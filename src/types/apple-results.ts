import { z } from "zod";
const score = z.number().finite().min(0).max(1);
const sec = z.number().finite().nonnegative();
export const AppleTextResultSchema = z
  .object({
    language: z.string(),
    hypotheses: z.record(z.string(), score),
    items: z
      .array(
        z
          .object({
            operation: z.enum(["entities", "lemmas", "sentences", "tokens"]),
            text: z.string(),
            value: z.string(),
            startUtf16: z.number().int().nonnegative(),
            lengthUtf16: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(200000),
  })
  .strict();
export const AppleTranslationResultSchema = z
  .object({
    units: z.array(z.object({ id: z.string(), text: z.string().max(200000) }).strict()).max(1000),
    sourceLanguage: z.string(),
    targetLanguage: z.string(),
  })
  .strict();
export const AppleTtsResultSchema = z
  .object({
    voice: z.string(),
    language: z.string(),
    durationSec: z.number().finite().positive(),
    sampleRate: z.number().finite().positive(),
  })
  .strict();
export const AppleAudioResultSchema = z
  .object({
    events: z
      .array(
        z
          .object({ label: z.string(), score, startSec: sec, endSec: sec })
          .strict()
          .refine((v) => v.endSec >= v.startSec),
      )
      .max(200000),
    windowSec: z.number().finite().positive(),
    overlap: score,
    labels: z.array(z.string()).max(2048),
    advisory: z.literal(true),
  })
  .strict();
export const AppleBoxSchema = z
  .object({ x: score, y: score, w: score, h: score, score })
  .strict()
  .refine((b) => b.x + b.w <= 1.000001 && b.y + b.h <= 1.000001);
const pose = z
  .object({
    confidence: score,
    points: z.array(z.object({ name: z.string(), x: score, y: score, score }).strict()).max(100),
  })
  .strict();
export const AppleVisionFrameSchema = z
  .object({
    id: z.string(),
    width: z.number().int().positive().max(4096),
    height: z.number().int().positive().max(4096),
    faces: z.array(AppleBoxSchema).max(1000).optional(),
    people: z.array(AppleBoxSchema).max(1000).optional(),
    poses: z.array(pose).max(1000).optional(),
    saliency: z.array(AppleBoxSchema).max(1000).optional(),
    quality: z.object({ overallScore: z.number().finite(), isUtility: z.boolean() }).strict().optional(),
    tracks: z
      .array(z.object({ x: score, y: score, w: score, h: score, score, id: z.string() }).strict())
      .max(1000)
      .optional(),
    flow: z
      .object({
        file: z.string(),
        width: z.number().int().positive().max(4096),
        height: z.number().int().positive().max(4096),
        format: z.literal("float32le-xy"),
        direction: z.literal("current-to-previous"),
        previousId: z.string(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((f) => f.width * f.height <= 4000000);
export const AppleVisionResultSchema = z
  .object({
    frames: z.array(AppleVisionFrameSchema).min(1).max(32),
    coordinates: z.literal("normalised-top-left"),
    advisory: z.literal(true),
  })
  .strict();
export const AppleAssistanceResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            sourceId: z.string().max(128),
            text: z.string().max(200000),
            tags: z.array(z.string().max(200)).max(50),
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    advisory: z.literal(true),
  })
  .strict();
