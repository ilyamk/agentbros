import { analyzeAudio } from "../src/lib/audio/analysis.js";
import { inspectEditorialProject } from "../src/lib/editorial/qa.js";
/**
 * Validate a rendered MP4 and produce a structured JSON report for the QA reviewer.
 *
 * Runs ffprobe + ffmpeg in sequence to gather:
 *   - Duration, resolution, FPS, codec, file size
 *   - Audio presence, peak dB, RMS dB (via volumedetect filter)
 *   - Extracted frame screenshots at regular intervals
 *   - Health-check findings (warnings only — never fail the run)
 *
 * Usage (project mode — resolves MP4 path automatically):
 *   pnpm tsx --env-file=.env scripts/validate-render.ts \
 *     --project <id> [--format landscape|vertical|square] \
 *     [--every 2] [--max 30] [--no-clean]
 *
 * Usage (direct input mode):
 *   pnpm tsx scripts/validate-render.ts \
 *     --input out/my-project/landscape.mp4 [--out-dir DIR] \
 *     [--every 2] [--max 30] [--no-clean]
 *
 * Options:
 *   --project    Project ID (mutually exclusive with --input)
 *   --format     Video format: landscape | vertical | square  [default: first in project.formats]
 *   --input      Absolute or relative path to an MP4 file (mutually exclusive with --project)
 *   --out-dir    Screenshot output directory (--input mode only; default: {input-stem}-qa-screenshots)
 *   --every      Interval between frame extracts in seconds  [default: 2]
 *   --max        Maximum number of screenshots to extract    [default: 30]
 *   --no-clean   Keep existing JPEGs in the output directory before extraction
 *
 * Requires: ffmpeg + ffprobe  (brew install ffmpeg)
 */

import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  runScript,
  parseArgs,
  emitProgress,
  ensureFfmpeg,
  ensureFfprobe,
  requireFile,
  requireProject,
  relativisePath,
  CliErrorObject,
} from "../src/lib/cli/index.js";
import { loadProject } from "../src/lib/project.js";

// ---------------------------------------------------------------------------
// Arg specs
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "timeline",
    type: "boolean",
    description: "Validate edited timeline duration/source ownership in project mode",
  },
  {
    name: "strict",
    type: "boolean",
    description: "Fail on blocking technical/editorial findings",
  },
  {
    name: "expect-audio",
    type: "boolean",
    description: "Require an audible audio stream in direct input mode",
  },
  {
    name: "project",
    short: "p",
    type: "string",
    description: "Project ID (mutually exclusive with --input)",
  },
  {
    name: "format",
    short: "f",
    type: "string",
    description: "Video format: landscape | vertical | square",
    choices: ["landscape", "vertical", "square"] as const,
  },
  {
    name: "input",
    short: "i",
    type: "string",
    description: "Direct path to an MP4 file (mutually exclusive with --project)",
  },
  {
    name: "out-dir",
    type: "string",
    description: "Screenshot output directory (--input mode only)",
  },
  {
    name: "every",
    type: "number",
    description: "Seconds between frame extracts",
    default: 2,
  },
  {
    name: "max",
    type: "number",
    description: "Maximum number of screenshots",
    default: 30,
  },
  {
    name: "no-clean",
    type: "boolean",
    description: "Keep existing JPEGs before extraction",
  },
] as const;

// ---------------------------------------------------------------------------
// Expected resolutions for health checks
// ---------------------------------------------------------------------------

const EXPECTED_RES: Record<string, { width: number; height: number }> = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
};

// ---------------------------------------------------------------------------
// ffprobe — full metadata
// ---------------------------------------------------------------------------

interface VideoMeta {
  width: number;
  height: number;
  fps: number;
  codec: string;
  container: string;
  sizeBytes: number;
  durationSec: number;
  frames: number;
  audio: {
    present: boolean;
    sampleRate: number | null;
    channels: number | null;
    bitRate: number | null;
  };
}

