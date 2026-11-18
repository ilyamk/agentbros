/**
 * Numbered sentences of a transcript (20-minute chunks with 60 s overlap) and a brief for the agent that proposes shorts.
 */
import path from "node:path";
import { parseArgs, relativisePath, requireFile, runScript } from "../src/lib/cli";
import { prepareShorts } from "../src/lib/shorts/prepare";
import { validation } from "../src/lib/shorts/cli";

void runScript(async () => {
  const args = parseArgs([
    { name: "transcript", required: true, description: "TranscriptSchema JSON (pipeline/transcript.json)" },
    {
      name: "output-dir",
      required: true,
      description: "Directory for prepared.json, sentences.json, chunk-NN.md and brief.md",
    },
    { name: "count", type: "number", default: 5, description: "How many shorts to keep" },
    { name: "min-sec", type: "number", default: 20, description: "Shortest clip in seconds" },
    { name: "max-sec", type: "number", default: 60, description: "Longest ordinary clip in seconds" },
    { name: "hard-max-sec", type: "number", default: 90, description: "Longest clip with a story payoff in seconds" },
    { name: "brief", description: "What the shorts are for: audience, topic or trend" },
  ] as const);
  requireFile(args.transcript!);
  const outputDir = path.resolve(args["output-dir"]!);
  const { prepared, files } = validation(() =>
    prepareShorts(args.transcript!, outputDir, {
      count: args.count as number,
      minSec: args["min-sec"] as number,
      maxSec: args["max-sec"] as number,
      hardMaxSec: args["hard-max-sec"] as number,
      brief: args.brief ?? null,
    }),
  );
  return {
    outputs: files.map((f) => relativisePath(path.join(outputDir, f))),
    metadata: {
      sentences: prepared.sentenceCount,
      sentencesDerived: prepared.sentencesDerived,
      chunks: prepared.chunks.length,
      brief: relativisePath(path.join(outputDir, "brief.md")),
    },
  };
});
