import { z } from "zod";

/**
 * Engine-neutral transcript of a user's recording. Producers: `transcribe`
 * (ElevenLabs Scribe or fal) and `speech:local`. Consumers: `recut:plan`,
 * `shorts:prepare`, captions, multicam angle choice. Times are source seconds;
 * consumers convert to decoded source frames themselves.
 */
const id = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
  .max(64);
const sec = z.number().finite().nonnegative();

export const TranscriptWordSchema = z
  .object({
    id,
    text: z.string().min(1),
    /**
     * `filler`: a disfluency ("um", "эээ"); context-dependent ones (standalone "ну") only when `engine.verbatim`.
     * Absent fillers prove nothing unless `engine.verbatim` is true. `event`: non-speech sounds and listener
     * backchannels ("mm-hmm", "угу").
     */
    kind: z.enum(["word", "filler", "event"]),
    startSec: sec,
    endSec: sec,
    speaker: id.nullable(),
    channel: z.number().int().nonnegative().nullable(),
    confidence: z.number().min(0).max(1).nullable(),
  })
  .strict()
  .refine((word) => word.endSec >= word.startSec, { message: "endSec before startSec" });

export const TranscriptSentenceSchema = z
  .object({
    id,
    firstWordId: id,
    lastWordId: id,
    text: z.string().min(1),
    startSec: sec,
    endSec: sec,
    speaker: id.nullable(),
  })
  .strict();

export const TranscriptSchema = z
  .object({
    version: z.literal(1),
    source: z
      .object({
        file: z.string().min(1),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        durationSec: sec.nullable(),
      })
      .strict(),
    engine: z
      .object({
        provider: z.enum(["elevenlabs", "local", "fal"]),
        model: z.string().min(1),
        verbatim: z.boolean(),
        diarized: z.boolean(),
        /** `estimated` when word times are interpolated rather than produced by the engine. */
        timing: z.enum(["native", "estimated"]),
      })
      .strict(),
    language: z.string().min(2),
    speakers: z.array(z.object({ id, label: z.string().min(1).optional() }).strict()),
    words: z.array(TranscriptWordSchema).max(200_000),
    sentences: z.array(TranscriptSentenceSchema),
    /** Plain-language caveats from the producer, e.g. why diarisation did not run. */
    notes: z.array(z.string().min(1)).optional(),
  })
  .strict();

export type TranscriptWord = z.infer<typeof TranscriptWordSchema>;
export type TranscriptSentence = z.infer<typeof TranscriptSentenceSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
