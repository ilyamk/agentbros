/**
 * Legacy fal model descriptions, retained for existing projects.
 * New selections use pnpm fal:find and docs/fal-catalogue.md.
 */

// ─── Image Generation ────────────────────────────────────────────────

/** @deprecated Use pnpm fal:find and docs/fal-catalogue.md for new model selections. */
export const IMAGE_MODELS = {
  /** Fast image gen, 1-4 steps, best for prototyping & backgrounds */
  "flux-schnell": {
    endpointId: "fal-ai/flux/schnell",
    displayName: "FLUX.1 Schnell",
    pricing: "~$0.003/image",
    input: {
      prompt: "string (REQUIRED)",
      image_size:
        "string | {width,height} — presets: square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9",
      num_inference_steps: "number — default: 4 (1-4 recommended for schnell)",
      num_images: "number — default: 1",
      seed: "number — for reproducibility",
      enable_safety_checker: "boolean — default: true",
      output_format: "'jpeg' | 'png' — default: 'jpeg'",
    },
    output: "{ images: [{ url, width, height, content_type }], seed, has_nsfw_concepts, prompt }",
    notes: "Best speed/cost ratio. Use for backgrounds, textures, quick concepts.",
  },

  /** Higher quality, 20-50 steps, good for hero images */
  "flux-dev": {
    endpointId: "fal-ai/flux/dev",
    displayName: "FLUX.1 Dev",
    pricing: "~$0.025/image",
    input: {
      prompt: "string (REQUIRED)",
      image_size: "string | {width,height} — same presets as schnell",
      num_inference_steps: "number — default: 28 (20-50 recommended)",
      guidance_scale: "number — default: 3.5 (how closely to follow prompt)",
      num_images: "number — default: 1",
      seed: "number",
      enable_safety_checker: "boolean — default: true",
      output_format: "'jpeg' | 'png'",
    },
    output: "{ images: [{ url, width, height, content_type }], seed, has_nsfw_concepts, prompt }",
    notes: "Better prompt following and detail. Use for product shots, hero scenes.",
  },

  /** Pro model, 4MP output, best quality */
  "flux-pro-ultra": {
    endpointId: "fal-ai/flux-pro/v1.1-ultra",
    displayName: "FLUX 1.1 Pro Ultra",
    pricing: "~$0.06/image",
    input: {
      prompt: "string (REQUIRED)",
      image_size: "string | {width,height}",
      seed: "number",
      num_images: "number — default: 1",
      enable_safety_checker: "boolean — default: true",
      output_format: "'jpeg' | 'png'",
      safety_tolerance: "number — 1 (strict) to 6 (permissive), default: 2",
    },
    output: "{ images: [{ url, width, height, content_type }], seed, has_nsfw_concepts, prompt }",
    notes: "Highest quality, 4 megapixel output. Use sparingly — 20x cost of schnell.",
  },

  /** GPT-Image-2 text-to-image — latest OpenAI image model; strong text rendering and photoreal compositions */
  "gpt-image-2": {
    endpointId: "openai/gpt-image-2",
    displayName: "GPT-Image-2 Text-to-Image",
    pricing: "Not disclosed by fal.ai",
    input: {
      prompt: "string (REQUIRED)",
      image_size:
        "'auto' | 'square_hd' | 'square' | 'portrait_4_3' | 'portrait_16_9' | 'landscape_4_3' | 'landscape_16_9' | { width, height } — multiples of 16, max edge 3840px, aspect ≤ 3:1, 655,360–8,294,400 px",
      num_images: "number — default: 1",
      quality: "'low' | 'medium' | 'high' — default: 'high'",
      output_format: "'png' | 'jpeg' | 'webp' — default: 'png'",
    },
    output: "{ images: [{ url, width, height, content_type }] }",
    notes: "Default for any text-heavy / photoreal / hero shot. Use pnpm generate:image --model gpt-image-2.",
  },

  /** GPT-Image-2 edit-image — compose or transform with up to several references and an optional mask */
  "gpt-image-2-edit": {
    endpointId: "openai/gpt-image-2/edit",
    displayName: "GPT-Image-2 Edit-Image",
    pricing: "Not disclosed by fal.ai",
    input: {
      prompt: "string (REQUIRED)",
      image_urls: "string[] (REQUIRED) — one or more reference images",
      image_size: "same options as text-to-image",
      num_images: "number — default: 1",
      quality: "'low' | 'medium' | 'high' — default: 'high'",
      output_format: "'png' | 'jpeg' | 'webp' — default: 'png'",
      mask_url: "string — optional mask image URL for partial / inpainting edits",
    },
    output: "{ images: [{ url, width, height, content_type }] }",
    notes: "Compose or edit using reference images. Use pnpm generate:image --model gpt-image-2 --reference-image.",
  },

  /** Image variation/remix from a reference image */
  "flux-redux": {
    endpointId: "fal-ai/flux/schnell/redux",
    displayName: "FLUX.1 Redux (Image Variation)",
    pricing: "~$0.003/image",
    input: {
      image_url: "string (REQUIRED) — reference image URL",
      prompt: "string — optional guidance for variation",
      image_size: "string | {width,height}",
      num_inference_steps: "number — default: 4",
      num_images: "number — default: 1",
      seed: "number",
    },
    output: "{ images: [{ url, width, height, content_type }] }",
    notes: "Creates variations of an existing image. Pass the reference image as an endpoint input.",
  },
} as const;

