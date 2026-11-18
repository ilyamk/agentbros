import { spawnSync } from "node:child_process";
import { round } from "./stats";

// Tension: one curve that rises as a film builds, dips when it holds its breath and spikes at the hit, and the shape of
// its climax as an editor would describe it. Translated from ReelMimic's perception/tension.py (MIT, © 2026 ReelMimic
// contributors). Measured with ffmpeg alone, the same way for a reference and a render; their optical-flow camera and
// local-motion features and spectral flux are left out, so the weights below renormalise over what is measured.

export const TENSION_MAX_HZ = 30;
const CURVE_HZ = 10;
const WEIGHTS = { loudness: 0.28, diff: 0.1, cuts: 0.1, flash: 0.08 } as const;
type Feature = keyof typeof WEIGHTS;
/** Just-noticeable ranges: a feature that varies less than this over the whole film is not stretched to fill 0-1. */
export const JND: Record<Feature, number> = { loudness: 6, diff: 0.02, cuts: 0.5, flash: 0.05 };
/** Change below these is not seen at all and is taken off before normalising. Loudness has no meaningful zero. */
export const DEADZONE: Partial<Record<Feature, number>> = { diff: 0.005, flash: 0.02 };
const SMOOTH_SEC = 0.15;
const PEAK_PROMINENCE = 0.12;
const PEAK_GAP_SEC = 4;
const WIDTH = 64;
const HEIGHT = 36;
const AUDIO_RATE = 22050;

export type TensionPeak = {
  timeSec: number;
  height: number;
  prominence: number;
  /** Slope of the curve over up to 8 s before the breath, per second. */
  buildSlope: number;
  /** From where the curve first fell near its pre-hit low to the hit. */
  breathSec: number;
  breathDepth: number;
  /** Video frames from the bottom of the breath to 90% of the hit. */
  riseFrames: number;
  holdSec: number;
  decaySec: number;
  beatOffsetFrames?: number;
};

export type Tension = {
  sampleHz: number;
  features: Feature[];
  curve: { hz: number; values: number[] };
  peaks: TensionPeak[];
};

export type TensionFeatures = { sampleHz: number; diff: number[]; luma: number[]; loudness?: number[] };

