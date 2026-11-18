import { executeFalOperation, PAID_CLI_SPECS } from "../src/lib/jobs/execution";
/**
 * Unified AI image generation via fal.ai.
 *
 * Models:
 *   gpt-image-2     — latest OpenAI image model (strong text rendering, coherent
 *                      photoreal compositions; pricing not disclosed by fal.ai).
 *                      Edit endpoint supports an optional `--mask-url` for
 *                      partial / inpainting edits.
 *   flux-schnell    — fast (~$0.003)
 *   flux-dev        — quality (~$0.025)
 *   flux-pro        — premium (~$0.04)
 *   flux-pro-ultra  — 4MP (~$0.06)
 *
 * Examples:
 *   pnpm tsx --env-file=.env scripts/generate-image.ts \
 *     --prompt "Modern cityscape" --output out/city.png --model flux-dev
 *
 *   pnpm tsx --env-file=.env scripts/generate-image.ts \
 *     --prompt "Tweet card with text 'AI now writes code'" \
 *     --output assets/memes/hook.png --model gpt-image-2 --quality high
 *
 *   pnpm tsx --env-file=.env scripts/generate-image.ts \
 *     --prompt "Replace the sky with neon aurora" \
 *     --output assets/edited.png --model gpt-image-2 \
 *     --reference-image https://example.com/photo.jpg \
 *     --mask-url https://example.com/mask.png --size landscape_16_9
 *
 * Output: JSON on stdout, progress on stderr.
 */

import { parseArgs, runScript, CliErrorObject } from "../src/lib/cli/index.js";
import type { GptImage2Size, GptImage2SizePreset } from "../src/lib/apis/fal.js";

// ---------------------------------------------------------------------------
// Argument spec
// ---------------------------------------------------------------------------

const SPECS = [
  ...PAID_CLI_SPECS,
  {
    name: "prompt",
    short: "p",
    required: true,
    description: "Image generation prompt",
  },
  {
    name: "output",
    short: "o",
    required: true,
    description: "Destination path for the generated image",
  },
  {
    name: "model",
    short: "m",
    default: "flux-schnell",
    choices: ["gpt-image-2", "flux-schnell", "flux-dev", "flux-pro", "flux-pro-ultra"] as const,
    description: "Model to use for generation",
  },
  {
    name: "size",
    description:
      "Image size. gpt-image-2 / FLUX: auto|square_hd|square|portrait_4_3|portrait_16_9|landscape_4_3|landscape_16_9. gpt-image-2 also accepts custom WxH (multiples of 16, e.g. 1280x720).",
  },
  {
    name: "quality",
    choices: ["low", "medium", "high"] as const,
    description: "Quality level (gpt-image-2 only): low | medium | high.",
  },
  {
    name: "format",
    default: "png",
    choices: ["png", "jpeg", "webp"] as const,
    description: "Output format",
  },
  {
    name: "reference-image",
    description:
      "Reference image URL for img2img / edit mode. For gpt-image-2, pass several refs via comma-separated --reference-images instead.",
  },
  {
    name: "reference-images",
    description:
      "Comma-separated list of reference image URLs (gpt-image-2 edit only — passed as image_urls). Mutually exclusive with --reference-image.",
  },
  {
    name: "mask-url",
    description: "Mask image URL for partial / inpainting edits (gpt-image-2 edit only).",
  },
  {
    name: "seed",
    type: "number" as const,
    description: "Random seed for reproducibility (FLUX only)",
  },
  {
    name: "num-images",
    type: "number" as const,
    default: 1,
    description: "Number of images to generate",
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
    description: "Pipeline stage label for the cost-ledger entry (e.g. 'assets', 'reshoot')",
  },
  {
    name: "asset-id",
    description: "Asset id from asset-plan.json — recorded in the cost ledger",
  },
] as const;

// ---------------------------------------------------------------------------
// Model → endpoint mapping
// ---------------------------------------------------------------------------

const FLUX_ENDPOINTS: Record<string, string> = {
  "flux-schnell": "fal-ai/flux/schnell",
  "flux-dev": "fal-ai/flux/dev",
  "flux-pro": "fal-ai/flux-pro/v1.1",
  "flux-pro-ultra": "fal-ai/flux-pro/v1.1-ultra",
};

// ---------------------------------------------------------------------------
// Cost table
// ---------------------------------------------------------------------------

const GPT2_SIZE_PRESETS: readonly GptImage2SizePreset[] = [
  "auto",
  "square_hd",
  "square",
  "portrait_4_3",
  "portrait_16_9",
  "landscape_4_3",
  "landscape_16_9",
];

