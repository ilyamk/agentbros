/**
 * Pure plans for the effects blocks of gap-triage batch 3 (design-reference/gap-triage.md rows C3-C5, C8): a puppet limb
 * on stop-motion steps, things becoming dots, a seeded scatter around a text box and a symbol disc. No JSX and no
 * browser: tests import this file directly. Every value is a function of the frame (and a seed where it varies).
 */
import { random } from "remotion";
import { curves, onSteps, stagger, type Point2 } from "../../timing";

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const power2In = (t: number): number => t * t;
const power3Out = (t: number): number => 1 - (1 - t) ** 3;
const power2Out = (t: number): number => 1 - (1 - t) ** 2;

// --- Puppet limb (C8) ---

export type Limb = {
  /** Pivot as a share of the piece's box (0,0 top left): a shoulder, a hinge. */
  pivotX: number;
  pivotY: number;
  /** Swing amplitude in degrees either side of rest. */
  swing: number;
  /** Frames for one full swing there and back. */
  period: number;
  /** Frames each pose holds: 2 on twos, 3 on threes (paper-style moves objects on twos and threes). */
  step: number;
};

/**
 * Angle of a separated limb about its pivot on `frame`: still until `from` (the piece's landing), then a sine swing on
 * stop-motion steps (`onSteps`), so the limb jumps pose to pose while the rest of the frame can move smoothly.
 */
export const limbAngle = (frame: number, limb: Limb, from = 0): number => {
  if (frame < from) return 0;
  const t = onSteps(frame - from, limb.step);
  return limb.swing * Math.sin((2 * Math.PI * t) / Math.max(1, limb.period));
};

// --- Things become dots (C3) ---

/** One source item (a word's centre or a grid cell) in px, with the disc radius it becomes. */
export type DotSource = { x: number; y: number; r: number };

export type DotFieldOrder = "index" | "radial";
export type DotFieldTo = "hold" | "converge" | "stream" | "merge";

export type DotFieldTiming = {
  /** Frame the first item swaps for its disc. */
  swapAt: number;
  /** index: frames between items (ace: 2-3). radial: frames the ring takes to reach the farthest item (context-dev: 23). */
  swapStep: number;
  order: DotFieldOrder;
  /** Frames an item takes to fade while its disc pops in. */
  swapFrames: number;
  to: DotFieldTo;
  /** Frame the field starts to converge (converge, stream, merge). */
  toAt: number;
  /** Frames the converge takes, power2.in (context-dev: 11; ace: about 8). */
  convergeFrames: number;
  /** Converge point in px. */
  target: { x: number; y: number };
  /** stream: frames the band takes to leave the frame after it forms. */
  streamFrames: number;
  /** stream: band start (left end) in px, the band's height in px, and the frame width it leaves past. */
  bandFrom: number;
  bandHeight: number;
  width: number;
  seed: string;
};

/**
 * Swap delays of every item: by index (left to right, `swapStep` frames apart) or radial from the field's centre, the
 * ring widening faster as it grows (power1.in in time: delay grows with the square root of the ring's rank), so the
 * farthest ring swaps `swapStep` frames after the first. Uses `stagger` kind radial, so equal distances swap together.
 */
export const dotSwapDelays = (sources: readonly DotSource[], order: DotFieldOrder, swapStep: number): number[] => {
  if (order === "index") return sources.map((_, i) => Math.round(i * swapStep));
  const ranks = stagger(sources.length, { kind: "radial", step: 1, points: sources });
  const last = Math.max(1, ...ranks);
  return ranks.map((rank) => Math.round(swapStep * Math.sqrt(rank / last)));
};

export type DotState = {
  /** Disc centre in px and radius; `item` is the source item's opacity (word or tile), `dot` the disc's scale 0..1+. */
  x: number;
  y: number;
  r: number;
  item: number;
  dot: number;
  /** The disc has merged into the single blob (merge) or left the frame (stream). */
  gone: boolean;
};

/** Converge progress of item `i` on `frame`, power2.in, each item seeded up to 3 frames late so the flow is not a block. */
const convergeT = (frame: number, i: number, t: DotFieldTiming): number => {
  const lag = Math.floor(random(`${t.seed}-lag-${i}`) * 4);
  return power2In(clamp01((frame - t.toAt - lag) / Math.max(1, t.convergeFrames)));
};

/** stream: frames the converged point takes to flatten into its band. */
export const BAND_FRAMES = 6;

