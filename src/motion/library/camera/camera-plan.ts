/**
 * Pure numbers of the camera modes from the reference gaps (batch 5): the image card of `photo-move`, the video wall
 * of `populate-pull-out` and the defocus ramp of `focus-pull`. No React: tests import this file directly
 * (tests/motion-blocks-gap-scenes.test.ts).
 */
import { resolvePlan, type Rect, type ResolveEntry } from "../ui/ui-plan";

const clamp01 = (t: number): number => Math.min(Math.max(t, 0), 1);
/** GSAP's power2.out and power1.out (not in ease-family.ts). */
export const power2Out = (t: number): number => 1 - (1 - clamp01(t)) ** 3;
export const power1Out = (t: number): number => 1 - (1 - clamp01(t)) ** 2;

// ---------------------------------------------------------------------------------------------------------------------
// photo-move frame "card" (abdulah t04-image-card-on-paper 5.43-6.87 s, 30 fps)
// ---------------------------------------------------------------------------------------------------------------------

/** abdulah: off-white paper ground. */
export const IMAGE_CARD_PAPER = "#F8F6F2";

/**
 * Default card rect as shares of the frame. abdulah (landscape): about 0.25 of the width by 0.45 of the height, in the
 * right third (x 0.56-0.81). Vertical and square keep the card's own aspect (about 0.78 wide to tall) centred a little high.
 */
export const imageCardRect = (width: number, height: number): Rect => {
  if (width > height * 1.2) return { x: 0.56, y: 0.275, w: 0.25, h: 0.45 };
  const aspect = (0.25 * 16) / (0.45 * 9); // the landscape card's width over height in px
  const w = width > height ? 0.36 : 0.62;
  const h = (w * width) / aspect / height;
  return { x: (1 - w) / 2, y: Math.max(0.05, (1 - h) / 2 - 0.04), w, h };
};

/**
 * The second card behind the first: hidden before `at` (cut on, no tween: abdulah F177), then rotated `rotate` degrees
 * and offset by `offset` shares of the card. `at` < 0: never.
 */
export const secondCardPose = (
  frame: number,
  at: number,
  rotate = 3,
  offset = { x: 0.07, y: -0.05 },
): { shown: boolean; rotate: number; x: number; y: number } =>
  at >= 0 && frame >= at ? { shown: true, rotate, x: offset.x, y: offset.y } : { shown: false, rotate: 0, x: 0, y: 0 };

// ---------------------------------------------------------------------------------------------------------------------
// populate-pull-out variant "wall" (ugc-app person-wall 2.90-6.90 s, 30 fps)
// ---------------------------------------------------------------------------------------------------------------------

/** ugc-app: pull-back power2.out over 0.5 s (15 f), then power1.out over 1.7 s (51 f), still moving at the cut. */
export const WALL_FIRST_FRAMES = 15;
export const WALL_SECOND_FRAMES = 51;
/** ugc-app: white tiles resolve to clips in about 8 frames, outward from the centre. */
export const WALL_RESOLVE_FRAMES = 8;

/**
 * Scale of the wall after the pull starts: log-space from `start` to `mid` on power2.out over `firstFrames`, then from
 * `mid` to 1 (the whole wall) on power1.out over `secondFrames`. Before `pullAt` it is `start`. Pure.
 */
export const wallScale = (
  frame: number,
  pullAt: number,
  start: number,
  mid: number,
  firstFrames = WALL_FIRST_FRAMES,
  secondFrames = WALL_SECOND_FRAMES,
): { scale: number; stage: "drift" | "pull" | "second" | "rest"; focus: number } => {
  if (frame < pullAt) return { scale: start, stage: "drift", focus: 1 };
  const t1 = (frame - pullAt) / Math.max(1, firstFrames);
  if (t1 < 1) {
    const p = power2Out(t1);
    return { scale: start * (mid / start) ** p, stage: "pull", focus: 1 - p };
  }
  const t2 = (frame - pullAt - firstFrames) / Math.max(1, secondFrames);
  const q = power1Out(t2);
  return { scale: mid * (1 / mid) ** q, stage: t2 < 1 ? "second" : "rest", focus: 0 };
};

/**
 * A cols x rows wall of tiles as shares of the stage, with `gap` (share of a tile) between them. `stagger` > 0 shifts
 * each column up by a fixed, column-dependent share (up to `stagger`) of a tile's height and adds a row below, so the
 * columns read as separate feeds rather than a grid (ugc-app's wall).
 */
