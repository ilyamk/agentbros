/**
 * Pure numbers of `ticker-card` (polymarket card-rotator 7.20-10.53 s, 30 fps): the swap schedule, the seeded price
 * line, the soft pull-back to a row and the row's drift. No React: tests import this file directly
 * (tests/motion-blocks-gap-scenes.test.ts).
 */
import { random } from "remotion";

/** polymarket: the card's asset swaps every 6-12 frames. */
export const TICKER_SWAP_MIN = 6;
export const TICKER_SWAP_MAX = 12;
/** polymarket F248-F268: the pull-back takes about 20 frames (0.67 s) on sine.inOut. */
export const TICKER_PULL_FRAMES = 20;
/** polymarket (strip side by side, F246-F275): the card is about 0.37 of the width close and about 0.27 in the row: scale about 0.72. */
export const TICKER_ROW_SCALE = 0.72;

export const sineInOut = (t: number): number => 0.5 - Math.cos(Math.PI * Math.min(Math.max(t, 0), 1)) / 2;

/**
 * Frames the card changes asset: the first asset shows from `at`, then one swap per remaining asset, each gap a seeded
 * whole number of frames in [min, max]. Pure and seeded: the same inputs give the same frames.
 */
export const tickerSwaps = (
  count: number,
  at: number,
  { min = TICKER_SWAP_MIN, max = TICKER_SWAP_MAX, seed = "ticker" }: { min?: number; max?: number; seed?: string } = {},
): number[] => {
  const out: number[] = [];
  let frame = at;
  for (let i = 1; i < count; i++) {
    frame += min + Math.floor(random(`${seed}-swap-${i}`) * (max - min + 1));
    out.push(frame);
  }
  return out;
};

/** Index of the asset shown at `frame`: 0 before the first swap, the last after the last. */
export const tickerIndexAt = (frame: number, swaps: readonly number[]): number =>
  swaps.filter((s) => s <= frame).length;

/**
 * A seeded price line of `points` values in 0..1 (0 the lowest point, 1 the highest) that drifts towards `change`'s
 * sign: a rising asset ends higher than it starts. Pure.
 */
export const tickerSeries = (seed: string, change: number, points = 28): number[] => {
  const raw: number[] = [];
  let v = 0;
  const trend = Math.sign(change) * 0.06;
  for (let i = 0; i < points; i++) {
    v += trend + (random(`${seed}-pt-${i}`) - 0.5) * 0.5;
    raw.push(v);
  }
  const lo = Math.min(...raw);
  const hi = Math.max(...raw);
  return raw.map((x) => (hi - lo < 1e-9 ? 0.5 : (x - lo) / (hi - lo)));
};

/** Pull-back progress 0..1 (sine.inOut over `frames` from `at`) and the stage scale from 1 to `rowScale`. */
export const tickerPull = (
  frame: number,
  at: number,
  frames = TICKER_PULL_FRAMES,
  rowScale = TICKER_ROW_SCALE,
): { p: number; scale: number } => {
  if (at < 0) return { p: 0, scale: 1 };
  const p = sineInOut((frame - at) / Math.max(1, frames));
  return { p, scale: 1 + (rowScale - 1) * p };
};

/**
 * Sideways travel of the row in shares of the width: none before the pull starts, then a constant leftward slide of
 * `speed` widths a second (polymarket: the row keeps sliding left through the hold).
 */
export const tickerDrift = (frame: number, at: number, speed: number, fps = 30): number =>
  at < 0 || frame <= at ? 0 : -(speed * (frame - at)) / fps;

/** Blur in px of a neighbour `distance` cards from the centre: depth of field that eases as the row settles. */
export const neighbourBlur = (distance: number, p: number, maxBlur: number): number =>
  maxBlur * Math.min(Math.abs(distance), 2) * 0.5 * (1 - 0.3 * p);
