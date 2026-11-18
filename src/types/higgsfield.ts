import { z } from "zod";

/**
 * Contracts for Higgsfield as a second model provider (docs/higgsfield.md).
 * Higgsfield publishes no model-list API with schemas: each workflow's JSON Schema comes from its
 * documentation page; prices come from the public catalogue (family "from" prices, discounts,
 * release dates) and the documented, free POST /estimate/<endpoint>.
 */

/** Higgsfield timestamps carry an offset, e.g. `2026-11-22T08:36:30.115746+00:00` (live status, 2026-11-15). */
const isoDate = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const endpointId = z
  .string()
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/)
  .max(200);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * One tracked schema file, src/lib/providers/schemas/higgsfield/<sha256>.json, where sha256 is the
 * hash of canonical JSON of `schema` alone. All Higgsfield schemas are tracked (they are small).
 */
export const HiggsfieldSchemaDocSchema = z
  .object({
    version: z.literal(1),
    endpoint: endpointId,
    title: z.string().min(1),
    /** The documentation page the schema was read from; absent for a schema-less catalogue model. */
    docsUrl: z.string().url().optional(),
    /** "Usage notes" bullets of the page, verbatim: limits JSON Schema does not encode. */
    usageNotes: z.array(z.string()).default([]),
    /** The page's "Complete JSON schema" (plain JSON Schema, may use if/then/else). */
    schema: z.record(z.string(), z.unknown()),
    asOf: z.iso.date(),
  })
  .strict();
export type HiggsfieldSchemaDoc = z.infer<typeof HiggsfieldSchemaDocSchema>;

/** A catalogue "from" price: a floor for the family, never a full price of a request. */
export const HiggsfieldListPriceSchema = z
  .object({
    amount: z.number().finite().nonnegative(),
    /** Pre-discount amount when the catalogue shows a sale. */
    originalAmount: z.number().finite().nonnegative().nullable(),
    unit: z.string().min(1),
    qualifier: z.string().nullable(),
    discountPercentage: z.number().finite().nonnegative().nullable(),
    discountExpiresAt: isoDate.nullable(),
    discountAfterExpiryPercentage: z.number().finite().nonnegative().nullable(),
    discountAfterExpiryExpiresAt: isoDate.nullable(),
  })
  .strict();

/** One parsed rate: "480p: $0.1540" in a pricing_description, or a measured estimate. */
export const HiggsfieldPriceTierSchema = z
  .object({
    /** The input value the rate applies to, e.g. { resolution: "480p" }; empty for a flat rate. */
    // Reserved $videoInput is derived from video URL fields: "absent" or "present"; it is not an input field.
    when: z.record(z.string(), z.string()).default({}),
    usdPerUnit: z.number().finite().nonnegative(),
    /** What is counted: generated seconds, source-video seconds, images, or the whole request. */
    basis: z.enum(["output-second", "source-second", "image", "request"]),
    /** Whole-second billing, upwards or to the nearest second, only when stated. */
    rounding: z.enum(["ceil-second", "nearest-second"]).nullable().default(null),
    capSeconds: z.number().finite().positive().optional(),
    approximate: z.literal(true).optional(),
    extras: z
      .array(
        z
          .object({
            field: z.string().min(1),
            includedCount: z.number().int().nonnegative(),
            usdPerExtra: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type HiggsfieldPriceTier = z.infer<typeof HiggsfieldPriceTierSchema>;

/** One /estimate answer, kept verbatim with the input that produced it. */
export const HiggsfieldEstimateSchema = z
  .object({
    input: z.record(z.string(), z.unknown()),
    type: z.enum(["estimate", "description"]),
    usd: z.number().finite().nonnegative().optional(),
    credits: z.number().finite().nonnegative().optional(),
    discountUsd: z.number().finite().nonnegative().optional(),
    discountPercentage: z.number().finite().nonnegative().optional(),
    pricingDescription: z.string().optional(),
    observedAt: isoDate,
  })
  .strict();
export type HiggsfieldEstimate = z.infer<typeof HiggsfieldEstimateSchema>;

/** One endpoint's price knowledge in src/lib/models/hf-prices.json. */
export const HiggsfieldPriceRecordSchema = z
  .object({
    endpoint: endpointId,
    /** Catalogue family slug the list price belongs to. */
    family: z.string().min(1).optional(),
    list: HiggsfieldListPriceSchema.nullable(),
    /** Parsed rates; empty when the description could not be parsed (the price is then unknown). */
    tiers: z.array(HiggsfieldPriceTierSchema).default([]),
    estimates: z.array(HiggsfieldEstimateSchema).default([]),
    /** Why tiers are empty or partial, e.g. "token-metered" (Cinema Studio). */
    unparsed: z.string().optional(),
    observedAsOf: z.iso.date(),
  })
  .strict();
export type HiggsfieldPriceRecord = z.infer<typeof HiggsfieldPriceRecordSchema>;

export const HiggsfieldPricesFileSchema = z
  .object({
    version: z.literal(1),
    syncedAt: z.iso.date().nullable(),
    prices: z.array(HiggsfieldPriceRecordSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = file.prices.map((row) => row.endpoint);
    if (ids.join("\n") !== [...ids].sort().join("\n") || new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["prices"], message: "Prices must be unique and sorted by endpoint." });
  });
export type HiggsfieldPricesFile = z.infer<typeof HiggsfieldPricesFileSchema>;

/** GET /requests/{id}/status (and the webhook payload's inner shape). */
export const HIGGSFIELD_STATUSES = ["queued", "in_progress", "completed", "failed", "nsfw", "canceled"] as const;
const MediaOutputSchema = z.object({ url: z.string().url(), content_type: z.string().optional() }).passthrough();
export const HiggsfieldRequestStatusSchema = z
  .object({
    status: z.enum(HIGGSFIELD_STATUSES),
    request_id: z.string().min(1),
    status_url: z.string().url().optional(),
    cancel_url: z.string().url().optional(),
    error: z.string().nullable().optional(),
    images: z.array(MediaOutputSchema).optional(),
    video: MediaOutputSchema.optional(),
    audio: MediaOutputSchema.optional(),
    audios: z.array(MediaOutputSchema).optional(),
    expires_at: isoDate.nullable().optional(),
    expires_after: z.number().optional(),
  })
  .passthrough();
export type HiggsfieldRequestStatus = z.infer<typeof HiggsfieldRequestStatusSchema>;

/** Refunded terminal states: the reservation is released and $0 is booked. */
export const HIGGSFIELD_REFUNDED = ["failed", "nsfw", "canceled"] as const;

export { sha256 as HiggsfieldSha256Schema };
