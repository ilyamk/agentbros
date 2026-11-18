import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ReferenceSpeechTextSchema, type ReferenceSpeechText } from "../../types/reference";

// A film's words are its makers' text, not ours. The tracked speech-text.json keeps their structure only (times,
// counts, boxes, case, an opaque id per distinct screen text); the verbatim text stays on this machine in the
// git-ignored media/ directory, for the consumers that need words: the blueprint leak check, the verbatim-copy check
// and the replica spec check. Every other consumer reads the structure, so its numbers are the same either way.

/** The verbatim layer, beside the media and as git-ignored as it. */
export const SPEECH_TEXT_FULL = "media/speech-text.full.json";
export const SPEECH_TEXT = "speech-text.json";

/** Letters and digits, lower case: the identity of a piece of screen text (ref:corpus merges samples on it). */
export const normaliseText = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

const wordsOf = (text: string) => text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));

const MINOR_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "for",
  "of",
  "to",
  "in",
  "on",
  "at",
  "by",
  "with",
  "from",
  "as",
  "is",
]);

/** Letter case of a text, kept in place of its words: upper, lower, title (every word capitalised), sentence (first only), mixed, none (no letters). */
export function textCase(text: string): NonNullable<ReferenceSpeechText["screenText"]["items"][number]["case"]> {
  const letters = text.match(/\p{L}/gu) ?? [];
  const cased = letters.filter((letter) => letter.toLowerCase() !== letter.toUpperCase());
  if (!cased.length) return "none";
  if (cased.every((letter) => letter === letter.toUpperCase())) return "upper";
  if (cased.every((letter) => letter === letter.toLowerCase())) return "lower";
  const initials = wordsOf(text)
    .map((word) => word.match(/\p{L}/u)?.[0])
    .filter((letter): letter is string => !!letter && letter.toLowerCase() !== letter.toUpperCase());
  const rest = wordsOf(text).flatMap((word) => (word.match(/\p{L}/gu) ?? []).slice(1));
  if (rest.some((letter) => letter.toLowerCase() !== letter.toUpperCase() && letter === letter.toUpperCase()))
    return "mixed";
  // Title case lets short function words stay lower ("Made for Teams").
  const major = wordsOf(text)
    .filter((word) => !MINOR_WORDS.has(word.toLowerCase().replace(/[^\p{L}]/gu, "")))
    .map((word) => word.match(/\p{L}/u)?.[0])
    .filter((letter): letter is string => !!letter && letter.toLowerCase() !== letter.toUpperCase());
  if (major.length > 1 && major.every((letter) => letter === letter.toUpperCase())) return "title";
  if (initials[0] && initials[0] === initials[0].toUpperCase()) return "sentence";
  return "mixed";
}

/** Whether a layer still holds any of the film's words. */
export function hasVerbatim(layer: ReferenceSpeechText | undefined): boolean {
  return (
    !!layer &&
    (layer.speech.words.some((word) => word.text !== undefined) ||
      layer.screenText.items.some((item) => item.text !== undefined))
  );
}

/** The structure of a full layer: every count and id computed from the words, then the words dropped. */
export function redactSpeechText(full: ReferenceSpeechText): ReferenceSpeechText {
  const ids = new Map<string, number>();
  for (const item of full.screenText.items) {
    if (item.text === undefined) continue;
    const key = normaliseText(item.text);
    if (!ids.has(key)) ids.set(key, ids.size);
  }
  return ReferenceSpeechTextSchema.parse({
    ...full,
    content: "structure",
    speech: {
      ...full.speech,
      words: full.speech.words.map(({ text, ...word }) => ({
        ...word,
        ...(text === undefined ? {} : { chars: normaliseText(text).length }),
      })),
    },
    screenText: {
      ...full.screenText,
      items: full.screenText.items.map(({ text, ...item }) =>
        text === undefined
          ? item
          : {
              ...item,
              textId: ids.get(normaliseText(text))!,
              chars: normaliseText(text).length,
              words: wordsOf(text).length,
              case: textCase(text),
            },
      ),
    },
  });
}

function writeJson(target: string, value: unknown) {
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, target);
}

/**
 * Writes a speech-text layer: a full one goes to media/speech-text.full.json and its structure to speech-text.json;
 * a structure-only one (an update made without the local text) to speech-text.json only. Returns the tracked path.
 */
export function writeSpeechText(directory: string, layer: ReferenceSpeechText): string {
  const parsed = ReferenceSpeechTextSchema.parse(layer);
  if (hasVerbatim(parsed)) writeJson(path.join(directory, SPEECH_TEXT_FULL), { ...parsed, content: "full" });
  const tracked = path.join(directory, SPEECH_TEXT);
  writeJson(tracked, hasVerbatim(parsed) ? redactSpeechText(parsed) : { ...parsed, content: "structure" });
  return tracked;
}

function readFile(target: string): ReferenceSpeechText | undefined {
  if (!existsSync(target)) return undefined;
  return ReferenceSpeechTextSchema.parse(JSON.parse(readFileSync(target, "utf8")));
}

/** The tracked layer, structure only once migrated. */
export function readTrackedSpeechText(directory: string): ReferenceSpeechText | undefined {
  return readFile(path.join(directory, SPEECH_TEXT));
}

/**
 * The film's words for the consumers that need them: the local full file, else a tracked layer that has not been
 * redacted yet, else undefined (a clone without the film: callers skip their word checks and say so).
 */
export function readFullSpeechText(directory: string): ReferenceSpeechText | undefined {
  const local = readFile(path.join(directory, SPEECH_TEXT_FULL));
  if (local && hasVerbatim(local)) return local;
  const tracked = readTrackedSpeechText(directory);
  return hasVerbatim(tracked) ? tracked : undefined;
}

/** The best layer for analysis code that runs before a redaction: full when present, else the tracked structure. */
export function readSpeechText(directory: string): ReferenceSpeechText | undefined {
  return readFullSpeechText(directory) ?? readTrackedSpeechText(directory);
}
