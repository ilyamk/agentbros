/**
 * Pure schedules for frame-exact flash, montage and ring blocks: grade steps around a cut, montage cadences with a
 * photosensitivity cap, accelerating cut lists, a halftone screen, a doubling counter and orbit-ring points. No JSX and
 * no browser: tests import this file directly. Every value is a function of the frame (and a seed where it varies).
 *
 * Measured in professional references (design-reference/library/<id>/techniques.json): airform grade-step-on-held-plate
 * (mono 3f, negative 2f, cream duotone with fringe 2f, cut, incoming negative 1f), flex and airform flash montages
 * (4-frame plates under one caption), gojiberry doubling-counter-montage (holds 1.47 s down to 1 frame, the counter
 * rolling 4–5 frames, 1–3 frames after the cut), motionfly orbit ring (expands off the frame in 12 frames, power2.in).
 */
import { random } from "remotion";

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));

// --- Photosensitivity budget ---

/** WCAG 2.3.1 allows three flashes (six opposing transitions) in any one second; src/lib/sensors/flash.ts measures it. */
export const MAX_CHANGES_PER_SECOND = 6;

/**
 * Most picture changes inside any window of `window` frames. A change is a frame where the whole picture swaps (a cut,
 * a grade step). Each change can be at most one luminance transition per area, so a schedule with no more than six
 * changes per second can never fail FLASH_RISK, whatever the plates are.
 */
export const maxChangesPerWindow = (changes: readonly number[], window = 30): number => {
  const sorted = [...new Set(changes)].sort((a, b) => a - b);
  let most = 0;
  let from = 0;
  for (let to = 0; to < sorted.length; to++) {
    while (sorted[to]! - sorted[from]! >= window) from++;
    most = Math.max(most, to - from + 1);
  }
  return most;
};

// --- Grade steps around a cut ---

export const GRADES = [
  "none",
  "mono",
  "negative",
  "polarity",
  "duotone",
  "halftone",
  "ground",
  "bleach",
  "wave",
  "darken",
  "matte",
  "colour",
] as const;
export type Grade = (typeof GRADES)[number];
/**
 * One whole-frame grade held for `frames` frames; `fringe` adds an RGB split on that step. The later grades:
 * - `bleach`: white over the plate at near full on the step's first frame, decaying over its other frames (`bleachLevel`).
 * - `wave`: horizontal sine displacement in bands (`waveOffsets`), usually with `fringe`.
 * - `darken`: the subject darkened on near black.
 * - `matte`: the subject alone, tinted `ink` on `ground` (`matteRoute`). Either `src`, a picture drawn in place of the
 *   plate (white subject on black, e.g. x-ray artwork), or `matteSrc`, the plate subject's alpha cut-out (a PNG the
 *   plate's size, transparent around the subject), which masks the plate itself: the subject is shown as its own
 *   negative in the two tokens. With neither it falls back to `darken`, since the look needs a real per-subject matte.
 * - `colour`: any `ground` and `ink` for the step: with `content` the plate is mapped dark to `ground`, light to `ink`;
 *   without it the frame is the flat `ground` (a content-free flash).
 */
export type GradeStep = {
  grade: Grade;
  frames: number;
  fringe?: boolean;
  ground?: string;
  ink?: string;
  content?: boolean;
  src?: string;
  matteSrc?: string;
};
export type GradeSpan = {
  from: number;
  to: number;
  grade: Grade;
  fringe: boolean;
  side: "exit" | "enter";
  ground?: string;
  ink?: string;
  content?: boolean;
  src?: string;
  matteSrc?: string;
};

/** The optional look fields of a step, carried onto its span only when set. */
const stepLook = (step: GradeStep): Pick<GradeSpan, "ground" | "ink" | "content" | "src" | "matteSrc"> => ({
  ...(step.ground !== undefined ? { ground: step.ground } : {}),
  ...(step.ink !== undefined ? { ink: step.ink } : {}),
  ...(step.content !== undefined ? { content: step.content } : {}),
  ...(step.src !== undefined ? { src: step.src } : {}),
  ...(step.matteSrc !== undefined ? { matteSrc: step.matteSrc } : {}),
});

