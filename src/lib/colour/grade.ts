import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { BakeResultSchema, GradeSchema, TimelineSchema, type Grade, type Timeline } from "../../types/colour";
import { runColourWorker } from "./worker";

const TRIPLETS = ["offset", "lift", "gamma", "gain"] as const;

/** Read and validate a grade.json; errors name the file and the field. */
export function loadGrade(file: string): Grade {
  if (!existsSync(file)) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Grade not found: ${file}` });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${file} is not JSON: ${(error as Error).message}` });
  }
  const parsed = GradeSchema.safeParse(raw);
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
    });
  return parsed.data;
}

/** The worker's form: triplets expanded, LUT paths absolute (relative to the grade file) and checked. */
export function normaliseGrade(grade: Grade, gradeFile: string): Record<string, unknown> {
  const out: Record<string, unknown> = { ...grade };
  for (const key of TRIPLETS) {
    const value = grade[key];
    if (typeof value === "number") out[key] = [value, value, value];
  }
  if (grade.luts) {
    out.luts = grade.luts.map((lut) => {
      const resolved = path.resolve(path.dirname(gradeFile), lut.path);
      if (!existsSync(resolved))
        throw new CliErrorObject({
          code: "FILE_NOT_FOUND",
          message: `LUT named by ${gradeFile} not found: ${resolved}`,
        });
      return { ...lut, path: resolved };
    });
  }
  delete out.name;
  delete out.notes;
  delete out.matchedTo;
  delete out.version;
  return out;
}

/** Bake a grade into a .cube (Resolve-compatible, red fastest). */
export function bakeCube(grade: Grade, gradeFile: string, output: string, size: number) {
  return runColourWorker(
    "bake",
    {
      grade: normaliseGrade(grade, gradeFile),
      size,
      output: path.resolve(output),
      title: grade.name ?? path.basename(gradeFile, path.extname(gradeFile)),
      comments: [
        `Agent Bros. Pictures colour:grade from ${path.basename(gradeFile)}`,
        "Input and output: Rec.709 display code values (gamma 2.4), full 0..1 data range",
      ],
    },
    BakeResultSchema,
  );
}

export function loadTimeline(file: string): Timeline {
  const parsed = TimelineSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
  if (!parsed.success)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${file}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    });
  const sorted = [...parsed.data.segments].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i]!.end <= sorted[i]!.start)
      throw new CliErrorObject({ code: "VALIDATION", message: `${file}: segment ${i} ends before it starts` });
    if (i > 0 && sorted[i]!.start < sorted[i - 1]!.end - 1e-6)
      throw new CliErrorObject({ code: "VALIDATION", message: `${file}: segments overlap at ${sorted[i]!.start}s` });
  }
  return { ...parsed.data, segments: sorted };
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering with ffmpeg

interface VideoFacts {
  width: number;
  height: number;
  pixFmt: string;
  colorSpace?: string;
  colorRange?: string;
  duration: number;
  hasAudio: boolean;
}

export function probeVideo(file: string): VideoFacts {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height,pix_fmt,color_space,color_range:format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `ffprobe failed on ${file}: ${result.stderr.trim()}` });
  const data = JSON.parse(result.stdout) as {
    streams: {
      codec_type: string;
      width?: number;
      height?: number;
      pix_fmt?: string;
      color_space?: string;
      color_range?: string;
    }[];
    format?: { duration?: string };
  };
  const video = data.streams.find((s) => s.codec_type === "video");
  if (!video?.width || !video.height)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `${file} has no video stream` });
  return {
    width: video.width,
    height: video.height,
    pixFmt: video.pix_fmt ?? "",
    colorSpace: video.color_space,
    colorRange: video.color_range,
    duration: Number(data.format?.duration ?? 0) || 0,
    hasAudio: data.streams.some((s) => s.codec_type === "audio"),
  };
}

