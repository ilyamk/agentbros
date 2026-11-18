// Measurable "AI-slop" signatures: the lists and thresholds motion:check and the project lint read.
// Each is a default a generated film falls into, not a ban: an intended use goes in motion:check's --allow with a reason.
// Catalogue with sources and fixes: design-reference/slop-catalogue.md.

import type { Occurrence } from "./findings";
import type { MeasuredText, PageMeasurement } from "./page-measure";

/** Emoji drawn as pictures, plus a text-style pictograph forced to emoji with VS16. ©, ®, ™ and arrows are not emoji here. */
export const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}️|[\u{1F1E6}-\u{1F1FF}]{2}/u;

export const hasEmoji = (text: string): boolean => EMOJI.test(text);

/** The purple-blue band of the default AI gradient. */
// provisional: recalibrated from ref:corpus
export const SLOP_HUE = { min: 230, max: 290 } as const;
// provisional: recalibrated from ref:corpus
export const SLOP_MIN_SATURATION = 0.4;
/** Too dark or too light to read as a hue. */
const LIGHTNESS = { min: 0.12, max: 0.9 } as const;
/** A backdrop blur at or above this many pixels is a frosted-glass card. */
// provisional: recalibrated from ref:corpus
export const GLASS_BLUR_PX = 4;

export type Rgb = { r: number; g: number; b: number; a: number };

/** HSL of an sRGB colour: hue in degrees, saturation and lightness 0-1. */
export function hsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === red
      ? ((green - blue) / d + (green < blue ? 6 : 0)) * 60
      : max === green
        ? ((blue - red) / d + 2) * 60
        : ((red - green) / d + 4) * 60;
  return { h, s, l };
}

export function inSlopBand(colour: Rgb): boolean {
  const { h, s, l } = hsl(colour);
  return h >= SLOP_HUE.min && h <= SLOP_HUE.max && s > SLOP_MIN_SATURATION && l >= LIGHTNESS.min && l <= LIGHTNESS.max;
}

/** Colours written as rgb()/rgba() (Chrome's computed form) or #hex. Anything else (oklch, color(), names) is skipped, not guessed. */
export function parseColours(value: string): Rgb[] {
  const colours: Rgb[] = [];
  for (const match of value.matchAll(
    /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)|#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi,
  )) {
    if (match[5]) {
      const hex = match[5].length <= 4 ? [...match[5]].map((digit) => digit + digit).join("") : match[5];
      colours.push({
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      });
      continue;
    }
    const alpha =
      match[4] === undefined ? 1 : match[4].endsWith("%") ? Number(match[4].slice(0, -1)) / 100 : Number(match[4]);
    colours.push({ r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: alpha });
  }
  return colours;
}