/**
 * How a `matte` step draws: `artwork` (the `src` picture, tinted), `cutout` (the plate masked by `matteSrc`, as a tinted
 * negative) or `darken` when it has neither. `src` wins when both are set. Pure.
 */
export const matteRoute = (step: { src?: string; matteSrc?: string }): "artwork" | "cutout" | "darken" =>
  step.src ? "artwork" : step.matteSrc ? "cutout" : "darken";

/** The measured exit of airform F71–F78: monochrome 3 frames, negative 2, cream duotone with fringe 2, then the cut. */
export const AIRFORM_EXIT: GradeStep[] = [
  { grade: "mono", frames: 3 },
  { grade: "negative", frames: 2 },
  { grade: "duotone", frames: 2, fringe: true },
];
/** The incoming plate's first frame, negative (airform F78). */
export const AIRFORM_ENTER: GradeStep[] = [{ grade: "negative", frames: 1 }];

/** paper-style parts-converge-flash (F716-F719): the new picture enters under a white flash, 1 frame near white, back over 2. */
export const PAPER_BLEACH_ENTER: GradeStep[] = [{ grade: "bleach", frames: 3 }];

/** abdulah t10-glitch-exit (F634-F640): dot screen 1, plate 1, dot screen 2, wave with RGB split 2, then the cut. */
export const ABDULAH_WAVE_EXIT: GradeStep[] = [
  { grade: "halftone", frames: 1 },
  { grade: "none", frames: 1 },
  { grade: "halftone", frames: 2 },
  { grade: "wave", frames: 2, fringe: true },
];

/** gojiberry flash-frame-subject-swap: the outgoing subject darkened on near black for 4 frames before the swap (F492-F495). */
export const GOJIBERRY_DARK_EXIT: GradeStep[] = [{ grade: "darken", frames: 4 }];

/**
 * gojiberry flash-frame-subject-swap (F644-F647): 4 frames of a cyan subject matte on dark, the x-ray. `src` must be a
 * matte of this subject (white on black); without one the step renders `darken`.
 */
export const gojiberryXrayExit = (src: string): GradeStep[] => [
  { grade: "matte", frames: 4, src, ink: "#62E6F2", ground: "#04080D" },
];

/**
 * The same 4 cyan frames from the plate's own subject: `matteSrc` is its alpha cut-out (inside public/, the plate's
 * size). The subject shows as a cyan negative on dark, which reads close to gojiberry's x-ray but is not a skeleton.
 * Make the PNG with `pnpm matte --input <plate> --out <dir>` (free, local, docs/matte.md); `pnpm rmbg` is the paid route.
 */
export const gojiberryXrayFromCutout = (matteSrc: string): GradeStep[] => [
  { grade: "matte", frames: 4, matteSrc, ink: "#62E6F2", ground: "#04080D" },
];

/**
 * nowakdesign polarity-strobe-title (F0-F25): three 3-frame content-free flashes (navy, black, white), black 2, the tiny
 * title on black 5, the whole frame inverted to white with faint tinted type 7, back 1, an RGB-split smear 2, clean
 * from F26. Every change is a hard frame swap. The navy-to-black step is under 10% luminance, so the sequence is two
 * general flashes (white in, white out, twice): within WCAG 2.3.1, though its cut count is over six a second.
 */
export const NOWAK_STROBE_ENTER: GradeStep[] = [
  { grade: "colour", frames: 3, ground: "#0B1A5C", content: false },
  { grade: "colour", frames: 3, ground: "#000000", content: false },
  { grade: "colour", frames: 3, ground: "#F3F3F1", content: false },
  { grade: "colour", frames: 2, ground: "#000000", content: false },
  { grade: "none", frames: 5 },
  { grade: "colour", frames: 7, ground: "#F3F3F1", ink: "#C9BEDF", content: true },
  { grade: "none", frames: 1 },
  { grade: "none", frames: 2, fringe: true },
];

/**
 * Frame spans of every step: exit steps end exactly on `exitAt` (the cut, the first frame the plate is gone) and enter
 * steps start on `enterAt`. `to` is exclusive. A value below 0 turns that side off.
 */
