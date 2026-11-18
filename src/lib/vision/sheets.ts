import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import { GLYPH_ADVANCE, GLYPH_HEIGHT, normaliseLabel } from "./bitmap-font";
import { BACKGROUND, CUT_MARK, differenceMap, MUTED, RgbImage, SAMPLE_MARK } from "./image";
import { decodeFrame, decodeFrames, renderWaveform, type VideoInfo } from "./media";

/** Tiles per image, counting difference maps. Past this an agent's image viewer cannot show them legibly. */
export const MAX_TILES = 120;
const MAX_SHEET_SIDE = 8192;
const TARGET_SHEET_WIDTH = 1920;
const GAP = 4;
const GROUP_GAP = 20;
const HEADER_HEIGHT = 28;
const MAX_CAPTION_LINES = 3;
const EPSILON = 1e-6;
const MARK_LABEL_HEIGHT = 20;
const WAVEFORM_HEIGHT = 120;
const TIMELINE_HEIGHT = MARK_LABEL_HEIGHT + WAVEFORM_HEIGHT + 24;

type Span = { startSec: number; endSec: number };
export const ShotsFileSchema = z.object({
  shots: z
    .array(z.object({ id: z.string().optional(), startSec: z.number().nonnegative(), endSec: z.number().positive() }))
    .min(1),
});
export const MarksFileSchema = z.union([z.array(z.number().nonnegative()), ShotsFileSchema]);
export const CaptionsFileSchema = z.union([
  z.array(z.string()),
  z.array(z.object({ startSec: z.number().nonnegative(), endSec: z.number().positive(), text: z.string() })),
]);
export type CaptionSpan = Span & { text: string };

export const round = (value: number, digits = 3) => Number(value.toFixed(digits));

/** Roughly how wide a video appears on a phone held upright, whatever its orientation. */
export const PHONE_TILE_WIDTH = 390;
const VIEWER_LONG_SIDE = 2000;

export function resolveTileWidth(phone: boolean | undefined, width: number | undefined): number | undefined {
  if (phone && width !== undefined) throw invalid("--phone sets the tile width; do not combine it with --width.");
  return phone ? PHONE_TILE_WIDTH : width;
}

/** A viewer that shrinks the sheet would make the tiles smaller than a phone shows them. */
export function phoneReport(image: RgbImage): { phone: true; warnings: string[] } {
  const longSide = Math.max(image.width, image.height);
  return {
    phone: true,
    warnings:
      longSide > VIEWER_LONG_SIDE
        ? [
            `The sheet's long side is ${longSide} px, so an image viewer may shrink it below true phone size. Use fewer tiles.`,
          ]
        : [],
  };
}

