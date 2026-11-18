import { z } from "zod";
import { RationalSchema } from "./timeline";

/**
 * Shorts selection from a long recording. `shorts:prepare` writes numbered
 * sentences; the harness agent fills `ShortsCandidatesSchema` (axis scores
 * with verbatim evidence, never a total); `shorts:rank` validates, scores and
 * writes unapproved proposals for `shorts-series`.
 */
const id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .max(64);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const sec = z.number().finite().nonnegative();
const sentenceNo = z.number().int().positive();

export const SHORTS_AXES = ["hook", "standalone", "emotion", "payoff", "value", "relevance"] as const;
export type ShortsAxis = (typeof SHORTS_AXES)[number];

export const ShortsSentenceSchema = z
  .object({
    n: sentenceNo,
    id,
    firstWordId: id,
    lastWordId: id,
    startSec: sec,
    endSec: sec,
    speaker: id.nullable(),
    text: z.string().min(1),
  })
  .strict();

export const ShortsPreparedSchema = z
  .object({
    version: z.literal(1),
    transcript: z
      .object({ file: z.literal("transcript.json"), sha256: hash, sourceSha256: hash, language: z.string().min(2) })
      .strict(),
    params: z
      .object({
        count: z.number().int().positive().max(30),
        minSec: z.number().positive(),
        maxSec: z.number().positive(),
        hardMaxSec: z.number().positive(),
        brief: z.string().nullable(),
      })
      .strict(),
    sentenceCount: z.number().int().nonnegative(),
    sentencesDerived: z.boolean(),
    chunks: z
      .array(
        z
          .object({
            file: z.string().regex(/^chunk-\d{2}\.md$/),
            startSec: sec,
            endSec: sec,
            firstSentence: sentenceNo,
            lastSentence: sentenceNo,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type ShortsPrepared = z.infer<typeof ShortsPreparedSchema>;

export const ShortsAxisScoreSchema = z
  .object({
    score: z.number().min(0).max(10),
    /** Sentence number the quote is taken from; must lie inside the candidate's range. */
    sentence: sentenceNo,
    /** Verbatim words from that sentence. */
    quote: z.string().min(2),
  })
  .strict();

export const ShortsCandidateSchema = z
  .object({
    id,
    title: z.string().min(1).max(120),
    firstSentence: sentenceNo,
    lastSentence: sentenceNo,
    hookSentence: sentenceNo,
    axes: z
      .object({
        hook: ShortsAxisScoreSchema,
        standalone: ShortsAxisScoreSchema,
        emotion: ShortsAxisScoreSchema,
        payoff: ShortsAxisScoreSchema,
        value: ShortsAxisScoreSchema,
        relevance: ShortsAxisScoreSchema,
      })
      .strict(),
    vetoes: z
      .object({
        needsSetup: z.boolean(),
        endsBeforePayoff: z.boolean(),
        claimOutOfContext: z.boolean(),
      })
      .strict(),
    note: z.string().max(400).optional(),
  })
  .strict()
  .refine((c) => c.lastSentence >= c.firstSentence, { message: "lastSentence before firstSentence" });
export type ShortsCandidate = z.infer<typeof ShortsCandidateSchema>;

export const ShortsCandidatesSchema = z
  .object({ version: z.literal(1), candidates: z.array(ShortsCandidateSchema).min(1).max(200) })
  .strict();

export const ShortsWeightsSchema = z
  .object(
    Object.fromEntries(SHORTS_AXES.map((axis) => [axis, z.number().min(0).max(10)])) as Record<ShortsAxis, z.ZodNumber>,
  )
  .strict()
  .refine((w) => Object.values(w).some((v) => v > 0), { message: "At least one weight must be positive" });
export type ShortsWeights = z.infer<typeof ShortsWeightsSchema>;

const FrameSpan = z.object({ start: RationalSchema, end: RationalSchema }).strict();

/** `ShortSelection` without `approval`: a human reviews it and adds approvedBy/approvedAt with this selectionHash. */
export const ShortProposalSelectionSchema = z
  .object({
    version: z.literal(1),
    id,
    purpose: z.string().min(1),
    ranges: z.array(FrameSpan).length(1),
    selectionHash: hash,
  })
  .strict();

export const ShortsScoredSchema = z
  .object({
    id,
    title: z.string(),
    score: z.number().min(0).max(100),
    axes: z.record(z.string(), ShortsAxisScoreSchema),
    firstSentence: sentenceNo,
    lastSentence: sentenceNo,
    hookSentence: sentenceNo,
    startSec: sec,
    endSec: sec,
    durationSec: sec,
    text: z.string(),
    warnings: z.array(z.string()),
  })
  .strict();
export type ShortsScored = z.infer<typeof ShortsScoredSchema>;

export const ShortsProposalsSchema = z
  .object({
    version: z.literal(1),
    preparedSha256: hash,
    candidatesSha256: hash,
    sourceSha256: hash,
    weights: ShortsWeightsSchema,
    weightsHash: hash,
    threshold: z.number().min(0).max(100),
    thresholdSource: z.enum(["flag", "calibration", "default"]),
    proposals: z.array(
      ShortsScoredSchema.extend({
        rank: z.number().int().positive(),
        selection: ShortProposalSelectionSchema.optional(),
      }).strict(),
    ),
    others: z.array(ShortsScoredSchema.extend({ reason: z.enum(["below-threshold", "over-count"]) }).strict()),
    droppedOverlaps: z.array(z.object({ id, keptId: id, overlap: z.number() }).strict()),
    rejected: z.array(z.object({ id: z.string(), reasons: z.array(z.string()).min(1) }).strict()),
    timeline: z.object({ projectId: id, trackId: z.string(), assetId: z.string() }).strict().nullable(),
  })
  .strict();
export type ShortsProposals = z.infer<typeof ShortsProposalsSchema>;

export const ShortsRatingsSchema = z
  .object({
    version: z.literal(1),
    ratings: z
      .array(z.object({ id, rating: z.number().int().min(1).max(5), note: z.string().optional() }).strict())
      .min(1),
  })
  .strict();

export const ShortsCalibrationSchema = z
  .object({
    version: z.literal(1),
    threshold: z.number().min(0).max(100),
    weights: ShortsWeightsSchema,
    weightsHash: hash,
    approvedAtLeast: z.number().int().min(1).max(5),
    targetPrecision: z.number().min(0).max(1),
    precision: z.number().min(0).max(1),
    clipsAbove: z.number().int().nonnegative(),
    approvedAbove: z.number().int().nonnegative(),
    rated: z.number().int().positive(),
    ratingsSha256: hash,
    proposalsSha256: hash,
    calibratedAt: z.string().datetime(),
  })
  .strict();
export type ShortsRatings = z.infer<typeof ShortsRatingsSchema>;
export type ShortsCalibration = z.infer<typeof ShortsCalibrationSchema>;
