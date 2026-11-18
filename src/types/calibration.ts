import { z } from "zod";

// Calibration pairs: a reference's own segment against copies degraded on purpose (ref:degrade), and how well
// sensors and a blind critic tell them apart (judge:calibrate). Files live under out/qa/calibration/ (git-ignored).

const Seconds = z.number().finite().nonnegative();
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const DEGRADE_KINDS = ["linear-motion", "stutter", "uniform-cuts", "desync", "no-sfx", "flat-grade"] as const;
export const DegradeKindSchema = z.enum(DEGRADE_KINDS);
/** What a variant actually is: `no-sfx` becomes `soft-transients` when the reference has no stems. */
export const VariantKindSchema = z.enum([...DEGRADE_KINDS, "soft-transients"]);
export type DegradeKind = z.infer<typeof DegradeKindSchema>;
export type VariantKind = z.infer<typeof VariantKindSchema>;

const ClipSchema = z
  .object({
    /** Relative to the manifest's directory. */
    path: z.string(),
    sha256: Sha256,
    /** Span of the reference's own time this clip shows. */
    startSec: Seconds,
    endSec: Seconds,
    frameCount: z.number().int().positive(),
  })
  .strict();

export const CalibrationManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    refId: z.string(),
    /** The picture the clips come from (the cropped analysis copy when the reference has a crop), relative to the repository. */
    media: z.string(),
    mediaSha256: Sha256.optional(),
    segment: z.object({ id: z.string(), startSec: Seconds, endSec: Seconds }).strict(),
    fps: z.number().positive(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    /** Every clip is encoded from one decoded master with these settings, the originals included. */
    encode: z.string(),
    original: ClipSchema,
    /** The 8-12 s span uniform-cuts needs; its variant is compared with this, not with `original`. */
    originalLong: ClipSchema.optional(),
    /** The reference's beat grid in its own time (audio.json tempo or --audio-map), for the sync readings. */
    grid: z
      .object({ beatsSec: z.array(Seconds), downbeatsSec: z.array(Seconds) })
      .strict()
      .optional(),
    variants: z.array(
      ClipSchema.extend({
        id: z.string(),
        kind: VariantKindSchema,
        /** The clip this variant is a degraded copy of. */
        against: z.enum(["original", "originalLong"]),
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.number())])),
      }).strict(),
    ),
    skipped: z.array(z.object({ kind: DegradeKindSchema, reason: z.string() }).strict()).default([]),
    /** Clip path to sha256, the same values as on each clip. */
    sha256s: z.record(z.string(), Sha256),
  })
  .strict();
export type CalibrationManifest = z.infer<typeof CalibrationManifestSchema>;

/** One blind question for the critic: two clips, A and B, with neutral names. */
export const CriticPairsSchema = z
  .object({
    schemaVersion: z.literal(1),
    question: z.string(),
    rules: z.array(z.string()),
    questions: z.array(
      z
        .object({
          pairId: z.string(),
          order: z.enum(["ab", "ba"]),
          strip: z.string(),
          a: z.string(),
          b: z.string(),
          waveform: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type CriticPairs = z.infer<typeof CriticPairsSchema>;

/** The answer key, kept apart from pairs.json: never shown to the critic. In order `ab`, A is clip x. */
export const CriticKeySchema = z
  .object({
    schemaVersion: z.literal(1),
    seed: z.string(),
    pairs: z.array(
      z
        .object({
          pairId: z.string(),
          manifest: z.string(),
          refId: z.string(),
          segmentId: z.string(),
          variantId: z.string(),
          kind: VariantKindSchema,
          original: z.enum(["x", "y"]),
          x: z.string(),
          y: z.string(),
        })
        .strict(),
    ),
    /** With --batches: each batch's question ids and the pair and order each stands for. */
    batches: z
      .array(
        z
          .object({
            batch: z.number().int().nonnegative(),
            questions: z.array(z.object({ id: z.string(), pairId: z.string(), order: z.enum(["ab", "ba"]) }).strict()),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type CriticKey = z.infer<typeof CriticKeySchema>;

const JudgementSchema = z.object({
  pairId: z.string(),
  order: z.enum(["ab", "ba"]),
  winner: z.enum(["A", "B", "tie"]),
  reason: z.string().default(""),
});
export const CriticResultsSchema = z.union([
  z.array(JudgementSchema),
  z.object({ judgements: z.array(JudgementSchema) }).transform((value) => value.judgements),
]);
export type CriticJudgement = z.infer<typeof JudgementSchema>;

const AccuracySchema = z
  .object({
    n: z.number().int().nonnegative(),
    detections: z.number().int().nonnegative(),
    accuracy: z.number().min(0).max(1).nullable(),
    eligible: z.boolean(),
  })
  .strict();

export const CalibrationReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    manifests: z.array(z.string()),
    /** Gate eligibility: accuracy at or over this, on at least `minPairs` pairs. */
    rule: z.object({ minAccuracy: z.number(), minPairs: z.number().int() }).strict(),
    sensors: z.array(
      AccuracySchema.extend({
        sensor: z.string(),
        kind: VariantKindSchema,
        /** target: the sensor is expected to read this kind as worse; control: it should not move. */
        role: z.enum(["target", "control"]),
        direction: z.string(),
        notMeasured: z.number().int().nonnegative(),
        /** For a control: pairs where it read the variant as clearly worse, a false alarm. */
        falseAlarms: z.number().int().nonnegative().optional(),
      }).strict(),
    ),
    byKind: z.record(
      z.string(),
      z
        .object({
          pairs: z.number().int().nonnegative(),
          sensors: z.record(z.string(), z.number().nullable()),
          critic: z.number().nullable().optional(),
        })
        .strict(),
    ),
    eligibleGates: z.array(
      z.object({ judge: z.string(), kind: VariantKindSchema, accuracy: z.number(), n: z.number().int() }).strict(),
    ),
    failures: z.array(
      z
        .object({
          judge: z.string(),
          kind: VariantKindSchema,
          manifest: z.string(),
          variantId: z.string(),
          reason: z.string(),
          original: z.number().nullable().optional(),
          variant: z.number().nullable().optional(),
        })
        .strict(),
    ),
    critic: z
      .object({
        pairs: z.number().int().nonnegative(),
        judged: z.number().int().nonnegative(),
        agreed: z.number().int().nonnegative(),
        correct: z.number().int().nonnegative(),
        accuracy: z.number().nullable(),
        byKind: z.record(z.string(), AccuracySchema),
        disagreements: z.array(z.string()),
        missing: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CalibrationReport = z.infer<typeof CalibrationReportSchema>;
