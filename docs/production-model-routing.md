# Production model routing

This guide is for **new briefs**. Preserve approved legacy projects and their explicit aliases; a model upgrade changes creative output and must be recorded as a new generation revision. The endpoint inventory and bundled OpenAPI snapshots establish schema and local adapter coverage, not live model acceptance. No requests in these examples have been submitted to a provider.

## Select before generating

1. Reuse approved, version-pinned character/object/location/style references and existing media. Import original Codex/Claude image outputs with `pnpm asset:import`; retain their original bytes and harness provenance rather than regenerating them or inventing subscription billing. Record cards using `pnpm entity:card` and reference pins using `pnpm asset:board`.
2. Use permitted stock or local Remotion compositing when it serves the brief. Keep source/licence evidence. Do not send stock queries or provider calls in a no-network/no-spend session.
3. Start with `pnpm models:pick --task TASK --project ID` (or `--use-case ID` / `--slot ID`) for ranked candidates with evidence, class and planning price, then `pnpm fal:scaffold --endpoint ENDPOINT --out REQUEST.json`. Inspect compatible family routing when needed: `pnpm fal:models --local --list --limit 1000`, or `--local --search FAMILY`. Use exact endpoint `--local --info ENDPOINT` to inspect coverage, region, transport and pricing source. Local `--schema ENDPOINT` returns the descriptor and the actual bundled input/output schemas with referenced components. Descriptors include typed `requestRouting` for family, variant, operation, region and transport; copy those routing fields, then supply schema-valid input and validate it using `buildFalOperation` or the dry-run.
4. Write an exact `FalEndpointRequest` (or the compatible legacy `FalOperationRequest`) JSON, then `pnpm generate:model --request REQUEST.json --output public/projects/ID/assets/images/hero.png --project ID --dry-run`. Inspect the returned plan, endpoint, schema hash/date, warnings, quote and `executable`; a successful envelope alone does not mean it is funded or supported for live transport.

The endpoint form works with any catalogue endpoint whose schema is cached:

```json
{"endpoint":"meshy/v7/image-to-3d","input":{"image_url":"https://fal.media/approved-reference.png"}}
```

Optional `transport`, `region` and `context` retain their existing meanings. Dry-run metadata includes `category`, `tier`, `outputKinds`, `mediaKind`, the internal OpenAPI `queuePath`, retirement/replacement information and derived `quoteInput`. A missing schema returns `providerCode: "SCHEMA_NOT_CACHED"` and a `nextAction` naming the schema-sync command; planning never fetches it automatically. Schema coverage and trust tier do not establish live acceptance.

Quotes use explicitly sent output counts/duration, text characters, `image_size` dimensions and measured `context.media[audio_url].durationSec`. Missing measurements stay unknown; schema defaults do not supply a duration. Text/JSON results use the queue executor and publish an immutable manifest in `pipeline/model-results/`. Their `--output` may be any file path under the project: it pins operation identity rather than the manifest destination. Training and Kling voice retain their dedicated nonmedia workflow.

Catalogue training endpoints use the nonmedia executor and immutable `pipeline/model-artifacts/` manifests, including schema-extracted weights/configs for endpoints outside the legacy registry. Training prices remain unknown without an authorised positive `--max-cost-usd`; cached schemas alone do not establish live acceptance.

| Need | Use case / slot and decision |
|---|---|
| Text-heavy hero, product image, precise edit | `text-card` / `image.text-render`, `hero-image` / `image.product`, `edit-image` / `image.edit`; inspect exact sizes, compression, transparency and masks. |
| Context-led illustration or edit | `scene-image` / `image.generate` or `edit-image` / `image.edit`; inspect reference/context limits and exact mask fields. |
| Stylised image, controlled reference workflow | `character-sheet` / `image.character`; `train-identity` / `train.lora` is a separate workflow and result type. |
| Narrative/native-audio clip, references, draft workflow | `b-roll`, `photo-motion`, `reference-shot` / the corresponding `video.*` slots. Check native speech language, duration, reference limits and draft lineage. |
| Detailed motion, controlled camera, premium clip | `reference-shot` / `video.reference-to-video`, `edit-clip` / `video.edit`; verify region and speech policy. Voice cloning has its own `audio.voice-clone` slot. |

