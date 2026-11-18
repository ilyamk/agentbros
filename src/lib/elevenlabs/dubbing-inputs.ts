import { z } from "zod";
import { TranscriptSchema } from "../../types/transcript";

const segment = z
  .object({
    text: z.string().min(1),
    start_s: z.number().finite().nonnegative(),
    end_s: z.number().finite().positive(),
    speaker_id: z.string().min(1).max(128).optional(),
    external_id: z.string().min(1).max(128).optional(),
    translation: z.string().optional(),
  })
  .strict();
const supplied = z.object({ segments: z.array(segment).min(1).max(20_000) }).strict();

export function dubbingTranscript(raw: unknown, source: { sha256: string; durationSec: number }) {
  const canonical = TranscriptSchema.safeParse(raw);
  if (
    canonical.success &&
    (canonical.data.source.sha256 !== source.sha256 ||
      canonical.data.source.durationSec === null ||
      Math.abs(canonical.data.source.durationSec - source.durationSec) > 0.05)
  )
    throw Error("Supplied transcript is not bound to this source media");
  const value = supplied.parse(
    canonical.success
      ? {
          segments: canonical.data.sentences.map((sentence) => ({
            text: sentence.text,
            start_s: sentence.startSec,
            end_s: sentence.endSec,
            external_id: sentence.id,
            ...(sentence.speaker ? { speaker_id: sentence.speaker } : {}),
          })),
        }
      : raw,
  );
  const ids = new Set<string>(),
    speakerEnds = new Map<string, number>();
  let previousStart = -1;
  for (const row of value.segments) {
    const duration = row.end_s - row.start_s;
    if (duration < 0.1 - 1e-9 || duration > 25 || row.start_s < previousStart || row.end_s > source.durationSec + 0.05)
      throw Error("Supplied transcript has invalid source timing; review rather than inventing boundaries");
    if (row.external_id && ids.has(row.external_id)) throw Error("Duplicate transcript external_id");
    if (row.external_id) ids.add(row.external_id);
    const speaker = row.speaker_id ?? "default";
    if (row.start_s < (speakerEnds.get(speaker) ?? 0) - 1e-9) throw Error("A supplied speaker overlaps itself");
    speakerEnds.set(speaker, row.end_s);
    previousStart = row.start_s;
  }
  const translated = value.segments.filter((row) => row.translation !== undefined).length;
  if (translated && translated !== value.segments.length) throw Error("Supply translations for every segment or none");
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024) throw Error("Supplied transcript exceeds 4 MiB");
  return value;
}

export function dubbingTranslations(raw: unknown, canonicalSegments?: { id?: string; external_id?: string }[]) {
  const value = z.record(z.string().min(1).max(128), z.string().min(1)).parse(raw);
  if (
    Object.keys(value).length < 1 ||
    Object.keys(value).length > 20_000 ||
    Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024
  )
    throw Error("Translation map exceeds its bounds");
  if (canonicalSegments) {
    const ids = canonicalSegments.map((row) => row.external_id ?? row.id);
    if (
      ids.some((id) => !id || !Object.hasOwn(value, id)) ||
      Object.keys(value).length !== ids.length ||
      new Set(ids).size !== ids.length
    )
      throw Error("Translations must cover each canonical source segment exactly once");
  }
  return value;
}
