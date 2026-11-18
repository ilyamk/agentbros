/**
 * Legacy fal.ai client, retained for existing projects and explicit old aliases.
 * New work uses pnpm fal:find, then pnpm generate:model with an endpoint-form
 * request ({ endpoint, input }); see docs/fal-catalogue.md.
 * Auth: FAL_KEY. Paid calls retain durable jobs and budget admission through
 * executeFalOperation; published results use local file URLs and pending jobs
 * carry resumable metadata.
 */

import { pathToFileURL } from "node:url";
import { executeFalOperation } from "../jobs/execution";
import { inspectAsset } from "../assets/inspect";
import { CliErrorObject } from "../cli";
import { PendingFalOperationError, localMediaDataUri, type FalGenerationContext } from "./fal-context";
export { PendingFalOperationError, localMediaDataUri };
export type { FalGenerationContext };
import path from "path";

// --- Types ---

export type FalImage = {
  url: string;
  width: number;
  height: number;
  content_type: string;
};

async function durable(
  endpoint: string,
  input: Record<string, unknown>,
  kind: "image",
  context?: FalGenerationContext,
  pricingModel = endpoint,
) {
  if (!context)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Paid fal helpers require generation context with projectId and output. Use CLI --dry-run for offline plans.",
    });
  const result = await executeFalOperation({ ...context, endpoint, model: pricingModel, input, mediaKind: kind });
  if (result.metadata.state !== "published") throw new PendingFalOperationError(result.metadata);
  return result.outputs;
}
function imageFiles(files: string[]): FalImage[] {
  return files.map((file) => {
    const { media, mime } = inspectAsset(file);
    return {
      url: pathToFileURL(path.resolve(file)).href,
      width: media.width!,
      height: media.height!,
      content_type: mime,
    };
  });
}
const imagePrice = (endpoint: string) =>
  (
    ({
      "fal-ai/flux/schnell": "fal:flux-schnell",
      "fal-ai/flux/dev": "fal:flux-dev",
      "fal-ai/flux-pro/v1.1": "fal:flux-pro",
      "fal-ai/flux-pro/v1.1-ultra": "fal:flux-pro-ultra",
      "fal-ai/flux/dev/image-to-image": "fal:flux-dev",
    }) as Record<string, string>
  )[endpoint] ?? endpoint;

// --- Image Generation ---

export type GenerateImageOptions = {
  generation?: FalGenerationContext;
  prompt: string;
  model?: string;
  imageSize?:
    | "square_hd"
    | "square"
    | "portrait_4_3"
    | "portrait_16_9"
    | "landscape_4_3"
    | "landscape_16_9"
    | { width: number; height: number };
  numImages?: number;
  numInferenceSteps?: number;
  guidanceScale?: number;
  seed?: number;
  outputFormat?: "jpeg" | "png";
  enableSafetyChecker?: boolean;
};

export async function generateImage(options: GenerateImageOptions): Promise<FalImage[]> {
  const {
    prompt,
    model = "fal-ai/flux/schnell",
    imageSize = "landscape_4_3",
    numImages = 1,
    numInferenceSteps,
    guidanceScale,
    seed,
    outputFormat = "jpeg",
    enableSafetyChecker = true,
  } = options;

  const input: Record<string, unknown> = {
    prompt,
    image_size: imageSize,
    num_images: numImages,
    output_format: outputFormat,
    enable_safety_checker: enableSafetyChecker,
  };

  if (numInferenceSteps !== undefined) input.num_inference_steps = numInferenceSteps;
  if (guidanceScale !== undefined) input.guidance_scale = guidanceScale;
  if (seed !== undefined) input.seed = seed;

  return imageFiles(
    await durable(
      model,
      input,
      "image",
      options.generation
        ? { ...options.generation, quoteInput: { ...options.generation.quoteInput, units: numImages } }
        : undefined,
      imagePrice(model),
    ),
  );
}

export async function removeBackground(imageUrl: string, generation?: FalGenerationContext): Promise<FalImage> {
  return imageFiles(
    await durable(
      "fal-ai/birefnet",
      { image_url: imageUrl },
      "image",
      generation ? { ...generation, quoteInput: { ...generation.quoteInput, units: 1 } } : undefined,
      "fal:birefnet-bgremoval",
    ),
  )[0]!;
}

// --- GPT-Image-2 ---
//
// Endpoints (verified 2026-04-30):
//   openai/gpt-image-2        — text-to-image
//   openai/gpt-image-2/edit   — edit / compose with reference images (+ optional mask)
//
// Size: preset enum, or custom { width, height } in multiples of 16, max edge
// 3840px, aspect ≤ 3:1, total pixels 655_360–8_294_400.
// Quality: low | medium | high (default: high).
// Edit endpoint accepts optional mask_url for partial / inpainting edits.

export type GptImage2SizePreset =
  "auto" | "square_hd" | "square" | "portrait_4_3" | "portrait_16_9" | "landscape_4_3" | "landscape_16_9";

export type GptImage2CustomSize = { width: number; height: number };
export type GptImage2Size = GptImage2SizePreset | GptImage2CustomSize;

export type GptImage2Quality = "low" | "medium" | "high";
export type GptImage2Format = "png" | "jpeg" | "webp";

export type GenerateImageGptImage2Options = {
  generation?: FalGenerationContext;
  prompt: string;
  imageSize?: GptImage2Size;
  numImages?: number;
  quality?: GptImage2Quality;
  outputFormat?: GptImage2Format;
};

/** Generate images via the legacy GPT-Image-2 endpoint. */
export async function generateImageGptImage2(options: GenerateImageGptImage2Options): Promise<FalImage[]> {
  const { prompt, imageSize, numImages, quality, outputFormat } = options;

  const input: Record<string, unknown> = { prompt };
  if (imageSize !== undefined) input["image_size"] = imageSize;
  if (numImages !== undefined) input["num_images"] = numImages;
  if (quality !== undefined) input["quality"] = quality;
  if (outputFormat !== undefined) input["output_format"] = outputFormat;

  return imageFiles(await durable("openai/gpt-image-2", input, "image", options.generation, "fal:gpt-image-2"));
}

/** Generate images via GPT-Image-2 and publish every requested result to disk. */
export async function generateAndSaveGptImage(
  prompt: string,
  outputPath: string,
  options: Omit<GenerateImageGptImage2Options, "prompt"> = {},
): Promise<void> {
  await generateImageGptImage2({ ...options, prompt, generation: { ...options.generation, output: outputPath } });
}
