import { random } from "remotion";
import { stagger, type Point2 } from "../../timing";

/**
 * Pure numbers under the UI-motion blocks of the reference gap batch (`placeholder-resolve`, `ui-check-list`,
 * `ui-annotate`, `ui-card-grid`, `chip-wall`) and the modes on `ui-data-table`, `ui-ai-chat` and `ui-prompt-bar`.
 * No React, no media: tests import this file directly. Timings are the measured ones from the technique cards in
 * design-reference/techniques/ (placeholder-resolve, check-row-list, anchored-annotations, card-fanout, chip-wall).
 */

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
const lin = (frame: number, from: number, frames: number) =>
  frames <= 0 ? (frame >= from ? 1 : 0) : clamp01((frame - from) / frames);

/** GSAP families used here, as pure 0..1 shapes (the same maths as src/motion/ease-family.ts). */
export const uiEase = {
  linear: (t: number) => t,
  "power2.inOut": (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  "power2.out": (t: number) => 1 - (1 - t) ** 3,
  "power3.out": (t: number) => 1 - (1 - t) ** 4,
  "expo.out": (t: number) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t)),
  /** GSAP back.out(1.7): passes the target by about 10% and settles. */
  "back.out": (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
  },
} as const;
export type UiEaseName = keyof typeof uiEase;

export const easeWindow = (frame: number, from: number, frames: number, ease: UiEaseName): number => {
  const t = lin(frame, from, frames);
  return t <= 0 ? 0 : t >= 1 ? 1 : uiEase[ease](t);
};

// ---------------------------------------------------------------------------------------------------------------------
// placeholder-resolve

/** A region of the stage, in shares of the stage (0..1). */
export type Rect = { x: number; y: number; w: number; h: number };

export type ResolveOrder = "index" | "reading" | "radial";

export type ResolveOptions = {
  /** Frame the first region starts. */
  start: number;
  /** Frames between region starts (or between rings with `order: "radial"`). */
  step: number;
  /** `index` as given, `reading` top-to-bottom then left-to-right, `radial` outward from `origin` (default the centre). */
  order?: ResolveOrder;
  /** Radial origin in stage shares; default the centre of the regions' bounding box. */
  origin?: Point2;
  /** Radial: bucket distances into rings this wide (stage shares) so a field resolves ring by ring. */
  ring?: number;
  /** Frames the placeholder grows from a point to its rect before it resolves; 0 shows it whole at once. */
  grow?: number;
  /** Frames from placeholder to content. */
  dissolve: number;
  /** Frames the placeholder holds whole between growing and dissolving. */
  hold?: number;
};

/** One region's schedule: `at` it appears (and starts growing), `growEnd` it is whole, `resolveAt` it starts dissolving, `resolveEnd` it is content. */
export type ResolveEntry = { at: number; growEnd: number; resolveAt: number; resolveEnd: number };

const centreOf = (r: Rect): Point2 => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/** Start offsets (frames from `start`) per region, in the chosen order. */
export const resolveDelays = (
  regions: readonly Rect[],
  options: Pick<ResolveOptions, "step" | "order" | "origin" | "ring">,
): number[] => {
  const n = regions.length;
  if (n === 0) return [];
  const order = options.order ?? "index";
  if (order === "radial")
    return stagger(n, {
      kind: "radial",
      step: options.step,
      points: regions.map(centreOf),
      origin: options.origin,
      ring: options.ring,
    });
  if (order === "reading") {
    // Rows are bands of similar top edge (within half the smallest height), then left to right.
    const band = Math.max(1e-6, Math.min(...regions.map((r) => r.h)) / 2);
    const rank = regions
      .map((_, i) => i)
      .sort(
        (a, b) =>
          Math.floor(regions[a]!.y / band) - Math.floor(regions[b]!.y / band) || regions[a]!.x - regions[b]!.x || a - b,
      );
    return regions.map((_, i) => rank.indexOf(i) * options.step);
  }
  return stagger(n, { kind: "index", step: options.step });
};

/** The schedule of every region: when it appears, is whole, starts and ends its dissolve into content. */
export const resolvePlan = (regions: readonly Rect[], options: ResolveOptions): ResolveEntry[] => {
  const grow = Math.max(0, options.grow ?? 0);
  const hold = Math.max(0, options.hold ?? 0);
  return resolveDelays(regions, options).map((d) => {
    const at = options.start + d;
    const growEnd = at + grow;
    const resolveAt = growEnd + hold;
    return { at, growEnd, resolveAt, resolveEnd: resolveAt + Math.max(0, options.dissolve) };
  });
};

