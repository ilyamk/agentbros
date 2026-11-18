/**
 * Generate AI images using fal.ai (FLUX models), or Pollinations only when asked for explicitly.
 *
 * Usage:
 *   tsx --env-file=.env scripts/generate-ai-image.ts --prompt "abstract purple gradient" --output public/images/bg.png
 *   tsx --env-file=.env scripts/generate-ai-image.ts --prompt "neon city" --size portrait_16_9 --output public/images/neon.png
 *   tsx --env-file=.env scripts/generate-ai-image.ts --prompt "product mockup" --model fal-ai/flux-pro/v1.1-ultra --output public/images/pro.png
 *   tsx scripts/generate-ai-image.ts --prompt "tech" --provider pollinations --output public/images/tech.png
 *
 * Options:
 *   --prompt     Image description (required)
 *   --output     Output file path (required)
 *   --model      fal.ai model ID (default: fal-ai/flux/schnell)
 *   --size       Image size preset or WxH (default: square_hd)
 *               Presets: square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9
 *               Custom: 1080x1920
 *   --steps      Inference steps (default: model default)
 *   --provider   "fal" (default) or "pollinations". Pollinations is a third-party
 *               service with an unclear licence: it is used only when named, never
 *               as a silent fallback for a missing FAL_KEY. Its download is bounded
 *               by a timeout and a byte cap, and --output must stay inside the
 *               working directory.
 */

import { writeFileSync, mkdirSync, existsSync } from "fs";
import path from "path";
import { executeFalOperation, PAID_CLI_SPECS } from "../src/lib/jobs/execution";
import { LEGACY_ENDPOINTS } from "../src/lib/models/registry";

import { parseArgs, runScript, emitProgress, CliErrorObject, assertPathWithin } from "../src/lib/cli";

const POLLINATIONS_TIMEOUT_MS = 60_000;
const POLLINATIONS_MAX_BYTES = 32 * 1024 * 1024;

function parseSize(size: string): string | { width: number; height: number } {
  if (size.includes("x")) {
    const [w, h] = size.split("x").map(Number);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0 || w > 8192 || h > 8192)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid image dimensions (1–8192 pixels)." });
    return { width: w!, height: h! };
  }
  if (!["square_hd", "square", "portrait_4_3", "portrait_16_9", "landscape_4_3", "landscape_16_9"].includes(size))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Unknown image size preset." });
  return size;
}

async function generateWithPollinations(prompt: string, width: number, height: number): Promise<Buffer> {
  emitProgress(`  Provider: Pollinations (free, no key)`);
  emitProgress(`  Size:     ${width}x${height}`);
  emitProgress(`  Note:     prototyping only — unclear commercial license`);
  emitProgress(`  Generating...`);

  const params = new URLSearchParams({ width: String(width), height: String(height) });
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(POLLINATIONS_TIMEOUT_MS) });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
      throw new CliErrorObject({
        code: "TIMEOUT",
        message: `Pollinations did not answer within ${POLLINATIONS_TIMEOUT_MS / 1000} s.`,
      });
    throw new CliErrorObject({
      code: "NETWORK",
      message: `Pollinations request failed: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
  if (!res.ok) throw new CliErrorObject({ code: "NETWORK", message: `Pollinations error (${res.status})` });
  const type = res.headers.get("content-type") ?? "";
  if (!type.startsWith("image/"))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Pollinations returned ${type || "no content type"}, not an image.`,
    });
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > POLLINATIONS_MAX_BYTES)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Pollinations image exceeds ${POLLINATIONS_MAX_BYTES} bytes.`,
    });
  const chunks: Buffer[] = [];
  let total = 0;
  const reader = res.body?.getReader();
  if (!reader) throw new CliErrorObject({ code: "NETWORK", message: "Pollinations returned an empty body." });
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > POLLINATIONS_MAX_BYTES) {
      await reader.cancel();
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Pollinations image exceeds ${POLLINATIONS_MAX_BYTES} bytes.`,
      });
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) throw new CliErrorObject({ code: "NETWORK", message: "Pollinations returned an empty body." });
  return Buffer.concat(chunks);
}

