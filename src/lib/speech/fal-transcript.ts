import { TranscriptSchema, type Transcript } from "../../types/transcript";
import { buildTranscript, type RawWord } from "./transcript";

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/** Native word rows, or explicitly estimated words within a provider's segment span. Never time untimed text. */
export function normaliseFalTranscript(
  result: unknown,
  options: { source: Transcript["source"]; endpoint: string; language?: string },
): Transcript {
  const outer = record(result);
  if (outer.provider === "fal.ai" && typeof outer.endpoint === "string" && outer.endpoint !== options.endpoint)
    throw new Error("Raw fal manifest endpoint differs from the selected endpoint.");
  const raw = outer.provider === "fal.ai" && outer.data ? record(outer.data) : outer;
  if (!Array.isArray(raw.words) && !Array.isArray(raw.chunks) && !Array.isArray(raw.segments))
    throw new Error("fal transcription requires words, chunks or segments with timestamps.");
  const words: RawWord[] = [];
  const speakers = new Map<string, string>();
  let estimated = false,
    untimed = 0;
  const add = (value: unknown, segment: boolean, inheritedSpeaker?: unknown) => {
    const row = record(value);
    if (row.type === "spacing" || typeof row.text !== "string" || !row.text.trim()) return;
    const stamp = Array.isArray(row.timestamp) ? row.timestamp : [];
    const start = row.start ?? stamp[0],
      end = row.end ?? stamp[1];
    if (!time(start) || !time(end) || end < start) {
      untimed++;
      return;
    }
    const label = row.speaker_id ?? row.speaker ?? inheritedSpeaker;
    const labelText =
      typeof label === "string" && label.trim()
        ? label
        : typeof label === "number" && Number.isFinite(label)
          ? String(label)
          : null;
    if (labelText !== null && !speakers.has(labelText)) speakers.set(labelText, `speaker_${speakers.size + 1}`);
    const parts = segment ? row.text.trim().split(/\s+/u) : [row.text];
    if (segment) estimated = true;
    parts.forEach((text, i) =>
      words.push({
        text,
        startSec: start + ((end - start) * i) / parts.length,
        endSec: start + ((end - start) * (i + 1)) / parts.length,
        kind: row.type === "audio_event" ? "event" : "word",
        speaker: labelText === null ? null : speakers.get(labelText)!,
        channel: null,
        confidence: null,
      }),
    );
  };
  if (Array.isArray(raw.words) && raw.words.length) raw.words.forEach((row) => add(row, false));
  else
    for (const value of Array.isArray(raw.chunks) ? raw.chunks : Array.isArray(raw.segments) ? raw.segments : []) {
      const segment = record(value);
      if (Array.isArray(segment.words) && segment.words.length)
        segment.words.forEach((row) => add(row, false, segment.speaker_id ?? segment.speaker));
      else add(segment, true);
    }
  if (!words.length && typeof raw.text === "string" && raw.text.trim())
    throw new Error("fal transcription contains text but no usable timestamps; use a timestamp-capable endpoint.");
  const transcript = buildTranscript({
    source: options.source,
    engine: {
      provider: "fal",
      model: options.endpoint,
      verbatim: false,
      diarized: speakers.size > 0,
      timing: estimated ? "estimated" : "native",
    },
    language:
      options.language ??
      (typeof raw.language_code === "string"
        ? raw.language_code
        : typeof raw.language === "string"
          ? raw.language
          : Array.isArray(raw.languages) && typeof raw.languages[0] === "string"
            ? raw.languages[0]
            : "und"),
    words,
    notes: [
      "This endpoint does not establish verbatim filler coverage.",
      ...(estimated
        ? ["Word timings are estimated evenly within provider segment timestamps; review before cutting or captioning."]
        : []),
      ...(untimed ? [`${untimed} recognised rows had unusable timestamps and were left out.`] : []),
    ],
  });
  transcript.speakers = [...speakers].map(([label, id]) => ({ id, label }));
  return TranscriptSchema.parse(transcript);
}
