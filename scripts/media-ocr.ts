import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { LocalOcrConfigSchema, probeLocalOcr, ingestLocalOcr } from "../src/lib/ingest/local-ocr";
import { readOcrJson } from "../src/lib/ingest/ocr-evidence";
runScript(async () => {
  const args = parseArgs([
    { name: "action", required: true, description: "probe or ingest; local installed OCR only" },
    { name: "config", required: true, description: "Trusted prepared executable/source hash configuration (CLI only)" },
    { name: "project", description: "Existing project slug" },
    { name: "index", description: "Existing non-OCR video source index JSON" },
  ] as const);
  const config = LocalOcrConfigSchema.parse(readOcrJson(args.config!, 65536).value);
  if (args.action === "probe") return { outputs: [], metadata: await probeLocalOcr(config) };
  if (args.action !== "ingest" || !args.project || !args.index)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose probe, or ingest with --project and --index" });
  const result = await ingestLocalOcr({ projectId: args.project, indexFile: args.index, config });
  return { outputs: [result.file, result.receiptFile], metadata: result };
});