export const gradeSchedule = ({
  exitAt,
  exit,
  enterAt,
  enter,
}: {
  exitAt: number;
  exit: readonly GradeStep[];
  enterAt: number;
  enter: readonly GradeStep[];
}): GradeSpan[] => {
  const spans: GradeSpan[] = [];
  if (enterAt >= 0) {
    let frame = enterAt;
    for (const step of enter) {
      spans.push({
        from: frame,
        to: frame + step.frames,
        grade: step.grade,
        fringe: !!step.fringe,
        side: "enter",
        ...stepLook(step),
      });
      frame += step.frames;
    }
  }
  if (exitAt >= 0) {
    let frame = exitAt - exit.reduce((sum, step) => sum + step.frames, 0);
    for (const step of exit) {
      spans.push({
        from: Math.max(0, frame),
        to: frame + step.frames,
        grade: step.grade,
        fringe: !!step.fringe,
        side: "exit",
        ...stepLook(step),
      });
      frame += step.frames;
    }
  }
  return spans.filter((span) => span.to > span.from).sort((a, b) => a.from - b.from);
};

/** The step showing on `frame`, or undefined for the plate's own grade. */
export const gradeAt = (spans: readonly GradeSpan[], frame: number): GradeSpan | undefined =>
  spans.find((span) => frame >= span.from && frame < span.to);

/** Peak white of a bleach step: near full, so the plate still ghosts through on its first frame. */
export const BLEACH_PEAK = 0.92;

/**
 * White over the plate on frame `local` (0-based) of a `frames`-long bleach step: BLEACH_PEAK on the first frame, then
 * decaying (power 1.5) to nothing by the step's end. paper-style parts-converge-flash: 1 frame near white, back over 2.
 */
export const bleachLevel = (local: number, frames: number): number => {
  if (local < 0 || local >= frames) return 0;
  return BLEACH_PEAK * (1 - local / Math.max(1, frames)) ** 1.5;
};

/**
 * Sideways offsets (share of width, signed) of `bands` horizontal bands on frame `local` of a wave step: one sine of
 * `cycles` periods down the frame, its phase advancing `speed` radians a frame. abdulah t10: 2 frames, then the cut.
 */
export const waveOffsets = (
  local: number,
  {
    bands = 24,
    amplitude = 0.035,
    cycles = 2.5,
    speed = 1.9,
  }: { bands?: number; amplitude?: number; cycles?: number; speed?: number } = {},
): number[] =>
  Array.from(
    { length: bands },
    (_, band) => amplitude * Math.sin((2 * Math.PI * cycles * (band + 0.5)) / bands + speed * local),
  );

/** Frames where the picture changes: every step start, every step end that returns to the plate, and the cut. */
export const gradeChanges = (spans: readonly GradeSpan[], exitAt = -1): number[] => {
  const changes = new Set<number>();
  for (const span of spans) {
    changes.add(span.from);
    if (!spans.some((other) => other.from === span.to)) changes.add(span.to);
  }
  if (exitAt >= 0) changes.add(exitAt);
  return [...changes].sort((a, b) => a - b);
};

/**
 * Horizontal offsets (share of width, signed) of `bands` slices on `frame` of a slice glitch that starts on `at` and
 * lasts `frames`: the largest `offset` on the first frame, resolving to 0 in steps of `hold` frames (no tween). With
 * `chaos` 0 each band keeps its side and only shrinks, so every area of the frame changes in one direction and the
 * glitch costs about one flash; `chaos` 1 re-rolls every band on every step, the jumping look of the references
 * (gojiberry polarity-slice-glitch: 5–30% of width, resolving in 10–12 frames), which needs motion:check FLASH_RISK.
 */
export const sliceOffsets = (
  frame: number,
  {
    at,
    frames,
    bands,
    offset,
    seed,
    hold = 2,
    chaos = 0,
  }: { at: number; frames: number; bands: number; offset: number; seed: string; hold?: number; chaos?: number },
): number[] => {
  const local = frame - at;
  if (at < 0 || local < 0 || local >= frames) return Array.from({ length: bands }, () => 0);
  const step = Math.floor(local / Math.max(1, hold));
  const steps = Math.ceil(frames / Math.max(1, hold));
  const decay = 1 - step / steps;
  return Array.from({ length: bands }, (_, band) => {
    // A third of the bands stay put, so the plate still reads.
    if (random(`${seed}-still-${band}`) < 0.33) return 0;
    const side = random(`${seed}-side-${band}`) < 0.5 ? -1 : 1;
    const base = side * (0.35 + 0.65 * random(`${seed}-size-${band}`));
    const jump = random(`${seed}-${band}-${step}`) * 2 - 1;
    return (base * (1 - chaos) + jump * chaos) * offset * decay;
  });
};

