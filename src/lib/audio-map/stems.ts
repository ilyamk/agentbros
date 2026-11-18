import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CliErrorObject, requireFile } from "../cli";
import { primingTrim, type DecoderDelay } from "./decoder-delay";

const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/audio-stems.py");
const TIMEOUT_MS = 1800000;

export const STEM_MODEL = "htdemucs";
export const STEM_NAMES = ["drums", "bass", "other", "vocals"] as const;
export type StemName = (typeof STEM_NAMES)[number];

/** Keyed by the audio's hash, not by project: the same track in two projects is split once. Removed by `clean --scope cache`. */
export const STEMS_CACHE_DIR = path.join(".cache", "audio-stems");

export type Stems = { model: string; sha256: string; dir: string; cached: boolean; paths: Record<StemName, string> };
export type StemsOutcome = { stems: Stems } | { stems: null; reason: string };

const uvx = () => pythonUv(process.env.AUDIO_STEMS_UVX ?? process.env.REFERENCE_UVX);

export function stemsDir(sha256: string, model = STEM_MODEL, root = process.cwd()): string {
  return path.join(root, STEMS_CACHE_DIR, model, sha256);
}

function stemPaths(dir: string): Record<StemName, string> {
  return Object.fromEntries(STEM_NAMES.map((name) => [name, path.join(dir, `${name}.wav`)])) as Record<
    StemName,
    string
  >;
}

function decodeStereo(media: string, wav: string, delay?: DecoderDelay): void {
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
      "2",
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

/** Splits the file with Demucs into drums, bass, other and vocals, or returns the cached split. Throws when the model cannot run. */
export function separateStems(
  input: string,
  options: { root?: string; model?: string; decoder?: DecoderDelay } = {},
): Stems {
  requireFile(input);
  const model = options.model ?? STEM_MODEL;
  const sha256 = createHash("sha256").update(readFileSync(input)).digest("hex");
  // A split with the priming removed is another timeline, so it is cached apart.
  const dir = stemsDir(
    options.decoder?.primingCorrected ? `${sha256}-primed${Math.round(options.decoder.primingSec * 1e6)}us` : sha256,
    model,
    options.root,
  );
  const paths = stemPaths(dir);
  if (Object.values(paths).every((file) => existsSync(file))) return { model, sha256, dir, cached: true, paths };
  const work = mkdtempSync(path.join(tmpdir(), "audio-stems-"));
  try {
    const wav = path.join(work, "mix.wav");
    decodeStereo(input, wav, options.decoder);
    const staging = path.join(work, "stems");
    process.stderr.write(`Separating stems with ${model} (first run downloads the model, about 80 MB)\n`);
    const result = spawnSync(uvx(), pythonArgs("stems", [WORKER, wav, staging, model]), {
      env: pythonEnvironment("stems"),
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? result.stderr.trim().slice(-600);
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `stem separation failed: ${detail}`,
        details: {
          fix: "Check uv and network access for the first download of torch, demucs and the model weights, then rerun.",
        },
      });
    }
    mkdirSync(path.dirname(dir), { recursive: true });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
    writeFileSync(
      path.join(dir, "stems.json"),
      `${JSON.stringify({ model, sha256, source: path.basename(input), sources: STEM_NAMES }, null, 2)}\n`,
    );
    return { model, sha256, dir, cached: false, paths };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Like separateStems, but a missing model or a failed run gives a reason instead of an error, so the map falls back to the full mix. */
export function tryStems(
  input: string,
  options: { root?: string; model?: string; decoder?: DecoderDelay } = {},
): StemsOutcome {
  try {
    return { stems: separateStems(input, options) };
  } catch (error) {
    if (error instanceof CliErrorObject && error.code === "FFMPEG_MISSING") throw error;
    return { stems: null, reason: error instanceof Error ? error.message.slice(0, 300) : String(error) };
  }
}
