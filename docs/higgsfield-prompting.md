# Higgsfield workflows and prompting
For production recommendations use `pnpm models:pick --task TASK` or a use case/slot from [the slot guide](model-slots-guide.md). The endpoint names below document provider contracts, prompting syntax and historical verification.


Offline contracts and recorded provider documentation, checked 2026-11-15. Requests below use the exact Higgsfield endpoint and field names. Replace example URLs with your authorised public media. Validate with `pnpm generate:model --request REQUEST.json --output PATH --dry-run` and review the quote before execution. An offline example establishes schema validity, not provider acceptance, consent or billing. Supply measured `context.media` keyed by the exact URL for duration, bytes and dimensions; `contentType` supplies a verified image MIME type. Missing measurements produce warnings.

Prices below come from [hf-prices.json](../src/lib/models/hf-prices.json), dated 2026-11-15. A catalogue “from” amount is a floor, not a request quote. Missing records and token-metered descriptions require an authorised positive `--max-cost-usd`, a planning bound rather than a provider billing cap. Never borrow prices or request schemas from fal or a sibling endpoint.

The evidence table below is checked against the tracked file by `tests/hf-prompting.test.ts`. Request-specific estimates require matching bodies; parsed tariffs require all billing quantities. Unresolved prices need an authorised bound.

| Endpoint | Evidence |
|---|---|
| `bytedance/seedance-2.5/image-to-video` | Parsed tariff |
| `bytedance/seedance-2.5/reference-to-video` | Parsed tariff |
| `bytedance/seedance-2.5/text-to-video` | Parsed tariff |
| `bytedance/seedance-2.5/video-edit` | Parsed tariff |
| `bytedance/seedance-2.5/video-extend` | Parsed tariff |
| `higgsfield-ai/soul/cinema` | Request-specific estimates |
| `higgsfield-ai/soul/standard` | Request-specific estimates |
| `higgsfield-ai/soul/v2/standard` | Request-specific estimates |
| `higgsfield/ads-studio/v1.0` | Unresolved price |
| `higgsfield/cinema-studio/4.0` | Unresolved price |
| `higgsfield/genjutsu/motion-transfer/v1.0` | Parsed tariff |
| `higgsfield/genjutsu/object-swap/v1.0` | Parsed tariff |
| `higgsfield/genjutsu/restyle/v1.0` | Approximate tariff |
| `marketing-studio/image` | Request-specific estimates |
| `marketing-studio/image/flare` | Unresolved price |
| `marketing-studio/image/sunburst` | Unresolved price |
| `v1/custom-references` | Unresolved price |

## Rights and consent — before preparing inputs

Any use that puts a real, identifiable person into footage, or uses third-party clips (films, ads or social media), must first go through the existing `entity:card` consent workflow and `film:rights`. Follow [entity cards and consent](entity-workflow.md): import the original with provenance and licence evidence, record likeness consent with evidence and scope, and obtain explicit approval of the pinned card. Card approval alone does not establish likeness, voice or licence consent. Record the user's rights decision using the [film rights gate](production-chain.md#the-replica-route), including owned, licensed or study-only status and their actual words. Study-only material cannot be delivered for publication.

