import { ModelPreparationGuideSchema } from "./model-preparation-binding";
import { z } from "zod";
import { FalOperationContextSchema } from "./generation";

/**
 * Contracts for the whole fal catalogue (docs/fal-integration.md).
 * The endpoint ID is the primary key; family/variant labels are optional legacy routing.
 */

/** Categories as fal's Platform API reports them (GET /v1/models metadata.category). */
export const FAL_CATEGORIES = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "audio-to-video",
  "text-to-audio",
  "audio-to-audio",
  "text-to-speech",
  "speech-to-text",
  "speech-to-speech",
  "audio-to-text",
  "video-to-audio",
  "video-to-text",
  "image-to-text",
  "image-to-3d",
  "text-to-3d",
  "3d-to-3d",
  "worlds",
  "vision",
  "llm",
  "text-to-text",
  "json",
  "image-to-json",
  "text-to-json",
  "training",
  "workflow",
  "unknown",
] as const;
export const FalCategorySchema = z.enum(FAL_CATEGORIES);
export type FalCategory = z.infer<typeof FalCategorySchema>;
/** Unknown category strings from a future catalogue are kept as `unknown`, never dropped. */
export function normaliseFalCategory(value: unknown): FalCategory {
  return FalCategorySchema.safeParse(value).success ? (value as FalCategory) : "unknown";
}

/** What a result file or field is, independent of the endpoint family. */
export const OUTPUT_KINDS = ["image", "video", "audio", "model3d", "text", "json", "weights", "file"] as const;
export const OutputKindSchema = z.enum(OUTPUT_KINDS);
export type OutputKind = z.infer<typeof OutputKindSchema>;
/** Media an input field takes (a `*_url`/`*_urls` field, or an x-fal media hint). */
export const InputMediaSchema = z.enum(["image", "video", "audio", "file", "model3d"]);
export type InputMedia = z.infer<typeof InputMediaSchema>;
/**
 * What an endpoint can do beyond its input media, read from its input fields (`--capability`).
 * Matchers and descriptions: src/lib/models/capabilities.ts. Each id is held by at least one real model.
 */
export const MODEL_CAPABILITY_IDS = [
  "image-input",
  "start-frame",
  "end-frame",
  "multi-reference",
  "video-input",
  "audio-input",
  "generate-audio",
  "audio-driven",
  "voice",
  "voice-clone",
  "lyrics",
  "language",
  "seed",
  "negative-prompt",
  "camera-control",
  "loop",
  "multi-shot",
  "elements",
  "keyframes",
  "mask",
  "style-reference",
  "style-preset",
  "character-reference",
  "lora",
  "fps",
  "num-outputs",
  "transparent-background",
  "prompt-expansion",
  "safety-tolerance",
  "guidance",
  "steps",
  "output-format",
  "upscale-factor",
  "web-search",
] as const;
export const ModelCapabilitySchema = z.enum(MODEL_CAPABILITY_IDS);
export type ModelCapability = z.infer<typeof ModelCapabilitySchema>;

export const TrustTierSchema = z.enum(["discovered", "priced", "verified", "live"]);
export type TrustTier = z.infer<typeof TrustTierSchema>;
export const TRUST_ORDER: Readonly<Record<TrustTier, number>> = Object.freeze({
  discovered: 0,
  priced: 1,
  verified: 2,
  live: 3,
});

export const FalTransportSchema = z.enum(["queue", "stream", "realtime", "training"]);
/**
 * Which service runs an endpoint. The same endpoint ID can exist at both with different schemas
 * (bytedance/seedance-2.5/reference-to-video), so every lookup is keyed by (provider, endpoint).
 * A record without `provider` is fal: every file written before Higgsfield support.
 */
export const PROVIDER_IDS = ["fal", "higgsfield"] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
export function providerOf(record: { provider?: ProviderId }): ProviderId {
  return record.provider ?? "fal";
}
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const isoDate = z.union([z.iso.date(), z.iso.datetime()]);
const endpointId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/)
  .max(200);
const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** One input field, compact enough for a tracked index (no descriptions). */
export const InputFieldSummarySchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean(),
    enum: z.array(scalar).max(64).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    default: z.unknown().optional(),
    media: InputMediaSchema.optional(),
    array: z.boolean().optional(),
  })
  .strict();
