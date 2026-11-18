/**
 * Pure-TS caption editing: filler-word removal and emphasis marking.
 *
 * Exported as a reusable library so the edit-captions CLI script and the
 * caption-editor agent can both import the core logic directly.
 */

import type { WordAlignment } from "../elevenlabs/tts";
import type { EditedWord } from "../../types/pipeline";

// ---------------------------------------------------------------------------
// Filler lists
// ---------------------------------------------------------------------------

const FILLERS: Record<string, string[]> = {
  en: ["um", "uh", "er", "like", "you know", "kinda", "sorta", "basically", "actually", "literally"],
  ru: ["эээ", "ну", "вот", "типа", "короче", "значит", "как бы"],
  es: ["em", "eh", "pues"],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip punctuation and lower-case a word for matching. */
function normalise(text: string): string {
  return text
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Build a set of normalised filler strings for the given language.
 * Falls back to English if the language code is not recognised.
 */
function buildFillerSet(language: string): Set<string> {
  const lang = language.split("-")[0].toLowerCase();
  const list = FILLERS[lang] ?? FILLERS["en"];
  return new Set(list.map((f) => f.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type EditCaptionsOptions = {
  language?: string;
  /** Words (or their normalised forms) that should receive emphasis. */
  emphasisTerms?: string[];
};

export type EditCaptionsResult = {
  words: EditedWord[];
  droppedFillers: string[];
};

/**
 * Apply filler removal and emphasis marking to a raw word-alignment array.
 *
 * - Fillers (language-specific list) are dropped and reported in `droppedFillers`.
 * - Up to 3 words per call receive `emphasis: true`:
 *     1. Words whose normalised form appears in `emphasisTerms`
 *     2. Words that are fully UPPER-CASE in the original text (user stress markers)
 *
 * @param rawWords     - WordAlignment[] as produced by ElevenLabs forced alignment.
 * @param options      - Language, optional extra emphasis terms.
 */
export function editSceneCaptions(rawWords: WordAlignment[], options: EditCaptionsOptions = {}): EditCaptionsResult {
  const language = options.language ?? "en";
  const fillerSet = buildFillerSet(language);

  const normalisedEmphasisTerms: Set<string> = new Set((options.emphasisTerms ?? []).map(normalise));

  const droppedFillers: string[] = [];
  const kept: Array<{ word: WordAlignment; isAllCaps: boolean }> = [];

  for (const word of rawWords) {
    const norm = normalise(word.text);

    if (fillerSet.has(norm)) {
      droppedFillers.push(word.text);
      continue;
    }

    // Detect user stress marker: fully upper-case original (e.g. "FAST")
    const stripped = word.text.replace(/[^\p{L}]/gu, "");
    const isAllCaps = stripped.length > 0 && stripped === stripped.toUpperCase();

    kept.push({ word, isAllCaps });
  }

  // Collect candidate emphasis indices (deduplicated, capped at 3)
  const emphasisIndices = new Set<number>();

  for (let i = 0; i < kept.length && emphasisIndices.size < 3; i++) {
    const { word, isAllCaps } = kept[i];
    const norm = normalise(word.text);

    const matchesExtra = normalisedEmphasisTerms.size > 0 && normalisedEmphasisTerms.has(norm);
    const matchesCaps = isAllCaps;

    if (matchesExtra || matchesCaps) {
      emphasisIndices.add(i);
    }
  }

  const words: EditedWord[] = kept.map(({ word }, idx) => ({
    text: word.text,
    start: word.start,
    end: word.end,
    emphasis: emphasisIndices.has(idx),
  }));

  return { words, droppedFillers };
}
