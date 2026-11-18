/**
 * Pure numbers for the background blocks from the reference corpus: word-backdrop (rings, tiles, ghost word, countdown),
 * material-fill (brushed metal, embossed maze, the growing tile), liquid-light (a corner glow with a dark core and a
 * refractive rim) and spotlight-studio's brand-colour sweep. No JSX and no browser: tests import this file directly.
 * Every value is a function of the frame and, where it varies, of a seed.
 *
 * Measured in design-reference/library/<id>/techniques.json: polymarket field-backdrops (6-12% contrast, always moving),
 * foren countdown-behind-word (steps on frames 0, 2, 4, 7, 11 to zero, glow, hold 13 f), flame guide-frame-opens-to-object
 * (tile 6% to 20% of the width in ~10 f) and implode-and-blur (maze ground fades in under the last wisp), ugc-app
 * corner-liquid-light (grows ~0.57 s from the bottom-right corner), cashfree screen-pulls-back-to-device (sweep #A7E4C0 to
 * #053618, frame to 47% in 0.46 s, power3.out).
 */
import { noise3D } from "@remotion/noise";
import { random } from "remotion";
import { familyProgress } from "../../ease-family";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

// --- word-backdrop ---

/** polymarket field-backdrops: the layer sits 6-12% off the ground; the default is the middle of that range. */
export const BACKDROP_CONTRAST = 0.09;

export type Ring = { radius: number; alpha: number };

/**
 * Concentric rings expanding from the centre without end: ring i is `i / count` of a period ahead. `radius` is a share of
 * `maxRadius` units; `alpha` fades in near the centre and out at the edge so no ring pops.
 */
export const ringField = (
  frame: number,
  { count = 6, period = 90, maxRadius = 1 }: { count?: number; period?: number; maxRadius?: number } = {},
): Ring[] =>
  Array.from({ length: count }, (_, i) => {
    const phase = (((frame / period + i / count) % 1) + 1) % 1;
    const alpha = Math.min(1, phase / 0.15) * Math.min(1, (1 - phase) / 0.35);
    return { radius: phase * maxRadius, alpha: clamp01(alpha) };
  }).sort((a, b) => a.radius - b.radius);

/**
 * A grid of tiles lit at seeded random: each tile keeps its state for `hold` frames, on its own seeded offset so tiles
 * never all change together. `lit` is the share of tiles on at once. Returns 0..1 per tile (row-major), eased over 2 frames.
 */
export const tileFlicker = (
  frame: number,
  {
    columns,
    rows,
    seed,
    hold = 8,
    lit = 0.18,
  }: { columns: number; rows: number; seed: string; hold?: number; lit?: number },
): number[] =>
  Array.from({ length: columns * rows }, (_, i) => {
    const offset = Math.floor(random(`${seed}-offset-${i}`) * hold);
    const bucket = Math.floor((frame + offset) / hold);
    const on = (b: number) => (random(`${seed}-${i}-${b}`) < lit ? 1 : 0);
    const into = (frame + offset) % hold;
    const now = on(bucket);
    const before = on(bucket - 1);
    return into >= 2 ? now : before + ((now - before) * (into + 1)) / 3;
  });

/** foren countdown-behind-word: the numeral steps on these frames after the block starts, slowing (2, 2, 3, 4). */
export const FOREN_COUNTDOWN_STEPS = [0, 2, 4, 7, 11] as const;
/** Frames the zero glows and holds before the cut out. */
export const FOREN_COUNTDOWN_HOLD = 13;

/** Values shown on each step, from `from` down to 0, spaced evenly and rounded: 4 -> 4 3 2 1 0, 10 -> 10 8 5 3 0. */
export const countdownValues = (from: number, steps: number): number[] =>
  Array.from({ length: steps }, (_, k) => (steps === 1 ? 0 : Math.round(from * (1 - k / (steps - 1)))));

export type CountdownState = { value: number | null; step: number; glow: number };

/**
 * The numeral at a frame: null before the first step; `glow` rises over 3 frames once it reaches zero and stays for the
 * hold, so the zero reads as an arrival.
 */
export const countdownAt = (
  frame: number,
  {
    at = 0,
    steps = FOREN_COUNTDOWN_STEPS as readonly number[],
    from = 4,
  }: { at?: number; steps?: readonly number[]; from?: number } = {},
): CountdownState => {
  const local = frame - at;
  let step = -1;
  for (let k = 0; k < steps.length; k++) if (local >= steps[k]!) step = k;
  if (step < 0) return { value: null, step: -1, glow: 0 };
  const values = countdownValues(from, steps.length);
  const last = steps[steps.length - 1]!;
  const glow = step === steps.length - 1 ? clamp01((local - last + 1) / 3) : 0;
  return { value: values[step]!, step, glow };
};

// --- material-fill ---

/**
 * A narrow specular band crossing the material: 0..1 across the diagonal, one pass every `period` frames, eased in and
 * out so it slows at the edges like a reflection of a fixed softbox on a turning surface.
 */
export const specularBand = (
  frame: number,
  { period = 75, offset = 0 }: { period?: number; offset?: number } = {},
): number => {
  const phase = ((((frame + offset) / period) % 1) + 1) % 1;
  return -0.25 + 1.5 * (0.5 - Math.cos(Math.PI * phase) / 2);
};

export type Segment = { x1: number; y1: number; x2: number; y2: number };

/**
 * A seeded maze in a `columns` x `rows` grid of unit cells: each cell draws one wall, horizontal or vertical, on one of
 * its sides (the 10 PRINT pattern on a square grid). Coordinates are in cells.
 */
