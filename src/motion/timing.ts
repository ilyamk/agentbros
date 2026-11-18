import { Easing, random } from "remotion";
import type { AudioMap } from "../types/film";

export type Curve = (t: number) => number;

export const curves = {
  linear: (t: number) => t,
  /** Fast arrival, long settle: confident entrances. */
  expoOut: Easing.bezier(0.16, 1, 0.3, 1),
  /** Slow start, violent exit: leaving or zooming through. */
  expoIn: Easing.bezier(0.7, 0, 0.84, 0),
  /** Gentle acceleration: a block that creeps, then leaves faster each frame. */
  quadIn: (t: number) => t * t,
  /** Whips and short camera moves. */
  inOut: Easing.bezier(0.87, 0, 0.13, 1),
  /** Gentler in-out for long camera travel. */
  drift: Easing.bezier(0.45, 0, 0.55, 1),
  /** Passes the target once: objects with weight. */
  overshoot: Easing.bezier(0.34, 1.56, 0.64, 1),
  /** Pulls back before leaving. */
  anticipation: Easing.bezier(0.36, 0, 0.66, -0.56),
} satisfies Record<string, Curve>;

export type CurveName = keyof typeof curves;
export type CurveRef = CurveName | Curve;

export const resolveCurve = (curve: CurveRef = "linear"): Curve =>
  typeof curve === "function" ? curve : curves[curve];

/** Eased 0-1 progress of a window, clamped at both ends. Overshooting curves may exceed 1 inside the window. */
export const progress = (frame: number, from: number, duration: number, curve: CurveRef = "expoOut"): number => {
  if (duration <= 0) return frame >= from ? 1 : 0;
  const t = (frame - from) / duration;
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return resolveCurve(curve)(t);
};

/** `curve` shapes the segment that arrives at this key. */
export type Keyframe = { at: number; value: number; curve?: CurveRef };

const assertAscending = (keys: readonly { at: number }[]): void => {
  if (keys.length === 0) throw new Error("A track needs at least one keyframe.");
  for (let i = 1; i < keys.length; i++) {
    if (keys[i]!.at <= keys[i - 1]!.at)
      throw new Error(`Keyframes must ascend: ${keys[i - 1]!.at} then ${keys[i]!.at}.`);
  }
};

/** Holds the first value before the first key and the last value after the last key. */
export const track = (frame: number, keys: readonly Keyframe[]): number => {
  assertAscending(keys);
  const first = keys[0]!;
  if (frame <= first.at) return first.value;
  for (let i = 1; i < keys.length; i++) {
    const to = keys[i]!;
    if (frame <= to.at) {
      const from = keys[i - 1]!;
      const t = (frame - from.at) / (to.at - from.at);
      return from.value + (to.value - from.value) * resolveCurve(to.curve)(t);
    }
  }
  return keys.at(-1)!.value;
};

export type PointKeyframe = { at: number; x: number; y: number; curve?: CurveRef };

export const trackPoint = (frame: number, keys: readonly PointKeyframe[]): { x: number; y: number } => ({
  x: track(
    frame,
    keys.map(({ at, x, curve }) => ({ at, value: x, curve })),
  ),
  y: track(
    frame,
    keys.map(({ at, y, curve }) => ({ at, value: y, curve })),
  ),
});

/** Change per frame of any frame-driven value: the honest input for motion blur. */
export const velocity = (value: (frame: number) => number, frame: number): number => value(frame + 1) - value(frame);

/** Directional blur for a speed in pixels per frame. Direction does not matter; `shutter` 0.15 is near a 180 degree shutter. */
export const motionSigma = (speed: number, shutter = 0.15, maxBlur = 140): number =>
  Math.min(Math.abs(speed) * shutter, maxBlur);

export type Stagger =
  | { kind: "index"; step: number }
  | { kind: "centre"; step: number }
  | { kind: "edges"; step: number }
  | { kind: "seeded"; step: number; seed: string; jitter?: number }
  /**
   * Outward from `origin` (default: the centre of the points' bounding box). Points at the same distance start together;
   * `ring` buckets distances into bands of that width (in the points' units) so a field fills ring by ring. `inward` reverses.
   * `points` must have `count` entries.
   */
  | { kind: "radial"; step: number; points: readonly Point2[]; origin?: Point2; ring?: number; inward?: boolean };

