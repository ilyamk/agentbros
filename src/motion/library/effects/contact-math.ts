/**
 * Contact and carry moves as pure functions of seconds since a cue: a landing that rings out,
 * a headline split by a hit, an arc between slots, a cast gathering on fanned arcs, a seal that
 * grows under it, and a flood draining in rings. Pass `frame / fps` and the cue's time in seconds.
 * Ideas from onetake lib/motion.js (feitangyuan/onetake); written fresh here.
 */

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;
/** Progress 0..1 of t across [t0, t1]. */
export const seg = (t: number, t0: number, t1: number): number =>
  t1 === t0 ? (t >= t1 ? 1 : 0) : clamp01((t - t0) / (t1 - t0));
/** Smootherstep: the travel curve for arcs and gathers (t80 about .67). */
export const smoother = (u: number): number => u * u * u * (u * (u * 6 - 15) + 10);

/** A decaying oscillation around 0 that starts at the hit: a landing, a wobble. */
export const ring = (tau: number, decay = 7, omega = 22): number =>
  tau <= 0 ? 0 : Math.exp(-decay * tau) * Math.sin(omega * tau);

/** Damped spring progress 0 → 1 (overshoots when zeta < 1). */
export const spring = (tau: number, zeta = 0.6, omega = 20): number => {
  if (tau <= 0) return 0;
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * tau) * (Math.cos(wd * tau) + ((zeta * omega) / wd) * Math.sin(wd * tau));
  }
  return 1 - Math.exp(-omega * tau) * (1 + omega * tau);
};

/** The lander's squash on a hit: scale x up, y down, ringing out. */
export const impact = (t: number, tHit: number, { sqx = 0.13, sqy = 0.16, decay = 7, omega = 22 } = {}) => {
  const r = ring(t - tHit, decay, omega);
  return { r, sx: 1 + r * sqx, sy: 1 - r * sqy };
};

/**
 * A hit at `cx` splits a line of glyphs: the glyph at `x` is pushed away by side, bounces by its
 * distance from the hit and rejoins. `width` is the distance over which the effect falls off.
 */
export const impactSplit = (
  t: number,
  tHit: number,
  x: number,
  cx: number,
  { width = 600, spread = 65, bounce = 65, rot = 0.18, falloff = 3 } = {},
) => {
  const d = (x - cx) / width;
  const r = ring(t - tHit);
  const apart = smoother(seg(t, tHit - 0.01, tHit + 0.48)) * (1 - smoother(seg(t, tHit + 0.63, tHit + 0.98)));
  return { dx: Math.sign(d) * apart * spread, dy: r * bounce * Math.exp(-d * d * falloff), rot: r * d * rot };
};

type Point = { x: number; y: number };

/** An arc from one slot to the next; land it with `impact`. */
export const hop = (t: number, t0: number, t1: number, from: Point, to: Point, height = 200): Point => {
  const k = smoother(seg(t, t0, t1));
  return { x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k) - Math.sin(k * Math.PI) * height };
};

/** Item i of n travels on an arc to its place, fanned by index and staggered: many become one group. */
export const gather = (
  t: number,
  t0: number,
  t1: number,
  i: number,
  n: number,
  from: Point,
  to: Point,
  { stagger = 0.08, arc = 120, spin = 0.4 } = {},
) => {
  const k = smoother(seg(t, t0 + i * stagger, t1 + i * stagger));
  const bump = Math.sin(k * Math.PI);
  return { k, x: lerp(from.x, to.x, k), y: lerp(from.y, to.y, k) - bump * arc, rot: bump * (i - (n - 1) / 2) * spin };
};

/** A disc that grows and turns under a gathering cast: the cast becomes the mark. */
export const seal = (t: number, t0: number, t1: number, { r = 235, turns = 1 } = {}) => {
  const k = smoother(seg(t, t0, t1));
  return { k, r: r * k, rot: k * turns * 360 };
};

/** n rings leave one point `stagger` apart, each reaching `rMax` in `dur`: a flood that drains onto the next scene. */
export const ripple = (t: number, t0: number, { n = 3, stagger = 0.16, dur = 1.25, rMax = 1160 } = {}) => {
  const r: number[] = [];
  for (let k = 0; k < n; k++) r.push(rMax * smoother(seg(t, t0 + k * stagger, t0 + k * stagger + dur)));
  return { r, done: t >= t0 + (n - 1) * stagger + dur };
};