export function formatTimecode(seconds: number): string {
  const hundredths = Math.floor(seconds * 100 + EPSILON);
  const minutes = Math.floor(hundredths / 6000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(minutes)}:${pad(Math.floor(hundredths / 100) % 60)}.${pad(hundredths % 100)}`;
}

const invalid = (message: string) => new CliErrorObject({ code: "INVALID_INPUT", message });

export function tileSize(info: VideoInfo, requestedWidth?: number): { width: number; height: number } {
  const fallback = Math.min(info.width, info.height > info.width ? 240 : 320);
  const width = Math.round(requestedWidth ?? fallback);
  if (width < 16 || width > 4096) throw invalid(`--width must be between 16 and 4096, got ${width}.`);
  return { width, height: Math.max(2, Math.round((width * info.height) / info.width)) };
}

function assertTileLimit(tiles: number, hint: string): void {
  if (tiles > MAX_TILES) throw invalid(`This would draw ${tiles} tiles; the limit is ${MAX_TILES}. ${hint}`);
}

function balancedColumns(count: number, width: number, groupSize = 1): number {
  const most = Math.max(groupSize, Math.floor(TARGET_SHEET_WIDTH / (width + GAP) / groupSize) * groupSize);
  const rows = Math.ceil(count / most);
  return Math.min(most, Math.ceil(count / rows / groupSize) * groupSize);
}

function wrapCaption(text: string, maxCharacters: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of normaliseLabel(text).trim().split(" ")) {
    const fitted = word.slice(0, maxCharacters);
    if (line && line.length + 1 + fitted.length > maxCharacters) {
      lines.push(line);
      line = fitted;
    } else line = line ? `${line} ${fitted}` : fitted;
  }
  if (line) lines.push(line);
  if (lines.length > MAX_CAPTION_LINES) {
    lines.length = MAX_CAPTION_LINES;
    lines[MAX_CAPTION_LINES - 1] = `${lines[MAX_CAPTION_LINES - 1]!.slice(0, maxCharacters - 3)}...`;
  }
  return lines;
}

export type Cell = { image: RgbImage; label: string; caption?: string; diff?: { image?: RgbImage; label: string } };

/** Lays tiles out left to right. `groupSize` adds a wider gap between groups of tiles in a row. */
export function composeGrid(cells: Cell[], options: { title: string; columns: number; groupSize?: number }): RgbImage {
  const { title, groupSize = 1 } = options;
  const columns = Math.max(1, Math.min(options.columns, cells.length));
  const { width: tileWidth, height: tileHeight } = cells[0]!.image;
  const scale = tileWidth >= 160 ? 2 : 1;
  const lineHeight = (GLYPH_HEIGHT + 2) * scale + 2;
  const perLine = Math.max(1, Math.floor(tileWidth / (GLYPH_ADVANCE * scale)));
  const wrapped = cells.map((cell) => (cell.caption ? wrapCaption(cell.caption, perLine) : []));
  const captionLines = Math.max(0, ...wrapped.map((lines) => lines.length));
  const hasDiff = cells.some((cell) => cell.diff);
  const cellHeight = tileHeight + lineHeight * (1 + captionLines) + (hasDiff ? tileHeight + lineHeight : 0);
  const rows = Math.ceil(cells.length / columns);
  const groupGaps = (column: number) => (groupSize > 1 ? Math.floor(column / groupSize) : 0);
  const gapsBefore = (column: number) => groupGaps(column) * GROUP_GAP + (column - groupGaps(column)) * GAP;
  const sheetWidth = GAP * 2 + columns * tileWidth + gapsBefore(columns - 1);
  const sheetHeight = HEADER_HEIGHT + rows * (cellHeight + GAP) + GAP;
  if (sheetWidth > MAX_SHEET_SIDE || sheetHeight > MAX_SHEET_SIDE)
    throw invalid(
      `The sheet would be ${sheetWidth}x${sheetHeight} px; the limit is ${MAX_SHEET_SIDE} per side. Use a smaller --width, fewer tiles or more --columns.`,
    );
  const sheet = RgbImage.filled(sheetWidth, sheetHeight, BACKGROUND);
  sheet.drawText(title.slice(0, Math.floor((sheetWidth - GAP * 2) / (GLYPH_ADVANCE * 2))), GAP, 7, 2, MUTED);
  cells.forEach((cell, index) => {
    const column = index % columns;
    const x = GAP + column * tileWidth + gapsBefore(column);
    let y = HEADER_HEIGHT + Math.floor(index / columns) * (cellHeight + GAP);
    sheet.blit(cell.image, x, y);
    y += tileHeight + 2;
    sheet.drawText(cell.label.slice(0, perLine), x, y, scale);
    y += lineHeight;
    for (const line of wrapped[index]!) {
      sheet.drawText(line, x, y, scale, MUTED);
      y += lineHeight;
    }
    y += (captionLines - wrapped[index]!.length) * lineHeight;
    if (cell.diff) {
      if (cell.diff.image) sheet.blit(cell.diff.image, x, y);
      else sheet.fillRect(x, y, tileWidth, tileHeight, [0, 0, 0]);
      sheet.drawText(cell.diff.label.slice(0, perLine), x, y + tileHeight + 2, scale, MUTED);
    }
  });
  return sheet;
}

const describe = (input: string, info: VideoInfo) =>
  `${path.basename(input)} ${info.width}x${info.height} ${round(info.fps, 2)}FPS`;

export type StripWindow = { startFrame?: number; endFrame?: number; startSec?: number; endSec?: number };

/** Resolves a window to an inclusive frame range. Seconds are [start, end); frames are inclusive at both ends. */
export function resolveWindow(info: VideoInfo, window: StripWindow): { first: number; last: number } {
  const usesFrames = window.startFrame !== undefined || window.endFrame !== undefined;
  const usesSeconds = window.startSec !== undefined || window.endSec !== undefined;
  if (usesFrames && usesSeconds) throw invalid("Choose --start-sec/--end-sec or --start-frame/--end-frame, not both.");
  const first = usesFrames ? (window.startFrame ?? 0) : Math.floor((window.startSec ?? 0) * info.fps + EPSILON);
  const requestedLast = usesFrames
    ? (window.endFrame ?? info.frameCount - 1)
    : window.endSec === undefined
      ? info.frameCount - 1
      : Math.ceil(window.endSec * info.fps - EPSILON) - 1;
  const last = Math.min(requestedLast, info.frameCount - 1);
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > last)
    throw invalid(`The window selects no frames: first ${first}, last ${last}, video has ${info.frameCount}.`);
  return { first, last };
}

export function buildStrip(
  input: string,
  info: VideoInfo,
  options: StripWindow & { step?: number; columns?: number; width?: number; diff?: boolean },
) {
  const step = options.step ?? 1;
  if (!Number.isInteger(step) || step < 1) throw invalid("--step must be a positive integer.");
  const { first, last } = resolveWindow(info, options);
  const count = Math.floor((last - first) / step) + 1;
  const tiles = options.diff ? count * 2 - 1 : count;
  assertTileLimit(
    tiles,
    `Increase --step to at least ${Math.ceil((last - first + 1) / (options.diff ? (MAX_TILES + 1) / 2 : MAX_TILES))} or narrow the window.`,
  );
  const { width, height } = tileSize(info, options.width);
  const images = decodeFrames(input, info, { startFrame: first, count, step, width, height });
  if (!images.length)
    throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `No frames decoded from frame ${first} of ${input}` });
  const frames = images.map((_, index) => {
    const frame = first + index * step;
    return { frame, timeSec: round(frame / info.fps), diffMean: undefined as number | undefined };
  });
  const cells: Cell[] = images.map((image, index) => {
    const entry = frames[index]!;
    const cell: Cell = { image, label: `F${entry.frame} ${formatTimecode(entry.timeSec)}` };
    if (options.diff) {
      if (index === 0) cell.diff = { label: "DIFF: NONE" };
      else {
        const map = differenceMap(image, images[index - 1]!);
        entry.diffMean = round(map.mean, 2);
        cell.diff = { image: map.image, label: `DIFF ${entry.diffMean}` };
      }
    }
    return cell;
  });
  const title = `${describe(input, info)} STEP ${step}${options.diff ? ", X4 DIFF AGAINST PREVIOUS TILE" : ""}`;
  return {
    image: composeGrid(cells, { title, columns: options.columns ?? balancedColumns(cells.length, width) }),
    frames,
    step,
  };
}

function shotFrames(shot: Span, info: VideoInfo, index: number): [number, number, number] {
  // A shot shorter than a frame, or a last shot past the decoded frame count (a cropped copy can be a frame short), keeps its nearest frame.
  // A shot that starts beyond that frame is outside the video.
  const requested = Math.max(0, Math.ceil(shot.startSec * info.fps - EPSILON));
  const first = Math.min(requested, info.frameCount - 1);
  const last = Math.max(first, Math.min(Math.ceil(shot.endSec * info.fps - EPSILON) - 1, info.frameCount - 1));
  if (shot.endSec <= shot.startSec || requested > info.frameCount || first < 0)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Shot ${index + 1} (${shot.startSec}-${shot.endSec}s) selects no frames in a ${round(info.durationSec)}s video.`,
    });
  return [first, Math.floor((first + last) / 2), last];
}