/**
 * A region's state at a frame: `shown` 0 before it appears, `grow` 0..1 on power2.inOut (the nexaa measure),
 * `resolve` 0..1 linear (placeholder to content).
 */
export const resolveState = (
  frame: number,
  entry: ResolveEntry,
): { shown: boolean; grow: number; resolve: number } => ({
  shown: frame >= entry.at,
  grow:
    entry.growEnd > entry.at
      ? easeWindow(frame, entry.at, entry.growEnd - entry.at, "power2.inOut")
      : frame >= entry.at
        ? 1
        : 0,
  resolve: lin(frame, entry.resolveAt, entry.resolveEnd - entry.resolveAt),
});

/** The rect a region occupies while it grows from `from` (a point in stage shares, default its own left-middle) to itself. */
export const growRectFrom = (rect: Rect, grow: number, from?: Point2): Rect => {
  const o = from ?? { x: rect.x, y: rect.y + rect.h / 2 };
  const g = clamp01(grow);
  return { x: o.x + (rect.x - o.x) * g, y: o.y + (rect.y - o.y) * g, w: rect.w * g, h: rect.h * g };
};

/** Last frame any region is still resolving. */
export const resolveEndOf = (plan: readonly ResolveEntry[]): number =>
  plan.reduce((m, e) => Math.max(m, e.resolveEnd), 0);

// ---------------------------------------------------------------------------------------------------------------------
// ui-check-list

/** nexaa (measured at 24 fps): card settles in 6 f, circles fill in 3-4 f, rows 9 then 7 f apart; at 30 fps 8, 4, 11 and 9. */
export const CHECK_SETTLE = 8;
export const CHECK_FILL = 4;
export const CHECK_GAPS = [11, 9] as const;

/**
 * Frame each row's circle starts to fill. `gaps` are the frames between successive rows; the last gap repeats
 * for longer lists (the default 11, 9, 9 ... is the nexaa measure at 30 fps).
 */
export const checkSchedule = (rows: number, at: number, gaps: readonly number[] = CHECK_GAPS): number[] => {
  const out: number[] = [];
  let t = at;
  for (let i = 0; i < rows; i++) {
    out.push(t);
    t += gaps.length ? (gaps[Math.min(i, gaps.length - 1)] ?? 7) : 7;
  }
  return out;
};

/** A clock wipe's swept angle in degrees (0..360), linear over `fill` frames from `at`. */
export const clockSweep = (frame: number, at: number, fill = CHECK_FILL): number => 360 * lin(frame, at, fill);

/** Tick stroke drawn 0..1 after the circle is full, over `frames`. */
export const tickDraw = (frame: number, at: number, fill = CHECK_FILL, frames = 3): number =>
  lin(frame, at + fill - 1, frames);

// ---------------------------------------------------------------------------------------------------------------------
// ui-annotate

/** Reading order of points: rows by `band` (stage shares), then left to right. Returns the rank of each point. */
export const readingRank = (points: readonly Point2[], band = 0.06): number[] => {
  const order = points
    .map((_, i) => i)
    .sort(
      (a, b) =>
        Math.floor(points[a]!.y / band) - Math.floor(points[b]!.y / band) || points[a]!.x - points[b]!.x || a - b,
    );
  return points.map((_, i) => order.indexOf(i));
};

/**
 * airform: boxes arrive whole, a few per frame, in reading order over about 4 frames (steps(1)): item `i` appears on
 * `at + floor(rank * span / count)`. `span` 0 shows them all on `at`.
 */
export const buildFrames = (points: readonly Point2[], at: number, span = 4, band = 0.06): number[] => {
  const rank = readingRank(points, band);
  const n = Math.max(1, points.length);
  return rank.map((r) => at + Math.floor((r * span) / n));
};

/** A dimension label for a box measured in stage pixels, e.g. "314×211". */
export const dimensionLabel = (w: number, h: number): string => `${Math.round(w)}×${Math.round(h)}`;

/** A coordinate label for a point in stage pixels, e.g. "x: 412 y: 208". */
export const coordinateLabel = (x: number, y: number): string => `x: ${Math.round(x)} y: ${Math.round(y)}`;

/** Seeded per-frame jitter in stage pixels, held for `hold` frames (the boxes that shift slightly frame to frame). */
export const holdJitter = (frame: number, seed: string, amount: number, hold = 2): Point2 => {
  if (amount <= 0) return { x: 0, y: 0 };
  const k = Math.floor(frame / Math.max(1, hold));
  return { x: (random(`${seed}-jx-${k}`) - 0.5) * 2 * amount, y: (random(`${seed}-jy-${k}`) - 0.5) * 2 * amount };
};

