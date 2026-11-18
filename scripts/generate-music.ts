/**
 * Generate background music: ElevenLabs Music API directly (default), or a
 * music endpoint on fal (`--provider fal --model <endpoint>`) through durable
 * jobs with budget admission. Re-run the same arguments to resume a fal job.
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/generate-music.ts \
 *     --prompt "Upbeat lo-fi hip-hop, 30s" \
 *     --output public/projects/my-project/music/bg.mp3
 *
 *   pnpm tsx --env-file=.env scripts/generate-music.ts \
 *     --composition-plan scripts/plans/my-plan.json \
 *     --output public/projects/my-project/music/bg.mp3
 *
 * Options:
 *   --prompt              Text description of the music to generate (mutually exclusive with --composition-plan)
 *   --output              Output file path (required)
 *   --duration            Requested duration in seconds, 3–600 (default: 30; prompt mode only)
 *   --composition-plan    Path to a JSON file containing a CompositionPlan object
 *   --force               Overwrite the output file if it already exists
 *   --provider            elevenlabs (default) or fal
 *   --model               fal endpoint (see src/lib/providers/fal-music.ts)
 *   --instrumental, --seed, --negative-prompt, --dry-run   fal options
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  runScript,
  parseArgs,
  emitProgress,
  requireEnv,
  requireFile,
  withRetry,
  ensureFfprobe,
  relativisePath,
  CliErrorObject,
} from "../src/lib/cli/index.js";
import { generateMusic } from "../src/lib/elevenlabs-music.js";
import { runFalMusic } from "../src/lib/music/fal-generate.js";
import type { CompositionPlan } from "../src/lib/elevenlabs-music.js";

// ---------------------------------------------------------------------------
// Arg spec
// ---------------------------------------------------------------------------

const SPECS = [
  {
    name: "max-cost-usd",
    type: "number",
    description: "Explicit per-operation planning bound for unknown audio prices",
  },
  { name: "operation-id", description: "Stable paid operation ID (per-scene suffix where applicable)" },
  {
    name: "prompt",
    type: "string" as const,
    description: "Text description of the music (mutually exclusive with --composition-plan)",
  },
  {
    name: "output",
    type: "string" as const,
    required: true,
    description: "Output file path (e.g. public/projects/my-project/music/bg.mp3)",
  },
  {
    name: "duration",
    type: "number" as const,
    description: "Requested duration in seconds (prompt mode only). ElevenLabs direct: 3–600, default 30",
  },
  {
    name: "composition-plan",
    type: "string" as const,
    description: "Path to a JSON file containing a CompositionPlan object",
  },
  {
    name: "force",
    type: "boolean" as const,
    description: "Overwrite the output file if it already exists",
  },
  {
    name: "project",
    description:
      "Optional project ID — when set, an entry is appended to public/projects/{id}/pipeline/cost-ledger.jsonl",
  },
  {
    name: "asset-id",
    description: "Asset id from asset-plan.json — recorded in the cost ledger",
  },
  { name: "provider", default: "elevenlabs", description: "elevenlabs (direct API, default) or fal" },
  {
    name: "model",
    description: "fal music endpoint, e.g. fal-ai/elevenlabs/music, fal-ai/lyria2, fal-ai/minimax-music/v2.6",
  },
  { name: "instrumental", type: "boolean", description: "Ask for a vocal-free track (fal)" },
  { name: "seed", type: "number", description: "Seed where the fal model accepts one" },
  { name: "negative-prompt", description: "What to exclude, where the fal model accepts it" },
  {
    name: "dry-run",
    type: "boolean",
    description: "fal only: validate and quote offline, with no reservation, writes or API calls",
  },
] as const;

// ---------------------------------------------------------------------------
// ffprobe helper — inline since src/lib/audio is not in this worktree
// ---------------------------------------------------------------------------

function probeFileDuration(filePath: string): number | null {
  const result = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { encoding: "utf-8" },
  );

  if (result.error || result.status !== 0) {
    return null;
  }

  const value = parseFloat(result.stdout.trim());
  return isNaN(value) ? null : value;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);

  const provider = args.provider as string;
  if (provider !== "elevenlabs" && provider !== "fal") {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--provider must be elevenlabs or fal (got ${provider}).`,
    });
  }
  if (provider === "fal") {
    if (!args.model)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--provider fal needs --model <fal endpoint>." });
    return runFalMusic({
      endpoint: args.model,
      prompt: args.prompt,
      compositionPlanPath: args["composition-plan"],
      durationSec: args.duration,
      instrumental: args.instrumental === true,
      seed: args.seed,
      negativePrompt: args["negative-prompt"],
      output: args.output as string,
      projectId: args.project,
      assetId: args["asset-id"],
      operationId: args["operation-id"],
      maxCostUsd: args["max-cost-usd"],
      dryRun: args["dry-run"] === true,
      force: args.force === true,
    });
  }
  if (args.model || args.instrumental || args.seed !== undefined || args["negative-prompt"] || args["dry-run"]) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--model, --instrumental, --seed, --negative-prompt and --dry-run apply to --provider fal only.",
    });
  }

  const outputPath = path.resolve(args.output as string);
  const durationSec = (args.duration as number | undefined) ?? 30;
  const force = args.force as boolean;
  const promptArg = args.prompt as string | undefined;
  const planPath = args["composition-plan"] as string | undefined;

  // ── Validation ─────────────────────────────────────────────────────────

  if (!promptArg && !planPath) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "One of --prompt or --composition-plan is required.",
    });
  }

  if (promptArg && planPath) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--prompt and --composition-plan are mutually exclusive — use one or the other.",
    });
  }

  if (promptArg) {
    if (durationSec < 3 || durationSec > 600) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--duration must be between 3 and 600 seconds (got ${durationSec}).`,
      });
    }
  }

  if (existsSync(outputPath) && !force) {
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `Output file already exists: ${outputPath}. Pass --force to overwrite.`,
    });
  }

  requireEnv("ELEVENLABS_API_KEY");

  // ── Load composition plan if provided ──────────────────────────────────

  let compositionPlan: CompositionPlan | undefined;
  if (planPath) {
    requireFile(planPath);
    const raw: unknown = JSON.parse(readFileSync(planPath, "utf-8"));
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--composition-plan must be a JSON object, got ${Array.isArray(raw) ? "array" : typeof raw}.`,
      });
    }
    compositionPlan = raw as CompositionPlan;
  }

  const mode = promptArg ? "prompt" : "composition-plan";

  // ── Generate ────────────────────────────────────────────────────────────

  emitProgress(
    promptArg
      ? `Generating music: ${durationSec}s — "${promptArg}"…`
      : `Generating music from composition plan: ${planPath}…`,
  );

  let durableOperationId: string | undefined;
  const { sizeBytes } = await withRetry(
    () =>
      generateMusic({
        prompt: promptArg,
        compositionPlan,
        durationSec: promptArg ? durationSec : undefined,
        outputPath,
        paid: {
          projectId: args.project,
          onOperationId: (id: string) => (durableOperationId = id),
          operationId: args["operation-id"],
          assetId: args["asset-id"],
          maxCostUsd: args["max-cost-usd"],
        },
      }),
    { attempts: 3, backoffMs: 10_000, retryOn: ["RATE_LIMIT", "NETWORK"] },
  );

  // ── Measure actual duration ─────────────────────────────────────────────

  let measuredDurationSec: number | null = null;
  try {
    ensureFfprobe();
    measuredDurationSec = probeFileDuration(outputPath);
    if (measuredDurationSec === null) {
      process.stderr.write("[warn] ffprobe ran but returned no duration — metadata.measuredDurationSec will be null\n");
    }
  } catch {
    process.stderr.write(
      "[warn] ffprobe not available — install with: brew install ffmpeg. metadata.measuredDurationSec will be null\n",
    );
  }

  if (typeof args.project === "string" && args.project.length > 0) {
    try {
      const { logCost } = await import("../src/lib/cli/cost-log.js");
      const billedSeconds = measuredDurationSec ?? (promptArg ? durationSec : 0);
      logCost({
        projectId: args.project as string,
        stage: "assets",
        scriptId: "generate-music.ts",
        assetId: args["asset-id"] as string | undefined,
        service: "ElevenLabs",
        provider: "elevenlabs",
        ...(durableOperationId ? { operationId: durableOperationId } : {}),
        model: "elevenlabs:music" as never,
        units: billedSeconds,
        unitName: "second",
        notes: `mode=${mode} durationSec=${billedSeconds}`,
      });
    } catch {
      /* non-fatal */
    }
  }

  return {
    outputs: [relativisePath(outputPath)],
    metadata: {
      mode,
      requestedDurationSec: promptArg ? durationSec : null,
      measuredDurationSec,
      sizeBytes,
    },
  };
});
