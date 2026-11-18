import { readFileSync, statSync } from "node:fs";
import { parseArgs, runScript, emitProgress, CliErrorObject } from "../src/lib/cli";
import { FalOperationRequestSchema } from "../src/types/generation";
import { executeFalHttpStream, MAX_STREAM_INPUT_BYTES } from "../src/lib/providers/stream/service";
runScript(async () => {
  const args = parseArgs([
    { name: "request", required: true, description: "Exact FalOperationRequest JSON with transport stream" },
    { name: "output", required: true, description: "Project-local image output path" },
    { name: "project", description: "Project with configured durable budget" },
    { name: "operation-id", description: "Stable stream identity; interrupted streams cannot reconnect" },
    { name: "max-cost-usd", type: "number", description: "Explicit planning bound; provider billing is not capped" },
    {
      name: "execute",
      type: "boolean",
      description: "Explicitly execute one charged stream (default offline dry-run)",
    },
    { name: "dry-run", type: "boolean", description: "Force offline validation regardless of execute" },
    { name: "force", type: "boolean", description: "Explicit output replacement" },
    { name: "timeout-ms", type: "number", description: "Total stream timeout, max 1800000ms" },
    { name: "idle-ms", type: "number", description: "Idle stream timeout, max 1800000ms" },
    { name: "max-bytes", type: "number", description: "Response and aggregate media bound, max 128MiB" },
  ] as const);
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Caller cancelled stream"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const file = statSync(args.request!);
    if (!file.isFile() || file.size > MAX_STREAM_INPUT_BYTES + 65536)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Stream request JSON file is not regular or exceeds input byte limit.",
      });
    const dryRun = !args.execute || args["dry-run"] === true;
    emitProgress(
      dryRun
        ? "Validating HTTP stream plan offline"
        : "Executing one budget-admitted HTTP stream; interruptions retain liability",
    );
    return await executeFalHttpStream({
      request: FalOperationRequestSchema.parse(JSON.parse(readFileSync(args.request!, "utf8"))),
      output: args.output!,
      projectId: args.project,
      operationId: args["operation-id"],
      maxCostUsd: args["max-cost-usd"],
      force: args.force,
      dryRun,
      signal: controller.signal,
      limits: {
        ...(args["timeout-ms"] !== undefined ? { timeoutMs: args["timeout-ms"] } : {}),
        ...(args["idle-ms"] !== undefined ? { idleMs: args["idle-ms"] } : {}),
        ...(args["max-bytes"] !== undefined ? { totalBytes: args["max-bytes"] } : {}),
      },
    });
  } finally {
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
});