/** Grey frames at up to 30 Hz (difference and brightness) and the sound's RMS level per sample, in dB. */
export function measureTensionFeatures(
  video: string,
  info: { fps: number; durationSec: number; hasAudio: boolean },
  audio = video,
): TensionFeatures {
  const sampleHz = Math.min(info.fps, TENSION_MAX_HZ);
  const frames = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      video,
      "-an",
      "-sn",
      "-map",
      "0:v:0",
      "-vf",
      `fps=${sampleHz},scale=${WIDTH}:${HEIGHT}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    { maxBuffer: 4 * 1024 * 1024 * 1024 },
  );
  if (frames.error || frames.status !== 0)
    throw new Error(
      `Could not decode frames of ${video}: ${frames.error?.message ?? frames.stderr?.toString().slice(-300)}`,
    );
  const size = WIDTH * HEIGHT;
  const count = Math.floor(frames.stdout.length / size);
  const diff: number[] = [];
  const luma: number[] = [];
  for (let index = 0; index < count; index++) {
    const current = frames.stdout.subarray(index * size, (index + 1) * size);
    let brightness = 0;
    let change = 0;
    for (let pixel = 0; pixel < size; pixel++) {
      brightness += current[pixel]!;
      if (index > 0) change += Math.abs(current[pixel]! - frames.stdout[(index - 1) * size + pixel]!);
    }
    luma.push(brightness / size / 255);
    diff.push(change / size / 255);
  }
  let loudness: number[] | undefined;
  if (info.hasAudio) {
    const sound = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-i",
        audio,
        "-vn",
        "-sn",
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        String(AUDIO_RATE),
        "-f",
        "f32le",
        "pipe:1",
      ],
      { maxBuffer: 4 * 1024 * 1024 * 1024 },
    );
    if (!sound.error && sound.status === 0) {
      const pcm = new Float32Array(sound.stdout.buffer, sound.stdout.byteOffset, Math.floor(sound.stdout.length / 4));
      const window = Math.round(AUDIO_RATE / sampleHz);
      loudness = Array.from({ length: count }, (_, index) => {
        const centre = Math.round(((index + 0.5) * AUDIO_RATE) / sampleHz);
        const from = Math.max(0, centre - window);
        const to = Math.min(pcm.length, centre + window);
        let squares = 0;
        for (let sample = from; sample < to; sample++) squares += pcm[sample]! ** 2;
        return 20 * Math.log10(Math.sqrt(squares / Math.max(1, to - from)) + 1e-6);
      });
    }
  }
  return { sampleHz, diff, luma, ...(loudness ? { loudness } : {}) };
}

const percentile = (values: number[], share: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  const position = share * (sorted.length - 1);
  const low = Math.floor(position);
  const high = Math.min(sorted.length - 1, low + 1);
  return sorted[low]! + (sorted[high]! - sorted[low]!) * (position - low);
};

/** 5th-95th percentile to 0-1, never stretching a range smaller than what a viewer notices. */
export function robust01(values: number[], jnd = 0): number[] {
  if (!values.length) return [];
  const low = percentile(values, 0.05);
  const span = Math.max(percentile(values, 0.95) - low, jnd);
  return span > 1e-9 ? values.map((value) => Math.min(1, Math.max(0, (value - low) / span))) : values.map(() => 0);
}

export function gaussianSmooth(values: number[], sigma: number): number[] {
  if (sigma <= 0) return [...values];
  const radius = Math.ceil(4 * sigma);
  const kernel = Array.from({ length: 2 * radius + 1 }, (_, index) =>
    Math.exp(-((index - radius) ** 2) / (2 * sigma * sigma)),
  );
  const total = kernel.reduce((sum, value) => sum + value, 0);
  // Mirrors at the ends, as scipy's gaussian_filter1d does by default.
  const at = (index: number) => {
    const count = values.length;
    let position = index;
    while (position < 0 || position >= count) position = position < 0 ? -position - 1 : 2 * count - position - 1;
    return values[position]!;
  };
  return values.map(
    (_, index) => kernel.reduce((sum, weight, offset) => sum + weight * at(index + offset - radius), 0) / total,
  );
}

function runningMedian(values: number[], size: number): number[] {
  const half = Math.floor(size / 2);
  return values.map((_, index) => {
    const window = values
      .slice(Math.max(0, index - half), Math.min(values.length, index + half + 1))
      .sort((a, b) => a - b);
    return window[Math.floor(window.length / 2)]!;
  });
}

export function cutDensity(cutTimes: number[], count: number, hz: number): number[] {
  const impulses = new Array<number>(count).fill(0);
  for (const time of cutTimes) {
    const index = Math.round(time * hz);
    if (index >= 0 && index < count) impulses[index] = 1;
  }
  return gaussianSmooth(impulses, 0.75 * hz).map((value) => value * hz);
}

export function tensionCurve(features: TensionFeatures, cutTimes: number[]): { values: number[]; used: Feature[] } {
  const { sampleHz: hz, diff, luma } = features;
  const count = diff.length;
  const base = runningMedian(luma, Math.max(3, Math.round(hz)) | 1);
  const raw: Partial<Record<Feature, number[]>> = {
    diff,
    cuts: cutDensity(cutTimes, count, hz),
    flash: luma.map((value, index) => Math.max(0, value - base[index]!)),
    ...(features.loudness ? { loudness: features.loudness.slice(0, count) } : {}),
  };
  const used = (Object.keys(WEIGHTS) as Feature[]).filter((name) => raw[name]?.length === count);
  const weight = used.reduce((sum, name) => sum + WEIGHTS[name], 0);
  const mix = new Array<number>(count).fill(0);
  for (const name of used) {
    const seen = raw[name]!.map((value) =>
      DEADZONE[name] !== undefined ? Math.max(0, value - DEADZONE[name]!) : value,
    );
    robust01(seen, JND[name]).forEach((value, index) => (mix[index]! += (WEIGHTS[name] * value) / weight));
  }
  return { values: gaussianSmooth(mix, SMOOTH_SEC * hz), used };
}

/** Local maxima with their topographic prominence, thinned to one per `distance` samples by height, as scipy's find_peaks. */
export function findPeaks(
  values: number[],
  minProminence: number,
  distance: number,
): { index: number; prominence: number }[] {
  const candidates: number[] = [];
  for (let index = 1; index < values.length - 1; index++) {
    if (values[index]! <= values[index - 1]!) continue;
    let end = index;
    while (end + 1 < values.length && values[end + 1] === values[index]) end++;
    if (end + 1 < values.length && values[end + 1]! < values[index]!) candidates.push(Math.floor((index + end) / 2));
    index = end;
  }
  const kept = new Set<number>();
  for (const index of [...candidates].sort((a, b) => values[b]! - values[a]!))
    if ([...kept].every((other) => Math.abs(other - index) >= distance)) kept.add(index);
  return [...kept]
    .sort((a, b) => a - b)
    .map((index) => {
      const height = values[index]!;
      let left = index;
      let leftMin = height;
      while (left > 0 && values[left - 1]! <= height) leftMin = Math.min(leftMin, values[--left]!);
      let right = index;
      let rightMin = height;
      while (right < values.length - 1 && values[right + 1]! <= height) rightMin = Math.min(rightMin, values[++right]!);
      return { index, prominence: height - Math.max(leftMin, rightMin) };
    })
    .filter((peak) => peak.prominence >= minProminence);
}

/** The most prominent peaks, each with the shape of its build, breath, hit and release. `fps` converts the rise to video frames. */
export function describePeaks(values: number[], hz: number, fps: number, count = 3): TensionPeak[] {
  if (values.length < hz) return [];
  const found = findPeaks(values, PEAK_PROMINENCE, Math.max(1, Math.round(PEAK_GAP_SEC * hz)));
  return found
    .sort((a, b) => b.prominence * values[b.index]! - a.prominence * values[a.index]!)
    .slice(0, count)
    .sort((a, b) => a.index - b.index)
    .map(({ index, prominence }) => {
      let hit = index;
      while (hit > 0 && values[hit - 1]! >= 0.97 * values[index]!) hit--;
      const from = Math.max(0, hit - Math.round(2 * hz));
      let dip = hit;
      for (let position = hit - 1; position >= from; position--) if (values[position]! < values[dip]!) dip = position;
      const before = values.slice(Math.max(0, dip - Math.round(4 * hz)), dip + 1);
      const breathDepth = before.length ? Math.max(...before) - values[dip]! : 0;
      let breathStart = dip;
      while (breathStart > 0 && values[breathStart - 1]! <= values[dip]! + 0.2 * breathDepth) breathStart--;
      const buildFrom = Math.max(0, breathStart - Math.round(8 * hz));
      let buildSlope = 0;
      if (breathStart - buildFrom >= 4) {
        const xs = Array.from({ length: breathStart - buildFrom + 1 }, (_, offset) => (buildFrom + offset) / hz);
        const ys = values.slice(buildFrom, breathStart + 1);
        const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
        const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
        const spread = xs.reduce((sum, value) => sum + (value - meanX) ** 2, 0);
        buildSlope =
          spread > 0 ? xs.reduce((sum, value, offset) => sum + (value - meanX) * (ys[offset]! - meanY), 0) / spread : 0;
      }
      const top = values[index]!;
      const low = values[dip]!;
      const rise = Math.max(
        0,
        values.slice(dip, hit + 1).findIndex((value) => value >= low + 0.9 * (top - low)),
      );
      const after = values.slice(hit);
      const holdSamples = after.findIndex((value) => value < 0.9 * top);
      const half = top - 0.5 * (top - low);
      const decaySamples = after.findIndex((value) => value < half);
      return {
        timeSec: round(hit / hz, 3),
        height: round(top, 3),
        prominence: round(prominence, 3),
        buildSlope: round(buildSlope, 4),
        breathSec: round((hit - breathStart) / hz, 3),
        breathDepth: round(breathDepth, 3),
        riseFrames: Math.round((rise * fps) / hz),
        holdSec: round((holdSamples < 0 ? after.length : holdSamples) / hz, 3),
        decaySec: round((decaySamples < 0 ? after.length : decaySamples) / hz, 3),
      };
    });
}

export function measureTension(features: TensionFeatures, cutTimes: number[], fps: number): Tension {
  const { values, used } = tensionCurve(features, cutTimes);
  const every = Math.max(1, Math.round(features.sampleHz / CURVE_HZ));
  return {
    sampleHz: features.sampleHz,
    features: used,
    curve: {
      hz: round(features.sampleHz / every, 3),
      values: values.filter((_, index) => index % every === 0).map((value) => round(value, 3)),
    },
    peaks: describePeaks(values, features.sampleHz, fps),
  };
}

/** The climax: the peak that stands out most, by prominence times height. */
export function climaxOf(tension: { peaks: TensionPeak[] } | undefined): TensionPeak | undefined {
  return tension?.peaks.reduce<TensionPeak | undefined>(
    (best, peak) => (!best || peak.prominence * peak.height > best.prominence * best.height ? peak : best),
    undefined,
  );
}

/** Video frames from the climax to its nearest beat: negative lands before the beat. */
export function beatOffsetFrames(peak: TensionPeak, beatsSec: number[], fps: number): number | undefined {
  if (!beatsSec.length) return undefined;
  const nearest = beatsSec.reduce((best, beat) =>
    Math.abs(beat - peak.timeSec) < Math.abs(best - peak.timeSec) ? beat : best,
  );
  return round((peak.timeSec - nearest) * fps, 1);
}
