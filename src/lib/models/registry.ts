import { platformPricingSourceUrl } from "../../types/pricing-evidence";
import { findFalPriceRecord, pricingContext, pricingFromRecord } from "./fal-pricing";
import { findCatalogEntry } from "./fal-catalog";
import { loadFalUnitSemantics } from "./fal-docs-pricing";
import { publicTariff } from "./public-tariffs";
import snapshots from "../providers/schemas/fal-operations.json";
import { hasLocalFalTransport } from "../providers/transport-capabilities";
import type { ModelRequestRouting } from "../../types/models";
import { FalOperationRequestSchema } from "../../types/generation";
import type { ModelDescriptor, ModelOperation, PricingDefinition } from "../../types/models";
function compatibilityOperation(route: ModelRequestRouting): ModelOperation {
  if (route.family === "flux-2-gallery") return "style-workflow";
  const legacy: Record<string, ModelOperation> = {
    edit: "image-edit",
    train: "training",
    "train-edit": "training",
    complete: "draft-complete",
    "video-to-video/edit": "video-edit",
    "video-to-video/reference": "video-reference",
    realtime: "text-to-image",
    "text-to-image": "text-to-image",
    "text-to-video": "text-to-video",
    "image-to-video": "image-to-video",
    "reference-to-video": "reference-to-video",
    "motion-control": "motion-control",
    outpaint: "outpaint",
    "create-voice": "create-voice",
  };
  const compatible = legacy[route.operation];
  if (!compatible) throw new Error(`Unsupported discovery operation: ${route.operation}`);
  return compatible;
}
/** True when no public tariff or curated definition exists, so price() uses the platform API record. */
function usesApiFallback(id: string): boolean {
  return !publicTariff(id) && findFalPriceRecord(id) !== undefined && curated(id) === undefined;
}
function curated(id: string): PricingDefinition | undefined {
  // Never propagate a sibling endpoint price without operation-specific evidence.
  if (id === "fal-ai/flux-2-pro")
    return {
      kind: "megapixels",
      firstUsd: 0.03,
      extraUsd: 0.015,
      inputExtraUsd: 0.015,
    };
  if (id === "fal-ai/kling-video/v3/pro/image-to-video")
    return {
      kind: "range",
      lowUsdPerUnit: 0.112,
      expectedUsdPerUnit: 0.168,
      highUsdPerUnit: 0.196,
    };
  if (id === "bytedance/seedance-2.5/reference-to-video")
    return {
      kind: "video-tokens",
      usdPerThousand: 0.0214,
      videoReferenceMultiplier: 0.6,
      forecastMargin: 0.05,
    };
  if (id === "openai/gpt-image-2.5/sunburst/text-to-image")
    return {
      kind: "tokens",
      ratesPerMillion: {
        textInput: 5,
        imageInput: 8,
        imageOutput: 30,
        cachedTextInput: 1.25,
        cachedImageInput: 2,
        textOutput: 10,
        thinkingOutput: 10,
      },
      forecastMargin: 0.2,
    };
  if (id === "google/nano-banana-2.1")
    return {
      kind: "tokens",
      ratesPerMillion: {
        textInput: 1.764,
        imageInput: 1.764,
        imageOutput: 35.294,
        thinkingOutput: 8.823,
      },
      forecastMargin: 0.2,
    };
  return undefined;
}
function price(id: string): PricingDefinition {
  const published = publicTariff(id);
  if (published) return published.pricing;
  const known = curated(id);
  if (known) return known;
  // Only operations without a curated definition fall back to their own platform API record.
  const record = findFalPriceRecord(id);
  if (record) {
    const entry = findCatalogEntry(id);
    return pricingFromRecord(record, entry && pricingContext(entry), loadFalUnitSemantics().get(id));
  }
  return {
    kind: "unknown",
    reason: "No operation-specific verified price snapshot. Refresh schema and pricing before paid use.",
  };
}
const compatibilityFamilies: Record<ModelRequestRouting["family"], ModelDescriptor["family"]> = {
  "gpt-image-2.6": "gpt-image-2.6",
  "gpt-image-2.5": "gpt-image-2.5",
  "nano-banana-2.1": "nano-banana-2.1",
  "flux-2": "flux-2",
  "flux-2-gallery": "flux-2",
  "kling-v3": "kling-3",
  "kling-o3": "kling-o3",
  "kling-voice": "kling-voice",
  "seedance-2.5": "seedance-2.5",
};
const rows: ModelDescriptor[] = snapshots.map((snapshot) => {
  const { family, variant, operation, region, transport } = snapshot;
  const parsed = FalOperationRequestSchema.parse({ family, variant, operation, region, transport, input: {} });
  const requestRouting: ModelRequestRouting = Object.freeze({
    family: parsed.family,
    variant: parsed.variant!,
    operation: parsed.operation,
    region: parsed.region,
    transport: parsed.transport!,
  });
  const apiRecord =
    publicTariff(snapshot.endpoint) || !usesApiFallback(snapshot.endpoint)
      ? undefined
      : findFalPriceRecord(snapshot.endpoint);
  return {
    id: snapshot.endpoint,
    family: compatibilityFamilies[requestRouting.family],
    requestRouting,
    operation: compatibilityOperation(requestRouting),
    transport: requestRouting.transport === "realtime" ? "session" : requestRouting.transport,
    region: requestRouting.region,
    source: apiRecord ? platformPricingSourceUrl(snapshot.endpoint) : `https://fal.ai/models/${snapshot.endpoint}`,
    asOf: apiRecord ? apiRecord.observedAsOf.slice(0, 10) : snapshot.asOf,
    pricing: price(snapshot.endpoint),
    verification: {
      discovery: true,
      schema: snapshot.schemaStatus === "verified",
      localAdapter:
        snapshot.schemaStatus === "verified" &&
        hasLocalFalTransport(snapshot.endpoint, snapshot.transport as ModelRequestRouting["transport"]),
      live: false,
    },
    capabilities: {
      pricingEvidence: publicTariff(snapshot.endpoint)?.evidence,
      schemaSource: snapshot.schemaSource,
      schemaAsOf: snapshot.asOf,
      schemaSha256: snapshot.sha256,
      transport: snapshot.transport,
      liveAcceptance: "not-run",
    },
  };
});
/** Bundled provider input/output schema with its referenced components. No network discovery. */
export function findModelSchema(id: string) {
  const snapshot = snapshots.find((row) => row.endpoint === id);
  return snapshot
    ? {
        input: snapshot.input,
        output: snapshot.output,
        schemas: snapshot.schemas,
        schemaSource: snapshot.schemaSource,
        asOf: snapshot.asOf,
        sha256: snapshot.sha256,
      }
    : undefined;
}
export const MODEL_REGISTRY: Readonly<Record<string, ModelDescriptor>> = Object.freeze(
  Object.fromEntries(rows.map((row) => [row.id, Object.freeze(row)])),
);
export function findModel(id: string): ModelDescriptor | undefined {
  return MODEL_REGISTRY[id];
}
export function listModels(
  filter: {
    family?: ModelDescriptor["family"] | ModelRequestRouting["family"];
    requestFamily?: ModelRequestRouting["family"];
    requestOperation?: ModelRequestRouting["operation"];
    requestTransport?: ModelRequestRouting["transport"];
    region?: ModelRequestRouting["region"];
    operation?: ModelOperation;
    transport?: ModelDescriptor["transport"];
  } = {},
): ModelDescriptor[] {
  return Object.values(MODEL_REGISTRY).filter(
    (model) =>
      (!filter.family || model.family === filter.family || model.requestRouting.family === filter.family) &&
      (!filter.requestFamily || model.requestRouting.family === filter.requestFamily) &&
      (!filter.requestOperation || model.requestRouting.operation === filter.requestOperation) &&
      (!filter.requestTransport || model.requestRouting.transport === filter.requestTransport) &&
      (!filter.region || model.requestRouting.region === filter.region) &&
      (!filter.operation || model.operation === filter.operation) &&
      (!filter.transport || model.transport === filter.transport),
  );
}
/** Stable logical aliases for existing CLI/project files. */
export const LEGACY_ENDPOINTS: Readonly<Record<string, Partial<Record<ModelOperation, string>>>> = {
  "flux-schnell": { "text-to-image": "fal-ai/flux/schnell" },
  "flux-dev": { "text-to-image": "fal-ai/flux/dev" },
  "flux-pro": { "text-to-image": "fal-ai/flux-pro/v1.1" },
  "flux-pro-ultra": { "text-to-image": "fal-ai/flux-pro/v1.1-ultra" },
  "gpt-image-1": {
    "text-to-image": "fal-ai/gpt-image-1",
    "image-edit": "fal-ai/gpt-image-1/edit",
  },
  "gpt-image-2": {
    "text-to-image": "openai/gpt-image-2",
    "image-edit": "openai/gpt-image-2/edit",
  },
  "kling-2.5-turbo": {
    "text-to-video": "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    "image-to-video": "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
  },
  "seedance-1-pro": {
    "text-to-video": "fal-ai/bytedance/seedance/v1/pro/text-to-video",
    "image-to-video": "fal-ai/bytedance/seedance/v1/pro/image-to-video",
  },
  "seedance-2-fast": {
    "text-to-video": "bytedance/seedance-2.0/fast/text-to-video",
    "image-to-video": "bytedance/seedance-2.0/fast/image-to-video",
    "reference-to-video": "bytedance/seedance-2.0/fast/reference-to-video",
  },
  "hailuo-02-pro": {
    "text-to-video": "fal-ai/minimax/hailuo-02/pro/text-to-video",
    "image-to-video": "fal-ai/minimax/hailuo-02/pro/image-to-video",
  },
};
export function resolveModelEndpoint(model: string, operation: ModelOperation): string | undefined {
  const found = findModel(model);
  if (found) return found.operation === operation ? found.id : undefined;
  return LEGACY_ENDPOINTS[model.replace(/^fal:/, "")]?.[operation];
}
