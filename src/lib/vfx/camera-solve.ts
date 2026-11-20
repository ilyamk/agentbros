/**
 * General moving-camera solve for footage inserts (docs: .agents/skills/vork-3d-vfx/references/vfx.md).
 *
 * Three local stages, each a plain file contract so a stage can be rerun alone:
 * 1. tracks: KLT features outside a holdout matte, forward-backward and epipolar checked
 *    (scripts/workers/camera-tracks.py, uv `vork` group).
 * 2. solve: Blender libmv solve with iterative cleaning; every round is exported and the best geometrically sane
 *    round is kept (scripts/blender/vfx_camera_solve.py through blender:run, no render).
 * 3. scale (optional): metric scale from a subject of known width seen in a person matte
 *    (scripts/workers/camera-scale.py).
 * The result is an OpenCV sidecar (camera.json, world-to-camera K/R/t per frame) that `vorkCamera` turns into a
 * Vork camera, plus bundles.json and solve-report.json.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { DEFAULT_TIMEOUT_SEC, runBlender } from "../backends/blender-run";
import { PYTHON_ROOT, pythonArgs, pythonEnvironment, pythonUv } from "../python";

export const TRACKS_WORKER = path.join(PYTHON_ROOT, "scripts/workers/camera-tracks.py");
export const SCALE_WORKER = path.join(PYTHON_ROOT, "scripts/workers/camera-scale.py");
export const SOLVE_SCRIPT = path.join(PYTHON_ROOT, "scripts/blender/vfx_camera_solve.py");

export type TrackOptions = {
  frames?: [number, number];
  matteDir?: string;
  mattePattern?: string;
  maxPoints?: number;
  minDistance?: number;
  fbMaxPx?: number;
  minLength?: number;
  redetectEvery?: number;
  matteDilatePx?: number;
  epipolarGap?: number;
  epipolarPx?: number;
  epipolarRejectShare?: number;
};

export type SolveOptions = {
  focalPx: number;
  keyframes?: [number, number];
  cleanRounds?: number;
  maxTracks?: number;
  minLength?: number;
  targetErrorPx?: number;
  refine?: string;
};

export type CameraSolveRequest = {
  plate: string;
  output: string;
  tracks?: TrackOptions;
  solve: SolveOptions;
  scale?: { matteDir: string; mattePattern?: string; subjectWidthM?: number };
  executable?: string;
  timeoutSec?: number;
};

/** The tracking worker's request (snake_case, as the worker reads it); exported for tests. */
export function tracksRequest(plate: string, output: string, options: TrackOptions = {}) {
  return {
    plate: path.resolve(plate),
    output: path.resolve(output),
    frames: options.frames ?? null,
    matte_dir: options.matteDir ? path.resolve(options.matteDir) : null,
    matte_pattern: options.mattePattern ?? "frame-{:05d}.png",
    max_points: options.maxPoints ?? 900,
    min_distance: options.minDistance ?? 12,
    fb_max_px: options.fbMaxPx ?? 0.5,
    min_length: options.minLength ?? 15,
    redetect_every: options.redetectEvery ?? 3,
    matte_dilate_px: options.matteDilatePx ?? 10,
    epipolar_gap: options.epipolarGap ?? 6,
    epipolar_px: options.epipolarPx ?? 1,
    epipolar_reject_share: options.epipolarRejectShare ?? 0.25,
  };
}

/** The Blender solve script's parameters; exported for tests. */
export function solveParams(plate: string, tracks: string, output: string, options: SolveOptions) {
  return {
    plate: path.resolve(plate),
    tracks: path.resolve(tracks),
    output: path.resolve(output),
    focal_px: options.focalPx,
    ...(options.keyframes ? { keyframes: options.keyframes } : {}),
    ...(options.cleanRounds !== undefined ? { clean_rounds: options.cleanRounds } : {}),
    ...(options.maxTracks !== undefined ? { max_tracks: options.maxTracks } : {}),
    ...(options.minLength !== undefined ? { min_length: options.minLength } : {}),
    ...(options.targetErrorPx !== undefined ? { target_error_px: options.targetErrorPx } : {}),
    ...(options.refine !== undefined ? { refine: options.refine } : {}),
  };
}

/** Run a uv worker with one request file and parse its single JSON line. */
function runWorker(worker: string, request: object, requestFile: string, timeoutSec: number) {
  writeFileSync(requestFile, JSON.stringify(request, null, 1));
  const child = spawnSync(pythonUv(), pythonArgs("vork", [worker, requestFile]), {
    env: pythonEnvironment("vork"),
    encoding: "utf8",
    timeout: timeoutSec * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = (child.stdout ?? "").trim().split("\n").at(-1) ?? "";
  if (child.status !== 0 || !line.startsWith("{"))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `${path.basename(worker)} failed: ${(child.stderr || child.error?.message || "no output").trim().slice(-800)}`,
    });
  return JSON.parse(line) as Record<string, unknown> & { count?: number };
}

export type SolveReport = {
  averageErrorPx: number;
  focalPx: number;
  frames: number;
  solvedFrames: number;
  missingFrames: number[];
  bestRound?: number;
  scaleMetresPerUnit?: number;
};

/** Run tracks → solve → optional scale. Returns the paths of each stage and the final report. */
export async function cameraSolve(request: CameraSolveRequest) {
  const output = path.resolve(request.output);
  const timeoutSec = request.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  mkdirSync(output, { recursive: true });
  const tracksFile = path.join(output, "tracks.json");
  const tracks = runWorker(
    TRACKS_WORKER,
    tracksRequest(request.plate, tracksFile, request.tracks),
    path.join(output, "tracks-request.json"),
    timeoutSec,
  );
  const solveDir = path.join(output, "solve");
  const params = solveParams(request.plate, tracksFile, solveDir, request.solve);
  const paramsFile = path.join(output, "solve-request.json");
  writeFileSync(paramsFile, JSON.stringify(params, null, 1));
  await runBlender({
    script: SOLVE_SCRIPT,
    output: path.join(output, "blender"),
    format: "png",
    device: "cpu",
    factoryStartup: true,
    noRender: true,
    overwrite: false,
    resume: false,
    scriptArgs: [paramsFile],
    executable: request.executable,
    timeoutSec,
  });
  let finalDir = solveDir;
  let scale: Record<string, unknown> | undefined;
  if (request.scale) {
    finalDir = path.join(output, "scaled");
    scale = runWorker(
      SCALE_WORKER,
      {
        solve: solveDir,
        output: finalDir,
        matte_dir: path.resolve(request.scale.matteDir),
        matte_pattern: request.scale.mattePattern ?? "frame-{:05d}.png",
        subject_width_m: request.scale.subjectWidthM ?? 0.16,
      },
      path.join(output, "scale-request.json"),
      timeoutSec,
    );
  }
  const report = JSON.parse(readFileSync(path.join(finalDir, "solve-report.json"), "utf8")) as SolveReport;
  return {
    output,
    tracks: { file: tracksFile, ...tracks },
    solveDir,
    finalDir,
    camera: path.join(finalDir, "camera.json"),
    report,
    scale,
  };
}
