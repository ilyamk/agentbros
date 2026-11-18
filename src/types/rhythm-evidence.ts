import { z } from "zod";
import { RationalSchema, TimebaseSchema } from "./timeline";
export const RhythmHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RhythmIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const RhythmProjectSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/);
const relative = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((part) => !part || part === "." || part === "..") &&
      !p.includes(":") &&
      !/[\x00-\x1f\x7f]/.test(p),
    "Project/root-relative literal path required",
  );
export const RhythmFilePinSchema = z
  .object({
    path: relative,
    sha256: RhythmHashSchema,
    bytes: z
      .number()
      .int()
      .nonnegative()
      .safe()
      .max(128 * 1024 * 1024),
  })
  .strict();
export const RhythmCurrentPinSchema = z.discriminatedUnion("kind", [
  RhythmFilePinSchema.extend({ kind: z.literal("present") }).strict(),
  z.object({ kind: z.literal("absent"), path: relative }).strict(),
]);
export const RHYTHM_PARAMETERS = Object.freeze({
  sampleRate: 16000,
  hopSamples: 320,
  windowHops: 25,
  floorRms: 0.005,
  floorMultiplier: 1.8,
  riseMultiplier: 1.5,
  minimumSpacingSec: 0.12,
  minimumIntervalSec: 0.25,
  maximumIntervalSec: 1.5,
  intervalTolerance: 0.08,
  toleranceSec: 0.02,
  confidenceThreshold: 0.65,
  sectionSec: 4,
} as const);
export const RhythmParametersSchema = z
  .object({
    sampleRate: z.literal(16000),
    hopSamples: z.literal(320),
    windowHops: z.literal(25),
    floorRms: z.literal(0.005),
    floorMultiplier: z.literal(1.8),
    riseMultiplier: z.literal(1.5),
    minimumSpacingSec: z.literal(0.12),
    minimumIntervalSec: z.literal(0.25),
    maximumIntervalSec: z.literal(1.5),
    intervalTolerance: z.literal(0.08),
    toleranceSec: z.literal(0.02),
    confidenceThreshold: z.literal(0.65),
    sectionSec: z.literal(4),
  })
  .strict();
export const RhythmClockSchema = z
  .object({
    version: z.literal(1),
    codec: z.enum(["pcm_s16le", "pcm_s24le", "pcm_s32le", "pcm_f32le", "pcm_f64le", "flac"]),
    sampleRate: z.number().int().min(8000).max(192000),
    channels: z.number().int().min(1).max(2),
    timebase: TimebaseSchema,
    terminalTick: z.number().int().positive().safe(),
    frames: z
      .array(
        z
          .object({ pts: z.number().int().nonnegative().safe(), nbSamples: z.number().int().min(1).max(65536) })
          .strict(),
      )
      .min(1)
      .max(30000),
  })
  .strict();
export const RhythmClockSummarySchema = z
  .object({
    sampleRate: z.number().int().min(8000).max(192000),
    channels: z.number().int().min(1).max(2),
    codec: RhythmClockSchema.shape.codec,
    timebase: TimebaseSchema,
    terminalTick: z.number().int().positive().safe(),
    sourceSamples: z.number().int().positive().safe(),
    analysisSamples: z.number().int().positive().max(4800000),
    duration: RationalSchema,
  })
  .strict();
const tool = z.object({ version: z.string().min(1).max(300), sha256: RhythmHashSchema }).strict();
export const RhythmArtifactMetadataSchema = z
  .object({ version: z.literal("darwin-owned-generated-fd-v1"), sha256: RhythmHashSchema })
  .strict();
export const RhythmRuntimeSchema = z
  .object({ ffmpeg: tool, ffprobe: tool, artifactMetadata: RhythmArtifactMetadataSchema.optional() })
  .strict();
export const RhythmImplementationsSchema = z
  .object({ kernel: RhythmHashSchema, clock: RhythmHashSchema, evidence: RhythmHashSchema, mapper: RhythmHashSchema })
  .strict();
export const RhythmExecutionLimitsSchema = z
  .object({
    wholeMs: z.number().int().positive().max(90000),
    probeMs: z.number().int().positive().max(15000),
    decodeMs: z.number().int().positive().max(60000),
    stallMs: z.number().int().positive().max(10000),
    metadataBytes: z.number().int().positive().max(4194304),
    sharedMetadataBytes: z.number().int().positive().max(8388608),
    stderrBytes: z.number().int().positive().max(262144),
    sourceBytes: z.number().int().positive().max(67108864),
    pcmBytes: z.number().int().positive().max(19200000),
    artifactBytes: z.number().int().positive().max(67108864),
  })
  .partial()
  .strict();
export const RhythmAnalysisRequestSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("source-rhythm-evidence-v1"),
    projectId: RhythmProjectSchema,
    assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    assetSha256: RhythmHashSchema,
    profile: z.literal("rms-onset-v1-mono16k"),
    limits: RhythmExecutionLimitsSchema.optional(),
  })
  .strict()
  .refine((r) => r.assetId === `sha256:${r.assetSha256}`, "Asset ID/SHA mismatch");
