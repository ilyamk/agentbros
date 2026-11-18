# fal category and command map

Start with `pnpm models:pick --task TASK --project ID`, inspect `pnpm fal:models --schema ENDPOINT`, then `pnpm fal:scaffold --endpoint ENDPOINT --out REQUEST.json`. Fill placeholders, validate and obtain approval/budget before any paid call. Verified endpoint rows and selection evidence live in [the agent guide](../../../../docs/fal-catalogue.md#verified-endpoints); this map does not freeze a model or tariff.

| Category or need | Recommended route |
|---|---|
| text-to-image, image-to-image; inpaint/outpaint | Endpoint-form request through `pnpm generate:model --request REQUEST.json --project ID --output OUTPUT --dry-run`. Use the exact edit/reference/mask fields. |
| text-to-video, image-to-video, video-to-video, avatar | The same scaffold → endpoint request → `generate:model` loop; preserve reference/media/native-audio constraints. The legacy image/video aliases do not take endpoint overrides. |
| Image cutout | `pnpm rmbg --input INPUT --output OUTPUT --endpoint ENDPOINT --dry-run` |
| Image/video upscale | `pnpm upscale --input INPUT --output OUTPUT --endpoint ENDPOINT --dry-run`; category must match the input media. |
| Video lipsync | `pnpm exec tsx scripts/generate-lipsync.ts --video VIDEO --audio AUDIO --output OUTPUT --endpoint ENDPOINT --dry-run` |
| Frame interpolation | Endpoint-form `generate:model` request; inspect exact FPS/slowdown fields. |
| speech-to-text | `pnpm transcribe --provider fal --endpoint ENDPOINT --input AUDIO --output TRANSCRIPT.json --dry-run`; execution also needs project/budget. The result is normalised to TranscriptSchema. |
| text-to-speech | `pnpm generate:voiceover --provider fal --endpoint ENDPOINT --project ID --dry-run`; scene speech and actual word timings when supplied. |
| Text SFX / video foley | `pnpm sfx:generate --endpoint ENDPOINT --project ID --prompt PROMPT --duration SECONDS --output OUTPUT --dry-run`; add a local video with its video flag for foley. SFX uses its own verified endpoint roles. |
| Music | `pnpm generate:music --provider fal --project ID --model ENDPOINT --dry-run`; music has a separate schema-pinned allow-list. |
| audio-to-audio, speech-to-speech | Endpoint-form `generate:model` requests for stems, denoise and authorised voice conversion. Prose-only audio-to-text uses this route too, not timed transcription. |
| image-to-3d, text-to-3d, 3d-to-3d | Endpoint-form `generate:model`; GLB convention is `assets/3d/NAME.glb`. Asset plans use `ai-3d` and `source: "fal-model"`; non-GLB files remain file publications. |
| worlds | Inspect contracts first. Empty session-offer outputs and absent capture/playback adapters do not establish an executable world route. |
| vision, llm, image/video-to-text, JSON | Endpoint-form `generate:model`; read the immutable analysis manifest using `pnpm model:result --project ID --operation-id OPERATION`. Treat prose/JSON as observations requiring frame checks. |
| training | Endpoint-form `generate:model` through nonmedia admission; one operation per run, unknown price requires an authorised bound. Weights/configs and provenance go to immutable model-artifact manifests; never load pickle weights. |

Utility endpoint overrides accept only active verified endpoints with the corresponding curated role. Scaffolding provides the exact input fields for everything else; never substitute a generic product screen, guessed URL field or another endpoint's schema.

## Trust and price

- `discovered`: inventory entry; strict validation needs its pinned schema. Missing/schema-less entries cannot execute through the queue.
- `priced`: schema and dated price record. Unsupported units or missing quantities can still leave the request unbounded.
- `verified`: reviewed pin, guard, extraction and offline contract tests. Verification is separate from curation and price.
- `live`: accepted real-run receipt; no tracked entry claims this yet.

Unknown price means an explicitly authorised positive `--max-cost-usd` (asset metadata `maxCostUsd`), never zero or a guessed sibling rate. It is a planning bound, not a provider billing cap. For variations use `pnpm fal:quote --spec BATCH.json --project ID`, `pnpm budget --project ID --forecast BATCH.json` and `pnpm fal:batch --spec BATCH.json --project ID --dry-run`; execution additionally needs user approval and an authorised total.

Retiring or gone endpoints need `pnpm fal:doctor --project ID`: inspect replacements and record any deliberate migration. Keep approved legacy projects working and resume historical jobs with frozen quotes. A replacement warning never authorises a new paid operation.

Maintenance, promotion and drift handling: [maintainer guide](../../../../docs/fal-integration.md). Respect no-network/no-spend sessions; missing schemas stay pending until authorised maintenance.

## Higgsfield and cross-provider choice

Use `pnpm models:pick --use-case replace-person`, `--use-case influencer-photo` or `--use-case ad-variant` for character swaps, persona stills and ad images across providers. Compare labelled exact/tiered prices, floors, release dates and reasons; `pnpm models:compare` reports only evidenced equivalent savings. Scaffold with `pnpm fal:scaffold --provider higgsfield --endpoint ENDPOINT --out REQUEST.json`, retain `provider: "higgsfield"`, then `pnpm hf:quote --request REQUEST.json` and the usual `generate:model --dry-run` loop. Never reuse a fal payload for an identical Higgsfield ID. A schema-less proposed candidate needs explicit `/estimate` validation (`hf:quote --provider-estimate`) or a schema; catalogue floors never admit a budget. Real people/third-party clips need `entity:card` consent and `film:rights` first.

Read [Higgsfield model choice and refresh](../../../../docs/higgsfield.md) and [prompting guidance](../../../../docs/higgsfield-prompting.md).
