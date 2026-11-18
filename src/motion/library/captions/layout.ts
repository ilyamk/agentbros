import { z } from "zod";
import { buildCaptionPages, type CaptionPage, type CaptionWord } from "../../../lib/captions/pages";
import {
  CAPTION_UI_ZONES,
  captionBox,
  FRAME_SIZE,
  type Box,
  type CaptionFormat,
  type CaptionUiZone,
} from "../../../lib/captions/readability";
import type { Cue, SfxKind } from "../types";

export const captionWordSchema = z.object({
  text: z.string().min(1),
  /** Seconds on the caption's clock; `startOffsetSec` maps it to this block's frames. */
  start: z.number().min(0),
  end: z.number().min(0),
  emphasis: z.boolean().optional(),
  /** `event` words (laughter, music) are skipped; fillers render only if they are still in the edit. */
  kind: z.enum(["word", "filler", "event"]).optional(),
  emoji: z.string().optional(),
  /** Diarised speaker; pages break at every change. */
  speaker: z.string().nullable().optional(),
});

/** Props every caption preset shares. */
export const captionBaseShape = {
  words: z.array(captionWordSchema),
  /** Caption-clock seconds at this block's frame 0 (a clip that starts mid-transcript). */
  startOffsetSec: z.number().min(0),
  /** Words per page, 1–6: 1 shows one word at a time; 2–4 reads best for talking heads. */
  maxWords: z.number().int().min(1).max(6),
  /** Pages that would be on screen for less than this merge with a neighbour (never beyond `maxWords` at 1–2). */
  minPageSec: z.number().min(0).max(3),
  position: z.enum(["lower", "middle", "upper"]),
  /** `safe-zone` places the page inside the platform safe zone of the frame; `inline` fills its parent (a layout slot). */
  placement: z.enum(["safe-zone", "inline"]),
  /** The interface `safe-zone` keeps clear of on a vertical frame: `organic` (default) or a paid placement (`ad` is every platform's); written by `captions:place --placement ad`. */
  uiZone: z.enum(CAPTION_UI_ZONES).optional(),
  /** Multiplies the type size; the page still shrinks to fit the safe width. */
  textScale: z.number().min(0.6).max(1.6),
  /** BCP-47 language of the words, for upper-casing (Turkish i, German ß) and the connective-word list. */
  language: z.string().min(2),
  textColor: z.string(),
  accent: z.string(),
  /** Words to treat as key words besides those marked `emphasis` (case and punctuation ignored); an optional emoji rises over the page while one is spoken. */
  keywords: z.array(z.object({ word: z.string().min(1), emoji: z.string().optional() })),
};

export type CaptionBaseProps = {
  words: CaptionWord[];
  startOffsetSec: number;
  maxWords: number;
  minPageSec: number;
  position: "lower" | "middle" | "upper";
  placement: "safe-zone" | "inline";
  uiZone?: CaptionUiZone;
  textScale: number;
  language: string;
  textColor: string;
  accent: string;
  keywords: { word: string; emoji?: string }[];
};

/** Type metrics of one look, as shares of the frame's shorter side and of the em. */
export type CaptionMetrics = {
  /** Largest type size as a share of min(width, height). */
  fontShare: number;
  /** Average advance of a character in em, for the line budget; fitting measures the real width. */
  charWidthEm: number;
  lineHeight: number;
  uppercase: boolean;
  /** Horizontal padding each word carries, in em (a box behind the word). */
  wordPadEm: number;
  /** Largest scale of any word (the active pop, a key word); lines keep room for it. */
  activeScale: number;
  /** Lines a page may take. */
  maxLines?: number;
  /** Pages never exceed `maxWords`, even when merging a short page. */
  strictWords?: boolean;
};

/** Width left for a line when one word in it is scaled up: the scaled word is about 40% of a line. */
export const activeWidth = (width: number, activeScale: number) => width / (1 + (activeScale - 1) * 0.4);

export const formatFor = (width: number, height: number): CaptionFormat =>
  height > width ? "vertical" : height === width ? "square" : "landscape";

