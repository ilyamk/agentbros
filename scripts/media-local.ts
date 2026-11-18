import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { LocalWorkerConfigSchema, probeLocalWorker, readBoundedLocalText } from "../src/lib/ingest/local-worker";
import { ingestLocalMedia, embedSourceIndexes, embedLocalQuery } from "../src/lib/ingest/local-analysis";
import { listSourceIndexes } from "../src/lib/ingest";
import { searchEmbeddings, EmbeddingPackSchema } from "../src/lib/ingest/embeddings";
import { proposeSelect, type SourceSelect } from "../src/lib/ingest/selects";
runScript(async () => {
  const args = parseArgs([
    {
      name: "config",
      required: true,
      description: "Explicit installed offline engine/model configuration JSON",
    },
    {
      name: "action",
      required: true,
      description: "probe, asr, corpus or query",
    },
    {
      name: "project",
      description: "Project slug",
    },
    {
      name: "source",
      description: "Original recording for ASR",
    },
    {
      name: "options",
      description: "Existing ingest options JSON",
    },
    {
      name: "query",
      description: "Query text",
    },
    {
      name: "corpus",
      description: "Local embedding pack JSON",
    },
    {
      name: "context",
      type: "number",
      default: 1.5,
      description: "Protected proposal context seconds",
    },
    {
      name: "limit",
      type: "number",
      default: 10,
      description: "Ranked proposals limit",
    },
  ] as const);
  const config = LocalWorkerConfigSchema.parse(JSON.parse(readBoundedLocalText(args.config!, 1024 * 1024)));
  if (args.action === "probe")
    return {
      outputs: [],
      metadata: probeLocalWorker(config),
    };
  if (!args.project)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Inference needs --project",
    });
  if (args.action === "asr") {
    if (!args.source)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "ASR needs --source",
      });
    const result = await ingestLocalMedia({
      projectId: args.project,
      sourceFile: args.source,
      config,
      options: args.options ? JSON.parse(readBoundedLocalText(args.options, 1024 * 1024)) : undefined,
    });
    return {
      outputs: [result.file, result.workerEvidence],
      metadata: result,
    };
  }
  const indexes = listSourceIndexes(args.project);
  if (args.action === "corpus") {
    const result = await embedSourceIndexes(args.project, indexes, config);
    return {
      outputs: [result.file, result.workerEvidence],
      metadata: result,
    };
  }
  if (args.action === "query") {
    if (!args.query || !args.corpus)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Query needs --query and --corpus (pack JSON, not worker envelope)",
      });
    const pack = EmbeddingPackSchema.parse(JSON.parse(readBoundedLocalText(args.corpus))),
      result = await embedLocalQuery(args.project, args.query, config, pack.space);
    const hits = searchEmbeddings(indexes, pack, result.query, args.limit).map((hit) => ({
      ...hit,
      proposal: proposeSelect(
        indexes.find((index) => index.cacheKey === hit.cacheKey)!,
        hit as unknown as SourceSelect,
        args.context,
      ),
    }));
    return {
      outputs: [result.workerEvidence],
      metadata: {
        ...result,
        hits,
        automaticSelection: false,
      },
    };
  }
  throw new CliErrorObject({
    code: "INVALID_INPUT",
    message: "Choose probe, asr, corpus or query",
  });
});
