import { createHash } from "node:crypto";
import { z } from "zod";
import { HiggsfieldPriceRecordSchema } from "./higgsfield";

export const MAX_PRICING_EVIDENCE_BYTES = 32 * 1024;
function assertFiniteJson(value: unknown, ancestors = new Set<object>(), depth = 0): void {
  if (depth > 8) throw new Error("Evidence JSON nesting exceeds its closed payload depth.");
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "string") {
    if (value.length > MAX_PRICING_EVIDENCE_BYTES) throw new Error("Evidence string exceeds its finite bound.");
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (
    typeof value !== "object" ||
    value === null ||
    (![Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      !(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype))
  )
    throw new Error("Evidence must be plain finite JSON.");
  if (ancestors.has(value)) throw new Error("Circular evidence is not JSON.");
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128 || keys.some((key) => typeof key !== "string"))
    throw new Error("Evidence JSON has unsupported keys.");
  ancestors.add(value);
  for (const key of keys) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable || !("value" in descriptor))
      throw new Error("Evidence JSON cannot contain accessors or hidden fields.");
    assertFiniteJson(descriptor.value, ancestors, depth + 1);
  }
  if (
    Array.isArray(value) &&
    (keys.length !== value.length + 1 || keys.some((key) => key !== "length" && !/^(0|[1-9][0-9]*)$/.test(String(key))))
  )
    throw new Error("Evidence cannot contain sparse or extended arrays.");
  ancestors.delete(value);
}
const finiteJson = z.unknown().superRefine((value, ctx) => {
  try {
    assertFiniteJson(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Evidence must be bounded plain finite JSON without executable/accessor/circular values.",
    });
  }
});
const rate = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 1_000_000);
const margin = z.number().finite().min(0).max(1);
const tokenRates = z
  .object({
    textInput: rate,
    imageInput: rate,
    imageOutput: rate,
    textOutput: rate.optional(),
    cachedTextInput: rate.optional(),
    cachedImageInput: rate.optional(),
    thinkingOutput: rate.optional(),
  })
  .strict();
/** Closed historical descriptor; absent optional categories are never filled/inferred. */
export const ClosedPricingDefinitionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unknown"), reason: z.string().min(1).max(8192) }).strict(),
  z.object({ kind: z.literal("free") }).strict(),
  z
    .object({
      kind: z.literal("fixed"),
      usdPerUnit: rate,
      quantity: z
        .enum(["generated-second", "output", "request", "input-kilo-characters", "input-audio-minute"])
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("range"),
      lowUsdPerUnit: rate,
      expectedUsdPerUnit: rate,
      highUsdPerUnit: rate,
      audioRates: z.object({ off: rate, on: rate, voice: rate }).strict().optional(),
    })
    .strict()
    .refine(
      (value) => value.lowUsdPerUnit <= value.expectedUsdPerUnit && value.expectedUsdPerUnit <= value.highUsdPerUnit,
      "Rate ranges must be ordered.",
    ),
  z.object({ kind: z.literal("tokens"), ratesPerMillion: tokenRates, forecastMargin: margin }).strict(),
  z.object({ kind: z.literal("megapixels"), firstUsd: rate, extraUsd: rate, inputExtraUsd: rate }).strict(),
  z
    .object({
      kind: z.literal("video-tokens"),
      usdPerThousand: rate,
      videoReferenceMultiplier: rate,
      forecastMargin: margin,
      resolutionRates: z
        .object({ "480p": rate.optional(), "720p": rate.optional(), "1080p": rate.optional(), "4k": rate.optional() })
        .strict()
        .optional(),
      acceptsVideoReferences: z.boolean().optional(),
    })
    .strict(),
]);
export type ClosedPricingDefinition = z.infer<typeof ClosedPricingDefinitionSchema>;
const endpoint = z
  .string()
  .min(1)
  .max(300)
  .regex(/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/);
const observedDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }, "Observation must be a real ISO calendar date.");
const payloadFields = {
  kind: z.literal("public-list-tariff"),
  version: z.literal(1),
  provider: z.literal("fal.ai"),
  endpoint,
  model: endpoint,
  sourceUrl: z.string().max(332),
  observedAsOf: observedDate,
  currency: z.literal("USD"),
  unit: z.string().min(1).max(200),
  conditions: z.string().min(1).max(8192),
  acceptance: z.literal("not-run"),
  pricing: ClosedPricingDefinitionSchema,
};
function coherentPayload(value: { endpoint: string; model: string; sourceUrl: string }, ctx: z.RefinementCtx): void {
  if (value.model !== value.endpoint)
    ctx.addIssue({ code: "custom", path: ["model"], message: "Evidence model must equal its exact endpoint." });
  if (value.sourceUrl !== `https://fal.ai/models/${value.endpoint}`)
    ctx.addIssue({
      code: "custom",
      path: ["sourceUrl"],
      message: "Evidence requires the exact public model URL without aliases/query/fragment.",
    });
}
export const PublicListPricingPayloadSchema = finiteJson.pipe(
  z.object(payloadFields).strict().superRefine(coherentPayload),
);
export type PublicListPricingPayloadV1 = z.infer<typeof PublicListPricingPayloadSchema>;

