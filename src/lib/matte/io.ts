import { spawn, spawnSync } from "node:child_process";
import { CliErrorObject } from "../cli";

/** ffmpeg and ffprobe plumbing for `pnpm matte`: frame extraction, raw grey streams, alpha merge and ProRes 4444. */

export const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|tiff?|bmp)$/i;
export const FRAME_PATTERN = "frame-%05d.png";
export const frameName = (frame: number) => `frame-${String(frame).padStart(5, "0")}.png`;

function ffmpeg(args: string[], label: string): string {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `${label} failed: ${(result.error?.message ?? result.stderr).slice(-800)}`,
    });
  return result.stdout;
}

export type MediaInfo = { width: number; height: number; fps?: number; frames?: number };

/** Width, height, frame rate and (when the container states it) frame count of the first video stream. */
export function probeMedia(file: string): MediaInfo {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,r_frame_rate,avg_frame_rate,nb_frames",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Cannot read ${file}: ${(result.error?.message ?? result.stderr).slice(-400)}`,
    });
  const stream = (
    JSON.parse(result.stdout) as {
      streams?: {
        width?: number;
        height?: number;
        r_frame_rate?: string;
        avg_frame_rate?: string;
        nb_frames?: string;
      }[];
    }
  ).streams?.[0];
  if (!stream?.width || !stream.height)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${file} has no video or image stream` });
  const rate = (value?: string) => {
    const [n, d] = (value ?? "").split("/").map(Number);
    return n && d ? n / d : undefined;
  };
  const frames = Number(stream.nb_frames);
  return {
    width: stream.width,
    height: stream.height,
    fps: rate(stream.avg_frame_rate) ?? rate(stream.r_frame_rate),
    ...(Number.isFinite(frames) && frames > 0 ? { frames } : {}),
  };
}

/** One still to an RGB PNG (any alpha dropped), so every engine and the merge read the same pixels. */
export function extractImage(input: string, output: string): void {
  ffmpeg(["-i", input, "-frames:v", "1", "-pix_fmt", "rgb24", output], "image decode");
}

/** Source frames [start, end) of a video as RGB PNGs named by their source frame number. Returns the numbers written. */
export function extractVideoFrames(input: string, directory: string, start: number, end: number): void {
  ffmpeg(
    [
      "-i",
      input,
      "-vf",
      `select='between(n\\,${start}\\,${end - 1})'`,
      "-fps_mode",
      "passthrough",
      "-pix_fmt",
      "rgb24",
      "-start_number",
      String(start),
      `${directory}/${FRAME_PATTERN}`,
    ],
    "frame extraction",
  );
}

/** RGBA cut-outs from colour frames and grey alpha frames, the rmbg contract: subject opaque, the rest transparent. */
export function mergeAlpha(colour: string, alpha: string, output: string, start?: number): void {
  const sequence = start !== undefined ? ["-start_number", String(start)] : [];
  ffmpeg(
    [
      ...sequence,
      "-i",
      colour,
      ...sequence,
      "-i",
      alpha,
      "-filter_complex",
      "[0:v]format=rgb24[c];[1:v]format=gray[a];[c][a]alphamerge,format=rgba",
      ...sequence,
      output,
    ],
    "alpha merge",
  );
}

/** ProRes 4444 with a 16-bit alpha plane from the RGBA cut-outs. A deliverable for editors, not for Remotion. */
export function writeProres(cutouts: string, start: number, fps: number, output: string): void {
  ffmpeg(
    [
      "-framerate",
      String(fps),
      "-start_number",
      String(start),
      "-i",
      cutouts,
      "-c:v",
      "prores_ks",
      "-profile:v",
      "4444",
      "-pix_fmt",
      "yuva444p10le",
      "-alpha_bits",
      "16",
      "-vendor",
      "apl0",
      output,
    ],
    "ProRes 4444 encode",
  );
}

export function pixelFormat(file: string): string {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  );
  return result.stdout.trim();
}

/** Streams an image sequence (printf pattern from `start`) as raw 8-bit grey frames, one Uint8Array per frame. */
export async function* greyFrames(
  pattern: string,
  start: number,
  width: number,
  height: number,
): AsyncGenerator<Uint8Array> {
  const size = width * height;
  const child = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-start_number",
      String(start),
      "-i",
      pattern,
      "-vf",
      `scale=${width}:${height}:flags=bilinear,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= size) {
      yield new Uint8Array(pending.subarray(0, size));
      pending = pending.subarray(size);
    }
  }
  const code = await closed;
  if (code !== 0)
    throw new CliErrorObject({ code: "INTERNAL", message: `grey decode of ${pattern} failed: ${stderr}` });
}

/** Writes raw grey frames to a PNG sequence numbered from `start`. */
export function greyWriter(pattern: string, start: number, width: number, height: number) {
  const child = spawn(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "-s",
      `${width}x${height}`,
      "-i",
      "-",
      "-start_number",
      String(start),
      pattern,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  const closed = new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    async write(frame: Uint8Array) {
      if (!child.stdin.write(frame)) await new Promise<void>((resolve) => child.stdin.once("drain", () => resolve()));
    },
    async close() {
      child.stdin.end();
      const code = await closed;
      if (code !== 0)
        throw new CliErrorObject({ code: "INTERNAL", message: `grey encode to ${pattern} failed: ${stderr}` });
    },
  };
}
