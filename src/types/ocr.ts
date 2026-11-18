import { z } from "zod";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const reference = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (v) => !v.startsWith("/") && !v.includes("\\") && v.split("/").every((p) => p && p !== "." && p !== ".."),
    "Use a confined public-relative reference",
  );
export const OcrRuntimeSchema = z
  .object({
    engine: z.literal("apple-vision"),
    osVersion: z.string().min(1).max(200),
    revision: z.literal(3),
    supportedLanguages: z.array(z.string().min(1).max(30)).min(1).max(100),
  })
  .strict();
export const OcrIdentitySchema = z
  .object({
    runtime: OcrRuntimeSchema,
    executableHash: hash,
    workerSourceHash: hash,
    languages: z.array(z.string().min(1).max(30)).min(1).max(4),
    recognitionLevel: z.literal("accurate"),
    languageCorrection: z.literal(false),
    automaticLanguageDetection: z.literal(false),
    cpuOnly: z.literal(true),
  })
  .strict();
export const OcrObservationSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    confidence: z.number().finite().min(0).max(1),
    box: z
      .object({
        x: z.number().finite().min(0).max(1),
        y: z.number().finite().min(0).max(1),
        width: z.number().finite().positive().max(1),
        height: z.number().finite().positive().max(1),
      })
      .strict()
      .refine((b) => b.x + b.width <= 1.000001 && b.y + b.height <= 1.000001, "OCR box outside image"),
  })
  .strict();
export const OcrFramePinSchema = z
  .object({
    path: reference,
    hash,
    timeSec: z.number().finite().nonnegative(),
    sourceFrame: z.object({ num: z.number().int().nonnegative(), den: z.literal(1) }).strict(),
  })
  .strict();
export const OcrFrameResultSchema = OcrFramePinSchema.extend({
  width: z.number().int().positive().max(4096),
  height: z.number().int().positive().max(4096),
  observations: z.array(OcrObservationSchema).max(100),
})
  .strict()
  .refine((v) => v.width * v.height <= 4000000, "OCR image exceeds 4MP");
export const OcrReceiptSchema = z
  .object({
    version: z.literal(1),
    key: hash,
    identityHash: hash,
    identity: OcrIdentitySchema,
    sourceHash: hash,
    baseIndex: z.object({ path: reference, hash, cacheKey: hash }).strict(),
    frames: z.array(OcrFrameResultSchema).min(1).max(32),
    outputHash: hash,
  })
  .strict();
export const OcrAnalysisSchema = z
  .object({
    engine: z.literal("apple-vision"),
    revision: z.literal(3),
    identityHash: hash,
    cacheKey: hash,
    receipt: z.object({ path: reference, hash }).strict(),
    baseCacheKey: hash,
    occurrence: z.literal("sampled-decoded-frame-v1"),
    reviewRequired: z.literal(true),
  })
  .strict();
