import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { GitHub, eventData, integer, prNumbers } from "./api";
import { evaluate, getFacts, writeArtefact, type Facts, type Pull } from "./gh-pr-facts";
import { CliErrorObject, parseArgs } from "../../src/lib/cli";
import { runOffline } from "../../src/lib/contrib/cli";
import { auditPlan } from "../../src/lib/triage/audit";
import { repositoryText } from "../../src/lib/context/repository";
import { readArtefact } from "../../src/lib/triage/artefact";
import { buildPrompt } from "../../src/lib/triage/prompt";
import { charged, readLedger } from "../../src/lib/triage/ledger";
import { loadConfig, preflightJudges } from "../../src/lib/triage/vendors";
import { TriageBudgetStateSchema, type SpendRecord, type TriageConfig } from "../../src/types/triage";

export type TriageCaps = {
  perPrCapUsd: number;
  monthlyCapUsd: number | null;
  maxRunsPerPr?: number;
  perOwnerMonthlyRuns?: number;
};
const amount = (row: ReturnType<typeof TriageBudgetStateSchema.parse>["reservations"][number]) =>
  row.settled ? row.settledUsd! : row.boundUsd;
async function stateFile(api: GitHub) {
  const file = await api.content("triage-budget.json", "automation-state");
  if (!file)
    throw new Error(
      "Initialise automation-state/triage-budget.json before enabling paid triage; missing state never resets spend",
    );
  return { ...file, data: TriageBudgetStateSchema.parse(JSON.parse(file.text)) };
}
async function putState(api: GitHub, file: Awaited<ReturnType<typeof stateFile>>, message: string) {
  await api.call("/contents/triage-budget.json", "PUT", {
    branch: "automation-state",
    sha: file.sha,
    message,
    content: Buffer.from(JSON.stringify(file.data, null, 2) + "\n").toString("base64"),
  });
}
export class TriageSkip extends Error {}

/**
 * The judge subprocess's environment: this process's, without GitHub and Actions credentials. It reads untrusted PR
 * text and calls the vendors with its TRIAGE_* keys only; the write token stays with this process.
 */
export function judgeEnv(base: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const name of Object.keys(env))
    if (
      /^(GH|GITHUB)_(ENTERPRISE_)?TOKEN$/.test(name) ||
      /^ACTIONS_(RUNTIME|ID_TOKEN_REQUEST|CACHE)_/.test(name) ||
      /_APP_PRIVATE_KEY$/.test(name)
    )
      delete env[name];
  return env;
}
/** A remote bound survives runner cancellation, including a provider call with an ambiguous result. */
export async function reserveTriage(
  api: GitHub,
  caps: TriageCaps,
  operation: string,
  now = new Date(),
  prIdentity?: string,
  details: { headSha?: string; owner?: string; boundUsd?: number } = {},
): Promise<void> {
  if (
    !Number.isFinite(caps.perPrCapUsd) ||
    caps.perPrCapUsd <= 0 ||
    caps.monthlyCapUsd === null ||
    !Number.isFinite(caps.monthlyCapUsd) ||
    caps.monthlyCapUsd < 0
  )
    throw new Error("Triage requires explicit positive per-PR and nonnegative monthly caps");
  if (!/^[\w:-]{1,160}$/.test(operation)) throw new Error("Invalid triage operation ID");
  if (operation.endsWith(":pr") && !prIdentity)
    throw new Error("PR reservations require a trusted repository/PR identity");
  if (
    prIdentity &&
    (!prIdentity.startsWith(`${api.repo.toLowerCase()}#`) ||
      !/^[1-9]\d*$/.test(prIdentity.slice(`${api.repo.toLowerCase()}#`.length)))
  )
    throw new Error("Invalid trusted PR identity");
  const file = await stateFile(api);
  const { reservations } = file.data;
  if (reservations.some((row) => row.operation === operation))
    throw new TriageSkip("Triage operation already reserved; do not resubmit an ambiguous paid run");
  const boundUsd = details.boundUsd ?? caps.perPrCapUsd;
  if (!Number.isFinite(boundUsd) || boundUsd < 0 || boundUsd > caps.perPrCapUsd)
    throw new TriageSkip("Durable triage per-PR cap exceeded; defer to human review");
  const previous = reservations.filter(
    (row) => row.prIdentity === prIdentity || (!row.prIdentity && row.operation.endsWith(":pr")),
  );
  if (prIdentity) {
    if (details.headSha && previous.some((row) => row.headSha === details.headSha))
      throw new TriageSkip("This PR head SHA was already triaged");
    if (previous.length >= (caps.maxRunsPerPr ?? 2)) throw new TriageSkip("Maximum triage runs for this PR reached");
    if (previous.reduce((sum, row) => sum + amount(row), 0) + boundUsd > caps.perPrCapUsd)
      throw new TriageSkip("Durable triage per-PR cap exceeded; defer to human review");
  }
  const at = now.toISOString();
  const month = reservations.filter((row) => row.at.slice(0, 7) === at.slice(0, 7));
  if (
    details.owner &&
    month.filter((row) => row.owner?.toLowerCase() === details.owner!.toLowerCase()).length >=
      (caps.perOwnerMonthlyRuns ?? 4)
  )
    throw new TriageSkip("PR owner monthly triage quota exhausted");
  if (month.reduce((sum, row) => sum + amount(row), 0) + boundUsd > caps.monthlyCapUsd)
    throw new TriageSkip("Durable triage monthly cap exceeded; defer to human review");
  reservations.push({
    operation,
    at,
    boundUsd,
    ...(prIdentity ? { prIdentity } : {}),
    ...(details.headSha ? { headSha: details.headSha } : {}),
    ...(details.owner ? { owner: details.owner.toLowerCase() } : {}),
  });
  await putState(api, file, `Reserve triage bound ${operation}`);
}

