import { readFileSync } from "node:fs";
import { parseArgs, runScript, CliErrorObject, requireProject } from "../src/lib/cli";
import { batchStatus, runBatch } from "../src/lib/jobs/batch";
import { FalBatchSpecSchema } from "../src/types/fal-catalog";
runScript(async () => {
  const args = parseArgs([
    { name: "spec", required: true, description: "FalBatchSpec JSON file" },
    { name: "project", required: true, description: "Project ID" },
    {
      name: "dry-run",
      type: "boolean",
      description: "Quote only (default); materialises immutable requests, never submits",
    },
    { name: "execute", type: "boolean", description: "Execute sequential durable operations after a fitting forecast" },
    {
      name: "max-total-usd",
      type: "number",
      description: "Explicit total authorisation, at least the aggregate high bound",
    },
    { name: "revision", description: "Append a revision to batchId, creating new operation identities" },
    { name: "status", type: "boolean", description: "Read each operation from the job store without writes" },
    { name: "scope-root", description: "Trusted MCP workspace boundary for nested output paths" },
  ] as const);
  requireProject(args.project!);
  if (args.execute && (args["dry-run"] || args.status))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--execute conflicts with --dry-run/--status." });
  const spec = FalBatchSpecSchema.parse(JSON.parse(readFileSync(args.spec!, "utf8")));
  const options = { projectId: args.project!, revision: args.revision, scopeRoot: args["scope-root"] };
  if (args.status) return { outputs: [], metadata: { operations: batchStatus(spec, options) } };
  const result = await runBatch(spec, { ...options, execute: args.execute, maxTotalUsd: args["max-total-usd"] });
  if ("failedOperationId" in result)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Batch stopped at ${result.failedOperationId}. Resume with the same IDs.`,
      details: result,
    });
  return { outputs: result.operations.map((row) => row.operation.requestFile), metadata: result };
});