export const RhythmHeuristicSchema = z
  .object({
    sourceSha256: RhythmHashSchema,
    durationSec: z.number().finite().positive().max(300),
    algorithm: z.literal("rms-onset-v1"),
    onsetsSec: z.array(z.number().finite().nonnegative().max(300)).max(10000),
    tempoBpm: z.number().finite().positive().nullable(),
    confidence: z.number().finite().min(0).max(1),
    beatCandidatesSec: z.array(z.number().finite().nonnegative().max(300)).max(10000),
    overrides: z.null(),
    fallback: z.enum(["candidate-beats", "speech-story-rhythm"]),
    sections: z
      .array(
        z
          .object({
            startSec: z.number().finite().nonnegative(),
            endSec: z.number().finite().positive().max(300),
            rms: z.number().finite().nonnegative(),
          })
          .strict(),
      )
      .min(1)
      .max(75),
    automaticCuts: z.literal(false),
  })
  .strict();
export const RhythmEvidencePayloadSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("source-rhythm-evidence-v1"),
    request: RhythmAnalysisRequestSchema,
    original: RhythmFilePinSchema,
    selectedAssetDigest: RhythmHashSchema,
    initialPins: z.array(RhythmFilePinSchema).min(2).max(3),
    parameters: RhythmParametersSchema,
    runtime: RhythmRuntimeSchema,
    implementations: RhythmImplementationsSchema,
    clock: RhythmClockSummarySchema,
    artifacts: z
      .object({
        clock: RhythmFilePinSchema,
        pcm: RhythmFilePinSchema,
        originalSnapshot: RhythmFilePinSchema.optional(),
        commit: RhythmFilePinSchema.optional(),
      })
      .strict(),
    analysis: RhythmHeuristicSchema,
    onsets: z
      .array(z.object({ id: RhythmIdSchema, sample: z.number().int().nonnegative().max(4799999) }).strict())
      .max(10000),
    generatedAt: z.iso.datetime(),
    state: z.literal("candidate"),
    reviewRequired: z.literal(true),
    automaticCuts: z.literal(false),
    calibratedBeatTruth: z.literal(false),
    apiCalls: z.literal(0),
  })
  .strict();
export const RhythmEvidenceSchema = RhythmEvidencePayloadSchema.extend({ sha256: RhythmHashSchema }).strict();
const review = z
  .object({
    kind: z.literal("supplied-review"),
    reviewedBy: z
      .string()
      .min(1)
      .max(256)
      .refine((v) => !!v.trim(), "Reviewer cannot be blank"),
    note: z
      .string()
      .min(1)
      .max(2048)
      .refine((v) => !!v.trim(), "Review note cannot be blank"),
    acknowledge: z.literal("reviewed-source-marks-not-calibrated-beat-truth"),
  })
  .strict();
export const ReviewedRhythmMarksSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("reviewed-rhythm-marks-v1"),
    projectId: RhythmProjectSchema,
    evidence: z.object({ path: relative, sha256: RhythmHashSchema }).strict(),
    trackId: RhythmIdSchema,
    clipId: RhythmIdSchema,
    expectedRevision: z.number().int().nonnegative().safe(),
    review,
    marks: z
      .array(
        z.discriminatedUnion("origin", [
          z.object({ id: RhythmIdSchema, origin: z.literal("evidence-onset"), onsetId: RhythmIdSchema }).strict(),
          z
            .object({
              id: RhythmIdSchema,
              origin: z.literal("manual-reviewed-mark"),
              sample: z.number().int().nonnegative().max(4799999),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(512),
  })
  .strict();
const rowBase = {
  id: RhythmIdSchema,
  origin: z.enum(["evidence-onset", "manual-reviewed-mark"]),
  sample: z.number().int().nonnegative().max(4799999),
  sourceFrame: RationalSchema,
};
export const RhythmMappedRowSchema = z.discriminatedUnion("status", [
  z
    .object({ ...rowBase, status: z.literal("included"), outputFrame: RationalSchema, outputSeconds: RationalSchema })
    .strict(),
  z.object({ ...rowBase, status: z.literal("outside-source-trim") }).strict(),
]);
export const RhythmMarksPayloadSchema = z
  .object({
    version: z.literal(1),
    contract: z.literal("mapped-rhythm-marks-v1"),
    request: ReviewedRhythmMarksSchema,
    requestSha256: RhythmHashSchema,
    evidencePayloadSha256: RhythmHashSchema,
    reviewSha256: RhythmHashSchema,
    currentPins: z.array(RhythmCurrentPinSchema).min(4).max(16),
    revision: z.number().int().nonnegative().safe(),
    clipSha256: RhythmHashSchema,
    assetSha256: RhythmHashSchema,
    mapperSha256: RhythmHashSchema,
    rows: z.array(RhythmMappedRowSchema).min(1).max(512),
    included: z.number().int().min(0).max(512),
    excluded: z.number().int().min(0).max(512),
    readonly: z.literal(true),
    timelineMutation: z.literal(false),
    reviewRequired: z.literal(true),
    calibratedBeatTruth: z.literal(false),
  })
  .strict();
export const RhythmMarksSchema = RhythmMarksPayloadSchema.extend({ sha256: RhythmHashSchema }).strict();
export type RhythmClock = z.infer<typeof RhythmClockSchema>;
export type RhythmClockSummary = z.infer<typeof RhythmClockSummarySchema>;
export type RhythmEvidence = z.infer<typeof RhythmEvidenceSchema>;
export type ReviewedRhythmMarks = z.infer<typeof ReviewedRhythmMarksSchema>;
export type RhythmMarks = z.infer<typeof RhythmMarksSchema>;