export type Point2 = { x: number; y: number };

/** Indices of `points` ordered by distance from `origin` (default: bounding-box centre), nearest first; ties keep index order. */
export const radialOrder = (points: readonly Point2[], origin?: Point2): number[] => {
  const o = origin ?? boxCentre(points);
  const d = points.map((p) => Math.hypot(p.x - o.x, p.y - o.y));
  return points.map((_, i) => i).sort((a, b) => d[a] - d[b] || a - b);
};

const boxCentre = (points: readonly Point2[]): Point2 => {
  if (points.length === 0) return { x: 0, y: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
};

const radialDelays = (map: Extract<Stagger, { kind: "radial" }>): number[] => {
  const o = map.origin ?? boxCentre(map.points);
  const key = (p: Point2) => {
    const d = Math.hypot(p.x - o.x, p.y - o.y);
    return map.ring && map.ring > 0 ? Math.floor(d / map.ring + 1e-9) : Math.round(d * 1e6) / 1e6;
  };
  const keys = map.points.map(key);
  const levels = [...new Set(keys)].sort((a, b) => a - b);
  const last = levels.length - 1;
  return keys.map((k) => {
    const rank = levels.indexOf(k);
    return (map.inward ? last - rank : rank) * map.step;
  });
};

/** Start delays in frames for `count` items. */
export const stagger = (count: number, map: Stagger): number[] => {
  const indices = Array.from({ length: count }, (_, i) => i);
  const middle = (count - 1) / 2;
  switch (map.kind) {
    case "index":
      return indices.map((i) => i * map.step);
    case "centre":
      return indices.map((i) => Math.floor(Math.abs(i - middle)) * map.step);
    case "edges":
      return indices.map((i) => Math.floor(middle - Math.abs(i - middle)) * map.step);
    case "seeded": {
      const order = [...indices].sort((a, b) => random(`${map.seed}-order-${a}`) - random(`${map.seed}-order-${b}`));
      return indices.map((i) => order.indexOf(i) * map.step + random(`${map.seed}-jitter-${i}`) * (map.jitter ?? 0));
    }
    case "radial":
      if (map.points.length !== count)
        throw new Error(`stagger radial: ${map.points.length} points for ${count} items`);
      return radialDelays(map);
  }
};

/**
 * A flash that peaks on `at` and decays to 0 over `frames` frames (power2.out: most of it gone in the first frame or two),
 * 0 before `at` and after. The entry flash of TextBloom; any one-shot glow.
 */
export const flashDecay = (frame: number, at: number, frames: number): number => {
  if (at < 0 || frame < at || frames <= 0) return 0;
  const t = (frame - at) / frames;
  if (t >= 1) return 0;
  return (1 - t) * (1 - t);
};

/**
 * Stop-motion time: the frame held on every `step`th frame (on twos, on threes), counted from `offset`.
 * Feed the result to any frame-driven value to make one element move on steps under a smooth camera.
 */
export const onSteps = (frame: number, step: number, offset = 0): number => {
  if (!(step >= 1)) return frame;
  const s = Math.round(step);
  return Math.floor((frame - offset) / s) * s + offset;
};

export type Beat = { id: string; at: number; until?: number };
export type Cue = { id: string; at: number; from: number; to: number; durationInFrames: number };

/** Seconds to frame-accurate cues. Each position rounds from the start, so rounding never accumulates. */
export const beatCues = (fps: number, beats: readonly Beat[], endSec?: number): Cue[] => {
  assertAscending(beats.map(({ at }) => ({ at })));
  return beats.map((beat, i) => {
    const from = Math.round(beat.at * fps);
    const untilSec = beat.until ?? beats[i + 1]?.at ?? endSec;
    const to = untilSec === undefined ? from + 1 : Math.round(untilSec * fps);
    if (to <= from) throw new Error(`Cue "${beat.id}" ends before it starts.`);
    return { id: beat.id, at: beat.at, from, to, durationInFrames: to - from };
  });
};

export const beatGrid = (fps: number, bpm: number, count: number, offsetSec = 0): Cue[] =>
  beatCues(
    fps,
    Array.from({ length: count }, (_, n) => ({ id: `beat-${n}`, at: offsetSec + (n * 60) / bpm })),
    offsetSec + (count * 60) / bpm,
  );

export const cueProgress = (cue: Cue, frame: number, curve: CurveRef = "linear"): number =>
  progress(frame, cue.from, cue.durationInFrames, curve);

/** Decays from 1 on the cue's frame to 0 after `frames`: a small accent, not a jump. */
export const cuePulse = (cue: Cue, frame: number, frames = 7): number =>
  frame < cue.from ? 0 : 1 - progress(frame, cue.from, frames, "expoOut");

export const activeCue = (cues: readonly Cue[], frame: number): Cue | undefined =>
  cues.find((cue) => frame >= cue.from && frame < cue.to);

// --- Bridge from an edit:snap cue sheet and an audio:map: plain data in, values out, nothing loaded here ---

/** What the cue bridge reads of a sheet: ids and frames. A `cue-sheet.json` imported as JSON widens its literals (schemaVersion: number, kind: string), and still fits. */
export type CueFrameSheet = { readonly cues: readonly { readonly id: string; readonly frame: number }[] };

/** Frame of a cue in a cue sheet. An unknown id throws: a silent 0 would put the cut on the first frame. */
export const cueFrame = (sheet: CueFrameSheet, id: string): number => {
  const cue = sheet.cues.find((item) => item.id === id);
  if (!cue) throw new Error(`No cue "${id}" in this cue sheet.`);
  return cue.frame;
};

export const cueFrames = (sheet: CueFrameSheet): Record<string, number> =>
  Object.fromEntries(sheet.cues.map((cue) => [cue.id, cue.frame]));

export type AudioPulseOptions = {
  /** Seconds of the track at the film's first frame: the cue sheet's `musicOffsetSec`. */
  offsetSec?: number;
  frames?: number;
  kinds?: readonly AudioMap["events"][number]["kind"][];
  minStrength?: number;
};

/** Decays from an event's strength on its frame to 0 after `frames`, so motion answers kicks without any audio at render time. Overlaps take the largest. */
export const audioPulse = (
  frame: number,
  fps: number,
  events: readonly Pick<AudioMap["events"][number], "timeSec" | "kind" | "strength">[],
  options: AudioPulseOptions = {},
): number => {
  const { offsetSec = 0, frames = 7, kinds, minStrength = 0 } = options;
  let pulse = 0;
  for (const event of events) {
    if (event.strength < minStrength || (kinds && !kinds.includes(event.kind))) continue;
    const from = Math.round((event.timeSec - offsetSec) * fps);
    if (frame < from || frame >= from + frames) continue;
    pulse = Math.max(pulse, event.strength * (1 - progress(frame, from, frames, "expoOut")));
  }
  return pulse;
};

export type EnergyBand = "rms" | "low" | "high";

/** Track energy at a frame, linear between points of the map's curve and held at both ends. */
export const energyAt = (
  frame: number,
  fps: number,
  curve: AudioMap["energyCurve"],
  options: { offsetSec?: number; band?: EnergyBand } = {},
): number => {
  const { offsetSec = 0, band = "rms" } = options;
  if (curve.length === 0) return 0;
  const at = frame / fps + offsetSec;
  let low = 0;
  let high = curve.length - 1;
  if (at <= curve[0]!.timeSec) return curve[0]![band];
  if (at >= curve[high]!.timeSec) return curve[high]![band];
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if (curve[middle]!.timeSec <= at) low = middle;
    else high = middle;
  }
  const from = curve[low]!;
  const to = curve[high]!;
  return from[band] + ((to[band] - from[band]) * (at - from.timeSec)) / (to.timeSec - from.timeSec);
};

