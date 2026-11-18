import { pythonArgs, pythonEnvironment, pythonUv } from "../python";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../cli";
import type { Boundary } from "../reference/shots";
import { decodeFrame, probeVideo, writeImage, type VideoInfo } from "../vision/media";
import { buildStrip, composeGrid, MAX_TILES, tileSize, type Cell } from "../vision/sheets";
import {
  FootageShotsSchema,
  FootageTransitionTypeSchema,
  type FootageCut,
  type FootageShot,
  type FootageShots,
} from "../../types/footage-shots";

const WORKER = path.resolve(import.meta.dirname, "../../../scripts/workers/footage-shots.py");
/** TransNetV2 on Apple's MPS gives different boundaries from CPU (see the transnetv2-pytorch README), so it always runs on CPU. */
export const TRANSNET_DEVICE = "cpu";
/** The same normalisation as recording-edit, so frame N here is frame N of its master. */
export const CFR_FILTER = (fps: number) => `fps=fps=${fps}:start_time=0:round=near`;
export const DEFAULT_CFR_FPS = 30;
const TIMEOUT_MS = 3 * 3600 * 1000;
const STORYBOARD_COLUMNS = 8;
const STRIP_TILES = 12;
const STRIP_WIDTH = 240;
const INSTALL_UV = "Install uv: curl -LsSf https://astral.sh/uv/install.sh | sh";

export type Engine = "transnetv2" | "reference";

const WorkerSchema = z.object({
  engine: z.enum(["transnetv2", "reference"]),
  version: z.string(),
  device: z.string().optional(),
  torch: z.string().optional(),
  fadeDetector: z.string(),
  fps: z.number().positive(),
  frames: z.number().int().positive(),
  params: z.record(z.string(), z.number()),
  candidates: z.number().int().nonnegative(),
  transitions: z.array(
    z.object({
      frame: z.number().int(),
      type: FootageTransitionTypeSchema,
      startFrame: z.number().int(),
      endFrame: z.number().int(),
      confidence: z.number(),
      measures: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
    }),
  ),
});
type WorkerResult = z.infer<typeof WorkerSchema>;

const uvx = () => pythonUv(process.env.FOOTAGE_UVX);

export function workerArgs(engine: Engine, media: string): string[] {
  return pythonArgs(engine === "transnetv2" ? "transnet" : "reference", [WORKER, media, engine, TRANSNET_DEVICE]);
}

function runWorker(
  engine: Engine,
  media: string,
): { ok: true; value: WorkerResult } | { ok: false; reason: string; fix: string } {
  const result = spawnSync(uvx(), workerArgs(engine, media), {
    env: pythonEnvironment(engine === "transnetv2" ? "transnet" : "reference"),
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message ?? result.stderr.trim().slice(-600);
    const fix = /ENOENT|not found/i.test(detail)
      ? INSTALL_UV
      : "Check network access for the first uv package download (torch is about 80 MB), then rerun footage:shots.";
    return { ok: false, reason: `footage-shots ${engine} failed: ${detail}`, fix };
  }
  const line = result.stdout.trim().split("\n").at(-1) ?? "";
  const parsed = WorkerSchema.safeParse(JSON.parse(line));
  if (!parsed.success)
    return {
      ok: false,
      reason: `footage-shots ${engine} printed an unexpected result: ${parsed.error.message}`,
      fix: "Report this; the worker and src/lib/footage/shots.ts disagree.",
    };
  return { ok: true, value: parsed.data };
}

const parseRate = (value: unknown) => {
  const [numerator, denominator = 1] = String(value).split("/").map(Number);
  return numerator! / denominator;
};

/** A stream whose average rate differs from its base rate has frames of unequal length. */
export function frameRateIsVariable(stream: { avg_frame_rate?: string; r_frame_rate?: string }): boolean {
  const average = parseRate(stream.avg_frame_rate);
  const base = parseRate(stream.r_frame_rate);
  if (!Number.isFinite(average) || !Number.isFinite(base) || average <= 0 || base <= 0) return true;
  return Math.abs(average - base) / base > 0.001;
}

/** `start_time` is the video stream's start relative to the container's, which ffmpeg treats as time 0. */
export function probeFrameRates(input: string): {
  avg_frame_rate?: string;
  r_frame_rate?: string;
  start_time?: string;
} {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=avg_frame_rate,r_frame_rate,start_time:format=start_time",
      "-of",
      "json",
      input,
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffprobe failed on ${input}: ${result.stderr.trim().slice(-400)}`,
    });
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.[0];
  if (!stream) throw new CliErrorObject({ code: "INVALID_INPUT", message: `No video stream in ${input}` });
  const offset = (Number(stream.start_time) || 0) - (Number(parsed.format?.start_time) || 0);
  return { ...stream, start_time: String(Math.max(0, offset)) };
}

export function normaliseToCfr(input: string, output: string, fps: number): void {
  mkdirSync(path.dirname(output), { recursive: true });
  const result = spawnSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-nostdin",
      "-y",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-vf",
      CFR_FILTER(fps),
      "-fps_mode",
      "cfr",
      "-c:v",
      "libx264",
      "-preset",
      "fast",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      output,
    ],
    { encoding: "utf8", timeout: TIMEOUT_MS },
  );
  if (result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not convert ${input} to a constant frame rate: ${result.stderr.trim().slice(-400)}`,
    });
}

