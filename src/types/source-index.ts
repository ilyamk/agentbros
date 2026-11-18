import { z } from "zod";
import { RationalSchema, TimebaseSchema } from "./timeline";
import { OcrAnalysisSchema } from "./ocr";
import { CategoryAnalysisSchema } from "./category-search";
import { VisualAnalysisSchema } from "./visual-search";
const Span = z
  .object({ startSec: z.number().finite().nonnegative(), endSec: z.number().finite().positive() })
  .refine((v) => v.endSec > v.startSec, "Span end must follow start");
export const EvidenceSchema = z.object({
  kind: z.enum([
    "supplied-transcript",
    "local-asr",
    "ocr",
    "manual-tag",
    "ffmpeg-scene-change",
    "visual-frame",
    "visual-category",
  ]),
  source: z.string(),
  hash: z.string().optional(),
  detail: z.string().optional(),
});
export const SourceSegmentSchema = z
  .object({
    id: z.string(),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    text: z.string(),
    tags: z.array(z.string()),
    evidence: z.array(EvidenceSchema),
    speaker: z.string().min(1).optional(),
  })
  .refine((v) => v.endSec > v.startSec);
export const IngestOptionsSchema = z
  .object({
    proxyWidth: z.number().int().min(64).max(1920).default(640),
    thumbnailEverySec: z.number().min(0.1).max(600).default(5),
    sceneThreshold: z.number().min(0).max(1).default(0.3),
    ocr: z.boolean().default(false),
    ocrLanguage: z
      .string()
      .regex(/^[a-zA-Z0-9_+]+$/)
      .default("eng"),
    tags: z.array(z.string().min(1)).default([]),
    protectedSpans: z.array(Span.and(z.object({ reason: z.string().min(1) }))).default([]),
  })
  .strict();
export const SourceIndexSchema = z
  .object({
    schemaVersion: z.literal(1),
    projectId: z.string(),
    assetId: z.string(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
    createdAt: z.string(),
    source: z.object({
      path: z.string(),
      kind: z.enum(["video", "audio"]),
      durationSec: z.number().positive(),
      originSec: z.number().finite().default(0),
      fps: TimebaseSchema.optional(),
      variableFrameRate: z.boolean(),
      timestamps: z.array(z.number().nonnegative()),
    }),
    options: IngestOptionsSchema,
    proxy: z
      .object({
        path: z.string(),
        hash: z.string(),
        fps: TimebaseSchema.optional(),
        startSec: z.literal(0),
        mapping: z.literal("same-origin-seconds"),
      })
      .optional(),
    thumbnails: z.array(
      z.object({ path: z.string(), hash: z.string(), timeSec: z.number().nonnegative(), sourceFrame: RationalSchema }),
    ),
    scenes: z.array(Span.and(z.object({ evidence: EvidenceSchema }))),
    segments: z.array(SourceSegmentSchema),
    localAnalysis: z
      .object({
        identityHash: z.string().regex(/^[a-f0-9]{64}$/),
        cacheKey: z.string().regex(/^[a-f0-9]{64}$/),
        engine: z.literal("whisper.cpp"),
        model: z.string().min(1),
        revision: z.string().min(1),
        modelHash: z.string().regex(/^[a-f0-9]{64}$/),
        reviewRequired: z.literal(true),
        segmentation: z.literal("sentence-boundaries-v1").optional(),
        wordTimingMethod: z.literal("native-word-segments-v1").optional(),
      })
      .strict()
      .optional(),
    transcript: z.object({ hash: z.string(), source: z.string(), path: z.string() }).optional(),
    ocrAnalysis: OcrAnalysisSchema.optional(),
    visualAnalysis: VisualAnalysisSchema.optional(),
    categoryAnalysis: CategoryAnalysisSchema.optional(),
    ocr: z.object({
      available: z.boolean(),
      executed: z.boolean(),
      version: z.string().optional(),
      warning: z.string().optional(),
    }),
  })
  .strict();
export type SourceIndex = z.infer<typeof SourceIndexSchema>;
export type IngestOptions = z.input<typeof IngestOptionsSchema>;