const scaleBox = (box: Box, k: number): Box => ({
  left: box.left * k,
  top: box.top * k,
  right: box.right * k,
  bottom: box.bottom * k,
});

export type CaptionPosition = "lower" | "middle" | "upper";

/** `box` is the box at the props' `position`; `boxes` holds all three, the same width, for pages placed elsewhere. */
export type CaptionLayout = {
  format: CaptionFormat;
  uiZone: CaptionUiZone;
  pages: CaptionPage[];
  box: Box;
  boxes: Record<CaptionPosition, Box>;
  padPx: number;
  maxFontPx: number;
  lineHeightPx: number;
  maxCharsPerLine: number;
};

/** Room inside the box for outline, shadow and the active word's pop, so none of them leaves the safe zone. */
export const PAD_PX = 44;

/**
 * Pages, the caption box and the type budget for one look, pure so tests and the readability check see exactly
 * what the block draws. `inline` uses the full parent width with a 6% margin instead of the safe zone.
 */
export const captionLayout = (
  p: CaptionBaseProps,
  metrics: CaptionMetrics,
  width: number,
  height: number,
): CaptionLayout => {
  const format = formatFor(width, height);
  const k = width / FRAME_SIZE[format].width;
  const maxFontPx = Math.min(width, height) * metrics.fontShare * p.textScale;
  const lineHeightPx = maxFontPx * metrics.lineHeight;
  const maxLines = metrics.maxLines ?? 2;
  const boxFor = (position: CaptionPosition): Box =>
    p.placement === "safe-zone"
      ? scaleBox(captionBox(format, position, lineHeightPx / k, Math.min(maxLines, 2), PAD_PX, p.uiZone), k)
      : { left: width * 0.06, right: width * 0.94, top: 0, bottom: height };
  const boxes = { lower: boxFor("lower"), middle: boxFor("middle"), upper: boxFor("upper") };
  const box = boxes[p.position];
  const usable = activeWidth(box.right - box.left, metrics.activeScale) - maxFontPx * metrics.wordPadEm * 4;
  const charEm = metrics.charWidthEm * (metrics.uppercase ? 1.15 : 1);
  const maxCharsPerLine = Math.max(6, Math.floor(usable / (maxFontPx * charEm)));
  const pages = buildCaptionPages(p.words, {
    maxWords: p.maxWords,
    minPageSec: p.minPageSec,
    maxCharsPerLine,
    maxLines: Math.min(maxLines, 2),
    strictWords: metrics.strictWords,
  });
  return {
    format,
    uiZone: p.uiZone ?? "organic",
    pages,
    box,
    boxes,
    padPx: p.placement === "safe-zone" ? PAD_PX * k : 0,
    maxFontPx,
    lineHeightPx,
    maxCharsPerLine,
  };
};

export const displayText = (text: string, uppercase: boolean, language: string) =>
  uppercase ? text.toLocaleUpperCase(language) : text;

const normalise = (text: string, language: string) => text.toLocaleLowerCase(language).replace(/[^\p{L}\p{N}]+/gu, "");

/** True when a word is a keyword: marked `emphasis`, or listed in `keywords` (case and punctuation ignored). */
export const keywordOf = (
  word: CaptionWord,
  keywords: readonly { word: string; emoji?: string }[],
  language: string,
): { emoji?: string } | null => {
  const listed = keywords.find((keyword) => normalise(keyword.word, language) === normalise(word.text, language));
  if (listed) return { emoji: listed.emoji ?? word.emoji };
  return word.emphasis ? { emoji: word.emoji } : null;
};

/** One cue per marked word, on the frame it is spoken, relative to the block's start. */
export const emphasisCues = (
  p: CaptionBaseProps,
  isKeyword: (word: CaptionWord) => boolean,
  sfx: SfxKind,
  weight: "hero" | "support",
  fps = 30,
): Cue[] =>
  p.words
    .filter((word) => word.kind !== "event" && word.end > word.start && isKeyword(word))
    .map((word) => ({
      frame: Math.max(0, Math.round((word.start - p.startOffsetSec) * fps)),
      kind: "hit" as const,
      sfx,
      weight,
      label: `"${word.text}" spoken`,
    }));