export type InputFieldSummary = z.infer<typeof InputFieldSummarySchema>;

/** A price as the Platform API states it; converted to PricingDefinition by models/fal-pricing.ts. */
export const FalPriceRecordSchema = z
  .object({
    endpoint: endpointId,
    unitPrice: z.number().finite().nonnegative(),
    unit: z.string().min(1),
    currency: z.literal("USD"),
    observedAsOf: isoDate,
    source: z.literal("platform-pricing-api"),
  })
  .strict();
export type FalPriceRecord = z.infer<typeof FalPriceRecordSchema>;

export const FalCatalogEntrySchema = z
  .object({
    endpoint: endpointId,
    category: FalCategorySchema,
    displayName: z.string(),
    status: z.enum(["active", "deprecated", "gone"]),
    retiresAt: isoDate.optional(),
    replacement: endpointId.optional(),
    firstSeen: isoDate,
    lastSeen: isoDate,
    schema: z.object({ sha256, asOf: isoDate, source: z.string().url(), cached: z.boolean() }).strict().nullable(),
    inputs: z.array(InputFieldSummarySchema),
    outputs: z.object({ kinds: z.array(OutputKindSchema), fields: z.array(z.string()) }).strict(),
    transport: FalTransportSchema,
    price: FalPriceRecordSchema.omit({ endpoint: true }).nullable(),
    tier: TrustTierSchema,
    /** Legacy modern-family routing for the 98 original snapshot endpoints. */
    routing: z
      .object({ family: z.string(), variant: z.string(), operation: z.string(), region: z.string() })
      .strict()
      .optional(),
    tags: z.array(z.string()).default([]),
    /** Absent means fal. */
    provider: ProviderIdSchema.optional(),
    /** Provider release date of the model family (Higgsfield catalogue `released_on`); newer usually means better. */
    releasedOn: z.iso.date().optional(),
    /** One-sentence provider description, used by fal:find for meaning, never for quality claims. */
    description: z.string().max(600).optional(),
    /** A model only this provider offers (Higgsfield "Exclusive"). */
    exclusive: z.boolean().optional(),
    /** Provider model family, e.g. Higgsfield catalogue slug "genjutsu-light". */
    family: z
      .object({ slug: z.string().min(1), title: z.string().min(1), company: z.string().min(1).optional() })
      .strict()
      .optional(),
    /** Human documentation page of this endpoint. */
    docsUrl: z.string().url().optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.tier !== "discovered" && !entry.schema)
      ctx.addIssue({ code: "custom", path: ["tier"], message: "Only a discovered entry may lack a schema." });
    if (entry.tier === "priced" && !entry.price)
      ctx.addIssue({ code: "custom", path: ["price"], message: "A priced entry needs a price record." });
    if (entry.tier === "live")
      ctx.addIssue({
        code: "custom",
        path: ["tier"],
        message: "live requires a recorded receipt; no tracked entry may claim it yet.",
      });
  });
export type FalCatalogEntry = z.infer<typeof FalCatalogEntrySchema>;

/** One tracked file per category: src/lib/models/fal-catalog/<category>.json */
export const FalCatalogFileSchema = z
  .object({
    version: z.literal(1),
    /** Absent means fal; a Higgsfield index lives in src/lib/models/hf-catalog/. */
    provider: ProviderIdSchema.optional(),
    category: FalCategorySchema,
    syncedAt: isoDate,
    entries: z.array(FalCatalogEntrySchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = file.entries.map((e) => e.endpoint);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["entries"], message: "Duplicate endpoint." });
    if (file.entries.some((e) => providerOf(e) !== providerOf(file)))
      ctx.addIssue({ code: "custom", path: ["entries"], message: "Entry provider differs from file provider." });
    if (file.entries.some((e) => e.category !== file.category))
      ctx.addIssue({ code: "custom", path: ["entries"], message: "Entry category differs from file category." });
    if (ids.join("\n") !== [...ids].sort().join("\n"))
      ctx.addIssue({ code: "custom", path: ["entries"], message: "Entries must be sorted by endpoint." });
  });
