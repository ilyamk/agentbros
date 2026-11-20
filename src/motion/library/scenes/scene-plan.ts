/**
 * Pure numbers of the scene blocks from the reference gaps (batch 5): the quad split's cut planner, the bento's hero
 * snap layout and the flash montage's per-plate focus. No React, no media: tests import this file directly
 * (tests/motion-blocks-gap-scenes.test.ts).
 */

export type Rect = { x: number; y: number; w: number; h: number };

// ---------------------------------------------------------------------------------------------------------------------
// quad-split (ace t01, t02, t14; ace is 60 fps, numbers below converted to the film's fps by the caller's `fps`)
// ---------------------------------------------------------------------------------------------------------------------

/** Cells in reading order: top left, top right, bottom left, bottom right. */
export const QUAD_CELLS = ["tl", "tr", "bl", "br"] as const;
export type QuadCell = (typeof QUAD_CELLS)[number];

/** The opposite corner of each cell (index into QUAD_CELLS): coinciding changes are allowed only on these pairs. */
export const QUAD_DIAGONAL = [3, 2, 1, 0] as const;

/** ace: never more than two cell changes within 0.1 s. */
export const QUAD_WINDOW_SEC = 0.1;
/** ace: a diagonal pair lands one frame apart (at 60 fps; at 30 fps half a frame rounds up to one). */
export const QUAD_PAIR_GAP = 1;
/** ace t14: the top-right cell held one line for 1.9 s while the others changed four times. */
export const QUAD_REST_SEC = 1.9;
/** ace t02: median gap between boundaries 0.517 s. */
export const QUAD_MEDIAN_GAP_SEC = 0.517;

export type QuadPlanOptions = {
  fps?: number;
  /** Seconds in which at most two changes may fall (0.1). */
  windowSec?: number;
  /** Frames between the two changes of a diagonal pair (1). */
  pairGap?: number;
  /** Shortest hold of one cell between its own changes, in frames (3). */
  minHold?: number;
  /** Seconds one cell must rest in the densest stretch; 0 turns the rest rule off. */
  restSec?: number;
};

export type QuadEvent = { frame: number; cell: number };

/** Frames of the "at most two" window: 0.1 s is 3 frames at 30 fps and 6 at 60. */
export const quadWindowFrames = (fps = 30, windowSec = QUAD_WINDOW_SEC): number =>
  Math.max(2, Math.ceil(windowSec * fps));

/** All changes of a plan as one list ordered by frame, then cell. */
export const quadEvents = (cuts: readonly (readonly number[])[]): QuadEvent[] =>
  cuts
    .flatMap((list, cell) => list.map((frame) => ({ frame, cell })))
    .sort((a, b) => a.frame - b.frame || a.cell - b.cell);

/** The window of `frames` frames holding the most changes: its start and its count. Ties keep the earliest. */
export const densestWindow = (events: readonly QuadEvent[], frames: number): { from: number; count: number } => {
  let best = { from: events[0]?.frame ?? 0, count: 0 };
  for (const start of events) {
    const count = events.filter((e) => e.frame >= start.frame && e.frame < start.frame + frames).length;
    if (count > best.count) best = { from: start.frame, count };
  }
  return best;
};

/** Cells with no change inside [from, from + frames). */
export const restingCells = (cuts: readonly (readonly number[])[], from: number, frames: number): number[] =>
  cuts.map((list, cell) => (list.some((f) => f >= from && f < from + frames) ? -1 : cell)).filter((cell) => cell >= 0);

export type QuadRest = { cell: number; from: number; to: number; others: number };

/**
 * The best rest of the stage: a hold of one cell (between its own changes, or from 0 to its first) at least `frames`
 * long, with the most changes of the other cells inside it. ace t14: the top right held 1.9 s while the others changed
 * four times. `undefined` when no hold is that long.
 */
