import { z } from "zod";

/**
 * Colour grading contracts: a declarative grade (grade.json), a timeline of per-shot grades, and the
 * colour worker's answers. The worker (scripts/workers/colour.py) evaluates a grade in this fixed order:
 * input LUT, white balance and exposure (linear light), offset, lift/gamma/gain, contrast, curves,
 * saturation, secondaries, look LUT, soft clip, output LUT, clamp to 0..1. Values are Rec.709 display code
 * values normalised to 0..1. See docs/colour-grading.md.
 */

const finite = z.number().finite();
/** A per-channel value; one number means the same value on R, G and B. */
const Triplet = z.union([finite, z.tuple([finite, finite, finite])]);
const CurvePoints = z.array(z.tuple([finite, finite])).min(2).max(32);

export const QualifierSchema = z.strictObject({
  /** Vectorscope hue angle in degrees (counter-clockwise from +Cb; red is about 103, skin line 123). */
  hue: z.strictObject({ center: finite, width: z.number().positive().max(360), softness: z.number().min(0).default(10) }).optional(),
  /** Chroma as a fraction of a 100% saturated colour (0..1+). */
  saturation: z.strictObject({ min: finite, max: finite, softness: z.number().min(0).default(0.05) }).optional(),
  /** Luma Y' 0..1. */
  luma: z.strictObject({ min: finite, max: finite, softness: z.number().min(0).default(0.05) }).optional(),
});

export const SecondarySchema = z.strictObject({
  name: z.string().min(1).max(80),
  qualifier: QualifierSchema,
  /** Rotate hue inside the key, in degrees. */
  hueShift: finite.default(0),
  /** Pull hue toward an angle (amount 0..1), e.g. skin toward the skin line. */
  hueToward: z.strictObject({ angle: finite, amount: z.number().min(0).max(1) }).optional(),
  /** Chroma multiplier inside the key. */
  saturation: z.number().min(0).max(4).default(1),
  /** Luma offset inside the key. */
  luma: z.number().min(-1).max(1).default(0),
  /** Mix of the whole correction. */
  strength: z.number().min(0).max(1).default(1),
});

export const LutRefSchema = z.strictObject({
  /** A 3D .cube file, relative to the grade file. */
  path: z.string().min(1),
  position: z.enum(["input", "look", "output"]).default("look"),
  strength: z.number().min(0).max(1).default(1),
});

export const GradeSchema = z.strictObject({
  version: z.literal(1).default(1),
  name: z.string().max(120).optional(),
  notes: z.string().max(4000).optional(),
  /** Provenance of a solved grade: what it was matched to and how. */
  matchedTo: z
    .strictObject({ reference: z.string(), method: z.string(), frames: z.number().int().positive(), strength: z.number().optional() })
    .optional(),
  whiteBalance: z.strictObject({ temperature: finite.default(0), tint: finite.default(0) }).optional(),
  /** Stops, in linear light. */
  exposure: finite.optional(),
  offset: Triplet.optional(),
  lift: Triplet.optional(),
  gamma: Triplet.optional(),
  gain: Triplet.optional(),
  contrast: z.strictObject({ amount: z.number().positive().max(4), pivot: z.number().min(0).max(1).default(0.435) }).optional(),
  curves: z
    .strictObject({ master: CurvePoints.optional(), r: CurvePoints.optional(), g: CurvePoints.optional(), b: CurvePoints.optional() })
    .optional(),
  saturation: z.number().min(0).max(4).optional(),
  secondaries: z.array(SecondarySchema).max(16).optional(),
  luts: z.array(LutRefSchema).max(4).optional(),
  /** Highlight knee (e.g. 0.92) and shadow knee for a smooth roll-off instead of a hard clip. */
  softClip: z.strictObject({ high: z.number().min(0.5).max(1).optional(), low: z.number().min(0).max(0.2).optional() }).optional(),
});
export type Grade = z.infer<typeof GradeSchema>;

export const TimelineSchema = z.strictObject({
  version: z.literal(1).default(1),
  /** Grade applied outside every segment (default: none). */
  base: z.string().optional(),
  segments: z
    .array(
      z.strictObject({
        label: z.string().optional(),
        start: z.number().min(0),
        end: z.number().positive(),
        /** A grade.json path relative to the timeline file. */
        grade: z.string().min(1),
      }),
    )
    .min(1),
});
export type Timeline = z.infer<typeof TimelineSchema>;

const MediaSchema = z.looseObject({
  path: z.string(),
  decode: z.looseObject({ matrix: z.string(), range: z.string() }),
  assumptions: z.array(z.string()),
  activePicture: z.looseObject({ cropped: z.boolean() }),
});

export const ScopesResultSchema = z.looseObject({
  ok: z.literal(true),
  media: MediaSchema,
  stats: z.looseObject({ luma: z.looseObject({}), whiteBalance: z.looseObject({ cast: z.string() }) }),
  files: z.record(z.string(), z.string()),
});

export const CompareResultSchema = z.looseObject({
  ok: z.literal(true),
  input: MediaSchema,
  reference: MediaSchema,
  zones: z.looseObject({ meanDeltaE2000: z.number() }),
  globalDeltaE2000: z.number(),
  findings: z.array(z.looseObject({ zone: z.string(), attribute: z.string(), value: z.number(), text: z.string() })),
  summary: z.string(),
  files: z.record(z.string(), z.string()),
});

const ZoneScore = z.looseObject({ mean: z.number() });
export const MatchResultSchema = z.looseObject({
  ok: z.literal(true),
  grade: z.record(z.string(), z.unknown()),
  method: z.string(),
  metrics: z.looseObject({ zoneDeltaE2000Before: ZoneScore, zoneDeltaE2000After: ZoneScore }),
  input: MediaSchema,
  reference: MediaSchema,
  files: z.record(z.string(), z.string()),
});

export const ShotsResultSchema = z.looseObject({
  ok: z.literal(true),
  hero: z.string(),
  shots: z.array(
    z.looseObject({
      label: z.string(),
      path: z.string(),
      hero: z.boolean(),
      summary: z.string(),
      outOfTolerance: z.boolean(),
      zones: z.looseObject({ meanDeltaE2000: z.number() }),
      grade: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  consistency: z.looseObject({ maxDeltaE2000: z.number(), outOfTolerance: z.number() }),
  files: z.record(z.string(), z.string()),
});

export const BakeResultSchema = z.looseObject({
  ok: z.literal(true),
  path: z.string(),
  size: z.number(),
  maxDelta: z.number(),
  identity: z.boolean(),
});
