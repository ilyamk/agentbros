import { executeFalOperation, PAID_CLI_SPECS } from "../src/lib/jobs/execution";
/**
 * Unified AI video generation via fal.ai.
 *
 * Models (verified 2026-04-30 against fal.ai API docs):
 *
 *   kling-2.5-turbo  — fal-ai/kling-video/v2.5-turbo/pro/text-to-video
 *                       Duration: 5 or 10 s (string enum "5"/"10")
 *                       Aspect:   16:9 | 9:16 | 1:1
 *                       Pricing:  $0.07/s → 5 s = $0.35, 10 s = $0.70
 *
 *   seedance-1-pro   — fal-ai/bytedance/seedance/v1/pro/text-to-video
 *                       Duration: 2–12 s (integer)
 *                       Aspect:   21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16
 *                       Pricing:  NOT disclosed on fal.ai as of fetch date
 *
 *   seedance-2-fast  — fal-ai/bytedance/seedance-2.0/fast/text-to-video
 *                       Duration: "auto" | 4–15 s (integer)
 *                       Aspect:   "auto" | 21:9 | 16:9 | 4:3 | 1:1 | 3:4 | 9:16
 *                       Resolution: 480p | 720p (default 720p)
 *                       Pricing:  NOT disclosed on fal.ai as of fetch date
 *                       Variants: image-to-video (image_url + optional end_image_url),
 *                                 reference-to-video (image_urls[] up to 9, video_urls[] up to 3,
 *                                 referenced inside prompt as @Image1…@Image9 / @Video1…)
 *
 *   hailuo-02-pro    — fal-ai/minimax/hailuo-02/pro/text-to-video
 *                       Duration: 6 or 10 s (integer)
 *                       Aspect:   NOT a supported parameter for this model
 *                       Pricing:  $0.08/s → 6 s = $0.48, 10 s = $0.80
 *
 * Endpoint variant selection:
 *   - --reference-images / --reference-videos / --reference-audios → r2v (Seedance 2.0 only)
 *   - --reference-image (single) → i2v
 *   - otherwise → t2v
 *
 * Example:
 *   pnpm tsx --env-file=.env scripts/generate-video.ts \
 *     --prompt "@Image1 walks through a neon-lit market, cinematic" \
 *     --output public/projects/X/assets/videos/hero.mp4 \
 *     --model seedance-2-fast --duration 8 --aspect 9:16 \
 *     --reference-images "https://.../char.png,https://.../prop.png"
 */

import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli/index.js";

import { estimate } from "../src/lib/pricing";
import { findCatalogEntry } from "../src/lib/models/fal-catalog";

// ---------------------------------------------------------------------------
// Model registry
// ---------------------------------------------------------------------------

type ModelKey = "kling-2.5-turbo" | "seedance-1-pro" | "seedance-2-fast" | "hailuo-02-pro";

interface ModelEntry {
  t2vId: string;
  i2vId: string;
  /** Reference-to-video endpoint (multi-image / multi-video). null if unsupported. */
  r2vId: string | null;
  /** Allowed integer durations. Empty array = any integer accepted (validated by fal). */
  validDurations: number[];
  /** Whether "auto" is an accepted duration value. */
  allowAutoDuration: boolean;
  /** Allowed aspect ratios. null = model does not accept aspect_ratio. */
  validAspects: string[] | null;
  /** Default integer duration (used when --duration is omitted and auto is unsupported). */
  defaultDuration: number;
  /** Default duration sentinel ("auto" or numeric). */
  defaultDurationLiteral: string | number;
  /** Kling expects "5" not 5; Seedance 2.0 expects "auto"|integer. */
  durationIsString: boolean;
  /** Allowed resolutions (Seedance 2.0). null = parameter unsupported. */
  validResolutions: string[] | null;
  defaultResolution: string | null;
  /** Whether the model accepts generate_audio. */
  supportsGenerateAudio: boolean;
}

