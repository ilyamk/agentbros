import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { CliErrorObject } from "../cli";
import type { Occurrence } from "./findings";

export const FADE_LOOKBACK_FRAMES = 15;
const FADE_RATIO = 0.6;
const FADE_MIN_DROP = 15;
const SINGLE_COLOUR_TOLERANCE = 2;
const NEAR_BLACK = 8;

export type FramePixels = { frame: number; hash: string; meanLuma: number; singleColour?: string; nearBlack: boolean };

export function decodePng(png: Buffer, width: number, height: number): Buffer {
  const size = width * height * 3;
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-f",
      "png_pipe",
      "-i",
      "pipe:0",
      "-frames:v",
      "1",
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "pipe:1",
    ],
    { input: png, maxBuffer: size + 1024 },
  );
  if (result.error || result.status !== 0 || result.stdout.length !== size)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not decode a frame capture: ${result.error?.message ?? (result.signal ? `ffmpeg was killed by ${result.signal}; was this run stopped from outside? ` : "")}${result.stderr?.toString().slice(-300) || (result.signal ? "" : `exit ${result.status}, got ${result.stdout.length} bytes, expected ${size}; a run stopped from outside looks like this`)}`,
    });
  return result.stdout;
}

export function measurePixels(frame: number, raw: Buffer): FramePixels {
  const [red, green, blue] = [raw[0]!, raw[1]!, raw[2]!];
  let luma = 0;
  let single = true;
  let black = true;
  for (let offset = 0; offset < raw.length; offset += 3) {
    const r = raw[offset]!;
    const g = raw[offset + 1]!;
    const b = raw[offset + 2]!;
    luma += 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (
      single &&
      (Math.abs(r - red) > SINGLE_COLOUR_TOLERANCE ||
        Math.abs(g - green) > SINGLE_COLOUR_TOLERANCE ||
        Math.abs(b - blue) > SINGLE_COLOUR_TOLERANCE)
    )
      single = false;
    if (black && (r > NEAR_BLACK || g > NEAR_BLACK || b > NEAR_BLACK)) black = false;
  }
  const hex = (value: number) => value.toString(16).padStart(2, "0");
  return {
    frame,
    hash: createHash("sha256").update(raw).digest("hex"),
    meanLuma: luma / (raw.length / 3),
    nearBlack: black,
    ...(single ? { singleColour: `#${hex(red)}${hex(green)}${hex(blue)}` } : {}),
  };
}

/** Chromium can raster a text edge a step or two differently on a fresh page. Nothing a viewer could see, and not a logic fault. */
const IMPERCEPTIBLE_CHANNEL_CHANGE = 4;

export function differsVisibly(a: Buffer, b: Buffer): boolean {
  for (let offset = 0; offset < a.length; offset++)
    if (Math.abs(a[offset]! - b[offset]!) > IMPERCEPTIBLE_CHANNEL_CHANGE) return true;
  return false;
}

/** Where two same-sized frames differ. */
export function comparePixels(a: Buffer, b: Buffer, width: number): string {
  let changed = 0;
  let left = Infinity;
  let top = Infinity;
  let right = -1;
  let bottom = -1;
  let largest = 0;
  for (let offset = 0; offset < a.length; offset += 3) {
    if (a[offset] === b[offset] && a[offset + 1] === b[offset + 1] && a[offset + 2] === b[offset + 2]) continue;
    largest = Math.max(
      largest,
      Math.abs(a[offset]! - b[offset]!),
      Math.abs(a[offset + 1]! - b[offset + 1]!),
      Math.abs(a[offset + 2]! - b[offset + 2]!),
    );
    const pixel = offset / 3;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    changed++;
    left = Math.min(left, x);
    right = Math.max(right, x);
    top = Math.min(top, y);
    bottom = Math.max(bottom, y);
  }
  if (!changed) return "no pixels differ";
  const share = (changed / (a.length / 3)) * 100;
  return `${share < 0.1 ? "<0.1" : share.toFixed(1)}% of pixels differ, within x=${left} y=${top} w=${right - left + 1} h=${bottom - top + 1}, largest channel change ${largest}`;
}

/** A flat colour shorter than this is a beat inside a transition, not a missing layer. */
const DEAD_RUN_MIN_FRAMES = 6;

/** Black mid-film is a flash or an unmounted layer. A flat colour counts on the poster and last frames, and elsewhere only as a run a viewer would notice. */
export function checkDeadFrames(frames: FramePixels[], lastFrame = frames.at(-1)?.frame): Occurrence[] {
  const isDead = (item: FramePixels) => Boolean(item.singleColour || item.nearBlack);
  const sorted = [...frames].sort((a, b) => a.frame - b.frame);
  const noticeable = new Set<number>();
  for (let start = 0; start < sorted.length; start++) {
    if (!isDead(sorted[start]!)) continue;
    let end = start;
    while (end + 1 < sorted.length && isDead(sorted[end + 1]!)) end++;
    if (sorted[end]!.frame - sorted[start]!.frame + 1 >= DEAD_RUN_MIN_FRAMES)
      for (let index = start; index <= end; index++) noticeable.add(sorted[index]!.frame);
    start = end;
  }
  return sorted
    .filter(
      (item) =>
        isDead(item) && (item.nearBlack || item.frame === 0 || item.frame === lastFrame || noticeable.has(item.frame)),
    )
    .map(({ frame, singleColour, nearBlack }) => ({
      code: "DEAD_FRAME" as const,
      frame,
      key: nearBlack ? "black" : (singleColour ?? "colour"),
      message: nearBlack ? `Frame ${frame} is entirely black.` : `Frame ${frame} is a single colour (${singleColour}).`,
      fix: `Nothing is on screen at this frame. Check that its layer mounts and has loaded; show content from frame 0 so the poster frame is not blank. If the empty frame is deliberate, add {"code":"DEAD_FRAME","frames":"${frame}-${frame}","reason":"..."} to --allow.`,
    }));
}

export function checkFadedFinal(last: FramePixels, before: FramePixels): Occurrence[] {
  if (last.meanLuma >= before.meanLuma * FADE_RATIO || before.meanLuma - last.meanLuma < FADE_MIN_DROP) return [];
  return [
    {
      code: "FADED_FINAL",
      frame: last.frame,
      key: "final",
      message: `Final frame ${last.frame} has mean luma ${last.meanLuma.toFixed(1)}, against ${before.meanLuma.toFixed(1)} at frame ${before.frame}: the video fades out.`,
      fix: `Hold the last message at full strength through frame ${last.frame}, because players and feeds freeze on the last frame. If the fade is intended, add {"code":"FADED_FINAL","reason":"..."} to --allow.`,
    },
  ];
}
