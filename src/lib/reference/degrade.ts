import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliErrorObject, emitProgress } from "../cli";
import { hashFileSync, writeJsonAtomic } from "../film/evidence";
import { probeVideo } from "../vision/media";
import { detectBoundaries } from "./shots";
import { readAnalysisMedia, readLayer, referenceDirectory } from "./library";
import { AudioMapSchema } from "../../types/film";
import {
  CalibrationManifestSchema,
  DEGRADE_KINDS,
  type CalibrationManifest,
  type DegradeKind,
  type VariantKind,
} from "../../types/calibration";

// ref:degrade: a reference's own segment and copies of it made worse on purpose, each with a known label, from ffmpeg
// alone. Every clip, the original included, is encoded from one decoded master with the same settings, so a sensor
// that tells them apart reads the degradation, not the codec. docs/reference-analysis.md, "Calibration".

export const DEFAULT_CALIBRATION_DIR = "out/qa/calibration";
/** Frames kept around the span so a shifted picture never runs out of source. */
const MARGIN_SEC = 0.5;
/** Long side of the master. Every sensor reads far smaller frames; the critic's strips too. */
const MAX_SIDE = 960;
const SEGMENT_MIN_SEC = 2;
const SEGMENT_MAX_SEC = 4;
/** uniform-cuts needs a cadence to destroy: 8-12 s, grown until it holds 5 shots (film:measure's variety floor). */
const LONG_MIN_SEC = 8;
const LONG_MAX_SEC = 12;
const LONG_WANTED_SHOTS = 5;
const MIN_UNIFORM_SHOTS = 3;
export const STUTTER_STEP = 3;
export const DESYNC_FRAMES = 4;
export const FLAT_GRADE = { saturation: 0.75, contrast: 0.85 } as const;
const SOFT_TRANSIENTS = "acompressor=threshold=0.03:ratio=8:attack=0.2:release=120:makeup=2,lowpass=f=3000";
/** A shot boundary from shots.json is moved to the sharpest picture change within this many frames. */
const SNAP_FRAMES = 2;
const ENERGY_SIZE = { width: 64, height: 36 };
const BITEXACT = ["-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1"];
const VIDEO_CODEC = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p"];
const AUDIO_CODEC = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
export const ENCODE = `libx264 crf 18 preset medium yuv420p, aac 192k 48 kHz stereo, bitexact, long side at most ${MAX_SIDE}`;

const round = (value: number, digits = 3) => Number(value.toFixed(digits));

function ffmpeg(args: string[], what: string, maxBuffer = 64 * 1024 * 1024): Buffer {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], {
    maxBuffer,
    timeout: 1800000,
    killSignal: "SIGKILL",
  });
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `${what}: ${result.error?.message ?? result.stderr?.toString().slice(-400)}`,
    });
  return result.stdout as Buffer;
}

/** ffmpeg's frame rate as a ratio when it is an NTSC rate, so frame k sits exactly at k / fps. */
export function rateString(fps: number): string {
  if (Math.abs(fps - Math.round(fps)) < 1e-3) return String(Math.round(fps));
  const ntsc = (fps * 1001) / 1000;
  if (Math.abs(ntsc - Math.round(ntsc)) < 1e-3) return `${Math.round(ntsc) * 1000}/1001`;
  return fps.toFixed(6);
}

// --- Frame maps: output frame k shows master frame map[k] ---

/** Every `step`th frame, held: smooth motion strobes. */
export function stutterMap(first: number, count: number, step = STUTTER_STEP): number[] {
  return Array.from({ length: count }, (_, k) => first + step * Math.floor(k / step));
}

/** The picture shifted against the sound: positive is picture late (it shows earlier frames), clamped to the master. */
export function desyncMap(first: number, count: number, offsetFrames: number, masterFrames: number): number[] {
  return Array.from({ length: count }, (_, k) => Math.min(masterFrames - 1, Math.max(0, first + k - offsetFrames)));
}