export const bestRest = (cuts: readonly (readonly number[])[], frames: number): QuadRest | undefined => {
  let best: QuadRest | undefined;
  cuts.forEach((list, cell) => {
    const bounds = [0, ...list];
    for (let i = 0; i < bounds.length - 1; i++) {
      const from = bounds[i]!;
      const to = bounds[i + 1]!;
      if (to - from < frames) continue;
      const others = cuts.reduce(
        (n, other, j) => n + (j === cell ? 0 : other.filter((f) => f > from && f < to).length),
        0,
      );
      if (!best || others > best.others) best = { cell, from, to, others };
    }
  });
  return best;
};

const placeEvents = (events: readonly QuadEvent[], w: number, pairGap: number, minHold: number): number[][] => {
  const placed: QuadEvent[] = [];
  for (const event of events) {
    let frame = event.frame;
    for (let guard = 0; guard < 10_000; guard++) {
      const near = placed.filter((p) => Math.abs(p.frame - frame) < w);
      const sameCell = placed.some((p) => p.cell === event.cell && Math.abs(p.frame - frame) < Math.max(minHold, 1));
      const partner = near[0];
      const pairOk =
        near.length === 1 &&
        partner!.cell === QUAD_DIAGONAL[event.cell] &&
        Math.abs(partner!.frame - frame) === pairGap &&
        // The partner must not already be paired with someone else.
        !placed.some((p) => p !== partner && Math.abs(p.frame - partner!.frame) < w);
      if (!sameCell && (near.length === 0 || pairOk)) break;
      frame++;
    }
    placed.push({ frame, cell: event.cell });
  }
  return QUAD_CELLS.map((_, cell) =>
    placed
      .filter((p) => p.cell === cell)
      .map((p) => p.frame)
      .sort((a, b) => a - b),
  );
};

/**
 * Plans the four cells' cut lists so they read as four films, not one: changes move later (never earlier) until no
 * more than two fall within `windowSec`, two that do fall together are on opposite corners `pairGap` frames apart (a
 * request on the same frame as its diagonal becomes the pair), and, with `restSec`, the cell with the fewest changes in
 * the densest stretch rests through it (its changes there move to the stretch's end). Pure; the input is not changed.
 */
export const planQuadCuts = (cuts: readonly (readonly number[])[], options: QuadPlanOptions = {}): number[][] => {
  const {
    fps = 30,
    windowSec = QUAD_WINDOW_SEC,
    pairGap = QUAD_PAIR_GAP,
    minHold = 3,
    restSec = QUAD_REST_SEC,
  } = options;
  const w = quadWindowFrames(fps, windowSec);
  const four = QUAD_CELLS.map((_, i) => [...(cuts[i] ?? [])].sort((a, b) => a - b));
  let plan = placeEvents(quadEvents(four), w, pairGap, minHold);
  const restFrames = Math.round(restSec * fps);
  // A rest counts when the other three change at least three times under it (ace: four).
  if (restFrames > 0 && (bestRest(plan, restFrames)?.others ?? 0) < 3) {
    const dense = densestWindow(quadEvents(plan), restFrames);
    if (dense.count > 0) {
      const counts = plan.map((list) => list.filter((f) => f >= dense.from && f < dense.from + restFrames).length);
      const rest = counts.indexOf(Math.min(...counts));
      const end = dense.from + restFrames;
      // The resting cell's changes inside the stretch collapse into one change at its end.
      const moved = four.map((list, cell) => {
        if (cell !== rest) return plan[cell]!;
        const inside = plan[cell]!.filter((f) => f >= dense.from && f < end);
        const outside = plan[cell]!.filter((f) => f < dense.from || f >= end);
        return [...outside, ...(inside.length > 0 ? [end] : [])].sort((a, b) => a - b);
      });
      plan = placeEvents(quadEvents(moved), w, pairGap, minHold);
    }
  }
  return plan;
};

/** Most changes in any window of `w` frames. */
export const maxChangesWithin = (cuts: readonly (readonly number[])[], w: number): number => {
  const events = quadEvents(cuts);
  return events.reduce(
    (m, e) => Math.max(m, events.filter((o) => o.frame >= e.frame && o.frame < e.frame + w).length),
    0,
  );
};

