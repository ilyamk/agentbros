# Legacy generation routes

Compatibility reference for retained generation routes. New briefs use [production model routing](production-model-routing.md), exact capability and schema requests and current registry quotes; prices are in `src/lib/pricing.ts` and the endpoint registry, and nothing here is admission authority. Budget rules: root [AGENTS.md](../AGENTS.md#paid-operations-and-budget). Presenter continuity and current modes: [talking-head instructions](../src/templates/AGENTS.md#talking-head-essentials).

## Legacy AI video (Kling 2.5 / Seedance 2.0 / Hailuo 02)

The CLI `scripts/generate-video.ts` defaults to `kling-2.5-turbo`; `src/lib/apis/fal.ts` retains separate compatibility helpers. Retiring or gone catalogue entries add `metadata.warnings`, with any recorded replacement and `pnpm fal:doctor`; execution and endpoint selection remain unchanged.

| Alias | fal endpoint family | Duration | Aspect | Variants | Pricing |
|-------|---------------------|----------|--------|----------|---------|
| `kling-2.5-turbo` | `fal-ai/kling-video/v2.5-turbo/pro/{text,image}-to-video` | 5\|10 s | 16:9\|9:16\|1:1 | t2v, i2v | registry quote |
| `seedance-2-fast` (asset dispatcher default) | `bytedance/seedance-2.0/fast/{text,image,reference}-to-video` (NO `fal-ai/` prefix) | 4–15 s or `auto` | auto\|21:9\|16:9\|4:3\|1:1\|3:4\|9:16 | t2v, i2v (+ `end_image_url`), r2v (≤9 image refs / ≤3 video refs / ≤3 audio refs, addressed via `@Image1`…`@Image9`, `@Video1`…, `@Audio1`…) | registry quote |
| `seedance-1-pro` | `fal-ai/bytedance/seedance/v1/pro/{text,image}-to-video` | 2–12 s | 21:9\|16:9\|4:3\|1:1\|3:4\|9:16 | t2v, i2v | not disclosed |
| `hailuo-02-pro` | `fal-ai/minimax/hailuo-02/pro/{text,image}-to-video` | 6\|10 s | (none — fixed) | t2v, i2v | registry quote |

When the asset-plan asks for `source: "fal-bytedance"` the dispatcher defaults to `seedance-2-fast`; override via `metadata.model = "seedance-1-pro"`.

### Historical creative recipe
1. **Character Bible** — Define each character ONCE (name, age, skin, hair, clothing). Inject verbatim into every prompt.
2. **Story Arc** — Map scenes to beats: hook → pain → bridge → solution → proof → ritual → CTA.
3. **Prompt = CHAR + ACTION + SETTING + LIGHT + STYLE + CAMERA** — Always this order.
4. **Choreograph actions** — 2-3 explicit beats per 5s clip (setup → action → resolve). Never vague.
5. **Style anchor** — Same string in every prompt. E.g.: `"Cinematic, warm soft lighting, shallow depth of field, 35mm anamorphic, muted warm tones, slow deliberate movement"`
6. **Calm transitions** — Start calm, end calm. Action in the middle. 12f crossfade needs visual compatibility.

### Character Card Example
```
CHAR_MAYA = "Maya, late 20s, olive skin, dark brown shoulder-length wavy hair, soft brown eyes, natural makeup, cream knit sweater"
```

### How to invoke

```bash
# Kling 2.5 t2v
pnpm generate:video --prompt "..." --output PATH --model kling-2.5-turbo \
  --duration 5 --aspect 16:9 [--reference-image URL]

# Seedance 2.0 fast — text-to-video
pnpm generate:video --prompt "..." --output PATH --model seedance-2-fast \
  --duration auto --aspect 9:16 --resolution 720p

# Seedance 2.0 fast — image-to-video (with optional ending frame)
pnpm generate:video --prompt "..." --output PATH --model seedance-2-fast \
  --reference-image https://… [--end-image-url https://…]

# Seedance 2.0 fast — reference-to-video (multi-image)
pnpm generate:video --prompt "@Image1 hugs @Image2 at sunset" --output PATH \
  --model seedance-2-fast \
  --reference-images "https://a.png,https://b.png" \
  [--reference-videos "https://clip1.mp4"] [--no-generate-audio]
```

For asset-plan generation, `pnpm asset:fetch-all --project <id>` dispatches modern `fal-model` exact operation requests and preserves explicit legacy sources in existing asset plans. New work uses `pnpm generate:model` and modern `fal-model` plans; N variations use `pnpm fal:batch` after quote/budget review.

## Legacy image alias (gpt-image-2)

| Service | Env var | Use | Client |
|---------|---------|-----|--------|
| fal.ai gpt-image-2 (legacy) | `FAL_KEY` | Retained OpenAI image alias — text rendering, photoreal compositions, memes, multi-image composition, optional mask for partial edits. Endpoints: `openai/gpt-image-2`, `openai/gpt-image-2/edit`. Pricing not disclosed. Quality `low\|medium\|high`. Size presets or custom WxH (mult. of 16). | `apis/fal.ts` |

**AI image rules:** Always remove bg (fal.ai birefnet) for FLUX images. Place as `<Img>` absolute. Entrance: fade or scale spring only. Add continuous subtle motion. Generate at 2x, display at 1x. For gpt-image-2, bg removal is optional (it renders coherent scenes).

## Legacy source aliases

Preserve explicit old `fal-gpt-image`/`fal-flux`/`fal-bytedance`/`fal-kling`/`fal-minimax` aliases only for approved legacy routes; never silently migrate them.

## Image and lipsync utilities

`pnpm rmbg`, `pnpm upscale` and the unaliased `scripts/generate-lipsync.ts` accept `--endpoint <id>` from [verified endpoints](fal-catalogue.md#verified-endpoints) curated as `cutout`, `upscale` or `lipsync`, respectively. The override maps media fields from the pinned endpoint schema and uses the schema-validated durable queue, result extraction and quote path. Unsupported IDs, tiers and roles fail with `INVALID_INPUT` and the allowed endpoints.

Without `--endpoint`, the existing input bytes, behaviour and pricing keys remain unchanged: `fal:birefnet-bgremoval`, `fal:aura-sr-upscale` and `fal:sync-lipsync` (or the existing `--model latentsync` route). With an override, pricing uses the exact endpoint; an unknown price needs an authorised positive `--max-cost-usd` before execution. `--dry-run` remains offline.

Examples: `pnpm rmbg --input photo.png --output cutout.png --endpoint fal-ai/birefnet/v2 --dry-run` and `pnpm upscale --input clip.mp4 --output large.mp4 --endpoint fal-ai/seedvr/upscale/video --dry-run`. Video detection uses the input extension (`mp4`, `mov`, `webm`, `mkv`, `avi`, `m4v`); it requires a verified `video-to-video` upscale endpoint. Image inputs require `image-to-image`.

For lipsync, run `pnpm exec tsx scripts/generate-lipsync.ts --video presenter.mp4 --audio voice.wav --output synced.mp4 --endpoint fal-ai/sync-lipsync/v3 --dry-run`. An override uses its schema rather than `--model`; Sync and LatentSync require video, so `--portrait` is refused by their schemas. Avatar selection, inpainting, outpainting and interpolation use endpoint-form requests through `pnpm generate:model` after `pnpm fal:scaffold --endpoint <id>`.