// --- Montage cadence ---

/** Start frame of every plate from its hold lengths. */
export const cadenceStarts = (holds: readonly number[], at = 0): number[] => {
  const starts: number[] = [];
  let frame = at;
  for (const hold of holds) {
    starts.push(frame);
    frame += hold;
  }
  return starts;
};

/**
 * Lengthens holds as little as possible, front to back, so that no window of `fps` frames holds more than `maxChanges`
 * cuts: the photosensitivity-safe cadence. The first plate's start counts as a cut (it replaces whatever came before).
 */
export const safeHolds = (
  holds: readonly number[],
  fps = 30,
  maxChanges = MAX_CHANGES_PER_SECOND,
  at = 0,
): number[] => {
  const out = holds.map((hold) => Math.max(1, Math.round(hold)));
  const starts = cadenceStarts(out, at);
  // Every cut after the first is checked against the cut maxChanges before it.
  for (let i = maxChanges; i < starts.length; i++) {
    const earliest = starts[i - maxChanges]! + fps;
    if (starts[i]! < earliest) {
      const shift = earliest - starts[i]!;
      out[i - 1] = out[i - 1]! + shift;
      for (let j = i; j < starts.length; j++) starts[j] = starts[j]! + shift;
    }
  }
  return out;
};

/** The cadence a montage plays: `safeHolds` when `flashSafe`, otherwise the holds as given. */
export const montageHolds = (
  holds: readonly number[],
  { flashSafe, fps = 30, at = 0 }: { flashSafe: boolean; fps?: number; at?: number },
): number[] =>
  flashSafe ? safeHolds(holds, fps, MAX_CHANGES_PER_SECOND, at) : holds.map((hold) => Math.max(1, Math.round(hold)));

/** Index of the plate showing on `frame` (-1 before the first). */
export const plateAt = (starts: readonly number[], frame: number): number => {
  let index = -1;
  for (let i = 0; i < starts.length; i++) if (frame >= starts[i]!) index = i;
  return index;
};

/**
 * Hold lengths that shrink geometrically from `first` to `floor` frames over `count` shots (an accelerando cut list):
 * the shape of gojiberry's 44, 46, 26, 19, 14 ... 2 frames.
 */
export const accelerandoHolds = (first: number, floor: number, count: number): number[] => {
  if (count <= 1) return [Math.max(1, Math.round(first))];
  const ratio = (floor / first) ** (1 / (count - 1));
  return Array.from({ length: count }, (_, i) => Math.max(floor, Math.round(first * ratio ** i)));
};

/** The gojiberry doubling montage, measured 6.733–14.067 s: twenty holds in frames (1.47 s ... 0.03 s). */
export const GOJIBERRY_HOLDS = [44, 46, 26, 19, 14, 13, 14, 8, 5, 4, 4, 4, 4, 3, 3, 2, 3, 1, 1, 3];

// --- Doubling counter ---

/**
 * The counter on `frame`: cut i (at starts[i]) doubles it from start × 2^(i-1) to start × 2^i, rolling linearly over
 * `roll` frames that begin `lead` frames after the cut, so the subject arrives first. Rolls that overlap chain.
 */
export const doublingValue = (
  frame: number,
  starts: readonly number[],
  { start = 1, lead = 2, roll = 4 }: { start?: number; lead?: number; roll?: number } = {},
): number => {
  let exponent = 0;
  for (let i = 1; i < starts.length; i++) {
    const t0 = starts[i]! + lead;
    if (frame < t0) break;
    exponent = i - 1 + clamp01((frame - t0 + 1) / Math.max(1, roll));
  }
  const whole = Math.floor(exponent);
  const lower = start * 2 ** whole;
  return lower + (lower * 2 - lower) * (exponent - whole);
};