/** Equivalent finite-JSON key ordering to generationInputHash, without runner/store imports. */
function canonical(value: unknown, locale?: string): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, locale)).join(",")}]`;
  if (typeof value === "object" && value !== null && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b, locale))
      .map(([key, field]) => `${JSON.stringify(key)}:${canonical(field, locale)}`)
      .join(",")}}`;
  }
  throw new Error("Pricing evidence must contain finite JSON without undefined or executable values.");
}
export function pricingEvidenceDigest(payload: PublicListPricingPayloadV1): string {
  const parsed = PublicListPricingPayloadSchema.parse(payload);
  const bytes = canonical(parsed);
  if (Buffer.byteLength(bytes, "utf8") > MAX_PRICING_EVIDENCE_BYTES)
    throw new Error("Pricing evidence exceeds 32 KiB canonical UTF-8 bound.");
  return createHash("sha256").update(bytes).digest("hex");
}
export const PublicListPricingEvidenceSchema = finiteJson.pipe(
  z
    .object({ ...payloadFields, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .superRefine((value, ctx) => {
      coherentPayload(value, ctx);
      if (Buffer.byteLength(canonical(value), "utf8") > MAX_PRICING_EVIDENCE_BYTES)
        ctx.addIssue({ code: "custom", message: "Full pricing evidence exceeds 32 KiB canonical UTF-8 bound." });
      const { sha256, ...payload } = value;
      try {
        if (pricingEvidenceDigest(payload) !== sha256)
          ctx.addIssue({ code: "custom", path: ["sha256"], message: "Pricing evidence digest mismatch." });
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid or oversized canonical pricing evidence." });
      }
    }),
);
export type PublicListPricingEvidenceV1 = z.infer<typeof PublicListPricingEvidenceSchema>;

/**
 * fal Platform pricing API record (GET /v1/models/pricing), converted by models/fal-pricing.ts.
 * The URL keeps the raw endpoint (no %2F), as the legacy fal music entries in pricing.ts do.
 */
export const FAL_PLATFORM_PRICING_API = "https://api.fal.ai/v1/models/pricing";
export function platformPricingSourceUrl(endpoint: string): string {
  return `${FAL_PLATFORM_PRICING_API}?endpoint_id=${endpoint}`;
}
const platformEndpoint = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/);
const platformFields = {
  kind: z.literal("platform-pricing-api"),
  version: z.literal(1),
  provider: z.literal("fal.ai"),
  endpoint: platformEndpoint,
  model: platformEndpoint,
  source: z.string().max(300),
  observedAsOf: observedDate,
  currency: z.literal("USD"),
  unit: z.string().min(1).max(200),
  unitPrice: rate,
  acceptance: z.literal("not-run"),
  pricing: ClosedPricingDefinitionSchema,
};
function coherentPlatformPayload(
  value: { endpoint: string; model: string; source: string; pricing: ClosedPricingDefinition },
  ctx: z.RefinementCtx,
): void {
  if (value.model !== value.endpoint)
    ctx.addIssue({ code: "custom", path: ["model"], message: "Evidence model must equal its exact endpoint." });
  if (value.source !== platformPricingSourceUrl(value.endpoint))
    ctx.addIssue({
      code: "custom",
      path: ["source"],
      message: "Evidence requires the exact pricing API URL for its endpoint.",
    });
  if (value.pricing.kind === "unknown" || value.pricing.kind === "free")
    ctx.addIssue({
      code: "custom",
      path: ["pricing"],
      message: "Platform evidence carries a bounded positive definition only.",
    });
}
export const PlatformPricingPayloadSchema = finiteJson.pipe(
  z.object(platformFields).strict().superRefine(coherentPlatformPayload),
);
export type PlatformPricingPayloadV1 = z.infer<typeof PlatformPricingPayloadSchema>;
export function platformPricingEvidenceDigest(payload: PlatformPricingPayloadV1): string {
  const parsed = PlatformPricingPayloadSchema.parse(payload);
  const bytes = canonical(parsed);
  if (Buffer.byteLength(bytes, "utf8") > MAX_PRICING_EVIDENCE_BYTES)
    throw new Error("Pricing evidence exceeds 32 KiB canonical UTF-8 bound.");
  return createHash("sha256").update(bytes).digest("hex");
}
export const PlatformPricingEvidenceSchema = finiteJson.pipe(
  z
    .object({ ...platformFields, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .superRefine((value, ctx) => {
      coherentPlatformPayload(value, ctx);
      const { sha256, ...payload } = value;
      try {
        if (platformPricingEvidenceDigest(payload) !== sha256)
          ctx.addIssue({ code: "custom", path: ["sha256"], message: "Pricing evidence digest mismatch." });
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid or oversized canonical pricing evidence." });
      }
    }),
);
export type PlatformPricingEvidenceV1 = z.infer<typeof PlatformPricingEvidenceSchema>;

/** Same canonical input hash as the durable runner, without importing its store. */
export function higgsfieldPricingInputHash(input: Record<string, unknown>, locale?: string): string {
  return createHash("sha256").update(canonical(input, locale)).digest("hex");
}
const higgsfieldFields = {
  kind: z.enum(["higgsfield-estimate", "higgsfield-list"]),
  version: z.literal(1),
  provider: z.literal("higgsfield"),
  canonicalLocale: z
    .string()
    .min(1)
    .max(100)
    .refine((locale) => {
      try {
        new Intl.Collator(locale);
        return true;
      } catch {
        return false;
      }
    }, "Invalid canonical collation locale.")
    .optional(),
  endpoint: platformEndpoint,
  model: platformEndpoint,
  source: z.string().max(350),
  observedAsOf: observedDate,
  currency: z.literal("USD"),
  acceptance: z.literal("not-run"),
  pricing: ClosedPricingDefinitionSchema,
  discountedUsd: rate,
  undiscountedUsd: rate,
  discountApplied: z.boolean(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.record(z.string(), finiteJson).optional(),
  defaults: z.record(z.string(), finiteJson),
  media: z.record(z.string(), z.object({ durationSec: rate.optional() }).strict()),
  videoInput: z.boolean(),
  record: HiggsfieldPriceRecordSchema,
};
function coherentHiggsfield(
  value: {
    kind: string;
    endpoint: string;
    model: string;
    source: string;
    discountedUsd: number;
    undiscountedUsd: number;
    discountApplied: boolean;
    pricing: ClosedPricingDefinition;
    record: { endpoint: string; observedAsOf: string };
    observedAsOf: string;
  },
  ctx: z.RefinementCtx,
): void {
  const source =
    value.kind === "higgsfield-estimate"
      ? `https://api.higgsfield.ai/estimate/${value.endpoint}`
      : "https://dash.higgsfield.ai/api/v2/catalog-models/?page_size=100";
  if (
    value.endpoint !== value.model ||
    value.endpoint !== value.record.endpoint ||
    value.observedAsOf !== value.record.observedAsOf ||
    value.source !== source
  )
    ctx.addIssue({ code: "custom", message: "Higgsfield evidence binding differs from its record." });
  if (value.undiscountedUsd < value.discountedUsd)
    ctx.addIssue({ code: "custom", message: "Discount exceeds the undiscounted price." });
  if (value.kind === "higgsfield-list") {
    if (value.pricing.kind !== "unknown")
      ctx.addIssue({ code: "custom", message: "Catalogue floor evidence is for comparisons only." });
  } else if (
    value.pricing.kind !== "fixed" ||
    value.pricing.quantity !== "request" ||
    value.pricing.usdPerUnit !== (value.discountApplied ? value.discountedUsd : value.undiscountedUsd)
  )
    ctx.addIssue({ code: "custom", message: "Higgsfield request price differs from its reservation amount." });
}
export const HiggsfieldPricingPayloadSchema = finiteJson.pipe(
  z.object(higgsfieldFields).strict().superRefine(coherentHiggsfield),
);
export type HiggsfieldPricingPayloadV1 = z.infer<typeof HiggsfieldPricingPayloadSchema>;
export function higgsfieldPricingEvidenceDigest(payload: HiggsfieldPricingPayloadV1): string {
  const parsed = HiggsfieldPricingPayloadSchema.parse(payload);
  const bytes = canonical(parsed, parsed.canonicalLocale);
  if (Buffer.byteLength(bytes, "utf8") > MAX_PRICING_EVIDENCE_BYTES)
    throw new Error("Pricing evidence exceeds 32 KiB.");
  return createHash("sha256").update(bytes).digest("hex");
}
export const HiggsfieldPricingEvidenceSchema = finiteJson.pipe(
  z
    .object({ ...higgsfieldFields, sha256: z.string().regex(/^[a-f0-9]{64}$/) })
    .strict()
    .superRefine((value, ctx) => {
      coherentHiggsfield(value, ctx);
      const { sha256, ...payload } = value;
      try {
        if (
          value.input !== undefined &&
          value.inputHash !== higgsfieldPricingInputHash(value.input, value.canonicalLocale)
        )
          ctx.addIssue({ code: "custom", message: "Higgsfield input digest mismatch." });
        if (
          Buffer.byteLength(canonical(value, value.canonicalLocale), "utf8") > MAX_PRICING_EVIDENCE_BYTES ||
          higgsfieldPricingEvidenceDigest(payload) !== sha256
        )
          ctx.addIssue({ code: "custom", message: "Higgsfield pricing digest mismatch or oversized evidence." });
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid Higgsfield pricing evidence." });
      }
    }),
);
export type HiggsfieldPricingEvidenceV1 = z.infer<typeof HiggsfieldPricingEvidenceSchema>;

/** Either evidence kind; `kind` tells them apart. */
export const PricingEvidenceSchema = z.union([
  PublicListPricingEvidenceSchema,
  PlatformPricingEvidenceSchema,
  HiggsfieldPricingEvidenceSchema,
]);
export type PricingEvidenceV1 = PublicListPricingEvidenceV1 | PlatformPricingEvidenceV1 | HiggsfieldPricingEvidenceV1;

/** Historical shape/quote binding only: no comparison with today's mutable registry. */
export function pricingEvidenceMatchesQuote(quote: {
  lowUsd?: number | null;
  expectedUsd?: number | null;
  highUsd?: number | null;
  model?: string;
  source: string;
  asOf: string;
  currency: string;
  basis?: string;
  confidence: string;
  pricingEvidence?: PricingEvidenceV1;
}): boolean {
  const evidence = quote.pricingEvidence;
  if (!evidence) return true;
  if (
    evidence.provider === "higgsfield" &&
    (evidence.pricing.kind !== "fixed" ||
      quote.lowUsd !== evidence.pricing.usdPerUnit ||
      quote.expectedUsd !== evidence.pricing.usdPerUnit ||
      quote.highUsd !== evidence.pricing.usdPerUnit)
  )
    return false;
  const source = evidence.kind === "public-list-tariff" ? evidence.sourceUrl : evidence.source;
  return (
    quote.model === evidence.model &&
    quote.source === source &&
    quote.asOf === evidence.observedAsOf &&
    quote.currency === evidence.currency &&
    quote.basis === evidence.pricing.kind &&
    quote.confidence !== "user-bound" &&
    quote.confidence !== "unknown" &&
    evidence.pricing.kind !== "unknown"
  );
}
