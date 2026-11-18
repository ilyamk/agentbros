import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { LocalCategoryConfigSchema, probeLocalCategory, ingestLocalCategory } from "../src/lib/ingest/local-category";
import { readSourceIndex } from "../src/lib/ingest";
import { searchCategoryFrames } from "../src/lib/ingest/category-evidence";
import { boundedEvidenceJson } from "../src/lib/ingest/bounded-evidence";
import { ocrLocalPath } from "../src/lib/ingest/ocr-evidence";
import path from "node:path";
runScript(async () => {
  const args = parseArgs([
    { name: "action", required: true, description: "probe, classify, or search; exact native category ID only" },
    { name: "config", description: "Trusted prepared executable/source pins; required only probe/classify" },
    { name: "project", description: "Existing project slug" },
    { name: "index", description: "Immutable sampled video source index" },
    { name: "query", description: "Pinned native-image-category query JSON; exact supported ID/taxonomy hash" },
  ] as const);
  if (args.action === "probe") {
    if (!args.config) throw new CliErrorObject({ code: "INVALID_INPUT", message: "probe needs --config" });
    return {
      outputs: [],
      metadata: await probeLocalCategory(
        LocalCategoryConfigSchema.parse(boundedEvidenceJson(args.config, 65536).value),
      ),
    };
  }
  if (!["classify", "search"].includes(args.action!) || !args.project || !args.index || !args.query)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Choose probe --config, or classify/search --project --index --query",
    });
  const project = path.resolve("public/projects", args.project),
    queryFile = ocrLocalPath(project, path.resolve(args.query)),
    query = boundedEvidenceJson(queryFile, 65536);
  if (args.action === "search") {
    const index = readSourceIndex(args.project, ocrLocalPath(project, path.resolve(args.index)), {
        boundedEvidence: true,
      }),
      hits = searchCategoryFrames(index, (ref) => ocrLocalPath(project, path.resolve("public", ref)), query.value);
    return {
      outputs: [],
      metadata: {
        hits,
        queryFile,
        querySha256: query.hash,
        observationOnly: true,
        reviewRequired: true,
        calibratedConfidence: false,
        missingLabels: "not returned; never zero-filled",
      },
    };
  }
  if (!args.config) throw new CliErrorObject({ code: "INVALID_INPUT", message: "classify needs --config" });
  const result = await ingestLocalCategory({
    projectId: args.project,
    indexFile: args.index,
    query: query.value,
    config: LocalCategoryConfigSchema.parse(boundedEvidenceJson(args.config, 65536).value),
  });
  return {
    outputs: [result.file, result.receiptFile],
    metadata: {
      ...result,
      queryFile,
      querySha256: query.hash,
      calibratedConfidence: false,
      missingLabels: "not returned; never zero-filled",
    },
  };
});