/** A linear or radial gradient whose visible stops (at least two) all sit in the purple-blue band. */
export function isSlopGradient(value: string): boolean {
  if (!/(?:linear|radial)-gradient\(/i.test(value)) return false;
  const stops = parseColours(value).filter((colour) => colour.a > 0.05);
  return stops.length >= 2 && stops.every(inSlopBand);
}

/** Pixels of the largest blur() in a backdrop-filter, or 0. */
export function backdropBlurPx(value: string): number {
  return Math.max(0, ...[...value.matchAll(/blur\(\s*([\d.]+)px\s*\)/gi)].map((match) => Number(match[1])));
}

// --- Composition over sampled frames ---

/** A text block's centre within this share of the stage width of the centre counts as centred. */
// provisional: recalibrated from ref:corpus
export const CENTRE_TOLERANCE = 0.06;
/** Above this share of text-bearing frames with every block centred, the layout never leaves the middle. */
// provisional: recalibrated from ref:corpus
export const CENTRED_FRAME_SHARE = 0.85;
/** Fewer text-bearing frames than this say nothing about a habit. */
export const MIN_TEXT_FRAMES = 4;

export type Box = { x: number; y: number; width: number; height: number };

export function isCentred(box: Box, stageWidth: number): boolean {
  return Math.abs(box.x + box.width / 2 - stageWidth / 2) <= CENTRE_TOLERANCE * stageWidth;
}

/** Share of text-bearing frames in which every text block is centred; null below MIN_TEXT_FRAMES. */
export function centredShare(
  frames: Box[][],
  stageWidth: number,
): { share: number | null; textFrames: number; centredFrames: number } {
  const withText = frames.filter((boxes) => boxes.length > 0);
  const centredFrames = withText.filter((boxes) => boxes.every((box) => isCentred(box, stageWidth))).length;
  return {
    share: withText.length < MIN_TEXT_FRAMES ? null : centredFrames / withText.length,
    textFrames: withText.length,
    centredFrames,
  };
}

/** Opacity above which an element has started to enter. */
export const ONSET_OPACITY = 0.05;
/** At least this many elements entering together, the same way, is a block dropped in rather than a hierarchy. */
// provisional: recalibrated from ref:corpus
export const SIMULTANEOUS_MIN = 3;
const SAME_OPACITY = 0.08;
const SAME_SHIFT_PX = 3;
const SAME_SCALE = 0.03;
/** At or above this opacity, still and unscaled, an element was cut in, not animated in. */
const CUT_IN_OPACITY = 0.95;

/** One sampled state of one element: its opacity and box. */
export type ElementSample = {
  opacity: number;
  box: Box;
  /** What fades it on this frame; elements sharing one enter as one. */ mover?: number | string | null;
};
/** An element's samples by frame; a missing frame means it was not visible. */
export type ElementTrack = Map<number, ElementSample>;

type Shape = {
  key: string;
  mover: number | string;
  opacity: number;
  rise: number;
  dx: number;
  dy: number;
  scale: number;
};

function entryShape(key: string, onset: ElementSample, next: ElementSample | undefined): Shape {
  const after = next ?? onset;
  return {
    key,
    mover: onset.mover ?? key,
    opacity: onset.opacity,
    rise: after.opacity - onset.opacity,
    dx: after.box.x + after.box.width / 2 - (onset.box.x + onset.box.width / 2),
    dy: after.box.y + after.box.height / 2 - (onset.box.y + onset.box.height / 2),
    scale: onset.box.width > 0 ? after.box.width / onset.box.width : 1,
  };
}

const sameShape = (a: Shape, b: Shape) =>
  Math.abs(a.opacity - b.opacity) <= SAME_OPACITY &&
  Math.abs(a.rise - b.rise) <= SAME_OPACITY &&
  Math.abs(a.dx - b.dx) <= SAME_SHIFT_PX &&
  Math.abs(a.dy - b.dy) <= SAME_SHIFT_PX &&
  Math.abs(a.scale - b.scale) <= SAME_SCALE;

/**
 * Groups of at least SIMULTANEOUS_MIN elements that start entering on the same sampled frame with the same shape: the same partial opacity there,
 * and the same opacity rise, shift and scale by the next sample. Elements already visible on the first frame, and elements cut in whole, are not
 * entrances. Staggered entrances differ in opacity at a shared sample, so this works on every-Nth-frame sampling too.
 */
export function simultaneousEntries(
  tracks: Map<string, ElementTrack>,
  frames: number[],
): { frame: number; keys: string[] }[] {
  const ordered = [...frames].sort((a, b) => a - b);
  const byFrame = new Map<number, Shape[]>();
  for (const [key, track] of tracks) {
    const index = ordered.findIndex((frame) => (track.get(frame)?.opacity ?? 0) > ONSET_OPACITY);
    if (index <= 0) continue;
    const frame = ordered[index]!;
    const shape = entryShape(key, track.get(frame)!, track.get(ordered[index + 1]!));
    const cutIn =
      shape.opacity >= CUT_IN_OPACITY &&
      Math.abs(shape.dx) <= SAME_SHIFT_PX &&
      Math.abs(shape.dy) <= SAME_SHIFT_PX &&
      Math.abs(shape.scale - 1) <= SAME_SCALE;
    if (!cutIn) byFrame.set(frame, [...(byFrame.get(frame) ?? []), shape]);
  }
  const groups: { frame: number; keys: string[] }[] = [];
  for (const [frame, shapes] of [...byFrame].sort((a, b) => a[0] - b[0])) {
    const clusters: Shape[][] = [];
    for (const shape of shapes) {
      const cluster = clusters.find((members) => sameShape(members[0]!, shape));
      if (cluster) cluster.push(shape);
      else clusters.push([shape]);
    }
    for (const cluster of clusters)
      if (new Set(cluster.map((shape) => shape.mover)).size >= SIMULTANEOUS_MIN)
        groups.push({ frame, keys: cluster.map((shape) => shape.key) });
  }
  return groups;
}

// --- motion:check occurrences ---

const quote = (text: string) => `"${text.length > 40 ? `${text.slice(0, 37)}...` : text}"`;

/** Per frame: emoji in visible text, purple-blue gradients and frosted-glass backdrops. */
export function slopFrameOccurrences(
  frame: number,
  measurement: Pick<PageMeasurement, "texts"> & Partial<Pick<PageMeasurement, "gradients" | "backdrops">>,
): Occurrence[] {
  const found: Occurrence[] = [];
  for (const item of measurement.texts)
    if (hasEmoji(item.text))
      found.push({
        code: "EMOJI_TEXT",
        frame,
        key: item.text,
        message: `Emoji in on-screen text ${quote(item.text)} (${item.label}).`,
        fix: "Replace the emoji with a word, an icon drawn in the film's own system, or nothing: emoji read as a template and render differently per platform.",
        text: [item.text],
        elements: item.names,
      });
  for (const style of measurement.gradients ?? [])
    if (isSlopGradient(style.value))
      found.push({
        code: "SLOP_PALETTE",
        frame,
        key: `gradient ${style.label} ${style.value}`,
        message: `${style.label} is filled with a purple-blue gradient (${style.value.slice(0, 120)}), the default AI palette.`,
        fix: "Take the palette from the brand or the reference (design.json). If a gradient is needed, run it within the brand's own hue or across hue families, not violet to blue.",
        elements: [style.label],
      });
  for (const style of measurement.backdrops ?? [])
    if (backdropBlurPx(style.value) >= GLASS_BLUR_PX)
      found.push({
        code: "SLOP_PALETTE",
        frame,
        key: `glass ${style.label}`,
        message: `${style.label} is a frosted-glass card: backdrop-filter ${style.value}.`,
        fix: "Drop the glass card. Separate the layer with scale, a solid plane of the palette, a hard shadow or space, not a blur behind it.",
        elements: [style.label],
      });
  return found;
}

export type SampledText = { frame: number; texts: MeasuredText[] };

const unionBox = (texts: MeasuredText[]): Box => {
  const lines = texts.flatMap((item) => item.lines);
  const left = Math.min(...lines.map((line) => line.x));
  const top = Math.min(...lines.map((line) => line.y));
  return {
    x: left,
    y: top,
    width: Math.max(...lines.map((line) => line.x + line.width)) - left,
    height: Math.max(...lines.map((line) => line.y + line.height)) - top,
  };
};

/** Text blocks on one frame: each block's union box, highest opacity and fader. */
function blocksOf(texts: MeasuredText[]): Map<string, ElementSample> {
  const grouped = new Map<string, MeasuredText[]>();
  for (const item of texts) if (item.lines.length) grouped.set(item.block, [...(grouped.get(item.block) ?? []), item]);
  return new Map(
    [...grouped].map(([key, items]) => [
      key,
      {
        opacity: Math.max(...items.map((item) => item.opacity)),
        box: unionBox(items),
        mover: items.find((item) => item.fader !== null)?.fader ?? null,
      },
    ]),
  );
}

/** Over the whole walk: blocks entering together the same way, and a layout that never leaves the centre line. */
export function slopFilmOccurrences(samples: SampledText[], stage: { width: number }): Occurrence[] {
  const found: Occurrence[] = [];
  const tracks = new Map<string, ElementTrack>();
  const settled: Box[][] = [];
  for (const { frame, texts } of samples) {
    const blocks = blocksOf(texts);
    for (const [key, sample] of blocks) {
      const track = tracks.get(key) ?? new Map<number, ElementSample>();
      track.set(frame, sample);
      tracks.set(key, track);
    }
    settled.push([...blocks.values()].filter((block) => block.opacity >= 0.5).map((block) => block.box));
  }
  const name = (key: string) => key.split("|").slice(1).join("|") || key;
  for (const group of simultaneousEntries(
    tracks,
    samples.map((sample) => sample.frame),
  ))
    found.push({
      code: "SIMULTANEOUS_ENTRY",
      frame: group.frame,
      key: [...group.keys].sort().join("\u0000"),
      message: `${group.keys.length} elements start entering on frame ${group.frame} with the same opacity and motion: ${group.keys
        .slice(0, 5)
        .map((key) => quote(name(key)))
        .join(", ")}.`,
      fix: "Give the entrance an order: lead with the element that matters, then stagger the rest by 3-6 frames or give them a different move, so the eye is told where to look first.",
      text: group.keys.map(name),
    });
  const centred = centredShare(settled, stage.width);
  if (centred.share !== null && centred.share > CENTRED_FRAME_SHARE) {
    const all = samples.flatMap((sample) => sample.texts);
    const aligned = all.filter((item) => item.align === "center").length / Math.max(1, all.length);
    found.push({
      code: "TEXT_CENTRED_ALWAYS",
      frame: samples.find((sample) => sample.texts.length)!.frame,
      key: "centred",
      message: `Every text block sits on the vertical centre line in ${centred.centredFrames} of ${centred.textFrames} text-bearing frames (${Math.round(centred.share * 100)}%; ${Math.round(aligned * 100)}% of text nodes are text-align: center).`,
      fix: "Break the centre axis: set type to a grid edge, a third or against the subject in some shots, and keep centring for the moments that need it.",
    });
  }
  return found;
}
