import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { LocalVisualConfigSchema, probeLocalVisual, ingestLocalVisual } from "../src/lib/ingest/local-visual";
import { readOcrJson } from "../src/lib/ingest/ocr-evidence";
runScript(async () => {
  const args = parseArgs([
    { name: "action", required: true, description: "probe or search; offline native image distance" },
    { name: "config", required: true, description: "Trusted prepared executable/source hash configuration; CLI only" },
    { name: "project", description: "Existing project slug" },
    { name: "index", description: "Existing sampled video source index" },
    { name: "query-asset", description: "Registered immutable original image asset ID" },
  ] as const);
  const config = LocalVisualConfigSchema.parse(readOcrJson(args.config!, 65536).value);
  if (args.action === "probe") return { outputs: [], metadata: await probeLocalVisual(config) };
  if (args.action !== "search" || !args.project || !args.index || !args["query-asset"])
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Choose probe, or search with --project --index --query-asset",
    });
  const result = await ingestLocalVisual({
    projectId: args.project,
    indexFile: args.index,
    queryAssetId: args["query-asset"],
    config,
  });
  return { outputs: [result.file, result.receiptFile], metadata: result };
});
