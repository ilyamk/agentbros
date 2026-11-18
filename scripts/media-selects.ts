import path from "node:path";
import { searchEmbeddings } from "../src/lib/ingest/embeddings";
import { readFileSync } from "node:fs";
import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { listSourceIndexes } from "../src/lib/ingest";
import { searchSourceIndexes, proposeSelect, applySelect } from "../src/lib/ingest/selects";
runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project slug" },
    {
      name: "embeddings",
      description: "Supplied model/revision-labelled vector corpus JSON",
    },
    {
      name: "vector-query",
      description: "Query vector JSON in exactly the same embedding space",
    },
    { name: "query", description: "Lexical transcript/tag query" },
    {
      name: "limit",
      type: "number",
      default: 10,
      description: "Maximum ranked hits",
    },
    {
      name: "context",
      type: "number",
      default: 1.5,
      description: "Minimum surrounding context seconds",
    },
    { name: "apply", description: "Explicit reviewed proposal JSON file" },
    {
      name: "index",
      description: "Source index JSON file for proposal application",
    },
    { name: "track", description: "Target timeline track ID" },
    { name: "clip", description: "Target timeline clip ID" },
    {
      name: "revision",
      type: "number",
      description: "Expected timeline revision",
    },
    {
      name: "dry-run",
      type: "boolean",
      description: "Preview a trim without mutation",
    },
  ] as const);
  if ([!!args.query, !!args.apply, !!args["vector-query"]].filter(Boolean).length !== 1)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Choose --query, --vector-query or --apply.",
    });
  if (args.apply) {
    if (!args.index || !args.track || !args.clip || args.revision === undefined)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Application requires --index --track --clip --revision.",
      });
    const result = applySelect({
      projectId: args.project!,
      indexFile: args.index,
      proposal: JSON.parse(readFileSync(args.apply, "utf8")),
      trackId: args.track,
      clipId: args.clip,
      expectedRevision: args.revision,
      dryRun: args["dry-run"],
    });
    return {
      outputs: args["dry-run"] ? [] : [path.resolve("public/projects", args.project!, "pipeline/timeline-edit.json")],
      metadata: {
        dryRun: args["dry-run"],
        revision: result.revision,
        timeline: result.timeline,
      },
    };
  }
  const indexes = listSourceIndexes(args.project!);
  if (args["vector-query"]) {
    if (!args.embeddings)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Vector query needs --embeddings corpus",
      });
    const hits = searchEmbeddings(
      indexes,
      JSON.parse(readFileSync(args.embeddings, "utf8")),
      JSON.parse(readFileSync(args["vector-query"], "utf8")),
      args.limit,
    );
    return {
      outputs: [],
      metadata: {
        method: "supplied-embedding-cosine",
        hits: hits.map((hit) => ({
          ...hit,
          proposal: proposeSelect(
            indexes.find((index) => index.cacheKey === hit.cacheKey)!,
            hit as unknown as import("../src/lib/ingest/selects").SourceSelect,
            args.context,
          ),
        })),
      },
    };
  }
  const hits = searchSourceIndexes(indexes, args.query!, args.limit);
  return {
    outputs: [],
    metadata: {
      method: "lexical-transcript-and-tags",
      hits: hits.map((hit) => ({
        ...hit,
        proposal: proposeSelect(
          indexes.find((index) => index.cacheKey === hit.cacheKey)!,
          hit,
          args.context,
        ),
      })),
    },
  };
});
