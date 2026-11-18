import { Easing, random } from "remotion";
import type { Curve } from "./timing";
import type { CaretKey } from "./type-track";

/**
 * Pure numbers under the typography modes and blocks built from the reference corpus's gaps (design-reference/gap-triage.md
 * rows A1-A11): print type, marquee rows, glyph to shape, caret extras, arrival tint, arc baseline, case flip, snap pill,
 * retype slot and roll-ups. No browser, so tests import this file directly. Frame counts are at 30 fps; references
 * measured at 60 fps (gojiberry) were converted by time.
 */

/** GSAP-named eases these modes use, as pure functions of 0..1 (power1.out = quad out, power2.out = cubic out). */
export const typeEases = {
  linear: (t: number) => t,
  "power1.out": (t: number) => 1 - (1 - t) ** 2,
  "power2.out": (t: number) => 1 - (1 - t) ** 3,
  "power3.out": (t: number) => 1 - (1 - t) ** 4,
  "power2.in": (t: number) => t ** 3,
  "circ.out": (t: number) => Math.sqrt(Math.max(0, 1 - (t - 1) ** 2)),
  "expo.out": (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  /** Front-loaded race: about 80% of the travel in the first quarter, then a creep into a dead stop. */
  front: Easing.bezier(0.05, 0.85, 0.15, 1) as Curve,
} satisfies Record<string, Curve>;
export type TypeEase = keyof typeof typeEases;

/** Clamped 0..1 of a window on a named ease. */
export const typeProgress = (frame: number, from: number, frames: number, ease: TypeEase = "linear"): number => {
  if (frames <= 0) return frame >= from ? 1 : 0;
  return typeEases[ease](Math.min(Math.max((frame - from) / frames, 0), 1));
};

/** Mix two #rrggbb colours (t 0 = a, 1 = b). Anything that is not 6-digit hex switches to `b` past t 0.5. */
export const mixHex = (a: string, b: string, t: number): string => {
  const parse = (c: string) =>
    /^#[0-9a-f]{6}$/i.test(c) ? [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16)) : null;
  const x = parse(a);
  const y = parse(b);
  const k = Math.min(Math.max(t, 0), 1);
  if (!x || !y) return k > 0.5 ? b : a;
  return `#${x
    .map((v, i) =>
      Math.round(v + (y[i]! - v) * k)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

// --- A4 caret extras: backspace by character, inline chips riding the caret ---

/**
 * Keys of a deletion by character from `text` down to `kept`, `rate` characters a frame on average (cashfree 20.4-20.9 s:
 * 1-2 a frame, so 1.5), one key a frame from `start`. Each key removes whole graphemes.
 */
export const backspaceByChar = (text: string, kept: string, start: number, rate: number): CaretKey[] => {
  const glyphs = [...text];
  const floor = [...kept].length;
  const keys: CaretKey[] = [];
  for (let k = 0; ; k++) {
    const left = Math.max(floor, glyphs.length - Math.round((k + 1) * rate));
    keys.push({ frame: start + k, text: glyphs.slice(0, left).join(""), kind: "delete" });
    if (left <= floor) break;
  }
  return keys;
};

export type CaretChip = {
  /** Characters typed when the chip appears at the end of the line. */
  at: number;
  /** Characters typed when it stops riding the caret and stays in the line; absent rides to the end. */
  park?: number;
};

export type ChipSlot = { riding: true } | { riding: false; after: number } | null;

/**
 * Where each chip sits once `typed` characters are on screen: null before it appears (or once deleted back past it);
 * riding while the caret pushes it (drawn after the last glyph); otherwise the character index it is parked after.
 * abdulah 17.1-19.4 s: a chip about 0.03 of the width sits just after the last glyph and each new glyph pushes it right;
 * the next word types after a parked chip.
 */
export const chipSlots = (typed: number, chips: readonly CaretChip[]): ChipSlot[] =>
  chips.map((chip) => {
    if (typed < chip.at) return null;
    if (chip.park === undefined || typed < chip.park) return { riding: true };
    return { riding: false, after: chip.park };
  });

// --- A5 arrival tint and corner dots ---

/**
 * Colour of a token `k = frame - start` frames after it appears: one tint a frame (motionfly 0-2 s: pale lilac,
 * raspberry, teal), then a linear settle from the last tint to `ink`, done `settle` frames after it appeared (motionfly
 * 5; ugc-app's cooling yellow 9). Before `start` and after the settle, `ink`.
 */
export const arrivalTint = (
  frame: number,
  start: number,
  tints: readonly string[],
  ink: string,
  settle: number,
): string => {
  const k = frame - start;
  if (k < 0 || tints.length === 0 || k >= settle) return ink;
  const steps = tints.length - 1;
  if (k < steps) return tints[k]!;
  return mixHex(tints[steps]!, ink, (k - steps) / Math.max(1, settle - steps));
};

/**
 * A value that follows a list of step changes, easing to each new target over `frames` (power2.out) from wherever it
 * was. motionfly's corner dots spread to the new text box over about 5 frames after each word.
 */
export const settleTrack = (
  frame: number,
  steps: readonly { frame: number; value: number }[],
  frames: number,
): number => {
  if (steps.length === 0) return 0;
  let value = steps[0]!.value;
  for (let i = 1; i < steps.length; i++) {
    const step = steps[i]!;
    if (frame < step.frame) break;
    value = value + (step.value - value) * typeProgress(frame, step.frame, frames, "power2.out");
  }
  return value;
};

// --- A7 arc baseline ---

export type ArcGlyph = { dx: number; dy: number; rotate: number };

/**
 * Offsets of glyphs set on a circular baseline that curves up at both ends, from their places on a straight line.
 * `widths` are advance widths in px; `bend` is the arc's whole angle in radians (0 is straight). Each glyph keeps its
 * arc length from the word's centre, so the word is the same length bent or straight.
 */
export const arcGlyphs = (widths: readonly number[], bend: number): ArcGlyph[] => {
  const total = widths.reduce((a, b) => a + b, 0);
  let edge = 0;
  return widths.map((w) => {
    const s = edge + w / 2 - total / 2;
    edge += w;
    if (Math.abs(bend) < 1e-6 || total <= 0) return { dx: 0, dy: 0, rotate: 0 };
    const radius = total / bend;
    const phi = s / radius;
    return { dx: radius * Math.sin(phi) - s, dy: -radius * (1 - Math.cos(phi)), rotate: (-phi * 180) / Math.PI };
  });
};

// --- A8 case flip ---

/** The other case of a glyph; a glyph with no case stays. */
export const otherCase = (glyph: string): string => {
  const upper = glyph.toLocaleUpperCase();
  return upper !== glyph ? upper : glyph.toLocaleLowerCase();
};

/**
 * How many glyphs have flipped by a frame: one in reading order every `step` frames from `at` (gojiberry 14.1-16.9 s at
 * 60 fps: a letter every 2-3 frames, the word in 9; at 30 fps about a frame a letter, the word in 4-5).
 */
export const caseFlipCount = (frame: number, at: number, step: number, count: number): number => {
  if (frame < at) return 0;
  return Math.min(count, Math.floor((frame - at) / Math.max(step, 1e-6)) + 1);
};

// --- A9 snap pill ---

export type PillGroup = { from: number; to: number };

/** Runs of consecutive marked tokens: the word groups a pill can hold. */
export const markedGroups = (marked: readonly boolean[]): PillGroup[] => {
  const groups: PillGroup[] = [];
  marked.forEach((on, i) => {
    if (!on) return;
    const last = groups.at(-1);
    if (last && last.to === i - 1) last.to = i;
    else groups.push({ from: i, to: i });
  });
  return groups;
};

/**
 * The pill's state: the group it holds (-1 before `at`) and how far it has opened (0..1). The first group opens empty
 * over `openFrames` (power2.out); every later group is a jump on its own frame, no tween (ugc-app 10.2-10.6 s, steps(1)).
 */
export const pillState = (
  frame: number,
  at: number,
  step: number,
  groups: number,
  openFrames: number,
): { group: number; open: number } => {
  if (groups === 0 || frame < at) return { group: -1, open: 0 };
  const group = Math.min(groups - 1, Math.floor((frame - at) / Math.max(step, 1)));
  return { group, open: group === 0 ? typeProgress(frame, at, openFrames, "power2.out") : 1 };
};

/** A centred word wrap: for each word its line and left edge, each line centred in `limit`. */
export const wrapCentred = (widths: readonly number[], gap: number, limit: number): { line: number; x: number }[] => {
  const lines: number[][] = [[]];
  let used = 0;
  widths.forEach((w, i) => {
    const current = lines.at(-1)!;
    if (current.length > 0 && used + gap + w > limit) {
      lines.push([i]);
      used = w;
    } else {
      current.push(i);
      used += (current.length > 1 ? gap : 0) + w;
    }
  });
  const out: { line: number; x: number }[] = [];
  lines.forEach((line, li) => {
    const span = line.reduce((sum, i) => sum + widths[i]!, 0) + gap * Math.max(0, line.length - 1);
    let x = (limit - span) / 2;
    for (const i of line) {
      out[i] = { line: li, x };
      x += widths[i]! + gap;
    }
  });
  return out;
};

// --- A10 retype slot ---

/**
 * A slot word replaced by selection and retyping (postiz 32.9-35.3 s): the word sits selected for `selectFrames` before
 * its swap; on the swap frame it clears and the next word types `lettersPerFrame` letters a frame (1 in the reference:
 * 7-8 frames for 7-8 letters); a swap every `hold` frames (55 in the reference).
 */
export const retypeSlotState = (
  frame: number,
  o: { at: number; hold: number; words: readonly string[]; selectFrames: number; lettersPerFrame: number },
): { index: number; text: string; selected: boolean; typing: boolean } => {
  const last = o.words.length - 1;
  const index = frame < o.at ? 0 : Math.min(last, Math.floor((frame - o.at) / o.hold));
  const word = [...(o.words[index] ?? "")];
  const swap = o.at + index * o.hold;
  const typed = index === 0 ? word.length : Math.min(word.length, Math.floor((frame - swap) * o.lettersPerFrame));
  const nextSwap = index < last ? o.at + (index + 1) * o.hold : Infinity;
  return {
    index,
    text: word.slice(0, typed).join(""),
    selected: frame >= nextSwap - o.selectFrames && frame < nextSwap,
    typing: typed < word.length,
  };
};

// --- A11 roll-ups ---

export const ROLLUP_CURVES = ["front", "linear", "power1.out", "power3.out"] as const;
export type RollupCurve = (typeof ROLLUP_CURVES)[number];

/**
 * The value on screen at a frame: `from` to `to` over `frames` on a curve, in whole units of 10^-decimals, a new value
 * every frame and no tween between digits. polymarket: a target figure front-loads (gauge 61% of the way by the 5th of
 * 20 frames, power3.out; a threshold power1.out), a running count is linear.
 */
export const rollupValue = (
  frame: number,
  o: { from: number; to: number; at: number; frames: number; curve: RollupCurve; decimals?: number },
): number => {
  const t = typeProgress(frame, o.at, o.frames, o.curve);
  const unit = 10 ** (o.decimals ?? 0);
  return Math.round((o.from + (o.to - o.from) * t) * unit) / unit;
};

/** A pill that grows from a dot over `dotFrames`, then stretches to full width (gojiberry 44.2 s: dot to a counted 100% in about 8 frames at 30 fps). */
export const pillGrow = (
  frame: number,
  at: number,
  dotFrames: number,
  stretchFrames: number,
): { dot: number; stretch: number } => ({
  dot: typeProgress(frame, at, dotFrames, "power2.out"),
  stretch: typeProgress(frame, at + dotFrames, stretchFrames, "power2.out"),
});

// --- A1 print type ---

/**
 * Share of the word revealed by a rising scan line (0 none, 1 all), even rate, drawn on `step`s (paper-style 46.6-47.9 s:
 * complete in about 32 frames, a new drawing every second frame, steps(16)).
 */
export const scanReveal = (frame: number, at: number, frames: number, step = 2): number => {
  if (frame < at) return 0;
  const held = at + Math.floor((frame - at) / Math.max(1, step)) * Math.max(1, step);
  return Math.min(1, (held - at + Math.max(1, step)) / Math.max(1, frames));
};

/**
 * A stamp from `from` times its size and `fromOpacity` to 1x solid over `frames` (paper-style 33.8 s: 2x faint to solid
 * in 4 frames, power2.in, no bounce).
 */
export const stampPose = (
  frame: number,
  at: number,
  frames: number,
  from = 2,
  fromOpacity = 0.3,
): { scale: number; opacity: number; visible: boolean } => {
  const t = typeProgress(frame, at, frames, "power2.in");
  return { scale: from + (1 - from) * t, opacity: fromOpacity + (1 - fromOpacity) * t, visible: frame >= at };
};

/** The frame shift after contact: seeded, decaying to rest over `frames` (paper-style: about 4 frames on every edge). */
export const joltOffset = (
  frame: number,
  contact: number,
  frames: number,
  amplitude: number,
  seed = "jolt",
): { x: number; y: number } => {
  const k = frame - contact;
  if (k < 0 || k >= frames || amplitude <= 0) return { x: 0, y: 0 };
  const decay = 1 - k / frames;
  return {
    x: (random(`${seed}-x-${k}`) * 2 - 1) * amplitude * decay,
    y: (random(`${seed}-y-${k}`) * 2 - 1) * amplitude * decay,
  };
};

export type Scrap = { face: number; colour: number; rotate: number; lift: number; clip: string; land: number };

/**
 * One torn paper scrap per glyph (paper-style 2.0-2.6 s): a seeded face and colour from the given counts, a rotation of
 * up to `tilt` degrees, a small baseline lift, a jagged clip polygon, and a landing frame `step` apart (2-3 frames in the
 * reference). Spaces get no scrap.
 */
export const scrapPlan = (
  glyphs: readonly string[],
  o: { at: number; step: number; faces: number; colours: number; tilt: number; seed: string },
): (Scrap | null)[] => {
  let n = 0;
  return glyphs.map((glyph, i) => {
    if (/\s/.test(glyph)) return null;
    const r = (k: string) => random(`${o.seed}-${i}-${k}`);
    const edge = (count: number, axis: "x" | "y", fixed: number, reverse: boolean) =>
      Array.from({ length: count }, (_, j) => {
        const along = ((reverse ? count - 1 - j : j) / (count - 1)) * 100;
        const jag = fixed === 0 ? r(`${axis}${j}`) * 7 : 100 - r(`${axis}${j}${fixed}`) * 7;
        return axis === "x" ? `${along.toFixed(1)}% ${jag.toFixed(1)}%` : `${jag.toFixed(1)}% ${along.toFixed(1)}%`;
      });
    const clip = `polygon(${[...edge(6, "x", 0, false), ...edge(5, "y", 100, false), ...edge(6, "x", 100, true), ...edge(5, "y", 0, true)].join(", ")})`;
    return {
      face: Math.floor(r("face") * o.faces) % Math.max(1, o.faces),
      colour: (Math.floor(r("colour") * o.colours) + i) % Math.max(1, o.colours),
      rotate: (r("rot") * 2 - 1) * o.tilt,
      lift: (r("lift") * 2 - 1) * 0.06,
      clip,
      land: Math.round(o.at + n++ * o.step),
    };
  });
};

/**
 * Ink level of a title that sits faint and snaps to full on `at` (paper-style 55.9 s: about 15% contrast, then black in
 * one frame), with the whole frame flickering for `flickerFrames` after (12 in the reference): returns the title's
 * opacity and a whole-frame brightness offset, -1..1, decaying to 0.
 */
export const inkIn = (
  frame: number,
  at: number,
  faint: number,
  flickerFrames: number,
  seed = "ink",
): { ink: number; flicker: number } => {
  if (frame < at) return { ink: faint, flicker: 0 };
  const k = frame - at;
  if (k >= flickerFrames) return { ink: 1, flicker: 0 };
  const decay = 1 - k / flickerFrames;
  const sign = k % 2 === 0 ? 1 : -1;
  return { ink: 1, flicker: sign * (0.4 + 0.6 * random(`${seed}-${k}`)) * decay };
};

// --- A2 marquee rows ---

export const MARQUEE_CURVES = ["expo.out", "circ.out", "linear"] as const;
export type MarqueeCurve = (typeof MARQUEE_CURVES)[number];

/**
 * Horizontal travel of the rows' common track in px: `distance` covered over `frames` on a curve (foren 8.1 s: enter
 * moving and brake to a near hold in about 25 frames, expo.out; cashfree 33.0 s: 0.43 of the width, circ.out), then a
 * constant `drift` px a frame so the hold never dies. A linear curve with `frames` 0 is a constant marquee.
 */
export const marqueeTravel = (
  frame: number,
  o: { at: number; frames: number; distance: number; curve: MarqueeCurve; drift: number },
): number => {
  const local = frame - o.at;
  if (o.frames <= 0) return local * o.drift;
  const t = typeProgress(frame, o.at, o.frames, o.curve);
  return o.distance * t + Math.max(0, local - o.frames) * o.drift;
};

/**
 * Left edges of the copies of a repeating row pattern of width `period` that cover [0, span], given the row's offset.
 * Each entry carries the copy index (negative to the left), so a block can colour the repeats.
 */
export const marqueeCopies = (offset: number, period: number, span: number): { x: number; copy: number }[] => {
  if (period <= 0) return [];
  const first = Math.floor(-offset / period) - 1;
  const out: { x: number; copy: number }[] = [];
  for (let copy = first; ; copy++) {
    const x = offset + copy * period;
    if (x > span) break;
    if (x + period >= 0) out.push({ x, copy });
  }
  return out;
};

/**
 * Scale and blur of an item by its distance from frame centre, `distance` as a share of the half width (0 at centre, 1 at
 * an edge): cashfree's centre tile about 1.3x; ugc-app's words sharp only near centre.
 */
export const focalAt = (
  distance: number,
  o: { scale: number; blur: number; radius: number },
): { scale: number; blur: number } => {
  const d = Math.min(1, Math.abs(distance) / Math.max(o.radius, 1e-6));
  const near = 1 - d;
  return { scale: 1 + (o.scale - 1) * near * near * (3 - 2 * near), blur: o.blur * d * d };
};

// --- A3 glyph to shape ---

export type GlyphShapeTiming = {
  /** Frame the word is on, whole. */
  at: number;
  /** Frames the word holds before it breaks (nowakdesign: 5). */
  hold: number;
  /** Frames the other letters scatter (4). */
  scatter: number;
  /** Frames they fade after the scatter (3). */
  fade: number;
  /** Frames the stroke stands alone and lengthens (6). */
  grow: number;
  /** Frames it rotates and extends to its full length, power2.out (6). */
  turn: number;
};

/**
 * Phases of nowakdesign's word-to-shape (3.0-3.9 s): hold, scatter, fade, the kept glyph's stem lengthening, then a
 * decelerating turn and extension. Each value is 0..1; `seam` is the frame the shape completes, where the next shot cuts.
 */
export const glyphShapePhases = (frame: number, t: GlyphShapeTiming) => {
  const breakAt = t.at + t.hold;
  const fadeAt = breakAt + t.scatter;
  const growAt = fadeAt + t.fade;
  const turnAt = growAt + t.grow;
  return {
    scatter: typeProgress(frame, breakAt, t.scatter, "power2.out"),
    fade: typeProgress(frame, fadeAt, t.fade, "linear"),
    grow: typeProgress(frame, growAt, t.grow, "power2.out"),
    turn: typeProgress(frame, turnAt, t.turn, "power2.out"),
    seam: turnAt + t.turn,
  };
};

/** Seeded scatter of glyph `i` in em: mostly vertical, a little sideways (nowakdesign F95-F98). */
export const scatterOffset = (i: number, seed: string): { x: number; y: number } => ({
  x: (random(`${seed}-sx-${i}`) * 2 - 1) * 0.15,
  y: (random(`${seed}-sy-${i}`) * 2 - 1) * 0.9,
});
