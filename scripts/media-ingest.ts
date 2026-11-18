import { readFileSync } from "node:fs";
import { parseArgs, runScript } from "../src/lib/cli";
import { ingestMedia } from "../src/lib/ingest";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project slug" },
    { name: "source", required: true, description: "Local recording path" },
    { name: "transcript", description: "Supplied local segments/words/Scribe JSON" },
    { name: "options", description: "Analysis options JSON file (tags, protectedSpans, proxy/thumbnail/OCR)" },
    { name: "dry-run", type: "boolean", description: "Validate without importing or writing" },
  ] as const);
  const result = ingestMedia({
    projectId: args.project!,
    sourceFile: args.source!,
    transcriptFile: args.transcript,
    options: args.options ? JSON.parse(readFileSync(args.options, "utf8")) : undefined,
    dryRun: args["dry-run"],
  });
  return { outputs: result.dryRun ? [] : [result.file], metadata: result };
});
