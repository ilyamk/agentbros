/**
 * Pure numbers for the 3D-ish blocks from the reference corpus: shaded-orb (glossy character orb, iridescent sphere
 * field), point-sphere (seeded strokes or points on a sphere, projected per frame), printing-slip (a curled sheet that
 * unrolls as rows print) and the modes `fan` (depth-card-flythrough) and `array` (studio-product-stage). No JSX and no
 * browser: tests import this file directly. Every value is a function of the frame and, where it varies, of a seed.
 *
 * Measured in design-reference/library/<id>/techniques.json: ace t05 (blob to 40% of the cell in 0.37 s, cyan shift, eyes
 * in 0.1 s, colour flood bottom-up in 0.08 s), flame collapse-to-point-burst (spheres 5-30% of the width enter from the
 * edges in 5 f, centre clear) and implode-and-blur (pull to a ring in 5 f, circ.out), flex t12 (stroke sphere pull-out
 * 0.83 s, circ.out), flame flank-words (dotted globe, expo.out pull-out, pink to blue drift), polymarket printing-slip
 * (rows about every 2 f, 0.97 s, power3.out), flex t06 (a dozen copies fanned over ~53 f, sine.inOut), cashfree
 * device-carousel (isometric phone array, truck x 0.25 W and y 0.14 H, sine.inOut).
 */
import { random } from "remotion";
import { familyProgress } from "../../ease-family";
import { stagger, type Point2 } from "../../timing";

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
/** GSAP sine.inOut. */
export const sineInOut = (t: number) => -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;

// --- shaded-orb: glossy ---

/** ace t05 at 30 fps: grow 11 f (0.37 s), cyan shift 4 f, eyes 3 f (0.1 s), flood 3 f (0.08 s). */
export const ACE_ORB = { grow: 11, shiftAt: 11, shift: 4, eyesAt: 16, eyes: 3, floodAt: 20, flood: 3 } as const;

export type OrbPlan = {
  at: number;
  grow: number;
  shiftAt: number;
  shift: number;
  eyesAt: number;
  eyes: number;
  floodAt: number;
  flood: number;
};
export type OrbState = { scale: number; shift: number; eyes: number; flood: number };

/**
 * The glossy orb at a frame, relative to `at`: `scale` 0..1 of its size (near-even growth, sine.out, as the strip's even
 * steps show), `shift` 0..1 from the first colour to the second, `eyes` 0..1 opacity, `flood` 0..1 height of the
 * bottom-up colour flood. Steps whose frame count is 0 are already done.
 */
export const orbState = (frame: number, plan: OrbPlan): OrbState => {
  const local = frame - plan.at;
  const window = (from: number, frames: number) => (frames <= 0 ? 1 : clamp01((local - from) / frames));
  return {
    scale: plan.grow <= 0 ? 1 : Math.sin((Math.PI / 2) * window(0, plan.grow)),
    shift: sineInOut(window(plan.shiftAt, plan.shift)),
    eyes: window(plan.eyesAt, plan.eyes),
    flood: 1 - (1 - window(plan.floodAt, plan.flood)) ** 2,
  };
};

// --- shaded-orb: iridescent field ---

export type FieldSphere = {
  /** Resting centre as a share of the frame (0..1); may sit partly outside, as in flame. */
  x: number;
  y: number;
  /** Radius as a share of the frame width. */
  r: number;
  /** 0 near, 1 far: far spheres are smaller in shading contrast and blurred. */
  depth: number;
  /** Start of the conic hue band in degrees, and the band's tilt. */
  hue: number;
  tilt: number;
  /** Entry delay in frames (radial order, outermost first). */
  delay: number;
};

/** flame: spheres of 5-30% of the frame width settle round the edges in 5 frames and leave the centre clear. */
export const FLAME_SPHERES = { minR: 0.05, maxR: 0.3, enter: 5, collapse: 5 } as const;

/**
 * A seeded field of spheres round the frame edges with a clear centre: each sits on an ellipse between `clear` and 0.75 of
 * the half-frame, at a seeded angle. Entry delays come from `stagger` radial (inward: outermost first) at `step` frames.
 */
