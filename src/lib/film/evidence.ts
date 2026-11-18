import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject, emitProgress } from "../cli";
import { detectBoundaries } from "../reference/shots";
import { probeVideo, type VideoInfo } from "../vision/media";
import { FlashReportSchema, measureFlashesInFile } from "../sensors/flash";
import { measureTension, measureTensionFeatures } from "./tension";

// What one video measures, before anything is compared with a target. It is the slow part, so it can be kept in a file.

export const MOTION_SAMPLE_FPS = 10;
const MOTION_WIDTH = 160;
const MOTION_HEIGHT = 90;
/** Below this, a channel difference is compression noise rather than something moving. */
const CHANGED_PIXEL_LEVEL = 6;
const SILENCE_DB = -50;
const SILENCE_MIN_SEC = 0.5;
const METER_FLOOR = -70;

const BoundarySchema = z.object({
  timeSec: z.number(),
  startSec: z.number(),
  endSec: z.number(),
  kind: z.string(),
  confidence: z.number(),
  measures: z.record(z.string(), z.number()).optional(),
});
export type FilmBoundary = z.infer<typeof BoundarySchema>;

const FilmAudioSchema = z.object({
  integratedLufs: z.number().nullable(),
  loudnessRangeLu: z.number().nullable(),
  truePeakDb: z.number().nullable(),
  /** Energy mean of the momentary (400 ms) EBU R128 loudness over each second; null below the meter's floor. */
  perSecond: z.array(z.object({ timeSec: z.number(), lufs: z.number().nullable() })),
  silences: z.array(z.object({ startSec: z.number(), endSec: z.number() })),
});
export type FilmAudio = z.infer<typeof FilmAudioSchema>;

/** Raise when a measurement changes, so kept evidence files are measured again. */
export const EVIDENCE_VERSION = 3;

export const FilmEvidenceSchema = z.object({
  schemaVersion: z.literal(EVIDENCE_VERSION),
  sha256: z.string(),
  path: z.string(),
  video: z.object({
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    frameCount: z.number(),
    durationSec: z.number(),
    hasAudio: z.boolean(),
  }),
  detector: z.string(),
  boundaries: z.array(BoundarySchema),
  candidateCount: z.number(),
  /** `energy` is the mean luma difference between samples, 0-255; `changed` the share of pixels that moved beyond noise. */
  motion: z.array(z.object({ timeSec: z.number(), energy: z.number(), changed: z.number() })),
  audio: FilmAudioSchema.optional(),
  /** The tension curve and its peaks (src/lib/film/tension.ts). Added without a version bump: kept files lacking it are measured again. */
  tension: z
    .object({
      sampleHz: z.number(),
      features: z.array(z.string()),
      curve: z.object({ hz: z.number(), values: z.array(z.number()) }),
      peaks: z.array(
        z.object({
          timeSec: z.number(),
          height: z.number(),
          prominence: z.number(),
          buildSlope: z.number(),
          breathSec: z.number(),
          breathDepth: z.number(),
          riseFrames: z.number(),
          holdSec: z.number(),
          decaySec: z.number(),
        }),
      ),
    })
    .optional(),
  /** WCAG 2.3.1 flashes over every frame (src/lib/sensors/flash.ts). Added without a version bump: kept files lacking it are measured again. */
  flash: FlashReportSchema.optional(),
  /** Per motion sample, the share of a 4x4 grid's cells that changed. Added without a version bump: kept files lacking it are measured again. */
  spread: z.array(z.number()).optional(),
  /** Consecutive-frame pairs: change and Laplacian sharpness (measureSharpness). Added without a version bump, like spread. */
  sharpness: z
    .object({
      width: z.number(),
      height: z.number(),
      step: z.number().optional(),
      samples: z.array(z.object({ timeSec: z.number(), change: z.number(), sharpness: z.number() })),
    })
    .optional(),
});
export type FilmEvidence = z.infer<typeof FilmEvidenceSchema>;
export type FilmSharpness = NonNullable<FilmEvidence["sharpness"]>;

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

