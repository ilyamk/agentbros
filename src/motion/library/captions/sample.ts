import type { CaptionWord } from "../../../lib/captions/pages";

type Spoken = [text: string, seconds: number, pauseAfter?: number, emphasis?: boolean];

/** Evenly timed preview words: each entry is spoken for its seconds, then an optional pause. */
export const timedWords = (spoken: readonly Spoken[], from = 0.2): CaptionWord[] => {
  let at = from;
  return spoken.map(([text, seconds, pause = 0.04, emphasis]) => {
    const word: CaptionWord = {
      text,
      start: Math.round(at * 1000) / 1000,
      end: Math.round((at + seconds) * 1000) / 1000,
      ...(emphasis ? { emphasis: true } : {}),
    };
    at += seconds + pause;
    return word;
  });
};

export const SAMPLE_EN = timedWords([
  ["Most", 0.22],
  ["people", 0.3],
  ["quit", 0.42, 0.06, true],
  ["right", 0.24],
  ["before", 0.3],
  ["it", 0.12],
  ["works.", 0.5, 0.35, true],
  ["Here's", 0.26],
  ["the", 0.12],
  ["fix.", 0.55, 0.1, true],
]);

export const SAMPLE_RU = timedWords([
  ["Монтаж", 0.42],
  ["занимает", 0.44],
  ["пять", 0.3],
  ["минут,", 0.4, 0.2, true],
  ["а", 0.1],
  ["не", 0.14],
  ["пять", 0.3],
  ["часов.", 0.55, 0.3, true],
  ["Вот", 0.24],
  ["как.", 0.45],
]);
