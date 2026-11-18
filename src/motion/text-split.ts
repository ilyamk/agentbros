const graphemeSegmenters = new Map<string, Intl.Segmenter>();

const graphemeSegmenter = (locale: string): Intl.Segmenter => {
  let segmenter = graphemeSegmenters.get(locale);
  if (!segmenter) {
    segmenter = new Intl.Segmenter(locale, { granularity: "grapheme" });
    graphemeSegmenters.set(locale, segmenter);
  }
  return segmenter;
};

/** Combined characters stay whole: и + U+0306 is one glyph. */
export const splitGraphemes = (text: string, locale = "ru"): string[] =>
  [...graphemeSegmenter(locale).segment(text)].map(({ segment }) => segment);

/** Runs of text between breaking spaces. Punctuation stays on its word; U+00A0 holds words together. */
export const splitWords = (text: string): string[] => text.split(/[^\S ]+/u).filter(Boolean);

export const splitLines = (text: string): string[] => text.split(/\r?\n/u).map((line) => line.trim());

export type Format = "vertical" | "square" | "landscape";

export const formatOf = (width: number, height: number): Format =>
  height > width ? "vertical" : height === width ? "square" : "landscape";

/** Line breaks set by hand for each format, because automatic wrapping breaks a composition. */
export type LineSet = { [K in Format]?: readonly string[] } & { fallback: readonly string[] };

export const linesFor = (set: LineSet, format: Format): readonly string[] => set[format] ?? set.fallback;

/** Room around a line that a mask must allow, in em, for Й Ё above and у р щ д below. */
export type MaskBleed = { top: number; bottom: number; side: number };

export const DEFAULT_MASK_BLEED: MaskBleed = { top: 0.28, bottom: 0.26, side: 0.12 };

/** How far a line must travel, in em, to sit wholly outside its mask, whatever the line-height. */
export const maskTravelEm = (lineHeight: number, bleed: MaskBleed = DEFAULT_MASK_BLEED): number =>
  lineHeight + bleed.top + bleed.bottom;

/** Weight of one glyph as a wave crosses the word; `position` is the wave's glyph index and may lie outside the word. */
export const glyphWeight = (index: number, position: number, spread: number, min: number, max: number): number => {
  const distance = Math.abs(index - position) / Math.max(spread, 0.0001);
  const eased = distance >= 1 ? 0 : 0.5 + 0.5 * Math.cos(distance * Math.PI);
  return min + (max - min) * eased;
};
