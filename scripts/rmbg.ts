/** Durable rmbg: invoke again with identical arguments to resume. */
import { parseArgs, runScript } from "../src/lib/cli";
import { localMediaDataUri } from "../src/lib/apis/fal-context";
import { executeFalOperation, PAID_CLI_SPECS } from "../src/lib/jobs/execution";
import { statSync } from "node:fs";
import { inspectAsset } from "../src/lib/assets/inspect";
import { prepareFalRoleExecution, requireVerifiedFalRoleEndpoint } from "../src/lib/providers/fal-plan-execution";
runScript(async () => {
  const args = parseArgs([
    { name: "input", short: "i", required: true, description: "Local image path" },
    { name: "endpoint", description: "Verified cutout endpoint; omit to keep the legacy BiRefNet route" },
    { name: "output", short: "o", required: true, description: "Output path" },
    { name: "project", description: "Project for durable budget tracking" },
    { name: "asset-id", description: "Logical asset ID" },
    { name: "force", short: "f", type: "boolean", description: "Replace an existing output after verification" },
    ...PAID_CLI_SPECS,
  ] as const);
  if (args.endpoint !== undefined) {
    const entry = requireVerifiedFalRoleEndpoint(args.endpoint, "cutout", "image-to-image");
    const source = localMediaDataUri(args.input!, "image");
    const { plan, options } = prepareFalRoleExecution(
      entry,
      { image: source },
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
    endpoint: "fal-ai/birefnet",
    model: "fal:birefnet-bgremoval",
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
