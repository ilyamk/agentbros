import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { decodeFrames, type VideoInfo } from "../vision/media";
import type { ReferenceCrop } from "../../types/reference";

// Phone-UI and letterbox detection, after ReelMimic's analyze.py detect_crop and ui_strip_crop (MIT, © 2026 ReelMimic contributors).

/** A crop that keeps more of the frame than this is not worth a second copy of the film. */
const MAX_KEPT_AREA = 0.85;
const MIN_KEPT_SIDE = 0.15;
const BAND_SAMPLES = 12;
/** Mean temporal standard deviation (0-255) of a row or column that counts as playing picture. */
const ACTIVE_FLOOR = 6;
const ACTIVE_SHARE_OF_MAX = 0.35;
/** A band outside the picture must be this still against the busiest row, or it is picture too. */
const STATIC_SHARE_OF_MAX = 0.2;
const MIN_BAND_SHARE = 0.03;

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/** Union of ffmpeg cropdetect boxes over the film: removes only what is black in every sampled frame. */
export function detectLetterbox(media: string, info: VideoInfo): ReferenceCrop | undefined {
  const rate = Math.min(2, 120 / Math.max(1, info.durationSec));
  const result = spawnSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      media,
      "-an",
      "-sn",
      "-vf",
      `fps=${rate.toFixed(4)},cropdetect=limit=24:round=2:reset=1:skip=0`,
      "-f",
      "null",
      "-",
    ],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600000 },
  );
  if (result.error || result.status !== 0) return undefined;
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (const match of result.stderr.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)) {
    const [x1, x2, y1, y2] = match.slice(1, 5).map(Number) as [number, number, number, number];
    if (x2 <= x1 || y2 <= y1) continue;
    left = Math.min(left, x1);
    right = Math.max(right, x2);
    top = Math.min(top, y1);
    bottom = Math.max(bottom, y2);
  }
  if (!Number.isFinite(left)) return undefined;
  const width = even(Math.min(info.width - left, right - left + 1));
  const height = even(Math.min(info.height - top, bottom - top + 1));
  if (
    width * height > MAX_KEPT_AREA * info.width * info.height ||
    width < MIN_KEPT_SIDE * info.width ||
    height < MIN_KEPT_SIDE * info.height
  )
    return undefined;
  return {
    x: left,
    y: top,
    width,
    height,
    method: "letterbox",
    note: "Black bars in every sampled frame: letterbox, pillarbox or a picture inside a larger frame.",
  };
}

/** The longest run of indices above the floor. */
function longestRun(values: number[], floor: number): [number, number] | undefined {
  let best: [number, number] | undefined;
  let start = -1;
  values.forEach((value, index) => {
    if (value > floor && start < 0) start = index;
    const ends = start >= 0 && (value <= floor || index === values.length - 1);
    if (ends) {
      const end = value > floor ? index : index - 1;
      if (!best || end - start > best[1] - best[0]) best = [start, end];
      start = -1;
    }
  });
  return best;
}

const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

type GreyFrame = { width: number; height: number; data: Uint8Array | Buffer };
const greyAt = (frame: GreyFrame, x: number, y: number) => {
  const offset = (y * frame.width + x) * 3;
  return 0.299 * frame.data[offset]! + 0.587 * frame.data[offset + 1]! + 0.114 * frame.data[offset + 2]!;
};

/** Standard deviation over time of each row, each column and each pixel, and each pixel's mean, from evenly spread grey frames. */
export function temporalSpread(frames: GreyFrame[]): {
  rows: number[];
  columns: number[];
  pixels: Float32Array;
  means: Float32Array;
} {
  const { width, height } = frames[0]!;
  const count = frames.length;
  const rows = new Array<number>(height).fill(0);
  const columns = new Array<number>(width).fill(0);
  const pixels = new Float32Array(width * height);
  const means = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let squares = 0;
      for (const frame of frames) {
        const grey = greyAt(frame, x, y);
        sum += grey;
        squares += grey * grey;
      }
      const spread = Math.sqrt(Math.max(0, squares / count - (sum / count) ** 2));
      pixels[y * width + x] = spread;
      means[y * width + x] = sum / count;
      rows[y]! += spread / width;
      columns[x]! += spread / height;
    }
  return { rows, columns, pixels, means };
}