// ─── Video Generation ────────────────────────────────────────────────

/** @deprecated Use pnpm fal:find and docs/fal-catalogue.md for new model selections. */
export const VIDEO_MODELS = {
  /** MiniMax free tier — good quality, no cost */
  "minimax-live": {
    endpointId: "fal-ai/minimax-video/video-01-live",
    displayName: "MiniMax Video-01-Live",
    pricing: "Free tier available",
    input: {
      prompt: "string (REQUIRED) — detailed scene description",
      prompt_optimizer: "boolean — default: true (auto-enhance prompt)",
    },
    output: "{ video: { url } }",
    notes: "Best free option. ~10s generation. Good for ambient/background clips.",
  },

  /** Kling v2 — higher quality, paid */
  "kling-text-to-video": {
    endpointId: "fal-ai/kling-video/v2/master/text-to-video",
    displayName: "Kling 2.0 Text-to-Video",
    pricing: "~$1.40 per 5s clip",
    input: {
      prompt: "string (REQUIRED)",
      duration: "number — 5 or 10 seconds",
      aspect_ratio: "string — '16:9', '9:16', '1:1'",
      negative_prompt: "string — what to avoid",
    },
    output: "{ video: { url } }",
    notes: "High quality. Specify aspect_ratio '9:16' for vertical video.",
  },

  /** Kling v2 image-to-video — animate a still image */
  "kling-image-to-video": {
    endpointId: "fal-ai/kling-video/v2/master/image-to-video",
    displayName: "Kling 2.0 Image-to-Video",
    pricing: "~$1.40 per 5s clip",
    input: {
      prompt: "string (REQUIRED) — describe the motion",
      image_url: "string (REQUIRED) — starting frame image",
      duration: "number — 5 or 10 seconds",
      negative_prompt: "string",
    },
    output: "{ video: { url } }",
    notes: "Animate a generated or product image. Pass the image as an endpoint input.",
  },

  /** HunyuanVideo — open source, good quality */
  "hunyuan-video": {
    endpointId: "fal-ai/hunyuan-video",
    displayName: "HunyuanVideo",
    pricing: "~$0.50/video",
    input: {
      prompt: "string (REQUIRED)",
      resolution: "string — 'landscape' (1280x720), 'portrait' (720x1280), 'square' (960x960)",
      num_frames: "number — default: 129 (~5s at 24fps)",
    },
    output: "{ video: { url } }",
    notes: "Open-source model, good motion quality. Tencent-made.",
  },

  /** Luma Dream Machine */
  "luma-dream-machine": {
    endpointId: "fal-ai/luma-dream-machine",
    displayName: "Luma Dream Machine",
    pricing: "~$0.50/video",
    input: {
      prompt: "string (REQUIRED)",
      aspect_ratio: "string — '16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'",
      loop: "boolean — seamless loop",
    },
    output: "{ video: { url } }",
    notes: "Good for cinematic/dreamy visuals. Supports looping.",
  },
} as const;