// ---------------------------------------------------------------------------------------------------------------------
// ui-card-grid

/** Grid cells (stage shares) for `count` cards in `cols` columns inside `area`, with `gap` between cells. */
export const gridCells = (count: number, cols: number, area: Rect, gap = 0.02): Rect[] => {
  const c = Math.max(1, Math.min(cols, count));
  const rows = Math.max(1, Math.ceil(count / c));
  const w = (area.w - gap * (c - 1)) / c;
  const h = (area.h - gap * (rows - 1)) / rows;
  return Array.from({ length: count }, (_, i) => ({
    x: area.x + (i % c) * (w + gap),
    y: area.y + Math.floor(i / c) * (h + gap),
    w,
    h,
  }));
};

/** postiz: cards about 4 f apart, from about 0.3 of their size, back.out; the travel lasts `frames`. */
export const FANOUT_STEP = 4;
export const FANOUT_FROM = 0.3;
export const FANOUT_FRAMES = 9;

/**
 * Pose of fanned card `i`: it starts at `from` scale centred on the source rect and travels to its cell on back.out.
 * Returns the rect it occupies (stage shares) and its opacity (on in 2 f).
 */
export const fanoutPose = (
  frame: number,
  i: number,
  source: Rect,
  cell: Rect,
  opts: { at: number; step?: number; frames?: number; fromScale?: number },
) => {
  const at = opts.at + i * (opts.step ?? FANOUT_STEP);
  const t = easeWindow(frame, at, opts.frames ?? FANOUT_FRAMES, "back.out");
  const s0 = opts.fromScale ?? FANOUT_FROM;
  const sc = centreOf(source);
  const cc = centreOf(cell);
  const scale = s0 + (1 - s0) * t;
  const cx = sc.x + (cc.x - sc.x) * t;
  const cy = sc.y + (cc.y - sc.y) * t;
  return {
    rect: { x: cx - (cell.w * scale) / 2, y: cy - (cell.h * scale) / 2, w: cell.w * scale, h: cell.h * scale },
    opacity: lin(frame, at, 2),
    started: frame >= at,
  };
};

/** postiz: a chip every ~0.5 s in cursor order; the outline pulse covers the last 5 frames. */
export const STATUS_GAP = 15;
export const OUTLINE_FRAMES = 5;

/** Frames each card's chip lands, in the given cursor order (card indices), `gap` apart from `at`. */
export const statusSchedule = (count: number, at: number, gap = STATUS_GAP, order?: readonly number[]): number[] => {
  const seq = order && order.length ? order : Array.from({ length: count }, (_, i) => i);
  const out = Array.from({ length: count }, () => Number.POSITIVE_INFINITY);
  seq.forEach((card, k) => {
    if (card >= 0 && card < count && !Number.isFinite(out[card]!)) out[card] = at + k * gap;
  });
  return out;
};

// ---------------------------------------------------------------------------------------------------------------------
// chip-wall

export type WallChip = { label: string; col: number; row: number; width: number };

/**
 * A seeded wall: `cols` x `rows` slots, each a label from `labels[1..]` (cycled, then shuffled by `seed`), with a seeded
 * width share between 0.6 and 1 for callers that draw fixed-width chips. Only the chip at `pick` carries `labels[0]`.
 */