/** Last frame of the converge, every lag included. */
export const dotConvergeEnd = (t: Pick<DotFieldTiming, "toAt" | "convergeFrames">): number =>
  t.toAt + t.convergeFrames + 3;

/** Order of item `i` by x, so the band keeps the field's left-to-right order. */
const xRank = (sources: readonly DotSource[], i: number): number =>
  sources.filter((s, j) => s.x < sources[i]!.x || (s.x === sources[i]!.x && j < i)).length;

/**
 * Every disc on `frame`: the item fades and its disc pops (overshoot) on its swap delay; then `converge` pulls the discs
 * to `target` (power2.in); `merge` swaps them for one blob at the end; `stream` lays them out as a band from
 * `bandFrom` to the target at the target's height, which then travels right past the frame, power2.in.
 */
export const dotFieldStates = (frame: number, sources: readonly DotSource[], t: DotFieldTiming): DotState[] => {
  const delays = dotSwapDelays(sources, t.order, t.swapStep);
  const end = dotConvergeEnd(t);
  return sources.map((s, i) => {
    const local = frame - t.swapAt - delays[i]!;
    const swap = clamp01(local / Math.max(1, t.swapFrames));
    const pop = local < 0 ? 0 : local >= t.swapFrames ? 1 : Math.min(1.15, curves.overshoot(swap));
    const item = 1 - swap;
    if (t.to === "hold" || frame < t.toAt) return { x: s.x, y: s.y, r: s.r, item, dot: pop, gone: false };
    const c = convergeT(frame, i, t);
    if (t.to === "stream" && frame >= end) {
      // The point flattens into a band (each disc to its slot between bandFrom and the target, at a seeded height inside
      // the band, power2.out over BAND_FRAMES) while the band travels right past the frame (power2.in).
      const slot = sources.length > 1 ? xRank(sources, i) / (sources.length - 1) : 0;
      const bx = t.bandFrom + (t.target.x - t.bandFrom) * slot;
      const by = t.target.y + (random(`${t.seed}-band-${i}`) - 0.5) * t.bandHeight;
      const spread = power2Out(clamp01((frame - end) / BAND_FRAMES));
      const travel = power2In(clamp01((frame - end) / Math.max(1, t.streamFrames)));
      const shift = travel * (t.width - t.bandFrom + t.bandHeight);
      const x = t.target.x + (bx - t.target.x) * spread + shift;
      const y = t.target.y + (by - t.target.y) * spread;
      const r = s.r * 0.65;
      return { x, y, r, item: 0, dot: pop, gone: x - r > t.width };
    }
    const x = s.x + (t.target.x - s.x) * c;
    const y = s.y + (t.target.y - s.y) * c;
    return {
      x,
      y,
      r: t.to === "stream" ? s.r * (1 - 0.35 * c) : s.r,
      item: 0,
      dot: pop,
      gone: t.to === "merge" && frame >= end,
    };
  });
};

/** merge: radius of the single blob on `frame` (area of the discs, shrunk to 60%, popping in on the merge frame), 0 before. */
export const dotBlobRadius = (
  frame: number,
  sources: readonly DotSource[],
  t: Pick<DotFieldTiming, "toAt" | "convergeFrames" | "to">,
): number => {
  if (t.to !== "merge") return 0;
  const end = dotConvergeEnd(t);
  if (frame < end) return 0;
  const full = 0.6 * Math.sqrt(sources.reduce((sum, s) => sum + s.r * s.r, 0));
  return full * Math.min(1.12, curves.overshoot(clamp01((frame - end + 1) / 5)));
};

/**
 * stream: the band's trailing edge in px on `frame` (the leftmost disc still on the frame), or -1 until the band has
 * formed; type placed behind the band is revealed up to it, so it appears only where the band has passed. Once the band
 * has gone it is the frame width.
 */
export const dotStreamEdge = (frame: number, sources: readonly DotSource[], t: DotFieldTiming): number => {
  if (t.to !== "stream" || frame < dotConvergeEnd(t) + BAND_FRAMES) return -1;
  const live = dotFieldStates(frame, sources, t).filter((s) => !s.gone);
  return live.length ? Math.min(...live.map((s) => s.x - s.r)) : t.width;
};

// --- Scatter around a line (C4) ---

export type Box = { x: number; y: number; w: number; h: number };
/** A placed item: centre in px and its half width and half height. */
export type Placed = { x: number; y: number; hw: number; hh: number };

const overlaps = (a: Placed, b: Placed, gap: number): boolean =>
  Math.abs(a.x - b.x) < a.hw + b.hw + gap && Math.abs(a.y - b.y) < a.hh + b.hh + gap;