// --- Micro-craft: intent-named eases, entry hierarchy, follow-through and time remapping ---

/** Normalised damped spring: 0 at 0, exactly 1 at 1, one small overshoot (about 4%) and no visible ring after. */
const settleCurve: Curve = (() => {
  const span = 20;
  const raw = (t: number) => (t <= 0 ? 0 : 1 - Math.exp(-0.6 * t * span) * Math.cos(0.5 * t * span));
  const end = raw(1);
  return (t: number) => raw(t) / end;
})();

/**
 * Eases named by what the move should feel like, so a plan can say "brake" and a builder picks the same curve every
 * time. All start at 0 and end at 1; `punch` and `settle` pass 1 once on the way, the others stay inside 0..1.
 * Pass one wherever a `CurveRef` is taken: `progress(frame, 0, 18, intentCurves.brake)`.
 */
export const intentCurves = {
  /** Position to position with no visible travel at either end: interface moves, whips, short camera snaps. */
  snap: curves.inOut,
  /** Arrives and rests with one small give (about 4%): a card, a word or a frame coming to a stop under its own weight. */
  settle: settleCurve,
  /** Long, even travel with soft ends: camera moves, parallax, a slow push. */
  glide: curves.drift,
  /** Passes the target once by about 10%: a hit, a stamp, a number that lands. */
  punch: curves.overshoot,
  /** Barely accelerates and barely brakes: idle breathing, ambient drift, a hold that still lives. */
  float: Easing.bezier(0.37, 0, 0.63, 1),
  /** Enters at speed and decelerates hard: the confident entrance, anything thrown into place. */
  brake: curves.expoOut,
} satisfies Record<string, Curve>;

