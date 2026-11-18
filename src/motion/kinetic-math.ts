import { noise2D } from "@remotion/noise";
import { random } from "remotion";
import { progress, resolveCurve, track, type CurveRef } from "./timing";

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);
const fract = (value: number): number => value - Math.floor(value);

/** Exponential approach: fast at once, never quite done. Reads like the scale curve of a word that lands (k about 0.4 per frame). */
export const settle = (elapsed: number, k = 0.4): number => (elapsed <= 0 ? 0 : 1 - Math.exp(-k * elapsed));

/** 1 on the hit frame, falling to 0 after `frames`; 0 before the hit. For flashes and shakes. */
export const hitDecay = (frame: number, at: number, frames = 6): number => {
  if (frame < at || frame >= at + frames) return 0;
  const t = (frame - at) / frames;
  return (1 - t) * (1 - t);
};

/** The largest decay across several hits. */
export const hitsDecay = (frame: number, hits: readonly number[], frames = 6): number =>
  hits.reduce((peak, at) => Math.max(peak, hitDecay(frame, at, frames)), 0);

/** Camera kick after a hit: seeded and over in `frames`. Small amplitudes land harder than large ones. */
export const hitShake = (
  frame: number,
  at: number,
  { seed, amplitude = 14, frames = 8 }: { seed: string; amplitude?: number; frames?: number },
): { x: number; y: number; roll: number } => {
  const power = hitDecay(frame, at, frames) * amplitude;
  return {
    x: noise2D(`${seed}-x`, frame * 0.9, at) * power,
    y: noise2D(`${seed}-y`, frame * 0.9, at) * power,
    roll: noise2D(`${seed}-r`, frame * 0.9, at) * power * 0.05,
  };
};

// --- Velocity smear ---

export type SmearOptions = {
  /** Blur sigma per pixel of per-frame travel. Above a 180 degree shutter on purpose: the streak is the picture. */
  shutter?: number;
  maxBlur?: number;
  /** Stretch along the motion per 100 px/frame. */
  stretchPer100?: number;
  maxStretch?: number;
  /** Colour fringe per 100 px/frame, in px. */
  chromaPer100?: number;
  maxChroma?: number;
};

/** `rowCut` 0 to 1: how far the streak breaks into separate rows at high speed. */
export type SmearState = { blur: number; stretch: number; rowShift: number; rowCut: number; chroma: number };

/** What speed draws, in pixels per frame. Below 1 px/frame nothing happens, so settled type stays clean. */
export const smearAt = (
  speed: number,
  {
    shutter = 0.5,
    maxBlur = 110,
    stretchPer100 = 0.28,
    maxStretch = 1.9,
    chromaPer100 = 6,
    maxChroma = 10,
  }: SmearOptions = {},
): SmearState => {
  const pace = Math.abs(speed);
  if (pace < 1) return { blur: 0, stretch: 1, rowShift: 0, rowCut: 0, chroma: 0 };
  const blur = Math.min(pace * shutter, maxBlur);
  return {
    blur,
    stretch: Math.min(1 + (pace / 100) * stretchPer100, maxStretch),
    rowShift: blur * 1.3,
    rowCut: Math.min(blur / 110, 1) * 0.72,
    chroma: Math.min((pace / 100) * chromaPer100, maxChroma),
  };
};

// --- Word pose: landing, hold, exit ---

export type WordEnter = "slam" | "lens" | "cut";
export type WordExit = "left" | "right" | "up" | "down" | "through" | "cut";

export type WordMotion = {
  /** Frame of the hit: the word is on screen from here. */
  at: number;
  enter?: WordEnter;
  /** Scale on the hit frame. Default 0.36 for slam, 5 for lens. */
  fromScale?: number;
  /** Rate of the landing, per frame. */
  k?: number;
  /** Starting rotation in degrees; it settles with the scale. */
  tilt?: { x?: number; y?: number; z?: number };
  /** Slow push on the hold: added scale per second at 30 fps. Nothing important sits dead. */
  creep?: number;
  /** Frame the word begins to leave. Absent: it stays. */
  exitAt?: number;
  exit?: WordExit;
  exitFrames?: number;
  /** Pixels covered by a lateral exit. */
  travel?: number;
};

export type WordPose = {
  visible: boolean;
  x: number;
  y: number;
  scale: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  opacity: number;
};

