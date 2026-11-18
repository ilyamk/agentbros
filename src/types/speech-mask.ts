import { z } from "zod";

/**
 * Voice-activity mask of a recording from Silero VAD. Producer: `speech:local`
 * (`pipeline/speech-mask.json` or `--vad-output`). Consumer: `recut:plan` for
 * silence decisions. Segments are raw detector output in source seconds, sorted
 * and non-overlapping, with no padding added: consumers apply their own.
 */
const sec = z.number().finite().nonnegative();

export const SpeechMaskSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({ file: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), durationSec: sec })
      .strict(),
    engine: z
      .object({
        provider: z.literal("silero-vad"),
        version: z.string().min(1),
        sampleRate: z.literal(16000),
        threshold: z.number().gt(0).lt(1),
        minSpeechMs: z.number().int().nonnegative(),
        minSilenceMs: z.number().int().nonnegative(),
        padMs: z.literal(0),
      })
      .strict(),
    speech: z.array(
      z
        .object({ startSec: sec, endSec: sec })
        .strict()
        .refine((span) => span.endSec > span.startSec, { message: "empty speech span" }),
    ),
    speechSec: sec,
  })
  .strict()
  .refine(
    (mask) =>
      mask.speech.every(
        (span, i) =>
          span.endSec <= mask.source.durationSec + 0.05 && (i === 0 || span.startSec >= mask.speech[i - 1]!.endSec),
      ),
    { message: "speech spans must be sorted, non-overlapping and inside the source" },
  );

export type SpeechMask = z.infer<typeof SpeechMaskSchema>;
