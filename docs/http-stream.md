# Durable HTTP image streaming

`src/lib/providers/stream/service.ts` implements the six exact FLUX.2 HTTP stream routes from the bundled schema snapshots. This is a dedicated transport, not a queue subscription, realtime WebSocket or a promise of live provider acceptance. Verification is local loopback/contract tested, `live: false`. No fal API/discovery/upload/inference requests were made in implementation or tests.

## Offline planning and explicit execution

```sh
pnpm exec tsx scripts/generate-stream.ts --request stream-request.json --output public/projects/PROJECT/assets/hero.png --project PROJECT
```

The default is **dry-run**, even with `--dry-run=false` unless `--execute` is explicitly supplied. Help/dry-run requires no API credentials and performs no writes or budget reservations. The shared CLI may load a local .env for a default invocation; explicit --dry-run also skips that loading. An exact request uses the normal `FalOperationRequest` fields, for example `family: flux-2`, `variant: dev`, `operation: text-to-image`, `transport: stream`, `input: {prompt: ...}`. Inspect current schemas rather than copying fields from another variant. Existing imported `asset://sha256/HASH` inputs resolve to byte-preserving references with provenance pins.

Real execution is implemented for a later explicitly authorised invocation using `--execute`, an existing configured project budget, credentials and a bounded quote. Unknown stream rates require an explicitly authorised positive `--max-cost-usd`; this planning bound does not limit actual provider charges. The current no-real-API/no-budget instruction prohibits invoking that mode against a provider. Limits can be lowered with `--timeout-ms`, `--idle-ms`, `--max-bytes`; there is no unbounded mode.

The callable service is `executeFalHttpStream(options)` returning `{outputs, metadata}`. It defaults `dryRun` to true. Tests inject a `FalHttpStreamTransport` or fetcher; production creates a fixed HTTPS fal transport, never a configurable credential-bearing server URL. The root `generate-model` router may delegate to this service after resolving exact routing/reference fields; ordinary queue retry remains inappropriate for stream jobs.

## Actual protocol

The protocol was inspected in the installed official `@fal-ai/client` streaming implementation (`src/streaming.js`, `src/request.js`, `src/utils.js`; upstream [fal-js](https://github.com/fal-ai/fal-js)). Server mode uses one POST to `https://fal.run/EXACT-ENDPOINT`, JSON input, `Authorization: Key …`, `Accept: text/event-stream`, and ownership from `x-fal-request-id`. Exact snapshot endpoints already end in `/stream`; it is never appended twice. The service disables redirects and automatic reconnect/retry.

SSE JSON data events support split UTF-8 chunks, CR/LF/CRLF, comments and multiline data. Only clean HTTP EOF establishes the SDK's last-event result. Incomplete events, invalid UTF-8/JSON, arrays, explicit errors, timeouts and cancellation are not final success. `id`/`retry` fields are not proof of a documented replay/resumption API and are not used to reconnect. Non-SSE fallback accepts only supported binary image MIME with clean bounded EOF.

The six stream output snapshots contain an empty output schema. Consequently schema acceptance alone proves no final media shape. Publication requires actual image URLs in `images[].url`, `image.url`, `output.url`, `image_url` or `url`, or a complete binary PNG/JPEG/WebP response. HTTPS URLs must use trusted fal media hosts; inline `data:image/{png,jpeg,webp};base64` is strict, canonical and bounded. Unverified alternate provider event shapes fail with retained liability instead of being fabricated into media. Live acceptance and any undocumented model-specific event format still need future authorised verification.

## Ownership, checkpoints and release

Durable reservation, original endpoint/input hash/publication binding and exclusive operation lease precede the charged connect. The store records send intent before POST and request ownership as soon as headers arrive. If the provider omits its ID, no ID is fabricated: the job stays submitting until a complete checksum-bound local streamProof permits result publication. Stream jobs use provider `fal-stream`; absence of a provider ID never grants remote replay authority.

Raw bytes, last-event checkpoints, inspected media cache and source/hash index are fsynced under private `.cache/paid-responses/PROJECT/streams/OPERATION-HASH/`, with restrictive file permissions, bounded buffers and path/symlink guards. They are never exposed as public project assets. Parser processing waits for checkpoint writes before reading further, avoiding an unbounded event queue. Default bounds: 64 MiB response/aggregate media, 16 MiB event, 1,000 events, 180 seconds total and 30 seconds idle. Hard ceilings are 128 MiB total, 32 MiB event, 10,000 events and 30 minutes for timeouts. Image decode also caps each edge at 16,384 and pixels at 64 million.

Clean final results enter `result-ready`; actual bytes undergo ffprobe plus full ffmpeg decode, MIME/extension checks and immutable asset import before atomic output publication. Cached media is source/checksum pinned. Published/validated resumes verify every output hash; changed outputs cannot silently pass. Download/publication failures retry the retained local result without charged reconnect. A complete checksum-verified raw spool can reconstruct a result after a lost final journal commit; reconstruction re-parses the actual raw stream instead of trusting edited checkpoint result fields.

Interrupted charged streams become `unknown`, retain budget liability and refuse automatic paid replay even when a provider request ID exists. Subsequent calls report `reconcile-stream-no-reconnect`. A new operation targeting the same ambiguous asset remains blocked by the shared attempt policy. No refund, no-charge status, final cost or invoice is inferred from HTTP errors, cancellation, silence or publication. Only supplied real billing receipts reconcile through the shared budget tooling.

## Local verification

```sh
pnpm exec tsx --test tests/http-stream.test.ts
pnpm exec tsc --noEmit
pnpm exec tsx scripts/lint-project.ts
```

Tests use actual loopback HTTP with synthetic locally generated PNG: partial Unicode SSE, binary fallback, abort/truncation, invalid events/media, timeouts/limits, concurrent workers, filesystem failures, cached-result restart/publication, hash/identity mismatches and default offline CLI. API credentials in those HTTP fixtures are fake; media and billing fixtures are clearly local, not claims of live provider performance or charges.

Expanded JSON input (including imported image data) is limited to 4 MiB before hashing, reservation or connection. Dry-run exposes `maxInputBytes` and rejects oversized input too. Every local result resume re-parses the bounded immutable raw body and compares its checksum and rebuilt final result with retained journal proof before publication.
