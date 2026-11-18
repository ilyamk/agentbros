import { parseArgs, runScript } from "../src/lib/cli";
import { ModelsPricesQuerySchema, rankModelPrices } from "../src/lib/models/models-compare";

runScript(async () => {
  const args = parseArgs([
    { name: "scenario", required: true, description: "Standard scenario ID, e.g. 10s-720p or 1-image-1mp" },
    { name: "category", description: "Exact catalogue category" },
    { name: "slot", description: "Restrict to non-retired candidates in this slot" },
    { name: "provider", choices: ["fal", "higgsfield", "any"], description: "Provider (default any)" },
    { name: "kind", description: "Comma-separated cell kinds: exact,approximate,typical,floor,unknown" },
    { name: "max-usd", type: "number", description: "Maximum scenario USD; excludes floors and unknowns" },
    { name: "limit", type: "number", description: "Maximum rows (default 30, maximum 10000)" },
    { name: "project", description: "Optional MCP project scope" },
  ] as const);
  const query = ModelsPricesQuerySchema.parse({
    scenario: args.scenario,
    category: args.category,
    slot: args.slot,
    provider: args.provider,
    kind: args.kind?.split(",").map((kind) => kind.trim()),
    maxUsd: args["max-usd"],
    limit: args.limit,
  });
  return { metadata: rankModelPrices(query) };
});
