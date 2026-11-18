/**
 * Grants, revises or shows a project's autonomy policy (pipeline/policy.json) and raises its global limits.
 * Every revision is appended; anything that widens what runs without asking (autonomy, a higher budget, a new
 * provider, a pre-answer, an auto-pass step, a raised limit, autonomous spend) needs --answer with the user's own words. Narrowing needs
 * none. A bespoke film or a recording's source project (footage:next); a pre-answer that does not fit the project or is
 * not one of its question's options is refused (src/lib/autonomy/pre-answers.ts). A budget also installs or raises the job store's ceiling up to it, on the same words. CLI only, never MCP.
 */
import { requireUserWords } from "../src/lib/cli/user-words";
import { wordsChannel } from "../src/lib/cli/channel";
import { CliErrorObject, parseArgs, runScript } from "../src/lib/cli";
import { takeRepeated } from "../src/lib/film/cli";
import { appendGuardEvent, guardCheck } from "../src/lib/film/guard";
import { preAnswerProblems } from "../src/lib/autonomy/pre-answers";
import { openPolicyProject } from "../src/lib/autonomy/project";
import { currentPolicy, PolicyRefusal, revisePolicy, type PolicyChange } from "../src/lib/autonomy/policy";
import { OperationStore } from "../src/lib/jobs/store";
import {
  AUTO_PASS_STEPS,
  AUTONOMY_MODES,
  LIMIT_NAMES,
  PreAnswersSchema,
  type AutoPassStep,
  type LimitName,
  type PreAnswers,
} from "../src/types/policy";

const invalid = (message: string) => new CliErrorObject({ code: "INVALID_INPUT", message });
const list = (value: string | undefined) =>
  value === undefined
    ? undefined
    : value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
const usd = (flag: string, value: string | undefined) => {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw invalid(`--${flag} must be a non-negative number of USD.`);
  return number;
};