function probeMeta(inputPath: string): VideoMeta {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", inputPath],
    { encoding: "utf-8" },
  );

  if (result.error || result.status !== 0) {
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `ffprobe failed: ${(result.stderr ?? result.error?.message ?? "unknown").slice(0, 200)}`,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new CliErrorObject({
      code: "INTERNAL",
      message: `ffprobe returned unparseable JSON: ${result.stdout.slice(0, 120)}`,
    });
  }

  const streams: unknown[] = parsed.streams ?? [];
  const fmt = parsed.format ?? {};

  const videoStream = streams.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.codec_type === "video",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any | undefined;

  const audioStream = streams.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (s: any) => s.codec_type === "audio",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any | undefined;

  if (!videoStream) {
    throw new CliErrorObject({
      code: "INTERNAL",
      message: "ffprobe found no video stream — file may be corrupt or not a video.",
    });
  }

  // Parse frame rate: "30/1", "60000/1001", etc.
  const fpsFrac: string = videoStream.r_frame_rate ?? "30/1";
  const [num, den] = fpsFrac.split("/").map(Number);
  const fps = den && den !== 0 ? num / den : 30;

  const durationSec = parseFloat(fmt.duration ?? videoStream.duration ?? "0");
  const sizeBytes = parseInt(fmt.size ?? "0", 10);

  // nb_frames is often "N/A" — compute from duration if needed
  const rawFrames = parseInt(videoStream.nb_frames ?? "", 10);
  const frames = Number.isFinite(rawFrames) && rawFrames > 0 ? rawFrames : Math.round(durationSec * fps);

  const audioPresent = audioStream !== undefined;

  return {
    width: videoStream.width,
    height: videoStream.height,
    fps: Math.round(fps * 100) / 100,
    codec: videoStream.codec_name ?? "unknown",
    container: (fmt.format_name ?? "").split(",")[0] ?? "unknown",
    sizeBytes,
    durationSec,
    frames,
    audio: {
      present: audioPresent,
      sampleRate: audioPresent ? parseInt(audioStream.sample_rate, 10) || null : null,
      channels: audioPresent ? (audioStream.channels ?? null) : null,
      bitRate: audioPresent ? parseInt(audioStream.bit_rate ?? "", 10) || null : null,
    },
  };
}

// ---------------------------------------------------------------------------
// ffmpeg volumedetect — audio peak and RMS
// ---------------------------------------------------------------------------

interface AudioLevels {
  meanVolumeDb: number | null;
  maxVolumeDb: number | null;
}

function measureAudio(inputPath: string): AudioLevels {
  // volumedetect writes its report to stderr
  const result = spawnSync("ffmpeg", ["-i", inputPath, "-af", "volumedetect", "-vn", "-f", "null", "-"], {
    encoding: "utf-8",
  });

  // ffmpeg exits non-zero for this command on some platforms/containers — that
  // is fine; we only care about the presence of the output lines.
  const output = result.stderr ?? "";

  const meanMatch = /mean_volume:\s*([-\d.]+)\s*dB/i.exec(output);
  const maxMatch = /max_volume:\s*([-\d.]+)\s*dB/i.exec(output);

  return {
    meanVolumeDb: meanMatch ? parseFloat(meanMatch[1]) : null,
    maxVolumeDb: maxMatch ? parseFloat(maxMatch[1]) : null,
  };
}

// ---------------------------------------------------------------------------
// Frame extraction
// ---------------------------------------------------------------------------

/** Zero-padded sortable filename: 000012.50.jpg */
function formatTs(seconds: number): string {
  const intPart = Math.floor(seconds).toString().padStart(6, "0");
  const fracPart = (seconds % 1).toFixed(2).slice(1); // ".xx"
  return `${intPart}${fracPart}`;
}

interface Screenshot {
  atSec: number;
  path: string;
}

