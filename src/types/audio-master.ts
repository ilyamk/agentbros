import { z } from "zod";
/** A relative path with no empty, `.` or `..` segment, no backslash and no URL or FFmpeg protocol scheme (`http:`, `concat:`, `subfile:`). */
export const isPlainRelativePath = (value: string): boolean =>
  !value.startsWith("/") &&
  !value.includes("\\") &&
  !value.includes("\0") &&
  !value.split("/").some((part) => ["", ".", ".."].includes(part)) &&
  !/^[a-z][a-z0-9+.-]*:/i.test(value);
export const AudioMasterInputsSchema = z
  .object({
    version: z.literal(1),
    mode: z.literal("project-timeline"),
    projectId: z.string().min(1),
    algorithm: z.literal("local-audio-v1"),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    sources: z
      .array(
        z
          .object({
            source: z.string().min(1).refine(isPlainRelativePath, "Audio input source must be public-relative"),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type AudioMasterInputs = z.infer<typeof AudioMasterInputsSchema>;
export const AudioMasterSchema = z
  .object({
    source: z.string().min(1),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    durationSec: z.number().positive(),
    integratedLufs: z.number(),
    truePeakDb: z.number(),
    targetLufs: z.number(),
    createdAt: z.string().datetime(),
    projectInputs: AudioMasterInputsSchema.optional(),
  })
  .strict();
export type AudioMaster = z.infer<typeof AudioMasterSchema>;
const Keyframe = z
  .object({
    atSec: z.number().nonnegative(),
    volume: z.number().min(0).max(1),
    /** Who wrote it: "fix-masking" keyframes are replaced on the next sfx:cues --fix-masking run. The mixer ignores it. */
    source: z.literal("fix-masking").optional(),
    /** The track's own keyframe volume before a fix-masking duck scaled it, restored on the next run. */
    baseVolume: z.number().min(0).max(1).optional(),
  })
  .strict();
export const LocalAudioMixSchema = z
  .object({
    version: z.literal(1),
    durationSec: z.number().positive(),
    targetLufs: z.number().min(-24).max(-9).default(-16),
    truePeakDb: z.number().min(-6).max(-1).default(-1.5),
    duckMusic: z.boolean().default(true),
    /** Deepest the music may dip under speech, in dB. The compressor's dry share sets the floor. */
    duckDb: z.number().min(-24).max(-3).default(-9),
    tracks: z
      .array(
        z
          .object({
            source: z.string().min(1),
            role: z.enum(["speech", "music", "sfx"]),
            startSec: z.number().nonnegative().default(0),
            sourceStartSec: z.number().nonnegative().default(0),
            sourceEndSec: z.number().positive().optional(),
            rate: z.number().min(0.125).max(8).default(1),
            volume: z.number().min(0).max(1).default(1),
            keyframes: z.array(Keyframe).default([]),
            loop: z.boolean().default(false),
            allowSpeechTrim: z.boolean().default(false),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((plan, ctx) => {
    for (const [i, track] of plan.tracks.entries()) {
      if (track.startSec >= plan.durationSec)
        ctx.addIssue({
          code: "custom",
          path: ["tracks", i, "startSec"],
          message: "Track begins after master end",
        });
      if (track.sourceEndSec !== undefined && track.sourceEndSec <= track.sourceStartSec)
        ctx.addIssue({
          code: "custom",
          path: ["tracks", i, "sourceEndSec"],
          message: "Source end must exceed start",
        });
      for (let k = 1; k < track.keyframes.length; k++)
        if (track.keyframes[k].atSec <= track.keyframes[k - 1].atSec)
          ctx.addIssue({
            code: "custom",
            path: ["tracks", i, "keyframes"],
            message: "Keyframe times must be strictly increasing",
          });
    }
  });
export type LocalAudioMix = z.infer<typeof LocalAudioMixSchema>;
