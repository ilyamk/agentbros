#!/usr/bin/env tsx
/**
 * Optional lipsync utility — animates a still portrait OR a short video clip
 * to match a supplied audio track, producing a lip-synced output video.
 *
 * NOT used in the default talking-head pipeline. The default pipeline relies
 * on Seedance 2.0 fast with `--generate-audio` because:
 *   1. Native-audio generation has lipsync built in.
 *   2. Stand-alone lipsync models still produce noticeable artefacts and add
 *      a third generation step (cost + time) for marginal quality gain.
 *
 * Use this script ONLY when:
 *   • The creator explicitly wants ElevenLabs voice control over the
 *     presenter (specific voice, specific tone, multilingual quirks).
 *   • You have a real recorded presenter clip but no audio, and need to dub.
 *
 * Models:
 *   sync-1.9-studio  → fal-ai/sync-lipsync         (Sync Labs flagship)
 *   latentsync       → fal-ai/latentsync           (ByteDance, fastest)
 *
 * Usage:
 *   pnpm tsx --env-file=.env scripts/generate-lipsync.ts \
 *     --portrait public/projects/{id}/assets/images/presenter.png \
 *     --audio    public/projects/{id}/voiceover/full.mp3 \
 *     --output   public/projects/{id}/talking-head/full.mp4 \
 *     --model    sync-1.9-studio
 *
 * For a video presenter (idle clip) instead of a still:
 *     --video public/projects/{id}/talking-head/idle.mp4
 *
 * Requires --project for paid execution, and journals each operation before submit.
 * --dry-run is offline; invoke with the same operation ID to resume queued work.
 */

import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli";
import { localMediaDataUri } from "../src/lib/apis/fal-context";
import { inspectAsset } from "../src/lib/assets/inspect";
import { executeFalOperation, PAID_CLI_SPECS } from "../src/lib/jobs/execution";
import { statSync } from "node:fs";
import { prepareFalRoleExecution, requireVerifiedFalRoleEndpoint } from "../src/lib/providers/fal-plan-execution";
const SPECS = [
  ...PAID_CLI_SPECS,
  { name: "endpoint", description: "Verified lipsync endpoint; overrides --model using its pinned input schema" },
  {
    name: "portrait",
    description: "Path to a still portrait image (PNG/JPG). Mutually exclusive with --video.",
  },
  {
    name: "video",
    description: "Path to an idle presenter video. Mutually exclusive with --portrait.",
  },
  {
    name: "audio",
    required: true as const,
    description: "Path to the audio MP3/WAV that drives the lipsync.",
  },
  {
    name: "output",
    required: true as const,
    description: "Output MP4 path.",
  },
  {
    name: "model",
    choices: ["sync-1.9-studio", "latentsync"] as const,
    default: "sync-1.9-studio",
    description: "Lipsync model variant.",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Overwrite existing output.",
  },
  {
    name: "project",
    description: "Project ID for durable paid execution",
  },
  {
    name: "asset-id",
    description: "Asset id label for the cost ledger.",
  },
] as const;

const MODEL_ENDPOINTS: Record<string, string> = {
  "sync-1.9-studio": "fal-ai/sync-lipsync",
  latentsync: "fal-ai/latentsync",
};

runScript(async () => {
  const args = parseArgs(SPECS);
  if (!!args.portrait === !!args.video)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Choose exactly one of --portrait or --video." });
  if (args.endpoint !== undefined) {
    const entry = requireVerifiedFalRoleEndpoint(args.endpoint, "lipsync");
    const sourcePath = (args.portrait ?? args.video)!;
    const source = localMediaDataUri(sourcePath, args.video ? "video" : "image");
    const audio = localMediaDataUri(args.audio!, "audio");
    const { plan, options } = prepareFalRoleExecution(
      entry,
      { [args.video ? "video" : "image"]: source, audio },
      {
        media: {
          [source]: { ...inspectAsset(sourcePath).media, bytes: statSync(sourcePath).size },
          [audio]: { ...inspectAsset(args.audio!).media, bytes: statSync(args.audio!).size },
        },
      },
    );
    const result = await executeFalOperation({
      ...options,
      projectId: args.project,
      output: args.output!,
      stage: "talking-head",
      assetId: args["asset-id"],
      operationId: args["operation-id"],
      maxCostUsd: args["max-cost-usd"],
      dryRun: args["dry-run"],
      force: args.force,
    });
    return {
      ...result,
      metadata: {
        ...result.metadata,
        plan,
        mediaKind: options.mediaKind,
        queuePath: options.queuePath,
        quoteInput: options.quoteInput,
      },
    };
  }
  if (args.model === "latentsync" && !args.video)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "LatentSync requires a video, not a portrait." });
  const source = localMediaDataUri((args.portrait ?? args.video)!, args.video ? "video" : "image");
  const audio = localMediaDataUri(args.audio!, "audio");
  const duration = inspectAsset(args.audio!).media.durationSec;
  const endpoint = MODEL_ENDPOINTS[args.model!]!;
  const input = {
    ...(args.video ? { video_url: source } : { image_url: source }),
    audio_url: audio,
    ...(args.model === "sync-1.9-studio" ? { model: "lipsync-1.9.0-beta" } : {}),
  };
  return executeFalOperation({
    projectId: args.project,
    endpoint,
    model: args.model === "latentsync" ? endpoint : "fal:sync-lipsync",
    input,
    output: args.output!,
    mediaKind: "video",
    stage: "talking-head",
    assetId: args["asset-id"],
    operationId: args["operation-id"],
    maxCostUsd: args["max-cost-usd"],
    dryRun: args["dry-run"],
    force: args.force,
    quoteInput: { units: duration ?? null },
  });
});