/** Decode matrix and range: the stream's tags, else the HD/SD convention the colour worker also uses. */
export function decodeTags(facts: VideoFacts, overrides: { matrix?: string; range?: string } = {}) {
  const assumed: string[] = [];
  const yuv = /^(yuv|nv|p01)/.test(facts.pixFmt);
  const jpeg = facts.pixFmt.startsWith("yuvj");
  const map: Record<string, string> = {
    bt709: "bt709",
    smpte170m: "bt601",
    bt470bg: "bt601",
    bt2020nc: "bt2020",
    bt2020c: "bt2020",
  };
  let matrix = overrides.matrix ?? map[facts.colorSpace ?? ""];
  if (!matrix) {
    matrix = jpeg ? "bt601" : facts.width >= 1280 || facts.height > 576 ? "bt709" : "bt601";
    if (yuv) assumed.push(`matrix ${matrix} (stream untagged)`);
  }
  let range =
    overrides.range ?? (facts.colorRange === "pc" ? "full" : facts.colorRange === "tv" ? "limited" : undefined);
  if (!range) {
    range = jpeg ? "full" : "limited";
    if (yuv) assumed.push(`range ${range} (stream untagged)`);
  }
  return { yuv, matrix, range, assumed };
}

const SWS_MATRIX: Record<string, string> = { bt709: "bt709", bt601: "bt601", bt2020: "bt2020" };

export interface RenderOptions {
  input: string;
  output: string;
  /** One cube for the whole clip, or cubes per time range (contiguous, sorted; null = no grade). */
  segments: { start: number; end: number; cube: string | null }[];
  codec: "h264" | "prores";
  crf: number;
  matrix?: string;
  range?: string;
  /** Spatial corrections over a single-segment grade: the window's cube applies on top of the base inside its mask. */
  windows?: RenderWindow[];
}

export interface RenderWindow {
  cube: string;
  /** A grey matte video (shape windows), or a `pnpm matte` alpha sequence. */
  mask:
    | { kind: "video"; path: string }
    | { kind: "frames"; pattern: string; startFrame: number; fps: number; feather: number };
  invert: boolean;
  strength: number;
}

/**
 * Grade a video or still: decode with the stated matrix and range to 16-bit RGB, apply each 3D LUT with
 * tetrahedral interpolation, encode back to Rec.709 limited range with explicit colour tags. Audio is copied.
 */
