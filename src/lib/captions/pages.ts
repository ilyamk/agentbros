import { createTikTokStyleCaptions, type Caption } from "@remotion/captions";
import type { Transcript } from "../../types/transcript";

/** One spoken word on a caption page, in seconds of the clock the caption plays on. */
export type CaptionWord = {
  text: string;
  start: number;
  end: number;
  emphasis?: boolean;
  kind?: "word" | "filler" | "event";
  /** Shown above the page while this word is active (keyword emphasis). */
  emoji?: string;
  /** Diarised speaker; a page never holds two speakers. */
  speaker?: string | null;
};

export type CaptionPage = {
  /** Seconds the page appears and leaves; `end` is held at least `minPageSec` where the next page allows. */
  start: number;
  end: number;
  words: CaptionWord[];
  /** Word indices per line, one or two lines. */
  lines: number[][];
};

export type PageOptions = {
  /**
   * Words per page, 1–6: 1 is single-word mode, 2–4 reads best on short-form. From 3 up a too-short page may merge
   * into one word over the limit; at 1 and 2 the limit is hard.
   */
  maxWords: number;
  /** Never merge a short page past `maxWords`, at any size (stacked pages, one word per line). */
  strictWords?: boolean;
  /** Characters per line before the page breaks into a second line. */
  maxCharsPerLine: number;
  maxLines: number;
  /** Pages shorter than this merge with a neighbour when the merged page still fits. */
  minPageSec: number;
  /** Tokens closer than this stay on one page (`createTikTokStyleCaptions`). */
  combineMs: number;
  /** A pause at least this long starts a new page. */
  breakOnSilenceMs: number;
  /** A page stays up this long after its last word unless the next page starts first. */
  holdSec: number;
};

export const DEFAULT_PAGE_OPTIONS: PageOptions = {
  maxWords: 3,
  maxCharsPerLine: 16,
  maxLines: 2,
  minPageSec: 0.8,
  combineMs: 1200,
  breakOnSilenceMs: 500,
  holdSec: 0.5,
};

