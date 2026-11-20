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
const CurvePoints = z
  .array(z.tuple([finite, finite]))
  .min(2)
  .max(32);

export const QualifierSchema = z.strictObject({
  /** Vectorscope hue angle in degrees (counter-clockwise from +Cb; red is about 103, skin line 123). */
  hue: z
    .strictObject({ center: finite, width: z.number().positive().max(360), softness: z.number().min(0).default(10) })
    .optional(),
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

export const BaseGradeSchema = z.strictObject({
  version: z.literal(1).default(1),
  name: z.string().max(120).optional(),
  notes: z.string().max(4000).optional(),
  /** Provenance of a solved grade: what it was matched to and how. */
  matchedTo: z
    .strictObject({
      reference: z.string(),
      method: z.string(),
      frames: z.number().int().positive(),
      strength: z.number().optional(),
    })
    .optional(),
  whiteBalance: z.strictObject({ temperature: finite.default(0), tint: finite.default(0) }).optional(),
  /** Stops, in linear light. */
  exposure: finite.optional(),
  offset: Triplet.optional(),
  lift: Triplet.optional(),
  gamma: Triplet.optional(),
  gain: Triplet.optional(),
  contrast: z
    .strictObject({ amount: z.number().positive().max(4), pivot: z.number().min(0).max(1).default(0.435) })
    .optional(),
  curves: z
    .strictObject({
      master: CurvePoints.optional(),
      r: CurvePoints.optional(),
      g: CurvePoints.optional(),
      b: CurvePoints.optional(),
    })
    .optional(),
  saturation: z.number().min(0).max(4).optional(),
  secondaries: z.array(SecondarySchema).max(16).optional(),
  luts: z.array(LutRefSchema).max(4).optional(),
  /** Highlight knee (e.g. 0.92) and shadow knee for a smooth roll-off instead of a hard clip. */
  softClip: z
    .strictObject({ high: z.number().min(0.5).max(1).optional(), low: z.number().min(0).max(0.2).optional() })
    .optional(),
});

/** A box in normalised frame units (0..1): left, top, width, height. */
const NormBox = z.tuple([
  z.number().min(-1).max(2),
  z.number().min(-1).max(2),
  z.number().positive().max(3),
  z.number().positive().max(3),
]);

export const WindowMaskSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("shape"),
    shape: z.enum(["ellipse", "rectangle"]).default("ellipse"),
    /** Static box, normalised; ignored when `track` is given. */
    box: NormBox.optional(),
    /** A track file from colour:track, relative to the grade file: the window follows it. */
    track: z.string().optional(),
    /** Edge fall-off as a fraction of the box size. */
    softness: z.number().min(0).max(1).default(0.2),
  }),
  z.strictObject({
    kind: z.literal("matte"),
    /** A `pnpm matte` output folder (alpha/frame-NNNNN.png and matte.json), relative to the grade file. */
    path: z.string().min(1),
    /** Gaussian feather of the matte edge, in pixels. */
    feather: z.number().min(0).max(200).default(0),
  }),
]);

/** A spatial correction: `grade` applies on top of the base grade inside the mask (Resolve's window on a serial node). */
export const WindowSchema = z.strictObject({
  name: z.string().min(1).max(80),
  mask: WindowMaskSchema,
  invert: z.boolean().default(false),
  grade: BaseGradeSchema,
  strength: z.number().min(0).max(1).default(1),
});

export const GradeSchema = BaseGradeSchema.extend({ windows: z.array(WindowSchema).max(8).optional() });
export type Grade = z.infer<typeof GradeSchema>;
export type BaseGrade = z.infer<typeof BaseGradeSchema>;

export const TrackSchema = z.strictObject({
  version: z.literal(1),
  input: z.string(),
  /** The box the user or agent placed, in source pixels, at `at` seconds. */
  box: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  at: z.number().min(0),
  method: z.string(),
  keyframes: z
    .array(
      z.strictObject({
        t: z.number(),
        x: z.number(),
        y: z.number(),
        w: z.number(),
        h: z.number(),
        confidence: z.number(),
        active: z.boolean().default(true),
      }),
    )
    .min(1),
});
export type Track = z.infer<typeof TrackSchema>;

export const TrackResultSchema = z.looseObject({
  ok: z.literal(true),
  fps: z.number(),
  keyframes: TrackSchema.shape.keyframes,
  lostPct: z.number(),
  files: z.record(z.string(), z.string()),
});

export const MaskResultSchema = z.looseObject({
  ok: z.literal(true),
  path: z.string(),
  frames: z.number(),
  meanCoveragePct: z.number(),
});

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
  gate: z.looseObject({
    status: z.enum(["pass", "warn", "fail"]),
    failed: z.array(z.string()),
    warnings: z.array(z.string()),
  }),
  stages: z.array(z.string()),
  input: MediaSchema,
  reference: MediaSchema,
  files: z.record(z.string(), z.string()),
});

const GateSchema = z.looseObject({
  status: z.enum(["pass", "warn", "fail"]),
  checks: z.array(
    z.looseObject({ id: z.string(), status: z.enum(["pass", "info", "warn", "fail"]), text: z.string() }),
  ),
  failed: z.array(z.string()),
  warnings: z.array(z.string()),
});

/** colour:check, and the gate colour:match and colour:looks run on their sampled pixels. */
export const CheckResultSchema = GateSchema.extend({
  ok: z.literal(true),
  files: z.record(z.string(), z.string()),
});

export const MatchShotsResultSchema = z.looseObject({
  ok: z.literal(true),
  perShot: z.literal(true),
  gateStatus: z.enum(["pass", "warn", "fail"]),
  shots: z.array(
    z.looseObject({
      label: z.string(),
      start: z.number(),
      end: z.number(),
      grade: z.record(z.string(), z.unknown()),
      gate: GateSchema,
      stages: z.array(z.string()),
    }),
  ),
  files: z.record(z.string(), z.string()),
});

export const LooksResultSchema = z.looseObject({
  ok: z.literal(true),
  looks: z.array(
    z.looseObject({ id: z.string(), grade: z.record(z.string(), z.unknown()), gate: GateSchema, still: z.string() }),
  ),
  files: z.record(z.string(), z.string()),
});

/** How a look treats skin: `hold` solves a skin secondary that keeps hue near the source and chroma at `chroma` times it. */
export const SkinPolicySchema = z.strictObject({
  mode: z.enum(["hold", "free"]).default("hold"),
  chroma: z.number().min(0.3).max(1.6).default(1),
  hueAllowance: z.number().min(0).max(40).default(6),
  lightness: z.number().min(-25).max(25).default(0),
  /** The look warms skin on purpose (golden hour): the yellow-drift check reports instead of failing. */
  warm: z.boolean().default(false),
});

export const LookSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string(),
  family: z.enum(["technical", "film", "commercial", "music-video"]),
  /** What the look is for, in one sentence. */
  intent: z.string(),
  /** Where this treatment is commonly seen (genres, formats), never a named title's LUT. */
  typicalUse: z.string(),
  /** The tonal and colour moves in plain words: what a colourist would say it does. */
  moves: z.array(z.string()).min(1),
  skin: SkinPolicySchema,
  /** What goes wrong when it is pushed too far or used on the wrong material. */
  risks: z.array(z.string()).min(1),
  grade: BaseGradeSchema,
});
export type Look = z.infer<typeof LookSchema>;

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