export function hashFileSync(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** Cells per side of the motion-spread grid. */
export const SPREAD_GRID = 4;
/** A cell has moved when more than this share of its pixels changed beyond noise. */
// provisional: recalibrated from ref:corpus
export const SPREAD_CELL_SHARE = 0.05;

/** Share of the grid's cells (SPREAD_GRID x SPREAD_GRID) in which more than SPREAD_CELL_SHARE of the pixels changed beyond `level`. */
export function gridChangedShare(
  current: Uint8Array,
  previous: Uint8Array,
  width: number,
  height: number,
  level = CHANGED_PIXEL_LEVEL,
  grid = SPREAD_GRID,
): number {
  const changed = new Float64Array(grid * grid);
  const total = new Float64Array(grid * grid);
  for (let y = 0; y < height; y++) {
    const row = Math.min(grid - 1, Math.floor((y * grid) / height)) * grid;
    for (let x = 0; x < width; x++) {
      const cell = row + Math.min(grid - 1, Math.floor((x * grid) / width));
      total[cell]!++;
      if (Math.abs(current[y * width + x]! - previous[y * width + x]!) > level) changed[cell]!++;
    }
  }
  let moved = 0;
  for (let cell = 0; cell < grid * grid; cell++)
    if (total[cell]! && changed[cell]! / total[cell]! > SPREAD_CELL_SHARE) moved++;
  return moved / (grid * grid);
}

/** Variance of the 4-neighbour Laplacian over interior pixels: high for crisp edges, falling as motion blur smears them. */
export function laplacianVariance(image: Uint8Array, width: number, height: number): number {
  let sum = 0;
  let squares = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++)
    for (let x = 1; x < width - 1; x++) {
      const at = y * width + x;
      const value = 4 * image[at]! - image[at - 1]! - image[at + 1]! - image[at - width]! - image[at + width]!;
      sum += value;
      squares += value * value;
      count++;
    }
  return count ? squares / count - (sum / count) ** 2 : 0;
}

/** Whole-frame change and grid spread per sample pair, at MOTION_SAMPLE_FPS; one decode for both. */
export function motionPass(media: string): { motion: FilmEvidence["motion"]; spread: number[] } {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      media,
      "-an",
      "-sn",
      "-map",
      "0:v:0",
      "-vf",
      `fps=${MOTION_SAMPLE_FPS},scale=${MOTION_WIDTH}:${MOTION_HEIGHT}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    { maxBuffer: 8 * 1024 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not decode frames of ${media}: ${result.error?.message ?? result.stderr?.toString().slice(-300)}`,
    });
  const size = MOTION_WIDTH * MOTION_HEIGHT;
  const count = Math.floor(result.stdout.length / size);
  const motion: FilmEvidence["motion"] = [];
  const spread: number[] = [];
  for (let index = 1; index < count; index++) {
    const current = result.stdout.subarray(index * size, (index + 1) * size);
    const previous = result.stdout.subarray((index - 1) * size, index * size);
    let total = 0;
    let changed = 0;
    for (let pixel = 0; pixel < size; pixel++) {
      const difference = Math.abs(current[pixel]! - previous[pixel]!);
      total += difference;
      if (difference > CHANGED_PIXEL_LEVEL) changed++;
    }
    motion.push({
      timeSec: round(index / MOTION_SAMPLE_FPS, 2),
      energy: round(total / size),
      changed: round(changed / size, 5),
    });
    spread.push(round(gridChangedShare(current, previous, MOTION_WIDTH, MOTION_HEIGHT), 4));
  }
  return { motion, spread };
}

/** Whole-frame change at a fixed 10 samples a second, the same for any frame rate or size. */
export function measureMotion(media: string): FilmEvidence["motion"] {
  return motionPass(media).motion;
}

/** Long side of the sharpness decode: 160x90 is too coarse to see blur. */
const SHARP_LONG_SIDE = 480;
const SHARP_SAMPLES_PER_SEC = 5;
/** Beyond this per-channel difference a pixel moved between two consecutive frames. */
const SHARP_CHANGED_LEVEL = 10;

