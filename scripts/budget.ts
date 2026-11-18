import { readFileSync } from "node:fs";
import { requireUserWords } from "../src/lib/cli/user-words";
import { wordsChannel } from "../src/lib/cli/channel";
import { parseArgs, runScript, requireProject, CliErrorObject, emitProgress } from "../src/lib/cli";
import { OperationStore, ceilingAuthorityMessage, ceilingNeedsGrant } from "../src/lib/jobs/store";
import { runBatch } from "../src/lib/jobs/batch";
import { FalBatchSpecSchema } from "../src/types/fal-catalog";
import { noteSpend } from "../src/lib/memory/capture";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project ID" },
    {
      name: "ceiling-usd",
      type: "number",
      description:
        "Configure the project ceiling. Lowering is free; raising it, or a first ceiling above zero, needs --answer",
    },
    {
      name: "answer",
      description:
        "The user's own words authorising a raised (or first) ceiling; recorded in the store's policy events. Never your own words",
    },
    { name: "max-job-usd", type: "number", description: "Per-job ceiling (defaults to project ceiling)" },
    { name: "repair-fraction", type: "number", default: 0.15, description: "Repair budget share" },
    { name: "attempts", type: "number", default: 2, description: "Maximum paid attempts per asset" },
    { name: "operation-id", description: "Job to inspect/reconcile/release" },
    { name: "forecast", description: "FalBatchSpec JSON: read-only aggregate quote and policy verdict" },
    { name: "scope-root", description: "Trusted MCP workspace boundary for forecast output paths" },
    { name: "receipt", description: "JSON billing receipt file with provider evidence" },
    { name: "release", description: "JSON explicit no-charge confirmation file" },
  ] as const);
  requireProject(args.project!);
  if (args.receipt && args.release)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose receipt or release, not both." });
  if ((args.receipt || args.release) && !args["operation-id"])
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Billing/release requires --operation-id." });
  if (args.forecast) {
    if (args.receipt || args.release || args["ceiling-usd"] !== undefined || args.answer !== undefined)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "--forecast cannot configure or reconcile a budget.",
      });
    const spec = FalBatchSpecSchema.parse(JSON.parse(readFileSync(args.forecast, "utf8")));
    return {
      outputs: [],
      metadata: await runBatch(spec, { projectId: args.project!, write: false, scopeRoot: args["scope-root"] }),
    };
  }
  const store = new OperationStore(args.project!);
  if (args.answer !== undefined && args["ceiling-usd"] === undefined)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--answer only authorises a --ceiling-usd change." });
  if (args["ceiling-usd"] !== undefined) {
    const ceilingUsd = args["ceiling-usd"];
    const answer = args.answer === undefined ? undefined : requireUserWords(args.answer, "--answer");
    // The store refuses too; this check gives the agent a clean message to take to the user.
    if (!answer && ceilingNeedsGrant(store.ceilingUsd(), ceilingUsd))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: ceilingAuthorityMessage(args.project!, store.ceilingUsd(), ceilingUsd),
      });
    store.configure(
      {
        ceilingUsd,
        maxJobUsd: args["max-job-usd"] ?? ceilingUsd,
        repairReserveFraction: args["repair-fraction"],
        maxPaidAttemptsPerAsset: args.attempts,
      },
      answer ? { by: "user", answer, ...wordsChannel() } : undefined,
    );
  }
  let memoryWarning: string | undefined;
  if (args.receipt) {
    const settled = store.reconcileBilling(args["operation-id"]!, JSON.parse(readFileSync(args.receipt, "utf8")));
    if (settled.receipt)
      memoryWarning = noteSpend(
        args.project!,
        settled.receipt.actualUsd,
        settled.operationId,
        settled.receipt.receiptId,
      );
    if (memoryWarning) emitProgress(memoryWarning);
  }
  if (args.release) store.releaseReservation(args["operation-id"]!, JSON.parse(readFileSync(args.release, "utf8")));
  const snapshot = store.snapshot();
  const job = args["operation-id"] ? snapshot.jobs[args["operation-id"]] : undefined;
  if (args["operation-id"] && !job)
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: "Unknown operation ID." });
  return {
    outputs: [],
    metadata: {
      projectId: args.project,
      policy: snapshot.policy,
      policyEvents: snapshot.policyEvents ?? [],
      summary: store.summary(),
      ...(job ? { job } : { operations: Object.values(snapshot.jobs) }),
      ...(memoryWarning ? { memoryWarning } : {}),
    },
  };
});
