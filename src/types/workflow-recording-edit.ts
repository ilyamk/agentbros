import { z } from "zod";
import { AssetRightsSchema } from "./assets";
const frame = z.number().int().safe().nonnegative();
const interval = {
  startFrame: frame,
  endFrame: frame,
};
const LegacyRecordingEditRequestSchema = z
  .object({
    version: z.literal(1),
    workflow: z.literal("recording-edit"),
    projectId: z.string(),
    name: z.string().min(1),
    profile: z.literal("recording-only"),
    formats: z
      .array(z.enum(["vertical", "square", "landscape"]))
      .min(1)
      .max(3),
    source: z
      .object({
        file: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.string().min(1),
        fps: z
          .object({
            num: z.literal(30),
            den: z.literal(1),
          })
          .strict(),
        rights: AssetRightsSchema.optional(),
      })
      .strict(),
    transcript: z
      .object({
        version: z.string().min(1),
        language: z.string().min(1),
        words: z
          .array(
            z
              .object({
                id: z.string().min(1),
                text: z.string().min(1),
                ...interval,
                /** Diarised speaker; written onto each caption so pages break at speaker changes. Absent leaves older edit hashes unchanged. */
                speaker: z.string().min(1).optional(),
              })
              .strict(),
          )
          .min(1)
          .max(30000),
      })
      .strict(),
    keepSpans: z
      .array(
        z
          .object({
            id: z.string().min(1),
            ...interval,
            reason: z.string().min(1),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    cuts: z
      .array(
        z
          .object({
            ...interval,
            reason: z.string().min(1),
          })
          .strict(),
      )
      .max(201),
    protectedSpans: z
      .array(
        z
          .object({
            ...interval,
            kind: z.enum(["negation", "caveat", "attribution", "context", "complete-statement"]),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .max(1000),
    revision: z.number().int().positive(),
    previousEdit: z
      .object({
        projectId: z.string(),
        editHash: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    review: z
      .object({
        reviewer: z.string().min(1),
        reviewedAt: z.string().datetime(),
        approvedEditHash: z.string().regex(/^[a-f0-9]{64}$/),
        meaningPreserved: z.literal(true),
      })
      .strict()
      .optional(),
  })
  .strict();
/** Source intervals index decoded frames, never the nominal frame-rate clock. */
export const RecordingNormalizationSchema = z
  .object({
    targetFps: z.object({ num: z.literal(30), den: z.literal(1) }).strict(),
    video: z.literal("timestamp-near"),
    keepRounding: z.literal("outward"),
    boundaryRounding: z.literal("nearest"),
    audio: z.literal("preserve-clock"),
  })
  .strict();
const NormalizedRecordingEditRequestSchema = LegacyRecordingEditRequestSchema.extend({
  version: z.literal(2),
  source: LegacyRecordingEditRequestSchema.shape.source
    .extend({
      fps: z
        .object({ num: z.number().int().positive().max(1000000), den: z.number().int().positive().max(1000000) })
        .strict(),
      normalization: RecordingNormalizationSchema,
    })
    .strict(),
});
/** Audio and picture treatment of every join between kept spans; applied when the reviewed project is created. */
export const RecordingJoinPolicySchema = z
  .object({
    crossfadeMs: z.number().finite().min(5).max(50),
    curve: z.literal("equal-power"),
    snap: z
      .object({
        energyWindowMs: z.literal(10),
        searchMs: z.number().finite().min(0).max(33),
        zeroCrossingMs: z.literal(5),
      })
      .strict(),
    roomTone: z
      .object({ ...interval, gainDb: z.number().finite().min(-60).max(0) })
      .strict()
      .nullable(),
    punchIn: z
      .object({ scale: z.number().finite().min(1).max(1.2), pattern: z.literal("alternate") })
      .strict()
      .nullable(),
  })
  .strict();
const JoinedRecordingEditRequestSchema = LegacyRecordingEditRequestSchema.extend({
  version: z.literal(3),
  source: z.union([LegacyRecordingEditRequestSchema.shape.source, NormalizedRecordingEditRequestSchema.shape.source]),
  joins: RecordingJoinPolicySchema,
});
export const RecordingEditRequestSchema = z.discriminatedUnion("version", [
  LegacyRecordingEditRequestSchema,
  NormalizedRecordingEditRequestSchema,
  JoinedRecordingEditRequestSchema,
]);
export type RecordingJoinPolicy = z.infer<typeof RecordingJoinPolicySchema>;
export type RecordingEditRequest = z.infer<typeof RecordingEditRequestSchema>;
