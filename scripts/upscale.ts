/** Durable upscale: invoke again with identical arguments to resume. */
import { parseArgs, runScript } from "../src/lib/cli";
import { localMediaDataUri } from "../src/lib/apis/fal-context";
import { executeFalOperation, PAID_CLI_SPECS } from "../src/lib/jobs/execution";
import { extname } from "node:path";
import { statSync } from "node:fs";
import { inspectAsset } from "../src/lib/assets/inspect";
import { prepareFalRoleExecution, requireVerifiedFalRoleEndpoint } from "../src/lib/providers/fal-plan-execution";
runScript(async () => {
  const args = parseArgs([
    { name: "input", short: "i", required: true, description: "Local image path, or video path with --endpoint" },
    { name: "endpoint", description: "Verified upscale endpoint; video inputs require video-to-video" },
    { name: "output", short: "o", required: true, description: "Output path" },
    { name: "project", description: "Project for durable budget tracking" },
    { name: "asset-id", description: "Logical asset ID" },
    { name: "force", short: "f", type: "boolean", description: "Replace an existing output after verification" },
    ...PAID_CLI_SPECS,
  ] as const);
  if (args.endpoint !== undefined) {
    const kind = /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(extname(args.input!)) ? "video" : "image";
    const entry = requireVerifiedFalRoleEndpoint(
      args.endpoint,
      "upscale",
      kind === "video" ? "video-to-video" : "image-to-image",
    );
    const source = localMediaDataUri(args.input!, kind);
    const { plan, options } = prepareFalRoleExecution(
      entry,
      { [kind]: source },
      { media: { [source]: { ...inspectAsset(args.input!).media, bytes: statSync(args.input!).size } } },
    );
    const result = await executeFalOperation({
      ...options,
      projectId: args.project,
      output: args.output!,
      assetId: args["asset-id"],
      operationId: args["operation-id"],
      maxCostUsd: args["max-cost-usd"],
      dryRun: args["dry-run"],
      force: args.force,
    });
    return {
      ...result,
      metadata: {
        ...result.metadata,
        plan,
        mediaKind: options.mediaKind,
        queuePath: options.queuePath,
        quoteInput: options.quoteInput,
      },
    };
  }
  return executeFalOperation({
    projectId: args.project,
    endpoint: "fal-ai/aura-sr",
    model: "fal:aura-sr-upscale",
    input: { image_url: localMediaDataUri(args.input!, "image") },
    output: args.output!,
    mediaKind: "image",
    assetId: args["asset-id"],
    operationId: args["operation-id"],
    maxCostUsd: args["max-cost-usd"],
    dryRun: args["dry-run"],
    force: args.force,
    quoteInput: { units: 1 },
  });
});
