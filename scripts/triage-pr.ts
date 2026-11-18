import { randomUUID } from "node:crypto";
import { CliErrorObject, parseArgs } from "../src/lib/cli";
import { readArtefact } from "../src/lib/triage/artefact";
import { runTriageScript } from "../src/lib/triage/cli";
import { decide } from "../src/lib/triage/decide";
import { ledgerPath } from "../src/lib/triage/ledger";
import { buildPrompt } from "../src/lib/triage/prompt";
import { type JudgeResult, createJudge, loadConfig, preflightJudges } from "../src/lib/triage/vendors";

void runTriageScript(async () => {
  const args = parseArgs([
    {
      name: "artefact",
      description: "Directory containing metadata.json, body.md, change.md and diff.patch; never executed",
    },
    { name: "repository", description: "Trusted owner/repository supplied by the privileged caller" },
    { name: "pr", type: "number", description: "Trusted PR number supplied by the privileged caller" },
    { name: "dry-run", type: "boolean", description: "Build an offline plan; no vendor calls or ledger writes" },
  ] as const);
  const config = loadConfig();
  if (!config.enabled) return { metadata: { skipped: "triage disabled" } };
  if (!args.artefact) throw new CliErrorObject({ code: "INVALID_INPUT", message: "PR triage requires --artefact" });
  const artefact = readArtefact(args.artefact!, config.maxDiffBytes);
  const prompt = buildPrompt(artefact.material);
  const runId = process.env.TRIAGE_RUN_ID ?? randomUUID();
  const ledger = ledgerPath();
  if (args["dry-run"])
    return {
      metadata: {
        dryRun: true,
        judges: config.judges,
        perPrCapUsd: config.perPrCapUsd,
        monthlyCapUsd: config.monthlyCapUsd,
        pricing: config.pricing,
        truncated: artefact.truncated,
        files: artefact.files,
        ready: false,
        message: "Plan only. Execution validates prices, keys and caps, including an explicitly set monthlyCapUsd.",
      },
    };
  if (!args.repository || !/^[\w.-]+\/[\w.-]+$/.test(args.repository) || !Number.isSafeInteger(args.pr) || args.pr! < 1)
    throw new Error("Paid PR triage requires trusted --repository and --pr; never use artefact metadata");
  const prIdentity = `${args.repository.toLowerCase()}#${args.pr}`;
  const reservedBoundUsd = preflightJudges(config, ledger, runId, [prompt], process.env, prIdentity);
  const options = { config, ledger, runId, prIdentity };
  const results = [
    await createJudge(config.judges[0], options).judge(prompt),
    await createJudge(config.judges[1], options).judge(prompt),
  ] as [JudgeResult, JudgeResult];
  return {
    metadata: {
      ...decide(
        results,
        prompt.canary,
        config.judges.map((slot) => slot.label),
      ),
      runId,
      reservedBoundUsd,
      costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
      usage: Object.fromEntries(results.map((result, index) => [config.judges[index]!.label, result.usage])),
      truncated: artefact.truncated,
    },
  };
});