const CREEP_FRAMES = 30;
const THROUGH_SCALE = 6;

export const wordPose = (frame: number, motion: WordMotion): WordPose => {
  const {
    at,
    enter = "slam",
    k,
    tilt = {},
    creep = 0.04,
    exitAt,
    exit = "cut",
    exitFrames = exit === "through" ? 4 : 5,
    travel = 2400,
  } = motion;
  const hidden: WordPose = { visible: false, x: 0, y: 0, scale: 1, rotateX: 0, rotateY: 0, rotateZ: 0, opacity: 0 };
  if (frame < at) return hidden;
  const elapsed = frame - at;
  const landing = enter === "cut" ? 1 : settle(elapsed, k ?? (enter === "lens" ? 0.55 : 0.4));
  const from = motion.fromScale ?? (enter === "lens" ? 5 : 0.36);
  const leftover = 1 - landing;
  const held = 1 + (creep * elapsed) / CREEP_FRAMES;
  const scale = (from + (1 - from) * landing) * held;
  const pose: WordPose = {
    visible: true,
    x: 0,
    y: 0,
    scale,
    rotateX: (tilt.x ?? 0) * leftover,
    rotateY: (tilt.y ?? 0) * leftover,
    rotateZ: (tilt.z ?? 0) * leftover,
    opacity: 1,
  };
  if (exitAt === undefined || frame < exitAt) return pose;
  if (exit === "cut") return hidden;
  const t = (frame - exitAt) / exitFrames;
  if (t >= 1) return hidden;
  if (exit === "through")
    return {
      ...pose,
      scale: scale * THROUGH_SCALE ** (t * t + t * 0.6),
      opacity: t > 0.6 ? clamp(1 - (t - 0.6) / 0.4, 0, 1) : 1,
    };
  const moved = t * t * t * travel;
  if (exit === "left") return { ...pose, x: -moved };
  if (exit === "right") return { ...pose, x: moved };
  if (exit === "up") return { ...pose, y: -moved };
  return { ...pose, y: moved };
};

/** Pixels per frame of a word's motion, including the edge speed its scale change gives a word `halfWidth` across. */
export const wordSpeed = (
  frame: number,
  motion: WordMotion,
  halfWidth: number,
): { vx: number; vy: number; vScale: number } => {
  const now = wordPose(frame, motion);
  const next = wordPose(frame + 1, motion);
  if (!now.visible) return { vx: 0, vy: 0, vScale: 0 };
  // The last frame of an exit keeps its speed instead of reading as a stop.
  if (!next.visible) {
    const before = wordPose(frame - 1, motion);
    return { vx: now.x - before.x, vy: now.y - before.y, vScale: (now.scale - before.scale) * halfWidth };
  }
  return { vx: next.x - now.x, vy: next.y - now.y, vScale: (next.scale - now.scale) * halfWidth };
};

// --- Per-glyph arrival ---

export type GlyphRiseOptions = {
  at: number;
  /** Frames between neighbours. */
  step?: number;
  frames?: number;
  seed?: string;
  /** Rise distance in em. */
  rise?: number;
  /** Largest tumble in degrees. */
  tumble?: number;
  /** Rotation left in place at rest, in degrees. 0 is level; a hand-cut word keeps a tilt. */
  restTilt?: number;
};

export type GlyphState = {
  visible: boolean;
  opacity: number;
  y: number;
  rotateX: number;
  rotateY: number;
  rotateZ: number;
  scaleAlong: number;
  scaleAcross: number;
  blur: number;
};