const MODEL_REGISTRY: Record<ModelKey, ModelEntry> = {
  "kling-2.5-turbo": {
    t2vId: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    i2vId: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    r2vId: null,
    validDurations: [5, 10],
    allowAutoDuration: false,
    validAspects: ["16:9", "9:16", "1:1"],
    defaultDuration: 5,
    defaultDurationLiteral: 5,
    durationIsString: true,
    validResolutions: null,
    defaultResolution: null,
    supportsGenerateAudio: false,
  },
  "seedance-1-pro": {
    t2vId: "fal-ai/bytedance/seedance/v1/pro/text-to-video",
    i2vId: "fal-ai/bytedance/seedance/v1/pro/image-to-video",
    r2vId: null,
    validDurations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    allowAutoDuration: false,
    validAspects: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    defaultDuration: 5,
    defaultDurationLiteral: 5,
    durationIsString: false,
    validResolutions: null,
    defaultResolution: null,
    supportsGenerateAudio: false,
  },
  "seedance-2-fast": {
    // NOTE: Seedance 2.0 endpoints do NOT carry the `fal-ai/` prefix —
    // their fal-client slug is `bytedance/seedance-2.0/...`. Adding the
    // prefix yields a 404. Confirmed against fal.ai docs (April 2026).
    t2vId: "bytedance/seedance-2.0/fast/text-to-video",
    i2vId: "bytedance/seedance-2.0/fast/image-to-video",
    r2vId: "bytedance/seedance-2.0/fast/reference-to-video",
    validDurations: [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
    allowAutoDuration: true,
    validAspects: ["auto", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    defaultDuration: 5,
    defaultDurationLiteral: "auto",
    durationIsString: false, // numbers go as integers, "auto" goes as string — handled per-call
    validResolutions: ["480p", "720p"],
    defaultResolution: "720p",
    supportsGenerateAudio: true,
  },
  "hailuo-02-pro": {
    t2vId: "fal-ai/minimax/hailuo-02/pro/text-to-video",
    i2vId: "fal-ai/minimax/hailuo-02/pro/image-to-video",
    r2vId: null,
    validDurations: [6, 10],
    allowAutoDuration: false,
    validAspects: null,
    defaultDuration: 6,
    defaultDurationLiteral: 6,
    durationIsString: false,
    validResolutions: null,
    defaultResolution: null,
    supportsGenerateAudio: false,
  },
};

// ---------------------------------------------------------------------------
// Cost estimator
// ---------------------------------------------------------------------------

function estimateCost(key: ModelKey, durationSec: number | null): number | null {
  if (durationSec === null) return null;
  return estimate({ model: `fal:${key}`, units: durationSec }).estimatedUsd;
}

function formatCostHint(key: ModelKey, durationSec: number | null): string {
  const cost = estimateCost(key, durationSec);
  if (cost === null) return "(pricing not disclosed)";
  return `approx. $${cost.toFixed(2)}`;
}

/** Split a CSV string into a clean URL list, preserving order, dropping empties. */
function parseCsvList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Argument spec
// ---------------------------------------------------------------------------

const SPECS = [
  ...PAID_CLI_SPECS,
  {
    name: "prompt",
    required: true as const,
    description: "Video generation prompt",
  },
  {
    name: "output",
    required: true as const,
    description: "Destination path for the generated MP4",
  },
  {
    name: "model",
    default: "kling-2.5-turbo",
    choices: ["kling-2.5-turbo", "seedance-1-pro", "seedance-2-fast", "hailuo-02-pro"] as const,
    description: "Model alias to use",
  },
  {
    name: "duration",
    description:
      'Duration in seconds. Kling: 5|10. Seedance v1: 2-12. Seedance 2 fast: "auto" or 4-15. Hailuo: 6|10. Omit for model default.',
  },
  {
    name: "aspect",
    description:
      'Aspect ratio. Kling: 16:9|9:16|1:1. Seedance v1: 21:9|16:9|4:3|1:1|3:4|9:16. Seedance 2 fast adds "auto". Hailuo: unsupported. Omit for model default.',
  },
  {
    name: "resolution",
    description: "Resolution (Seedance 2 fast only): 480p | 720p. Default 720p.",
  },
  {
    name: "reference-image",
    description: "URL of single reference image — activates image-to-video variant",
  },
  {
    name: "end-image-url",
    description: "Optional ending-frame URL for image-to-video transitions (Seedance 2 fast only)",
  },
  {
    name: "reference-images",
    description:
      "Comma-separated list of up to 9 reference image URLs — activates reference-to-video (Seedance 2 fast only). Reference each in --prompt as @Image1, @Image2, …",
  },
  {
    name: "reference-videos",
    description:
      "Comma-separated list of up to 3 reference video URLs (Seedance 2 fast r2v). Reference each in --prompt as @Video1, @Video2, @Video3.",
  },
  {
    name: "reference-audios",
    description:
      "Comma-separated list of up to 3 reference audio URLs (Seedance 2 fast r2v). Reference each in --prompt as @Audio1, @Audio2, @Audio3.",
  },
  {
    name: "generate-audio",
    type: "boolean" as const,
    default: true,
    description:
      "Generate synchronised audio (Seedance 2 fast only; matches model default true). Use --no-generate-audio to disable.",
  },
  {
    name: "negative-prompt",
    description: "Negative prompt (Kling only)",
  },
  {
    name: "seed",
    type: "number" as const,
    description: "Random seed (Seedance v1 / v2 only)",
  },
  {
    name: "force",
    type: "boolean" as const,
    default: false,
    description: "Overwrite an existing output file",
  },
  {
    name: "project",
    description:
      "Optional project ID — when set, an entry is appended to public/projects/{id}/pipeline/cost-ledger.jsonl",
  },
  {
    name: "stage",
    description: "Pipeline stage label for the cost-ledger entry",
  },
  {
    name: "asset-id",
    description: "Asset id from asset-plan.json — recorded in the cost ledger",
  },
] as const;

// ---------------------------------------------------------------------------
// Per-model validation
// ---------------------------------------------------------------------------

interface ResolvedArgs {
  duration: string | number; // numeric or "auto"
  aspect: string | null; // null = parameter must not be sent
  resolution: string | null;
  generateAudio: boolean | null;
  referenceImages: string[];
  referenceVideos: string[];
  referenceAudios: string[];
  referenceImage: string | undefined;
  endImageUrl: string | undefined;
  variant: "t2v" | "i2v" | "r2v";
}

function resolveAndValidate(
  key: ModelKey,
  rawDuration: string | undefined,
  rawAspect: string | undefined,
  rawResolution: string | undefined,
  generateAudio: boolean,
  generateAudioExplicit: boolean,
  referenceImage: string | undefined,
  endImageUrl: string | undefined,
  referenceImages: string[],
  referenceVideos: string[],
  referenceAudios: string[],
): ResolvedArgs {
  const reg = MODEL_REGISTRY[key];

  // ── Variant routing ─────────────────────────────────────────────────────
  let variant: "t2v" | "i2v" | "r2v" = "t2v";
  if (referenceImages.length > 0 || referenceVideos.length > 0 || referenceAudios.length > 0) {
    if (!reg.r2vId) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${key} does not support reference-to-video. Drop --reference-images / --reference-videos / --reference-audios, or switch to seedance-2-fast.`,
      });
    }
    variant = "r2v";
    if (referenceImages.length > 9) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--reference-images accepts at most 9 URLs (got ${referenceImages.length}).`,
      });
    }
    if (referenceVideos.length > 3) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--reference-videos accepts at most 3 URLs (got ${referenceVideos.length}).`,
      });
    }
    if (referenceAudios.length > 3) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--reference-audios accepts at most 3 URLs (got ${referenceAudios.length}).`,
      });
    }
    if (referenceImage) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--reference-image (single) and --reference-images (multi) are mutually exclusive. Pick one.`,
      });
    }
    if (endImageUrl) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--end-image-url is only valid for image-to-video. Drop it when using --reference-images.`,
      });
    }
  } else if (referenceImage) {
    variant = "i2v";
    if (endImageUrl && key !== "seedance-2-fast") {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--end-image-url is only supported by seedance-2-fast.`,
      });
    }
  } else {
    if (endImageUrl) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `--end-image-url requires --reference-image (image-to-video variant).`,
      });
    }
  }

  // ── Duration ────────────────────────────────────────────────────────────
  let duration: string | number;
  if (rawDuration === undefined || rawDuration === "") {
    duration = reg.defaultDurationLiteral;
  } else if (rawDuration === "auto") {
    if (!reg.allowAutoDuration) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${key} does not accept "auto" duration. Allowed: ${reg.validDurations.join(", ")}`,
      });
    }
    duration = "auto";
  } else {
    const n = Number(rawDuration);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Invalid --duration "${rawDuration}". Pass an integer or "auto" (where supported).`,
      });
    }
    if (!reg.validDurations.includes(n)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Invalid --duration ${n} for ${key}. Allowed: ${reg.validDurations.join(", ")}${reg.allowAutoDuration ? ' or "auto"' : ""}`,
      });
    }
    duration = n;
  }

  // ── Aspect ──────────────────────────────────────────────────────────────
  let aspect: string | null;
  if (reg.validAspects === null) {
    if (rawAspect !== undefined && rawAspect !== "") {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${key} does not accept an aspect_ratio parameter. Drop --aspect.`,
      });
    }
    aspect = null;
  } else {
    const a = rawAspect && rawAspect !== "" ? rawAspect : reg.allowAutoDuration ? "auto" : "16:9";
    if (!reg.validAspects.includes(a)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Invalid --aspect "${a}" for ${key}. Allowed: ${reg.validAspects.join(", ")}`,
      });
    }
    aspect = a;
  }

  // ── Resolution ──────────────────────────────────────────────────────────
  let resolution: string | null;
  if (reg.validResolutions === null) {
    if (rawResolution !== undefined && rawResolution !== "") {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${key} does not accept --resolution. Drop it.`,
      });
    }
    resolution = null;
  } else {
    const r = rawResolution && rawResolution !== "" ? rawResolution : reg.defaultResolution!;
    if (!reg.validResolutions.includes(r)) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `Invalid --resolution "${r}" for ${key}. Allowed: ${reg.validResolutions.join(", ")}`,
      });
    }
    resolution = r;
  }

  // ── generate_audio ──────────────────────────────────────────────────────
  let generateAudioOut: boolean | null;
  if (reg.supportsGenerateAudio) {
    generateAudioOut = generateAudio;
  } else {
    if (generateAudioExplicit) {
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${key} does not accept --generate-audio. Drop the flag.`,
      });
    }
    generateAudioOut = null;
  }

  return {
    duration,
    aspect,
    resolution,
    generateAudio: generateAudioOut,
    referenceImages,
    referenceVideos,
    referenceAudios,
    referenceImage,
    endImageUrl,
    variant,
  };
}