/** Only complete, attributable ledger evidence can release an unused remote bound. */
export async function settleTriage(
  api: GitHub,
  operation: string,
  records: SpendRecord[],
  _exitCode: number | null,
): Promise<void> {
  const calls = charged(records).filter((row) => row.reservation.runId === operation);
  const settlements = new Set(records.filter((row) => row.event === "settle").map((row) => row.id));
  const ambiguous = calls.some((row) => !settlements.has(row.reservation.id)) || calls.length === 0;
  // A failed process without ledger evidence may have submitted a paid call before crashing.
  if (calls.length === 0) return;
  const costUsd = calls.reduce((sum, row) => sum + row.costUsd, 0);
  for (let attempt = 0; ; attempt++) {
    const file = await stateFile(api);
    const row = file.data.reservations.find((row) => row.operation === operation);
    if (!row) throw new Error("Missing remote triage reservation; cannot settle");
    if (row.settled) {
      if (row.settledUsd !== costUsd) throw new Error("Conflicting triage settlement");
      return;
    }
    if (ambiguous) {
      if (costUsd <= row.boundUsd) return;
      row.boundUsd = costUsd;
    } else {
      row.settledUsd = costUsd;
      row.settled = true;
    }
    try {
      await putState(api, file, `Settle triage cost ${operation}`);
      return;
    } catch (error) {
      if (!(error instanceof CliErrorObject) || error.details?.status !== 409 || attempt >= 3) throw error;
    }
  }
}