const SENTENCE_END = /[.!?…]["»”)]*$/u;

/** Spoken words of a transcript; `event` tokens (laughter, music) never become captions, fillers stay when present. */
export const wordsFromTranscript = (transcript: Pick<Transcript, "words">): CaptionWord[] =>
  transcript.words
    .filter((word) => word.kind !== "event" && word.endSec > word.startSec && word.text.trim())
    .map((word) => ({
      text: word.text.trim(),
      start: word.startSec,
      end: word.endSec,
      kind: word.kind,
      ...(word.speaker ? { speaker: word.speaker } : {}),
    }));

/** Existing `voiceover/{scene}.words.json` or edited word files (`{ text, start, end, emphasis? }`). */
export const wordsFromAlignment = (
  words: readonly { text: string; start: number; end: number; emphasis?: boolean; kind?: string }[],
): CaptionWord[] =>
  words
    .filter((word) => word.kind !== "event" && word.end > word.start && word.text.trim())
    .map((word) => ({
      text: word.text.trim(),
      start: word.start,
      end: word.end,
      ...(word.emphasis ? { emphasis: true } : {}),
    }));

const chars = (words: readonly CaptionWord[]) =>
  words.reduce((sum, word, index) => sum + word.text.length + (index ? 1 : 0), 0);

/** One line if it fits, otherwise the two-line split with the shortest longer line. */
export const breakLines = (words: readonly CaptionWord[], maxCharsPerLine: number, maxLines = 2): number[][] => {
  const all = words.map((_, index) => index);
  if (words.length < 2 || maxLines < 2 || chars(words) <= maxCharsPerLine) return [all];
  let best = 1;
  let bestLongest = Infinity;
  for (let split = 1; split < words.length; split++) {
    const longest = Math.max(chars(words.slice(0, split)), chars(words.slice(split)));
    if (longest < bestLongest) [best, bestLongest] = [split, longest];
  }
  return [all.slice(0, best), all.slice(best)];
};

const fits = (words: readonly CaptionWord[], o: PageOptions) =>
  breakLines(words, o.maxCharsPerLine, o.maxLines).every(
    (line) => chars(line.map((i) => words[i]!)) <= o.maxCharsPerLine,
  );

/**
 * Caption pages from timed words: grouped by `createTikTokStyleCaptions` (time and silence), then split to
 * `maxWords` and the line budget, split after sentence ends and at every speaker change, and pages shorter than
 * `minPageSec` merged with a neighbour, never across a sentence end or a speaker change.
 */
export const buildCaptionPages = (input: readonly CaptionWord[], options: Partial<PageOptions> = {}): CaptionPage[] => {
  const o = { ...DEFAULT_PAGE_OPTIONS, ...options };
  const words = input.filter((word) => word.kind !== "event" && word.end > word.start && word.text.trim());
  if (!words.length) return [];
  // A hard break between two words: a sentence ends, or the diarised speaker changes.
  const hardBreak = (a: CaptionWord, b: CaptionWord | undefined) =>
    !!b && (SENTENCE_END.test(a.text) || (a.speaker ?? null) !== (b.speaker ?? null));
  const captions: Caption[] = words.map((word, index) => ({
    text: index === 0 ? word.text : ` ${word.text}`,
    startMs: word.start * 1000,
    endMs: word.end * 1000,
    timestampMs: null,
    confidence: null,
    pageBreakAfter: hardBreak(word, words[index + 1]),
  }));
  const { pages } = createTikTokStyleCaptions({
    captions,
    combineTokensWithinMilliseconds: o.combineMs,
    breakOnSilenceAfterMilliseconds: o.breakOnSilenceMs,
  });
  let cursor = 0;
  const groups: CaptionWord[][] = [];
  for (const page of pages) {
    const pageWords = words.slice(cursor, cursor + page.tokens.length);
    cursor += page.tokens.length;
    let current: CaptionWord[] = [];
    for (const word of pageWords) {
      if (current.length && (current.length >= o.maxWords || !fits([...current, word], o))) {
        groups.push(current);
        current = [];
      }
      current.push(word);
    }
    if (current.length) groups.push(current);
  }
  const startOf = (group: CaptionWord[]) => group[0]!.start;
  const mergeCap = o.maxWords >= 3 && !o.strictWords ? o.maxWords + 1 : o.maxWords;
  // Merge a page that cannot stay up for minPageSec into its neighbour, when the result still fits the lines.
  for (let index = 0; index < groups.length;) {
    const group = groups[index]!;
    const next = groups[index + 1];
    const room = (next ? startOf(next) : group.at(-1)!.end + o.holdSec) - startOf(group);
    if (room >= o.minPageSec) {
      index++;
      continue;
    }
    if (
      next &&
      !hardBreak(group.at(-1)!, next[0]) &&
      next.length + group.length <= mergeCap &&
      fits([...group, ...next], o)
    ) {
      groups.splice(index, 2, [...group, ...next]);
      continue;
    }
    const previous = groups[index - 1];
    if (
      previous &&
      !hardBreak(previous.at(-1)!, group[0]) &&
      previous.length + group.length <= mergeCap &&
      fits([...previous, ...group], o)
    ) {
      groups.splice(index - 1, 2, [...previous, ...group]);
      index--;
      continue;
    }
    index++;
  }
  return groups.map((group, index) => {
    const next = groups[index + 1];
    const start = startOf(group);
    const spokenEnd = group.at(-1)!.end;
    const wanted = Math.max(spokenEnd + o.holdSec, start + o.minPageSec);
    return {
      start,
      end: next ? Math.min(wanted, startOf(next)) : wanted,
      words: group,
      lines: breakLines(group, o.maxCharsPerLine, o.maxLines),
    };
  });
};

/** The page on screen at `time`, and the word being spoken (held through short gaps inside the page). */
export const pageAt = (
  pages: readonly CaptionPage[],
  time: number,
): { page: CaptionPage; pageIndex: number; activeIndex: number } | null => {
  const pageIndex = pages.findIndex((page) => time >= page.start && time < page.end);
  if (pageIndex < 0) return null;
  const page = pages[pageIndex]!;
  let activeIndex = -1;
  page.words.forEach((word, index) => {
    if (time >= word.start) activeIndex = index;
  });
  if (activeIndex >= 0 && time >= page.words[activeIndex]!.end && activeIndex === page.words.length - 1)
    activeIndex = -1;
  return { page, pageIndex, activeIndex };
};

export const pageText = (page: CaptionPage): string[] =>
  page.lines.map((line) => line.map((index) => page.words[index]!.text).join(" "));
