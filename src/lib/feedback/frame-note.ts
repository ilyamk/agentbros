/**
 * Frame notes (`pnpm frame:note`, 2026-11-20): the user's words on one frame of any video of a project, with the points
 * and boxes they put on it, kept as `pipeline/frame-notes/<id>.json` beside `<id>.png`, the frame with the marks drawn.
 * Any route: a film's frame feedback reopens its build (`feedback --frame`), a note only tells the agent.
 *
 * The frame comes from the video file itself (ffmpeg, the frame the console showed), never from the browser. The marks come as the user saw them: a transparent PNG overlay the console drew at the video's size, laid
 * over the frame. Without an overlay the boxes and points are drawn as rectangles (no text: this ffmpeg may lack
 * `drawtext`); the words stay in the JSON either way.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  FRAME_NOTES_DIR,
  FrameMarkSchema,
  FrameNoteSchema,
  MAX_FRAME_MARKS,
  type FrameMark,
  type FrameNote,
} from "../../types/console";
import { CliErrorObject, assertPathWithin } from "../cli";
import { hashFile } from "../console/view/files";
import { ulid } from "../console/ulid";

/** Largest overlay file accepted (bytes) and its largest side (pixels). */
export const OVERLAY_MAX_BYTES = 4 * 1024 * 1024;
export const OVERLAY_MAX_SIDE = 8192;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const invalid = (message: string) => new CliErrorObject({ code: "INVALID_INPUT", message });

/** Width and height of a PNG, or a refusal when the bytes are not one. */
export function pngSize(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR")
    throw invalid("The overlay is not a PNG image.");
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height || width > OVERLAY_MAX_SIDE || height > OVERLAY_MAX_SIDE)
    throw invalid(`The overlay is ${width}×${height}; each side is 1 to ${OVERLAY_MAX_SIDE} pixels.`);
  return { width, height };
}

/** The marks of a `--marks-file`: a JSON array of {x, y, w?, h?, text}, at most nine. */
export function parseMarks(text: string): FrameMark[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw invalid("--marks-file is not JSON: an array of {x, y, w?, h?, text}.");
  }
  if (!Array.isArray(raw)) throw invalid("--marks-file is an array of {x, y, w?, h?, text}.");
  if (raw.length > MAX_FRAME_MARKS) throw invalid(`At most ${MAX_FRAME_MARKS} marks on one frame (got ${raw.length}).`);
  return raw.map((mark, index) => {
    const parsed = FrameMarkSchema.safeParse(mark);
    if (!parsed.success)
      throw invalid(
        `Mark ${index + 1} is not a point or a box inside the frame with words: ${parsed.error.issues[0]?.message}.`,
      );
    return parsed.data;
  });
}

const pad = (value: number, width = 2) => String(value).padStart(width, "0");

