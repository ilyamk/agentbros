# Higgsfield
For production recommendations use `pnpm models:pick --task TASK` or a use case/slot from [the slot guide](model-slots-guide.md). The endpoint names below document provider contracts, prompting syntax and historical verification.


Last updated: 2026-11-15

Higgsfield is indexed separately from fal. Every lookup uses `(provider, endpoint)` because shared IDs can have different request schemas. For example, Seedance 2.5 reference-to-video takes integer duration at Higgsfield and a string enum at fal.

## Catalogue

Sources recorded on 2026-11-15:

- Public [video](https://docs.higgsfield.ai/docs/models/video-generation.md) and [image](https://docs.higgsfield.ai/docs/models/image-generation.md) documentation link to 36 family pages and 84 workflow pages. Complete JSON Schema fences supply request contracts; usage notes preserve additional limits. Soul ID uses `v1/custom-references` with training transport.
- The anonymous public catalogue at `https://dash.higgsfield.ai/api/v2/catalog-models/?page_size=100` supplies family descriptions, companies, release dates, exclusivity, output types and tags. Its primary price is retained by the parser for the pricing workstream; catalogue entries have `price: null`. Catalogue workflow products such as product-shots annotate their existing mode with tags.

```bash
pnpm hf:sync --from-fixtures tests/fixtures/higgsfield
pnpm hf:sync --from-fixtures tests/fixtures/higgsfield --dry-run
pnpm hf:sync --resume
```

The first two commands are offline. The network form is maintenance for a network-authorised orchestrator: anonymous GETs only, no credentials or generation. It traverses the public documentation and paginated catalogue. Catalogue failure warns and preserves previous catalogue-only entries while refreshing documentation; only complete enumeration can mark them gone; documentation failure aborts before publishing an index. Transient failures and server errors retry with capped backoff. HTTP 429 honours Retry-After; a wait over 60 seconds returns RATE_LIMIT. Successful GETs are checkpointed under the git-ignored `.cache/hf-sync/<date>/`; `--resume` reuses those pages. A dry run writes nothing, including checkpoints.

The validated, sorted index is `src/lib/models/hf-catalog/<category>.json`, with file-level `provider: "higgsfield"`. Input schemas are tracked as `src/lib/providers/schemas/higgsfield/<sha256>.json`, hashed from canonical JSON of the input schema. Identical schemas share a file; provider snapshot resolution retains the requested endpoint identity. Sync removes unreferenced hashes, retains gone entries with their frozen pins, and writes added/gone/schema-change/newly-observed-release evidence to the drift report. Category counts cover active entries.

All entries start at tier `discovered`. Only an exact reviewed hash pin in `src/lib/models/hf-verified.json` makes an entry `verified`. The pins file is intentionally empty until wave 2. Sync never infers verification from documentation, popularity or price.

The fixture sync produces 88 endpoints: 84 documented workflows and four schema-less, discovered endpoints from families without documentation:

| Family | Endpoint |
|---|---|
| Genjutsu Light | `higgsfield/genjutsu-light/motion-transfer/v1.0` |
| Kling 4.0 | `kling-video/v4.0/text-to-video` |
| Kling 4.0 Flash | `kling-video/v4.0-flash/text-to-video` |
| AI Influencer | `higgsfield/ai-influencer` |

The legacy typo prefix `higgsfiled/` is excluded. Schema-less inventory does not establish an executable request contract. Offline fixtures establish local parsing and validation only; transport, pricing, live acceptance and wave 2 verification remain separate work.

Higgsfield endpoint requests use `provider: "higgsfield"` with `generate:model`. Planning reads the provider-specific tracked schema and runs the shared validator and guards. It never substitutes a fal schema or price. Unknown prices require an explicitly authorised positive `--max-cost-usd`; this bounds local admission, not provider billing.

## Workflows and prompting

See [Higgsfield workflows and prompting](higgsfield-prompting.md) for exact inputs, usage-note limits, price bases, schema-tested requests and required entity consent/film rights checks. Provider-scoped guards enforce measured Genjutsu source limits, restyle presets, Cinema reference tokens, Soul character strength and Marketing image formats. Missing media measurements warn; account ownership, training completion and Marketing preset existence need provider verification.

`pnpm hf:sync --presets` refreshes only `src/lib/models/hf-restyle-presets.json` using the credentialled client's `restylePresets()`. It skips without a key. `--from-fixtures tests/fixtures/higgsfield` is offline; `--dry-run` never writes. The cache stores only `{asOf, presets:[{id,name}]}`; `AGENTBROS_HF_RESTYLE_PRESETS` redirects it for isolated tests. Unknown preset IDs fail with the refresh command; a cache older than 30 days warns.

Schema-less catalogue entries plan with `verification.schema:false` and are not executable by default. `generate:model --provider-estimate` validates the exact input with the free estimate API before executing; `--allow-unvalidated` explicitly accepts the absent schema. Dry-run remains offline, so the estimate flag does not validate then. A numeric provider estimate supplies the admitted request price; a description needs a supported tariff calculation or a positive `--max-cost-usd` bound. Genjutsu Light has no documented usage-note duration limits; its catalogue description's first-15-seconds behaviour does not establish Genjutsu's limits.

Soul ID (`v1/custom-references`) plans as nonmedia training. The dedicated durable adapter POSTs the custom-reference route and polls it by ID; completion publishes a training manifest with `customReferenceId`, used later as `custom_reference_id` with the matching Soul family/account. Training inputs must already be public HTTP(S) image URLs; local/imported/data inputs are refused. HTTP 429 returns the same operation to reserved admission and surfaces Retry-After; the caller waits and retries once. No training price or Idempotency-Key support is documented: use an authorised bound, and reconcile ambiguous submissions without an automatic resubmit. Failed training retains liability because its docs do not promise a refund.

The presets module exports `HiggsfieldRestylePresetsSchema`, `hfRestylePresetsPath()`, `loadHiggsfieldRestylePresets(file?)`, `parseHiggsfieldRestylePresets(answer, asOf)` and `syncHiggsfieldRestylePresets({credentials?, fetch?, fixtureFile?, file?, asOf?, dryRun?}?)`. Training exports `HiggsfieldCustomReferenceSchema` and `createHiggsfieldTrainingProvider(client): JobProvider`. The client adds `createCustomReference(input)` and `customReference(id)`. `buildFalOperation(request, {allowUnvalidated?}?)` retains offline planning; its `verification.schema` is boolean, and zero hash bytes mark the absence of a schema (never a reviewed pin). `FalOperationContext.media` additionally accepts optional `contentType` for measured format checks.

## Requests and results

Set `HIGGSFIELD_API_KEY=<id>:<secret>` from https://open.higgsfield.ai/api-keys. Preflight reports presence and format without exposing either part.

Completed requests carry `provider` and `operationId` into the cost ledger; unknown prices remain unknown until reconciled.

For generation queue requests, the durable operation ID is the `Idempotency-Key`. Before the first submit, the runner persists the exact JSON body. A lost response or a restart retries the same bytes and key. A 422 idempotency mismatch retains liability and stops automatic retries: never generate a replacement key automatically. fal retains its existing ambiguous-submit reconciliation behaviour.

Imported `asset://` references are resolved locally to inline media, then uploaded with a presigned PUT. No credentials go to the upload host. Both estimates and submissions reject data URIs at the transport boundary. Accepted upload types are JPEG, PNG, WebP, GIF, WAV and MP4; other image/audio/video formats are converted locally with ffmpeg first.

Estimates and jobs share `pipeline/higgsfield-uploads.json` per project. Its validated entries are keyed by the original source SHA-256 and content type after conversion, and store `{publicUrl, uploadedAt}`. Writes use an atomic rename and a separate upload lease; symlink escapes are refused. The recorded upload contract documents no expiry for these public URLs, so the file records `expiry: "unknown"`. A hit is reused indefinitely; only a missing entry triggers an upload. The job still persists its own `{sourceSha256, publicUrl, contentType}` uploads and frozen request body before submit.

On a fresh, non-dry-run `generate:model --provider-estimate`, uploads complete before the free estimate and before any reservation or job exists. The estimate supplies validation and admission pricing for the prepared public-URL input. The job prepares again from the same cache and asserts byte identity with the estimate. The optional durable `preparedInputHash` binds pricing evidence to those provider bytes while the original `inputHash` and operation ID retain their source identity for historical resume. Resuming a job uses its stored quote and body without another estimate. Any estimate error, including HTTP 413 (`VALIDATION`), leaves no new job, reservation or charge; completed free uploads may remain cached.

`hf:quote --provider-estimate --project ID` uses the same preparation and cache. Without `--project`, imported, local and inline media are refused with `INVALID_INPUT`; public HTTP(S) references pass through. Dry-run generation and offline quotes make no uploads or provider requests. These behaviours are verified with injected fetches, not live calls.

`queued` and `in_progress` map to queued/running. A `completed` status contains the result itself: `images`, `video`, `audio` or `audios`. `failed`, `nsfw` and `canceled` are refunded terminal failures: the reservation is released and the cost ledger records $0. Moderation failures report “rejected by content moderation (nsfw)”.

Completed files expire after seven days. Publication downloads them immediately and retains the provider's `expires_at` in publication metadata. An interrupted or refused download retains the result, so resume publishes without another submit.

Result downloads require HTTPS and the provider-specific allowlist in `HIGGSFIELD_RESULT_HOSTS`: `cdn.higgsfield.ai`, `static-public-media.higgsfield.ai` and `d28lhcrx5qdowv.cloudfront.net`. These hosts are evidenced by recorded preview fixtures; they do not establish a live generation result host. The orchestrator adds the exact host observed during the authorised live test. An unknown host is refused, with the completed job left resumable after review and an allowlist update.

Offline fixture tests establish transport and recovery contracts only; no live request, billing or output acceptance is claimed.

## Integration API

The client module exports `parseHiggsfieldKey(value: string | undefined): {id: string; secret: string}`, `validHiggsfieldRequestUrl(value: unknown, requestId: string, kind: 'status' | 'cancel'): string | undefined`, and `createHiggsfieldClient({credentials, fetch?, timeoutMs?}): HiggsfieldClient`.

The returned client's asynchronous methods are `submit(endpoint, input, {idempotencyKey, expiresAfterSec?, body?})`, `status(statusUrlOrRequestId)`, `cancel(cancelUrlOrRequestId)`, `deleteRequest(requestId)`, `estimate(endpoint, input)`, `usage(params?)`, `restylePresets()`, `createUpload(contentType)` and `putUpload(uploadUrl, headers, bytes)`. JSON responses remain provider-shaped records; upload creation returns `HiggsfieldUpload` (`public_url`, `upload_url`, `upload_headers`). `HiggsfieldUsageParams` accepts optional `start`, `end`, `timeframe`, `model` and `expand`.

Uploads export `prepareHiggsfieldInput(input, {client, uploads, persistUpload, transcode?, cache?, onReferencePrepared?}): Promise<Record<string, unknown>>`, `transcodeHiggsfieldUpload(media: UploadMedia): UploadMedia` and `HIGGSFIELD_UPLOAD_TYPES`. `UploadMedia` holds `contentType` and `bytes: Buffer`. `ProviderUpload` holds `sourceSha256`, `publicUrl` and `contentType`. The optional `onReferencePrepared(source, publicUrl): void` carries measured media context to the uploaded URL for description-based pricing.

`HiggsfieldUploadCache(projectId: string, rootDir?: string)` exposes `file` and `reuse(sourceSha256: string, contentType: string, upload: () => Promise<string>): Promise<string>`. `HiggsfieldUploadCacheSchema` validates the version-1 cache. `assertHiggsfieldPublicInput(value: unknown): void` rejects nested data URIs. `generationRequestBody(value: unknown): string` exports the runner's existing canonical JSON serialisation for estimates and submissions. `ExecutionOptions.higgsfieldEstimateBody?: string` carries the expected bytes into admission and the provider assertion.

`createHiggsfieldJobProvider(client, {transcode?, projectId?, cache?, expectedBody?}?): JobProvider` enables `idempotentSubmit` and `prepareInput`; production execution always supplies `projectId`. The additive submit context is `{operationId, body?}`. Store methods are `rejectHiggsfieldTrainingAdmission(id): GenerationJob` (confirmed custom-reference HTTP 429 only), `persistSubmission(id, {requestBody?, upload?}): GenerationJob`, `confirmNoCharge(id, source): GenerationJob` and `recordProviderCost(id): void`.

Routing uses `ExecutionOptions.providerId?: ProviderId`; existing provider injection remains available. `FalOperationPlan.provider` is `ProviderId`. Result APIs gain provider arguments: `trustedArtifactUrl(value, provider?): URL`, `extractArtifacts(output, result, provider?): ExtractedArtifacts`, `resolveFalSnapshotForPlan(plan)` with an optional provider, and `validateFalOperationResult(endpoint, result, provider?): Record<string, unknown>`. Omitting provider retains fal compatibility. `higgsfieldKeyCheck(value: string | undefined): DoctorCheck` supplies the preflight check.

## Prices and spend

`pnpm hf:pricing --from-fixtures tests/fixtures/higgsfield/estimates.json` converts the recorded free estimate answers and the neighbouring catalogue fixture. `--dry-run` writes nothing. `AGENTBROS_HF_PRICES` redirects the prices file for isolated runs. A catalogue-fetch failure makes the refresh partial: affected endpoints retain historical list evidence while successful estimates are merged, the file's `syncedAt` stays null, and affected checkpoints remain retryable.

`pnpm hf:pricing --sync --sample-image URL --sample-video URL --sample-audio URL` reads the public catalogue and calls the free estimate API with minimal schema inputs. Supply real public media URLs; the tool does not upload files or generate media. Network requests require `HIGGSFIELD_API_KEY=id:secret`. Transient failures retry with bounded backoff and respect `Retry-After`; input errors are recorded without retry. Per-endpoint results, including errors, are appended to `.cache/hf-pricing/<date>.jsonl`. `--resume` skips successful or terminal input-error endpoints with unchanged schema/sample options and retries transient or local construction failures; incomplete final checkpoint writes are discarded. `--as-of YYYY-MM-DD` selects the original sync date when resuming later. Schema-less models use the documented sibling table in `hf-pricing.ts`; Kling 4.0 and Flash instead send the recorded prompt-only input. Soul ID training is skipped with “training; no estimate route”. HTTP 400 detail text is retained in failures and checkpoints after redacting the credential, secret and ID. Failed endpoints retain prior successful price evidence. Authentication or network failures return `partial: true` with `ok: false` and keep `syncedAt` null; terminal input-validation 400s do not fail the run. Corrected sampling logic invalidates older checkpoints.

`pnpm hf:pricing --sync --scenarios --endpoints vendor/model,other/model --resume --sample-image URL --sample-video URL --sample-audio URL` estimates standard scenario inputs. Omit `--endpoints` for the whole catalogue. Category membership in `model-slots.json` selects scenario IDs from `price-scenarios.json`, including both audio states. Requests use schema-valid controls and required sample inputs at concurrency two, with three total attempts for transient failures. Unsupported controls/ranges and missing samples are recorded as skips without calling the API. A K-resolution enum does not establish decimal megapixels; sample URLs do not establish measured source duration. Those quantities remain skipped when no exact schema control or measurement is available. This command never uploads or generates media.

Scenario checkpoints live in `.cache/hf-pricing/scenarios-<date>.jsonl`. Each attempted request carries an `inputKey` for the full canonical request; every endpoint/scenario has a fingerprint covering schema, samples and setting. Same-day `--resume` restores successes and skips with matching fingerprints, retries failures and discards a torn final line. Previous estimates, unmatched tiers and unselected endpoints survive partial runs; failures set `syncedAt` to null. Metadata reports actual estimate `requests` including retries, `resumed`, per-scenario `success`/`skip`/`fail` counts and individual results. A description-only response is retained as a description, never relabelled as an exact numeric estimate. `--dry-run` still makes free requests but writes neither prices nor checkpoints.

Add `--check-usage` to collect `usageBefore` through the existing read-only `/models/usage` analytics before any estimates. It contains the selected UTC date, observation time, cost and per-model quantities/costs. Read the same date with `summariseHiggsfieldUsage` afterwards to compare. These are account-wide analytics, not billing proof: unrelated concurrent activity and reporting delays prevent attributing a difference solely to the estimate run. Usage requests are separate from the estimate `requests` count.

Exact estimates retain the complete input, including prompt, media and image size. Discovery must build that same input with `higgsfieldScenarioInput(entry, setting, samples)`; omitting required fields cannot match. The current discovery caller still projects controls/defaults only, so endpoints with required non-default prompt/media still need that caller integration. No approximate input match is allowed in quotes or budget admission.

`pnpm hf:quote --request REQUEST.json` quotes offline from `src/lib/models/hf-prices.json`. Requests use `{ "provider": "higgsfield", "endpoint": "vendor/model/operation", "input": {} }`. With `--project ID`, imported `asset://sha256/HASH` references supply their measured duration, width and height from the asset registry, taking precedence over supplied metadata for those references. Remote URLs require explicit `context.media`; quoting never fetches or measures them. Resolution defaults come from the Higgsfield schema. Schema URL length checks use the prospective upload URL for inline media; the original bytes and input hash stay unchanged. The local MCP tool is `avc_hf_quote`; `--provider-estimate` is CLI-only and calls the free estimate API once, returning the answer, updated quote and sealed evidence without changing the tracked prices. The process retains the exact-input answer for admission by `generate:model --provider-estimate`, including schema-backed requests. Resuming an admitted job uses its frozen quote without another estimate call. MCP passes its trusted workspace boundary to `generate:model`; local nested references for either provider must remain inside that boundary after canonical path resolution, including symlinks.

`pnpm hf:pricing --reparse` rebuilds every record's tiers from its stored estimate descriptions without network access; numeric request answers, catalogue observations and dates are preserved. `--dry-run` reports before/after counts without writing. It does not recover failed estimates: those need the next authorised sync.

Description rates must match the measured grammar, including single tiers, 4K and conditional video-input blocks. Reserved `when.$videoInput` is derived from any populated video URL field; image/audio references alone do not select the video-input rate. Source seconds round upwards or to the nearest whole second only when stated, with any stated prepared-source limits: Seedance edit pads to at least four seconds; Genjutsu motion-transfer and object-swap trim to thirty seconds before rounding. Source measurements use `video_url`, or the primary item of `video_urls`; an extension uses the requested duration (including its schema default), never the existing video's length. Explicit multi-shot billing requires schema support and `multi_shots: true`, then sums `multi_prompt[].duration`; missing, inconsistent or unsupported shot fields leave multi-shot quotes unknown. H3 includes five `image_urls` and adds $0.08 for each further image.

For `higgsfield/genjutsu-light/motion-transfer/v1.0` only, output seconds are `ceil(min(measured source duration, 15))`. The recorded catalogue sentence is “Uses the first 15 seconds of the source video and preserves source audio.” Its estimate description bills per output second; the catalogue establishes how that output follows the source. This rule does not apply to sibling endpoints.

Restyle tiers are approximate. Its recorded docs specify source seconds rounded upwards after trimming to 30 seconds. **Approximate tier reservations include a +25% safety margin**, applied to the calculated total before discount selection; quote notes state both the approximation and margin. Sealed evidence records the resulting reservation amount. Cinema Studio retains the full video-token formula and both rates in `unparsed`, but stays unknown because the recorded resolution/aspect-ratio enums have no pixel-dimension mapping. Ads Studio and Marketing Studio retain all token rates and require actual token usage.

Image tiers multiply `num_images`; request-level estimates, including Soul's four-image estimate, are used once and only for matching inputs. Two-duration samples report fixed and per-second components for comparison, without authorising extrapolation. Unmatched inputs, token-metered descriptions and missing measured quantities need an explicitly authorised positive planning bound.

Catalogue amounts qualified “from” are comparison floors, never full request prices. Evidence preserves discounted and undiscounted request amounts. Quote calculations use the full amount when expiry is unknown, falls within one hour, or either observation is older than seven days. Durable admission always reserves the undiscounted liability for a dated discount. Before submitting a legacy discounted job, admission atomically raises its reservation within all policy limits or refuses; operation identity, frozen bytes and quote evidence stay intact. Released or reconciled operations cannot submit again. Prices are estimates, not invoices or provider-enforced spending caps.

`pnpm hf:usage --project ID --start YYYY-MM-DD --end YYYY-MM-DD` reads account-wide daily usage analytics and compares model/day totals with this project's Higgsfield ledger rows. It reports cost and quantity differences, unresolved costs and rows using estimates. **Analytics, not billing:** account activity outside the project can explain differences. No reconciliation result changes receipts, reservations or the ledger. The injected fetch reader validates the recorded paginated `{time_series:[{bucket,results:[{model,quantity,unit_price,cost}]}],total,page,limit}` response; unfamiliar response shapes fail validation for review.

## Library API

In `src/lib/models/hf-pricing.ts`:

| Export | Signature / result |
|---|---|
| `parseHiggsfieldPricing` | `(description: string) → {tiers: HiggsfieldPriceTier[], unparsed?: string}` |
| `higgsfieldPriceRecordFor` | `(endpoint, input, file?) → HiggsfieldPriceRecord \| undefined`; tracked prices supplemented by a free exact-request estimate obtained in this process |
| `higgsfieldPricingFor` | `(record, input, context?: HiggsfieldPricingContext) → HiggsfieldPrice`; a closed pricing definition, source, both amounts and selected estimate/tier |
| `higgsfieldPriceFor` | `(endpoint, input, context?, file?) → HiggsfieldPrice \| undefined`; provider-specific file lookup |
| `hfPricesPath`, `loadHiggsfieldPrices` | `() → string`; `(file?) → ReadonlyMap<string, HiggsfieldPriceRecord>` |
| `serialiseHiggsfieldPrices` | `(records, syncedAt: string \| null) → string`; sorted and schema-validated |
| `higgsfieldPricingSource` | `(endpoint, kind?) → string`; exact source URL |
| `higgsfieldEstimateFromAnswer` | `(input, answer: unknown, observedAt: string) → HiggsfieldEstimate` |
| `separateHiggsfieldDurationCosts` | `(estimates) → {fixedUsd, usdPerSecond} \| undefined`; diagnostic only |
| `minimalHiggsfieldInput` | `(schema: JsonSchema, samples: SampleMedia) → Record<string, unknown>` |
| `higgsfieldCataloguePrices` | `(answer: unknown) → Map<string, {family, list}>`; family and endpoint mappings |
| `higgsfieldPricingRequest` | `(fetch, url, input \| undefined, options?, publicRequest?) → Promise<unknown>`; only the two Higgsfield origins |
| `estimateHiggsfield` | `(endpoint, input, fetch: HiggsfieldFetch, options?) → Promise<HiggsfieldEstimate>` |
| `syncHiggsfieldPrices` | `(endpoints, fetch: HiggsfieldFetch, options?) → Promise<HiggsfieldPricingSyncResult>`; options include samples, catalogue fixture, checkpoint path and resume |
| `higgsfieldScenarioInput` | `(entry, setting, samples) → Record<string, unknown>`; exact schema-valid scenario input, throws when infeasible; `entry.inputSchema` may inject a fixture schema |
| `higgsfieldScenarioPricingFor` | `(record, entry, setting, now?) → HiggsfieldPrice \| undefined`; discovery-only reconstruction of stored sample inputs, requiring full exact equality; quotes/admission keep using `higgsfieldPricingFor` |
| `syncHiggsfieldScenarioEstimates` | `(entries, scenarios, fetch: HiggsfieldFetch, options?)`; merged records, requests, per-scenario counts and individual outcomes; options include samples, previous records, slots, checkpoint/resume, now and concurrency |
| `reparseHiggsfieldPrices` | `(records: readonly HiggsfieldPriceRecord[]) → HiggsfieldPriceRecord[]`; offline tier rebuild |
| `higgsfieldPricesFromFixtures` | `(estimates: unknown, catalogue: unknown) → HiggsfieldPricingSyncResult` |
| `fetchHiggsfieldUsage` | `(fetch: HiggsfieldFetch, options?) → Promise<HiggsfieldUsageRow[]>` |
| `summariseHiggsfieldUsage` | `(date: string, fetch: HiggsfieldFetch, options?)`; read-only dated account totals for before/after evidence |
| `reconcileHiggsfieldUsage` | `(usage, ledger, {start?, end?}?) → {authority, scope, rows}` |

`src/lib/models/pricing-evidence.ts` exports `createHiggsfieldPricingEvidence(record, input, context?, kind?)`, `createHiggsfieldListPricingEvidence(record)`, `validateHiggsfieldPricingEvidence(value, expected?)` and `assertCurrentHiggsfieldPricingEvidence(value, endpoint, file?)`. Creation can return undefined when the evidence cannot bound a request or no list record exists. List evidence is comparison-only. The types module exports the corresponding payload/evidence schemas, digest and `higgsfieldPricingInputHash(input)`.

Shared `quote()` accepts `provider: "higgsfield"`, `providerInput` and `providerContext`. `quoteInputForPlan()` derives these from a Higgsfield plan and schema defaults. A quote covers exactly one physical request; non-default units or multipliers are rejected. Durable reservation checks bind evidence to the exact operation input hash and current schema defaults. For large inline media, compact Higgsfield evidence omits `input`, media keys and the estimate records’ sampled inputs while retaining the full exact `inputHash`. Fresh admission requires the private, copied original input/context/record issued in the current process and rechecks current prices and defaults; an arbitrary compact payload cannot authorise a reservation. Historical resume validates the saved digest and operation binding without that process cache. The existing 32 KiB evidence limit remains. Existing fal evidence schemas and digests retain their historical bytes.

Completed Higgsfield jobs have one ledger writer, deduplicated by operation ID. `estimatedUsd` is the admitted expected quote or the explicit user planning bound, labelled in `notes`; `actualUsd` remains unknown until confirmed. Explicit `--asset-id` values are preserved. The default output identity is project-relative, with a basename fallback for an output outside the project. Publication still follows the shared fal output-path behaviour: relative `--output` paths resolve from the working directory.

`syncFalPrices()` additionally accepts `checkpointFile`, `resume` and `partial`, returning completed/total batch counts, a partial flag and any failure. The CLI persists only completed batches; a partial output keeps the file's `syncedAt` null and reports the partial count in metadata.

## Choosing a model

Start offline with `pnpm fal:find --provider any --task "put my character into this movie clip, vertical, cheap" --explain`. Without `--provider`, discovery defaults to fal when `HIGGSFIELD_API_KEY` is absent and to both providers when present; it reads presence only. Explicit `fal`, `higgsfield` and `any` work independently of credentials. No provider call is made by discovery or scaffolding.

Discovery returns `metadata.match: { matched, via, concepts }` for both providers. Unordered Russian/English concept groups cover generic generation, editing, audio repair, avatars, try-on, structured data and modifiers as well as Genjutsu/Soul/Cinema workflows. With no concept, meaningful lexical overlap across ID, name, tags, family title and description can select best-hit categories; candidates warn `Lexical match only`. No signal returns `ok: true`, `matched: false` in `match`, no candidates, a message and concept/category suggestions with example explicit-filter commands. Rephrase or pass `--category`/`--inputs`/`--outputs`; never choose from an unmatched list. Lexical and unmatched answers offer a `nextActions` memory gap command without writing memory. Thresholds, API compatibility and the [concept inventory](fal-catalogue.md#task-matching-and-no-match) are shared with fal.

Add concepts in `src/lib/models/fal-task-map.ts` using actual catalogue terms, plus ru/en golden phrasings. `tests/fal-task-coverage.test.ts` checks schema categories, curation roles and raw categories in both tracked catalogues; a refresh adding a category requires a concept. `tests/fal-task-golden.test.ts` checks phrasings and fixture rankings; `tests/fal-find-match.test.ts` checks honest no-match and lexical fallback.

Each candidate names its provider, release date (null means unknown), reasons, tier, price kind and next commands. Curation is keyed by provider and endpoint in `fal-curation.json` and `hf-curation.json`, reviewed on 2026-11-15 against catalogue descriptions and usage notes. It covers Genjutsu motion transfer/object swap/restyle, Genjutsu Light, Soul 2/Cinema, AI Influencer, Marketing Studio, Ads Studio, Cinema Studio, Seedance 2.5 and Kling 3/4. These are workflow matches, not measured quality claims. Exclusive status adds a small bonus only with a curated role match. Release dates add a small bonus within the same family or curated role; fal's `firstSeen` is a discovery date, not a release date, so fal receives no release bonus or penalty.

Prices are labelled exact request estimates, tiered request estimates, `from $X (floor)`, or unknown. A floor never qualifies for `--max-usd` admission or savings. Unknown prices never count as cheap. Source-duration workflows need measured source metadata; the finder does not infer those seconds from a requested output duration. For Genjutsu, vertical aspect and duration follow the source: prepare and measure the source clip first. Strict production filtering remains available with `--min-tier verified`; current unverified Higgsfield rows will be excluded.

Shared endpoint IDs appear with an `equivalents` group containing both providers and prices. `pnpm models:compare --resolution 720p --duration 5` also lists identical IDs and a tested explicit table of four Kling 3 standard/pro text/image pairs. `--category` and `--endpoint` restrict the results. Each member carries price evidence date and kind, unit rate and request total. Savings require exact comparable request totals, supported explicit parameters and matching audio defaults. Otherwise the cheaper provider and savings remain null. Schemas differ: always scaffold separately per provider, even for an identical ID. Offline price evidence is planning information, not an invoice.

The loop is `fal:find --provider any` → `fal:scaffold --provider higgsfield|fal` → `hf:quote` or `fal:quote --project ID` → `generate:model --dry-run`. Fill placeholders before quoting. Requests must retain their `provider`. Review consent/rights, quote and durable budget before any authorised generation. See [prompting guidance](higgsfield-prompting.md).

### Replace a person in a clip

Record `entity:card` consent and `film:rights --preparation ID` source-use rights for real people and third-party clips before provider processing. Use object-swap for local character/person replacement that preserves the scene, motion-transfer for rebuilding around source movement, and restyle for a selected style preset. Standard Genjutsu production first follows the [prepared input recipe](higgsfield-prompting.md#prepared-genjutsu-workflow): measured source segment, approved image roles, preferred @Video1/@Image1 markers, source-use rights, visual approval and a hash-bound request. Schema scaffolds below inspect the low-level API shape; they do not authorise fresh execution.

```bash
pnpm fal:find --provider any --task "replace a person in a video, vertical, cheap" --explain
pnpm fal:scaffold --provider higgsfield --endpoint higgsfield/genjutsu/motion-transfer/v1.0 --out /tmp/character-request.json
pnpm hf:quote --request /tmp/character-request.json
pnpm generate:model --request /tmp/character-request.json --project ID --output OUTPUT.mp4 --dry-run
```

Fill `video_url` and `image_urls` with the authorised originals, choose a supported resolution and add `context.media` with the exact source URL's measured `durationSec`. The source sets the crop and timing. Local quoting uses source seconds only when measured. In an authorised network session, `pnpm hf:quote --request /tmp/character-request.json --provider-estimate` validates the body with the free `/estimate` API before a paid operation is considered.

Genjutsu Light is **catalogue-only, no schema, tier discovered**. `--include-schemaless` shows it and its release date (2026-10-20), description and warnings. It preserves source audio and uses the first 15 source seconds according to the catalogue. It cannot be scaffolded using the Genjutsu schema: validate a separately prepared request through `/estimate` (`hf:quote --provider-estimate`), or wait for the schema. For authorised execution, `generate:model --provider-estimate` uses the answer for validation and pricing; dry-run remains offline and unvalidated. `--allow-unvalidated` is the explicit alternative when a tariff or positive planning bound is available.

### Fashion influencer photo

```bash
pnpm fal:find --provider any --task "make a fashion influencer photo" --explain
pnpm fal:scaffold --provider higgsfield --endpoint higgsfield-ai/soul/v2/standard --out /tmp/persona-request.json
pnpm hf:quote --request /tmp/persona-request.json
pnpm generate:model --request /tmp/persona-request.json --project ID --output OUTPUT.png --dry-run
```

Fill the prompt and select the provider's aspect, resolution, style and batch size fields. Soul 2's catalogue describes portraits and fashion images; Soul Cinema exposes custom-reference controls. AI Influencer makes a character sheet according to its catalogue description and is currently schema-less: inspect it with `--include-schemaless`, then follow the same estimate-or-wait path. A price observed for a different prompt, batch size or body is not an exact price for this request; obtain a matching quote. Pin approved persona references to an entity card before producing variants.

## Keeping models and prices fresh

Run `pnpm models:refresh --dry-run` to list the maintenance steps without network or writes, then `pnpm models:refresh --resume` in a network-authorised session. Refresh weekly and whenever a provider announces a model or tariff change. `--provider fal|higgsfield|all` selects the scope. Anonymous catalogue/schema refreshes need no credentials; fal pricing requires `FAL_KEY`, Higgsfield pricing requires `HIGGSFIELD_API_KEY`. Missing credentials skip pricing visibly. No generation or paid call is part of refresh. On GitHub, `.github/workflows/models-refresh.yml` runs it daily with keys from the `models` environment and opens or updates the `bot/models-refresh` PR for review ([GitHub administration](github.md)).

The umbrella runs `fal:sync --catalog --tier verified --verify-known --report`, `fal:pricing --sync --resume --partial`, `hf:sync` (with `--resume` when requested), and `hf:pricing --sync --resume`. Pass `--sample-image URL --sample-video URL --sample-audio URL` to the umbrella for media-input estimate sampling; absent samples remain reported endpoint failures. Failed endpoints retain previous successful estimates with their original evidence dates rather than erasing them. The umbrella marks the price file partially synced for authentication, network or local sampling failures and treats partial pricing results as failed steps and continues other steps.

`out/qa/model-refresh/model-refresh.md` and JSON metadata report each step, newly observed models with release dates, retiring/gone rows, price changes beyond 1%, catalogue and estimate sales with known/unknown expiry, and exact cross-provider savings at 720p/5 seconds. fal's tracked price format has no sale/expiry fields, so no fal discounts are inferred. Unknown expiry is not proof a sale is still active. Partial failure returns `ok: false` with successful step metadata retained. Refresh is CLI-only network maintenance; `avc_models_compare` and provider-aware `avc_fal_find` / `avc_fal_scaffold` are local MCP tools.

Discovery API: `findFalEndpoints(query, {catalog?, now?, env?, hfPrices?}?)` returns provider-tagged `FalFindCandidate[]`; `defaultFindProvider(env?)` chooses the default; `loadModelCuration()` returns tuple-keyed entries. `modelChoicePrice(entry, parameters?, {now?, hfPrices?}?)` returns a labelled `ModelChoicePrice`. `compareModels(query?, {fal?, higgsfield?, hfPrices?, now?}?)` returns `ModelsComparison[]`; the explicit pair table is `MODEL_EQUIVALENTS`. `refreshModels(query, dependencies)` accepts injected `runStep`, snapshot, comparison and report writers; `modelRefreshSteps(query?, env?)` lists credential-aware steps. `hf:sync` additionally returns `cataloguePricing` family observations so anonymous catalogue sales remain reportable even without pricing credentials.

Daily model refresh proposes slot successors and flags stale/retiring entries for owner review; see [Freshness](model-slots-guide.md#freshness).

## Public content links and checked remote originals

`hf:media` bridges a supplied page or direct file URL to the existing generation workflow. It does not enumerate the Higgsfield Motion Library, use browser cookies or infer private endpoints. Direct public HTTP(S) references already pass through the provider without uploading; page URLs need resolving first. Inspect the exact cached fields with `pnpm hf:media --action capabilities`: models without schemas remain explicitly unavailable for field binding.

```bash
pnpm hf:media --action resolve --url 'https://example.com/post' --kind video
pnpm hf:media --action acquire --project ID --id original-v1 --url 'https://example.com/post' --media-url 'https://cdn.example.com/original.mp4' --kind video
pnpm hf:media --action bind --project ID --id original-v1 --sha256 RECEIPT_SHA --request REQUEST.json --field /video_url --out BOUND.json
pnpm generate:model --project ID --request BOUND.json --output public/projects/ID/assets/result.mp4 --dry-run
```

`resolve` inspects bounded static OG/native media/JSON-LD metadata and returns candidates, without executing scripts. Multiple candidates require explicit selection. A dynamic/login-only Motion Library page can expose no original: supply a permitted direct original URL/export, or use the existing `media:fetch` route for a supported public post. A thumbnail, preview or generative remix result is not automatically the original or permission to reuse it. No external acquisition or live account acceptance is claimed by the offline tests.

`acquire` downloads an original for inspection, imports its immutable bytes and saves `pipeline/remote-media/ID.json` with source/media URLs, hash, MIME, measured geometry/duration/FPS and optional known `--expires-at`. The returned `binding` is `{id, sha256}` of that receipt, distinct from the media checksum. Repeating the same ID reuses it; changed sources use a new ID. Optional `--max-bytes` defaults to 256 MiB and cannot exceed 512 MiB. Fetching uses the existing DNS-pinned public network transport, with redirect validation and bounded reads; credentials, private destinations and remote FFmpeg inputs are refused. Rights remain unknown, including when an original is hosted by Higgsfield.

`bind` uses a JSON pointer relative to `input`, such as `/image_urls/0`, `/first_frame_url` or `/input_images/0/image_url`. Initialise parent objects/arrays in the endpoint scaffold. Only documented URL fields can be bound, image/video/audio kinds must match, and the completed request must validate. Bind further references into a new request revision. `context.remoteMedia` is harness metadata; it is never sent as a provider input. Local originals remain in the asset registry and generated outputs retain their reference IDs. Soul ID keeps its separate training transport, with direct public nested image URLs and no invented training upload support.

Before a provider estimate or fresh submission, checked URLs are read again and must match the approved bytes. Known URLs expiring within 60 seconds fail; availability after this check and the provider's later fetch are not guaranteed. Polling a queued/running request uses its saved identity and does not re-fetch an expired input URL. Retries retain the original URL, receipt and operation ID; changed or expired sources need a new receipt/request and any applicable approvals, never a silently rewritten paid operation. Direct URLs supplied without receipts retain the existing unverified-remote contract and do not acquire measured evidence or rights by themselves.

This avoids **reuploading** suitable remote originals; it does not avoid downloading them locally for inspection/revalidation. Media needing transformation uses the existing local derivative/upload route. For Genjutsu, use the [prepared remote-source recipe](higgsfield-prompting.md#remote-genjutsu-source) rather than editing an approved request.