/**
 * Same number of shots, all one length: a long shot is cut short, a short one held on its last frame. `starts` are the
 * shots' first frames relative to the span, the first being 0.
 */
export function uniformCutMap(first: number, count: number, starts: number[]): { map: number[]; outStarts: number[] } {
  const edges = [...starts, count];
  const shots = starts.length;
  const map: number[] = [];
  const outStarts: number[] = [];
  for (let index = 0; index < shots; index++) {
    const from = Math.round((index * count) / shots);
    const to = Math.round(((index + 1) * count) / shots);
    outStarts.push(from);
    for (let k = from; k < to; k++) map.push(first + Math.min(edges[index]! + (k - from), edges[index + 1]! - 1));
  }
  return { map, outStarts };
}

/**
 * Inside each shot, frames are re-picked so the picture's cumulative change grows evenly with time: an ease in or out
 * becomes constant speed. `energy[k]` is the change from frame k-1 to k (energy[0] unused); `starts` as in uniformCutMap.
 * Frame selection only: no in-between frames are made, so fast stretches skip frames and slow ones hold.
 */
export function linearMotionMap(first: number, energy: number[], starts: number[]): number[] {
  const count = energy.length;
  const edges = [...starts, count];
  const map: number[] = [];
  for (let index = 0; index < starts.length; index++) {
    const a = edges[index]!;
    const b = edges[index + 1]!;
    const cumulative: number[] = [0];
    for (let k = a + 1; k < b; k++) cumulative.push(cumulative.at(-1)! + Math.max(0, energy[k] ?? 0));
    const total = cumulative.at(-1)!;
    const last = b - 1 - a;
    for (let k = a; k < b; k++) {
      if (last < 2 || total <= 1e-9) {
        map.push(first + k);
        continue;
      }
      const target = (total * (k - a)) / last;
      let f = cumulative.findIndex((value) => value >= target - 1e-12);
      if (f < 0) f = last;
      if (f > 0 && target - cumulative[f - 1]! < cumulative[f]! - target) f -= 1;
      map.push(first + a + f);
    }
  }
  return map;
}

/** Shot starts inside [first, first + count), relative to it, each moved to the biggest change within SNAP_FRAMES. */
export function shotStartsIn(cutFrames: number[], first: number, count: number, energy?: number[]): number[] {
  const starts = new Set<number>([0]);
  for (const frame of cutFrames) {
    let relative = frame - first;
    if (energy) {
      let best = relative;
      for (let k = relative - SNAP_FRAMES; k <= relative + SNAP_FRAMES; k++)
        if (k > 0 && k < count && (energy[k] ?? 0) > (energy[best] ?? -1)) best = k;
      relative = best;
    }
    if (relative > 0 && relative < count) starts.add(relative);
  }
  return [...starts].sort((a, b) => a - b);
}

/** p90 / p10 of shot lengths, as film:measure reads variety. */
const lengthsOf = (starts: number[], count: number) =>
  [...starts, count].slice(1).map((edge, index) => edge - starts[index]!);

// --- Segments ---

export type Span = { startSec: number; endSec: number };

/**
 * `count` windows of `lengthSec`, not overlapping, scored by the cuts inside them (a cut 0.25 s clear of each edge) plus
 * the mean motion energy relative to the film's busiest second. Windows with a cut come first. Deterministic.
 */