/** One glyph tumbling in: stretches along its motion while fast and squashes for a few frames on arrival. */
export const glyphRiseAt = (
  frame: number,
  index: number,
  { at, step = 1.2, frames = 5, seed = "glyph", rise = 0.7, tumble = 42, restTilt = 0 }: GlyphRiseOptions,
): GlyphState => {
  const start = at + index * step;
  const rest = (random(`${seed}-rest-${index}`) * 2 - 1) * restTilt;
  if (frame < start)
    return {
      visible: false,
      opacity: 0,
      y: rise,
      rotateX: 0,
      rotateY: 0,
      rotateZ: rest,
      scaleAlong: 1,
      scaleAcross: 1,
      blur: 0,
    };
  const elapsed = frame - start;
  const eased = settle(elapsed, 3.2 / frames);
  const left = elapsed >= frames * 2 ? 0 : 1 - eased;
  const pace = left * (3.2 / frames) * rise;
  const landed = elapsed - frames * 0.6;
  const squash = landed > 0 && landed < 5 ? Math.sin((landed / 5) * Math.PI) * 0.09 : 0;
  const stretch = Math.min(pace * 3.4, 0.5);
  return {
    visible: true,
    opacity: clamp(0.3 + elapsed / (frames * 0.5), 0.3, 1),
    y: rise * left,
    rotateX: (random(`${seed}-x-${index}`) * 2 - 1) * tumble * left,
    rotateY: (random(`${seed}-y-${index}`) * 2 - 1) * tumble * left,
    rotateZ: rest + (random(`${seed}-z-${index}`) * 2 - 1) * (tumble / 3) * left,
    scaleAlong: 1 + stretch - squash,
    scaleAcross: 1 - stretch * 0.35 + squash * 0.7,
    blur: pace * 18,
  };
};

// --- Words along the lens axis ---

export type DollyOptions = {
  /** Frames the camera takes between two words. */
  travel?: number;
  /** Extra travel per frame on the hold, in word steps, so the camera never stops. */
  creep?: number;
};

/** Camera position along a stack of words: n means "resting on word n". Rests fall on the cues, and the move is finished on the cue. */
export const dollyPosition = (
  frame: number,
  cues: readonly number[],
  { travel = 11, creep = 0.0035 }: DollyOptions = {},
): number => {
  let position = 0;
  let last = cues[0] ?? 0;
  for (let i = 1; i < cues.length; i++) {
    const landing = cues[i]!;
    const from = landing - travel;
    if (frame < from) break;
    position = i - 1 + progress(frame, from, travel, "drift");
    last = landing;
  }
  return position + Math.max(frame - last, 0) * creep;
};

export type DollyWordOptions = {
  /** Scale change between neighbouring words. */
  ratio?: number;
  /** Beyond this scale a word has passed the lens. */
  near?: number;
  /** Below this scale a word is too far to see. */
  far?: number;
};

export type DollyWord = { visible: boolean; scale: number; opacity: number; blur: number };

/** Each word sits one `ratio` behind the last: at rest the next word already shows small inside the current one. */
export const dollyWord = (
  position: number,
  index: number,
  { ratio = 4.5, near = 4.6, far = 0.3 }: DollyWordOptions = {},
): DollyWord => {
  const scale = ratio ** (position - index);
  if (scale > near || scale < far * 0.6) return { visible: false, scale, opacity: 0, blur: 0 };
  const passing = scale > 2.2 ? clamp(1 - (scale - 2.2) / (near - 2.2), 0, 1) : 1;
  const arriving = scale < far * 1.6 ? clamp((scale - far * 0.6) / far, 0, 1) : 1;
  const out = scale > 1 ? scale - 1 : (1 - scale) * 0.8;
  return { visible: true, scale, opacity: passing * arriving, blur: out * 3.2 };
};

// --- Variable axes ---

export type AxisKeyframe = { at: number; wdth?: number; wght?: number };

/** Lands past the target and rings once or twice: `0.3` overshoot at about a third of the way. */
export const elasticEase = (elapsed: number, { k = 0.34, ring = 0.55 }: { k?: number; ring?: number } = {}): number =>
  elapsed <= 0 ? 0 : 1 - Math.exp(-k * elapsed) * Math.cos(ring * elapsed);

/** Value of one axis at a frame: keys that omit it hold the previous value. */
const axisAt = (frame: number, keys: readonly AxisKeyframe[], axis: "wdth" | "wght", fallback: number): number => {
  let value = fallback;
  for (const key of keys) {
    const target = key[axis];
    if (target === undefined) continue;
    if (frame < key.at) break;
    value += (target - value) * elasticEase(frame - key.at);
  }
  return value;
};

export const elasticAxes = (
  frame: number,
  keys: readonly AxisKeyframe[],
  {
    minWdth = 25,
    maxWdth = 151,
    minWght = 100,
    maxWght = 1000,
  }: { minWdth?: number; maxWdth?: number; minWght?: number; maxWght?: number } = {},
): { wdth: number; wght: number } => ({
  wdth: clamp(axisAt(frame, keys, "wdth", 100), minWdth, maxWdth),
  wght: clamp(axisAt(frame, keys, "wght", 400), minWght, maxWght),
});