export const chipWallLayout = (
  labels: readonly string[],
  cols: number,
  rows: number,
  seed: string,
  pick: number,
): WallChip[] => {
  const n = cols * rows;
  const pool = labels.length ? labels : ["Label"];
  const others = pool.length > 1 ? pool.slice(1) : pool;
  const rest = Array.from({ length: n }, (_, i) => others[i % others.length]!);
  const shuffled = rest
    .map((l, i) => ({ l, k: random(`${seed}-chip-${i}`) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.l);
  return Array.from({ length: n }, (_, i) => ({
    label: i === pick ? pool[0]! : shuffled[i]!,
    col: i % cols,
    row: Math.floor(i / cols),
    width: 0.6 + 0.4 * random(`${seed}-w-${i}`),
  }));
};

/** firecrawl (measured at 60 fps): the push's speed ramps up over 5 of its frames, then halves about every 15; at 30 fps that is 3 and 7.5. */
export const PUSH_RAMP = 3;
export const PUSH_HALF_LIFE = 7.5;

/**
 * Normalised push progress 0..1 at `frame`: speed rises linearly for `ramp` frames, then decays with half-life
 * `halfLife`; the curve is the integral, normalised so it reaches 1 at `frames`.
 */
export const pushProgress = (
  frame: number,
  at: number,
  frames: number,
  ramp = PUSH_RAMP,
  halfLife = PUSH_HALF_LIFE,
): number => {
  const k = Math.LN2 / Math.max(1e-6, halfLife);
  const integral = (t: number) => {
    if (t <= 0) return 0;
    const r = Math.max(1e-6, ramp);
    if (t <= r) return (t * t) / (2 * r);
    return r / 2 + (1 - Math.exp(-k * (t - r))) / k;
  };
  const total = integral(frames);
  return clamp01(integral(frame - at) / total);
};

/**
 * firecrawl re-measured (F1088-F1168 at 60 fps, row pitch of the wall by autocorrelation, 39 px to 124 px): the push's
 * share done, a 30-fps frame apart from F1096, is 0.05 after 2, 0.13 after 4, 0.24 after 6, 0.47 after 10, 0.69 after 14,
 * 0.84 after 18, 0.92 after 22, 0.98 after 28. The first 3-frame ramp reads too early (0.21 after 4); a 6-frame ramp,
 * a 9-frame half-life over 26 frames fits within 0.02 (least squares). Spread into chip-wall's props.
 */
export const chipWallFirecrawlPush = { pushFrames: 26, pushRamp: 6, pushHalfLife: 9 } as const;

/** firecrawl: every chip but one fades over about 1.3 s. */
export const ISOLATE_FRAMES = 39;

/** Opacity of a non-picked chip during the isolate: a seeded order inside the fade so the wall thins, not dims evenly. */
export const isolateOpacity = (frame: number, at: number, frames: number, seed: string, index: number): number => {
  const offset = random(`${seed}-iso-${index}`) * 0.5;
  return 1 - lin(frame, at + offset * frames, frames * 0.5);
};

// ---------------------------------------------------------------------------------------------------------------------
// ui-data-table: pinned row and row sheen (polymarket)

/** Position 0..1 of a soft band along a row: on power2.out over `frames` from `at`; outside the window it is hidden. */
export const sheenAt = (frame: number, at: number, frames: number): { x: number; visible: boolean } => ({
  x: easeWindow(frame, at, frames, "power2.out"),
  visible: frame >= at && frame < at + frames,
});

// ---------------------------------------------------------------------------------------------------------------------
// ui-ai-chat: typing pill to card (muse)

/** muse: pill fills 2 f, stretches to 0.30 W in 6 f (power3.out), card wipes through in 5 f with a soft edge, close to linear (strip m17). */
export const PILL_FILL = 2;
export const PILL_STRETCH = 6;
export const PILL_WIPE = 5;
export const PILL_TYPING = 12;

/** Frames of the pill morph, with `answerAt` the frame the card is fully wiped (the reply's lines start there). */
export const pillTiming = (answerAt: number, typing = PILL_TYPING) => {
  const wipeAt = answerAt - PILL_WIPE;
  const stretchAt = wipeAt - PILL_STRETCH;
  const fillAt = stretchAt - PILL_FILL;
  return { typingAt: fillAt - typing, fillAt, stretchAt, wipeAt, answerAt };
};

/** Pill state at a frame: `fill` 0..1, `stretch` 0..1 (power3.out), `wipe` 0..1 (linear: the strip shows the blue still on the right two frames before the end). */
export const pillState = (frame: number, answerAt: number, typing = PILL_TYPING) => {
  const t = pillTiming(answerAt, typing);
  return {
    ...t,
    shown: frame >= t.typingAt,
    fill: lin(frame, t.fillAt, PILL_FILL),
    stretch: easeWindow(frame, t.stretchAt, PILL_STRETCH, "power3.out"),
    wipe: easeWindow(frame, t.wipeAt, PILL_WIPE, "linear"),
  };
};

// ---------------------------------------------------------------------------------------------------------------------
// ui-prompt-bar: scale jump (ugc-app)

/** ugc-app: the bar drops away and the text re-sets at about 3.5x, centred, on one frame. */
export const JUMP_SCALE = 3.5;

/** Font size after the jump: `scale` times the bar's, but no wider than `maxWidth` for a text of `chars` characters. */
export const jumpFontSize = (
  barFont: number,
  chars: number,
  maxWidth: number,
  scale = JUMP_SCALE,
  advance = 0.52,
): number => Math.min(barFont * scale, maxWidth / Math.max(1, chars * advance));