/** Parse `--size` for gpt-image-2: preset name OR `WxH` (multiples of 16). */
function parseGpt2Size(raw: string | undefined): GptImage2Size {
  if (raw === undefined || raw === "") return "auto";
  if ((GPT2_SIZE_PRESETS as readonly string[]).includes(raw)) {
    return raw as GptImage2SizePreset;
  }
  const m = /^(\d+)x(\d+)$/i.exec(raw);
  if (!m) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `Invalid --size "${raw}" for gpt-image-2. Use a preset (${GPT2_SIZE_PRESETS.join("|")}) or WxH (e.g. 1280x720).`,
    });
  }
  const width = parseInt(m[1]!, 10);
  const height = parseInt(m[2]!, 10);
  if (width % 16 !== 0 || height % 16 !== 0) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `gpt-image-2 size dimensions must be multiples of 16 (got ${width}x${height}).`,
    });
  }
  if (width > 3840 || height > 3840) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `gpt-image-2 max edge is 3840px (got ${width}x${height}).`,
    });
  }
  const ratio = Math.max(width, height) / Math.min(width, height);
  if (ratio > 3) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `gpt-image-2 aspect ratio must be ≤ 3:1 (got ${width}x${height}).`,
    });
  }
  const totalPx = width * height;
  if (totalPx < 655_360 || totalPx > 8_294_400) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `gpt-image-2 total pixels must be 655,360–8,294,400 (got ${totalPx}).`,
    });
  }
  return { width, height };
}

// ---------------------------------------------------------------------------
// Durable execution follows validated argument parsing
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

runScript(async () => {
  // 1. Parse args
  const args = parseArgs(SPECS);

  const model = args.model ?? "flux-schnell";
  const isGpt2 = model === "gpt-image-2";
  const isFlux = !isGpt2;

  // 2. Cross-flag validation — must run before requireEnv
  if (isFlux && args.quality !== undefined) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--quality is only supported with gpt-image-2 (got --model ${model})`,
    });
  }

  if (isGpt2 && args.seed !== undefined) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--seed is only supported with FLUX models (not gpt-image-2)",
    });
  }

  const referenceImage = args["reference-image"] as string | undefined;
  const referenceImagesRaw = args["reference-images"] as string | undefined;
  const referenceImages = referenceImagesRaw
    ? referenceImagesRaw
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  const maskUrl = args["mask-url"] as string | undefined;

  if (referenceImage && referenceImages.length > 0) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--reference-image and --reference-images are mutually exclusive. Pick one.",
    });
  }
  if (referenceImages.length > 0 && !isGpt2) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "--reference-images is only supported by --model gpt-image-2. Use --reference-image (single) for other models.",
    });
  }
  if (maskUrl && !isGpt2) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--mask-url is only supported by --model gpt-image-2 (edit mode).",
    });
  }
  if (maskUrl && referenceImage === undefined && referenceImages.length === 0) {
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--mask-url requires --reference-image or --reference-images (edit mode).",
    });
  }

  const outputPath = args.output!;
  const numImages = args["num-images"];
  if (!Number.isInteger(numImages) || numImages < 1 || numImages > 10)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--num-images must be an integer from 1 to 10." });
  const refs = referenceImages.length ? referenceImages : referenceImage ? [referenceImage] : [];
  let endpoint: string;
  let input: Record<string, unknown>;
  if (isGpt2) {
    endpoint = refs.length ? "openai/gpt-image-2/edit" : "openai/gpt-image-2";
    input = {
      prompt: args.prompt!,
      image_size: parseGpt2Size(args.size),
      num_images: numImages,
      output_format: args.format!,
      quality: args.quality ?? "medium",
      ...(refs.length ? { image_urls: refs } : {}),
      ...(maskUrl ? { mask_url: maskUrl } : {}),
    };
  } else {
    endpoint = FLUX_ENDPOINTS[model]!;
    if (referenceImage) endpoint = "fal-ai/flux/dev/image-to-image";
    input = referenceImage
      ? { prompt: args.prompt!, image_url: referenceImage, strength: 0.75, num_images: numImages }
      : {
          prompt: args.prompt!,
          image_size: args.size ?? "square_hd",
          num_images: numImages,
          output_format: args.format!,
          ...(referenceImage ? { image_url: referenceImage } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
        };
  }
  return executeFalOperation({
    projectId: args.project,
    endpoint,
    model: referenceImage && !isGpt2 ? "fal:flux-dev" : `fal:${model}`,
    input,
    output: outputPath,
    mediaKind: "image",
    quoteInput: { units: numImages },
    stage: args.stage,
    assetId: args["asset-id"],
    operationId: args["operation-id"],
    maxCostUsd: args["max-cost-usd"],
    dryRun: args["dry-run"],
    force: args.force,
  });
});
