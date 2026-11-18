import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, requireFile } from "../cli";
import { AudioMapSchema, MusicStructureSchema, type AudioMap, type MusicStructure } from "../../types/film";
import { detectDecoderDelay, primingTrim, type DecoderDelay } from "./decoder-delay";
import { tryStems } from "./stems";

const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/audio-map.py");
const STRUCTURE_WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/audio-structure.py");
const TIMEOUT_MS = 1800000;

export type AudioMapDiagnostics = {
  engine: string;
  trackerBpm: number;
  downbeatConfidence: number;
  beatsPerBarAssumed: number;
  grid: Record<string, number>;
  /** Which reading the beat grid follows: the drums stem's fit, the mix's drum fit, or the tracker. */
  gridSource?: string;
  drumGrid?: Record<string, number>;
  /** Why stems were asked for and not used; the map then reads drums from the full mix. */
  stemsSkipped?: string;
};

export type AudioMapResult = {
  map: AudioMap;
  brief: string;
  diagnostics: AudioMapDiagnostics;
  jsonPath: string;
  imagePath?: string;
};

type WorkerOutput = {
  map: Omit<AudioMap, "schemaVersion" | "source" | "mapImagePath"> & { durationSec: number };
  diagnostics: AudioMapDiagnostics;
  brief: string;
};

const uvx = () => pythonUv(process.env.REFERENCE_UVX);

/** A path as a project would refer to it: relative inside the working directory, as given outside it. */
function portable(target: string): string {
  const relative = path.relative(process.cwd(), path.resolve(target));
  return relative.startsWith("..") || path.isAbsolute(relative) ? target : relative.split(path.sep).join("/");
}

function decode(media: string, wav: string, delay?: DecoderDelay): void {
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      media,
      "-map",
      "0:a:0",
      "-af",
      `${primingTrim(delay)}aresample=44100:async=1:first_pts=0`,
      "-ac",
      "1",
      "-c:a",
      "pcm_s16le",
      wav,
    ],
    { encoding: "utf8", timeout: 600000, killSignal: "SIGKILL" },
  );
  if (result.error && /ENOENT/.test(result.error.message))
    throw new CliErrorObject({
      code: "FFMPEG_MISSING",
      message: "ffmpeg not found. Install it with: brew install ffmpeg",
    });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg could not read an audio stream from ${media}: ${result.error?.message ?? result.stderr.trim().slice(-300)}`,
    });
}

function runWorker<T = WorkerOutput>(wav: string, request: Record<string, unknown>, work: string, worker = WORKER): T {
  const file = path.join(work, "request.json");
  writeFileSync(file, JSON.stringify(request));
  const result = spawnSync(uvx(), pythonArgs("audio-map", [worker, wav, file]), {
    env: pythonEnvironment("audio-map"),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim().slice(-600);
    const missing = /ENOENT|not found/i.test(detail);
    throw new CliErrorObject({
      code: missing ? "VALIDATION" : "INTERNAL",
      message: `audio-map worker failed: ${detail}`,
      details: {
        fix: missing
          ? "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh"
          : "Check network access for the first uv package download, then rerun.",
      },
    });
  }
  return JSON.parse(result.stdout) as T;
}

/** Measures a file and writes the map, plus the picture unless `imagePath` is null. */
export function buildAudioMap(request: {
  input: string;
  output: string;
  imagePath?: string | null;
  imageRef?: string;
  sourcePath?: string;
  title?: string;
  stems?: boolean;
  aacPrimingCorrect?: boolean;
}): AudioMapResult {
  requireFile(request.input);
  const image = request.imagePath === undefined ? `${request.output.replace(/\.json$/, "")}.png` : request.imagePath;
  const work = mkdtempSync(path.join(tmpdir(), "audio-map-"));
  try {
    const wav = path.join(work, "audio.wav");
    const decoder = detectDecoderDelay(request.input, request.aacPrimingCorrect ?? false);
    decode(request.input, wav, decoder);
    const sha256 = createHash("sha256").update(readFileSync(request.input)).digest("hex");
    const split = request.stems ? tryStems(request.input, { decoder }) : null;
    const stems = split?.stems ?? null;
    const title = request.title ?? path.basename(request.input);
    const stemPaths = stems ? { drumsPath: stems.paths.drums, bassPath: stems.paths.bass } : {};
    const { map, diagnostics, brief: mapBrief } = runWorker(wav, { imagePath: null, title, ...stemPaths }, work);
    // The form reads the finished grid, then draws the map's picture with its own lanes added.
    const mapFile = path.join(work, "map.json");
    writeFileSync(mapFile, JSON.stringify({ ...map, source: { durationSec: map.durationSec } }));
    const { structure, brief: structureBrief } = runWorker<{ structure: unknown; brief: string }>(
      wav,
      { mapPath: mapFile, imagePath: image ? path.resolve(image) : null, title, ...stemPaths },
      work,
      STRUCTURE_WORKER,
    );
    const brief = `${mapBrief} ${structureBrief}`;
    if (split && !split.stems) diagnostics.stemsSkipped = split.reason;
    const { durationSec, ...rest } = map;
    const parsed = AudioMapSchema.parse({
      schemaVersion: 1,
      source: { path: request.sourcePath ?? portable(request.input), sha256, durationSec, decoder },
      ...rest,
      structure,
      ...(stems ? { stems: { model: stems.model, dir: portable(stems.dir) } } : {}),
      ...(image ? { mapImagePath: request.imageRef ?? portable(image) } : {}),
    });
    mkdirSync(path.dirname(path.resolve(request.output)), { recursive: true });
    writeFileSync(request.output, `${JSON.stringify(parsed, null, 2)}\n`);
    return { map: parsed, brief, diagnostics, jsonPath: request.output, ...(image ? { imagePath: image } : {}) };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** The structure worker alone, on a map made elsewhere (by hand in tests): its form and brief, with no picture. */
export function readStructure(
  input: string,
  map: Record<string, unknown>,
): { structure: MusicStructure; brief: string } {
  requireFile(input);
  const work = mkdtempSync(path.join(tmpdir(), "audio-structure-"));
  try {
    const wav = path.join(work, "audio.wav");
    decode(input, wav);
    const mapFile = path.join(work, "map.json");
    writeFileSync(mapFile, JSON.stringify(map));
    const { structure, brief } = runWorker<{ structure: unknown; brief: string }>(
      wav,
      { mapPath: mapFile, imagePath: null },
      work,
      STRUCTURE_WORKER,
    );
    return { structure: MusicStructureSchema.parse(structure), brief };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export function readAudioMap(file: string): AudioMap {
  requireFile(file);
  return AudioMapSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}