/** Pairs of changes closer than `w` frames, with their cells and gap. */
export const closePairs = (
  cuts: readonly (readonly number[])[],
  w: number,
): { a: QuadEvent; b: QuadEvent; gap: number }[] => {
  const events = quadEvents(cuts);
  const out: { a: QuadEvent; b: QuadEvent; gap: number }[] = [];
  for (let i = 0; i < events.length; i++)
    for (let j = i + 1; j < events.length && events[j]!.frame - events[i]!.frame < w; j++)
      out.push({ a: events[i]!, b: events[j]!, gap: events[j]!.frame - events[i]!.frame });
  return out;
};

/** Index of the shot a cell shows at `frame` (0 before its first change). */
export const quadShotAt = (cuts: readonly number[], frame: number): number => cuts.filter((f) => f <= frame).length;

/** Median gap in frames between consecutive changes of the whole stage. */
export const medianGap = (cuts: readonly (readonly number[])[]): number => {
  const frames = quadEvents(cuts).map((e) => e.frame);
  const gaps = frames
    .slice(1)
    .map((f, i) => f - frames[i]!)
    .sort((a, b) => a - b);
  if (gaps.length === 0) return 0;
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
};

/** The four 50% x 50% cells, no gutter, as shares of the frame. */
export const quadRects = (): Rect[] =>
  QUAD_CELLS.map((_, i) => ({ x: (i % 2) * 0.5, y: Math.floor(i / 2) * 0.5, w: 0.5, h: 0.5 }));

// ---------------------------------------------------------------------------------------------------------------------
// scene-bento-collage heroSnap (cashfree bento-assemble-around-hero 16.10-18.63 s, 30 fps)
// ---------------------------------------------------------------------------------------------------------------------

/** cashfree: the full-bleed photo snaps to a card about 63% of the width. */
export const HERO_SNAP_SHARE = 0.63;
/** cashfree: tiles land every 1-2 frames, no tween. */
export const HERO_SNAP_STEPS = [2, 1, 2, 1, 2, 1];

/**
 * Rects (px) of the hero card centred at `share` of the width (same aspect as the frame, so it reads as the photo
 * shrunk) and six tiles around it in reading order: the two tall side panels last, as cashfree's slide in at the end.
 */
export const heroSnapRects = (
  width: number,
  height: number,
  share = HERO_SNAP_SHARE,
  gap = 16,
): { hero: Rect; tiles: Rect[] } => {
  if (height > width * 1.2) {
    // Vertical: the card is wider than `share` (sides would be slivers); the tiles stack in rows above and below it,
    // the two "panels" as full-width bands at the top and bottom edges.
    const hw = width - gap * 2;
    const hh = hw * 0.75;
    const hero = { x: gap, y: (height - hh) / 2, w: hw, h: hh };
    const space = hero.y - gap * 2;
    const bandH = space * 0.42;
    const rowH = space - bandH - gap;
    const half = (hw - gap) / 2;
    const rowTop = gap + bandH + gap;
    const rowBottom = hero.y + hh + gap;
    return {
      hero,
      tiles: [
        { x: gap, y: rowTop, w: half, h: rowH },
        { x: gap + half + gap, y: rowBottom, w: half, h: rowH },
        { x: gap + half + gap, y: rowTop, w: half, h: rowH },
        { x: gap, y: rowBottom, w: half, h: rowH },
        { x: gap, y: gap, w: hw, h: bandH },
        { x: gap, y: rowBottom + rowH + gap, w: hw, h: bandH },
      ],
    };
  }
  const hw = width * share;
  const hh = height * share;
  const hero = { x: (width - hw) / 2, y: (height - hh) / 2, w: hw, h: hh };
  const side = hero.x - gap * 2;
  const band = hero.y - gap * 2;
  const top: Rect = { x: hero.x, y: gap, w: hw * 0.58 - gap / 2, h: band };
  const topRight: Rect = { x: hero.x + hw * 0.58 + gap / 2, y: gap, w: hw * 0.42 - gap / 2, h: band };
  const bottom: Rect = { x: hero.x, y: hero.y + hh + gap, w: hw * 0.4 - gap / 2, h: band };
  const bottomRight: Rect = { x: hero.x + hw * 0.4 + gap / 2, y: hero.y + hh + gap, w: hw * 0.6 - gap / 2, h: band };
  const left: Rect = { x: gap, y: gap, w: side, h: height - gap * 2 };
  const right: Rect = { x: width - gap - side, y: gap, w: side, h: height - gap * 2 };
  return { hero, tiles: [top, bottomRight, topRight, bottom, left, right] };
};

