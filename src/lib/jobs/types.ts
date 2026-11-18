import {
  higgsfieldPricingInputHash,
  PricingEvidenceSchema,
  pricingEvidenceMatchesQuote,
  type PricingEvidenceV1,
} from "../../types/pricing-evidence";
import { VideoForecastEvidenceSchema } from "../../types/generation";
import { z } from "zod";
import { CampaignBindingSchema } from "../../types/campaigns";
import { ReferencePackBindingSchema } from "../../types/reference-pack-binding";
import { ModelPreparationBindingSchema } from "../../types/model-preparation-binding";
import { RemoteMediaBindingSchema } from "../../types/remote-media";
import { createHash } from "node:crypto";
import { canonicalRequestBody } from "./request-body";

export const JobStatusSchema = z.enum([
  "planned",
  "reserved",
  "submitting",
  "queued",
  "running",
  "result-ready",
  "downloading",
  "validated",
  "published",
  "failed",
  "cancelled",
  "unknown",
]);
export type JobStatus = z.infer<typeof JobStatusSchema>;
const dollars = z
  .number()
  .finite()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER / 1_000_000);
export const PriceQuoteSchema = z
  .object({
    currency: z.literal("USD"),
    lowUsd: dollars,
    expectedUsd: dollars,
    highUsd: dollars,
    bounded: z.literal(true),
    source: z.string().min(1),
    asOf: z.union([z.iso.datetime(), z.iso.date()]),
    confidence: z.enum(["provider-quote", "published-rate", "conservative-bound", "user-bound"]),
    /** Reservation bounds an estimate, not provider-enforced billing. */
    providerEnforced: z.boolean().default(false),
    forecastEvidence: VideoForecastEvidenceSchema.optional(),
    pricingEvidence: PricingEvidenceSchema.optional(),
    model: z.string().optional(),
    basis: z.string().optional(),
    notes: z.array(z.string()).optional(),
  })
  .refine((q) => q.lowUsd <= q.expectedUsd && q.expectedUsd <= q.highUsd, "Quote bounds must be ordered.")
  .refine(
    pricingEvidenceMatchesQuote,
    "Pricing evidence differs from quote model/source/date/currency/basis or manual/unknown confidence.",
  );