export type IntentName = keyof typeof intentCurves;

export type HierarchyOptions = {
  /** First hero entry, in frames. */
  at?: number;
  /** Frame rate the frame gaps below are scaled from; the defaults are frames at 30 fps. */
  fps?: number;
  /** Frames between hero items when there is more than one. */
  heroStep?: number;
  /** Frames from the last hero entry to the first support entry. */
  supportGap?: number;
  supportStep?: number;
  /** Frames from the last support entry (or the last hero, with no support) to the first detail. */
  detailGap?: number;
  detailStep?: number;
};

export type HierarchyPlan = {
  hero: number[];
  support: number[];
  detail: number[];
  /** Last entry of any role. */ last: number;
};

/**
 * Entry frames by role, so a frame builds in reading order: the hero alone first, support after a breath, detail in a
 * quick stagger last. Defaults at 30 fps: hero at `at`, support 10 frames later in steps of 5, detail 7 frames after
 * the last support in steps of 3. Gaps scale with `fps`.
 */
export const hierarchy = (
  roles: { hero?: number; support?: number; detail?: number },
  options: HierarchyOptions = {},
): HierarchyPlan => {
  const { at = 0, fps = 30, heroStep = 4, supportGap = 10, supportStep = 5, detailGap = 7, detailStep = 3 } = options;
  const scale = (frames: number) => Math.round((frames * fps) / 30);
  const run = (count: number, from: number, step: number) =>
    Array.from({ length: Math.max(0, Math.floor(count)) }, (_, i) => from + i * scale(step));
  const hero = run(roles.hero ?? 1, at, heroStep);
  const supportFrom = (hero.at(-1) ?? at) + (hero.length > 0 ? scale(supportGap) : 0);
  const support = run(roles.support ?? 0, supportFrom, supportStep);
  const detailAnchor = support.at(-1) ?? hero.at(-1);
  const detail = run(roles.detail ?? 0, detailAnchor === undefined ? at : detailAnchor + scale(detailGap), detailStep);
  return { hero, support, detail, last: Math.max(at, ...hero, ...support, ...detail) };
};

export type FollowThroughOptions = {
  /** Size of the first swing past the stop, in the caller's units (pixels, degrees, scale). Negative swings back. */
  amplitude?: number;
  /** Decay rate per second; 6 is gone in about half a second. */
  damping?: number;
  /** Swings per second. */
  frequency?: number;
  fps?: number;
};

/**
 * Secondary motion after a stop: 0 up to `stopFrame`, then a decaying swing that first carries on in the direction of
 * travel and reaches `amplitude` at its first peak. Add it to the value that stopped (a hanging tag, a card's tilt).
 */
export const followThrough = (
  frame: number,
  stopFrame: number,
  { amplitude = 1, damping = 6, frequency = 2.2, fps = 30 }: FollowThroughOptions = {},
): number => {
  if (frame <= stopFrame || amplitude === 0) return 0;
  const omega = 2 * Math.PI * frequency;
  const swing = (t: number) => Math.exp(-damping * t) * Math.sin(omega * t);
  const peak = swing(Math.atan(omega / damping) / omega);
  return (amplitude * swing((frame - stopFrame) / fps)) / peak;
};