export function pickSegments(options: {
  durationSec: number;
  count: number;
  lengthSec: number;
  cutsSec: number[];
  energy?: { timeSec: number; energy: number }[];
}): Span[] {
  const { durationSec, count, lengthSec, cutsSec } = options;
  const energy = options.energy ?? [];
  const peak = Math.max(1e-9, ...energy.map((row) => row.energy));
  const candidates: { startSec: number; cuts: number; score: number }[] = [];
  for (let start = 0; start + lengthSec <= durationSec + 1e-9; start = round(start + 0.25)) {
    const end = start + lengthSec;
    const cuts = cutsSec.filter((time) => time > start + 0.25 && time < end - 0.25).length;
    const inside = energy.filter((row) => row.timeSec >= start && row.timeSec <= end);
    const motion = inside.length ? inside.reduce((sum, row) => sum + row.energy, 0) / inside.length / peak : 0;
    candidates.push({ startSec: start, cuts, score: cuts + motion });
  }
  candidates.sort((a, b) => Number(b.cuts > 0) - Number(a.cuts > 0) || b.score - a.score || a.startSec - b.startSec);
  const picked: Span[] = [];
  for (const candidate of candidates) {
    if (picked.length >= count) break;
    const span = { startSec: candidate.startSec, endSec: round(candidate.startSec + lengthSec) };
    if (picked.some((other) => span.startSec < other.endSec && other.startSec < span.endSec)) continue;
    picked.push(span);
  }
  return picked.sort((a, b) => a.startSec - b.startSec);
}

/** The span uniform-cuts re-cuts: centred on the segment, 8-12 s, grown until it holds LONG_WANTED_SHOTS shots. */
export function longSpan(segment: Span, durationSec: number, cutsSec: number[]): Span {
  const centre = (segment.startSec + segment.endSec) / 2;
  let chosen: Span | undefined;
  for (let length = LONG_MIN_SEC; length <= LONG_MAX_SEC; length++) {
    const span = Math.min(length, durationSec);
    const startSec = round(Math.min(Math.max(0, centre - span / 2), durationSec - span));
    chosen = { startSec, endSec: round(startSec + span) };
    if (
      cutsSec.filter((time) => time > chosen!.startSec && time < chosen!.endSec).length + 1 >= LONG_WANTED_SHOTS ||
      span >= durationSec
    )
      break;
  }
  return chosen!;
}

export const segmentId = (span: Span) =>
  `seg-${String(Math.round(span.startSec * 1000)).padStart(6, "0")}-${String(Math.round(span.endSec * 1000)).padStart(6, "0")}`;

// --- Master and clips ---

type Master = {
  dir: string;
  startSec: number;
  frames: number;
  fps: number;
  rate: string;
  width: number;
  height: number;
  wav?: string;
};

function extractMaster(
  media: string,
  audioMedia: string | undefined,
  span: Span,
  info: { width: number; height: number; fps: number },
  dir: string,
): Master {
  const scale = Math.min(1, MAX_SIDE / Math.max(info.width, info.height));
  const width = Math.max(2, Math.round((info.width * scale) / 2) * 2);
  const height = Math.max(2, Math.round((info.height * scale) / 2) * 2);
  const rate = rateString(info.fps);
  const duration = (span.endSec - span.startSec).toFixed(6);
  mkdirSync(path.join(dir, "master"), { recursive: true });
  ffmpeg(
    [
      "-ss",
      span.startSec.toFixed(6),
      "-i",
      media,
      "-t",
      duration,
      "-an",
      "-sn",
      "-map",
      "0:v:0",
      "-vf",
      `fps=${rate},scale=${width}:${height}:flags=bicubic,format=rgb24`,
      "-start_number",
      "0",
      "-compression_level",
      "1",
      path.join(dir, "master", "%06d.png"),
    ],
    "Could not decode the reference's frames",
  );
  const frames = readdirSync(path.join(dir, "master")).filter((name) => name.endsWith(".png")).length;
  if (!frames)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `No frames decoded from ${media} at ${span.startSec} s.`,
    });
  let wav: string | undefined;
  if (audioMedia) {
    wav = path.join(dir, "master.wav");
    ffmpeg(
      [
        "-ss",
        span.startSec.toFixed(6),
        "-i",
        audioMedia,
        "-t",
        duration,
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-ar",
        "48000",
        "-c:a",
        "pcm_s16le",
        wav,
      ],
      "Could not decode the reference's sound",
    );
  }
  return { dir, startSec: span.startSec, frames, fps: info.fps, rate, width, height, wav };
}