/** Frames where the counter's roll lands (the hit sounds there). */
export const doublingLands = (
  starts: readonly number[],
  { lead = 2, roll = 4 }: { lead?: number; roll?: number } = {},
): number[] => starts.slice(1).map((start) => start + lead + roll - 1);

// --- Halftone screen ---

/**
 * The dot screen on `frame`: cell size in pixels (scaled from a 1080-px frame), its angle, and the screen's offset
 * after `push` pixels a frame along the angle (a crawling screen; 0 holds it still). The offset wraps at one cell so
 * the numbers stay small; the picture is the same.
 */
export const halftoneScreen = (
  frame: number,
  { dotSize, angle, push, unit = 1 }: { dotSize: number; angle: number; push: number; unit?: number },
): { cell: number; angle: number; x: number; y: number } => {
  const cell = Math.max(2, dotSize * unit);
  const travel = (frame * push * unit) % cell;
  const radians = (angle * Math.PI) / 180;
  return { cell, angle, x: travel * Math.cos(radians), y: travel * Math.sin(radians) };
};

/**
 * Radius of the dot an ink of `darkness` (0 paper .. 1 solid) prints in a cell of `cell` pixels: area grows with
 * darkness, and at 1 the dots meet (the farthest-corner radius). The block draws this with a radial ramp and a hard
 * threshold; this is the same law for tests and for code that draws dots itself.
 */
export const halftoneDotRadius = (darkness: number, cell: number): number =>
  (Math.SQRT2 * cell * clamp01(darkness)) / 2;

/** One ink pair of a halftone colour cycle: dot colour and ground. */
export type HalftoneInk = { ink: string; ground: string };

/**
 * Fewest frames an ink may hold in a colour cycle: each swap can change the whole screen's tone, so a cycle no faster than
 * one swap per 5 frames stays within six changes a second (MAX_CHANGES_PER_SECOND) whatever the inks are.
 */
export const MIN_INK_HOLD = 5;

/**
 * The ink pair showing on `frame` of a cycle that swaps every `every` frames from `at` (steps(1), no blend), or undefined
 * when there is no cycle or before it starts. `every` is clamped to MIN_INK_HOLD.
 */
export const halftoneInkAt = (
  frame: number,
  inks: readonly HalftoneInk[],
  every: number,
  at = 0,
): HalftoneInk | undefined => {
  if (!inks.length || frame < at) return undefined;
  const hold = Math.max(MIN_INK_HOLD, Math.round(every));
  return inks[Math.floor((frame - at) / hold) % inks.length];
};

/** Frames where a halftone ink cycle swaps colour, inside [0, frames). */
export const halftoneInkChanges = (inks: readonly HalftoneInk[], every: number, frames: number, at = 0): number[] => {
  if (inks.length < 2) return [];
  const hold = Math.max(MIN_INK_HOLD, Math.round(every));
  const out: number[] = [];
  for (let f = at + hold; f < frames; f += hold) out.push(f);
  return out;
};

/**
 * abdulah t13-dot-screen-treatment (25.73-26.73 s): the plate as a coarse dot screen on black, its dot colour changing at
 * F772, F782 and F792 (every 10 frames, steps(1)): yellow, magenta, grey.
 */
export const ABDULAH_INKS: HalftoneInk[] = [
  { ink: "#F5D90A", ground: "#050505" },
  { ink: "#F0359A", ground: "#050505" },
  { ink: "#9C9C9C", ground: "#050505" },
];

// --- Orbit ring ---

export type OrbitPoint = { x: number; y: number; z: number; scale: number; row: number; index: number; glow: number };

/**
 * Points of `rows` concentric rings of `count` dots, on a ring of `radius` px tipped back by `tilt` degrees and rolled
 * by `roll`, turned by `angle` degrees. x, y are offsets from the centre in px after perspective; z > 0 is in front of
 * the subject. `glow` is a seeded brightness 0.35..1 that re-rolls every `twinkle` frames (0 holds it).
 */
