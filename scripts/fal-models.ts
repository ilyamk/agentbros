import { listModels as localModels, findModel, findModelSchema } from "../src/lib/models/registry";
import { quote } from "../src/lib/pricing";
import { loadCatalog, findCatalogEntry } from "../src/lib/models/fal-catalog";
import { falScaffoldSchema } from "../src/lib/models/fal-scaffold";
import { TrustTierSchema } from "../src/types/fal-catalog";
/**
 * Discover fal.ai models and their input schemas.
 *
 * Usage:
 *   tsx --env-file=.env scripts/fal-models.ts --list                              # List all active models
 *   tsx --env-file=.env scripts/fal-models.ts --search "text-to-image"            # Search by keyword
 *   tsx --env-file=.env scripts/fal-models.ts --category text-to-image            # Filter by category
 *   tsx --env-file=.env scripts/fal-models.ts --category image-to-video           # Video gen models
 *   tsx --env-file=.env scripts/fal-models.ts --schema fal-ai/flux/schnell        # Get full input schema
 *   tsx --env-file=.env scripts/fal-models.ts --info fal-ai/flux/schnell          # Quick model info
 *
 * Categories: text-to-image, image-to-image, image-to-video, text-to-video,
 *             text-to-audio, text-to-speech, speech-to-text, etc.
 */

const API_BASE = "https://api.fal.ai/v1";

import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";

async function falFetch(path: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.FAL_KEY) {
    headers["Authorization"] = `Key ${process.env.FAL_KEY}`;
  }

  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`fal API error: ${res.status} ${await res.text()}`);
  return res.json();
}

type FalModel = {
  endpoint_id: string;
  metadata?: {
    display_name?: string;
    category?: string;
    description?: string;
    status?: string;
    tags?: string[];
    thumbnail_url?: string;
  };
  openapi?: any;
};

async function listModels(opts: { category?: string; search?: string; limit?: number }): Promise<FalModel[]> {
  const params: Record<string, string> = {
    status: "active",
    limit: String(opts.limit || 50),
  };
  if (opts.category) params.category = opts.category;
  if (opts.search) params.q = opts.search;

  const all: FalModel[] = [];
  let cursor: string | undefined;

  do {
    if (cursor) params.cursor = cursor;
    const data = await falFetch("/models", params);
    all.push(...(data.models || []));
    cursor = data.has_more ? data.next_cursor : undefined;
    // Limit pagination to avoid huge lists
    if (all.length >= (opts.limit || 50)) break;
  } while (cursor);

  return all;
}

async function getModelSchema(endpointId: string): Promise<any> {
  const data = await falFetch("/models", {
    endpoint_id: endpointId,
    expand: "openapi-3.0",
  });
  return data.models?.[0];
}

runScript(async () => {
  const opts = parseArgs([
    { name: "family", description: "Offline exact request family or legacy family spelling" },
    { name: "operation", description: "Offline exact request operation" },
    { name: "transport", description: "Offline exact queue/training/stream/realtime transport" },
    { name: "region", description: "Offline exact global/us/singapore region" },
    { name: "local", type: "boolean", description: "Use offline discovery snapshot" },
    { name: "catalogue", type: "boolean", description: "Use the whole offline catalogue" },
    { name: "online", type: "boolean", description: "Use the existing online Platform API mode" },
    { name: "tier", description: "Catalogue trust tier" },
    { name: "retiring", type: "boolean", description: "Show only retiring catalogue entries" },
    { name: "quote", description: "Price endpoint or legacy pricing key offline" },
    { name: "units", type: "number", default: 1, description: "Invocation units" },
    { name: "width", type: "number", description: "Output width" },
    { name: "height", type: "number", description: "Output height" },
    { name: "duration", type: "number", description: "Output duration" },
    { name: "list", type: "boolean", description: "List active models" },
    { name: "search", description: "Search query" },
    { name: "category", description: "Model category" },
    { name: "schema", description: "Endpoint schema" },
    { name: "info", description: "Endpoint metadata" },
    { name: "limit", type: "number", default: 50, description: "Result limit" },
  ] as const);
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 1000)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--limit must be an integer from 1 to 1000." });
  if (opts.quote) {
    try {
      return {
        metadata: {
          quote: quote({
            model: opts.quote,
            units: opts.units,
            width: opts.width,
            height: opts.height,
            durationSec: opts.duration,
          }),
        },
      };
    } catch (error) {
      if (error instanceof RangeError) throw new CliErrorObject({ code: "INVALID_INPUT", message: error.message });
      throw error;
    }
  }
  if (!opts.local && (opts.family || opts.operation || opts.transport || opts.region))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Exact routing filters require --local." });
  if (opts.local) {
    if (opts.schema || opts.info)
      return {
        metadata: {
          model: findModel((opts.schema ?? opts.info)!) ?? null,
          ...(opts.schema ? { schema: findModelSchema(opts.schema) ?? null } : {}),
        },
      };
    const matched = localModels().filter(
      (model) =>
        (!opts.search ||
          `${model.id} ${model.family} ${model.requestRouting.family} ${model.requestRouting.variant} ${model.requestRouting.operation}`.includes(
            opts.search,
          )) &&
        (!opts.category || model.operation === opts.category || model.requestRouting.operation === opts.category) &&
        (!opts.family || model.family === opts.family || model.requestRouting.family === opts.family) &&
        (!opts.operation || model.requestRouting.operation === opts.operation) &&
        (!opts.transport || model.requestRouting.transport === opts.transport) &&
        (!opts.region || model.requestRouting.region === opts.region),
    );
    return {
      metadata: {
        models: matched.slice(0, opts.limit),
        total: matched.length,
        returned: Math.min(matched.length, opts.limit),
        truncated: matched.length > opts.limit,
        offline: true,
      },
    };
  }
  if (!opts.online && (opts.catalogue || opts.category || opts.tier || opts.retiring || opts.search || opts.schema)) {
    if (opts.tier) TrustTierSchema.parse(opts.tier);
    if (opts.schema) {
      try {
        return {
          metadata: {
            model: findCatalogEntry(opts.schema) ?? null,
            schema: falScaffoldSchema(opts.schema),
            offline: true,
          },
        };
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "SCHEMA_NOT_CACHED")
          return {
            metadata: {
              model: findCatalogEntry(opts.schema) ?? null,
              schema: null,
              error: "SCHEMA_NOT_CACHED",
              nextAction: `pnpm fal:sync --schemas ${opts.schema}`,
              offline: true,
            },
          };
        throw error;
      }
    }
    const matched = [...loadCatalog().values()].filter(
      (entry) =>
        (!opts.category || opts.category.split(",").includes(entry.category)) &&
        (!opts.tier || opts.tier === entry.tier) &&
        (!opts.retiring || !!entry.retiresAt) &&
        (!opts.search ||
          `${entry.endpoint} ${entry.displayName} ${entry.tags.join(" ")}`
            .toLowerCase()
            .includes(opts.search.toLowerCase())),
    );
    return {
      metadata: {
        models: matched.slice(0, opts.limit),
        total: matched.length,
        returned: Math.min(matched.length, opts.limit),
        truncated: matched.length > opts.limit,
        offline: true,
      },
    };
  }
  if (opts.schema || opts.info) {
    const model = await getModelSchema((opts.schema ?? opts.info)!);
    return { metadata: { model: model ?? null } };
  }
  if (!opts.list && !opts.search && !opts.category)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Pass --list, --search, --category, --schema, or --info.",
    });
  const models = await listModels({ category: opts.category, search: opts.search, limit: opts.limit });
  return { metadata: { models: models.slice(0, opts.limit) } };
});
