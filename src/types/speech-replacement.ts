import { z } from "zod";
import { ElevenLabsIdSchema, VoiceRefSchema } from "./elevenlabs";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const filePin = z.object({ file: z.string().min(1).max(4096), sha256: hash }).strict();
const frame = z.number().int().nonnegative().safe();
const base = {
  version: z.literal(1),
  projectId: ElevenLabsIdSchema,
  revision: frame,
  take: z.number().int().min(1).max(99).optional(),
  trackId: z.string().min(1).max(128),
  clipId: z.string().min(1).max(128),
  sourceSha256: hash,
  sourceTranscript: filePin,
  range: z.union([
    z.object({ startFrame: frame, endFrame: frame }).strict(),
    z.object({ firstWordId: ElevenLabsIdSchema, lastWordId: ElevenLabsIdSchema }).strict(),
  ]),
  approvedText: z.string().trim().min(1).max(10_000),
  language: z.string().regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]+)*$/),
  originalAudio: z.enum(["isolated-dialogue", "reviewed-room-tone"]),
  picture: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("offscreen") }).strict(),
    z.object({ mode: z.literal("unchanged-lips") }).strict(),
    z.object({ mode: z.enum(["cutaway", "lip-sync"]), assetId: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict(),
  ]),
  captionTrackId: z.string().min(1).max(128).optional(),
  maxCostUsd: z.number().positive().finite().optional(),
};
export const SpeechReplacementSchema = z
  .discriminatedUnion("method", [
    z
      .object({
        ...base,
        method: z.literal("voice-change"),
        voiceRef: VoiceRefSchema,
        performance: filePin.optional(),
        removeBackgroundNoise: z.boolean().optional(),
      })
      .strict(),
    z
      .object({
        ...base,
        method: z.literal("tts"),
        voiceRef: VoiceRefSchema,
        directedText: z.string().max(10_000).optional(),
      })
      .strict(),
    z.object({ ...base, method: z.literal("existing"), performance: filePin }).strict(),
  ])
  .superRefine((value, ctx) => {
    if (value.method === "existing") return;
    const model = value.voiceRef.model;
    if (
      value.voiceRef.language !== value.language ||
      (value.method === "tts"
        ? model !== "eleven_v4"
        : !["eleven_multilingual_sts_v2", "eleven_english_sts_v2"].includes(model))
    )
      ctx.addIssue({ code: "custom", message: "VoiceRef must match the language and replacement model" });
  });
export type SpeechReplacementRequest = z.infer<typeof SpeechReplacementSchema>;