Resolve each need with `pnpm models:pick --use-case ID`; the [slot table](model-slots.md) holds the dated ordering and evidence. Check permitted operations through the returned exact endpoint and dry-run. Queue image/video/audio/3D and explicit bounded stream images can use asset dispatch; training, voice and realtime need their dedicated workflow. Gallery edit variants use their exact queue schema. Streaming/realtime schema discovery alone does not prove live acceptance. Do not place nonmedia jobs or realtime session requests in `AssetPlanSchema`.

For HTTP streams, use `pnpm generate:stream --request REQUEST.json --output public/projects/ID/assets/images/hero.png --project ID`: default offline planning, an existing policy and explicit bound before future paid execution. `generate:model` also routes an exact stream request to that adapter. Read [stream recovery](http-stream.md); a complete retained result can publish locally, but an interrupted stream must not reconnect/replay, even with a request ID. For realtime use `pnpm generate:realtime --request SESSION.json` with a strict whole-session quote, concrete seed, one input revision and message/frame/deadline bounds. Read [session association and recovery](realtime-sessions.md); local socket writes are not provider acknowledgements. A changed revision requires a deliberately new session and reservation, never an automatic retry.

## Exact asset-plan handoff

See [modern-asset-plan.json](examples/modern-asset-plan.json) for **three locally validated schema examples**: GPT Image 2.5 flare image, Nano Banana 2.1 image, Seedance 2.5 video. These are unsubmitted planning inputs. The examples intentionally have no invented budget bound: review the quote and authorise spending before fetching.

Use `source: "fal-model"`, a compatible `kind`, and `metadata.operationRequest` containing either request form, including the exact provider `input`. Put the actual prompt in `operationRequest.input.prompt`; a top-level legacy `prompt` does not override it. Keep references inside their endpoint's exact input fields, not generic legacy `referenceImageUrls`. Validate both the asset plan and `buildFalOperation`; the dispatcher checks the kind against the plan's `outputKinds`.

| Asset kind | Required output | Project-relative target folder |
|---|---|---|
| `ai-image`, `meme`, `ai-cutout` | image | `assets/images` |
| `ai-video`, `talking-head-clip` | video | `assets/videos` |
| `ai-audio` | audio | `assets/audio` |
| `ai-3d` | model3d | `assets/3d` |
| `ai-upscale` | image or video | `assets/images` or `assets/videos` |

The new audio, 3D, upscale and cutout kinds require `source: "fal-model"`. Set `targetPath` explicitly, including the output extension. For example, the endpoint request above fits `kind: "ai-3d"` with `targetPath: "assets/3d/object.glb"`.

For endpoints with several output kinds, the CLI selects model3d, video, audio, image, weights, file, text, then JSON, in that order. The asset kind must match that primary output; an accompanying thumbnail does not turn a 3D operation into an image asset.

Record `metadata.operationId` or retain the dispatcher's stable project/asset/revision identity. Record a new `metadata.generationRevision` only for a deliberate newly authorised generation. Never advance it to retry an ambiguous submit. Pin media provenance, approved card versions and audio ownership. Pending/queued/running/unknown jobs remain unfinished; only validated published media counts as done.

Direct `generate:model` can resolve imported immutable `asset://sha256/HASH` references into bounded byte-preserving local inputs. Modern asset-plan dispatch resolves those immutable references during preflight and preserves the original IDs so the CLI re-resolves and pins their provenance. Prefer these imported references; do not substitute local filesystem paths or invent uploads. External HTTP(S)/data inputs still require approved reference provenance and exact media bounds.

## Budget and recovery

Use `pnpm budget --help`, `pnpm budget --project ID` and the dry-run quote; consult `src/lib/pricing.ts`/model registry instead of embedding prices in prompts or markdown. Quotes identify low/expected/high USD, source, date, confidence and bounded status. Unknown prices stay unknown, never zero. FLUX megapixels/reference inputs require the correct dimensions/reference metadata and `--token-forecast` when needed; a single invocation estimate is insufficient.

Tracked exact endpoint tariffs support the four Kling V3 Turbo creation endpoints, O3 pro video reference and create-voice. Generated-second quotes require the explicitly sent output duration; absent, nullable or automatic duration stays unknown even when a public schema describes a default. A helper cannot price five seconds and submit fifteen, or borrow another model's price. Nonmedia voice/training helpers bind the exact registered endpoint, model and result kind to one physical operation; batching requires separate operation identities. Unknown training prices still need an authorised manual bound. Historical resumes reuse their original validated quote and liability, including retired endpoints, without refreshing the price.

