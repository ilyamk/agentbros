import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { RgbImage } from "./image";

export type VideoInfo = {
  width: number;
  height: number;
  fps: number;
  frameCount: number;
  durationSec: number;
  hasAudio: boolean;
};

function run(binary: string, args: string[], options: { input?: Buffer; maxBuffer?: number } = {}): Buffer {
  const result = spawnSync(binary, args, { input: options.input, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr?.toString().trim().slice(-600);
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `${binary} failed: ${detail}` });
  }
  return result.stdout;
}

const ratio = (value: unknown): number => {
  const [numerator, denominator = 1] = String(value).split(/[/:]/).map(Number);
  return numerator! / denominator;
};

export function probeVideo(input: string, inputOptions: string[] = []): VideoInfo {
  if (!existsSync(input) || !statSync(input).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Video not found: ${input}` });
  const raw = JSON.parse(
    run("ffprobe", [
      "-v",
      "error",
      ...inputOptions,
      "-show_entries",
      "stream=codec_type,width,height,avg_frame_rate,nb_frames,duration,sample_aspect_ratio:stream_side_data=rotation:format=duration",
      "-of",
      "json",
      input,
    ]).toString(),
  );
  const streams: Array<Record<string, unknown>> = raw.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  if (!video) throw new CliErrorObject({ code: "INVALID_INPUT", message: `No video stream in ${input}` });
  const fps = ratio(video.avg_frame_rate);
  const durationSec = Number(video.duration ?? raw.format?.duration);
  if (!Number.isFinite(fps) || fps <= 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Cannot read the frame rate of ${input}` });
  const counted = Number(video.nb_frames);
  const frameCount = Number.isSafeInteger(counted) && counted > 0 ? counted : Math.round(durationSec * fps);
  if (!Number.isSafeInteger(frameCount) || frameCount < 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Cannot determine the frame count of ${input}` });
  const sampleAspect = ratio(video.sample_aspect_ratio);
  const storedWidth = Number(video.width) * (sampleAspect > 0 ? sampleAspect : 1);
  const rotation =
    (video.side_data_list as Array<{ rotation?: number }> | undefined)?.find((item) => item.rotation !== undefined)
      ?.rotation ?? 0;
  const sideways = Math.abs(rotation) % 180 === 90;
  return {
    width: Math.round(sideways ? Number(video.height) : storedWidth),
    height: Math.round(sideways ? storedWidth : Number(video.height)),
    fps,
    frameCount,
    durationSec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : frameCount / fps,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

/** Half a frame early, so the first decoded frame at or after this time is exactly `frame`. */
const seekSeconds = (frame: number, fps: number) => (frame <= 0 ? 0 : (frame - 0.5) / fps).toFixed(6);

/** Decodes `count` frames from `startFrame`, keeping every `step`th, in one ffmpeg call. May return fewer at end of file. */
export function decodeFrames(
  input: string,
  info: VideoInfo,
  options: { startFrame: number; count: number; step?: number; width: number; height: number },
): RgbImage[] {
  const { startFrame, count, step = 1, width, height } = options;
  const size = width * height * 3;
  const scale = `scale=${width}:${height}:flags=bilinear`;
  const filter = step > 1 ? `select='not(mod(n\\,${step}))',${scale}` : scale;
  const bytes = run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-ss",
      seekSeconds(startFrame, info.fps),
      "-i",
      input,
      "-an",
      "-sn",
      "-map",
      "0:v:0",
      "-vf",
      filter,
      "-fps_mode",
      "passthrough",
      "-frames:v",
      String(count),
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: size * count + 1024 },
  );
  const frames: RgbImage[] = [];
  for (let offset = 0; offset + size <= bytes.length; offset += size)
    frames.push(new RgbImage(width, height, bytes.subarray(offset, offset + size)));
  return frames;
}

/** One frame, stepping back slightly when a container overstates its frame count. */
export function decodeFrame(
  input: string,
  info: VideoInfo,
  frame: number,
  width: number,
  height: number,
): { image: RgbImage; frame: number } {
  for (let candidate = frame; candidate >= Math.max(0, frame - 3); candidate--) {
    const [image] = decodeFrames(input, info, { startFrame: candidate, count: 1, width, height });
    if (image) return { image, frame: candidate };
  }
  throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `Could not decode frame ${frame} of ${input}` });
}

/** Waveform of the first audio stream, aligned to the video's duration. */
export function renderWaveform(input: string, durationSec: number, width: number, height: number): RgbImage {
  const seconds = durationSec.toFixed(6);
  const bytes = run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-i",
      input,
      "-filter_complex",
      `[0:a:0]apad=whole_dur=${seconds},atrim=0:${seconds},showwavespic=s=${width}x${height}:colors=0x6EE7B7[wave]`,
      "-map",
      "[wave]",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { maxBuffer: width * height * 3 + 1024 },
  );
  if (bytes.length !== width * height * 3)
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: "Waveform output has an unexpected size." });
  return new RgbImage(width, height, bytes);
}

export function writeImage(image: RgbImage, output: string): string {
  const absolute = path.resolve(output);
  const extension = path.extname(absolute).toLowerCase();
  if (![".png", ".jpg", ".jpeg"].includes(extension))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `--output must end in .png or .jpg, got: ${output}` });
  mkdirSync(path.dirname(absolute), { recursive: true });
  run(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-s",
      `${image.width}x${image.height}`,
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-update",
      "1",
      ...(extension === ".png" ? [] : ["-q:v", "2"]),
      "-y",
      absolute,
    ],
    { input: image.data },
  );
  return absolute;
}
