import { z } from "zod";
import { OcrFramePinSchema } from "./ocr";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.startsWith("/") && !v.includes("\\") && v.split("/").every((p) => p && p !== "." && p !== ".."));
export const VisualRuntimeSchema = z
  .object({
    engine: z.literal("apple-vision-feature-print"),
    osVersion: z.string().min(1).max(200),
    revision: z.literal(2),
    crop: z.literal("scaleFill"),
    cpuOnly: z.literal(true),
    orientationPolicy: z.literal("validated-jpeg-png-exif-1-through-8-v1"),
  })
  .strict();
export const VisualIdentitySchema = z
  .object({ runtime: VisualRuntimeSchema, executableHash: hash, workerSourceHash: hash })
  .strict();
export const VisualQueryPinSchema = z
  .object({ assetId: z.string().min(1), path: ref, hash, assetMetadataHash: hash })
  .strict();
export const VisualFrameResultSchema = OcrFramePinSchema.extend({
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  featureHash: hash,
  distance: z.number().finite().nonnegative().max(100),
})
  .strict()
  .refine((v) => v.width * v.height <= 4000000);
export const VisualReceiptSchema = z
  .object({
    version: z.literal(1),
    key: hash,
    identityHash: hash,
    identity: VisualIdentitySchema,
    sourceHash: hash,
    baseIndex: z.object({ path: ref, hash, cacheKey: hash }).strict(),
    query: VisualQueryPinSchema,
    queryFeatureHash: hash,
    frames: z.array(VisualFrameResultSchema).min(1).max(32),
    outputHash: hash,
  })
  .strict();
export const VisualAnalysisSchema = z
  .object({
    engine: z.literal("apple-vision-feature-print"),
    revision: z.literal(2),
    identityHash: hash,
    cacheKey: hash,
    receipt: z.object({ path: ref, hash }).strict(),
    baseCacheKey: hash,
    occurrence: z.literal("sampled-decoded-frame-v1"),
    reviewRequired: z.literal(true),
  })
  .strict();