/** Luma change between consecutive master frames, tiny and grey: energy[k] is frame k-1 to k. */
function masterEnergy(master: Master, first: number, count: number): number[] {
  const { width, height } = ENERGY_SIZE;
  const bytes = ffmpeg(
    [
      "-start_number",
      String(first),
      "-framerate",
      master.rate,
      "-i",
      path.join(master.dir, "master", "%06d.png"),
      "-frames:v",
      String(count),
      "-vf",
      `scale=${width}:${height}:flags=area,format=gray`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "gray",
      "pipe:1",
    ],
    "Could not read motion energy",
    512 * 1024 * 1024,
  );
  const size = width * height;
  const frames = Math.floor(bytes.length / size);
  const energy = [0];
  for (let k = 1; k < frames; k++) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += Math.abs(bytes[k * size + i]! - bytes[(k - 1) * size + i]!);
    energy.push(sum / size);
  }
  while (energy.length < count) energy.push(0);
  return energy;
}

type AudioPlan = { inputs: { file: string; offsetSec: number }[]; filter?: string } | undefined;

function encodeClip(
  master: Master,
  map: number[],
  output: string,
  options: { audio: AudioPlan; videoFilter?: string },
): string {
  const sequence = mkdtempSync(path.join(master.dir, "seq-"));
  map.forEach((frame, index) => {
    const from = path.join(master.dir, "master", `${String(frame).padStart(6, "0")}.png`);
    const to = path.join(sequence, `${String(index).padStart(6, "0")}.png`);
    try {
      linkSync(from, to);
    } catch {
      copyFileSync(from, to);
    }
  });
  const durationSec = (map.length / master.fps).toFixed(6);
  const inputs = ["-framerate", master.rate, "-i", path.join(sequence, "%06d.png")];
  const audioArgs: string[] = [];
  const audio = options.audio;
  if (audio?.inputs.length) {
    for (const input of audio.inputs)
      inputs.push("-ss", Math.max(0, input.offsetSec).toFixed(6), "-t", durationSec, "-i", input.file);
    if (audio.inputs.length > 1) {
      const mix = `${audio.inputs.map((_, index) => `[${index + 1}:a]`).join("")}amix=inputs=${audio.inputs.length}:normalize=0${audio.filter ? `,${audio.filter}` : ""}[a]`;
      audioArgs.push("-filter_complex", mix, "-map", "0:v:0", "-map", "[a]");
    } else {
      audioArgs.push("-map", "0:v:0", "-map", "1:a:0", ...(audio.filter ? ["-af", audio.filter] : []));
    }
    audioArgs.push(...AUDIO_CODEC);
  } else audioArgs.push("-map", "0:v:0");
  mkdirSync(path.dirname(output), { recursive: true });
  ffmpeg(
    [
      ...inputs,
      ...audioArgs,
      "-vf",
      `${options.videoFilter ? `${options.videoFilter},` : ""}format=yuv420p`,
      ...VIDEO_CODEC,
      "-frames:v",
      String(map.length),
      "-t",
      durationSec,
      ...BITEXACT,
      output,
    ],
    `Could not encode ${path.basename(output)}`,
  );
  rmSync(sequence, { recursive: true, force: true });
  return output;
}

// --- The request ---

export type DegradeRequest = {
  libraryRoot: string;
  id: string;
  segments?: Span[];
  /** Pick this many segments automatically when `segments` is not given. */
  auto?: number;
  segmentSec?: number;
  kinds?: DegradeKind[];
  outDir?: string;
  audioMap?: string;
};

export type DegradeResult = { manifests: string[]; segments: { id: string; variants: number; skipped: number }[] };