/** `mm:ss.mmm` (or `h:mm:ss.mmm`) of `seconds`. */
export function clockMs(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor(ms / 60_000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const rest = `${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
  return h > 0 ? `${h}:${rest}` : rest;
}

/** ffmpeg filters that draw the marks as rectangles, for a note without an overlay. */
export function boxFilters(marks: readonly FrameMark[]): string[] {
  return marks.map((mark) => {
    const size = 0.02;
    const [x, y, w, h] =
      mark.w !== undefined && mark.h !== undefined
        ? [mark.x, mark.y, mark.w, mark.h]
        : [Math.max(0, mark.x - size / 2), Math.max(0, mark.y - size / 2), size, size];
    return `drawbox=x=iw*${x}:y=ih*${y}:w=iw*${w}:h=ih*${h}:color=0xff3b30@1:t=4`;
  });
}

export interface FrameNoteInput {
  rootDir: string;
  project: string;
  /** The video, relative to the project folder (`root: "project"`) or to `out/<id>/` (`root: "out"`). */
  media: string;
  root: "project" | "out";
  frame: number;
  /** Frames per second the frame number counts in; else the file's. */
  fps?: number;
  /** SHA-256 of the video the user watched: refused when the file changed since. */
  expect?: string;
  words: string;
  marks?: FrameMark[];
  region?: FrameNote["region"];
  /** A transparent PNG with the marks as the user saw them. */
  overlay?: string;
  channel?: FrameNote["channel"];
  now?: Date;
}

export interface FrameNoteResult {
  record: FrameNote;
  /** The note and its still, relative to the checkout. */
  note: string;
  still?: string;
}

type Probe = { width: number; height: number; fps: number; frames?: number };

function probe(file: string): Probe {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,avg_frame_rate,nb_frames:format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.error)
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffprobe not found. Install it with: brew install ffmpeg",
    });
  const json =
    result.status === 0
      ? (JSON.parse(result.stdout) as { streams?: Record<string, unknown>[]; format?: { duration?: string } })
      : {};
  const stream = json.streams?.[0];
  if (!stream) throw invalid(`No video stream in ${path.basename(file)}.`);
  const [numerator, denominator = 1] = String(stream.avg_frame_rate).split("/").map(Number);
  const fps = numerator && denominator ? numerator / denominator : 0;
  const duration = Number(json.format?.duration);
  const frames = Number(stream.nb_frames) || (fps && duration ? Math.round(duration * fps) : undefined);
  return { width: Number(stream.width), height: Number(stream.height), fps, ...(frames ? { frames } : {}) };
}

/** Validates the note, draws the still and writes both files (the PNG first, the JSON last). */
export function writeFrameNote(input: FrameNoteInput): FrameNoteResult {
  const projectDir = path.join(input.rootDir, "public", "projects", input.project);
  if (!existsSync(projectDir))
    throw new CliErrorObject({ code: "PROJECT_NOT_FOUND", message: `No project ${input.project}.` });
  const base = input.root === "out" ? path.join(input.rootDir, "out", input.project) : projectDir;
  const file = path.resolve(base, input.media);
  assertPathWithin(base, file);
  if (!existsSync(file) || !statSync(file).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `No video ${input.media} in the project.` });
  const sha256 = hashFile(file);
  if (input.expect && sha256 !== input.expect)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${input.media} changed since the user watched it (SHA-256 differs): reload the console and point again.`,
    });
  if (!Number.isInteger(input.frame) || input.frame < 0) throw invalid("--frame is a whole number from 0.");
  const marks = input.marks ?? [];
  if (marks.length > MAX_FRAME_MARKS) throw invalid(`At most ${MAX_FRAME_MARKS} marks on one frame.`);

  const video = probe(file);
  const fps = input.fps ?? video.fps;
  if (!(fps > 0)) throw invalid("The video's frame rate is unknown: pass --fps.");
  if (video.frames !== undefined && Math.round((input.frame * video.fps) / fps) >= video.frames)
    throw invalid(`Frame ${input.frame} is past the video's last frame (${video.frames} frames at ${video.fps} fps).`);
  const timeSec = input.frame / fps;

  let overlay: Buffer | undefined;
  if (input.overlay) {
    const stats = statSync(input.overlay);
    if (stats.size > OVERLAY_MAX_BYTES) throw invalid(`The overlay is over ${OVERLAY_MAX_BYTES} bytes.`);
    overlay = readFileSync(input.overlay);
    pngSize(overlay);
  }

  const id = `note-${ulid((input.now ?? new Date()).getTime()).toLowerCase()}`;
  const dir = path.join(projectDir, FRAME_NOTES_DIR);
  mkdirSync(dir, { recursive: true });
  const stillName = `${id}.png`;
  const temporary = path.join(dir, `.${stillName}.${process.pid}.tmp.png`);
  // ffmpeg returns the first frame at or after the seek: a quarter frame before the frame's start lands on it (the
  // middle, which the browser needs, would give the next one).
  const seek = (Math.max(0, input.frame - 0.25) / fps).toFixed(6);
  const drawn: FrameNote["drawn"] = overlay ? "overlay" : marks.length ? "boxes" : "none";
  const args = ["-v", "error", "-y", "-ss", seek, "-i", file];
  if (overlay && input.overlay) {
    args.push("-i", input.overlay);
    args.push(
      "-filter_complex",
      `[1:v]scale=${video.width}:${video.height}[marks];[0:v][marks]overlay=0:0:format=auto,format=rgb24[still]`,
      "-map",
      "[still]",
    );
  } else if (marks.length) args.push("-vf", boxFilters(marks).join(","));
  args.push("-frames:v", "1", "-update", "1", temporary);
  const ran = spawnSync("ffmpeg", args, { encoding: "utf8", timeout: 30_000 });
  if (ran.error && (ran.error as NodeJS.ErrnoException).code === "ENOENT")
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (ran.status !== 0 || !existsSync(temporary)) {
    rmSync(temporary, { force: true });
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `ffmpeg could not draw frame ${input.frame}: ${(ran.stderr || ran.error?.message || "").slice(0, 400)}`,
    });
  }
  renameSync(temporary, path.join(dir, stillName));

  const record = FrameNoteSchema.parse({
    v: 1,
    id,
    project: input.project,
    media: { path: input.media, root: input.root, ...(sha256 ? { sha256 } : {}) },
    frame: input.frame,
    fps,
    timeSec: Math.round(timeSec * 1000) / 1000,
    time: clockMs(timeSec),
    words: input.words,
    ...(input.region ? { region: input.region } : {}),
    ...(marks.length ? { marks } : {}),
    still: `${FRAME_NOTES_DIR}/${stillName}`,
    drawn,
    channel: input.channel ?? "cli",
    createdAt: (input.now ?? new Date()).toISOString(),
  } satisfies FrameNote);
  const noteFile = path.join(dir, `${id}.json`);
  const partial = `${noteFile}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(partial, noteFile);
  const relative = (absolute: string) => path.relative(input.rootDir, absolute).split(path.sep).join("/");
  return { record, note: relative(noteFile), still: relative(path.join(dir, stillName)) };
}