/** The hero's rect at `frame`: the whole frame before `snapAt`, the card from `snapAt` on (one frame, no tween). */
export const heroSnapRect = (frame: number, snapAt: number, width: number, height: number, card: Rect): Rect =>
  frame < snapAt ? { x: 0, y: 0, w: width, h: height } : card;

// ---------------------------------------------------------------------------------------------------------------------
// caption-over-flash-montage focus (ugc-app highlight-lock, palmier two-frame-burst)
// ---------------------------------------------------------------------------------------------------------------------

export type FocusBox = Rect;
export type FocusTarget = { x: number; y: number };

/**
 * Width of the focus box on plate `index` of `count`, as a share of frame width: `size` on the first plate growing
 * geometrically to `size * grow` on the last (palmier: the eye closes in steadily to a pupil about 30% of the width).
 * By plate index, not by frame, so a `flashSafe` stretch keeps the growth even.
 */
export const focusSizeAt = (index: number, count: number, size: number, grow = 1): number =>
  count <= 1 ? size : size * grow ** (Math.min(Math.max(index, 0), count - 1) / (count - 1));

/**
 * Transform that puts a plate's focus box (shares of the plate, which fills the frame) on `target` (shares of the
 * frame) at `size` of the frame's width: scale about the top-left corner, then translate in px. Pure.
 */
export const focusTransform = (
  box: FocusBox,
  target: FocusTarget,
  size: number,
  width: number,
  height: number,
): { scale: number; x: number; y: number } => {
  const scale = size / Math.max(box.w, 1e-6);
  const cx = (box.x + box.w / 2) * width;
  const cy = (box.y + box.h / 2) * height;
  return { scale, x: target.x * width - cx * scale, y: target.y * height - cy * scale };
};

/** Where the focus box lands on screen after `focusTransform`, in px. */
export const focusLanding = (
  box: FocusBox,
  t: { scale: number; x: number; y: number },
  width: number,
  height: number,
): Rect => ({
  x: t.x + box.x * width * t.scale,
  y: t.y + box.y * height * t.scale,
  w: box.w * width * t.scale,
  h: box.h * height * t.scale,
});

// ---------------------------------------------------------------------------------------------------------------------
// scene-end-card `wordmarkEntry: "type"` (motionfly t17, 26.23-27.27 s at 30 fps)
// ---------------------------------------------------------------------------------------------------------------------

/** motionfly t17: one wordmark letter about every 3 frames (F787 to F818). */
export const END_CARD_TYPE_EVERY = 3;
/** motionfly t01 and t17: a letter's tint settles to ink about 5 frames after it appeared. */
export const END_CARD_TINT_FRAMES = 5;
/** motionfly's tint run, lilac, raspberry, teal (t01, reused per letter in t17). */
export const END_CARD_TINT = ["#B873B3", "#B73A69", "#0A7F6F"] as const;

/** How many of `length` wordmark letters show at a frame when one types every `every` frames from `at`. Pure. */
export const endCardTyped = (frame: number, at: number, every: number, length: number): number =>
  frame < at ? 0 : Math.min(length, Math.floor((frame - at) / Math.max(1, every)) + 1);

/** Frame letter `index` appears. */
export const endCardLetterAt = (index: number, at: number, every: number): number => at + index * Math.max(1, every);

/** Reserve a still reading hold after the final camera move, including in the shortest supported demo. */
export function captureTiming(length: number, carriesControl: boolean) {
  const click = Math.round(length * 0.43);
  const carryAt = click + 6;
  const landing = carryAt + (carriesControl ? 18 : 0);
  const reframeDelay = Math.min(9, Math.round(length * 0.035));
  const reframeDuration = Math.min(24, Math.max(1, length - landing - reframeDelay - Math.ceil(length * 0.16)));
  return { click, carryAt, landing, reframeDelay, reframeDuration };
}