/** A pixel whose grey moves more than this (standard deviation over the samples) changed: picture crossed it. */
const CHANGED_SPREAD = 12;
/** A UI band or a bar is still nearly everywhere along its whole length; the film's own ground is crossed by the picture now and then. */
const MAX_CHANGED_SHARE = 0.02;
/** Median grey step across the band's inner edge: a real band ends at a hard edge; the film's own ground runs on into the picture. */
const MIN_EDGE_STEP = 10;
/** A band wider than this share of its side must also be uniform (a bar or a plain ground), or it is probably picture. */
const MAX_BUSY_BAND_SHARE = 0.15;
const MAX_UNIFORM_SPREAD = 10;
const EDGE_DEPTH = 2;

type Band = { axis: "rows" | "columns"; from: number; to: number; inside: number; towardPicture: -1 | 1 };

/**
 * Whether a still band beside the picture is a real band (bar, phone UI) and not still picture: nearly every pixel of it
 * stays still, a hard edge separates it from the picture in most samples, and a wide band is uniform. Returns why not.
 */
export function bandFault(
  band: Band,
  frames: GreyFrame[],
  spread: ReturnType<typeof temporalSpread>,
): string | undefined {
  const { width, height } = frames[0]!;
  const length = band.axis === "rows" ? width : height;
  const at = (along: number, across: number) =>
    band.axis === "rows" ? across * width + along : along * width + across;
  let changed = 0;
  let total = 0;
  let sum = 0;
  let squares = 0;
  for (let across = band.from; across < band.to; across++)
    for (let along = 0; along < length; along++) {
      const index = at(along, across);
      if (spread.pixels[index]! > CHANGED_SPREAD) changed++;
      sum += spread.means[index]!;
      squares += spread.means[index]! ** 2;
      total++;
    }
  if (!total) return undefined;
  if (changed / total > MAX_CHANGED_SHARE) return `picture crosses ${round(changed / total)} of the band`;
  const side = band.axis === "rows" ? height : width;
  const uniformSpread = Math.sqrt(Math.max(0, squares / total - (sum / total) ** 2));
  if ((band.to - band.from) / side > MAX_BUSY_BAND_SHARE && uniformSpread > MAX_UNIFORM_SPREAD)
    return `a busy band of ${round((band.to - band.from) / side)} of the frame`;
  // The step from the band's last lines to the picture's first, per sampled frame.
  const steps = frames.map((frame) => {
    let step = 0;
    let count = 0;
    for (let depth = 0; depth < EDGE_DEPTH; depth++) {
      const picture = band.inside + band.towardPicture * (depth + 1);
      const edge = band.inside - band.towardPicture * depth;
      if (picture < 0 || picture >= side || edge < 0 || edge >= side) continue;
      for (let along = 0; along < length; along++) {
        const [ox, oy] = band.axis === "rows" ? [along, picture] : [picture, along];
        const [ix, iy] = band.axis === "rows" ? [along, edge] : [edge, along];
        step += Math.abs(greyAt(frame, ox, oy) - greyAt(frame, ix, iy));
        count++;
      }
    }
    return count ? step / count : 0;
  });
  const medianStep = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? 0;
  if (medianStep < MIN_EDGE_STEP) return `no edge between band and picture (median step ${round(medianStep)})`;
  return undefined;
}

const round = (value: number) => Number(value.toFixed(3));

/** The playing picture between still bands, along one axis, as a share of that axis. */
export function activeBand(spread: number[]): { start: number; end: number } | undefined {
  const peak = Math.max(...spread);
  const run = longestRun(spread, Math.max(ACTIVE_FLOOR, peak * ACTIVE_SHARE_OF_MAX));
  if (!run) return undefined;
  const [start, end] = run;
  const length = end - start + 1;
  const before = spread.slice(0, start);
  const after = spread.slice(end + 1);
  const still = (band: number[]) =>
    band.length === 0 || (band.length >= MIN_BAND_SHARE * spread.length && mean(band) < STATIC_SHARE_OF_MAX * peak);
  if (
    length > MAX_KEPT_AREA * spread.length ||
    length < MIN_KEPT_SIDE * spread.length ||
    !still(before) ||
    !still(after)
  )
    return undefined;
  return { start: start / spread.length, end: (end + 1) / spread.length };
}

