/**
 * Extract frame JPEGs from a rendered video for QA review.
 *
 * Saves one JPEG per timestamp to out/{id}/qa-screenshots/{ts:06.2f}.jpg.
 * Timestamps are spaced `--every` seconds apart, starting at 0, up to
 * `--max` frames total (default 30). Existing screenshots are removed first
 * unless --no-clean is passed.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/qa-screenshots.ts --project <id>
 *   pnpm tsx --env-file=.env scripts/qa-screenshots.ts --project <id> --format landscape
 *   pnpm tsx --env-file=.env scripts/qa-screenshots.ts --project <id> --every 5 --max 20
 *   pnpm tsx --env-file=.env scripts/qa-screenshots.ts --project <id> --no-clean
 *
 * Options:
 *   --project    Project ID (required)
 *   --format     Video format: landscape | vertical | square (default: first in project.formats)
 *   --every      Interval between frames in seconds (default: 2)
 *   --max        Maximum number of frames to extract (default: 30)
 *   --no-clean   Do not remove existing screenshots before extracting
 *
 * Requires: ffmpeg + ffprobe (brew install ffmpeg)
 */

import { attachVideoReview } from "../src/lib/vision/review-adapters";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadProject } from "../src/lib/project";

import {
  parseArgs,
  runScript,
  requireProject,
  ensureFfmpeg,
  ensureFfprobe,
  CliErrorObject,
  emitProgress,
  assertPathWithin,
} from "../src/lib/cli";

// ---------------------------------------------------------------------------
// Duration via ffprobe
// ---------------------------------------------------------------------------

function getVideoDuration(videoPath: string): number {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", videoPath],
    { encoding: "utf-8" },
  );

  if (result.error || result.status !== 0) {
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffprobe failed for "${videoPath}": ${result.stderr?.trim() ?? "unknown error"}`,
    });
  }

  const duration = parseFloat(result.stdout.trim());
  if (isNaN(duration) || duration <= 0) {
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `Could not parse duration from ffprobe output: "${result.stdout.trim()}"`,
    });
  }

  return duration;
}

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

function extractFrame(videoPath: string, timestamp: number, outputPath: string): void {
  const result = spawnSync(
    "ffmpeg",
    ["-y", "-ss", String(timestamp), "-i", videoPath, "-frames:v", "1", "-q:v", "2", outputPath],
    { encoding: "utf-8" },
  );

  if (result.error || result.status !== 0) {
    throw new CliErrorObject({
      code: "FFMPEG_FAILED",
      message: `ffmpeg failed at ${timestamp}s: ${result.stderr?.trim() ?? "unknown error"}`,
    });
  }
}

// ---------------------------------------------------------------------------
// Timestamp formatting: "000012.50" → "000012.50.jpg"
// ---------------------------------------------------------------------------

function formatTimestamp(seconds: number): string {
  const intPart = Math.floor(seconds).toString().padStart(6, "0");
  const fracPart = (seconds % 1).toFixed(2).slice(1); // ".xx"
  return `${intPart}${fracPart}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs([
    { name: "overview", type: "boolean", description: "Sample the complete duration instead of a fixed interval" },
    { name: "project", required: true, description: "Project slug" },
    { name: "format", choices: ["vertical", "square", "landscape"], description: "Video format" },
    { name: "every", type: "number", default: 2, description: "Interval seconds" },
    { name: "max", type: "number", default: 30, description: "Maximum frames" },
    { name: "clean", type: "boolean", default: true, description: "Remove existing screenshots" },
  ] as const);
  const projectId = args.project!;
  requireProject(projectId);
  if (args.every <= 0 || !Number.isInteger(args.max) || args.max < 1 || args.max > 10000)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--every must be positive; --max must be an integer from 1 to 10000.",
    });
  const project = loadProject(projectId);
  const format = args.format ?? project.formats[0];
  if (!format) throw new CliErrorObject({ code: "VALIDATION", message: "No output format configured." });
  ensureFfmpeg();
  ensureFfprobe();
  const videoPath = path.join("out", projectId, `${format}.mp4`);
  if (!existsSync(videoPath))
    throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `Video not found: ${videoPath}` });
  const duration = getVideoDuration(videoPath);
  const outDir = path.join("out", projectId, "qa-screenshots");
  assertPathWithin(path.resolve("out"), path.resolve(outDir));
  mkdirSync(outDir, { recursive: true });
  if (args.clean)
    for (const file of readdirSync(outDir).filter((f) => f.endsWith(".jpg"))) rmSync(path.join(outDir, file));
  const outputs: string[] = [];
  // Never seek to exact EOF: ffmpeg can return success without writing a frame.
  for (let index = 0; index < args.max && (args.overview || index * args.every < duration); index++) {
    const timestamp = args.overview
      ? args.max === 1
        ? 0
        : (index * Math.max(0, duration - 1 / 30)) / (args.max - 1)
      : index * args.every;
    const output = path.join(outDir, `${formatTimestamp(timestamp)}.jpg`);
    extractFrame(videoPath, timestamp, output);
    if (!existsSync(output))
      throw new CliErrorObject({ code: "FFMPEG_FAILED", message: `No frame written at ${timestamp}s` });
    outputs.push(output);
    emitProgress(`Saved ${output}`);
  }
  const count = outputs.length;
  const review = attachVideoReview(videoPath, outDir);
  const warnings =
    !args.overview && args.max * args.every < duration
      ? ["Interval screenshots cover only the beginning; use --overview for the complete duration."]
      : [];
  return {
    outputs: [...outputs, ...review.outputs],
    metadata: {
      projectId,
      format,
      durationSec: duration,
      count,
      warnings,
      reviewPack: review.reviewPack,
      reviewWarnings: review.reviewWarnings,
    },
  };
});
