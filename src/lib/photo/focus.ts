import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { isHeif, majorBrand, readHead } from "../assets/heic";
import {
  fromCanvas,
  orientation,
  suggestMove,
  type PhotoEasing,
  type PhotoFormat,
  type Rect,
  type Suggestion,
} from "./crop";

export const CANVAS = 1280;
const IMAGE = /\.(jpe?g|png|webp|heic|heif)$/i;

export type ScoredBox = Rect & { score: number };
export type PhotoInput = { file: string; width: number; height: number; faces: ScoredBox[]; people: ScoredBox[] };
export type PhotoFocus = {
  file: string;
  /** staticFile name when the photo lives under public/, ready for the photo-move block's `src`. */
  src?: string;
  width: number;
  height: number;
  orientation: "portrait" | "landscape" | "square";
  faces: ScoredBox[];
  people: ScoredBox[];
  subject: "faces" | "people" | "none";
  formats: Partial<Record<PhotoFormat, Suggestion>>;
};

/** Photos named by a directory (sorted, not recursive) or a comma-separated list; HEIC/HEIF are set aside with the fix. */
export function listPhotos(input: string): { photos: string[]; skipped: { file: string; reason: string }[] } {
  const named =
    existsSync(input) && statSync(input).isDirectory()
      ? readdirSync(input)
          .filter((name) => IMAGE.test(name) && !name.startsWith("."))
          .sort()
          .map((name) => path.join(input, name))
      : input
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean);
  const photos: string[] = [],
    skipped: { file: string; reason: string }[] = [];
  for (const file of named) {
    if (!existsSync(file) || !statSync(file).isFile())
      throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Photo missing: ${file}` });
    if (isHeif(file, majorBrand(readHead(file))))
      skipped.push({
        file,
        reason:
          "HEIC/HEIF: the renderer cannot show it; `pnpm asset:import` converts it to JPEG, then run photo:focus on the imported file",
      });
    else photos.push(file);
  }
  if (!photos.length && !skipped.length)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `No photos (jpg, png, webp) in ${input}` });
  return { photos, skipped };
}

/** staticFile name of a file under `<root>/public/`, else undefined. */
export function staticName(file: string, root: string): string | undefined {
  const relative = path.relative(path.join(root, "public"), path.resolve(file));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative.split(path.sep).join("/")
    : undefined;
}

const probeSize = (file: string) => {
  const out = execFileSync(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
    { encoding: "utf8" },
  ).trim();
  const [width, height] = out.split(",").map(Number);
  if (!width || !height) throw new CliErrorObject({ code: "VALIDATION", message: `Cannot read the size of ${file}` });
  return { width, height };
};

/**
 * Decodes one photo the way the browser shows it (EXIF orientation applied) into a CANVAS-square padded frame at the
 * top-left, for one batched detector pass. Returns the displayed size and the scaled size on the canvas.
 */
export function stagePhoto(
  file: string,
  canvasFile: string,
  proxyFile: string,
): { width: number; height: number; scaledW: number; scaledH: number } {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-filter_complex",
    `[0:v]scale=${CANVAS}:${CANVAS}:force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuvj420p,split[a][b];[b]pad=${CANVAS}:${CANVAS}:0:0:black[c]`,
    "-map",
    "[a]",
    "-frames:v",
    "1",
    "-update",
    "1",
    proxyFile,
    "-map",
    "[c]",
    "-frames:v",
    "1",
    "-update",
    "1",
    "-q:v",
    "2",
    canvasFile,
  ]);
  const raw = probeSize(file),
    proxy = probeSize(proxyFile);
  const turned =
    proxy.width !== proxy.height && raw.width !== raw.height && proxy.width > proxy.height !== raw.width > raw.height;
  return {
    width: turned ? raw.height : raw.width,
    height: turned ? raw.width : raw.height,
    scaledW: proxy.width,
    scaledH: proxy.height,
  };
}

const r4 = (b: ScoredBox): ScoredBox => ({
  x: Number(b.x.toFixed(4)),
  y: Number(b.y.toFixed(4)),
  w: Number(b.w.toFixed(4)),
  h: Number(b.h.toFixed(4)),
  score: b.score,
});
/** Maps a detector sample from the padded canvas back to the photo. */
export const unpad = (boxes: ScoredBox[], scaledW: number, scaledH: number): ScoredBox[] =>
  boxes
    .map((box) => r4({ ...fromCanvas(box, CANVAS, scaledW, scaledH), score: Number(box.score.toFixed(3)) }))
    .filter((box) => box.w > 0.002 && box.h > 0.002);

/** One entry per photo: its subject and a start and end crop per format; neighbours alternate push in and pull out. */
export function buildFocus(
  inputs: PhotoInput[],
  opts: {
    formats: PhotoFormat[];
    durationSec: number;
    easing: PhotoEasing;
    minSpeed: number;
    root: string;
    alternate: boolean;
  },
): PhotoFocus[] {
  return inputs.map((photo, index) => {
    const formats: PhotoFocus["formats"] = {};
    for (const format of opts.formats) {
      formats[format] = suggestMove({
        width: photo.width,
        height: photo.height,
        faces: photo.faces,
        people: photo.people,
        format,
        durationSec: opts.durationSec,
        easing: opts.easing,
        minSpeed: opts.minSpeed,
        direction: opts.alternate && index % 2 === 1 ? "out" : "in",
      });
    }
    const src = staticName(photo.file, opts.root);
    return {
      file: photo.file,
      ...(src ? { src } : {}),
      width: photo.width,
      height: photo.height,
      orientation: orientation(photo.width, photo.height),
      faces: photo.faces.map(r4),
      people: photo.faces.length ? [] : photo.people.map(r4),
      subject: photo.faces.length ? "faces" : photo.people.length ? "people" : "none",
      formats,
    };
  });
}
