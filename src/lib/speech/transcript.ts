import path from "node:path";
import {
  TranscriptSchema,
  type Transcript,
  type TranscriptSentence,
  type TranscriptWord,
} from "../../types/transcript";

/** One recognised token before ids, filler marks and sentences are assigned. */
export type RawWord = {
  text: string;
  startSec: number;
  endSec: number;
  kind: "word" | "event";
  speaker: string | null;
  channel: number | null;
  confidence: number | null;
};

export type TranscriptInput = {
  source: Transcript["source"];
  engine: Transcript["engine"];
  language: string;
  words: RawWord[];
  notes?: string[];
};

/** A gap this long ends a sentence even without punctuation. */
export const SENTENCE_PAUSE_SEC = 0.7;
const SENTENCE_MAX_SEC = 30;
/** A pause this long isolates "ну" from its neighbours. */
const STANDALONE_PAUSE_SEC = 0.3;

const ISO_639_1: Record<string, string> = {
  eng: "en",
  rus: "ru",
  ukr: "uk",
  bel: "be",
  kaz: "kk",
  deu: "de",
  ger: "de",
  fra: "fr",
  fre: "fr",
  spa: "es",
  ita: "it",
  por: "pt",
  pol: "pl",
  nld: "nl",
  dut: "nl",
  ces: "cs",
  cze: "cs",
  slk: "sk",
  swe: "sv",
  nor: "no",
  dan: "da",
  fin: "fi",
  est: "et",
  lav: "lv",
  lit: "lt",
  ron: "ro",
  rum: "ro",
  hun: "hu",
  bul: "bg",
  srp: "sr",
  hrv: "hr",
  slv: "sl",
  ell: "el",
  gre: "el",
  tur: "tr",
  ara: "ar",
  heb: "he",
  hin: "hi",
  jpn: "ja",
  kor: "ko",
  zho: "zh",
  chi: "zh",
  cmn: "zh",
  vie: "vi",
  tha: "th",
  ind: "id",
  msa: "ms",
  fas: "fa",
  per: "fa",
  uzb: "uz",
  aze: "az",
  kat: "ka",
  geo: "ka",
  hye: "hy",
  arm: "hy",
  mlt: "mt",
};

/** ISO-639-1 where one exists, so Scribe ("eng") and local output ("en") agree; `und` when unknown. */
export function normaliseLanguage(code: string | null | undefined): string {
  const value = (code ?? "").trim().toLowerCase().split(/[-_]/)[0] ?? "";
  if (value.length < 2) return "und";
  return ISO_639_1[value] ?? value;
}

/**
 * A local recogniser's language from its text when no language was given: Cyrillic letters in a clear majority (over
 * 80% of letters, at least 20 of them) mean Russian unless Ukrainian or Belarusian letters appear; anything else stays
 * "und". Latin text is not guessed: too many languages share the script.
 */
export function inferLanguage(words: readonly { text: string }[]): string {
  let cyrillic = 0,
    letters = 0,
    other = 0;
  for (const word of words)
    for (const char of word.text) {
      if (!/\p{L}/u.test(char)) continue;
      letters++;
      if (/\p{Script=Cyrillic}/u.test(char)) {
        cyrillic++;
        if (/[іїєґўІЇЄҐЎ]/u.test(char)) other++;
      }
    }
  return cyrillic >= 20 && cyrillic / letters > 0.8 && other === 0 ? "ru" : "und";
}

