// Pure: turns an audio map (and optional measured per-frame levels) into per-frame curves. No Node imports.
import type { AudioMap } from "../../types/film";
import type { AudioCurveName, AudioCurves } from "./schema";

export type CurveParams = AudioCurves["params"];
export const DEFAULT_CURVE_PARAMS: CurveParams = { attackMs: 10, releaseMs: 150, halfLifeMs: 120, energyWindowMs: 800 };

/** Raw RMS per film frame, any scale: normalised here. */
export type MeasuredLevels = { level: number[]; low: number[]; mid: number[]; high: number[] };

export type ComputeCurvesInput = {
  map: AudioMap;
  fps: number;
  offsetSec?: number;
  /** Defaults to the rest of the track after the offset. */
  frameCount?: number;
  measured?: MeasuredLevels;
  stems?: Partial<Record<"drums" | "bass" | "other" | "vocals", number[]>>;
  params?: Partial<CurveParams>;
  source: AudioCurves["source"];
};

const round3 = (value: number) => Math.round(value * 1000) / 1000;
const clip01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

export function percentile(values: readonly number[], share: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(share * (sorted.length - 1))))]!;
}

/** Scales to the 99.5th percentile, so one click cannot flatten the rest; `floor` keeps a near-silent band near 0. */
export function normalise(values: readonly number[], floor = 0): number[] {
  const top = Math.max(percentile(values, 0.995), floor, 1e-9);
  return values.map((value) => clip01(value / top));
}

/** One-pole follower: rises with the attack time constant, falls with the release one. Precomputed, so stateful is fine. */
export function follow(values: readonly number[], fps: number, attackMs: number, releaseMs: number): number[] {
  const coefficient = (ms: number) => (ms <= 0 ? 1 : 1 - Math.exp(-1000 / (ms * fps)));
  const up = coefficient(attackMs);
  const down = coefficient(releaseMs);
  let state = values[0] ?? 0;
  return values.map((value) => (state += (value - state) * (value > state ? up : down)));
}

/** Centred moving average over `radius` frames each side. */
export function boxSmooth(values: readonly number[], radius: number): number[] {
  if (radius <= 0) return [...values];
  const prefix = [0];
  for (const value of values) prefix.push(prefix[prefix.length - 1]! + value);
  return values.map((_, index) => {
    const from = Math.max(0, index - radius);
    const to = Math.min(values.length, index + radius + 1);
    return (prefix[to]! - prefix[from]!) / (to - from);
  });
}

/** Linear resample of (timeSec, value) points onto film frames. */
function resample(
  points: readonly { timeSec: number; value: number }[],
  frameCount: number,
  fps: number,
  offsetSec: number,
): number[] {
  if (points.length === 0) return new Array<number>(frameCount).fill(0);
  let cursor = 0;
  return Array.from({ length: frameCount }, (_, frame) => {
    const at = offsetSec + frame / fps;
    while (cursor < points.length - 2 && points[cursor + 1]!.timeSec <= at) cursor++;
    const a = points[cursor]!;
    const b = points[Math.min(cursor + 1, points.length - 1)]!;
    if (at <= a.timeSec || b.timeSec <= a.timeSec) return at <= a.timeSec ? a.value : b.value;
    if (at >= b.timeSec) return b.value;
    return a.value + ((b.value - a.value) * (at - a.timeSec)) / (b.timeSec - a.timeSec);
  });
}

/** Film frame of a track time, rounded the way `beatGridFromMap` rounds, so peaks land on the grid's frames. */
export const hitFrame = (timeSec: number, fps: number, offsetSec: number) => Math.round((timeSec - offsetSec) * fps);

/** Attack on the hit frame at the hit's strength, then halving every half-life; overlapping hits take the max. */
export function envelope(
  hits: readonly { timeSec: number; strength: number }[],
  frameCount: number,
  fps: number,
  offsetSec: number,
  halfLifeMs: number,
): number[] {
  const out = new Array<number>(frameCount).fill(0);
  const halfLifeFrames = (halfLifeMs / 1000) * fps;
  const reach = Math.ceil(halfLifeFrames * 10);
  for (const hit of hits) {
    const start = hitFrame(hit.timeSec, fps, offsetSec);
    if (start >= frameCount) continue;
    for (let frame = Math.max(0, start); frame < Math.min(frameCount, start + reach); frame++) {
      const value = clip01(hit.strength) * 0.5 ** ((frame - start) / halfLifeFrames);
      if (value > out[frame]!) out[frame] = value;
    }
  }
  return out;
}

