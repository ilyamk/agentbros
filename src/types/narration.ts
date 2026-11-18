import { z } from "zod";
import { NarratorDirectionSchema } from "./pipeline";

/**
 * The film chain's narration step (docs/production-chain/narration.md). The narrator-director writes the direction;
 * `generate:voiceover --directed` reads the same file, so it stays a NarratorDirectionSchema with the film's own fields.
 */

/** Where the takes come from: paid ElevenLabs timestamped takes, free local system-voice drafts, or takes already made. */
export const NarrationRouteSchema = z.enum(["elevenlabs", "local", "existing"]);
export type NarrationRoute = z.infer<typeof NarrationRouteSchema>;

/** pipeline/narrator-direction.json in a film: the direction plus the voice choice, its route and the user's bound. */
export const NarrationDirectionSchema = NarratorDirectionSchema.extend({
  route: NarrationRouteSchema,
  /** Why this voice for this film: the brief's audience and tone, the script's register. */
  voiceWhy: z.string().min(1),
  /** The planning bound per take (generate:voiceover applies it to each beat), authorised by the user's approval of this file; required on the paid route. The exposure is beats × this. */
  maxCostUsd: z.number().positive().optional(),
  /**
   * The take this direction makes: 1 is voiceover/<beat>.mp3, n > 1 is voiceover/<beat>.take-<n>.mp3. A rejected paid take
   * stays on disk (takes are immutable); the revised direction raises this, and generate:voiceover gets --take <n>.
   */
  take: z.number().int().min(1).max(99).default(1),
});
export type NarrationDirection = z.infer<typeof NarrationDirectionSchema>;

export const NarrationBeatSchema = z.object({
  beatId: z.string().min(1),
  /** The take, project-relative (public/projects/<id>/...). */
  file: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  /** Measured with ffprobe by narration:check. */
  durationSec: z.number().positive(),
  /** The take's receipt: ElevenLabs `<take>.take.json` or the local result's `.receipt.json`. */
  receipt: z.string().min(1),
  /** Raw word timings: the provider's `.words.json` sidecar or a speech:local transcript. */
  words: z.string().min(1),
  /** Edited caption words the build mounts: voiceover/<beatId>.words.edited.json ({ words: [{text,start,end,emphasis}] }). */
  captions: z.string().min(1),
  wordCount: z.number().int().nonnegative(),
  emphasisCount: z.number().int().nonnegative(),
  /** Default placement: the takes laid end to end in script order. The beat sheet may move them. */
  startSec: z.number().nonnegative(),
});

/** pipeline/narration.json, written only by narration:check: every take measured, with its receipt and caption words. */
export const NarrationSchema = z.object({
  schemaVersion: z.literal(1),
  route: NarrationRouteSchema,
  /** The active take: the direction's `take`, whose files the beats name. */
  take: z.number().int().min(1).max(99).default(1),
  direction: z.object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/) }),
  language: z.string().min(2),
  beats: z.array(NarrationBeatSchema),
  totalSec: z.number().nonnegative(),
});
export type Narration = z.infer<typeof NarrationSchema>;