const hitsBox = (a: Placed, box: Box, gap: number): boolean =>
  a.x + a.hw + gap > box.x &&
  a.x - a.hw - gap < box.x + box.w &&
  a.y + a.hh + gap > box.y &&
  a.y - a.hh - gap < box.y + box.h;

/**
 * Seeded, non-overlapping positions for items of the given half sizes, clear of `avoid` (the held line's box) by `gap`
 * px. `area` is where centres may fall: keep it inside the safe zone for words; images may take an area past the frame
 * edges (abdulah's portraits sit off the edges). Bounded best-candidate sampling: up to `attempts` seeded tries per
 * item, keeping among the first `candidates` clear tries the one farthest from every placed item, so the field spreads
 * evenly instead of clumping; when no try is clear, the least crowded is kept, so the result always has every item.
 */
export const scatterPositions = (
  sizes: readonly { hw: number; hh: number }[],
  {
    area,
    avoid,
    gap,
    seed,
    attempts = 200,
    candidates = 12,
  }: { area: Box; avoid: Box | null; gap: number; seed: string; attempts?: number; candidates?: number },
): Placed[] => {
  const placed: Placed[] = [];
  sizes.forEach((size, i) => {
    let best: Placed | null = null;
    let bestScore = -Infinity;
    let clearFound = 0;
    for (let k = 0; k < attempts && clearFound < candidates; k++) {
      const p: Placed = {
        x: area.x + size.hw + random(`${seed}-${i}-${k}-x`) * Math.max(0, area.w - 2 * size.hw),
        y: area.y + size.hh + random(`${seed}-${i}-${k}-y`) * Math.max(0, area.h - 2 * size.hh),
        hw: size.hw,
        hh: size.hh,
      };
      const inBox = !!avoid && hitsBox(p, avoid, gap);
      const clear = !inBox && placed.every((q) => !overlaps(p, q, gap));
      if (clear) clearFound++;
      const near = placed.length
        ? Math.min(...placed.map((q) => Math.hypot(p.x - q.x, p.y - q.y) - Math.hypot(p.hw + q.hw, p.hh + q.hh)))
        : 0;
      // A clear try always beats an unclear one; among clear tries the farthest from its neighbours wins.
      const score = (clear ? 1e9 : 0) + (inBox ? -1e6 : 0) + near;
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    placed.push(best!);
  });
  return placed;
};

/** Frame each of `count` items cuts on: `at` then one every `every` frames (abdulah: a portrait every 4 frames). */
export const popFrames = (count: number, at: number, every: number): number[] =>
  Array.from({ length: count }, (_, i) => at + Math.round(i * every));

export type CornerPose = { x: number; y: number; visible: boolean };

/**
 * Card `i` of a corner orbit on `frame`: it flies in along its corner's diagonal from beyond the frame and brakes on its
 * corner spot in `enterFrames` (power3.out, no overshoot; foren: about 6 frames), cards `lag` frames apart, then drifts
 * slowly outward along the same diagonal at `drift` px a frame. Spots are the four corners of `spot` (a box around the
 * centre, in px); more than four cards cycle the corners.
 */
export const cornerPose = (
  frame: number,
  i: number,
  {
    at,
    enterFrames,
    lag,
    drift,
    spot,
    width,
    height,
  }: { at: number; enterFrames: number; lag: number; drift: number; spot: Box; width: number; height: number },
): CornerPose => {
  const corner = i % 4;
  const sx = corner === 0 || corner === 3 ? -1 : 1;
  const sy = corner < 2 ? -1 : 1;
  const tx = spot.x + (sx > 0 ? spot.w : 0);
  const ty = spot.y + (sy > 0 ? spot.h : 0);
  const start = at + i * lag;
  if (frame < start) return { x: tx, y: ty, visible: false };
  const from = { x: tx + sx * width * 0.45, y: ty + sy * height * 0.45 };
  const t = power3Out(clamp01((frame - start) / Math.max(1, enterFrames)));
  const since = Math.max(0, frame - start - enterFrames);
  const len = Math.hypot(width, height);
  return {
    x: from.x + (tx - from.x) * t + (sx * drift * since * width) / len,
    y: from.y + (ty - from.y) * t + (sy * drift * since * height) / len,
    visible: true,
  };
};

/** Frame card `i` of a corner orbit lands. */
export const cornerLanding = (
  i: number,
  { at, enterFrames, lag }: { at: number; enterFrames: number; lag: number },
): number => at + i * lag + enterFrames;

// --- Symbol disc (C5) ---

/** Index of the symbol showing on `frame`: one more for every swap frame reached (steps, no blend). */
export const symbolIndex = (frame: number, swaps: readonly number[], count: number): number => {
  const passed = swaps.filter((s) => frame >= s).length;
  return count > 0 ? passed % count : 0;
};

/**
 * The disc's offset from its rest spot on `frame` as a share of the travel: it arrives from `from` (shares of the frame,
 * signed) in `settleFrames` (power3.out, foren: 5) starting on `at`, then drifts `drift` px a frame along the same line
 * onward. Returns px; `visible` is false before `at`.
 */
export const discEntry = (
  frame: number,
  {
    at,
    settleFrames,
    from,
    drift,
    width,
    height,
  }: { at: number; settleFrames: number; from: { x: number; y: number }; drift: number; width: number; height: number },
): { dx: number; dy: number; visible: boolean; travel: number } => {
  if (frame < at) return { dx: from.x * width, dy: from.y * height, visible: false, travel: 1 };
  const t = power3Out(clamp01((frame - at) / Math.max(1, settleFrames)));
  const len = Math.hypot(from.x * width, from.y * height) || 1;
  const since = Math.max(0, frame - at - settleFrames);
  const ux = (-from.x * width) / len;
  const uy = (-from.y * height) / len;
  return {
    dx: from.x * width * (1 - t) + ux * drift * since,
    dy: from.y * height * (1 - t) + uy * drift * since,
    visible: true,
    travel: 1 - t,
  };
};

export type SpinPose = {
  /** Turn about the vertical axis in degrees; the face shows while cos > 0, the back while cos < 0. */
  angle: number;
  /** Horizontal squash of the face: |cos angle|. */
  squash: number;
  back: boolean;
  /** Overall scale (oversized on entry, 1 on landing) and the centre in px. */
  scale: number;
  x: number;
  y: number;
  /** Angular speed in degrees a frame (for a speed smear) and whether it has landed. */
  speed: number;
  landed: boolean;
  visible: boolean;
};

/**
 * A disc spinning about its vertical axis on its way to a slot (polymarket object-into-slot): from `from` at
 * `fromScale` to `to` at scale 1 over `frames` (polymarket: 20, power2.out), while it turns `turns` turns (0.5: back,
 * edge-on, face) and ends face-on; the turn finishes in the first `spinShare` of the move, so the disc reads face-on
 * while it still shrinks into place.
 */
export const spinPose = (
  frame: number,
  {
    at,
    frames,
    turns,
    fromScale,
    from,
    to,
    spinShare = 0.6,
  }: {
    at: number;
    frames: number;
    turns: number;
    fromScale: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
    spinShare?: number;
  },
): SpinPose => {
  const raw = clamp01((frame - at) / Math.max(1, frames));
  const t = power2Out(raw);
  const total = turns * 360;
  const turnAt = (f: number) => total * (power2Out(clamp01((f - at) / Math.max(1, frames * spinShare))) - 1);
  const angle = turnAt(frame);
  const prev = turnAt(frame - 1);
  const cos = Math.cos((angle * Math.PI) / 180);
  return {
    angle,
    squash: Math.abs(cos),
    back: cos < 0,
    scale: fromScale + (1 - fromScale) * t,
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    speed: frame <= at ? 0 : angle - prev,
    landed: raw >= 1,
    visible: frame >= at,
  };
};

/**
 * A grid of `cols` x `rows` cells filling the box (x, y, w, h in px), each with a seeded disc radius from `sizes` (shares
 * of the cell) and a seeded jitter (share of the cell): context-dev's cards becoming dots of three or four sizes.
 */
export const gridDotSources = (
  box: { x: number; y: number; w: number; h: number },
  cols: number,
  rows: number,
  sizes: readonly number[],
  jitter: number,
  seed: string,
): DotSource[] => {
  const cw = box.w / cols;
  const ch = box.h / rows;
  const cell = Math.min(cw, ch);
  const out: DotSource[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const k = `${seed}-${row}-${col}`;
      const size = sizes[Math.floor(random(`${k}-size`) * sizes.length)] ?? 0.2;
      out.push({
        x: box.x + (col + 0.5) * cw + (random(`${k}-jx`) - 0.5) * jitter * cell,
        y: box.y + (row + 0.5) * ch + (random(`${k}-jy`) - 0.5) * jitter * cell,
        r: (size * cell) / 2,
      });
    }
  }
  return out;
};