// ─── Image-to-Image ──────────────────────────────────────────────────

/** @deprecated Use pnpm fal:find and docs/fal-catalogue.md for new model selections. */
export const IMG2IMG_MODELS = {
  "flux-img2img": {
    endpointId: "fal-ai/flux/dev/image-to-image",
    displayName: "FLUX.1 Dev Image-to-Image",
    pricing: "~$0.025/image",
    input: {
      image_url: "string (REQUIRED) — source image",
      prompt: "string (REQUIRED) — describe desired changes",
      strength: "number — 0.0 (no change) to 1.0 (full regen), default: 0.95",
      num_inference_steps: "number — default: 28",
      guidance_scale: "number — default: 3.5",
      num_images: "number — default: 1",
      seed: "number",
      image_size: "string | {width,height}",
    },
    output: "{ images: [{ url, width, height, content_type }] }",
    notes: "Transform existing images. strength 0.3-0.5 for style transfer, 0.7-0.9 for major changes.",
  },
} as const;

// ─── Utility Models ──────────────────────────────────────────────────

/** @deprecated Use pnpm fal:find and docs/fal-catalogue.md for new model selections. */
export const UTILITY_MODELS = {
  /** 4x image upscaler */
  "upscale-aura-sr": {
    endpointId: "fal-ai/aura-sr",
    displayName: "AuraSR 4x Upscaler",
    pricing: "~$0.01/image",
    input: {
      image_url: "string (REQUIRED) — image to upscale",
    },
    output: "{ image: { url, width, height, content_type } }",
    notes: "4x resolution increase. Good for upscaling AI-generated images.",
  },

  /** Background removal */
  "bg-removal": {
    endpointId: "fal-ai/birefnet",
    displayName: "BiRefNet Background Removal",
    pricing: "~$0.01/image",
    input: {
      image_url: "string (REQUIRED)",
    },
    output: "{ image: { url, width, height, content_type } }",
    notes: "Returns PNG with transparent background. Great for product cutouts.",
  },
} as const;

// ─── Agent Decision Helper ───────────────────────────────────────────

/**
 * @deprecated Use pnpm fal:find and docs/fal-catalogue.md for new model selections.
 */
export function pickModel(
  type: "image" | "video" | "img2img" | "upscale" | "bg-removal",
  quality: "fast" | "quality" | "best" = "fast",
): { endpointId: string; displayName: string } {
  switch (type) {
    case "image":
      if (quality === "best") return IMAGE_MODELS["flux-pro-ultra"];
      if (quality === "quality") return IMAGE_MODELS["flux-dev"];
      return IMAGE_MODELS["flux-schnell"];

    case "video":
      if (quality === "quality" || quality === "best") return VIDEO_MODELS["kling-text-to-video"];
      return VIDEO_MODELS["minimax-live"];

    case "img2img":
      return IMG2IMG_MODELS["flux-img2img"];

    case "upscale":
      return UTILITY_MODELS["upscale-aura-sr"];

    case "bg-removal":
      return UTILITY_MODELS["bg-removal"];
  }
}

/** Legacy table endpoint IDs. @deprecated Use pnpm fal:find and docs/fal-catalogue.md for discovery. */
export function allModelIds(): string[] {
  return [
    ...Object.values(IMAGE_MODELS),
    ...Object.values(VIDEO_MODELS),
    ...Object.values(IMG2IMG_MODELS),
    ...Object.values(UTILITY_MODELS),
  ].map((m) => m.endpointId);
}