export const sphereField = (
  seed: string,
  count: number,
  {
    clear = 0.42,
    minR = FLAME_SPHERES.minR,
    maxR = FLAME_SPHERES.maxR,
    step = 0.5,
  }: { clear?: number; minR?: number; maxR?: number; step?: number } = {},
): FieldSphere[] => {
  const raw = Array.from({ length: count }, (_, i) => {
    const angle = (i / count) * Math.PI * 2 + (random(`${seed}-a-${i}`) - 0.5) * (Math.PI / count) * 1.4;
    const reach = clear + random(`${seed}-d-${i}`) * (0.75 - clear);
    const r = minR + random(`${seed}-r-${i}`) ** 1.6 * (maxR - minR);
    return {
      x: 0.5 + Math.cos(angle) * reach,
      y: 0.5 + Math.sin(angle) * reach,
      r,
      depth: clamp01(1 - (r - minR) / Math.max(1e-6, maxR - minR) + (random(`${seed}-z-${i}`) - 0.5) * 0.3),
      hue: Math.round(random(`${seed}-h-${i}`) * 360),
      tilt: Math.round(-60 + random(`${seed}-t-${i}`) * 120),
    };
  });
  const points: Point2[] = raw.map((s) => ({ x: s.x, y: s.y }));
  const delays = stagger(count, { kind: "radial", step, points, origin: { x: 0.5, y: 0.5 }, inward: true });
  return raw.map((s, i) => ({ ...s, delay: delays[i]! }));
};

export type SpherePose = { x: number; y: number; scale: number; opacity: number; blur: number };

/**
 * One field sphere at a frame. Entry (`enterAt` + its delay, `enter` frames, expo.out): from beyond the nearest edge to
 * rest. Collapse (`collapseAt`, `collapse` frames, circ.out): into a tight ring at the centre, then the cluster shrinks to
 * 5% and fades over 8 frames with growing blur (flame implode-and-blur).
 */
export const spherePose = (
  s: FieldSphere,
  frame: number,
  {
    enterAt = 0,
    enter = FLAME_SPHERES.enter,
    collapseAt,
    collapse = FLAME_SPHERES.collapse,
  }: { enterAt?: number; enter?: number; collapseAt?: number; collapse?: number } = {},
): SpherePose => {
  const p = familyProgress(frame, enterAt + s.delay, enter, "expo.out");
  const dx = s.x - 0.5;
  const dy = s.y - 0.5;
  const len = Math.hypot(dx, dy) || 1;
  const push = (1 - p) * (0.6 + s.r);
  let x = s.x + (dx / len) * push;
  let y = s.y + (dy / len) * push;
  let scale = 1;
  let opacity = frame >= enterAt + s.delay ? 1 : 0;
  let blur = 0;
  if (collapseAt !== undefined && frame >= collapseAt) {
    const c = familyProgress(frame, collapseAt, collapse, "circ.out");
    const ring = 0.06;
    x = x + (0.5 + (dx / len) * ring - x) * c;
    y = y + (0.5 + (dy / len) * ring - y) * c;
    scale = 1 - 0.75 * c;
    const shrink = clamp01((frame - collapseAt - collapse) / 8);
    scale *= 1 - 0.85 * shrink;
    x = 0.5 + (x - 0.5) * (1 - shrink);
    y = 0.5 + (y - 0.5) * (1 - shrink);
    opacity *= 1 - shrink;
    blur = shrink;
  }
  return { x, y, scale, opacity, blur };
};

// --- point-sphere ---

export type Vec3 = [number, number, number];

/** `count` points spread evenly on the unit sphere (Fibonacci lattice), each nudged by a seeded jitter. */
export const spherePoints = (seed: string, count: number, jitter = 0.35): Vec3[] => {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: count }, (_, i) => {
    const y = 1 - ((i + 0.5) / count) * 2;
    const ring = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = i * golden + (random(`${seed}-j-${i}`) - 0.5) * jitter;
    const yy = Math.max(-1, Math.min(1, y + (random(`${seed}-k-${i}`) - 0.5) * jitter * (2 / count)));
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    return [Math.cos(theta) * (rr || ring), yy, Math.sin(theta) * (rr || ring)];
  });
};