/** Contact sheet with the first, middle and last frame of each shot. */
export function buildShotSheet(
  input: string,
  info: VideoInfo,
  shots: Array<Span & { id?: string }>,
  options: { columns?: number; width?: number } = {},
) {
  assertTileLimit(shots.length * 3, "Pass fewer shots or split the file.");
  const { width, height } = tileSize(info, options.width);
  const cells: Cell[] = [];
  const report = shots.map((shot, index) => {
    const frames = shotFrames(shot, info, index).map((target, position) => {
      const decoded = decodeFrame(input, info, target, width, height);
      const timeSec = decoded.frame / info.fps;
      cells.push({ image: decoded.image, label: `${index + 1}${"FML"[position]} ${formatTimecode(timeSec)}` });
      return { position: ["first", "mid", "last"][position], frame: decoded.frame, timeSec: round(timeSec) };
    });
    return { index: index + 1, id: shot.id, startSec: shot.startSec, endSec: shot.endSec, frames };
  });
  const columns = options.columns
    ? Math.max(3, Math.floor(options.columns / 3) * 3)
    : balancedColumns(cells.length, width, 3);
  return {
    image: composeGrid(cells, {
      title: `${describe(input, info)} ${shots.length} SHOTS: FIRST/MID/LAST`,
      columns,
      groupSize: 3,
    }),
    shots: report,
  };
}

export function evenSampleFrames(info: VideoInfo, count: number): number[] {
  if (!Number.isInteger(count) || count < 1) throw invalid("--count must be a positive integer.");
  const frames = Array.from({ length: count }, (_, index) => Math.floor(((index + 0.5) * info.frameCount) / count));
  return [...new Set(frames)];
}

const captionFor = (
  captions: string[] | CaptionSpan[] | undefined,
  index: number,
  timeSec: number,
): string | undefined => {
  const entry = captions?.[0];
  if (!captions || entry === undefined) return undefined;
  if (typeof entry === "string") return (captions as string[])[index] || undefined;
  return (captions as CaptionSpan[]).find((span) => timeSec >= span.startSec && timeSec < span.endSec)?.text;
};