export type PriceQuote = Omit<z.input<typeof PriceQuoteSchema>, "pricingEvidence"> & {
  pricingEvidence?: PricingEvidenceV1;
};
export const BudgetPolicySchema = z.object({
  ceilingUsd: dollars,
  maxJobUsd: dollars,
  repairReserveFraction: z.number().min(0).max(1).default(0.15),
  maxPaidAttemptsPerAsset: z.number().int().positive().default(2),
});
export type BudgetPolicy = z.input<typeof BudgetPolicySchema>;
export const OperationInputSchema = z
  .object({
    operationId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/),
    provider: z.string().min(1),
    endpoint: z.string().min(1),
    inputHash: z.string().min(1),
    canonicalInput: z
      .object({
        version: z.literal(2),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        legacyLocale: z.string().max(100).optional(),
      })
      .strict()
      .optional(),
    preparedInputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    quotedRequestBody: z.string().optional(),
    assetId: z.string().min(1),
    stage: z.string().optional(),
    quote: PriceQuoteSchema,
    repair: z.boolean().default(false),
    publication: z
      .object({
        output: z.string().min(1),
        kind: z.enum(["image", "video", "audio", "voice", "training", "model3d", "text", "json", "weights", "file"]),
        model: z.string().min(1),
        referenceAssetIds: z.array(z.string()).default([]),
        modelPreparation: ModelPreparationBindingSchema.optional(),
        referencePack: ReferencePackBindingSchema.optional(),
        remoteMedia: z.array(RemoteMediaBindingSchema).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .superRefine((operation, ctx) => {
    const evidence = operation.quote.pricingEvidence;
    const pricingHash = operation.preparedInputHash ?? operation.inputHash;
    if (operation.preparedInputHash && operation.provider !== "higgsfield")
      ctx.addIssue({
        code: "custom",
        path: ["preparedInputHash"],
        message: "Prepared input pricing is Higgsfield-only.",
      });
    if (operation.quotedRequestBody !== undefined) {
      try {
        const body: unknown = JSON.parse(operation.quotedRequestBody);
        canonicalRequestBody(body);
        if (
          body === null ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          operation.provider !== "higgsfield" ||
          createHash("sha256").update(operation.quotedRequestBody).digest("hex") !== operation.preparedInputHash
        )
          throw Error("Invalid quoted body");
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["quotedRequestBody"],
          message: "Quoted body must match the exact prepared Higgsfield input hash.",
        });
      }
    }
    if (
      evidence?.provider === "higgsfield" &&
      (evidence.inputHash !== pricingHash ||
        (evidence.input !== undefined &&
          higgsfieldPricingInputHash(evidence.input, evidence.canonicalLocale) !== pricingHash))
    )
      ctx.addIssue({
        code: "custom",
        path: ["quote", "pricingEvidence"],
        message: "Higgsfield quote input differs from the operation input hash.",
      });
    if (
      evidence &&
      (operation.provider !== evidence.provider ||
        operation.endpoint !== evidence.endpoint ||
        (operation.publication && operation.publication.model !== evidence.model))
    )
      ctx.addIssue({
        code: "custom",
        path: ["quote", "pricingEvidence"],
        message: "Pricing evidence differs from original provider/endpoint/publication model.",
      });
  });
export type OperationInput = z.input<typeof OperationInputSchema>;
export const BillingReceiptSchema = z.object({
  receiptId: z.string().min(1),
  actualUsd: dollars,
  source: z.string().min(1),
  confirmedAt: z.iso.datetime(),
});
export type BillingReceipt = z.infer<typeof BillingReceiptSchema>;
/** Local media evidence is not a provider request ID or acknowledged realtime input. */
export const StreamLocalResultEvidenceSchema = z
  .object({
    streamProof: z
      .object({
        bodySha256: z.string().regex(/^[a-f0-9]{64}$/),
        complete: z.literal(true),
        providerRequestIdKnown: z.literal(false),
      })
      .strict(),
  })
  .passthrough();
export const RealtimeLocalResultEvidenceSchema = z
  .object({
    privateResultHash: z.string().regex(/^[a-f0-9]{64}$/),
    sessionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/),
    revisionId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/),
    providerAck: z.literal(false),
  })
  .passthrough();
export const ProviderUrlsSchema = z
  .object({
    status: z.url({ protocol: /^https$/ }),
    response: z.url({ protocol: /^https$/ }).optional(),
    cancel: z.url({ protocol: /^https$/ }).optional(),
  })
  .strict();
export type ProviderUrls = z.infer<typeof ProviderUrlsSchema>;
/** An OpenAPI submit path without its leading slash, e.g. `fal-ai/meshy/v7/image-to-3d`. */
export const QueueRouteSchema = z
  .string()
  .max(300)
  .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/)
  .refine(
    (route) => !route.split("/").some((part) => part === "." || part === ".." || part === "requests"),
    "Invalid queue route.",
  );
export const ProviderUploadSchema = z
  .object({
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    publicUrl: z.url({ protocol: /^https$/ }),
    contentType: z.string().min(1),
  })
  .strict();
export type ProviderUpload = z.infer<typeof ProviderUploadSchema>;
/** Completed downloader HTTP response is local evidence, never a fabricated provider request ID. */
export const MediaAcquisitionResultEvidenceSchema = z
  .object({
    acquisitionProof: z
      .object({
        responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
        complete: z.literal(true),
        providerRequestIdKnown: z.literal(false),
      })
      .strict(),
  })
  .passthrough();