const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Seeded short arcs on the unit sphere (flex's stroke sphere): each starts at a lattice point and runs along a great
 * circle in a seeded direction for `length` radians (varied ±40%), sampled at `samples` points.
 */
export const sphereArcs = (
  seed: string,
  count: number,
  { length = 0.5, samples = 8 }: { length?: number; samples?: number } = {},
): Vec3[][] =>
  spherePoints(seed, count, 0.9).map((p, i) => {
    const any: Vec3 = Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(p, any));
    const v = cross(p, u);
    const a = random(`${seed}-dir-${i}`) * Math.PI * 2;
    const t: Vec3 = [
      u[0] * Math.cos(a) + v[0] * Math.sin(a),
      u[1] * Math.cos(a) + v[1] * Math.sin(a),
      u[2] * Math.cos(a) + v[2] * Math.sin(a),
    ];
    const span = length * (0.6 + random(`${seed}-len-${i}`) * 0.8);
    return Array.from({ length: samples }, (_, k) => {
      const s = (k / (samples - 1)) * span;
      return [
        p[0] * Math.cos(s) + t[0] * Math.sin(s),
        p[1] * Math.cos(s) + t[1] * Math.sin(s),
        p[2] * Math.cos(s) + t[2] * Math.sin(s),
      ] as Vec3;
    });
  });

/** Rotate about y (`yaw`), then about x (`pitch`), radians. */
export const rotate = (p: Vec3, yaw: number, pitch: number): Vec3 => {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x = p[0] * cy + p[2] * sy;
  const z = -p[0] * sy + p[2] * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return [x, p[1] * cp - z * sp, p[1] * sp + z * cp];
};

export type Projected = { x: number; y: number; depth: number; scale: number };

/**
 * Perspective projection of a point on a sphere of `radius` pixels centred at (cx, cy), the camera `distance` sphere radii
 * away on +z. `depth` is 0 at the back, 1 at the front; `scale` is the perspective factor.
 */
export const project = (
  p: Vec3,
  { cx, cy, radius, distance = 4 }: { cx: number; cy: number; radius: number; distance?: number },
): Projected => {
  const scale = distance / (distance - p[2]);
  return { x: cx + p[0] * radius * scale, y: cy - p[1] * radius * scale, depth: (p[2] + 1) / 2, scale };
};

/** flex t12: the sphere pulls out in 0.83 s (25 f), circ.out. Scale from `from` down to 1. */
export const FLEX_PULL_OUT = { frames: 25, from: 1.62 } as const;

export const pullOut = (
  frame: number,
  {
    at = 0,
    frames = FLEX_PULL_OUT.frames as number,
    from = FLEX_PULL_OUT.from as number,
    ease = "circ.out",
  }: { at?: number; frames?: number; from?: number; ease?: "circ.out" | "expo.out" } = {},
): number => from + (1 - from) * familyProgress(frame, at, frames, ease);

/**
 * Procedural land for a dot globe: a point is land when a seeded value noise of its direction passes `share`. No map image
 * in git; continents are invented, which suits a world-in-general shot, not a real map.
 */
export const isLand = (p: Vec3, seed: string, share = 0.38): boolean => {
  const cell = (x: number, y: number, z: number) => random(`${seed}-${x}-${y}-${z}`);
  const f = 2.2;
  const x = (p[0] + 1) * f;
  const y = (p[1] + 1) * f;
  const z = (p[2] + 1) * f;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const sx = (x - xi) ** 2 * (3 - 2 * (x - xi));
  const sy = (y - yi) ** 2 * (3 - 2 * (y - yi));
  const sz = (z - zi) ** 2 * (3 - 2 * (z - zi));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const plane = (zz: number) =>
    lerp(
      lerp(cell(xi, yi, zz), cell(xi + 1, yi, zz), sx),
      lerp(cell(xi, yi + 1, zz), cell(xi + 1, yi + 1, zz), sx),
      sy,
    );
  return lerp(plane(zi), plane(zi + 1), sz) > 1 - share;
};

/** Gradient position 0..1 of a point for the tint: by height, drifting by `drift` per 100 frames (flame's pink to blue). */
export const tintAt = (p: Vec3, frame: number, drift = 0.35): number =>
  clamp01(((1 - p[1]) / 2) * (1 - drift) + Math.min(1, frame / 100) * drift);

// --- printing-slip ---