export const mazeSegments = (seed: string, columns: number, rows: number): Segment[] => {
  const out: Segment[] = [];
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < columns; x++) {
      const r = random(`${seed}-${x}-${y}`);
      if (r < 0.5) out.push({ x1: x, y1: y + (r < 0.25 ? 0 : 1), x2: x + 1, y2: y + (r < 0.25 ? 0 : 1) });
      else out.push({ x1: x + (r < 0.75 ? 0 : 1), y1: y, x2: x + (r < 0.75 ? 0 : 1), y2: y + 1 });
    }
  return out;
};

/** flame guide-frame-opens-to-object: the tile grows from 6% to 20% of the frame width in about 10 frames. */
export const FLAME_TILE = { from: 0.06, to: 0.2, frames: 10 } as const;

/** Tile width as a share of the frame width; power2.out (the strip shows a fast start that settles). */
export const tileGrow = (
  frame: number,
  {
    at = 0,
    frames = FLAME_TILE.frames,
    from = FLAME_TILE.from,
    to = FLAME_TILE.to,
  }: { at?: number; frames?: number; from?: number; to?: number } = {},
): number => {
  const t = clamp01((frame - at) / frames);
  return from + (to - from) * (1 - (1 - t) ** 3);
};

// --- liquid-light ---

/** ugc-app corner-liquid-light: grows over about 17 frames (0.57 s) and was still growing when the file ended. */
export const UGC_LIQUID_FRAMES = 17;

/** Radius of the glow as a share of the frame diagonal: expo.out growth to `size`, then a slow breathing swell. */
export const liquidRadius = (
  frame: number,
  { at = 0, frames = UGC_LIQUID_FRAMES, size = 0.42 }: { at?: number; frames?: number; size?: number } = {},
): number => {
  if (frame < at) return 0;
  const grow = familyProgress(frame, at, frames, "expo.out");
  const swell = 1 + 0.06 * Math.sin(Math.max(0, frame - at - frames) / 22);
  return size * grow * swell;
};

/**
 * Light at a point, in channel intensities 0..1. `d` is the distance from the corner as a share of the diagonal, `angle`
 * the direction from the corner (radians), `r` the current radius. The core inside the rim is dark; the rim is a soft band
 * whose radius differs slightly per channel (red outside, blue inside), the refractive fringe; noise bends the band.
 */
export const liquidLight = (
  d: number,
  angle: number,
  r: number,
  t: number,
  seed: string,
  rim = 0.06,
): [number, number, number] => {
  if (r <= 0) return [0, 0, 0];
  const warp = noise3D(`${seed}-warp`, Math.cos(angle) * 1.6, Math.sin(angle) * 1.6, t * 0.35) * 0.09 * r;
  const dd = d + warp;
  const band = (radius: number, width: number) => Math.exp(-(((dd - radius) / width) ** 2));
  const w = rim * Math.max(0.35, r / 0.42);
  const red = band(r * 1.035, w);
  const green = band(r, w * 0.95);
  const blue = band(r * 0.965, w * 1.1);
  const halo = 0.35 * Math.exp(-(((dd - r) / (w * 3.2)) ** 2));
  const inner =
    0.25 *
    Math.exp(-(((dd - r * 0.62) / (w * 0.7)) ** 2)) *
    (0.5 + 0.5 * noise3D(`${seed}-inner`, angle * 2, 0, t * 0.5));
  // Brighter along part of the arc, so it reads as a crescent of caustic light rather than a ring.
  const along = 0.4 + 0.6 * (0.5 + 0.5 * noise3D(`${seed}-along`, angle * 1.3, 0, t * 0.2));
  return [
    clamp01((red + halo) * along),
    clamp01((green + halo + inner * 0.6) * along),
    clamp01((blue + halo + inner) * along),
  ];
};

// --- spotlight-studio tint ---

const channels = (hex: string): [number, number, number] => {
  const body = hex.replace("#", "");
  const full = body.length === 3 ? [...body].map((c) => c + c).join("") : body.slice(0, 6);
  const v = Number.parseInt(full, 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
};

/** `a` mixed towards `b` by `t`, as #rrggbb. */
export const mixHex = (a: string, b: string, t: number): string => {
  const ca = channels(a);
  const cb = channels(b);
  return `#${ca
    .map((c, i) =>
      Math.round(c + (cb[i]! - c) * clamp01(t))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
};

/**
 * cashfree's brand-colour studio: the sweep lit from above in a pale tint of the brand colour, falling to a deep shade on
 * the floor (#A7E4C0 to #053618 for a green brand), instead of a dark ground.
 */
export const tintedSweep = (tint: string) => ({
  top: mixHex(tint, "#ffffff", 0.55),
  wall: mixHex(tint, "#ffffff", 0.2),
  floor: mixHex(tint, "#000000", 0.62),
  edge: mixHex(tint, "#000000", 0.8),
});

/** cashfree: the frame pulls back to 47% of its size in 0.46 s (14 frames), power3.out. */
export const CASHFREE_PULL_BACK = { to: 0.47, frames: 14 } as const;

/** Scale of the product layer during a pull-back: 1 / `to` (the frame filled) down to 1 over `frames`, power3.out. */
export const pullBackScale = (
  frame: number,
  {
    at = 0,
    frames = CASHFREE_PULL_BACK.frames,
    to = CASHFREE_PULL_BACK.to,
  }: { at?: number; frames?: number; to?: number } = {},
): number => {
  const p = familyProgress(frame, at, frames, "power3.out");
  return 1 / to + (1 - 1 / to) * p;
};