const bare = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\p{P}\p{S}]/gu, "");
// Only sounds that are never content words. "like", "actually", "well", "так", "вот" stay words.
const FILLER = /^(?:u+h+|u+m+|u+h+m+|e+r+m+|e+r{2,}|h+m+|m{2,}|э+|э+м+|м{2,}|х+м+|ну+у)$/u;
// Real words elsewhere: German "er", Russian "м" as metres after a number.
const FILLER_BY_LANGUAGE: Record<string, RegExp> = { en: /^er$/u, ru: /^м$/u };
// Listener feedback ("mm-hmm" while someone else talks): kept as events so captions skip it and recut never cuts it.
const BACKCHANNEL = /^(?:m+-?h+m+|mhm+|uh-?huh|u+h+-?h+u+h+|угу+|мгм+|м-?гм+)$/u;
const TRAILING_BREAK = /[,.!?…;:—–-]["»”')\]]*$/u;
export const SENTENCE_END = /[.!?…。！？]["»”')\]]*$/u;

/** "Mm-hmm", "uh-huh", "угу": a listener's acknowledgement rather than the speaker's words. */
export const isBackchannel = (text: string) =>
  BACKCHANNEL.test(
    text
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[^\p{L}-]/gu, "")
      .replace(/^-+|-+$/g, ""),
  );

/**
 * Disfluencies. Sounds that are never words ("um", "эээ", "ну-у") count in any transcript; a few that are words in
 * other languages only in their own ("er" in English, "м" in Russian, not after a number). Plain "ну" counts only in
 * verbatim transcripts and only when standalone: a pause, punctuation, a speaker change or the edge of the
 * transcript on both sides ("Ну, давайте" yes, "ну да" no).
 */
export function isFiller(
  words: readonly RawWord[],
  index: number,
  options: { verbatim?: boolean; language?: string } = { verbatim: true },
): boolean {
  const word = words[index]!;
  if (word.kind !== "word") return false;
  const key = bare(word.text);
  if (FILLER.test(key)) return true;
  const previous = words
    .slice(0, index)
    .reverse()
    .find((item) => item.kind === "word");
  const local = FILLER_BY_LANGUAGE[normaliseLanguage(options.language)];
  if (local?.test(key)) return !(key === "м" && previous && /\d[\p{P}]*$/u.test(previous.text));
  if (key !== "ну" || !options.verbatim) return false;
  const next = words.slice(index + 1).find((item) => item.kind === "word");
  const before =
    !previous ||
    previous.speaker !== word.speaker ||
    TRAILING_BREAK.test(previous.text.trim()) ||
    word.startSec - previous.endSec >= STANDALONE_PAUSE_SEC;
  const after =
    !next ||
    next.speaker !== word.speaker ||
    TRAILING_BREAK.test(word.text.trim()) ||
    next.startSec - word.endSec >= STANDALONE_PAUSE_SEC;
  return before && after;
}

/**
 * Local recogniser artefacts: `<unk>` tokens glued between words ("конференции<unk>Другая") and letters glued to
 * numbers ("of40.3", "Radio4", "in2021."). Parts become separate words that share the original span in
 * proportion to their length; a bare `<unk>` is dropped. All-caps codes such as "MP3" and "4K" stay whole.
 */
export function cleanAsrWords(words: RawWord[]): RawWord[] {
  return words.flatMap((word) => {
    const parts = word.text
      .split(/<unk>/giu)
      .flatMap((part, i, all) =>
        i < all.length - 1 && /^[\p{P}]*$/u.test(all[i + 1]!)
          ? [part + all[i + 1]!]
          : i > 0 && /^[\p{P}]*$/u.test(part)
            ? []
            : [part],
      )
      .flatMap((part) => part.split(/(?<=\p{L}*\p{Ll}{2})(?=\d)/u))
      .map((part) => part.trim())
      .filter((part) => /[\p{L}\p{N}]/u.test(part));
    if (parts.length === 1 && parts[0] === word.text) return [word];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    let cursor = word.startSec;
    return parts.map((part, i) => {
      const endSec =
        i === parts.length - 1 ? word.endSec : cursor + ((word.endSec - word.startSec) * part.length) / total;
      const piece = { ...word, text: part, startSec: cursor, endSec };
      cursor = endSec;
      return piece;
    });
  });
}

const safeId = (value: string) => {
  const id = value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/^[^a-zA-Z0-9]+/, "")
    .slice(0, 64);
  return id || "speaker";
};

/** Confidence in 0–1 from a natural-log probability; null when the engine gave none. */
export function confidenceFromLogprob(logprob: number | null | undefined): number | null {
  if (logprob === null || logprob === undefined || !Number.isFinite(logprob)) return null;
  return Math.min(1, Math.max(0, Math.exp(logprob)));
}

function sentencesOf(words: TranscriptWord[]): TranscriptSentence[] {
  const sentences: TranscriptSentence[] = [];
  let open: TranscriptWord[] = [];
  const close = () => {
    if (!open.length) return;
    const first = open[0]!,
      last = open.at(-1)!;
    sentences.push({
      id: `s${sentences.length + 1}`,
      firstWordId: first.id,
      lastWordId: last.id,
      text: open.map((word) => word.text).join(" "),
      startSec: first.startSec,
      endSec: Math.max(...open.map((word) => word.endSec)),
      speaker: first.speaker,
    });
    open = [];
  };
  const speech = words.filter((word) => word.kind !== "event");
  speech.forEach((word, i) => {
    open.push(word);
    const next = speech[i + 1];
    if (
      !next ||
      SENTENCE_END.test(word.text) ||
      next.speaker !== word.speaker ||
      next.startSec - word.endSec >= SENTENCE_PAUSE_SEC ||
      next.endSec - open[0]!.startSec > SENTENCE_MAX_SEC
    )
      close();
  });
  return sentences;
}