void runScript(async () => {
  const { values: preValues, rest: afterPre } = takeRepeated(process.argv.slice(2), "pre-answer");
  const { values: raiseValues, rest } = takeRepeated(afterPre, "raise");
  const args = parseArgs(
    [
      { name: "project", required: true, description: "Project ID" },
      { name: "autonomy", choices: AUTONOMY_MODES, description: "interactive (the default) or autonomous" },
      {
        name: "answer",
        description: "The user's own words granting this change; required for anything that widens the policy",
      },
      { name: "ceiling-usd", description: "The policy's spend cap; the job store's ceiling may not exceed it" },
      { name: "max-job-usd", description: "The policy's per-job limit (default: the ceiling)" },
      {
        name: "spend-usd",
        description:
          "Autonomous paid material: the policy may approve pending generated items while their bounds sum within this many USD and the durable budget; 0 removes it",
      },
      {
        name: "providers",
        description: "Comma-separated providers the job store admits under this policy (replaces the list)",
      },
      {
        name: "allow-user-bound-quotes",
        choices: ["yes", "no"],
        description: "Whether an autonomous run may reserve on a hand-bound quote (default no)",
      },
      {
        name: "pre-answer",
        description: `key=value, repeatable: ${Object.keys(PreAnswersSchema.shape).join(", ")} (formats and swaps comma-separated, shorts a count; captionStyle and shorts on a recording, swaps on a replica); key= drops one`,
      },
      {
        name: "auto-pass",
        description: `Comma-separated class (a) steps: ${AUTO_PASS_STEPS.join(", ")}; empty clears`,
      },
      { name: "final-review-only", choices: ["yes", "no"], description: "The user reviews only the final film" },
      {
        name: "raise",
        description: `limit=n, repeatable: ${LIMIT_NAMES.join(", ")}. Counts are never reset; a lower value needs no answer`,
      },
      {
        name: "show",
        type: "boolean",
        description: "Print the policy in force and the guard's counts; change nothing",
      },
    ] as const,
    rest,
  );
  const project = openPolicyProject(args.project!);
  if (args.show) {
    const check = guardCheck(project.projectDir);
    return { metadata: { projectId: project.id, policy: currentPolicy(project.projectDir) ?? null, guard: check } };
  }

  const change: PolicyChange = {};
  if (args.autonomy) change.autonomy = args.autonomy as PolicyChange["autonomy"];
  const ceiling = usd("ceiling-usd", args["ceiling-usd"]);
  const maxJob = usd("max-job-usd", args["max-job-usd"]);
  const providers = list(args.providers);
  if (ceiling !== undefined || maxJob !== undefined || providers || args["allow-user-bound-quotes"])
    change.budget = {
      ...(ceiling !== undefined ? { ceilingUsd: ceiling } : {}),
      ...(maxJob !== undefined ? { maxJobUsd: maxJob } : {}),
      ...(providers ? { allowedProviders: providers } : {}),
      ...(args["allow-user-bound-quotes"] ? { allowUserBoundQuotes: args["allow-user-bound-quotes"] === "yes" } : {}),
    };
  const preAnswers: Record<string, unknown> = {};
  const drop: (keyof PreAnswers)[] = [];
  for (const value of preValues) {
    const at = value.indexOf("=");
    if (at < 1) throw invalid(`--pre-answer takes key=value, got "${value}".`);
    const key = value.slice(0, at) as keyof PreAnswers;
    const text = value.slice(at + 1).trim();
    if (!(key in PreAnswersSchema.shape)) throw invalid(`Unknown pre-answer "${key}".`);
    if (!text) drop.push(key);
    else preAnswers[key] = key === "formats" || key === "swaps" ? list(text) : key === "shorts" ? Number(text) : text;
  }
  if (Object.keys(preAnswers).length) {
    const parsed = PreAnswersSchema.safeParse(preAnswers);
    if (!parsed.success)
      throw invalid(`--pre-answer: ${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}`);
    const problems = preAnswerProblems(parsed.data, project.kind);
    if (problems.length) throw invalid(`--pre-answer: ${problems.join(" ")}`);
    change.preAnswers = parsed.data;
  }
  if (drop.length) change.dropPreAnswers = drop;
  const autoPass = list(args["auto-pass"]);
  if (autoPass) {
    const unknown = autoPass.filter((step) => !(AUTO_PASS_STEPS as readonly string[]).includes(step));
    if (unknown.length)
      throw invalid(`--auto-pass: unknown ${unknown.join(", ")}; known ${AUTO_PASS_STEPS.join(", ")}.`);
    change.autoPass = autoPass as AutoPassStep[];
  }
  const spendUsd = usd("spend-usd", args["spend-usd"]);
  if (spendUsd !== undefined) change.spendUsd = spendUsd;
  if (args["final-review-only"]) change.finalReviewOnly = args["final-review-only"] === "yes";
  const limits: Partial<Record<LimitName, number>> = {};
  for (const value of raiseValues.flatMap((item) => list(item) ?? [])) {
    const [name, amount] = value.split("=");
    if (!(LIMIT_NAMES as readonly string[]).includes(name ?? ""))
      throw invalid(`--raise: unknown limit "${name}"; known ${LIMIT_NAMES.join(", ")}.`);
    const number = Number(amount);
    if (!Number.isFinite(number) || number <= 0) throw invalid(`--raise ${name} needs a positive number.`);
    limits[name as LimitName] = number;
  }
  if (Object.keys(limits).length) change.limits = limits;
  if (!Object.keys(change).length) throw invalid("Nothing to change: pass a flag, or --show.");

  if (args.answer !== undefined) requireUserWords(args.answer, "--answer");
  let result: ReturnType<typeof revisePolicy>;
  try {
    result = revisePolicy(project.projectDir, project.id, change, args.answer);
  } catch (error) {
    if (error instanceof PolicyRefusal) throw new CliErrorObject({ code: "VALIDATION", message: error.message });
    throw error;
  }
  if (change.limits)
    appendGuardEvent(project.projectDir, {
      kind: "raise",
      source: `film:policy revision ${result.revision.revision}`,
      at: new Date().toISOString(),
    });

  // The budget the user granted becomes the job store's ceiling, on the same words; never above it, never lowered here.
  let store: { ceilingUsd: number; configured: boolean; note?: string } | undefined;
  const budget = result.revision.budget;
  if (budget && change.budget && args.answer?.trim()) {
    const operations = new OperationStore(project.id);
    const current = operations.ceilingUsd();
    if (current === null || current < budget.ceilingUsd) {
      const existing = current === null ? undefined : operations.snapshot().policy;
      operations.configure(
        {
          ceilingUsd: budget.ceilingUsd,
          maxJobUsd: budget.maxJobUsd,
          repairReserveFraction: existing?.repairReserveFraction ?? 0.15,
          maxPaidAttemptsPerAsset: existing?.maxPaidAttemptsPerAsset ?? 2,
        },
        { by: "user", answer: args.answer.trim(), ...wordsChannel() },
      );
      store = { ceilingUsd: budget.ceilingUsd, configured: true };
    } else
      store = {
        ceilingUsd: current,
        configured: false,
        note: "The job store's ceiling already reaches the policy's; lower it with pnpm budget if needed.",
      };
  }
  return {
    outputs: [`${project.projectDir}/pipeline/policy.json`],
    metadata: {
      projectId: project.id,
      revision: result.revision,
      widened: result.widened,
      ...(store ? { store } : {}),
      guard: guardCheck(project.projectDir),
    },
  };
});
