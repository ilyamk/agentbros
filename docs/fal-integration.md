# fal catalogue integration: maintainer guide

Implemented on 2026-11-15. Agents start with [fal catalogue](fal-catalogue.md); this guide describes the implementation and maintenance procedure. Offline contract coverage does not establish live provider acceptance, creative quality or actual billing.

## Architecture

The public endpoint ID is the primary key. New requests use `{ "endpoint": "vendor/model/operation", "input": {} }`, with optional `transport`, `region` and `context`. The original family/variant/operation request form remains compatible for existing projects.

| Layer | Source and responsibility |
|---|---|
| Contracts | `src/types/fal-catalog.ts`: catalogue, prices, trust, discovery, curation, pins, drift and batch specs; `src/types/generation.ts`: endpoint requests and operation plans |
| Index | `src/lib/models/fal-catalog/<category>.json`, sorted by endpoint; `models/fal-catalog.ts` loads entries and resolves schemas. Removed entries remain indexed with status `gone`. `AGENTBROS_FAL_CATALOG_DIR` overrides the directory for isolated tests. |
| Schema cache | `.cache/fal-schemas/<sha256>.json`, or `AGENTBROS_FAL_SCHEMA_CACHE`. Stores canonical API model objects with volatile listing metadata and retirement/replacement fields removed before hashing. `readCachedApiModel` checks the bytes against the index hash. |
| Snapshots and pins | `providers/schemas/fal-operations.json` retains the 98 original operation snapshots. Endpoint requests resolve these first, then the hash-pinned cache. `models/fal-verified.json` records reviewed catalogue hashes and dates. |
| Prices | `models/fal-prices.json` contains dated Platform API observations; `models/fal-pricing.ts` converts supported units only when category and input quantities agree. Reviewed `models/public-tariffs.ts` rates take precedence over API observations; existing registry definitions remain authoritative for registered models. Unknown units or missing quantities stay unbounded. |
| Curation | `models/fal-curation.json` records sourced role judgements independently of trust and price. `models/fal-task-map.ts` maps Russian/English tasks to candidates. |
| Validation and guards | `providers/fal-operations.ts`: strict JSON Schema validation, semantic plugins in `providers/fal-guards/all.ts` (phase, then registration order), validation again and media limits. The validator supports unions, discriminators, tuple prefixes, nullable fields, formats and object bounds. Measured context supplies file/duration/pixel bounds; absent measurements are not invented. |
| Results | `providers/fal-results.ts` extracts typed artefacts and text/JSON. `assets/inspect.ts` checks media, GLB, UTF-8 and JSON. Downloaded/published files must pass the trusted-host check; other URLs are recorded as `untrustedUrls`. |
| Jobs | `jobs/execution.ts`, `jobs/nonmedia.ts`, `jobs/fal-provider.ts` and `jobs/store.ts`: reserve through `OperationStore.reserveOperation`, persist one submission, recover the same operation and publish immutable results. Provider status/response URLs and queue routes are stored with jobs. |
| Batches | `jobs/batch.ts`: schema-valid variations, one physical operation per identity, aggregate quotes and policy checks, sequential execution and published-job skipping. |

Paths in the table are relative to `src/lib/` unless otherwise stated. Missing cached schemas return `SCHEMA_NOT_CACHED` with a schema-sync next action; planning never fetches them automatically. Schema-less/realtime catalogue entries cannot run through the queue adapter. Dedicated stream and realtime commands retain their separate recovery contracts.

## Trust and promotion

| Tier | Meaning |
|---|---|
| `discovered` | Indexed endpoint; a schema pin permits strict planning when present. Schema-less inventory entries remain at this tier and cannot execute. |
| `priced` | Schema plus a dated price record; that record need not produce a bounded quote for every request. |
| `verified` | Reviewed pin, semantic guard coverage, result extraction and offline fixture contracts. Only this tier or higher is recommended for production discovery. Price may still be unknown. |
| `live` | Requires an accepted real-run receipt under ignored `out/qa/fal-live/`. No tracked entry claims this; the current schema rejects this tier pending receipt support. |