export function parseKinds(value: string | undefined): DegradeKind[] {
  if (!value?.trim()) return [...DEGRADE_KINDS];
  const kinds = value
    .split(",")
    .map((kind) => kind.trim())
    .filter(Boolean);
  const unknown = kinds.filter((kind) => !(DEGRADE_KINDS as readonly string[]).includes(kind));
  if (unknown.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Unknown --kinds ${unknown.join(", ")}. Known: ${DEGRADE_KINDS.join(", ")}.`,
    });
  return [...new Set(kinds)] as DegradeKind[];
}

function gridOf(
  directory: string,
  audioMap: string | undefined,
): { beatsSec: number[]; downbeatsSec: number[] } | undefined {
  if (audioMap) {
    const map = AudioMapSchema.parse(JSON.parse(readFileSync(audioMap, "utf8")));
    return { beatsSec: map.beatsSec, downbeatsSec: map.downbeatsSec };
  }
  const tempo = readLayer(directory, "audio.json")?.tempo;
  return tempo?.beatsSec.length ? { beatsSec: tempo.beatsSec, downbeatsSec: tempo.downbeatsSec } : undefined;
}

function stemsOf(directory: string): { music: string[]; dropped: string[] } | undefined {
  const stems = readLayer(directory, "audio.json")?.stems;
  if (!stems?.available || !stems.paths["drums"]) return undefined;
  const music = Object.entries(stems.paths)
    .filter(([name]) => name !== "drums")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, file]) => path.resolve(directory, file))
    .filter((file) => existsSync(file));
  return music.length ? { music, dropped: ["drums"] } : undefined;
}

export function degradeReference(request: DegradeRequest): DegradeResult {
  const directory = referenceDirectory(request.libraryRoot, request.id);
  const { media: sourceMedia, analysisMedia } = readAnalysisMedia(directory);
  const info = probeVideo(analysisMedia);
  const sourceInfo = probeVideo(sourceMedia);
  const kinds = request.kinds?.length ? request.kinds : [...DEGRADE_KINDS];
  const outRoot = path.resolve(request.outDir ?? path.join(DEFAULT_CALIBRATION_DIR, request.id));
  const shotsLayer = readLayer(directory, "shots.json");
  const motionLayer = readLayer(directory, "motion.json");
  const cutsSec = shotsLayer ? shotsLayer.shots.map((shot) => shot.startSec).filter((time) => time > 0.001) : undefined;
  const lengthSec = Math.min(SEGMENT_MAX_SEC, Math.max(SEGMENT_MIN_SEC, request.segmentSec ?? 3));
  const segments = request.segments?.length
    ? request.segments
    : pickSegments({
        durationSec: info.durationSec,
        count: Math.max(1, request.auto ?? 1),
        lengthSec,
        cutsSec: cutsSec ?? [],
        energy: motionLayer?.energyCurve,
      });
  if (!segments.length)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `The reference is ${round(info.durationSec)} s, too short for a ${lengthSec} s segment.`,
    });
  for (const span of segments)
    if (!(span.endSec > span.startSec) || span.startSec < 0 || span.endSec > info.durationSec + 1e-3)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Segment ${span.startSec}-${span.endSec} s is not inside the reference (0-${round(info.durationSec)} s).`,
      });
  const grid = gridOf(directory, request.audioMap);
  const stems = stemsOf(directory);
  const result: DegradeResult = { manifests: [], segments: [] };

  for (const segment of segments) {
    const id = segmentId(segment);
    const outDir = path.join(outRoot, id);
    emitProgress(`Degrading ${request.id} ${segment.startSec}-${segment.endSec} s into ${outDir}`);
    const long = kinds.includes("uniform-cuts") ? longSpan(segment, info.durationSec, cutsSec ?? []) : undefined;
    const masterSpan = {
      startSec: Math.max(0, Math.min(segment.startSec, long?.startSec ?? Infinity) - MARGIN_SEC),
      endSec: Math.min(info.durationSec, Math.max(segment.endSec, long?.endSec ?? 0) + MARGIN_SEC),
    };
    const temporary = mkdtempSync(path.join(os.tmpdir(), "avc-degrade-"));
    try {
      const master = extractMaster(
        analysisMedia,
        sourceInfo.hasAudio ? sourceMedia : undefined,
        masterSpan,
        info,
        temporary,
      );
      const frameOf = (timeSec: number) =>
        Math.min(master.frames - 1, Math.max(0, Math.round((timeSec - master.startSec) * master.fps)));
      const first = frameOf(segment.startSec);
      const count = Math.max(
        1,
        Math.min(master.frames - first, Math.round((segment.endSec - segment.startSec) * master.fps)),
      );
      const audioAt = (frame: number, filter?: string): AudioPlan =>
        master.wav
          ? { inputs: [{ file: master.wav, offsetSec: frame / master.fps }], ...(filter ? { filter } : {}) }
          : undefined;
      const clip = (
        name: string,
        frames: number[],
        startFrame: number,
        options: { audio: AudioPlan; videoFilter?: string },
      ) => {
        const file = encodeClip(master, frames, path.join(outDir, `${name}.mp4`), options);
        const startSec = round(master.startSec + startFrame / master.fps, 4);
        return {
          path: path.relative(outDir, file).split(path.sep).join("/"),
          sha256: hashFileSync(file),
          startSec,
          endSec: round(startSec + frames.length / master.fps, 4),
          frameCount: frames.length,
        };
      };
      const identity = (from: number, length: number) => Array.from({ length }, (_, k) => from + k);
      const original = clip("original", identity(first, count), first, { audio: audioAt(first) });
      // Cuts in master frames: the reference's shots.json, or the detector on the original when there is none.
      const cutFrames = (
        cutsSec ??
        detectBoundaries(path.join(outDir, original.path)).boundaries.map((row) => row.timeSec + original.startSec)
      ).map(frameOf);
      const shotsFrom = cutsSec ? "shots.json" : "detector on the original clip";
      const variants: CalibrationManifest["variants"] = [];
      const skipped: CalibrationManifest["skipped"] = [];
      let originalLong: CalibrationManifest["originalLong"];
      const add = (
        variantId: string,
        kind: VariantKind,
        against: "original" | "originalLong",
        frames: number[],
        startFrame: number,
        options: { audio: AudioPlan; videoFilter?: string },
        params: CalibrationManifest["variants"][number]["params"],
      ) => {
        emitProgress(`  ${variantId}`);
        variants.push({ id: variantId, kind, against, ...clip(variantId, frames, startFrame, options), params });
      };

      for (const kind of kinds) {
        if (kind === "stutter")
          add(
            "stutter",
            "stutter",
            "original",
            stutterMap(first, count),
            first,
            { audio: audioAt(first) },
            {
              step: STUTTER_STEP,
              note: `every ${STUTTER_STEP}rd frame held for ${STUTTER_STEP}; no blur added or removed`,
            },
          );
        else if (kind === "desync") {
          for (const offset of [DESYNC_FRAMES, -DESYNC_FRAMES])
            add(
              offset > 0 ? "desync-late" : "desync-early",
              "desync",
              "original",
              desyncMap(first, count, offset, master.frames),
              first,
              { audio: audioAt(first) },
              {
                offsetFrames: offset,
                offsetSec: round(offset / master.fps, 4),
                note: offset > 0 ? "picture late: sound arrives first" : "picture early: cuts lead the sound",
              },
            );
        } else if (kind === "flat-grade")
          add(
            "flat-grade",
            "flat-grade",
            "original",
            identity(first, count),
            first,
            {
              audio: audioAt(first),
              videoFilter: `eq=saturation=${FLAT_GRADE.saturation}:contrast=${FLAT_GRADE.contrast}`,
            },
            { ...FLAT_GRADE, note: "a control: colour only, timing untouched" },
          );
        else if (kind === "no-sfx") {
          if (!master.wav) {
            skipped.push({ kind, reason: "The reference has no audio stream." });
            continue;
          }
          if (stems) {
            const offsetSec = master.startSec + first / master.fps;
            add(
              "no-sfx",
              "no-sfx",
              "original",
              identity(first, count),
              first,
              { audio: { inputs: stems.music.map((file) => ({ file, offsetSec })) } },
              {
                kept: stems.music.map((file) => path.basename(file, ".wav")).join(","),
                dropped: stems.dropped.join(","),
                note: "demucs has no SFX stem: the drums stem, where percussive hits and most SFX land, is removed with them",
              },
            );
          } else
            add(
              "soft-transients",
              "soft-transients",
              "original",
              identity(first, count),
              first,
              { audio: audioAt(first, SOFT_TRANSIENTS) },
              {
                filter: SOFT_TRANSIENTS,
                note: "no stems (ref:analyze --stems): attacks squashed and highs cut instead of removing SFX",
              },
            );
        } else if (kind === "linear-motion") {
          const energy = masterEnergy(master, first, count);
          const starts = shotStartsIn(cutFrames, first, count, energy);
          const map = linearMotionMap(first, energy, starts);
          const moved = map.filter((frame, k) => frame !== first + k).length;
          add(
            "linear-motion",
            "linear-motion",
            "original",
            map,
            first,
            { audio: audioAt(first) },
            {
              shots: starts.length,
              retimedFrames: moved,
              energy: `luma difference at ${ENERGY_SIZE.width}x${ENERGY_SIZE.height}`,
              shotsFrom,
              note: "frames re-picked so change grows evenly within each shot; no in-betweens are made",
            },
          );
        } else if (kind === "uniform-cuts") {
          const longFirst = frameOf(long!.startSec);
          const longCount = Math.max(
            1,
            Math.min(master.frames - longFirst, Math.round((long!.endSec - long!.startSec) * master.fps)),
          );
          const energy = masterEnergy(master, longFirst, longCount);
          const starts = shotStartsIn(cutFrames, longFirst, longCount, energy);
          if (starts.length < MIN_UNIFORM_SHOTS) {
            skipped.push({
              kind,
              reason: `${starts.length} shot(s) in ${long!.startSec}-${long!.endSec} s; equal lengths need at least ${MIN_UNIFORM_SHOTS}.`,
            });
            continue;
          }
          originalLong ??= clip("original-long", identity(longFirst, longCount), longFirst, {
            audio: audioAt(longFirst),
          });
          const { map, outStarts } = uniformCutMap(longFirst, longCount, starts);
          const before = lengthsOf(starts, longCount).map((frames) => round(frames / master.fps, 3));
          const after = lengthsOf(outStarts, longCount).map((frames) => round(frames / master.fps, 3));
          add(
            "uniform-cuts",
            "uniform-cuts",
            "originalLong",
            map,
            longFirst,
            { audio: audioAt(longFirst) },
            {
              shots: starts.length,
              lengthsBeforeSec: before,
              lengthsAfterSec: after,
              shotsFrom,
              note: "long shots cut short, short ones held on their last frame; sound untouched",
            },
          );
        }
      }

      const manifest = CalibrationManifestSchema.parse({
        schemaVersion: 1,
        refId: request.id,
        media: path.relative(process.cwd(), analysisMedia).split(path.sep).join("/"),
        segment: { id, ...segment },
        fps: round(master.fps, 6),
        width: master.width,
        height: master.height,
        encode: ENCODE,
        original,
        ...(originalLong ? { originalLong } : {}),
        ...(grid
          ? {
              grid: {
                beatsSec: grid.beatsSec.filter(
                  (time) => time >= masterSpan.startSec - 1 && time <= masterSpan.endSec + 1,
                ),
                downbeatsSec: grid.downbeatsSec.filter(
                  (time) => time >= masterSpan.startSec - 1 && time <= masterSpan.endSec + 1,
                ),
              },
            }
          : {}),
        variants,
        skipped,
        sha256s: Object.fromEntries(
          [original, ...(originalLong ? [originalLong] : []), ...variants].map((entry) => [entry.path, entry.sha256]),
        ),
      });
      result.manifests.push(writeJsonAtomic(path.join(outDir, "manifest.json"), manifest));
      result.segments.push({ id, variants: variants.length, skipped: skipped.length });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  return result;
}
