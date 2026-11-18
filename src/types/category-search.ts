import { z } from "zod";
import { OcrFramePinSchema } from "./ocr";
export const CategoryHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const ref = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => !v.startsWith("/") && !v.includes("\\") && v.split("/").every((p) => p && p !== "." && p !== ".."));
export const CategoryIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\x00-\x1f\x7f]+$/);
export const CategoryTaxonomySchema = z
  .object({ identifiers: z.array(CategoryIdSchema).min(1).max(2048), hash: CategoryHashSchema })
  .strict();
export const CategoryRuntimeSchema = z
  .object({
    engine: z.literal("apple-vision-classification"),
    osVersion: z.string().min(1).max(200),
    revision: z.literal(2),
    inputPolicy: z.literal("classification-framework-default/full-image-region-v1"),
    regionOfInterest: z
      .object({ x: z.literal(0), y: z.literal(0), width: z.literal(1), height: z.literal(1) })
      .strict(),
    cpuOnly: z.literal(true),
    orientationPolicy: z.literal("validated-jpeg-png-exif-1-through-8-v1"),
    taxonomy: CategoryTaxonomySchema,
  })
  .strict();
export const CategoryIdentitySchema = z
  .object({ runtime: CategoryRuntimeSchema, executableHash: CategoryHashSchema, workerSourceHash: CategoryHashSchema })
  .strict();
export const CategoryScoreSchema = z
  .object({ identifier: CategoryIdSchema, score: z.number().finite().min(0).max(1) })
  .strict();
export const CategoryFrameResultSchema = OcrFramePinSchema.extend({
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  observations: z.array(CategoryScoreSchema).min(1).max(2048),
})
  .strict()
  .refine((v) => v.width * v.height <= 4000000);
export const CategoryReceiptSchema = z
  .object({
    version: z.literal(1),
    key: CategoryHashSchema,
    identityHash: CategoryHashSchema,
    identity: CategoryIdentitySchema,
    sourceHash: CategoryHashSchema,
    baseIndex: z.object({ path: ref, hash: CategoryHashSchema, cacheKey: CategoryHashSchema }).strict(),
    frames: z.array(CategoryFrameResultSchema).min(1).max(32),
    outputHash: CategoryHashSchema,
  })
  .strict();
export const CategoryAnalysisSchema = z
  .object({
    engine: z.literal("apple-vision-classification"),
    revision: z.literal(2),
    identityHash: CategoryHashSchema,
    cacheKey: CategoryHashSchema,
    receipt: z.object({ path: ref, hash: CategoryHashSchema }).strict(),
    baseCacheKey: CategoryHashSchema,
    occurrence: z.literal("sampled-decoded-frame-v1"),
    reviewRequired: z.literal(true),
  })
  .strict();
export const CategoryQuerySchema = z
  .object({
    version: z.literal(1),
    method: z.literal("native-image-category"),
    taxonomyHash: CategoryHashSchema,
    identifier: CategoryIdSchema,
  })
  .strict();
