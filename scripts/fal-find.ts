import { parseArgs, runScript } from "../src/lib/cli";
import { FalFindQuerySchema } from "../src/types/fal-catalog";
import { findFalEndpointResult } from "../src/lib/models/fal-find";

runScript(async () => {
  const args = parseArgs([
    {
      name: "provider",
      choices: ["fal", "higgsfield", "any"],
      description: "Default any when HIGGSFIELD_API_KEY is present, otherwise fal",
    },
    { name: "task", description: "Task in Russian or English" },
    { name: "category", description: "Comma-separated categories" },
    { name: "inputs", description: "Comma-separated required input media" },
    {
      name: "capability",
      description: "Comma-separated capabilities, all required (list: pnpm models:capabilities --list)",
    },
    { name: "any-capability", description: "Comma-separated capabilities, at least one required" },
    { name: "field", description: "Raw schema fallback: regex one input field name must match" },
    { name: "input-audio-sec", type: "number", description: "Input audio seconds; rejects a stated max below it" },
    { name: "input-video-sec", type: "number", description: "Input video seconds; rejects a stated max below it" },
    { name: "outputs", description: "Comma-separated output kinds" },
    { name: "duration", type: "number", description: "Duration in seconds" },
    { name: "aspect", description: "Aspect ratio, e.g. 9:16" },
    { name: "resolution", description: "Resolution, e.g. 1080p" },
    { name: "max-usd", type: "number", description: "Require a bounded quote within this amount" },
    { name: "min-tier", description: "Minimum trust tier" },
    { name: "include-retiring", type: "boolean", description: "Include retiring endpoints" },
    { name: "include-schemaless", type: "boolean", description: "Include non-executable schema-less entries" },
    { name: "limit", type: "number", description: "Shortlist size (1–100)" },
    { name: "explain", type: "boolean", description: "Include ten rejected candidates" },
    { name: "project", description: "Optional MCP project scope" },
  ] as const);
  const split = (value?: string) => value?.split(",").map((item) => item.trim());
  const query = FalFindQuerySchema.parse({
    provider: args.provider,
    task: args.task,
    categories: split(args.category),
    inputs: split(args.inputs),
    capabilities: split(args.capability),
    anyCapabilities: split(args["any-capability"]),
    field: args.field,
    inputAudioSec: args["input-audio-sec"],
    inputVideoSec: args["input-video-sec"],
    outputs: split(args.outputs),
    durationSec: args.duration,
    aspect: args.aspect,
    resolution: args.resolution,
    maxUsd: args["max-usd"],
    minTier: args["min-tier"],
    includeRetiring: args["include-retiring"],
    includeSchemaless: args["include-schemaless"],
    limit: args.limit,
    explain: args.explain,
  });
  const { candidates: rows, ...discovery } = findFalEndpointResult(query);
  return {
    metadata: {
      ...discovery,
      candidates: rows.filter((row) => !row.rejectedBecause),
      ...(args.explain ? { rejected: rows.filter((row) => row.rejectedBecause) } : {}),
    },
  };
});