export async function triageEligibility(
  api: GitHub,
  facts: Facts,
  config: Pick<TriageConfig, "minTierForAutoTriage">,
): Promise<string | undefined> {
  if (facts.pr.state !== "open" || facts.pr.draft) return "PR is closed or draft";
  if (
    !facts.cla ||
    facts.leakHit ||
    facts.uncertainFiles.length ||
    evaluate(facts).findings.some((finding) => finding.severity === "block")
  )
    return "Intake is blocked or incomplete";
  if (facts.authorTier >= config.minTierForAutoTriage) return;
  if (facts.authorTier !== 0 || !facts.labels.includes("triage:requested"))
    return "Author tier requires a maintainer triage request";
  const events = await api.pages<{ event: string; label?: { name: string }; actor?: { login: string } }>(
    `/issues/${facts.pr.number}/events`,
  );
  const latest = events
    .filter((event) => ["labeled", "unlabeled"].includes(event.event) && event.label?.name === "triage:requested")
    .at(-1);
  if (latest?.event === "labeled" && latest.actor?.login && /^[\w-]+$/.test(latest.actor.login)) {
    const actor = await api.call<{ permission: string }>(
      `/collaborators/${encodeURIComponent(latest.actor.login)}/permission`,
    );
    if (["write", "maintain", "admin"].includes(actor.permission)) return;
  }
  return "Triage request was not applied by a maintainer";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void runOffline(async () => {
    const args = parseArgs([
      {
        name: "mode",
        required: true,
        choices: ["pr", "audit"],
        description: "Run triage:pr or instructions:audit under a durable remote budget reservation",
      },
      { name: "artefact", description: "Untrusted PR data directory (intake is independently re-derived)" },
      { name: "pr", type: "number", description: "Maintainer workflow_dispatch PR number" },
    ] as const);
    const config = loadConfig();
    if (!config.enabled) return { metadata: { skipped: "triage disabled" } };
    const api = new GitHub(process.env.GITHUB_REPOSITORY ?? "", process.env.GH_TOKEN ?? "");
    const operation = `${process.env.GITHUB_RUN_ID ?? ""}:${process.env.GITHUB_RUN_ATTEMPT ?? ""}:${args.mode}`;
    if (!/^\d+:\d+:/.test(operation)) throw new Error("A GitHub run ID and attempt are required");
    let facts: Facts | undefined;
    if (args.mode === "pr") {
      const event = eventData({}) as { workflow_run?: { id?: number }; inputs?: { pr?: string } };
      let numbers: number[];
      if (process.env.GITHUB_EVENT_NAME === "workflow_dispatch")
        numbers = [integer(args.pr ?? Number(event.inputs?.pr))];
      else {
        if (!event.workflow_run?.id) throw new Error("PR triage requires a trusted workflow_run event");
        numbers = await prNumbers(api, { run: event.workflow_run.id });
      }
      if (numbers.length !== 1) return { metadata: { skipped: "No single current PR for this workflow" } };
      facts = await getFacts(api, numbers[0]!);
      const skipped = await triageEligibility(api, facts, config);
      if (skipped) return { metadata: { skipped } };
      // Rebuild material from the same authoritative head used by admission, including dispatch runs.
      writeArtefact(facts, ".cache/triage/artefact");
    }
    const saved = await api.content("triage-ledger.jsonl", "automation-state");
    mkdirSync(".cache/triage", { recursive: true });
    const ledger = ".cache/triage/ledger.jsonl";
    writeFileSync(ledger, saved?.text ?? "");
    const prIdentity = facts ? `${api.repo.toLowerCase()}#${facts.pr.number}` : undefined;
    const prompts = facts
      ? [buildPrompt(readArtefact(".cache/triage/artefact", config.maxDiffBytes).material)]
      : auditPlan(repositoryText(process.cwd())).prompts;
    let boundUsd: number;
    try {
      boundUsd = preflightJudges(config, ledger, operation, prompts, process.env, prIdentity);
      if (facts) {
        const fresh = await api.call<Pull>(`/pulls/${facts.pr.number}`);
        if (fresh.head.sha !== facts.pr.head.sha || fresh.updated_at !== facts.pr.updated_at)
          return { metadata: { skipped: "PR changed during intake" } };
      }
      await reserveTriage(api, config, operation, new Date(), prIdentity, {
        boundUsd,
        headSha: facts?.pr.head.sha,
        owner: facts?.pr.user.login,
      });
    } catch (error) {
      if (error instanceof TriageSkip || (error instanceof CliErrorObject && error.details?.labels))
        return { metadata: { skipped: error.message } };
      throw error;
    }
    const command = facts
      ? [
          "scripts/triage-pr.ts",
          "--artefact",
          ".cache/triage/artefact",
          "--repository",
          api.repo,
          "--pr",
          String(facts.pr.number),
        ]
      : ["scripts/instructions-audit.ts"];
    const result = spawnSync(process.execPath, ["--import", "tsx", ...command], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: judgeEnv(process.env, { TRIAGE_LEDGER: ledger, TRIAGE_RUN_ID: operation }),
    });
    await settleTriage(api, operation, readLedger(ledger), result.status);
    const content = readFileSync(ledger, "utf8");
    await api.call("/contents/triage-ledger.jsonl", "PUT", {
      branch: "automation-state",
      ...(saved ? { sha: saved.sha } : {}),
      message: `Record triage ledger ${operation}`,
      content: Buffer.from(content).toString("base64"),
    });
    const output = JSON.parse(result.stdout) as { ok: boolean; metadata?: Record<string, unknown>; message?: string };
    if (result.status !== 0 || !output.ok)
      throw new Error(output.message ?? "Triage failed; inspect retained reservations");
    return { metadata: { ...output.metadata, ...(facts ? { headSha: facts.pr.head.sha } : {}) } };
  });
