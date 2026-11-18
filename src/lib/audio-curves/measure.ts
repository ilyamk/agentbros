import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, requireFile } from "../cli";
import type { MeasuredLevels } from "./compute";

const RATE = 24000;
/** Band edges in Hz: low is kick and bass, high is hats and air. */
export const BANDS = {
  level: "",
  low: "lowpass=f=150,lowpass=f=150,",
  mid: "highpass=f=150,lowpass=f=2500,",
  high: "highpass=f=2500,highpass=f=2500,",
} as const;

function decode(media: string, filters: string, trimSec: number): Float32Array {
  const trim = trimSec > 0 ? `atrim=start=${trimSec},asetpts=PTS-STARTPTS,` : "";
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      media,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-af",
      `${trim}aresample=${RATE},${filters}anull`,
      "-f",
      "f32le",
      "-",
    ],
    { maxBuffer: 1024 * 1024 * 1024, timeout: 600000, killSignal: "SIGKILL" },
  );
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg could not read an audio stream from ${media}: ${result.error?.message ?? result.stderr.toString().trim().slice(-300)}`,
    });
  const bytes = result.stdout;
  return new Float32Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 4));
}

/** Root-mean-square of each film frame's own span of samples. */
export function frameRms(
  samples: Float32Array,
  rate: number,
  fps: number,
  offsetSec: number,
  frameCount: number,
): number[] {
  return Array.from({ length: frameCount }, (_, frame) => {
    const from = Math.max(0, Math.round((offsetSec + frame / fps) * rate));
    const to = Math.min(samples.length, Math.round((offsetSec + (frame + 1) / fps) * rate));
    if (to <= from) return 0;
    let sum = 0;
    for (let index = from; index < to; index++) sum += samples[index]! * samples[index]!;
    return Math.sqrt(sum / (to - from));
  });
}

export function measureLevels(
  media: string,
  options: { fps: number; offsetSec: number; frameCount: number; trimSec?: number },
): MeasuredLevels {
  requireFile(media);
  const measure = (filters: string) =>
    frameRms(decode(media, filters, options.trimSec ?? 0), RATE, options.fps, options.offsetSec, options.frameCount);
  return { level: measure(BANDS.level), low: measure(BANDS.low), mid: measure(BANDS.mid), high: measure(BANDS.high) };
}

/** Levels of the cached Demucs stems the map was made from; missing files are skipped. */
export function measureStems(
  dir: string,
  options: { fps: number; offsetSec: number; frameCount: number },
): Partial<Record<"drums" | "bass" | "other" | "vocals", number[]>> {
  const out: Partial<Record<"drums" | "bass" | "other" | "vocals", number[]>> = {};
  for (const name of ["drums", "bass", "other", "vocals"] as const) {
    const file = path.join(dir, `${name}.wav`);
    if (existsSync(file))
      out[name] = frameRms(decode(file, "", 0), RATE, options.fps, options.offsetSec, options.frameCount);
  }
  return out;
}