// ---------------------------------------------------------------------------
// Build fal.ai input payload per model
// ---------------------------------------------------------------------------

function buildInput(
  key: ModelKey,
  prompt: string,
  resolved: ResolvedArgs,
  negativePhrasing: string | undefined,
  seed: number | undefined,
): Record<string, unknown> {
  const reg = MODEL_REGISTRY[key];

  // Coerce duration for kling (string enum) — Seedance 2 fast accepts integers
  // directly and "auto" as a literal string, so leave the resolved value alone.
  const durationVal: string | number =
    typeof resolved.duration === "number" && reg.durationIsString ? String(resolved.duration) : resolved.duration;

  const base: Record<string, unknown> = { prompt };

  switch (key) {
    case "kling-2.5-turbo":
      base["duration"] = durationVal;
      if (resolved.aspect) base["aspect_ratio"] = resolved.aspect;
      if (negativePhrasing) base["negative_prompt"] = negativePhrasing;
      base["cfg_scale"] = 0.5;
      if (resolved.referenceImage) base["image_url"] = resolved.referenceImage;
      break;

    case "seedance-1-pro":
      base["duration"] = durationVal;
      if (resolved.aspect) base["aspect_ratio"] = resolved.aspect;
      base["resolution"] = "1080p";
      if (seed !== undefined) base["seed"] = seed;
      if (resolved.referenceImage) base["image_url"] = resolved.referenceImage;
      break;

    case "seedance-2-fast":
      base["duration"] = durationVal;
      if (resolved.aspect) base["aspect_ratio"] = resolved.aspect;
      if (resolved.resolution) base["resolution"] = resolved.resolution;
      if (resolved.generateAudio !== null) base["generate_audio"] = resolved.generateAudio;
      if (seed !== undefined) base["seed"] = seed;
      if (resolved.variant === "i2v") {
        base["image_url"] = resolved.referenceImage;
        if (resolved.endImageUrl) base["end_image_url"] = resolved.endImageUrl;
      } else if (resolved.variant === "r2v") {
        if (resolved.referenceImages.length > 0) base["image_urls"] = resolved.referenceImages;
        if (resolved.referenceVideos.length > 0) base["video_urls"] = resolved.referenceVideos;
        if (resolved.referenceAudios.length > 0) base["audio_urls"] = resolved.referenceAudios;
      }
      break;

    case "hailuo-02-pro":
      base["duration"] = durationVal;
      base["resolution"] = "1080P";
      base["prompt_optimizer"] = true;
      if (resolved.referenceImage) base["image_url"] = resolved.referenceImage;
      break;
  }

  return base;
}