// --- Scramble ---

/** Punctuation any Latin or Cyrillic face has. */
export const SCRAMBLE_POOL = "[]{}()<>/*+=;:!?#%";

export type ScrambleOptions = {
  at: number;
  duration?: number;
  seed?: string;
  pool?: string;
  cadence?: number;
  spreadShare?: number;
  resolveShare?: number;
};

/**
 * The corruption spreads from the first glyph across `spreadShare` of the window, holds, then every glyph resolves
 * within the last `resolveShare`. Outside the window, the word is exactly the target. Spaces stay spaces.
 */
export const scrambleGlyphs = (
  graphemes: readonly string[],
  frame: number,
  {
    at,
    duration = 15,
    seed = "scramble",
    pool = SCRAMBLE_POOL,
    cadence = 1,
    spreadShare = 0.65,
    resolveShare = 0.2,
  }: ScrambleOptions,
): string[] => {
  const t = (frame - at) / duration;
  if (t < 0 || t >= 1) return [...graphemes];
  const tick = Math.floor(frame / cadence);
  const count = Math.max(graphemes.length - 1, 1);
  const options = [...pool];
  return graphemes.map((grapheme, index) => {
    if (grapheme.trim() === "") return grapheme;
    const from = (index / count) * spreadShare;
    const until = 1 - resolveShare * (1 - index / count);
    if (t < from || t >= until) return grapheme;
    return options[Math.floor(random(`${seed}-${index}-${tick}`) * options.length)]!;
  });
};

/** Colour split of a scramble in pixels: none at the ends, largest in the middle. */
export const scrambleChroma = (frame: number, at: number, duration = 15, peak = 6): number => {
  const t = (frame - at) / duration;
  return t <= 0 || t >= 1 ? 0 : Math.sin(t * Math.PI) ** 2 * peak;
};

// --- Sentence-building caption ---

export type CaptionWord = { text: string; at: number };

export type CaptionWordState = { visible: boolean; opacity: number; tagFrom: number; tagTo: number };

/**
 * State of each word in a caption that grows with the film. The tag covers `tagFrom`..`tagTo` of its word: the old
 * tag's left edge runs off to the right as the new tag's right edge grows, so the highlight appears to travel.
 */
export const captionWords = (frame: number, words: readonly CaptionWord[], tagFrames = 4): CaptionWordState[] =>
  words.map((word, index) => {
    if (frame < word.at) return { visible: false, opacity: 0, tagFrom: 0, tagTo: 0 };
    const next = words[index + 1];
    const arrival = progress(frame, word.at, tagFrames, "expoOut");
    const leaving = next ? progress(frame, next.at, tagFrames, "expoOut") : 0;
    return { visible: true, opacity: 0.35 + 0.65 * arrival, tagFrom: leaving, tagTo: arrival };
  });

// --- Typing ---

export type TypingOptions = {
  at: number;
  seed?: string;
  /** Mean frames per character. */ pace?: number;
  /** Share of characters followed by a pause. */ pauses?: number;
};

/** Frame each character appears on. Typing comes in bursts with small hesitations, not an even tick. */
export const typingSchedule = (
  text: string,
  { at, seed = "typing", pace = 1.6, pauses = 0.14 }: TypingOptions,
): number[] => {
  let cursor = at;
  return [...text].map((_, index) => {
    const when = Math.round(cursor);
    const gap = pace * (0.55 + random(`${seed}-gap-${index}`) * 0.9);
    cursor += gap + (random(`${seed}-pause-${index}`) < pauses ? pace * 3 : 0);
    return when;
  });
};

export const typedCount = (frame: number, schedule: readonly number[]): number => {
  let count = 0;
  while (count < schedule.length && schedule[count]! <= frame) count++;
  return count;
};

// --- Layout morph ---

export type LayoutRect = { x: number; y: number; width: number; height: number; radius?: number };
export type LayoutKeyframe = LayoutRect & { at: number; curve?: CurveRef };

/** One shape's rectangle at a frame. Exact on every key, and holds outside them. */
export const morphRect = (
  frame: number,
  keys: readonly LayoutKeyframe[],
  defaultCurve: CurveRef = "expoOut",
): Required<LayoutRect> => {
  const of = (field: keyof LayoutRect) =>
    track(
      frame,
      keys.map((key) => ({ at: key.at, value: key[field] ?? 0, curve: key.curve ?? defaultCurve })),
    );
  return { x: of("x"), y: of("y"), width: of("width"), height: of("height"), radius: of("radius") };
};

