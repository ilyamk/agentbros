/**
 * Pre-cut a long presenter recording into per-scene clips using ffmpeg.
 *
 * This is an optional step — the Remotion composition can also use one long
 * file with presenterStartSec/presenterEndSec. Run this script when you want
 * discrete clip files under public/projects/{id}/talking-head/{sceneId}.mp4.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/slice-talking-head.ts --project <id>
 *   pnpm tsx --env-file=.env scripts/slice-talking-head.ts --project <id> --source path/to/raw.mp4
 *   pnpm tsx --env-file=.env scripts/slice-talking-head.ts --project <id> --force
 *
 * Options:
 *   --project   Project ID (required)
 *   --source    Path to the source video (overrides project.talkingHead.presenterVideo)
 *   --force     Overwrite existing output clips
 *
 * Requires: ffmpeg (brew install ffmpeg)
 */

import { existsSync, mkdirSync } from "fs";
import path from "path";
import { spawn } from "child_process";
import { loadProject } from "../src/lib/project";

import {
  parseArgs,
  runScript,
  requireProject,
  ensureFfmpeg,
  CliErrorObject,
  emitProgress,
  assertPathWithin,
} from "../src/lib/cli";

function runFfmpeg(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "inherit"] });

    proc.on("error", (err) => reject(new Error(`ffmpeg spawn error: ${err.message}`)));
    proc.on("close", (code) => resolve(code ?? 1));
  });
}

async function sliceScene(sourceVideo: string, outputPath: string, startSec: number, endSec: number): Promise<void> {
  const dir = path.dirname(outputPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  // Attempt stream copy first (fast, lossless)
  const copyArgs = ["-y", "-ss", String(startSec), "-to", String(endSec), "-i", sourceVideo, "-c", "copy", outputPath];

  const copyCode = await runFfmpeg(copyArgs);

  if (copyCode === 0) return;

  // Fallback: re-encode (slower but more compatible)
  emitProgress(`    Stream copy failed (exit ${copyCode}), re-encoding...`);
  const encodeArgs = [
    "-y",
    "-ss",
    String(startSec),
    "-to",
    String(endSec),
    "-i",
    sourceVideo,
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    outputPath,
  ];

  const encodeCode = await runFfmpeg(encodeArgs);
  if (encodeCode !== 0) {
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg re-encode failed with exit code ${encodeCode}`,
    });
  }
}

runScript(async () => {
  const args = parseArgs([
    { name: "project", required: true, description: "Project slug" },
    { name: "source", description: "Source video path" },
    { name: "force", type: "boolean", description: "Overwrite clips" },
  ] as const);
  const projectId = args.project!;
  requireProject(projectId);
  const project = loadProject(projectId);
  if (!project.talkingHead)
    throw new CliErrorObject({ code: "VALIDATION", message: "Project has no talkingHead configuration." });
  const sourceVideo = path.resolve(args.source ?? path.join("public", project.talkingHead.presenterVideo));
  if (!args.source) assertPathWithin(path.resolve("public"), sourceVideo);
  if (!existsSync(sourceVideo))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Source video not found: ${sourceVideo}` });
  const outputDir = path.join("public", "projects", projectId, "talking-head");
  const outputs: string[] = [];
  let skipped = 0;
  // Validate every range before writing any clip.
  for (const scene of project.scenes) {
    if (scene.presenterStartSec === undefined && scene.presenterEndSec === undefined) continue;
    if (
      scene.presenterStartSec === undefined ||
      scene.presenterEndSec === undefined ||
      !Number.isFinite(scene.presenterStartSec) ||
      !Number.isFinite(scene.presenterEndSec) ||
      scene.presenterStartSec < 0 ||
      scene.presenterEndSec <= scene.presenterStartSec
    )
      throw new CliErrorObject({ code: "VALIDATION", message: `Invalid presenter range: ${scene.id}` });
    assertPathWithin(outputDir, path.join(outputDir, `${scene.id}.mp4`));
  }
  ensureFfmpeg();
  for (const scene of project.scenes) {
    if (scene.presenterStartSec === undefined || scene.presenterEndSec === undefined) {
      skipped++;
      continue;
    }
    const output = path.resolve(outputDir, `${scene.id}.mp4`);
    if (existsSync(output) && !args.force) {
      skipped++;
      continue;
    }
    await sliceScene(sourceVideo, output, scene.presenterStartSec, scene.presenterEndSec);
    outputs.push(path.relative(process.cwd(), output));
  }
  return { outputs, metadata: { projectId, clipped: outputs.length, skipped } };
});