Promote an endpoint using the wave 3 method:

1. Record the API model's exact schema bytes in `tests/fixtures/fal-catalog/schemas/`, and map its endpoint/hash/category in `manifest.json`. Preserve older fixtures; `verifiedSnapshots` can pin a newer contract alongside an existing mapping.
2. Add its reviewed canonical catalogue hash and `since` date to `src/lib/models/fal-verified.json`. A null hash is transitional compatibility support, not completed verification; `--pin-verified` fills only null pins, never changed hashes.
3. Set the matching index entry's tier to `verified` with that schema pin. Trust is assigned by code and reviewed tests, never inferred from popularity or price.
4. Add semantic constraints not represented by JSON Schema to a guard plugin and register it in `providers/fal-guards/all.ts`. Reuse existing category/prefix guards when they cover the contract.
5. Add offline request/result contracts: valid payloads, rejected semantic edges, `unsupportedKeywords()` coverage, extraction and relevant publication/CLI paths. Every new fal test imports `./helpers/fal-no-network` first and uses temporary catalogue/cache directories, never checkout projects or an orchestrator-only cache.
6. Add sourced role curation and any specialised command allow-list entry. Unknown prices need no invented rate: retain the explicit planning-bound requirement.
7. Add a verified row to [the agent guide](fal-catalogue.md#verified-endpoints), including selection evidence, limitations and the offline verification date. Update affected playbooks and run their coverage checks.

A passing fixture does not authorise spending or promote an endpoint to live.

## Sync runbook

These commands contact free read APIs and may write tracked files. Run only in a network-authorised maintenance session; never during offline tests or while another stream owns the same output files.

```bash
pnpm fal:sync --catalog --verify-known --report
pnpm fal:sync --schemas meshy/v7.1/image-to-3d --report
pnpm fal:sync --tier verified --pin-verified --report
pnpm fal:pricing --sync
pnpm fal:pricing --show meshy/v7.1/image-to-3d
pnpm fal:doctor
```

Use one schema selector: `--schemas`, `--tier verified` or `--all`. A full `pnpm fal:sync --catalog --all --report` is slower and fetches at most four schemas concurrently. Listing has a page cap (default 40). Review `written`, `skipped`, `notFound`, `lookupMissing`, `verified` and drift metadata before accepting changes. `--dry-run` computes without writes; network mode is still network mode. Without `--catalog` (2026-11-17), only the category files whose entries changed are rewritten; the others stay byte-identical with their previous `syncedAt`.

Catalogue listing/lookups are deliberately anonymous: authenticated model lookups were observed returning `metadata: null`, losing category/name. Pricing GETs require `FAL_KEY`, batch up to 40 IDs and isolate unknown IDs by splitting failed batches. No generation is part of either sync.

Catalogue requests retry network failures, 429 and server errors up to four times, respecting Retry-After with bounded waits. Pricing retries 429 up to four times; an excessive wait returns `RATE_LIMIT` with `retryAfterMs`. Follow that delay and retry once at the caller level; do not loop indefinitely. Other network/timeouts retain their explicit CLI error codes. Provider pricing estimates are a separate, opt-in free POST through `pnpm fal:quote --project ID --request REQUEST.json --provider-estimate`; they are evidence, not a billing bound, and stay CLI-only.

Offline rehearsal:

```bash
pnpm fal:sync --from-fixtures tests/fixtures/fal-catalog --catalog --all --dry-run
pnpm fal:pricing --from-fixtures tests/fixtures/fal-catalog/pricing.json --dry-run
```

For tests, use `tests/helpers/fal-temp-catalog.ts` (`useTempFalCatalog`) and `AGENTBROS_FAL_PRICES` for temporary prices. Never depend on `.cache/fal-schemas` already existing or rewrite live project data.

## Drift handling

`fal:sync` reports added/gone endpoints, schema changes, retirements, price disagreements and tier demotions. `--report` writes `out/qa/model-refresh/fal-catalog-drift.md`. Review the exact changed bytes and description-only constraints; update guards, fixtures, contracts, curation and the docs row before reviewing a new verified pin. A mismatched hash loses verified status: `catalogTier` falls back to `priced` when a dated price remains, otherwise `discovered`. Sync does not silently advance non-null verified pins.

Reviewed public tariffs are not overwritten by conflicting API prices. Inspect `fal:pricing --show`, the price source, unit/category compatibility and missing quantity evidence before changing any tariff. Training, tokens and compute-based rates remain unknown where no safe conversion exists. An authorised positive `--max-cost-usd` is a planning bound, not a cap on provider invoices. When a model page's per-unit tariff disagrees with the pricing API (for example FLUX-3 first-last-frame draft: page $0.06/s, API $0.03/s), planning uses the higher rate, so a 5 s draft plans at $0.30, and `generate:model --dry-run` reports `metadata.priceDrift` (2026-11-17). Such prices stay planning-only: execution still needs `--max-cost-usd` ([unit semantics](model-slots-guide.md#unit-semantics-from-fal-model-pages)).

Use `pnpm fal:doctor --project ID` to locate retiring/gone references and recorded replacements. Legacy `generate:video` adds these warnings to `metadata.warnings`, but keeps the selected endpoint and payload. Never migrate an approved project or retry to a replacement silently. Historical jobs resume with their frozen quote, request identity and retained liability; changing a pin or current price does not lower old commitments.

Shared quote derivation in `providers/fal-quote-input.ts` resolves duration aliases and `num_samples` (including its pinned schema default), and applies Scribe's 30% keyterm premium. An unresolved sample count leaves the quote unbounded and requires an explicit planning bound. Generated-second execution validates the same duration and sample count. Provider estimates derive units from request quantities and tariff semantics regardless of the quote's evidence source; unsupported units fail rather than defaulting to one.

## API quirks recorded during wave 0

- Public endpoint IDs and OpenAPI paths differ in many fixtures (25 of the initial 54). For example, the public `meshy/v7/image-to-3d` schema uses an internal `/fal-ai/meshy/v7/image-to-3d` route. `snapshotFromOpenApi` matches one body-bearing POST and its request-result GET by shape. Submit uses the public endpoint; polling/results use persisted provider `status_url`/`response_url`. Historical jobs without those URLs retain the `endpointRoot` fallback.
- Some realtime endpoints have no queue schema, such as `kotoba-technologies/kotoba-sts/v1/realtime_voice`. They retain `schema: null` and are not queue-executable. Session-offer worlds with empty output contracts are also not promoted merely because a schema parses.
- Listing and direct lookup disagree in both directions. Listed entries returning 404 stay active and appear in `lookupMissing`; only an entry absent from the listing and confirmed 404 by `--verify-known` becomes `gone`. Active known endpoints missing from the listing are retained through lookup; entries are never deleted just for disappearing from a page.
- Authenticated catalogue lookups can lose metadata; use anonymous reads as above. Presentation fields, account flags, `updated_at`, retirement and replacement do not belong in the schema hash. Cache readers use `cachedApiModelSha256`/canonical bytes, not a hash of the unfiltered API response. Original Python-recorded ASCII fixture serialisation matches canonical JSON; non-ASCII bytes must be hashed exactly as written.
- Trusted-host validation applies to files actually downloaded/published. Weights, generic files and non-GLB model files remain file publications rather than fabricated media asset records. Inspect returned MIME/extension: a field named `model_glb` can contain an OBJ.

The stable read APIs remain `loadCatalog`, `findCatalogEntry`, `readCachedApiModel`, `resolveCatalogSnapshot`, `SchemaNotCachedError`, `schemaCacheDir` and `resetCatalogCache`; OpenAPI helpers remain in `providers/fal-openapi.ts`.

## Jobs, batches and result handoff

An individual plan follows `fal:find` → `fal:scaffold` → `generate:model --dry-run` → quote/budget review → user-authorised execution. Preserve endpoint, schema/input hashes, media provenance, operation ID and quote evidence. Unknown submission outcomes resume/reconcile the same identity; never manufacture a second paid POST.

A batch spec (`FalBatchSpecSchema`) has `version: 1`, `batchId`, `endpoint`, `baseInput`, `variations: [{id, inputPatch}]`, `outputDir` and `assetIdPrefix`; optional fields include `context`, `stage` and positive `maxCostUsdPerOp`. It supports 1–200 unique variations. Each identity is `<batchId>.<variationId>`; a deliberate revision creates new identities.

```bash
pnpm fal:quote --project ID --spec BATCH.json
pnpm budget --project ID --forecast BATCH.json
pnpm fal:batch --project ID --spec BATCH.json --dry-run
pnpm fal:batch --project ID --spec BATCH.json --execute --max-total-usd 10
pnpm fal:batch --project ID --spec BATCH.json --status
```

The execution example needs actual user approval and a fitting authorised total. Quote/forecast are read-only. Batch dry-run materialises immutable local request files without submission; execution requires a fitting aggregate high bound and reserves each operation through the existing job store. `invalid` includes validation/attempt-policy errors; published operations are skipped.

Images/video/audio become inspected assets. GLB goes to `assets/3d/` as `model3d`; other 3D formats and generic files remain files. Analysis text/JSON goes to immutable `pipeline/model-results/<operationId>.json`; `pnpm model:result --project ID --operation-id OPERATION` reads a bounded summary without downloads. Treat analysis as observations to check against frames. Training/voice use `pipeline/model-artifacts/` manifests; downloaded weights/configs retain content hashes and provenance. Individual resumes and batch skips share `jobs/model-artifacts.ts` publication verification: every output and artefact must retain its hash, and artefacts must remain within the project (including symlink containment). Asset plans use exact `metadata.operationRequest` and matching kinds (`ai-image`, `ai-video`, `ai-audio`, `ai-3d`, `ai-upscale`, `ai-cutout`); see [model routing](production-model-routing.md).

## Integrated commands

| Commands | Purpose |
|---|---|
| `fal:find`, `fal:models`, `fal:scaffold` | Offline task ranking, index/schema inspection and request drafts |
| `fal:sync`, `fal:pricing`, `fal:doctor` | Maintenance sync, price observations and local retirement diagnostics |
| `fal:quote`, `fal:batch`, `budget`, `cost:report` | Quotes, N-operation execution, policy/headroom and ledger reports |
| `generate:model`, `model:result` | Endpoint-form generation and local analysis summaries |
| `generate:stream`, `generate:realtime`, `realtime:editor` | Dedicated bounded transports and local revision drafts |
| `rmbg`, `upscale`, `scripts/generate-lipsync.ts` | Existing utilities with verified `--endpoint` overrides; lipsync is invoked through the local TypeScript runner |
| `transcribe --provider fal`, `generate:voiceover --provider fal` | Transcript normalisation and per-scene speech; ElevenLabs remains the default |
| `sfx:generate`, `generate:music --provider fal` | Verified SFX/foley and the separate music allow-list |
| `asset:fetch`, `asset:fetch-all` | Exact modern asset plans and compatible existing aliases |
| `generate:image`, `generate:video` | Legacy generation, retained for existing projects |

Local MCP exposes `avc_fal_find`, `avc_fal_scaffold`, `avc_fal_quote`, `avc_fal_doctor`, `avc_model_result` and capped `avc_models` inspection. `avc_fal_batch` enforces dry-run unless the trusted launcher allows paid calls. Sync/pricing and provider estimates stay CLI-only; doctor cannot take catalogue path overrides. The [command registry](../src/lib/cli/commands.ts) is the integrated alias/spend/tool authority.

`pnpm fal:pricing --sync --resume` skips completed batches in `.cache/fal-pricing/<date>.jsonl`; use the original `--as-of` date to resume later, or `--partial` to write completed observations with a null file `syncedAt` and the partial count in output metadata.