export type FalCatalogFile = z.infer<typeof FalCatalogFileSchema>;

export const FalDriftReportSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.iso.datetime(),
    added: z.array(endpointId),
    gone: z.array(endpointId),
    schemaChanged: z.array(z.object({ endpoint: endpointId, from: sha256, to: sha256 }).strict()),
    retiring: z.array(
      z.object({ endpoint: endpointId, retiresAt: isoDate, replacement: endpointId.optional() }).strict(),
    ),
    priceDrift: z.array(z.object({ endpoint: endpointId, tracked: z.string(), observed: z.string() }).strict()),
    demoted: z.array(
      z.object({ endpoint: endpointId, from: TrustTierSchema, to: TrustTierSchema, reason: z.string() }).strict(),
    ),
  })
  .strict();
export type FalDriftReport = z.infer<typeof FalDriftReportSchema>;

/** Hand-kept judgement: src/lib/models/fal-curation.json */
export const FalCurationEntrySchema = z
  .object({
    endpoint: endpointId,
    category: FalCategorySchema,
    roles: z
      .array(
        z.enum([
          "hero",
          "fast-draft",
          "budget",
          "text-render",
          "reference",
          "edit",
          "inpaint",
          "outpaint",
          "frame-interpolation",
          "lipsync",
          "avatar",
          "upscale",
          "cutout",
          "voice",
          "transcript",
          "sfx",
          "music",
          "foley",
          "mesh",
          "world",
          "analysis",
          "training",
          "motion-transfer",
          "character-swap",
          "restyle",
          "character",
          "ads",
          "cinematic",
        ]),
      )
      .min(1),
    notes: z.string().min(1),
    source: z.string().min(1),
    reviewedAt: z.iso.date(),
    /** Absent means fal. */
    provider: ProviderIdSchema.optional(),
  })
  .strict();
export const FalCurationFileSchema = z
  .object({ version: z.literal(1), entries: z.array(FalCurationEntrySchema) })
  .strict();
export type FalCurationEntry = z.infer<typeof FalCurationEntrySchema>;

/** `--field`: a bounded, compilable regular expression over input field names. */
export const FieldPatternSchema = z
  .string()
  .min(1)
  .max(120)
  .refine((value) => {
    try {
      new RegExp(value, "i");
      return true;
    } catch {
      return false;
    }
  }, "Not a valid regular expression");
/** One capability an endpoint was matched on, with the schema field that proves it. */
export const MatchedCapabilitySchema = z.object({ capability: z.string(), field: z.string() }).strict();
/** fal:find query: deterministic ranking, no LLM. */
export const FalFindQuerySchema = z
  .object({
    provider: z.enum(["fal", "higgsfield", "any"]).optional(),
    task: z.string().max(500).optional(),
    categories: z.array(FalCategorySchema).optional(),
    inputs: z.array(InputMediaSchema).optional(),
    capabilities: z.array(ModelCapabilitySchema).optional(),
    /** At least one of these capabilities. */
    anyCapabilities: z.array(ModelCapabilitySchema).optional(),
    /** Raw schema field fallback: a case-insensitive pattern one input field name must match. */
    field: FieldPatternSchema.optional(),
    /** Seconds of input audio/video the model must accept, where its schema states a limit. */
    inputAudioSec: z.number().positive().optional(),
    inputVideoSec: z.number().positive().optional(),
    outputs: z.array(OutputKindSchema).optional(),
    durationSec: z.number().positive().optional(),
    aspect: z
      .string()
      .regex(/^\d+:\d+$/)
      .optional(),
    resolution: z.string().optional(),
    maxUsd: z.number().positive().optional(),
    minTier: TrustTierSchema.default("discovered"),
    includeRetiring: z.boolean().default(false),
    includeSchemaless: z.boolean().default(false),
    explain: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(10),
  })
  .strict();
export type FalFindQuery = z.input<typeof FalFindQuerySchema>;
export const ModelChoicePriceSchema = z
  .object({
    kind: z.enum(["exact", "tiered", "floor", "unknown", "approximate", "typical"]),
    label: z.string(),
    usd: z.number().nullable(),
    unitPrice: z.number().nullable(),
    unit: z.string().nullable(),
    asOf: z.string().nullable(),
    evidenceKind: z.string(),
    basis: z.string().nullable(),
  })
  .strict();