// ---------------------------------------------------------------------------
// ffprobe — verify file and extract actual duration
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  const args = parseArgs(SPECS);

  const modelKey = (args["model"] ?? "kling-2.5-turbo") as ModelKey;
  const reg = MODEL_REGISTRY[modelKey];

  const rawDuration = args["duration"] as string | number | undefined;
  const rawAspect = args["aspect"] as string | undefined;
  const rawResolution = args["resolution"] as string | undefined;
  const referenceImage = args["reference-image"] as string | undefined;
  const endImageUrl = args["end-image-url"] as string | undefined;
  const referenceImages = parseCsvList(args["reference-images"] as string | undefined);
  const referenceVideos = parseCsvList(args["reference-videos"] as string | undefined);
  const referenceAudios = parseCsvList(args["reference-audios"] as string | undefined);
  const generateAudio = args["generate-audio"] as boolean;
  // Treat as "explicit" only when user disabled it; the default true matches fal default.
  const generateAudioExplicit = process.argv.some(
    (t) => t === "--generate-audio" || t === "--no-generate-audio" || t.startsWith("--generate-audio="),
  );
  const negativePhrasing = args["negative-prompt"] as string | undefined;
  const seed = args["seed"] as number | undefined;
  const outputPath = args["output"] as string;
  const force = args["force"] as boolean;

  const resolved = resolveAndValidate(
    modelKey,
    rawDuration === undefined ? undefined : String(rawDuration),
    rawAspect,
    rawResolution,
    generateAudio,
    generateAudioExplicit,
    referenceImage,
    endImageUrl,
    referenceImages,
    referenceVideos,
    referenceAudios,
  );

  const modelId = resolved.variant === "r2v" ? reg.r2vId! : resolved.variant === "i2v" ? reg.i2vId : reg.t2vId;

  const costHintSeconds = typeof resolved.duration === "number" ? resolved.duration : null;
  emitProgress(
    `Generating with ${modelKey} (${resolved.variant}, duration=${resolved.duration} ${formatCostHint(modelKey, costHintSeconds)})`,
  );
  emitProgress(`Model: ${modelId}`);

  const input = buildInput(modelKey, args["prompt"] as string, resolved, negativePhrasing, seed);

  const result = await executeFalOperation({
    projectId: args.project,
    endpoint: modelId,
    model: `fal:${modelKey}`,
    input,
    output: outputPath,
    mediaKind: "video",
    quoteInput: { units: costHintSeconds },
    stage: args.stage,
    assetId: args["asset-id"],
    operationId: args["operation-id"],
    maxCostUsd: args["max-cost-usd"],
    dryRun: args["dry-run"],
    force,
  });
  const entry = findCatalogEntry(modelId);
  if (entry?.retiresAt || entry?.status === "gone") {
    const status = entry.status === "gone" ? "is gone from the catalogue" : `retires at ${entry.retiresAt}`;
    const replacement = entry.replacement ? `Replacement: ${entry.replacement}.` : "No replacement is recorded.";
    result.metadata.warnings = [
      ...(Array.isArray(result.metadata.warnings) ? result.metadata.warnings : []),
      `${modelId} ${status}. ${replacement} Run pnpm fal:doctor.`,
    ];
  }
  return result;
});