export type GrowOptions = {
  at: number;
  frames?: number;
  /** Share of the window spent swelling before the surge. */ anticipation?: number;
  /** How much it swells in that time. */ swell?: number;
};

export type GrowState = Required<LayoutRect> & {
  /** 0 to 1: the label is gone by here. */ label: number;
  /** 0 to 1: the gradient flattens into the next ground. */ flat: number;
  progress: number;
};

/** An element that swells, then surges until it is the next scene. At the end it is exactly the stage. */
export const growRect = (
  frame: number,
  from: Required<LayoutRect>,
  stage: { width: number; height: number },
  { at, frames = 15, anticipation = 0.55, swell = 0.16 }: GrowOptions,
): GrowState => {
  const t = clamp((frame - at) / frames, 0, 1);
  const cx = from.x + from.width / 2;
  const cy = from.y + from.height / 2;
  const swelling = resolveCurve("drift")(clamp(t / anticipation, 0, 1));
  const swollen = { width: from.width * (1 + swell * swelling), height: from.height * (1 + swell * 0.7 * swelling) };
  const surge = t <= anticipation ? 0 : resolveCurve("expoIn")((t - anticipation) / (1 - anticipation));
  const width = swollen.width + (stage.width - swollen.width) * surge;
  const height = swollen.height + (stage.height - swollen.height) * surge;
  const centreX = cx + (stage.width / 2 - cx) * surge;
  const centreY = cy + (stage.height / 2 - cy) * surge;
  return {
    x: centreX - width / 2,
    y: centreY - height / 2,
    width,
    height,
    radius: from.radius * (1 - surge),
    label: clamp(1 - t / (anticipation + 0.1), 0, 1),
    flat: clamp((t - anticipation * 0.5) / (anticipation * 0.5), 0, 1),
    progress: t,
  };
};

// --- Collage that re-divides ---

export type GridSplit = { at: number; cell: string; dir: "x" | "y"; ratio: number; into: readonly [string, string] };
/** Moves the gutter of an existing split: `cell` is the id that was split. Ratio 1 hands the whole area to the first child, 0 to the second. */
export type GridSlide = { at: number; cell: string; ratio: number };
export type GridStep = GridSplit | GridSlide;

export type GridCell = { id: string; x: number; y: number; width: number; height: number };

const isSplit = (step: GridStep): step is GridSplit => "into" in step;

/**
 * Every cell's rectangle at a frame. Cells come from a binary split tree whose ratios animate, so whatever the frame the
 * cells tile the stage exactly: a gutter that slides takes from one neighbour what it gives another.
 */
export const collageCells = (
  frame: number,
  steps: readonly GridStep[],
  stage: { width: number; height: number },
  { root = "root", frames = 12, curve = "expoOut" as CurveRef } = {},
): GridCell[] => {
  const walk = (id: string, x: number, y: number, width: number, height: number): GridCell[] => {
    const split = steps.find((step): step is GridSplit => isSplit(step) && step.cell === id && step.at <= frame);
    if (!split) return [{ id, x, y, width, height }];
    let ratio = 1 + (split.ratio - 1) * progress(frame, split.at, frames, curve);
    for (const slide of steps) {
      if (isSplit(slide) || slide.cell !== id || slide.at > frame) continue;
      ratio += (slide.ratio - ratio) * progress(frame, slide.at, frames, curve);
    }
    const [first, second] = split.into;
    if (split.dir === "x")
      return [
        ...walk(first, x, y, width * ratio, height),
        ...walk(second, x + width * ratio, y, width * (1 - ratio), height),
      ];
    return [
      ...walk(first, x, y, width, height * ratio),
      ...walk(second, x, y + height * ratio, width, height * (1 - ratio)),
    ];
  };
  return walk(root, 0, 0, stage.width, stage.height);
};

// --- Number race ---

export type RaceOptions = { at: number; frames?: number; from?: number; to: number; curve?: CurveRef };

export const raceValue = (frame: number, { at, frames = 30, from = 0, to, curve = "expoOut" }: RaceOptions): number =>
  from + (to - from) * Math.min(progress(frame, at, frames, curve), 1);