/**
 * Frames between sampled pairs: about SHARP_SAMPLES_PER_SEC a second, but never a multiple of 2 or 3. Animation held on twos or threes (a
 * stutter) repeats with that period, so a step of 6 at 30 fps always landed on a held pair and read stepped motion as still; calibrated on
 * stutter pairs, 2026-11-15 (design-reference/calibration.md).
 */
export function sharpnessStep(fps: number): number {
  let step = Math.max(2, Math.round(fps / SHARP_SAMPLES_PER_SEC));
  while (step % 2 === 0 || step % 3 === 0) step++;
  return step;
}

/**
 * Pairs of consecutive frames, about SHARP_SAMPLES_PER_SEC a second: how much of the picture moved in one frame (`change`, share of pixels) and how
 * crisp the first frame is (`sharpness`, Laplacian variance). Real motion that fast blurs; rendered motion without motion blur does not.
 */
export function measureSharpness(media: string, video: Pick<VideoInfo, "width" | "height" | "fps">): FilmSharpness {
  const scale = SHARP_LONG_SIDE / Math.max(video.width, video.height);
  const width = Math.max(2, Math.round((video.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((video.height * scale) / 2) * 2);
  const step = sharpnessStep(video.fps);
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      media,
      "-an",
      "-sn",
      "-map",
      "0:v:0",
      "-vf",
      `select='lt(mod(n\\,${step})\\,2)',scale=${width}:${height}:flags=area,format=gray`,
      "-fps_mode",
      "passthrough",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    { maxBuffer: 8 * 1024 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not decode frames of ${media}: ${result.error?.message ?? result.stderr?.toString().slice(-300)}`,
    });
  const size = width * height;
  const pairs = Math.floor(result.stdout.length / size / 2);
  const samples: FilmSharpness["samples"] = [];
  for (let pair = 0; pair < pairs; pair++) {
    const first = result.stdout.subarray(pair * 2 * size, (pair * 2 + 1) * size);
    const second = result.stdout.subarray((pair * 2 + 1) * size, (pair * 2 + 2) * size);
    let changed = 0;
    for (let pixel = 0; pixel < size; pixel++)
      if (Math.abs(first[pixel]! - second[pixel]!) > SHARP_CHANGED_LEVEL) changed++;
    samples.push({
      timeSec: round((pair * step) / video.fps, 3),
      change: round(changed / size, 4),
      sharpness: round(laplacianVariance(first, width, height), 1),
    });
  }
  return { width, height, step, samples };
}

const number = (text: string | undefined) => {
  const value = Number(text);
  return text !== undefined && Number.isFinite(value) ? value : null;
};

/** Parses ffmpeg's ebur128 and silencedetect log. */
export function parseLoudnessLog(log: string, durationSec: number): FilmAudio {
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const buckets = new Map<number, number[]>();
  for (const match of log.matchAll(/t:\s*([\d.]+)\s+.*?M:\s*(-?[\d.]+|-?inf|nan)/g)) {
    const second = Math.floor(Number(match[1]));
    const lufs = number(match[2]);
    buckets.set(second, [...(buckets.get(second) ?? []), lufs === null ? METER_FLOOR : Math.max(lufs, METER_FLOOR)]);
  }
  const perSecond = [...buckets.entries()].map(([second, readings]) => {
    const lufs = 10 * Math.log10(readings.reduce((sum, reading) => sum + 10 ** (reading / 10), 0) / readings.length);
    return { timeSec: second, lufs: lufs <= METER_FLOOR + 0.01 ? null : round(lufs, 1) };
  });
  const silences: FilmAudio["silences"] = [];
  let open: number | undefined;
  for (const match of log.matchAll(/silence_(start|end):\s*(-?[\d.]+)/g)) {
    if (match[1] === "start") open = Math.max(0, Number(match[2]));
    else if (open !== undefined) {
      silences.push({ startSec: round(open), endSec: round(Number(match[2])) });
      open = undefined;
    }
  }
  if (open !== undefined) silences.push({ startSec: round(open), endSec: round(durationSec) });
  const integrated = number(/I:\s*(-?[\d.]+|-?inf)\s*LUFS/.exec(summary)?.[1]);
  return {
    integratedLufs: integrated === null || integrated <= METER_FLOOR ? null : integrated,
    loudnessRangeLu: number(/LRA:\s*([\d.]+)\s*LU/.exec(summary)?.[1]),
    truePeakDb: number(/Peak:\s*(-?[\d.]+|-?inf)\s*dBFS/.exec(summary)?.[1]),
    perSecond,
    silences,
  };
}

export function measureAudio(media: string, durationSec: number): FilmAudio {
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-nostdin",
      "-i",
      media,
      "-map",
      "0:a:0",
      "-af",
      `silencedetect=n=${SILENCE_DB}dB:d=${SILENCE_MIN_SEC},ebur128=peak=true:framelog=info`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not measure audio of ${media}: ${result.error?.message ?? result.stderr?.slice(-300)}`,
    });
  return parseLoudnessLog(result.stderr, durationSec);
}

/** `audioMedia` measures the sound from another file of the same film, such as the uncropped source of a cropped reference. */
export function gatherEvidence(
  media: string,
  options: {
    shots?: { boundaries: FilmBoundary[]; candidateCount: number; detector: string };
    audioMedia?: string;
  } = {},
): FilmEvidence {
  const video: VideoInfo = probeVideo(media);
  let shots = options.shots;
  if (!shots) {
    emitProgress(`Detecting shots in ${path.basename(media)}`);
    const detected = detectBoundaries(media);
    shots = {
      boundaries: detected.boundaries as FilmBoundary[],
      candidateCount: detected.candidates?.length ?? 0,
      detector: detected.detector.name,
    };
  }
  emitProgress(`Measuring motion and sound of ${path.basename(media)}`);
  const audioMedia = options.audioMedia ?? media;
  let tension: FilmEvidence["tension"];
  try {
    tension = measureTension(
      measureTensionFeatures(media, video, audioMedia),
      shots.boundaries.map((row) => row.timeSec),
      video.fps,
    );
  } catch (error) {
    emitProgress(`Tension not measured: ${error instanceof Error ? error.message : String(error)}`);
  }
  let flash: FilmEvidence["flash"];
  try {
    flash = measureFlashesInFile(media, video.fps);
  } catch (error) {
    emitProgress(`Flashes not measured: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { motion, spread } = motionPass(media);
  let sharpness: FilmSharpness | undefined;
  try {
    sharpness = measureSharpness(media, video);
  } catch (error) {
    emitProgress(`Sharpness not measured: ${error instanceof Error ? error.message : String(error)}`);
  }
  return FilmEvidenceSchema.parse({
    schemaVersion: EVIDENCE_VERSION,
    sha256: hashFileSync(media),
    path: path.resolve(media),
    video,
    detector: shots.detector,
    boundaries: shots.boundaries,
    candidateCount: shots.candidateCount,
    motion,
    ...(video.hasAudio ? { audio: measureAudio(audioMedia, video.durationSec) } : {}),
    ...(tension ? { tension } : {}),
    ...(flash ? { flash } : {}),
    spread,
    ...(sharpness ? { sharpness } : {}),
  });
}

/** Reuses a kept evidence file only while it still describes this exact video. */
export function evidenceFor(media: string, cacheFile: string | undefined): FilmEvidence {
  if (cacheFile && existsSync(cacheFile)) {
    const kept = FilmEvidenceSchema.safeParse(JSON.parse(readFileSync(cacheFile, "utf8")));
    if (
      kept.success &&
      kept.data.sha256 === hashFileSync(media) &&
      kept.data.tension &&
      kept.data.flash &&
      kept.data.spread &&
      kept.data.sharpness?.step === sharpnessStep(kept.data.video.fps)
    )
      return kept.data;
  }
  const evidence = gatherEvidence(media);
  if (cacheFile) writeJsonAtomic(cacheFile, evidence);
  return evidence;
}

export function writeJsonAtomic(file: string, value: unknown): string {
  const absolute = path.resolve(file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, absolute);
  return absolute;
}