export const orbitPoints = (
  frame: number,
  {
    count,
    rows,
    radius,
    rowGap,
    tilt,
    roll,
    angle,
    seed,
    twinkle = 0,
    perspective = 2.6,
  }: {
    count: number;
    rows: number;
    radius: number;
    rowGap: number;
    tilt: number;
    roll: number;
    angle: number;
    seed: string;
    twinkle?: number;
    perspective?: number;
  },
): OrbitPoint[] => {
  const points: OrbitPoint[] = [];
  const tiltR = (tilt * Math.PI) / 180;
  const rollR = (roll * Math.PI) / 180;
  const focal = radius * perspective;
  const step = twinkle > 0 ? Math.floor(frame / twinkle) : 0;
  for (let row = 0; row < rows; row++) {
    const r = radius * (1 + (row - (rows - 1) / 2) * rowGap);
    // Each row is offset half a cell so the matrix reads as cells, not spokes.
    const phase = ((row % 2) * 0.5 * 360) / count;
    for (let index = 0; index < count; index++) {
      const theta = ((angle + phase + (index * 360) / count) * Math.PI) / 180;
      const x0 = r * Math.cos(theta);
      const y0 = r * Math.sin(theta) * Math.cos(tiltR);
      const z = r * Math.sin(theta) * Math.sin(tiltR);
      const scale = focal / Math.max(1, focal - z);
      const x1 = x0 * scale;
      const y1 = y0 * scale;
      points.push({
        x: x1 * Math.cos(rollR) - y1 * Math.sin(rollR),
        y: x1 * Math.sin(rollR) + y1 * Math.cos(rollR),
        z,
        scale,
        row,
        index,
        glow: 0.35 + 0.65 * random(`${seed}-${row}-${index}-${step}`),
      });
    }
  }
  return points;
};

// --- Measured montage cadences ---

/** flex t11 (23.867–25.733 s): a lead plate, five flashes of 4/4/4/3/4 frames, a landing held 37. The lead is ours. */
export const FLEX_MONTAGE_HOLDS = [18, 4, 4, 4, 3, 4, 37];
/** airform flash montage (3.533–5.367 s): a 9-frame lead, ten plates of exactly 4 frames, a 6-frame plate. Over six cuts a second: needs plates close in tone or flashSafe. */
export const AIRFORM_MONTAGE_HOLDS = [9, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 6];
/** nowakdesign caption-anchor-footage-stutter (6.233–8.0 s): 3, 3, 5, 6, 4, 4, 4, 4, 20 frames. */
export const NOWAK_STUTTER_HOLDS = [3, 3, 5, 6, 4, 4, 4, 4, 20];
/** The gojiberry holds with a 40-frame landing in place of the last 3 frames: the doubling montage default. */
export const DOUBLING_DEFAULT_HOLDS = [...GOJIBERRY_HOLDS.slice(0, -1), 40];

/**
 * Reel positions (one per column, most significant first) of a doubling counter on `frame`: on each roll every column
 * turns forward from its old digit to its new one (0–9 steps, linear over `roll` frames), as mechanical reels do, so the
 * counter never shows the numbers in between (the reference reads 64, a blur, 128). `shown` is the settled value the
 * reels are leaving or have reached, and `visible` how many columns carry a digit.
 */
export const doublingReels = (
  frame: number,
  starts: readonly number[],
  columns: number,
  { start = 1, lead = 2, roll = 4 }: { start?: number; lead?: number; roll?: number } = {},
): { reels: number[]; visible: number; shown: number } => {
  let from = start;
  let to = start;
  let t = 1;
  for (let i = 1; i < starts.length; i++) {
    const t0 = starts[i]! + lead;
    if (frame < t0) break;
    from = start * 2 ** (i - 1);
    to = start * 2 ** i;
    t = clamp01((frame - t0 + 1) / Math.max(1, roll));
  }
  const digits = (value: number) =>
    String(Math.floor(value)).padStart(columns, "0").slice(-columns).split("").map(Number);
  const a = digits(from);
  const b = digits(to);
  const reels = a.map((d, c) => (d + ((b[c]! - d + 10) % 10) * t) % 10);
  const shown = t >= 1 ? to : from;
  return { reels, visible: String(Math.floor(t > 0 ? to : from)).length, shown };
};

/** The grade-step-flash preview: the airform exit cuts at frame 68 and a sliced plate enters at 112 (44 frames apart, one event a second). */
export const GRADE_STEP_PREVIEW = { exitAt: 68, sliceAt: 112, sliceFrames: 11, sliceFlipFrames: 1 };