function drawTimeline(
  sheet: RgbImage,
  top: number,
  info: VideoInfo,
  marks: number[],
  samples: number[],
  waveform: RgbImage | undefined,
): void {
  const rulerHeight = 24;
  const waveTop = top + MARK_LABEL_HEIGHT;
  const xAt = (seconds: number) =>
    Math.min(sheet.width - 1, Math.round((seconds / info.durationSec) * (sheet.width - 1)));
  if (waveform) sheet.blit(waveform, 0, waveTop);
  else {
    sheet.fillRect(0, waveTop, sheet.width, WAVEFORM_HEIGHT, [0, 0, 0]);
    sheet.drawText("NO AUDIO STREAM", 8, waveTop + 8, 2, MUTED);
  }
  const rulerTop = waveTop + WAVEFORM_HEIGHT;
  const interval =
    [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600].find((candidate) => info.durationSec / candidate <= 12) ??
    7200;
  for (let seconds = 0; seconds <= info.durationSec; seconds += interval) {
    const x = xAt(seconds);
    sheet.fillRect(x, rulerTop, 1, 6, MUTED);
    if (x + 3 + 5 * GLYPH_ADVANCE * 2 <= sheet.width)
      sheet.drawText(formatTimecode(seconds).slice(0, 5), x + 3, rulerTop + 8, 2, MUTED);
  }
  for (const seconds of samples) sheet.fillRect(xAt(seconds) - 1, rulerTop, 3, 6, SAMPLE_MARK);
  let labelEnd = -1;
  for (const seconds of marks) {
    const x = xAt(seconds);
    sheet.fillRect(x, top, 2, MARK_LABEL_HEIGHT + WAVEFORM_HEIGHT + rulerHeight, CUT_MARK);
    const label = formatTimecode(seconds);
    const labelWidth = label.length * GLYPH_ADVANCE * 2;
    if (x + 4 > labelEnd && x + 4 + labelWidth < sheet.width) {
      sheet.drawText(label, x + 4, top + 3, 2, CUT_MARK);
      labelEnd = x + 4 + labelWidth;
    }
  }
}

/** Storyboard of one video: labelled frames above a waveform with cut marks. */
export function buildReviewSheet(
  input: string,
  info: VideoInfo,
  options: {
    times?: number[];
    count?: number;
    marks?: number[];
    captions?: string[] | CaptionSpan[];
    columns?: number;
    width?: number;
  } = {},
) {
  const targets = options.times
    ? options.times.map((seconds) => {
        if (seconds < 0 || seconds > info.durationSec)
          throw invalid(`--times value ${seconds} is outside the ${round(info.durationSec)}s video.`);
        return Math.min(Math.floor(seconds * info.fps + EPSILON), info.frameCount - 1);
      })
    : evenSampleFrames(info, options.count ?? 12);
  assertTileLimit(targets.length, "Lower --count or pass fewer --times.");
  const { width, height } = tileSize(info, options.width);
  const frames: Array<{ frame: number; timeSec: number; caption?: string }> = [];
  const cells = targets.map((target, index) => {
    const decoded = decodeFrame(input, info, target, width, height);
    const timeSec = decoded.frame / info.fps;
    const caption = captionFor(options.captions, index, timeSec);
    frames.push({ frame: decoded.frame, timeSec: round(timeSec), ...(caption ? { caption } : {}) });
    return {
      image: decoded.image,
      label: `${formatTimecode(timeSec)} F${decoded.frame}`,
      ...(caption ? { caption } : {}),
    };
  });
  const grid = composeGrid(cells, {
    title: describe(input, info),
    columns: options.columns ?? balancedColumns(cells.length, width),
  });
  const sheet = RgbImage.filled(grid.width, grid.height + TIMELINE_HEIGHT + GAP, BACKGROUND);
  sheet.blit(grid, 0, 0);
  const marks = [...new Set(options.marks ?? [])].sort((a, b) => a - b);
  const drawnMarks = marks.filter((seconds) => seconds > 0 && seconds <= info.durationSec);
  const waveform = info.hasAudio ? renderWaveform(input, info.durationSec, grid.width, WAVEFORM_HEIGHT) : undefined;
  drawTimeline(
    sheet,
    grid.height,
    info,
    drawnMarks,
    frames.map((frame) => frame.timeSec),
    waveform,
  );
  return {
    image: sheet,
    frames,
    marks: drawnMarks,
    ignoredMarks: marks.filter((seconds) => !drawnMarks.includes(seconds)),
    hasAudio: info.hasAudio,
    timelineTop: grid.height,
  };
}
