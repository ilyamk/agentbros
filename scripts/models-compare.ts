import { parseArgs, runScript } from "../src/lib/cli";
import { compareModels, ModelsCompareQuerySchema } from "../src/lib/models/models-compare";

runScript(async () => {
  const args = parseArgs([
    { name: "category", description: "Exact catalogue category" },
    { name: "endpoint", description: "Exact endpoint ID or explicit family name" },
    { name: "resolution", description: "Shared resolution, e.g. 720p" },
    { name: "duration", type: "number", description: "Output duration in seconds" },
    { name: "project", description: "Optional MCP project scope" },
  ] as const);
  const comparisons = compareModels(
    ModelsCompareQuerySchema.parse({
      category: args.category,
      endpoint: args.endpoint,
      resolution: args.resolution,
      durationSec: args.duration,
    }),
  );
  return { metadata: { offline: true, comparisons } };
});