export function frameTimecode(frame: number, fps: number): string {
  const millis = Math.round((frame / fps) * 1000);
  const pad = (value: number, width = 2) => String(value).padStart(width, "0");
  return `${pad(Math.floor(millis / 3600000))}:${pad(Math.floor(millis / 60000) % 60)}:${pad(Math.floor(millis / 1000) % 60)}.${pad(millis % 1000, 3)}`;
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Shots run from one transition's boundary frame to the frame before the next; dissolve and fade frames are left out of the clean span. */
export function shotsFromCuts(cuts: FootageCut[], frames: number, fps: number): FootageShot[] {
  const inner = cuts.filter((cut) => cut.frame > 0 && cut.frame < frames);
  const starts = [0, ...inner.map((cut) => cut.frame)];
  return starts.map((startFrame, index) => {
    const endFrame = index + 1 < starts.length ? starts[index + 1]! - 1 : frames - 1;
    const before = index > 0 ? inner[index - 1] : undefined;
    const after = inner[index];
    const cleanStartFrame = Math.min(
      endFrame,
      before && before.type !== "cut" ? Math.max(startFrame, before.endFrame + 1) : startFrame,
    );
    const cleanEndFrame = Math.max(
      cleanStartFrame,
      after && after.type !== "cut" ? Math.min(endFrame, after.startFrame - 1) : endFrame,
    );
    return {
      id: `s${String(index + 1).padStart(3, "0")}`,
      startFrame,
      endFrame,
      startSec: round(startFrame / fps),
      endSec: round((endFrame + 1) / fps),
      durationFrames: endFrame - startFrame + 1,
      cleanStartFrame,
      cleanEndFrame,
      transitionIn: before?.type ?? "start",
      timecode: `${frameTimecode(startFrame, fps)}-${frameTimecode(endFrame + 1, fps)}`,
    };
  });
}

/** Analysed frames count from container time 0; a late-starting original stream counts from its own first frame. */
export function originalStreamFrame(result: Pick<FootageShots, "fps" | "source">, analysedFrame: number): number {
  return analysedFrame - Math.round((result.source.startOffsetSec ?? 0) * result.fps);
}

/** The same transitions as reference boundaries, so the reference pipeline can take this detector's cuts through shotsLayer. */
export function toReferenceBoundaries(result: FootageShots): Boundary[] {
  return result.cuts.map((cut) => ({
    timeSec: round(cut.frame / result.fps),
    startSec: round(cut.startFrame / result.fps),
    endSec: round(cut.type === "cut" ? cut.startFrame / result.fps : (cut.endFrame + 1) / result.fps),
    kind: cut.type,
    confidence: cut.confidence,
    measures: Object.fromEntries(
      Object.entries(cut.measures ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
    ),
  }));
}

function storyboard(
  media: string,
  info: VideoInfo,
  shots: FootageShot[],
  cuts: FootageCut[],
  directory: string,
  width?: number,
): string[] {
  const { width: tileWidth, height } = tileSize(info, width);
  const pages = Math.ceil(shots.length / MAX_TILES);
  return Array.from({ length: pages }, (_, page) => {
    const group = shots.slice(page * MAX_TILES, (page + 1) * MAX_TILES);
    const cells: Cell[] = group.map((shot) => {
      const middle = Math.floor((shot.cleanStartFrame + shot.cleanEndFrame) / 2);
      const decoded = decodeFrame(media, info, middle, tileWidth, height);
      return {
        image: decoded.image,
        label: `${shot.id} F${shot.startFrame}-${shot.endFrame}`,
        caption: `${shot.timecode} ${shot.transitionIn.toUpperCase()}`,
      };
    });
    const counts = (["cut", "dissolve", "fade"] as const)
      .map((type) => `${cuts.filter((cut) => cut.type === type).length} ${type.toUpperCase()}`)
      .join(" ");
    const title = `STORYBOARD ${page + 1}/${pages}: ${shots.length} SHOTS, ${counts}, MIDDLE CLEAN FRAME OF EACH`;
    return writeImage(
      composeGrid(cells, { title, columns: Math.min(STORYBOARD_COLUMNS, cells.length) }),
      path.join(directory, `storyboard-${String(page + 1).padStart(2, "0")}.jpg`),
    );
  });
}

function strip(media: string, info: VideoInfo, shot: FootageShot, output: string): string {
  const step = Math.max(1, Math.ceil(shot.durationFrames / STRIP_TILES));
  const { image } = buildStrip(media, info, {
    startFrame: shot.startFrame,
    endFrame: Math.min(shot.endFrame, info.frameCount - 1),
    step,
    width: STRIP_WIDTH,
    columns: 6,
  });
  return writeImage(image, output);
}

export type FootageShotsRequest = {
  input: string;
  outputDir: string;
  engine?: Engine | "auto";
  fps?: number;
  strips?: boolean;
  width?: number;
};

export function detectFootageShots(request: FootageShotsRequest): { result: FootageShots; outputs: string[] } {
  const input = path.resolve(request.input);
  const directory = path.resolve(request.outputDir);
  mkdirSync(directory, { recursive: true });
  const original = probeVideo(input);
  const rates = probeFrameRates(input);
  const variable = frameRateIsVariable(rates);
  // recording-edit's filter pads a stream that starts late, so frame numbers would otherwise differ from its master.
  const startOffsetSec = Math.max(0, Number(rates.start_time ?? 0) || 0);
  const lateStart = startOffsetSec > 0.5 / original.fps;
  const outputs: string[] = [];
  let media = input;
  let normalised: FootageShots["source"]["normalised"];
  if (variable || lateStart || (request.fps !== undefined && Math.abs(request.fps - original.fps) > 1e-6)) {
    const fps = request.fps ?? (variable ? DEFAULT_CFR_FPS : original.fps);
    media = path.join(directory, "cfr.mp4");
    normaliseToCfr(input, media, fps);
    normalised = { fps, filter: CFR_FILTER(fps) };
    outputs.push(media);
  }

  const engine = request.engine ?? "auto";
  let fallback: FootageShots["detector"]["fallback"];
  let run = runWorker(engine === "reference" ? "reference" : "transnetv2", media);
  if (!run.ok && engine === "auto") {
    fallback = {
      reason: `TransNetV2 was unavailable, so the reference detector ran; it misses some dissolves. ${run.reason}`,
      fix: run.fix,
    };
    run = runWorker("reference", media);
  }
  if (!run.ok) throw new CliErrorObject({ code: "INTERNAL", message: `${run.reason} Fix: ${run.fix}` });
  const worker = run.value;

  const info = { ...probeVideo(media), frameCount: worker.frames };
  const cuts: FootageCut[] = worker.transitions.map((row) => ({
    ...row,
    confidence: Math.min(1, Math.max(0, row.confidence)),
    timeSec: round(row.frame / worker.fps),
    timecode: frameTimecode(row.frame, worker.fps),
  }));
  const shots = shotsFromCuts(cuts, worker.frames, worker.fps);
  const sheets = storyboard(media, info, shots, cuts, directory, request.width);
  outputs.push(...sheets);
  let strips: Record<string, string> | undefined;
  if (request.strips) {
    strips = Object.fromEntries(
      shots.map((shot) => [shot.id, strip(media, info, shot, path.join(directory, "strips", `${shot.id}.jpg`))]),
    );
    outputs.push(...Object.values(strips));
  }

  const result = FootageShotsSchema.parse({
    schemaVersion: 1,
    source: {
      path: input,
      analysedPath: media,
      width: info.width,
      height: info.height,
      variableFrameRate: variable,
      ...(normalised ? { normalised } : {}),
      ...(normalised && startOffsetSec > 0 ? { startOffsetSec: round(startOffsetSec) } : {}),
    },
    fps: worker.fps,
    frames: worker.frames,
    durationSec: round(worker.frames / worker.fps),
    detector: {
      engine: worker.engine,
      version: worker.version,
      ...(worker.device ? { device: worker.device } : {}),
      ...(worker.torch ? { torch: worker.torch } : {}),
      fadeDetector: worker.fadeDetector,
      refinement:
        "cuts: largest mean pixel difference within 3 frames; dissolves: three-level fit of coarse composition change; fades: brightness ramps around the black hold",
      params: worker.params,
      candidates: worker.candidates,
      ...(fallback ? { fallback } : {}),
    },
    cuts,
    shots,
    storyboard: sheets.map((sheet) => path.relative(directory, sheet)),
    ...(strips
      ? { strips: Object.fromEntries(Object.entries(strips).map(([id, file]) => [id, path.relative(directory, file)])) }
      : {}),
  });
  const json = path.join(directory, "shots.json");
  writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
  return { result, outputs: [json, ...outputs] };
}
