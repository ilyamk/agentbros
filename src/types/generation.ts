import { z } from "zod";
import type { ProviderId } from "./fal-catalog";
import { ModelPreparationBindingSchema } from "./model-preparation-binding";
import { ReferencePackBindingSchema } from "./reference-pack-binding";
import { RemoteMediaBindingSchema } from "./remote-media";
/** Supplied output assumptions, not provider-enforced size/duration guarantees. */
export const SeedanceVideoForecastSchema = z
  .object({
    version: z.literal(1),
    endpoint: z.string().min(1).max(200),
    schemaSha256: z.string().regex(/^[a-f0-9]{64}$/),
    inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
    output: z
      .object({
        kind: z.literal("planning-assumption"),
        source: z.string().trim().min(1).max(1000),
        width: z.number().int().positive().max(16384),
        height: z.number().int().positive().max(16384),
        resolution: z.enum(["480p", "720p", "1080p", "4k"]),
        durationSec: z.number().int().min(4).max(30),
      })
      .strict(),
    videoReferences: z
      .array(
        z
          .object({
            referenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
            durationSec: z.number().min(1.8).max(30.2),
            source: z.string().trim().min(1).max(1000),
          })
          .strict(),
      )
      .max(10),
  })
  .strict();
export type SeedanceVideoForecast = z.infer<typeof SeedanceVideoForecastSchema>;
export const VideoForecastEvidenceSchema = z
  .object({
    kind: z.literal("seedance-video-forecast"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    forecast: SeedanceVideoForecastSchema,
  })
  .strict();
export type VideoForecastEvidence = z.infer<typeof VideoForecastEvidenceSchema>;
export const FalOperationContextSchema = z
  .object({
    speechLanguage: z.string().optional(),
    allowTranslatedSpeech: z.boolean().default(false),
    callerId: z.string().optional(),
    videoForecast: SeedanceVideoForecastSchema.optional(),
    modelPreparation: ModelPreparationBindingSchema.optional(),
    /** The reference pack this request was compiled from (RFC 0003 §6.5); checked by generate:model from WP6. */
    referencePack: ReferencePackBindingSchema.optional(),
    remoteMedia: z.array(RemoteMediaBindingSchema).max(100).optional(),
    draft: z.object({ id: z.string(), createdAt: z.iso.datetime(), callerId: z.string() }).optional(),
    now: z.iso.datetime().optional(),
    /** Local post-publish motion verdict for a video output (src/lib/sensors/motion-expect.ts); never sent to fal. */
    expect: z
      .object({
        motion: z.enum(["animated", "still"]),
        /** animated: least share of grid cells moving in the median sample (default 0.25). */
        minMovingShare: z.number().min(0).max(1).optional(),
        /** animated: most share of the clip frozen (default 0.5). */
        maxStillShare: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    /** ffprobe/asset metadata keyed by the exact reference URL, never sent to fal. */
    media: z
      .record(
        z.string(),
        z.object({
          contentType: z.string().optional(),
          bytes: z.number().int().nonnegative().optional(),
          width: z.number().positive().optional(),
          height: z.number().positive().optional(),
          durationSec: z.number().positive().optional(),
          fps: z.number().positive().optional(),
        }),
      )
      .default({}),
  })
  .strict();
export type FalOperationContext = z.input<typeof FalOperationContextSchema>;
export const FalOperationRequestSchema = z
  .object({
    family: z.enum([
      "gpt-image-2.5",
      "gpt-image-2.6",
      "nano-banana-2.1",
      "flux-2",
      "flux-2-gallery",
      "kling-v3",
      "kling-o3",
      "kling-voice",
      "seedance-2.5",
    ]),
    variant: z.string().optional(),
    operation: z.string(),
    region: z.enum(["global", "us", "singapore"]).default("global"),
    transport: z.enum(["queue", "training", "stream", "realtime"]).optional(),
    input: z.record(z.string(), z.unknown()),
    context: FalOperationContextSchema.optional(),
  })
  .strict();
export type FalOperationRequest = z.input<typeof FalOperationRequestSchema>;
/**
 * Endpoint-keyed request for any catalogue endpoint (docs/fal-integration.md).
 * Its schema comes from the tracked snapshot, else the hash-pinned cache named by the catalogue index.
 */
export const FalEndpointRequestSchema = z
  .object({
    /** Which service runs it; absent means fal. Validated against that provider's schema only. */
    provider: z.enum(["fal", "higgsfield"]).optional(),
    endpoint: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/)
      .max(200),
    transport: z.enum(["queue", "training", "stream", "realtime"]).optional(),
    region: z.enum(["global", "us", "singapore"]).optional(),
    input: z.record(z.string(), z.unknown()),
    context: FalOperationContextSchema.optional(),
  })
  .strict();
export type FalEndpointRequest = z.input<typeof FalEndpointRequestSchema>;
/** Either request form; `"endpoint" in request` tells them apart. */
export type FalAnyRequest = FalOperationRequest | FalEndpointRequest;
export type FalTransport = "queue" | "training" | "stream" | "realtime";
export type FalOperationPlan = {
  provider: ProviderId;
  family: string;
  variant: string;
  operation: string;
  region: string;
  endpoint: string;
  transport: FalTransport;
  input: Record<string, unknown>;
  executable: boolean;
  verification: { schema: boolean; localAdapter: boolean; live: false };
  schemaSource: string;
  schemaAsOf: string;
  schemaSha256: string;
  warnings: string[];
  /** Catalogue facts (optional until every caller reads the index). */
  category?: string;
  tier?: "discovered" | "priced" | "verified" | "live";
  outputKinds?: Array<"image" | "video" | "audio" | "model3d" | "text" | "json" | "weights" | "file">;
  retiresAt?: string;
  replacement?: string;
};