For supported fixed-duration Seedance creation/reference requests, use the optional versioned `context.videoForecast` procedure below. First dry-run without the forecast and pin the returned endpoint/schema hash and `metadata.inputHash` after imported references resolve. Record output pixels as explicit sourced planning assumptions and every passed video reference in order with its original-string hash and duration evidence; dry-run again to validate. Do not infer output dimensions from aspect ratio, resolution labels or reference frames. Auto/editing/draft/completion and unresolved tariffs remain unknown. Remote URL hashes pin strings, not remote bytes. Frozen evidence belongs to one operation; changed forecasts require a deliberate new generation revision.

An unknown quote requires an explicitly authorised positive `--max-cost-usd`, or `metadata.maxCostUsd` for asset dispatch. This is a user planning bound, **not a provider-enforced billing cap**. No example assigns one for the user. Check durable commitment, actual reconciled costs, repair reserve, max per job and paid attempts against the configured policy before submitting. `brief.budgetUsd: null` does not disable the default bounded policy.

Resume with the same request, operation ID, output and reference pins. Request IDs and raw results are durable; download/publication failures do not warrant a new submit. Ambiguous paid submits need reconciliation. Estimates are not invoices; leave actual billing unknown until a receipt is supplied. No-live-API runs keep paid generation pending and use existing/imported/local synthetic assets.

Supported bounded queue quotes now include optional immutable tariff evidence: the exact endpoint, public source URL, observation date, currency, unit, conditions, complete pricing definition and canonical digest. Inspect this saved evidence alongside the numeric quote. New reservations validate it against the trusted local descriptor; historical resumes retain their original entire quote even when current rates or endpoint availability change. Unknown/manual quotes and five legacy definitions keep this field absent. Absence is not a free price, and the descriptor is not an invoice, signature or complete calculator replay. HTTP stream and realtime quotes keep their separate contracts.

## Quality tier intent

`fast`: prefer approved reuse, stock and simpler local compositing; choose a modern candidate only after a bounded quote fits. `balanced`: compare exact modern variants for the shot's requirements and budget. `quality`: prioritise reference fidelity, text accuracy, continuity and output quality within the same approved ceiling. None of these tiers hardcodes an old model or guarantees one is cheaper.

## Legacy compatibility

Existing `fal-gpt-image` → GPT Image 2, `fal-flux` → FLUX.1, `fal-bytedance` → Seedance 2 fast (or explicit Seedance 1 override), `fal-kling` → Kling 2.5 and `fal-minimax` → Hailuo remain explicit legacy routes. Historical talking-head lessons still apply to continuity/audio/maths, but their durations, likeness filter observations and endpoint slugs concern those historical model versions. Revalidate them for modern operations rather than extrapolating production acceptance.

Genjutsu preparation (2026-11-15): standard object-swap, motion-transfer and restyle requests use `model:prepare` before fresh execution. Preserve `context.modelPreparation` inside `metadata.operationRequest` (the provider wire input stays unchanged). Follow the [three-mode recipe](higgsfield-prompting.md#prepared-genjutsu-workflow), including preferred @Video1/@Image1 markers, source-use permissions, pinned references and exact-result review. Existing durable jobs without a preparation binding keep their historical resume contract.

Reference packs (2026-11-17, [RFC 0003](rfcs/0003-reference-packs.md)): for a profiled endpoint (`pnpm refs:profiles --action for --endpoint E`), pass `refs:pack --action request`'s `request.json` unchanged, also inside `metadata.operationRequest` (optionally with `metadata.referencePack` set to the same `{id, sha256}`). `generate:model` and the asset dispatcher check the pack's files, the request bytes, the hash and the approval; an unapproved pack is `executable: false` in a dry run and refused on execution. Reference inputs without a pack only warn for now; `AGENTBROS_REFERENCE_PACKS=enforce` refuses them and `off` silences the warning. Prepared requests with `context.modelPreparation` and resumes of existing jobs are exempt. A published output is appended to the pack's `outputs.json`, and `refs:pack --action review-result` reviews only those outputs unless `--allow-foreign-result` is passed.