function extractFrames(
  inputPath: string,
  outDir: string,
  durationSec: number,
  every: number,
  max: number,
  clean: boolean,
): Screenshot[] {
  mkdirSync(outDir, { recursive: true });

  if (clean && existsSync(outDir)) {
    const existing = readdirSync(outDir).filter((f) => f.endsWith(".jpg"));
    if (existing.length > 0) {
      for (const f of existing) rmSync(path.join(outDir, f));
      emitProgress(`Cleared ${existing.length} existing screenshot(s).`);
    }
  }

  const timestamps: number[] = [];
  for (let t = 0; t <= durationSec; t += every) {
    timestamps.push(Math.min(t, Math.max(0, durationSec - 1 / 30)));
    if (timestamps.length >= max) break;
  }

  emitProgress(`Extracting ${timestamps.length} frame(s) every ${every}s (max ${max})…`);

  const screenshots: Screenshot[] = [];

  for (const ts of timestamps) {
    const filename = `${formatTs(ts)}.jpg`;
    const outputPath = path.join(outDir, filename);

    const result = spawnSync(
      "ffmpeg",
      ["-y", "-ss", String(ts), "-i", inputPath, "-frames:v", "1", "-q:v", "2", outputPath],
      { encoding: "utf-8" },
    );

    if (result.error || result.status !== 0) {
      throw new CliErrorObject({
        code: "INTERNAL",
        message: `Frame extraction failed at ${ts}s: ${(result.stderr ?? result.error?.message ?? "").slice(0, 200)}`,
      });
    }

    screenshots.push({
      atSec: ts,
      path: relativisePath(path.resolve(outputPath)),
    });
  }

  return screenshots;
}

// ---------------------------------------------------------------------------
// Health checks
// ---------------------------------------------------------------------------

interface Finding {
  severity: "warning" | "error";
  message: string;
}

