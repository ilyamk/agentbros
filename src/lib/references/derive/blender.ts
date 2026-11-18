/**
 * Blender reference passes (RFC 0003 §3.7, AC10): depth, normal, mist, clay, beauty and camera-path from a project
 * .blend, through the `blender:run` machinery (runBlender: Blender discovery, isolated profile, timeout, log) and
 * scripts/blender/kit/passes.py. The input asset is the target the pass matches: its size and frame count.
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { assertPathWithin, CliErrorObject } from "../../cli";
import { hashFile } from "../../assets/registry";
import { readCameraExport, runBlender } from "../../backends/blender-run";
import type { DerivationStep } from "../../../types/references";
import { BITEXACT, X264, type MediaState } from "./ops";

export const PASSES_SCRIPT = fileURLToPath(new URL("../../../../scripts/blender/kit/passes.py", import.meta.url));
/** Where a pass's PNG sequence and pass.json live inside the derivative directory (fixed, beside receipt.json). */
export const SEQUENCE_DIR = "sequence";

type BlenderStep = Extract<DerivationStep, { op: "blender-pass" }>;
export type PassReceipt = {
  pass: BlenderStep["pass"];
  frameStart: number;
  frameEnd: number;
  frames: number;
  width: number;
  height: number;
  fps: number;
  blenderVersion: string;
  nearM?: number;
  farM?: number;
  bitDepth?: number;
  files?: string[];
};
export type BlenderPassResult = {
  /** The file that becomes the derivative output: preview MP4, a PNG still, or camera.json. */
  output: string;
  /** Directory holding sequence/ and pass.json, moved into the derivative directory on commit; absent for camera-path. */
  sidecar?: string;
  pass: PassReceipt;
  blendSha256: string;
  version: string;
  measurements: Record<string, number>;
  warnings: string[];
};

/** A project-relative .blend inside the project (symlinks resolved), or INVALID_INPUT / FILE_NOT_FOUND. */
export function resolveBlendScene(projectDir: string, scene: string): string {
  if (path.isAbsolute(scene) || !scene.toLowerCase().endsWith(".blend"))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `blender-pass scene must be a project-relative .blend path, not ${scene}.`,
    });
  const root = realpathSync(projectDir);
  const candidate = path.resolve(root, scene);
  assertPathWithin(root, candidate);
  if (!existsSync(candidate) || !statSync(candidate).isFile())
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `blender-pass scene not found: ${scene}` });
  const real = realpathSync(candidate);
  assertPathWithin(root, real);
  return real;
}

function ffmpeg(args: string[]): void {
  const result = spawnSync("ffmpeg", ["-nostdin", "-hide_banner", "-v", "error", "-n", ...args], {
    encoding: "utf8",
    timeout: 600_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg failed: ${result.error?.message ?? result.stderr.slice(-700)}`,
    });
}

/** Render one pass for `target` into `work`; the caller imports `output` and moves `sidecar` on commit. */
export async function runBlenderPass(
  step: BlenderStep,
  target: MediaState,
  projectDir: string,
  work: string,
  options: { executable?: string; timeoutSec?: number } = {},
): Promise<BlenderPassResult> {
  const scene = resolveBlendScene(projectDir, step.scene);
  const blendSha256 = hashFile(scene);
  const output = path.join(work, "blender");
  const frames = target.kind === "video" ? (target.frameCount ?? 1) : 1;
  const run = await runBlender({
    blend: scene,
    script: PASSES_SCRIPT,
    output,
    format: "png",
    device: "cpu",
    factoryStartup: true,
    noRender: true,
    overwrite: false,
    resume: false,
    scriptArgs: [JSON.stringify({ pass: step.pass, width: target.width, height: target.height, frames })],
    executable: options.executable,
    timeoutSec: options.timeoutSec ?? 3600,
  });
  if (hashFile(scene) !== blendSha256)
    throw new CliErrorObject({ code: "VALIDATION", message: `${step.scene} changed while Blender rendered it.` });
  const passFile = path.join(output, "pass.json");
  if (!existsSync(passFile))
    throw new CliErrorObject({ code: "INTERNAL", message: `passes.py wrote no pass.json. Log: ${run.logFile}` });
  const pass = JSON.parse(readFileSync(passFile, "utf8")) as PassReceipt;
  const version = `Blender ${pass.blenderVersion}`;
  const warnings: string[] = [];
  if (target.kind === "video" && target.fps && Math.abs(pass.fps - target.fps) > 1e-3)
    warnings.push(
      `The scene runs at ${pass.fps} fps and the target at ${Number(target.fps.toFixed(3))} fps; frames map one to one, so retime the scene if its motion must match the target's seconds.`,
    );
  const measurements: Record<string, number> = { sceneFps: pass.fps, sequenceFrames: pass.frames };
  if (pass.nearM !== undefined && pass.farM !== undefined) {
    measurements.nearM = pass.nearM;
    measurements.farM = pass.farM;
  }
  if (step.pass === "camera-path") {
    const camera = path.join(output, "camera.json");
    const read = readCameraExport(camera);
    if (read.frames !== frames)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `camera.json holds ${read.frames} of ${frames} frames.`,
      });
    return { output: camera, pass, blendSha256, version, measurements, warnings };
  }
  if (pass.bitDepth) measurements.sequenceBitDepth = pass.bitDepth;
  const sequence = path.join(output, SEQUENCE_DIR);
  if (pass.files?.length !== frames || pass.width !== target.width || pass.height !== target.height)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `pass.json reports ${pass.files?.length ?? 0} frames at ${pass.width}x${pass.height}; expected ${frames} at ${target.width}x${target.height}.`,
    });
  for (const name of pass.files) {
    const file = path.join(sequence, name);
    if (!existsSync(file) || readFileSync(file).subarray(0, 8).toString("hex") !== "89504e470d0a1a0a")
      throw new CliErrorObject({ code: "VALIDATION", message: `Blender pass frame missing or not a PNG: ${name}` });
  }
  const preview = path.join(work, target.kind === "video" ? "pass-preview.mp4" : "pass-still.png");
  const input = ["-protocol_whitelist", "file", "-framerate", String(target.fps ?? pass.fps)];
  input.push("-start_number", String(pass.frameStart), "-i", path.join(sequence, "frame-%06d.png"));
  if (target.kind === "video")
    ffmpeg([...input, "-frames:v", String(frames), "-vf", "setsar=1", ...X264, ...BITEXACT, preview]);
  else ffmpeg([...input, "-frames:v", "1", "-vf", "format=rgb24", "-c:v", "png", ...BITEXACT, preview]);
  return { output: preview, sidecar: output, pass, blendSha256, version, measurements, warnings };
}
