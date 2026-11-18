import { z } from "zod";

/**
 * Several recordings of one event on a common reference clock, and the
 * artefacts built on it: angle proposals and per-shot crop paths.
 * The reference timeline is the reference input's audio time in seconds.
 * A source's `offsetSec` is the reference time at which its audio t=0 lands:
 * `referenceSec = sourceAudioSec + offsetSec`.
 */
const id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .max(64);
const sec = z.number().finite();
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const fps = z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).strict();

const WindowSchema = z
  .object({
    referenceSec: sec,
    offsetSec: sec,
    peakRatio: z.number().nonnegative(),
  })
  .strict();

export const MulticamSourceSchema = z
  .object({
    id,
    file: z.string().min(1),
    sha256,
    durationSec: z.number().nonnegative(),
    video: z
      .object({ fps, width: z.number().int().positive(), height: z.number().int().positive() })
      .strict()
      .nullable(),
    /** Audio offset at the start of the overlap; reference: 0. */
    offsetSec: sec,
    /** Reference time at which the video stream's first frame lands (audio offset plus container start difference). */
    videoOffsetSec: sec.nullable(),
    overlap: z.object({ startSec: sec, endSec: sec }).strict(),
    coarse: z.object({ offsetSec: sec, standardScore: z.number() }).strict().nullable(),
    refine: z.object({ start: WindowSchema, end: WindowSchema.nullable() }).strict().nullable(),
    drift: z
      .object({
        measured: z.boolean(),
        ppm: z.number().finite().nullable(),
        accumulatedMs: z.number().finite().nullable(),
        needsResample: z.boolean(),
      })
      .strict(),
    confidence: z.enum(["reference", "high", "low"]),
  })
  .strict();

export const MulticamSyncSchema = z
  .object({
    version: z.literal(1),
    referenceId: id,
    sampleRate: z.literal(48000),
    thresholds: z
      .object({
        minStandardScore: z.number(),
        minPeakRatio: z.number(),
        searchMs: z.number(),
        driftToleranceMs: z.number(),
      })
      .strict(),
    sources: z.array(MulticamSourceSchema).min(2),
    tools: z.record(z.string(), z.string()),
  })
  .strict()
  .refine(
    (sync) => sync.sources.some((source) => source.id === sync.referenceId && source.confidence === "reference"),
    {
      message: "referenceId must name the reference source",
    },
  );

/** Who sits in front of which camera and which microphone. */
export const AngleMapSchema = z
  .object({
    version: z.literal(1),
    speakers: z
      .array(
        z
          .object({
            /** Transcript speaker id, or any label when there is no transcript. */
            speaker: id,
            angle: id,
            /** Source whose audio is this speaker's own microphone. */
            mic: id.optional(),
            /** Horizontal place of this speaker in the wide frame (0 left, 1 right), used by reframe:track. */
            position: z.number().min(0).max(1).optional(),
          })
          .strict(),
      )
      .min(1),
    wide: id.optional(),
    /** Source whose audio carries the programme sound. Default: the sync reference. */
    audio: id.optional(),
  })
  .strict();

export const AngleReasonSchema = z.enum(["speaker", "overlap-hold", "overlap-wide", "silence-hold", "fallback-wide"]);

export const AnglePlanSchema = z
  .object({
    version: z.literal(1),
    sync: z.object({ file: z.string(), sha256 }).strict(),
    method: z.enum(["mic-energy", "diarisation", "visual-asd", "wide-only"]),
    rules: z
      .object({
        minShotSec: z.number(),
        overlapWideSec: z.number(),
        sentenceSnapSec: z.number(),
        dominanceDb: z.number(),
        hopSec: z.number(),
      })
      .strict(),
    fps,
    /** Camera whose frame the segments' `focus` points are measured in (the visual detection camera). */
    focusSource: id.nullable(),
    segments: z.array(
      z
        .object({
          startFrame: z.number().int().nonnegative(),
          endFrame: z.number().int().positive(),
          angle: id,
          speaker: id.nullable(),
          reason: AngleReasonSchema,
          /** Normalised face centre of the active speaker, when visual detection supplied one. */
          focus: z
            .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    notes: z.array(z.string()),
  })
  .strict();

export const CropKeyframeSchema = z
  .object({ frame: z.number().int().nonnegative(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();

/** Per-shot crop path in source frames; x/y are cover alignment (CSS object-position fractions), not crop centres. */
export const CropPathSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        file: z.string(),
        sha256,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        fps,
        frameCount: z.number().int().positive(),
      })
      .strict(),
    format: z.enum(["vertical", "square", "landscape"]),
    crop: z.object({ width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict(),
    detector: z.object({ face: z.string(), person: z.string(), sampleFps: z.number().positive() }).strict(),
    rules: z.object({ deadzone: z.number(), minMove: z.number(), smoothingSec: z.number() }).strict(),
    shots: z.array(
      z
        .object({
          startFrame: z.number().int().nonnegative(),
          endFrame: z.number().int().positive(),
          mode: z.enum(["stationary", "pan"]),
          subject: z.enum(["face", "person", "speaker", "none"]),
          coverage: z.number().min(0).max(1),
        })
        .strict(),
    ),
    keyframes: z.array(CropKeyframeSchema).min(1),
  })
  .strict();

export type MulticamSource = z.infer<typeof MulticamSourceSchema>;
export type MulticamSync = z.infer<typeof MulticamSyncSchema>;
export type AngleMap = z.infer<typeof AngleMapSchema>;
export type AnglePlan = z.infer<typeof AnglePlanSchema>;
export type AngleSegment = AnglePlan["segments"][number];
export type CropKeyframe = z.infer<typeof CropKeyframeSchema>;
export type CropPath = z.infer<typeof CropPathSchema>;

/** Visual active-speaker scores per face track of one camera, in that camera's own time (light-asd worker output). */
export const AsdResultSchema = z
  .object({
    version: z.literal(1),
    model: z.string(),
    source: id,
    hopSec: z.number().positive(),
    faces: z.array(
      z
        .object({
          id: z.string().min(1),
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          /** Per hop from t=0: speaking score (> 0 speaking), null where the face is not visible. */
          scores: z.array(z.number().finite().nullable()),
        })
        .strict(),
    ),
  })
  .strict();
export type AsdResult = z.infer<typeof AsdResultSchema>;