/** polymarket printing-slip: the slip unrolls over 0.97 s (29 f), power3.out; rows arrive every 1-2 frames at first, then slow. */
export const POLYMARKET_SLIP = { frames: 29 } as const;

/** Unrolled share of the slip at a frame, 0..1. */
export const slipUnroll = (
  frame: number,
  { at = 0, frames = POLYMARKET_SLIP.frames }: { at?: number; frames?: number } = {},
): number => familyProgress(frame, at, frames, "power3.out");

/** Share of the sheet hanging flat at an unroll: the `header` is out from the start, the rest follows the unroll. */
export const slipFlat = (unroll: number, header = 0.18): number => header + (1 - header) * unroll;

/** Rows printed: the rows sit evenly in the part below the header, so a row shows once the unroll passes it. */
export const slipRowsShown = (unroll: number, rows: number): number =>
  rows <= 0 ? 0 : Math.max(0, Math.min(rows, Math.floor(unroll * rows + 1e-9)));

/** The frame each row first shows, relative to `at`: about every frame at first, slowing as power3.out settles. */
export const slipRowFrames = (
  rows: number,
  { frames = POLYMARKET_SLIP.frames }: { frames?: number } = {},
): number[] => {
  const out: number[] = [];
  let f = 0;
  for (let row = 1; row <= rows; row++) {
    while (slipRowsShown(slipUnroll(f, { frames }), rows) < row && f < frames) f++;
    out.push(f);
  }
  return out;
};

/**
 * A point of the slip in its own space, for a distance `v` down the sheet (0 at the top). The unrolled part (length
 * `flat`) hangs straight; beyond it the paper wraps backwards round a roll of `radius`, so the bottom reads as a curl.
 * Returns y (down is negative) and z (back is negative).
 */
export const curlPoint = (v: number, flat: number, radius: number): { y: number; z: number } => {
  if (v <= flat) return { y: -v, z: 0 };
  const angle = Math.min((v - flat) / radius, Math.PI * 1.85);
  return { y: -flat - radius * Math.sin(angle), z: -radius * (1 - Math.cos(angle)) };
};

// --- depth-card-flythrough: fan ---

/** flex t06: a dozen copies fan out like a deck over ~53 frames, sine.inOut. */
export const FLEX_FAN = { copies: 12, frames: 53, delay: 2 } as const;

/**
 * Angle of each copy (degrees) about the shared corner at a frame: copy i rests at `spread * i / (copies - 1)` and starts
 * `delay * i` frames after the first; every copy finishes on frame `at + frames`.
 */
export const fanAngles = (
  frame: number,
  {
    copies = FLEX_FAN.copies,
    spread = 70,
    frames = FLEX_FAN.frames,
    delay = FLEX_FAN.delay,
    at = 0,
  }: { copies?: number; spread?: number; frames?: number; delay?: number; at?: number } = {},
): number[] => {
  const window = Math.max(1, frames - delay * (copies - 1));
  return Array.from({ length: copies }, (_, i) => {
    const target = copies <= 1 ? 0 : (spread * i) / (copies - 1);
    return target * sineInOut((frame - at - delay * i) / window);
  });
};

// --- studio-product-stage: array ---

export type GridCell = { x: number; z: number; column: number; row: number; index: number };

/** An isometric array's cells, centred on the origin, `spacing` apart in x and z. */
export const isoGrid = (columns: number, rows: number, spacing: number): GridCell[] =>
  Array.from({ length: columns * rows }, (_, index) => {
    const column = index % columns;
    const row = Math.floor(index / columns);
    return { x: (column - (columns - 1) / 2) * spacing, z: (row - (rows - 1) / 2) * spacing, column, row, index };
  });

/** cashfree: the camera trucks right by 0.25 of the frame width and down by 0.14 of its height, sine.inOut. */
export const CASHFREE_TRUCK = { x: 0.25, y: 0.14 } as const;

/** Camera offset at a frame as shares of the frame (x right, y down), centred so the move passes the middle. */
export const truckOffset = (
  frame: number,
  duration: number,
  { x = CASHFREE_TRUCK.x, y = CASHFREE_TRUCK.y }: { x?: number; y?: number } = {},
) => {
  const p = sineInOut(frame / Math.max(1, duration - 1)) - 0.5;
  return { x: x * p, y: y * p };
};