export const wallTiles = (cols: number, rows: number, gap = 0.06, stagger = 0): Rect[] => {
  const w = 1 / cols;
  const h = 1 / rows;
  const perColumn = stagger > 0 ? rows + 1 : rows;
  const out: Rect[] = [];
  for (let r = 0; r < perColumn; r++)
    for (let c = 0; c < cols; c++) {
      const shift = stagger > 0 ? (((c * 7 + 3) % 5) / 4) * stagger * h : 0;
      out.push({ x: c * w + (w * gap) / 2, y: r * h - shift + (h * gap) / 2, w: w * (1 - gap), h: h * (1 - gap) });
    }
  return out;
};

/**
 * ugc-app 6.50-6.90 s, late in the pull where the scale barely changes: neighbouring columns slide against each other
 * by about 10-20 px over 8 frames at a tile height of about 190 px, so about 0.012 of a tile height a frame, in
 * alternating directions (read off a strip; the rate is approximate, the pull-back dominates earlier frames).
 */
export const WALL_SCROLL = 0.012;
/** Half the angle the wall's width spans on its cylinder (radians) in the wall preset: a slight bow, as ugc-app's. */
export const WALL_CURVE = 0.35;
/** ugc-app F190: the outer columns fall to under half the centre's brightness, the corners near black, and go soft; the vignette's strength at the corners. */
export const WALL_VIGNETTE = 0.85;

/**
 * Vertical position (share of the stage) of a tile whose resting top is `y`, in a column of `perColumn` tiles of pitch
 * `pitch`, after the column has scrolled `frame * speed` tile pitches (even columns down, odd up). It wraps, so a
 * column is an endless feed. Pure.
 */
export const wallScrollY = (
  y: number,
  column: number,
  frame: number,
  speed: number,
  pitch: number,
  perColumn: number,
): number => {
  if (speed === 0) return y;
  const span = pitch * perColumn;
  const offset = (column % 2 === 0 ? 1 : -1) * frame * speed * pitch;
  return ((((y + pitch + offset) % span) + span) % span) - pitch;
};

/**
 * A tile column on a cylinder whose width spans `2 * curve` radians, seen from its axis: its centre `cx` (share of the
 * stage) moves towards the middle and it narrows by the cosine of its angle, and grows slightly shorter (the far edge
 * of the wall). `curve` 0 leaves it flat. Pure.
 */
export const wallCurve = (cx: number, curve: number): { cx: number; scaleX: number; scaleY: number } => {
  if (curve <= 0) return { cx, scaleX: 1, scaleY: 1 };
  const angle = (cx - 0.5) * 2 * curve;
  return {
    cx: 0.5 + Math.sin(angle) / (2 * Math.sin(curve)),
    scaleX: (Math.cos(angle) * curve) / Math.sin(curve),
    scaleY: 1 - 0.25 * (1 - Math.cos(angle)),
  };
};

/**
 * Each tile's resolve schedule: white blocks appear ring by ring outward from the centre (`step` frames a ring, one
 * tile width a ring), each un-blurring into its clip over `dissolve` frames. Uses placeholder-resolve's `resolvePlan`.
 */
export const wallPlan = (
  tiles: readonly Rect[],
  cols: number,
  start: number,
  step = 1,
  dissolve = WALL_RESOLVE_FRAMES,
): ResolveEntry[] =>
  resolvePlan(tiles, { start, step, order: "radial", origin: { x: 0.5, y: 0.5 }, ring: 1 / cols, dissolve });

// ---------------------------------------------------------------------------------------------------------------------
// focus-pull mode "ramp" (gojiberry defocus-end-card 47.2-56.53 s, 60 fps)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * gojiberry (strip 48.20-49.80 s against ours): the plate starts to soften about 48.4 s and is fully soft by about
 * 49.1 s, evenly in between: about 0.75 s (22 frames at 30 fps), sine.inOut.
 */
export const DEFOCUS_RAMP_FRAMES = 22;

/** Blur in px of the footage layer: 0 before `at`, rising to `max` over `frames` on sine.inOut, held after. */
export const defocusRamp = (frame: number, at: number, frames = DEFOCUS_RAMP_FRAMES, max = 24): number => {
  if (frame <= at) return 0;
  const t = clamp01((frame - at) / Math.max(1, frames));
  return max * (0.5 - Math.cos(Math.PI * t) / 2);
};