export const GenerationJobSchema = OperationInputSchema.safeExtend({
  state: JobStatusSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  reservedMicros: z.number().int().nonnegative(),
  paidAttempts: z.number().int().nonnegative(),
  providerRequestId: z.string().optional(),
  /** Frozen provider bytes and uploaded references, persisted before submit for idempotent recovery. */
  requestBody: z.string().optional(),
  requestBodySha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  uploads: z.array(ProviderUploadSchema).optional(),
  /** Queue URLs the submit returned (fal `status_url`/`response_url`); absent on historical jobs. */
  providerUrls: ProviderUrlsSchema.optional(),
  /** OpenAPI submit path used for status/result when the submit returned no queue URLs; absent on historical jobs. */
  queueRoute: QueueRouteSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional(),
  refundedFailure: z.literal(true).optional(),
  error: z.string().optional(),
  receipt: BillingReceiptSchema.optional(),
  refunds: z
    .array(
      z.object({
        receiptId: z.string().min(1),
        refundUsd: dollars,
        source: z.string().min(1),
        confirmedAt: z.iso.datetime(),
      }),
    )
    .default([]),
  release: z
    .object({
      confirmationId: z.string().min(1),
      reason: z.enum(["not-submitted", "confirmed-no-charge"]),
      source: z.string().min(1),
    })
    .optional(),
  history: z.array(z.object({ state: JobStatusSchema, at: z.iso.datetime(), note: z.string().optional() })),
  /** The user's latest cancel request (RFC 0004 D12, `job:cancel`) and what the provider made of it; never faked. */
  cancellation: z
    .object({
      at: z.iso.datetime(),
      answer: z.string().min(1).max(4000),
      outcome: z.enum(["cancelled", "requested", "unavailable", "refused"]),
      note: z.string().max(2000).optional(),
    })
    .strict()
    .optional(),
});
export type GenerationJob = z.infer<typeof GenerationJobSchema>;
/**
 * Who allowed a ceiling change. Raising (or first setting above zero) the durable ceiling needs
 * the user's own words, or a recorded upstream authority that already carries them: a numeric
 * brief.budgetUsd the user answered, a campaign quota the user approved, a benchmark operator's
 * explicit bound, or a paid command's explicit per-run bounds.
 */
export const CeilingGrantSchema = z.discriminatedUnion("by", [
  z
    .object({
      by: z.literal("user"),
      answer: z
        .string()
        .trim()
        .min(1)
        .max(2000)
        .refine(
          (answer) => !/^<.*>$/s.test(answer),
          "--answer still holds the placeholder: ask the user and pass their own words.",
        ),
      /** `console` when the studio console applied the user's decision (RFC 0004 D9). */
      channel: z.enum(["cli", "console"]).optional(),
    })
    .strict(),
  z
    .object({
      by: z.enum(["brief", "campaign", "bench", "operation-bounds"]),
      source: z.string().trim().min(1).max(500),
    })
    .strict(),
]);
export type CeilingGrant = z.infer<typeof CeilingGrantSchema>;
export const PolicyEventSchema = z
  .object({
    at: z.iso.datetime(),
    previousCeilingUsd: dollars.nullable(),
    ceilingUsd: dollars,
    change: z.enum(["first", "raise", "same", "lower"]),
    grant: CeilingGrantSchema.optional(),
  })
  .strict();
export type PolicyEvent = z.infer<typeof PolicyEventSchema>;
export const OperationDatabaseSchema = z.object({
  version: z.literal(1),
  projectId: z.string(),
  revision: z.number().int().nonnegative(),
  policy: BudgetPolicySchema,
  jobs: z.record(z.string(), GenerationJobSchema),
  campaignAllocation: CampaignBindingSchema.optional(),
  /** Every configure call, oldest first: who changed the ceiling, when and on whose words. */
  policyEvents: z.array(PolicyEventSchema).optional(),
});
export type OperationDatabase = z.infer<typeof OperationDatabaseSchema>;
