import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { readAnalysisMedia } from "../reference/library";
import { BACKGROUND, RgbImage } from "./image";
import { decodeFrame, decodeFrames, probeVideo, type VideoInfo } from "./media";
import {
  composeGrid,
  formatTimecode,
  MAX_TILES,
  resolveWindow,
  round,
  tileSize,
  type Cell,
  type StripWindow,
} from "./sheets";

// Reference-over-ours strips, after ReelMimic's clip_strip.py --vs (MIT, © 2026 ReelMimic contributors).

const DARK_LUMA = 30;
const DARK_SHARE = 0.8;

/** A reference directory, or its media/source file, stands for the copy analysis reads: cropped when the record holds a crop. */
export function resolveVersusMedia(input: string): { media: string; note?: string } {
  const resolved = path.resolve(input);
  const directory =
    existsSync(resolved) && statSync(resolved).isDirectory()
      ? resolved
      : path.basename(path.dirname(resolved)) === "media" && path.basename(resolved).startsWith("source.")
        ? path.dirname(path.dirname(resolved))
        : undefined;
  if (directory && existsSync(path.join(directory, "source.json"))) {
    const { analysisMedia, source } = readAnalysisMedia(directory);
    return {
      media: analysisMedia,
      ...(source.crop
        ? {
            note: `Reference ${source.referenceId}: using the cropped picture (${source.crop.method}), as analysis does.`,
          }
        : {}),
    };
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `--vs: no video or reference directory at ${input}` });
  return { media: resolved };
}

export function parseSecondsRange(value: string, flag: string): { startSec: number; endSec: number } {
  const match = /^([\d.]+):([\d.]+)$/.exec(value.trim());
  const startSec = Number(match?.[1]);
  const endSec = Number(match?.[2]);
  if (!match || !Number.isFinite(startSec) || !Number.isFinite(endSec) || endSec <= startSec)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${flag} is "start:end" in seconds with end after start, got "${value}".`,
    });
  return { startSec, endSec };
}

function fitted(image: RgbImage, width: number, height: number): RgbImage {
  if (image.width === width && image.height === height) return image;
  const tile = RgbImage.filled(width, height, BACKGROUND);
  tile.blit(image, Math.floor((width - image.width) / 2), Math.floor((height - image.height) / 2));
  return tile;
}

const isDark = (image: RgbImage) => {
  for (let offset = 0; offset + 2 < image.data.length; offset += 3)
    if (0.299 * image.data[offset]! + 0.587 * image.data[offset + 1]! + 0.114 * image.data[offset + 2]! >= DARK_LUMA)
      return false;
  return true;
};

/**
 * Our window, and the reference's range sampled into the same number of frames, row over row: each reference row sits
 * directly above the matching row of ours, so the build, the hit and the hold line up.
 */
export function buildVersusStrip(
  input: string,
  info: VideoInfo,
  reference: string,
  options: StripWindow & {
    step?: number;
    columns?: number;
    width?: number;
    referenceRange?: { startSec: number; endSec: number };
  },
) {
  const step = options.step ?? 1;
  if (!Number.isInteger(step) || step < 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--step must be a positive integer." });
  const { first, last } = resolveWindow(info, options);
  const count = Math.floor((last - first) / step) + 1;
  if (count * 2 > MAX_TILES)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `${count * 2} tiles (both rows) is over ${MAX_TILES}. Increase --step to at least ${Math.ceil((last - first + 1) / (MAX_TILES / 2))} or narrow the window.`,
    });
  const referenceInfo = probeVideo(reference);
  const range = options.referenceRange ?? { startSec: first / info.fps, endSec: (last + 1) / info.fps };
  if (range.startSec >= referenceInfo.durationSec)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--vs-range starts at ${range.startSec} s, after the reference ends (${round(referenceInfo.durationSec)} s).`,
    });
  const { width, height } = tileSize(info, options.width);
  const ours = decodeFrames(input, info, { startFrame: first, count, step, width, height });
  if (!ours.length)
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `No frames decoded from frame ${first} of ${input}` });
  const scale = Math.min(width / referenceInfo.width, height / referenceInfo.height);
  const innerWidth = Math.max(2, Math.round(referenceInfo.width * scale));
  const innerHeight = Math.max(2, Math.round(referenceInfo.height * scale));
  const theirs = ours.map((_, index) => {
    const timeSec = range.startSec + (index * (range.endSec - range.startSec)) / ours.length;
    const decoded = decodeFrame(
      reference,
      referenceInfo,
      Math.min(referenceInfo.frameCount - 1, Math.floor(timeSec * referenceInfo.fps + 1e-6)),
      innerWidth,
      innerHeight,
    );
    return { image: fitted(decoded.image, width, height), timeSec: decoded.frame / referenceInfo.fps };
  });
  const darkShare = theirs.filter((frame) => isDark(frame.image)).length / theirs.length;
  if (darkShare >= DARK_SHARE)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `The reference rows are black (${Math.round(darkShare * 100)}% of frames). Wrong file or --vs-range? Pass the reference directory so the cropped picture is used.`,
    });
  const columns = Math.max(1, Math.min(options.columns ?? Math.max(1, Math.floor(1920 / (width + 4))), ours.length));
  const cells: Cell[] = [];
  const frames = ours.map((_, index) => ({
    frame: first + index * step,
    timeSec: round((first + index * step) / info.fps),
    referenceSec: round(theirs[index]!.timeSec),
  }));
  for (let start = 0; start < ours.length; start += columns) {
    const end = Math.min(ours.length, start + columns);
    const blank = () =>
      Array.from({ length: columns - (end - start) }, () => ({
        image: RgbImage.filled(width, height, BACKGROUND),
        label: "",
      }));
    cells.push(
      ...theirs
        .slice(start, end)
        .map((frame) => ({ image: frame.image, label: `REF ${formatTimecode(frame.timeSec)}` })),
      ...blank(),
    );
    cells.push(
      ...ours
        .slice(start, end)
        .map((image, offset) => ({ image, label: `OURS ${formatTimecode(frames[start + offset]!.timeSec)}` })),
      ...blank(),
    );
  }
  const title = `REF ${path.basename(reference)} ${formatTimecode(range.startSec)}-${formatTimecode(range.endSec)} OVER OURS ${path.basename(input)} ${formatTimecode(first / info.fps)}-${formatTimecode((last + 1) / info.fps)}`;
  return {
    image: composeGrid(cells, { title, columns }),
    frames,
    referenceRange: { startSec: round(range.startSec), endSec: round(range.endSec) },
    step,
  };
}