/** Phone screen recordings put the film between busy but static UI bands that cropdetect cannot see through. */
export function detectStaticBands(media: string, info: VideoInfo): ReferenceCrop | undefined {
  const width = Math.max(32, Math.min(270, Math.round(info.width / 4)));
  const height = Math.max(32, Math.round((width * info.height) / info.width));
  const step = Math.max(1, Math.floor(info.frameCount / BAND_SAMPLES));
  const frames = decodeFrames(media, info, {
    startFrame: Math.floor(step / 2),
    count: BAND_SAMPLES,
    step,
    width,
    height,
  });
  if (frames.length < 4) return undefined;
  const spread = temporalSpread(frames);
  const faults: string[] = [];
  // Each still band must look like a real band; one that does not stays in the picture, which then runs to that edge.
  const checked = (axis: Band["axis"], band: { start: number; end: number } | undefined) => {
    if (!band) return undefined;
    const size = axis === "rows" ? height : width;
    const first = Math.round(band.start * size);
    const last = Math.round(band.end * size);
    const before =
      first > 0
        ? bandFault({ axis, from: 0, to: first, inside: first - 1, towardPicture: 1 }, frames, spread)
        : undefined;
    const after =
      last < size
        ? bandFault({ axis, from: last, to: size, inside: last, towardPicture: -1 }, frames, spread)
        : undefined;
    if (before) faults.push(`${axis === "rows" ? "top" : "left"}: ${before}`);
    if (after) faults.push(`${axis === "rows" ? "bottom" : "right"}: ${after}`);
    const kept = { start: before ? 0 : band.start, end: after ? 1 : band.end };
    return kept.start === 0 && kept.end === 1 ? undefined : kept;
  };
  const vertical = checked("rows", activeBand(spread.rows));
  const horizontal = checked("columns", activeBand(spread.columns));
  if (faults.length) emitProgress(`Still bands kept as picture: ${faults.join("; ")}`);
  if (!vertical && !horizontal) return undefined;
  const y = vertical ? even(vertical.start * info.height) : 0;
  const x = horizontal ? even(horizontal.start * info.width) : 0;
  const cropHeight = vertical
    ? even(Math.min(info.height - y, (vertical.end - vertical.start) * info.height))
    : info.height;
  const cropWidth = horizontal
    ? even(Math.min(info.width - x, (horizontal.end - horizontal.start) * info.width))
    : info.width;
  if (cropWidth * cropHeight > MAX_KEPT_AREA * info.width * info.height) return undefined;
  return {
    x,
    y,
    width: cropWidth,
    height: cropHeight,
    method: "static-bands",
    note: "Moving picture between still bands: a phone screen recording or a frame with a fixed UI.",
  };
}

export function detectCrop(media: string, info: VideoInfo): ReferenceCrop | undefined {
  return detectLetterbox(media, info) ?? detectStaticBands(media, info);
}

export function parseCrop(value: string, info: { width: number; height: number }): ReferenceCrop {
  const match = /^(\d+):(\d+):(\d+):(\d+)$/.exec(value.trim());
  if (!match)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--crop is W:H:X:Y in pixels, got "${value}".` });
  const [width, height, x, y] = match.slice(1).map(Number) as [number, number, number, number];
  if (width < 2 || height < 2 || x + width > info.width || y + height > info.height)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--crop ${value} does not fit a ${info.width}x${info.height} frame.`,
    });
  return { x, y, width: even(width), height: even(height), method: "manual" };
}

/** The cropped analysis copy, made once beside the source: same clock, sound kept, a keyframe every 12 frames for seeking. */
export function croppedMedia(media: string, crop: ReferenceCrop): string {
  const target = path.join(path.dirname(media), `analysis-${crop.width}x${crop.height}+${crop.x}+${crop.y}.mp4`);
  if (existsSync(target)) return target;
  mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp.mp4`;
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      media,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-vf",
      `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "16",
      "-g",
      "12",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "256k",
      temporary,
    ],
    { encoding: "utf8", timeout: 1800000, killSignal: "SIGKILL" },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not crop the reference for analysis: ${result.error?.message ?? result.stderr.slice(-400)}`,
    });
  renameSync(temporary, target);
  return target;
}
