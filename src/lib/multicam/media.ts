import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync } from "node:fs";
import { CliErrorObject } from "../cli";

export type Probe = {
  durationSec: number;
  audio: { startSec: number } | null;
  video: {
    startSec: number;
    fps: { num: number; den: number };
    width: number;
    height: number;
    frameCount: number | null;
  } | null;
};

function tool(name: "ffmpeg" | "ffprobe", args: string[]): string {
  const result = spawnSync(name, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: `${name} not found. Install it with: brew install ffmpeg`,
    });
  if (result.status !== 0)
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `${name} failed: ${result.stderr.trim().slice(-600)}` });
  return result.stdout;
}

const rate = (text: string | undefined) => {
  const [num, den] = (text ?? "0/1").split("/").map(Number);
  return num! > 0 && den! > 0 ? { num: num!, den: den! } : null;
};

export function probe(file: string): Probe {
  const raw = JSON.parse(tool("ffprobe", ["-v", "error", "-show_format", "-show_streams", "-of", "json", file])) as {
    format?: { duration?: string };
    streams?: {
      codec_type?: string;
      start_time?: string;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      width?: number;
      height?: number;
      nb_frames?: string;
      disposition?: { attached_pic?: number };
    }[];
  };
  const streams = raw.streams ?? [];
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const video = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const fps = video ? (rate(video.avg_frame_rate) ?? rate(video.r_frame_rate)) : null;
  return {
    durationSec: Number(raw.format?.duration ?? 0),
    audio: audio ? { startSec: Number(audio.start_time ?? 0) } : null,
    video:
      video && fps && video.width && video.height
        ? {
            startSec: Number(video.start_time ?? 0),
            fps,
            width: video.width,
            height: video.height,
            frameCount: video.nb_frames ? Number(video.nb_frames) : null,
          }
        : null,
  };
}

/** First audio stream as 16-bit mono PCM at 48 kHz, starting at the audio stream's first sample. */
export function extractWav(file: string, output: string): void {
  tool("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-vn",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    output,
  ]);
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(1 << 20);
  const fd = openSync(file, "r");
  try {
    for (let read = readSync(fd, buffer); read > 0; read = readSync(fd, buffer)) hash.update(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}