runScript(async () => {
  const opts = parseArgs([
    ...PAID_CLI_SPECS,
    { name: "project", description: "Project for budget tracking" },
    { name: "asset-id", description: "Logical asset ID" },
    { name: "force", type: "boolean", description: "Replace existing output" },
    { name: "prompt", required: true, description: "Image prompt" },
    { name: "output", required: true, description: "Output path" },
    { name: "model", description: "fal endpoint" },
    { name: "size", description: "Size preset or WxH" },
    { name: "steps", type: "number", description: "Inference steps" },
    {
      name: "provider",
      choices: ["fal", "pollinations"],
      description: "Provider: fal (default) or pollinations (third-party, unclear licence; explicit only)",
    },
  ] as const);
  if (opts.steps !== undefined && (!Number.isInteger(opts.steps) || opts.steps < 1))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--steps must be a positive integer." });
  // Check the destination before any provider call: it must stay inside the working directory.
  const output = path.resolve(opts.output!);
  assertPathWithin(process.cwd(), output);
  emitProgress(`\nAI Image Generation`);
  emitProgress(`  Prompt: "${opts.prompt}"\n`);

  // No silent fallback: a missing FAL_KEY fails in the fal path; Pollinations must be named.
  const provider = opts.provider ?? "fal";

  if (provider === "fal") {
    const endpoint = opts.model ?? "fal-ai/flux/schnell";
    const alias = Object.entries(LEGACY_ENDPOINTS).find(
      ([, descriptor]) => descriptor["text-to-image"] === endpoint,
    )?.[0];
    return executeFalOperation({
      projectId: opts.project,
      endpoint,
      model: alias ? `fal:${alias}` : endpoint,
      input: {
        prompt: opts.prompt,
        image_size: parseSize(opts.size ?? "square_hd"),
        num_images: 1,
        output_format: "png",
        ...(opts.steps ? { num_inference_steps: opts.steps } : {}),
      },
      output: opts.output!,
      mediaKind: "image",
      assetId: opts["asset-id"],
      operationId: opts["operation-id"],
      maxCostUsd: opts["max-cost-usd"],
      dryRun: opts["dry-run"],
      force: opts.force,
      quoteInput: { units: 1 },
    });
  }
  const size = parseSize(opts.size ?? "square_hd");
  const dims =
    typeof size === "object"
      ? size
      : (
          {
            square_hd: [1024, 1024],
            square: [512, 512],
            portrait_4_3: [768, 1024],
            portrait_16_9: [576, 1024],
            landscape_4_3: [1024, 768],
            landscape_16_9: [1024, 576],
          } as Record<string, number[]>
        )[size];
  if (!dims) throw new CliErrorObject({ code: "INVALID_INPUT", message: "Unknown image size preset." });
  const [w, h] = Array.isArray(dims) ? dims : [dims.width, dims.height];
  if (opts["dry-run"])
    return {
      outputs: [],
      metadata: {
        dryRun: true,
        provider,
        prompt: opts.prompt,
        width: w,
        height: h,
        output: opts.output,
        prototypeOnly: true,
        licence: "unclear",
      },
    };
  if (existsSync(output) && !opts.force)
    throw new CliErrorObject({ code: "FILE_EXISTS", message: "Output exists; use --force." });
  const buffer = await generateWithPollinations(opts.prompt!, w!, h!);
  mkdirSync(path.dirname(output), { recursive: true });
  assertPathWithin(process.cwd(), output);
  writeFileSync(output, buffer);
  return {
    outputs: [opts.output!],
    metadata: { provider, bytes: buffer.length, prototypeOnly: true, licence: "unclear" },
  };
});