/** Ids, filler marks, speakers and sentences, validated against TranscriptSchema. */
export function buildTranscript(input: TranscriptInput): Transcript {
  const raw = input.words
    .map((word) => ({ ...word, text: word.text.trim(), speaker: word.speaker === null ? null : safeId(word.speaker) }))
    .filter((word) => word.text && Number.isFinite(word.startSec) && Number.isFinite(word.endSec))
    // Punctuation-only tokens ("..." where Scribe marks an interruption) are not speech.
    .filter((word) => word.kind === "event" || /[\p{L}\p{N}]/u.test(word.text))
    .map((word) => ({ ...word, startSec: Math.max(0, word.startSec), endSec: Math.max(0, word.startSec, word.endSec) }))
    .map((word, order) => ({ word, order }))
    .sort((a, b) => a.word.startSec - b.word.startSec || a.order - b.order)
    .map(({ word }) => word);
  const words: TranscriptWord[] = raw.map((word, i) => ({
    id: `w${i + 1}`,
    text: word.text,
    kind:
      word.kind === "event" || isBackchannel(word.text)
        ? "event"
        : isFiller(raw, i, { verbatim: input.engine.verbatim, language: input.language })
          ? "filler"
          : "word",
    startSec: round(word.startSec),
    endSec: round(word.endSec),
    speaker: word.speaker,
    channel: word.channel,
    confidence: word.confidence === null ? null : Math.round(word.confidence * 10000) / 10000,
  }));
  const speakers = [
    ...new Set(words.map((word) => word.speaker).filter((speaker): speaker is string => speaker !== null)),
  ].map((id) => ({ id }));
  return TranscriptSchema.parse({
    version: 1,
    source: input.source,
    engine: input.engine,
    language: normaliseLanguage(input.language),
    speakers,
    words,
    sentences: sentencesOf(words),
    ...(input.notes?.length ? { notes: input.notes } : {}),
  });
}

const round = (value: number) => Math.round(value * 1000) / 1000;

type ScribeWordRow = {
  text?: unknown;
  start?: unknown;
  end?: unknown;
  type?: unknown;
  speaker_id?: unknown;
  logprob?: unknown;
  channel_index?: unknown;
};
type ScribeChunk = {
  language_code?: unknown;
  language_probability?: unknown;
  words?: unknown;
  channel_index?: unknown;
  audio_duration_secs?: unknown;
};
export type ScribeResponse = ScribeChunk & { transcripts?: unknown; text?: unknown };

/**
 * Scribe JSON (single transcript or multichannel `transcripts[]`) to raw words. Spacing rows are dropped.
 * With multichannel audio each channel restarts speaker numbering, so ids become `ch0`, or `ch0-speaker_1`
 * when diarisation split a channel.
 */
export function scribeWords(
  response: ScribeResponse,
  options: { multichannel?: boolean } = {},
): { words: RawWord[]; language: string | null; durationSec: number | null; untimed: number } {
  const chunks = (Array.isArray(response.transcripts) ? response.transcripts : [response]) as ScribeChunk[];
  const words: RawWord[] = [];
  let untimed = 0;
  chunks.forEach((chunk, index) => {
    const chunkChannel =
      typeof chunk.channel_index === "number" ? chunk.channel_index : options.multichannel ? index : null;
    for (const row of (Array.isArray(chunk.words) ? chunk.words : []) as ScribeWordRow[]) {
      if (row.type === "spacing" || typeof row.text !== "string" || !row.text.trim()) continue;
      if (typeof row.start !== "number" || typeof row.end !== "number") {
        untimed++;
        continue;
      }
      const channel = typeof row.channel_index === "number" ? row.channel_index : chunkChannel;
      const speakerId = typeof row.speaker_id === "string" && row.speaker_id ? row.speaker_id : null;
      const speaker =
        options.multichannel && channel !== null
          ? speakerId
            ? `ch${channel}-${speakerId}`
            : `ch${channel}`
          : speakerId;
      words.push({
        text: row.text,
        startSec: row.start,
        endSec: row.end,
        kind: row.type === "audio_event" ? "event" : "word",
        speaker,
        channel,
        confidence: confidenceFromLogprob(typeof row.logprob === "number" ? row.logprob : null),
      });
    }
  });
  const first = chunks[0];
  const duration = [response.audio_duration_secs, first?.audio_duration_secs].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return {
    words,
    language: typeof first?.language_code === "string" ? first.language_code : null,
    durationSec: duration ?? null,
    untimed,
  };
}

/** Where `transcribe` keeps the paid response: `transcript.json` → `transcript.scribe.json`. */
export function scribeRawPath(outputPath: string): string {
  const parsed = path.parse(outputPath);
  return path.join(parsed.dir, `${parsed.ext === ".json" ? parsed.name : parsed.base}.scribe.json`);
}