/** Position 0..1 inside the span between marks, extrapolated by the first and last spacing beyond them. */
export function phaseAt(marks: readonly number[], frame: number): number {
  if (marks.length < 2) return 0;
  let index = 0;
  let low = 0;
  let high = marks.length - 1;
  if (frame < marks[0]!) {
    const step = marks[1]! - marks[0]!;
    const value = (frame - marks[0]!) / step;
    return value - Math.floor(value);
  }
  if (frame >= marks[high]!) {
    const step = marks[high]! - marks[high - 1]!;
    const value = (frame - marks[high]!) / step;
    return value - Math.floor(value);
  }
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (marks[mid]! <= frame) {
      index = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  const span = marks[index + 1]! - marks[index]!;
  return span > 0 ? clip01((frame - marks[index]!) / span) % 1 : 0;
}

export function computeCurves(input: ComputeCurvesInput): AudioCurves {
  const { map, fps } = input;
  const offsetSec = input.offsetSec ?? 0;
  const params = { ...DEFAULT_CURVE_PARAMS, ...input.params };
  const frameCount = input.frameCount ?? Math.max(0, Math.round((map.source.durationSec - offsetSec) * fps));
  const curves: Partial<Record<AudioCurveName, number[]>> = {};
  const shaped = (values: number[]) => follow(values, fps, params.attackMs, params.releaseMs);

  let level: number[];
  if (input.measured) {
    const whole = percentile(input.measured.level, 0.995);
    level = normalise(input.measured.level);
    curves.low = shaped(normalise(input.measured.low, 0.1 * whole));
    curves.mid = shaped(normalise(input.measured.mid, 0.1 * whole));
    curves.high = shaped(normalise(input.measured.high, 0.1 * whole));
  } else {
    const points = (key: "rms" | "low" | "high") =>
      map.energyCurve.map((point) => ({ timeSec: point.timeSec, value: point[key] }));
    level = resample(points("rms"), frameCount, fps, offsetSec);
    curves.low = shaped(resample(points("low"), frameCount, fps, offsetSec));
    curves.high = shaped(resample(points("high"), frameCount, fps, offsetSec));
  }
  curves.level = shaped(level);
  curves.energy = normalise(boxSmooth(level, Math.max(1, Math.round(((params.energyWindowMs / 1000) * fps) / 2))));

  const stems = Object.entries(input.stems ?? {}).filter(
    (entry): entry is [keyof NonNullable<ComputeCurvesInput["stems"]>, number[]] => Array.isArray(entry[1]),
  );
  if (stems.length > 0) {
    const reference = Math.max(...stems.map(([, values]) => percentile(values, 0.995)));
    for (const [name, values] of stems) curves[name] = shaped(normalise(values, 0.1 * reference));
  }

  const drums = map.drums ?? {
    kick: map.events.filter((event) => event.kind === "kick"),
    snare: map.events.filter((event) => event.kind === "snare"),
    hat: map.events.filter((event) => event.kind === "hat"),
  };
  for (const kind of ["kick", "snare", "hat"] as const)
    curves[kind] = envelope(drums[kind], frameCount, fps, offsetSec, params.halfLifeMs);

  const toFilm = (seconds: readonly number[]) => seconds.map((sec) => Math.round((sec - offsetSec) * fps * 100) / 100);
  const trust = map.tempo.gridTrust;
  const beats = trust === "none" ? [] : toFilm(map.beatsSec);
  const downbeats = trust === "none" ? [] : toFilm(map.downbeatsSec);
  if (beats.length >= 2) curves.beatPhase = Array.from({ length: frameCount }, (_, frame) => phaseAt(beats, frame));
  if (downbeats.length >= 2)
    curves.barPhase = Array.from({ length: frameCount }, (_, frame) => phaseAt(downbeats, frame));
  if (downbeats.length > 0)
    curves.downbeat = envelope(
      map.downbeatsSec.map((timeSec) => ({ timeSec, strength: 1 })),
      frameCount,
      fps,
      offsetSec,
      params.halfLifeMs * 2,
    );

  return {
    schemaVersion: 1,
    kind: "audio-curves",
    fps,
    frameCount,
    offsetSec,
    source: input.source,
    grid: { trust, ...(map.tempo.bpm && trust !== "none" ? { bpm: map.tempo.bpm } : {}), beats, downbeats },
    params,
    curves: Object.fromEntries(
      Object.entries(curves).map(([name, values]) => [name, values.map((value) => round3(clip01(value)))]),
    ),
  };
}