/**
 * Reel position of each column of an odometer, least significant last. A column rolls only while the one to its right
 * goes from 9 to 0, so a whole value rests on whole digits.
 */
export const odometerReels = (value: number, columns: number): number[] => {
  const magnitude = Math.max(value, 0);
  const reels: number[] = [];
  let lower = magnitude;
  reels.unshift(lower);
  for (let column = 1; column < columns; column++) {
    const whole = Math.floor(magnitude / 10 ** column);
    const carry = clamp(fract(lower) + (Math.floor(lower) % 10) - 9, 0, 1);
    lower = whole + carry;
    reels.unshift(lower);
  }
  return reels;
};

// --- Live backgrounds ---

export type RadialLine = { x1: number; y1: number; x2: number; y2: number; opacity: number; width: number };

export type RadialOptions = {
  seed?: string;
  count?: number;
  /** Centre of the field in stage pixels. */
  cx: number;
  cy: number;
  /** Beyond the far corner, in pixels. */
  reach: number;
  /** 0 to 1: slow, sparse and short at 0, dense and long at 1. */
  energy: number;
  /** 0 to 1: a pocket clear of lines around the centre, as a share of `reach`. */
  clear?: number;
};

/** Lines leaving a point. Each has a seeded angle, speed and phase; energy decides how many show, how long and how bright. */
export const radialLines = (
  frame: number,
  { seed = "radial", count = 260, cx, cy, reach, energy, clear = 0 }: RadialOptions,
): RadialLine[] => {
  const power = clamp(energy, 0, 1);
  const lines: RadialLine[] = [];
  for (let i = 0; i < count; i++) {
    const rank = random(`${seed}-rank-${i}`);
    if (rank > 0.14 + power * 0.86) continue;
    const angle = random(`${seed}-angle-${i}`) * Math.PI * 2;
    const speed = 0.006 + random(`${seed}-speed-${i}`) * 0.012;
    const phase = fract(random(`${seed}-phase-${i}`) + frame * speed);
    // A hit pulls the starts towards the centre and throws the lines long, so they read as a burst from one point.
    const inner = clear + phase ** (1 + power * 1.6) * (1 - clear);
    const length = (0.04 + random(`${seed}-length-${i}`) * 0.1) * (0.5 + power * 3.6);
    const outer = inner + length;
    const fade = Math.min(phase * 5, 1) * Math.min((1 - phase) * 3, 1);
    lines.push({
      x1: cx + Math.cos(angle) * inner * reach,
      y1: cy + Math.sin(angle) * inner * reach,
      x2: cx + Math.cos(angle) * outer * reach,
      y2: cy + Math.sin(angle) * outer * reach,
      opacity: fade * (0.35 + power * 0.65),
      width: 0.7 + random(`${seed}-width-${i}`) * (0.7 + power * 0.7),
    });
  }
  return lines;
};

/** Radius and strength of a ring thrown by a hit. Done after `frames`. */
export const shockRingAt = (
  frame: number,
  at: number,
  { from = 60, to = 1100, frames = 14 }: { from?: number; to?: number; frames?: number } = {},
): { visible: boolean; radius: number; opacity: number } => {
  if (frame < at || frame >= at + frames) return { visible: false, radius: from, opacity: 0 };
  const elapsed = frame - at;
  return { visible: true, radius: from + (to - from) * settle(elapsed, 0.28), opacity: (1 - elapsed / frames) ** 1.4 };
};

export type LightBlob = { x: number; y: number; radius: number; strength: number };

/** Soft lights that wander by seeded noise, in shares of the stage. Energy makes them larger and stronger. */
export const lightBlobs = (
  frame: number,
  {
    seed = "light",
    count = 3,
    speed = 0.006,
    energy = 0.5,
  }: { seed?: string; count?: number; speed?: number; energy?: number } = {},
): LightBlob[] =>
  Array.from({ length: count }, (_, i) => ({
    x: 0.5 + noise2D(`${seed}-x-${i}`, frame * speed, i) * 0.55,
    y: 0.5 + noise2D(`${seed}-y-${i}`, frame * speed, i * 3) * 0.5,
    radius: 0.32 + 0.1 * noise2D(`${seed}-r-${i}`, frame * speed * 0.7, i) + clamp(energy, 0, 1) * 0.28,
    strength: 0.34 + clamp(energy, 0, 1) * 0.66,
  }));