function healthCheck(meta: VideoMeta, levels: AudioLevels, format: string | undefined): Finding[] {
  const findings: Finding[] = [];

  if (meta.durationSec < 5) {
    findings.push({
      severity: "warning",
      message: "Very short render — duration under 5 seconds.",
    });
  }
  if (meta.durationSec > 90) {
    findings.push({
      severity: "warning",
      message: "Render exceeds typical 90-second budget.",
    });
  }
  if (meta.sizeBytes < 100_000) {
    findings.push({
      severity: "warning",
      message: "Unusually small file (< 100 KB) — render may have failed or produced a silent/blank video.",
    });
  }

  if (meta.audio.present) {
    if (levels.meanVolumeDb !== null && levels.meanVolumeDb < -40) {
      findings.push({
        severity: "warning",
        message: `Audio extremely quiet (mean ${levels.meanVolumeDb} dB) — voiceover or music may be missing.`,
      });
    }
    if (levels.maxVolumeDb !== null && levels.maxVolumeDb > -1) {
      findings.push({
        severity: "warning",
        message: `Audio clipping risk — peak volume ${levels.maxVolumeDb} dB is near 0 dBFS.`,
      });
    }
  }

  if (format !== undefined && format in EXPECTED_RES) {
    const expected = EXPECTED_RES[format];
    if (meta.width !== expected.width || meta.height !== expected.height) {
      findings.push({
        severity: "error",
        message: `Unexpected resolution ${meta.width}×${meta.height} for format "${format}" (expected ${expected.width}×${expected.height}).`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

void runScript(async () => {
  const args = parseArgs(SPECS);

  const hasProject = Boolean(args.project);
  const hasInput = Boolean(args.input);

  if (hasProject === hasInput) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: hasProject
        ? "Provide either --project or --input, not both."
        : "Provide either --project <id> or --input <path>.",
    });
  }

  const every = (args.every as number) > 0 ? (args.every as number) : 2;
  const max = (args.max as number) > 0 ? Math.round(args.max as number) : 30;
  const clean = !(args["no-clean"] as boolean);

  ensureFfmpeg();
  ensureFfprobe();

  let inputPath: string;
  let outDir: string;
  let format: string | undefined;

  if (hasProject) {
    const projectId = args.project as string;
    requireProject(projectId);

    const project = loadProject(projectId);

    const formatArg = args.format as string | undefined;
    format = formatArg ?? project.formats[0];

    if (!format || !["landscape", "vertical", "square"].includes(format)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Cannot determine format. Pass --format landscape|vertical|square or set project.formats.`,
      });
    }

    inputPath = path.resolve(path.join("out", projectId, `${format}.mp4`));
    outDir = path.resolve(path.join("out", projectId, "qa-screenshots"));
  } else {
    inputPath = path.resolve(args.input as string);

    if (args["out-dir"]) {
      outDir = path.resolve(args["out-dir"] as string);
    } else {
      // Strip extension and suffix "-qa-screenshots"
      const stem = inputPath.replace(/\.mp4$/i, "");
      outDir = `${stem}-qa-screenshots`;
    }

    format = args.format as string | undefined;
  }

  requireFile(inputPath);

  // Step 1 — technical metadata
  emitProgress("Running ffprobe…");
  const meta = probeMeta(inputPath);
  emitProgress(
    `ffprobe → ${meta.durationSec.toFixed(2)}s, ${meta.width}×${meta.height}, ${meta.fps}fps, ${meta.codec}`,
  );

  // Step 2 — audio analysis (only when audio stream present)
  let levels: AudioLevels = { meanVolumeDb: null, maxVolumeDb: null };
  if (meta.audio.present) {
    emitProgress("Running audio analysis (volumedetect)…");
    levels = measureAudio(inputPath);
    emitProgress(`Audio analysis: mean ${levels.meanVolumeDb ?? "n/a"} dB, max ${levels.maxVolumeDb ?? "n/a"} dB`);
  } else {
    emitProgress("No audio stream — skipping volumedetect.");
  }

  // Step 3 — frame extraction
  const screenshots = extractFrames(inputPath, outDir, meta.durationSec, every, max, clean);
  emitProgress(`Extracted ${screenshots.length} screenshot(s) → ${relativisePath(outDir)}`);

  // Step 4 — health checks
  const findings = healthCheck(meta, levels, format);
  const audioAnalysis = analyzeAudio(inputPath);
  if (args["expect-audio"] && (!audioAnalysis.present || audioAnalysis.integratedLufs === null))
    findings.push({
      severity: "error",
      message: "Required audio stream is missing or silent",
    });
  if (audioAnalysis.truePeakDb !== null && audioAnalysis.truePeakDb > -0.5)
    findings.push({
      severity: "error",
      message: `True peak ${audioAnalysis.truePeakDb} dBTP exceeds -0.5 dBTP`,
    });
  const editorial = hasProject
    ? inspectEditorialProject(String(args.project), {
        renderFile: inputPath,
        editedTimeline: args.timeline === true,
        format: format as "vertical" | "square" | "landscape",
      })
    : undefined;
  if (editorial) findings.push(...editorial.findings);
  if (findings.length > 0) {
    emitProgress(`Health checks: ${findings.length} warning(s).`);
    for (const f of findings) emitProgress(`  [warning] ${f.message}`);
  } else {
    emitProgress("Health checks: all clear.");
  }

  // File size from filesystem (ffprobe may report container estimate)
  const actualSize = statSync(inputPath).size;

  const reportPath = path.join(outDir, "validation-report.json");
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        status: findings.some((f) => f.severity === "error") ? "failed" : "passed",
        meta,
        levels,
        audioAnalysis,
        editorial,
        findings,
        screenshots,
      },
      null,
      2,
    ) + "\n",
  );
  if (args.strict && findings.some((f) => f.severity === "error"))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Render QA failed with blocking findings",
      details: { report: relativisePath(reportPath), findings },
    });
  return {
    outputs: [relativisePath(reportPath), ...screenshots.map((s) => s.path)],
    metadata: {
      input: relativisePath(inputPath),
      format: {
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        container: meta.container,
        codec: meta.codec,
        sizeBytes: actualSize,
      },
      duration: {
        seconds: meta.durationSec,
        frames: meta.frames,
      },
      audio: {
        present: meta.audio.present,
        sampleRate: meta.audio.sampleRate,
        channels: meta.audio.channels,
        meanVolumeDb: levels.meanVolumeDb,
        maxVolumeDb: levels.maxVolumeDb,
      },
      analysis: audioAnalysis,
      qaStatus: findings.some((f) => f.severity === "error") ? "failed" : "passed",
      reportPath: relativisePath(reportPath),
      screenshots: screenshots.map((s) => ({ atSec: s.atSec, path: s.path })),
      findings,
    },
  };
});