export type SpeedSegment = {
  /** Output frame where the change to `speed` starts. */
  at: number;
  /** Source frames per output frame: 0.25 is slow motion, 1 real time, 4 fast; 0 holds the frame. */
  speed: number;
  /** Frames the change from the previous speed takes (default 6); 0 jumps. */
  ramp?: number;
  /** Shape of the change (default "drift"); must stay inside 0..1, or the source would run backwards. */
  curve?: CurveRef;
};

const RAMP_STEPS = 32;

const assertRemap = (segments: readonly SpeedSegment[]): void => {
  let free = -Infinity;
  for (const segment of segments) {
    if (!(segment.speed >= 0) || !Number.isFinite(segment.speed))
      throw new Error(`Speed must be 0 or more: ${segment.speed}.`);
    if (segment.at < free)
      throw new Error(`Speed segment at ${segment.at} starts before the previous ramp ends (${free}).`);
    const curve = resolveCurve(segment.curve ?? "drift");
    for (let i = 1; i < 16; i++) {
      const value = curve(i / 16);
      if (value < -1e-6 || value > 1 + 1e-6)
        throw new Error(
          "A speed ramp curve must stay inside 0..1; overshooting curves would run the source backwards.",
        );
    }
    free = segment.at + Math.max(0, segment.ramp ?? 6);
  }
};

/** Speed (source frames per output frame) at an output frame. Before the first segment the clip runs at `initialSpeed`. */
export const speedAt = (frame: number, segments: readonly SpeedSegment[], initialSpeed = 1): number => {
  let speed = initialSpeed;
  for (const segment of segments) {
    if (frame < segment.at) break;
    const ramp = Math.max(0, segment.ramp ?? 6);
    if (ramp === 0 || frame >= segment.at + ramp) {
      speed = segment.speed;
      continue;
    }
    return speed + (segment.speed - speed) * resolveCurve(segment.curve ?? "drift")((frame - segment.at) / ramp);
  }
  return speed;
};

/** Simpson integral of the speed over [from, to] with a fixed number of steps, so the result is a pure function of `to`. */
const integrateSpeed = (from: number, to: number, segments: readonly SpeedSegment[], initialSpeed: number): number => {
  if (to <= from) return 0;
  const h = (to - from) / RAMP_STEPS;
  let sum = speedAt(from, segments, initialSpeed) + speedAt(to, segments, initialSpeed);
  for (let i = 1; i < RAMP_STEPS; i++) sum += speedAt(from + i * h, segments, initialSpeed) * (i % 2 === 1 ? 4 : 2);
  return (sum * h) / 3;
};

/**
 * Source frame for an output frame under a speed ramp: the integral of `speedAt` from 0. Continuous and never
 * decreasing, so slow-fast-slow ramps never stutter. Constant stretches are exact; eased changes are integrated with a
 * fixed step count. Drive a procedural child with `<Freeze frame={timeRemap(frame, segments)}>`; for media, round it
 * and pass it as the start of a one-frame `<Sequence>` holding `<Video trimBefore>` from `@remotion/media`.
 */
export const timeRemap = (frame: number, segments: readonly SpeedSegment[], initialSpeed = 1): number => {
  assertRemap(segments);
  if (frame <= 0) return frame * initialSpeed;
  let source = 0;
  let cursor = 0;
  let speed = initialSpeed;
  for (const segment of segments) {
    const start = Math.max(segment.at, 0);
    if (start > cursor) {
      const until = Math.min(frame, start);
      source += speed * (until - cursor);
      cursor = until;
      if (frame <= start) return source;
    }
    const end = segment.at + Math.max(0, segment.ramp ?? 6);
    if (end > cursor) {
      const until = Math.min(frame, end);
      source += integrateSpeed(cursor, until, segments, initialSpeed);
      cursor = until;
      if (frame <= end) return source;
    }
    speed = segment.speed;
  }
  return source + speed * (frame - cursor);
};