`film:rights` without `--preparation` retains its replica-only contract (see [production chain](production-chain.md#commands)). For a prepared Genjutsu remix in any project, `film:rights --preparation ID` records hash-bound source-use permissions for the original video and reference images, explicit processing permission, placements, commercial/special uses and audio rights. It is not a general consent flag on `generate:model`. Other workflows still need their own applicable rights evidence. Local preparation transmits no inputs; permissions and approval must be complete before uploads, estimates or paid execution.

Higgsfield applies content moderation. `nsfw` is a refunded terminal status for generation, reported as rejected by content moderation. Schema-less execution flags do not change moderation or rights requirements. Soul ID training has its own statuses; its docs do not promise a refund for failed training.

## Genjutsu motion-transfer

Use `higgsfield/genjutsu/motion-transfer/v1.0` to transfer source motion while changing referenced subjects or appearance. The [workflow](https://docs.higgsfield.ai/docs/models/genjutsu/motion-transfer.md) requires `video_url` and `image_urls` (1–8 images); `prompt` is optional, default empty. `resolution` is `480p`, `720p` (default) or `1080p`.

The source must last at least 4 seconds. More than 30 seconds is trimmed to 30; output follows the prepared source. The recorded price uses source seconds rounded up: $0.1540 / $0.3446 / $0.8346 per second at 480p / 720p / 1080p respectively. Plan from the prepared source duration; refresh the quote for the exact input.

Motion transfer rebuilds the scene around the source movement and camera. For a targeted replacement that must preserve the original scene, use object-swap. The provider permits an empty prompt; our preparation supplies an explicit prompt and prefers the house `@Video1` and `@Image1` convention below. The provider documentation does not establish that token syntax as a guaranteed API contract.

```json
{"provider":"higgsfield","endpoint":"higgsfield/genjutsu/motion-transfer/v1.0","input":{"video_url":"https://example.com/source.mp4","image_urls":["https://example.com/character.jpg"]}}
```

## Genjutsu object-swap

Use `higgsfield/genjutsu/object-swap/v1.0` for substitution in source footage. The [workflow](https://docs.higgsfield.ai/docs/models/genjutsu/object-swap.md) requires `video_url` and 1–8 `image_urls`; optional `prompt` defaults empty, and `resolution` has the same three tiers as motion-transfer.

The video minimum is 4 seconds; inputs over 30 seconds are trimmed. **The source video must have at least 409,600 pixels per frame (`width × height`).** This is a minimum on the video, not a maximum on reference images. Prices in the tracked file are $0.1540 / $0.3446 / $0.8346 per source second, rounded up, at 480p / 720p / 1080p.

Object swap is the local substitution mode: identify the selected person, face, outfit or object and name what must remain unchanged. Prefer `@Video1` and `@Image1`, bound to the exact attachments as described below. There is no mask or bounding-box API field; preparation annotations and sampled frames are review evidence, not hidden provider inputs.

```json
{"provider":"higgsfield","endpoint":"higgsfield/genjutsu/object-swap/v1.0","input":{"video_url":"https://example.com/source.mp4","image_urls":["https://example.com/object.jpg"]}}
```

## Genjutsu restyle

Use `higgsfield/genjutsu/restyle/v1.0` to change visual style while retaining motion, composition and source audio. The [workflow](https://docs.higgsfield.ai/docs/models/genjutsu/restyle.md) requires `video_url` and `preset_id`. Optional `image_urls` accepts up to five character images; omit it or use `[]` to retain source subjects. `prompt` defaults empty; `resolution` is `480p`, `720p` or `1080p`, default `720p`. Null is not accepted.

The source must be at least 4 seconds and at most 200 MiB. Sources over 30 seconds are trimmed, including audio. Style can change output cadence, FPS and exact duration. `preset_id` must exist in the [dated cache](../src/lib/models/hf-restyle-presets.json); unknown IDs fail and caches older than 30 days warn. In a network-authorised session run `pnpm hf:sync --presets` to fetch current IDs with credentials. The tracked approximate tariff is $0.318 / $0.681 / $1.632 per prepared source second at 480p / 720p / 1080p, rounded up after trimming to 30 seconds. Local quotes add a 25% safety margin; these are approximate rates, not exact request estimates.

Prompting: select the documented style by preset UUID, and use optional character images only to guide appearance. No documented prompting guidance for prose beyond the optional prompt. The example uses the cached Cel-Shaded CG Anime preset.

```json
{"provider":"higgsfield","endpoint":"higgsfield/genjutsu/restyle/v1.0","input":{"video_url":"https://example.com/source.mp4","preset_id":"c2143317-f28d-4c3c-a0b8-39bd547e08a7"}}
```

## Genjutsu Light

`higgsfield/genjutsu-light/motion-transfer/v1.0` is catalogue-only. Its [recorded catalogue description](../tests/fixtures/higgsfield/catalog-models.json) describes transferring motion to reference characters and scenes, using the first 15 seconds and preserving source audio. **There is no documented workflow schema or usage-note duration/reference limit.** Do not apply Genjutsu's 4–30-second rules to Light.

The price file records $0.0739 / $0.1471 / $0.2936 per output second at 480p / 720p / 1080p. Local quotes derive output duration from measured source seconds, capped at 15 seconds and rounded up; without measured source duration the price stays unresolved. Prompting: no documented prompting guidance.

A minimal request guaranteed to validate offline cannot be supplied: exact accepted field names are unverified. The recorded estimate used `video_url`, `image_urls` and `resolution`; that is evidence of an estimate request, not a JSON Schema. Plans report `verification.schema: false` and are not executable by default. Before execution, `generate:model --provider-estimate` validates the exact request using the free provider estimate API; alternatively `--allow-unvalidated` explicitly accepts the absent schema. A dry-run remains offline and does not perform the estimate. Neither option supplies a spending bound or validates rights.

## Soul 2

Use `higgsfield-ai/soul/v2/standard` for portraits and fashion images; that purpose comes from the [catalogue](../tests/fixtures/higgsfield/catalog-models.json). The [workflow](https://docs.higgsfield.ai/docs/models/soul-2/generate.md) requires `prompt`. Optional controls include `aspect_ratio`, `resolution`, `batch_size`, `enhance_prompt`, `style_id`, `style_strength`, `seed`, `custom_reference_id` and `custom_reference_strength`.

`batch_size` is 1 or 4. `aspect_ratio` defaults `1:1`; accepted ratios are `9:16`, `16:9`, `4:3`, `3:4`, `1:1`, `2:3`, `3:2`. Resolution is `720p` or `1080p`. Omitted seed is random; explicit null is invalid. A `custom_reference_id` must be trained for v2, completed and owned by the calling account; with it, `custom_reference_strength` must be greater than 0 and at most 1 (default 1). The field is `custom_reference_id`, not `soul_id`. Offline checks cannot establish account ownership or training completion.

The tracked catalogue floor is $0.0032 per image. Request-specific estimates are $0.004 at 720p and $0.006 at 1080p for the recorded prompt and `batch_size: 1`. These are whole-request estimates for matching inputs; do not extrapolate to different prompts or batches.

Prompting: the usage notes say short prompts in the general style may be enhanced even with `enhance_prompt:false`. `style_strength` currently has no effect. No documented prompting guidance beyond those behaviours.

```json
{"provider":"higgsfield","endpoint":"higgsfield-ai/soul/v2/standard","input":{"prompt":"Editorial portrait in soft daylight"}}
```

## Soul Cinema and Soul Standard

Use `higgsfield-ai/soul/cinema` for the fixed Cinema style, or `higgsfield-ai/soul/standard` for the standard style family. Their [Cinema](https://docs.higgsfield.ai/docs/models/soul-cinema/generate.md) and [Standard](https://docs.higgsfield.ai/docs/models/soul-standard/generate.md) workflows require `prompt` and accept `batch_size` 1 or 4, `resolution` `720p`/`1080p`, `aspect_ratio`, `enhance_prompt`, `seed`, `custom_reference_id` and `custom_reference_strength`. Aspect ratios are the same seven as Soul 2; Cinema defaults `1:1`, Standard `4:3`. Both have request-specific estimates: Cinema records $0.004 at 720p and $0.006 at 1080p; Standard records $0.094 and $0.188 respectively. Each applies only to its sampled body with `batch_size: 1`. Standard also has a $0.0938/image catalogue floor. Other inputs need a matching estimate or authorised bound.

Cinema requires a completed account-owned reference trained with `model_version:"cinema"`. Supplying `custom_reference_id` enables character prompt enhancement even when `enhance_prompt:false`. Cinema has a fixed style; its schema has no `style_id` input, even though the usage notes describe client styles as ignored. Cinema seed may be omitted but not null. It can be absent from discovery; its documented endpoint still identifies it.

Standard uses a completed account-owned v1 reference. It additionally accepts `style_id`, `style_strength` and `image_reference_url`; the latter guides enhancement and is distinct from a trained character ID. Standard accepts omitted or null seed. `custom_reference_strength:0` means the style's default character strength, rather than disabling the character. Short general-style prompts may be enhanced with enhancement disabled. These are the documented prompting behaviours; no documented prompting guidance for composing prose.

```json
{"provider":"higgsfield","endpoint":"higgsfield-ai/soul/cinema","input":{"prompt":"A portrait beside a sunlit window"}}
```

```json
{"provider":"higgsfield","endpoint":"higgsfield-ai/soul/standard","input":{"prompt":"A portrait beside a sunlit window"}}
```

## Soul ID training

Use `v1/custom-references` to train a reusable character, as documented by [Create character](https://docs.higgsfield.ai/docs/models/soul-id/create-character.md). This is a **training** operation, not an image generator; do not POST to `/soul-id`. It needs `name` (at most 100 characters) and `input_images` containing 1–100 objects with `type:"image_url"` and public `image_url`. `model_version` is `v1` (default), `v2` or `cinema`; select the matching generation family.

The durable adapter POSTs `/v1/custom-references`, saves the returned `id`, then polls GET `/v1/custom-references/{id}`. States are `not_ready`, `queued`, `in_progress`, `completed`, `failed`. A completed job publishes an immutable training manifest with `customReferenceId`; pass that value as `custom_reference_id` in a later Soul request using the same account. Training returns no image or weights. This adapter accepts public HTTP(S) training-image URLs only; it rejects local, imported and inline data references instead of silently submitting them without upload. Capacity rejection is HTTP 429 with Retry-After; it creates no charged request. The same durable operation returns to reserved admission and surfaces RATE_LIMIT with the delay; wait and retry once. No Idempotency-Key support is documented on this route: an ambiguous submission stays blocked and retains liability for reconciliation; never resubmit it automatically.

The tracked training record has no estimate route or bounded tariff; the price remains unresolved and needs an authorised bound. Prompting: there is no prompt field and no documented prompting guidance or training-image selection recipe.

```json
{"provider":"higgsfield","endpoint":"v1/custom-references","input":{"name":"Approved character","model_version":"v2","input_images":[{"type":"image_url","image_url":"https://example.com/authorised-portrait.jpg"}]}}
```

## AI Influencer

`higgsfield/ai-influencer` is catalogue-only. The [recorded catalogue](../tests/fixtures/higgsfield/catalog-models.json) describes one character sheet with human and animal modes. The price file has an exact list amount of $0.05 per image and an estimate of $0.05 for `{}`; that estimate does not establish accepted input fields.

There is no documented schema, reference-count limit, aspect/resolution rule or `soul_id` contract. Exact inputs and a guaranteed offline-valid minimal request are unavailable. No documented prompting guidance. Use the same explicit estimate-validation or unvalidated-execution gate as Light; do not invent mode or character fields from the description.

## Marketing Studio image — flare, sunburst, generate-and-edit

Use these for text-to-image or editing campaign images, following [flare](https://docs.higgsfield.ai/docs/models/marketing-studio-image/flare.md), [sunburst](https://docs.higgsfield.ai/docs/models/marketing-studio-image/sunburst.md) and [generate-and-edit](https://docs.higgsfield.ai/docs/models/marketing-studio-image/generate-and-edit.md). Their endpoint IDs are `marketing-studio/image/flare`, `marketing-studio/image/sunburst` and `marketing-studio/image` respectively. All require `prompt`; optional fields are `quality`, `preset_id`, `image_urls`, `moderation`, `resolution`, `aspect_ratio`, `enhance_prompt`.

With `enhance_prompt:false` (default), omit `image_urls` for text generation or supply up to 16 for editing. With enhancement enabled, supply an existing `preset_id` and 1–2 images: product first, optional person/model second. Presets come from GET `/marketing-studio/image/presets`, a different list from Genjutsu restyle. Existence and image roles cannot be established offline. Images must be JPEG, PNG or WebP; oversized supported images are normalised, with no documented numerical size limit. `resolution` is `1k`, `2k` (default) or `4k`; these are tiers, not exact dimensions. `aspect_ratio:auto` follows the preset when enhanced and currently maps to square when unenhanced. Explicit ratios are `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `21:9`.

Flare and sunburst accept `quality` `low`, `medium`, `high`, `xhigh`, `max`, also when enhanced. Generate-and-edit accepts `low`, `medium`, `high` unenhanced, and requires `high` when enhanced. The schema encodes that condition. All three have tracked records and $0.0162/image catalogue floors. Flare and Sunburst retain token-metered descriptions requiring actual usage, so no bounded tariff is parsed. Generate-and-edit has request-specific estimates of $0.221 / $0.439 / $0.722 at 1k / 2k / 4k for the sampled high-quality, unenhanced body; other bodies need a matching estimate or authorised bound.

Prompting: the schema describes `prompt` as “Write your prompt here”; the docs define product/person ordering and enhancement behaviours above. No documented prompting guidance for prose beyond these input roles.

```json
{"provider":"higgsfield","endpoint":"marketing-studio/image/flare","input":{"prompt":"A ceramic vase beside a sunlit window","enhance_prompt":false}}
```

```json
{"provider":"higgsfield","endpoint":"marketing-studio/image/sunburst","input":{"prompt":"A ceramic vase beside a sunlit window","enhance_prompt":false}}
```

```json
{"provider":"higgsfield","endpoint":"marketing-studio/image","input":{"prompt":"A ceramic vase beside a sunlit window","enhance_prompt":false}}
```

## Ads Studio

Use `higgsfield/ads-studio/v1.0` to turn a brief into ad concepts and rendered images in one request. The [workflow](https://docs.higgsfield.ai/docs/models/ads-studio/generate.md) requires `prompt`; optional inputs are `niche`, `language`, `batch_size`, `image_urls`, `aspect_ratio`, `target_audience`. There is no separate preparation call.

`batch_size` is 1–8 (default 1), producing one image per successful concept. `image_urls` accepts at most 10 images. All outputs share the requested `aspect_ratio` (default `1:1`, no `auto`). Rendering is fixed to GPT Image 2.5 Flare, 2k, high quality; `quality`, `resolution`, renderer and fallback-model fields are not public inputs. The tracked record has a $0.084/image catalogue floor and a token-metered description requiring actual usage. It has no bounded tariff or matching numeric request estimate; execution needs an authorised bound.

Prompting: submit the brief in `prompt`; use the schema's `niche`, `target_audience` and `language` controls where appropriate. No documented prompting guidance for ad copy or prompt structure.

```json
{"provider":"higgsfield","endpoint":"higgsfield/ads-studio/v1.0","input":{"prompt":"An advert for a reusable ceramic coffee cup"}}
```

## Cinema Studio 4.0

Use `higgsfield/cinema-studio/4.0` for automatic scene direction: text-to-video without references, reference-to-video when any media array is nonempty. The [workflow](https://docs.higgsfield.ai/docs/models/cinema-studio-4/generate.md) requires nonblank `prompt`. It accepts `duration` (integer 4–30, default 5), `resolution` (`480p`/`720p`, default `720p`), `aspect_ratio` (`16:9`, `4:3`, `1:1`, `3:4`, `9:16`, `21:9`), `generate_audio`, `image_urls`, `video_urls`, `audio_urls` and optional creative controls.

References are limited to 30 images, 10 videos, 10 audio files, at most 50 in total. Video and audio can be normalised to separate 30-second budgets. Prompt tokens `<<<image_1>>>`, `<<<video_1>>>`, `<<<audio_1>>>` are one-based and must refer to attached items of the matching type. Editing and extension belong to the separate Seedance endpoints.

Prompting: omit `era`, `genre`, `light`, `pacing`, `camera_lens`, `camera_model`, `color_palette`, `camera_aperture`, `camera_movement` to let the director choose. Literal `auto` is invalid for these enums. `pacing` accepts `chaotic`, `dynamic`, `calm`, `single-shot`. **No explicit multi-shot array or shot-duration structure is documented in this schema**; do not borrow Kling's `multi_prompt` or invent `shots`. For automatic direction, describe the video in `prompt`; the schema calls this text instructions for generation or editing, but the usage notes restrict this endpoint to new videos.

The price file marks this workflow `token-metered`, with no parsed bounded tariff. Its description computes video tokens from input plus generated video seconds, output dimensions and 24 fps, rounded up after division by 1024. At 480p/720p it states $0.0214 per 1,000 video tokens without video input and $0.01284 with video input; image/audio references do not count as video input. A $0.1234/second catalogue floor is not a usable full quote. Execution needs an authorised bound.

```json
{"provider":"higgsfield","endpoint":"higgsfield/cinema-studio/4.0","input":{"prompt":"Ocean waves at sunset, with gentle camera movement"}}
```

## Seedance 2.5 at Higgsfield

Use the separate [text-to-video](https://docs.higgsfield.ai/docs/models/seedance-2-5/text-to-video.md), [image-to-video](https://docs.higgsfield.ai/docs/models/seedance-2-5/image-to-video.md), [reference-to-video](https://docs.higgsfield.ai/docs/models/seedance-2-5/reference-to-video.md), [video-edit](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-edit.md) and [video-extend](https://docs.higgsfield.ai/docs/models/seedance-2-5/video-extend.md) endpoints under `bytedance/seedance-2.5/`.

Text-to-video requires nonblank `prompt` and has no media inputs. Image-to-video requires `image_url`, accepts optional `end_image_url` and optional `prompt`; framing follows the image. Reference-to-video requires `prompt` and at least one nonempty `image_urls`, `video_urls` or `audio_urls`; audio-only references are supported. The limits are 30 images, 10 videos, 10 audio files and 50 total, with video/audio separately normalised to 30-second budgets. Video-edit and video-extend require `video_url` and `prompt`; the source counts toward the video/total limits, leaving at most nine extra `video_urls`. Framing follows the source. Edit has no `duration` field; it derives duration from the prepared source (normalised to at least 4 seconds). Extend accepts integer `duration` 4–30, default 5. Public media URLs are required; provider `asset://` inputs are rejected.

**Differences from fal:** Higgsfield generation durations use integers 4–30, rather than fal's string enum with `auto`. Do not forward fal `seed`, `codec`, `draft`, `task` or draft-completion inputs. The provider-specific schema decides resolution and aspect options. Requesting the same endpoint ID at fal does not validate a Higgsfield request.

All five workflows have parsed tariffs. Text-to-video and image-to-video cost $0.1177 / $0.2647 / $0.6518 per output second at 480p / 720p / 1080p. Reference-to-video uses those rates without video input, or $0.1387 / $0.3264 / $0.7858 with video input; image/audio references alone use the lower rate. Video-edit uses the latter rates per prepared source second, rounded up with a four-second minimum. Video-extend uses the latter rates per requested extension second; existing source seconds are not added. Prompting: the docs identify the media roles, optional last frame and framing rules above; no documented prompting guidance for prose.

```json
{"provider":"higgsfield","endpoint":"bytedance/seedance-2.5/text-to-video","input":{"prompt":"A red fox in snow","duration":5}}
```

```json
{"provider":"higgsfield","endpoint":"bytedance/seedance-2.5/image-to-video","input":{"image_url":"https://example.com/first-frame.jpg"}}
```

```json
{"provider":"higgsfield","endpoint":"bytedance/seedance-2.5/reference-to-video","input":{"prompt":"A red fox in snow","image_urls":["https://example.com/fox.jpg"],"duration":5}}
```

```json
{"provider":"higgsfield","endpoint":"bytedance/seedance-2.5/video-edit","input":{"prompt":"Change the scene to winter","video_url":"https://example.com/source.mp4"}}
```

```json
{"provider":"higgsfield","endpoint":"bytedance/seedance-2.5/video-extend","input":{"prompt":"The fox continues walking","video_url":"https://example.com/source.mp4","duration":5}}
```

## Kling 4.0

`kling-video/v4.0/text-to-video` is catalogue-only. The [recorded catalogue](../tests/fixtures/higgsfield/catalog-models.json) describes video generation; no workflow page or input schema is available. Do not assume Kling 3.0 fields, reference counts, multi-shot structure or speech limits. Exact required fields, resolution/duration limits and an offline-valid minimal request cannot be established. No documented prompting guidance.

The price file records $0.1257 per output second at 720p and $0.1879 at 1080p. These rates do not establish accepted inputs. Kling 4.0 Flash is a separate endpoint (`kling-video/v4.0-flash/text-to-video`) with a recorded $0.94 estimate for the sampled prompt and a $0.094/second list amount; do not substitute that quote for Kling 4.0. Use provider estimate validation or explicitly allow absent-schema execution, plus an appropriate bound whenever the quote is unknown.


## Prepared Genjutsu workflow

Fresh `higgsfield/genjutsu/{object-swap,motion-transfer,restyle}/v1.0` operations require a prepared, approved request. Historical durable jobs without a preparation binding retain their original resume identity. Low-level schema scaffolds remain useful for inspection, but are not fresh-production authorisation. Genjutsu Light has a separate, incomplete contract and is not admitted by this recipe.

### Choose the mode and sources

`pnpm model:prepare --action profile --mode object-swap` (or `motion-transfer`, `restyle`) returns the intent, prerequisites and next commands. `fal:find` and `fal:scaffold` return preparation guidance for each standard Genjutsu endpoint. A local replacement preserving the background chooses object-swap; explicit transfer/rebuilding chooses motion-transfer; restyle requires a current preset UUID. Numeric provider limits remain in the exact schema and existing guards, not duplicated in a second registry.

When no clip is supplied, `pnpm motion:library --action sources` gives research/acquisition routes. Research a shortlist in the requested category and market, then `--action add --project ID --input CANDIDATE.json`; `--action search --project ID --query dance --market US` returns dated local candidates within the default seven-day house window. `MotionCandidateSchema` in `src/types/model-preparation.ts` requires source URL, origin, category/tags, market, observation date, actual trend evidence and an acquisition state. Optional metrics are observations, never invented rankings. Candidate files are immutable: changed evidence or an acquired original uses a new candidate ID. Public-post acquisition returns literal `media:fetch` planning arguments; paid downloading still needs that command's quota/budget. Search and acquisition are distinct.

Higgsfield's Motion Library exists in the web application, but no supported public feed/download API was established from the [published documentation index](https://docs.higgsfield.ai/llms.txt) and [OpenAPI](https://docs.higgsfield.ai/docs/openapi.json), checked 2026-11-15. The restyle presets endpoint lists styles, not trending source clips. Do not invent a library endpoint, use a thumbnail as an original, or assume a web remix grants external reuse rights. An authorised original export can be imported; otherwise leave acquisition pending. [TikTok's public trends view](https://ads.tiktok.com/creative/creativeCenter/trends/video) can inform research; a discovered post is not a reuse licence. Licensed stock or a newly recorded performance is an alternative, not evidence of a current trend.

### Prepare the source and references

Import originals with `asset:import`. Resolve approved entity revisions and semantic roles with `entity:card`. Character references require documented likeness consent, or explicit not-applicable for an invented identity. A card is metadata; individual image files are the provider attachments. Use a clear identity reference for a simple swap and complementary, consistent angles when the source turns or changes framing. Do not automatically attach a composite contact sheet as several people. The 512-pixel short-edge recommendation is a house review aid, not a provider minimum; low-resolution references warn and still require an explicit detail review.

Write a strict `ModelPreparationSpec` (schema: `src/types/model-preparation.ts`). Example structure, with imported IDs and approved revisions substituted before use:

```text
{
  "schemaVersion": 1,
  "id": "football-face-v1",
  "mode": "object-swap",
  "sourceAssetId": "sha256:<64 hexadecimal characters>",
  "segment": { "startSec": 2, "durationSec": 8 },
  "references": [
    { "kind": "character", "entityId": "hero", "revision": 1, "role": "front" },
    { "kind": "character", "entityId": "hero", "revision": 1, "role": "profile" }
  ],
  "target": {
    "description": "the face of the man in the long olive-green outfit and headwear",
    "change": "Replace only his facial identity with the approved hero identity.",
    "preserve": ["his clothing and sunglasses", "movement and camera", "football, lighting and background"],
    "otherSubjects": ["the uniformed player beside him"]
  },
  "resolution": "1080p",
  "useMarkers": true,
  "audioPolicy": "mute"
}
```

For motion-transfer, describe the new scene and appearance in `target.change`, retaining source motion/camera in `preserve`. For restyle, add `presetId` from the current cache, allow zero to five character images, and specify retained composition/motion. `segment.crop` optionally takes even `x`, `y`, `width`, `height` within the displayed source. Choose audio deliberately: `preserve-source`, `mute`, or `replace-in-edit`. Muting/replacement strips audio from the prepared provider input; replacement is completed and checked in the existing edit/mix flow.

`pnpm model:prepare --project ID --action prepare --spec SPEC.json` retains the original and makes a separately imported MP4 derivative from the selected in/out points and crop, without upscaling. It measures the actual source and derivative, checks the exact model schema/guards, pins card versions and ordered references, and writes `pipeline/model-preparations/PREPARATION/`: `receipt.json`, `request.json`, sampled source/reference images, `board.html` and an uncompleted `visual-review-template.json`. The preparation never generates media through a provider. Review the full source, not just three samples. A project-local lock prevents concurrent preparation; immutable outputs are never overwritten. A changed spec uses a new ID. Prepared inline references have a 256 MiB aggregate harness bound; ordinary requests retain the previous 32 MiB bound. Oversized inputs require smaller prepared originals.

### Marker prompting

Prefer **`@Video1`, `@Image1`, `@Image2`, …** wherever applicable. This is a house prompt convention that has worked in practice; it is not a documented provider guarantee or a universal model syntax. `@Video1` always names the prepared derivative, and `@ImageN` names `image_urls[N - 1]`, never an entity database index. The generator composes explicit reference bindings from the pinned roles, target/change, invariants and other subjects. Guards reject out-of-range/zero markers, including references to a second video. `useMarkers: false` is an explicit compatibility option; the default and agent guidance use markers. Never transfer this syntax to a different model without evidence.

A generated prompt begins, for example: `In @Video1, change only the face of the man in the long olive-green outfit. Replace only his facial identity. Reference bindings: @Image1 (hero, front); @Image2 (hero, profile). Preserve: his clothing; source movement; background. Do not alter these other subjects: the uniformed player.` A marker identifies an attachment; it is not a tracked mask and cannot guarantee perfect preservation.

### Rights, review and execution

Complete a separate visual-review JSON from the template after inspecting the board and source: name the reviewer/evidence, confirm readable motion and an unambiguous target, and assess each exact reference hash in order for identity consistency, detail and suitable angle. These are supplied observations, not automatic identity scores.

Record the user's actual source-use authorisation:

```bash
pnpm film:rights --project ID --preparation PREPARATION --status licensed --answer "USER_WORDS" --allow-processing --evidence "LICENCE_OR_OWNER_EVIDENCE" --placements tiktok,instagram-reels --commercial --audio-rights muted
pnpm model:prepare --project ID --action approve --id PREPARATION --review REVIEW.json --answer "USER_WORDS"
pnpm model:prepare --project ID --action check --id PREPARATION
pnpm hf:quote --project ID --request public/projects/ID/pipeline/model-preparations/PREPARATION/request.json
pnpm generate:model --project ID --request public/projects/ID/pipeline/model-preparations/PREPARATION/request.json --output public/projects/ID/assets/remix.mp4 --dry-run
```

`--status owned|licensed|study-only` covers the original video and all ordered image references. Processing permission is explicit; study-only cannot pass publication. Retained source audio needs owned/licensed audio rights. Record special uses individually with `--advertising`, `--endorsement`, `--standalone-resale` where the supplied permission covers them; these are never inferred from commercial permission. These records and approvals are caller-supplied declarations, not authenticated signatures or independent legal proof. They do not establish that a third party actually granted permission.

Check the exact quote and durable budget, obtain the existing material/spend approval, then execute the same request through `generate:model`. Source-use/input approval does not authorise spending. `context.modelPreparation` binds the preparation ID/hash; retain it in `metadata.operationRequest` for asset plans and optionally `modelPreparation` on a bespoke material item. Both direct generation and asset dispatch reach the same admission gate. Fresh execution validates files, image order, approved card revisions, schema, prompt/input, rights and visual approval before uploads/estimates or reservation. A changed input, schema, board, rights scope or approval requires a new preparation and approval; never change an operation ID merely to retry.

### Result review and delivery

Published originals retain their preparation binding in asset provenance and an exact-hash result receipt. Run `model:prepare --action result-board --project ID --id PREPARATION --result PATH` for measured result frames and a review template. Inspect the whole result alongside the original: identity through turns/occlusions, motion/camera, preserved scene elements, other subjects, temporal consistency and audio. Record the completed assessment with `--action review-result --review RESULT_REVIEW.json`. A `repair` or `reshoot` verdict cannot pass delivery; reshoots need the user's decision and a new authorised attempt. Reviews are immutable and exact-byte-bound. Audio marked `replace-in-edit` requires a bound final `audioMaster` and `loudness.audioRequired: true`, or the existing checked native-platform audio handoff; a silent final render cannot silently satisfy it.

Strict delivery follows the generated asset's preparation provenance, requires a passing result review and source-use permissions covering every placement and effective special use, and blocks study-only sources. An unrelated final-output rights review cannot erase a missing Genjutsu source/result review. Local fixture coverage proves preparation, pinning and admission behaviour; live generation and subjective creative quality remain unverified until a separately authorised trial.

Delivery also follows `referenceAssetIds` through edited derivatives and chained remixes, rejects cycles/missing ancestors, and checks each upstream prepared result. A later owned declaration cannot erase an earlier study-only restriction. In bespoke projects, retained preparation originals are covered only by current exact-input source-use approval; entity JSON/HTML is snapshot-bound creative evidence, while media remains subject to rights review.

For detailed motion and occlusion review, `result-board` returns literal `vision:pack` arguments for the prepared source and result. Follow [agent vision](agent-vision.md): verify each manifest with `vision:inspect` and open actual PNG pages/full frames, then cite source hashes and frame IDs in review evidence. A path or a manifest alone is not a visual inspection. Preparation normalises sample aspect, CFR cadence and video time origin; a nonconforming provider result must be conformed through the existing media workflow before exact-frame packs are asserted.

### Remote Genjutsu source

A supplied direct file link or public page first goes through `hf:media --action resolve`, then `--action acquire` as described in [public content links](higgsfield.md#public-content-links-and-checked-remote-originals). Use its imported `assetId` as `sourceAssetId` and its receipt `binding` as optional `remoteSource` in `ModelPreparationSpec`. Select the entire measured clip (`startSec: 0`, exact measured `durationSec`), with no crop. Preserve source audio when present; a silent original can use any audio policy. The original must already have square pixels, unrotated geometry and a measured zero-origin CFR clock. All existing exact endpoint limits still apply.

In this mode `model:prepare` samples and reviews the imported original, retains its hash as `preparedSource`, and emits the original external `video_url` plus `context.remoteMedia`. It does not transcode or upload that video. References remain ordered approved entity images, with the preferred **@Video1, @Image1, @Image2, …** convention unchanged. Source-use permissions, input approval, budget and exact-result QA still apply. A remote source requiring a shorter segment, geometry normalisation, crop or changed audio is refused with instructions to omit `remoteSource`; local preparation then creates the intended derivative. The recipe never passes the unmodified full URL while claiming that a crop or audio change was made.

Receipts and measurements are checked offline during planning. Before a fresh estimate/submit the external bytes are checked again; changed, inaccessible or explicitly expiring links stop before provider processing. Known queued jobs retain their remote binding and original lineage on resume without depending on the source link remaining available. A generic `hf:media --action bind` cannot change an already prepared request. A new remote URL requires a new receipt and preparation/approval revision.

Motion candidates may use `acquisition: "public-link"` to return `hf:media --action resolve` arguments. Once acquired, a new candidate can include `assetId` and `remoteMedia` with the exact receipt binding; its next action supplies `remoteSource`. A dynamic Higgsfield card with no exposed public original remains pending or uses an authorised export; there is still no claimed automatic library feed.