export function renderGraded(options: RenderOptions) {
  const facts = probeVideo(options.input);
  const tags = decodeTags(facts, { matrix: options.matrix, range: options.range });
  const still = /\.(png|tiff?)$/i.test(options.output);
  const work = mkdtempSync(path.join(tmpdir(), "colour-render-"));
  try {
    // Plain names keep ffmpeg's filter-graph escaping out of the way of user paths.
    const cubes = options.segments.map((segment, index) => {
      if (!segment.cube) return null;
      const target = path.join(work, `g${index}.cube`);
      copyFileSync(segment.cube, target);
      return target;
    });
    const toRgb = tags.yuv
      ? `scale=in_color_matrix=${SWS_MATRIX[tags.matrix] ?? "bt709"}:in_range=${tags.range === "full" ? "pc" : "tv"},format=rgb48le`
      : "format=rgb48le";
    const back = still
      ? "format=rgb48le"
      : `scale=out_color_matrix=bt709:out_range=tv,format=${options.codec === "prores" ? "yuv422p10le" : "yuv420p"}`;
    const lut = (cube: string | null) => (cube ? `lut3d=file=${cube}:interp=tetrahedral` : "null");
    const args = ["-v", "error", "-nostdin", "-y", "-i", options.input];
    const windows = options.windows ?? [];
    if (windows.length && cubes.length !== 1)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Windows apply to one grade, not to a per-shot timeline",
      });
    if (windows.length) {
      const size = `${facts.width}:${facts.height}`;
      const parts = [
        `[0:v]${toRgb},${lut(cubes[0]!)},format=gbrp16le,split=${windows.length + 1}[b0]${windows.map((_, i) => `[c${i}]`).join("")}`,
      ];
      windows.forEach((window, i) => {
        const cube = path.join(work, `w${i}.cube`);
        copyFileSync(window.cube, cube);
        if (window.mask.kind === "video") args.push("-i", window.mask.path);
        else
          args.push(
            "-framerate",
            String(window.mask.fps),
            "-start_number",
            String(window.mask.startFrame),
            "-i",
            window.mask.pattern,
          );
        const pad =
          window.mask.kind === "frames" && window.mask.startFrame > 0
            ? `,tpad=start=${window.mask.startFrame}:start_mode=add:color=black`
            : "";
        const feather =
          window.mask.kind === "frames" && window.mask.feather > 0 ? `,gblur=sigma=${window.mask.feather}` : "";
        const invert = window.invert ? ",negate" : "";
        const strength =
          window.strength < 1
            ? `,colorchannelmixer=rr=${window.strength}:gg=${window.strength}:bb=${window.strength}`
            : "";
        parts.push(`[c${i}]${lut(cube)},format=gbrp16le[w${i}]`);
        parts.push(
          `[${i + 1}:v]format=gray${pad},scale=${size}:flags=bilinear${feather}${invert},format=gbrp16le${strength}[m${i}]`,
        );
        parts.push(`[b${i}][w${i}][m${i}]maskedmerge[b${i + 1}]`);
      });
      parts.push(`[b${windows.length}]${back}[v]`);
      args.push("-filter_complex", parts.join(";"));
    } else if (cubes.length === 1) {
      args.push("-filter_complex", `[0:v]${toRgb},${lut(cubes[0]!)},${back}[v]`);
    } else {
      const labels = cubes.map((_, i) => `[s${i}]`).join("");
      const parts = [`[0:v]${toRgb},split=${cubes.length}${labels}`];
      options.segments.forEach((segment, i) => {
        parts.push(
          `[s${i}]trim=start=${segment.start}:end=${segment.end},setpts=PTS-STARTPTS,${lut(cubes[i]!)}[g${i}]`,
        );
      });
      parts.push(`${cubes.map((_, i) => `[g${i}]`).join("")}concat=n=${cubes.length}:v=1:a=0,${back}[v]`);
      args.push("-filter_complex", parts.join(";"));
    }
    args.push("-map", "[v]");
    if (still) args.push("-frames:v", "1", "-update", "1");
    else {
      if (facts.hasAudio) args.push("-map", "0:a?", "-c:a", "copy");
      if (options.codec === "prores") args.push("-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0");
      else args.push("-c:v", "libx264", "-preset", "medium", "-crf", String(options.crf), "-threads", "4");
      args.push("-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv");
      args.push("-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1");
      if (/\.mp4$/i.test(options.output)) args.push("-movflags", "+faststart");
    }
    mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true });
    args.push(options.output);
    const result = spawnSync("ffmpeg", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0)
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `ffmpeg grade failed: ${result.stderr.trim().slice(-800)}`,
      });
    return {
      decode: { matrix: tags.matrix, range: tags.range, assumptions: tags.assumed },
      durationSec: facts.duration,
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Contiguous segments covering [0, duration], gaps filled with the base cube (or no grade). */
export function fillSegments(
  segments: { start: number; end: number; cube: string | null }[],
  duration: number,
  base: string | null,
): { start: number; end: number; cube: string | null }[] {
  const out: { start: number; end: number; cube: string | null }[] = [];
  let cursor = 0;
  for (const segment of segments) {
    const start = Math.max(segment.start, 0);
    const end = duration > 0 ? Math.min(segment.end, duration) : segment.end;
    if (start > cursor + 1e-3) out.push({ start: cursor, end: start, cube: base });
    if (end > start) out.push({ start, end, cube: segment.cube });
    cursor = Math.max(cursor, end);
  }
  if (duration > cursor + 1e-3) out.push({ start: cursor, end: duration, cube: base });
  return out;
}