export type ModelChoicePrice = z.infer<typeof ModelChoicePriceSchema>;
export const ModelEquivalentsSchema = z
  .object({
    members: z.array(
      z.object({ provider: ProviderIdSchema, endpoint: endpointId, price: ModelChoicePriceSchema }).strict(),
    ),
    cheaper: ProviderIdSchema.nullable(),
    savingUsd: z.number().nullable(),
    savingPercent: z.number().nullable(),
    note: z.string(),
  })
  .strict();
export type ModelEquivalents = z.infer<typeof ModelEquivalentsSchema>;
export const FalFindCandidateSchema = z
  .object({
    provider: ProviderIdSchema,
    releasedOn: z.iso.date().nullable(),
    price: ModelChoicePriceSchema,
    equivalents: ModelEquivalentsSchema.optional(),
    endpoint: endpointId,
    category: FalCategorySchema,
    tier: TrustTierSchema,
    score: z.number(),
    reasons: z.array(z.string()),
    warnings: z.array(z.string()),
    estimate: z
      .object({
        lowUsd: z.number().nullable(),
        expectedUsd: z.number().nullable(),
        highUsd: z.number().nullable(),
        bounded: z.boolean(),
        unit: z.string().nullable(),
      })
      .strict(),
    nextCommands: z.array(z.string()),
    preparation: ModelPreparationGuideSchema.optional(),
    /** Requested capabilities (and `--field`) that matched, each with its schema field. */
    matchedCapabilities: z.array(MatchedCapabilitySchema).optional(),
    rejectedBecause: z.array(z.string()).optional(),
  })
  .strict();
export type FalFindCandidate = z.infer<typeof FalFindCandidateSchema>;

export const FalFindMatchSchema = z
  .object({
    matched: z.boolean(),
    via: z.enum(["task-map", "lexical", "explicit", "none"]),
    concepts: z.array(z.string()),
  })
  .strict();
export const FalFindResultSchema = z
  .object({
    match: FalFindMatchSchema,
    candidates: z.array(FalFindCandidateSchema),
    message: z.string().optional(),
    suggestions: z.array(
      z.object({ concept: z.string(), categories: z.array(FalCategorySchema), exampleCommand: z.string() }).strict(),
    ),
    nextActions: z.array(z.string()),
  })
  .strict();
export type FalFindResult = z.infer<typeof FalFindResultSchema>;

/** N physical operations, one identity each (AGENTS.md: a batch needs separate operation identities). */
export const FalBatchSpecSchema = z
  .object({
    version: z.literal(1),
    batchId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/),
    endpoint: endpointId,
    baseInput: z.record(z.string(), z.unknown()),
    context: FalOperationContextSchema.optional(),
    variations: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/),
            inputPatch: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    outputDir: z.string().min(1),
    assetIdPrefix: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,80}$/),
    maxCostUsdPerOp: z.number().positive().finite().optional(),
    stage: z.string().optional(),
  })
  .strict()
  .superRefine((spec, ctx) => {
    const ids = spec.variations.map((v) => v.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["variations"], message: "Variation IDs must be unique." });
  });
export type FalBatchSpec = z.input<typeof FalBatchSpecSchema>;

/** Endpoints raised to `verified`, each pinned to the catalogue hash it was verified at: src/lib/models/fal-verified.json. */
export const FalVerifiedPinSchema = z
  .object({
    /** null: pin on the next sync (`fal:sync --pin-verified`); a later different hash demotes the entry. */
    catalogSha256: sha256.nullable(),
    since: z.iso.date(),
  })
  .strict();
export const FalVerifiedFileSchema = z
  .object({
    version: z.literal(1),
    pins: z.record(endpointId, FalVerifiedPinSchema),
  })
  .strict();
export type FalVerifiedPin = z.infer<typeof FalVerifiedPinSchema>;
export type FalVerifiedFile = z.infer<typeof FalVerifiedFileSchema>;
