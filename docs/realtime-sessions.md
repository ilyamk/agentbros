# Bounded fal realtime capture

This transport implements the documented FLUX.2 klein WebSocket image-edit endpoint. It is separate from HTTP streams and queue requests. Tests use an actual local loopback WebSocket server and synthetic locally generated PNGs. No fal auth/inference/uploads or paid APIs were used for verification.

Protocol references: [official model API](https://fal.ai/models/fal-ai/flux-2/klein/realtime/api), [official fal JavaScript SDK source](https://github.com/fal-ai/fal-js/tree/main/libs/client/src) (`realtime.ts`, `auth.ts`, `utils.ts`, installed version 1.10.1).

The SDK connects to `wss://fal.run/fal-ai/flux-2/klein/realtime`, with a short-lived JWT and `max_buffering=1`. Input objects and output objects use MessagePack. Frames contain binary image bytes, declared dimensions and content type. When interpolation is requested, two frames are returned in chronological order. SDK control notifications and idle timeout messages are not input acknowledgements.

There is no documented durable provider session ID, input acknowledgement, correlation ID, idempotency key or recovery/resume API. The first implementation therefore accepts exactly **one input revision per bounded session**, with a concrete seed. Local session/revision IDs never enter the provider input schema. A socket write callback means only a local write, not provider acceptance. A mismatched seed, malformed result, early close, deadline or interruption becomes unknown/cancelled with retained liability. It never silently reconnects or replays. A new revision needs an explicit new session ID and its own reservation. This is a capture utility, not an invented recoverable interactive protocol.

Request JSON uses `RealtimeSessionRequestSchema`: `version:1`, `projectId`, `sessionId`, `revisionId`, a verified `operation` (`family:"flux-2"`, `variant:"klein"`, `operation:"realtime"`, `transport:"realtime"`), positive bounded whole-session `quote`, and `limits`:

- `maxFrames`: 1–2 (interpolation needs 2).
- `maxInputBytes`: up to 4 MiB, including encoded payload.
- `maxResponseBytes`: up to 16 MiB; incoming WebSocket frame and decoded binary/string/array bounds apply.
- `maxControls`: 1–64.
- `timeoutMs`: 50–100000, below the temporary token's lifetime.

`image_url` must be an inline JPEG/PNG/WebP data URI. Inputs are locally probed and decoded before auth/connect. Outputs pass actual probe and full single-image decode before immutable import into the asset registry. Captures have exact hashes and unknown billing/rights metadata; they do not imply creative approval, copyright clearance or a free invoice.

```sh
# Default pure offline plan: no project writes, credentials, sockets or token POST.
pnpm tsx scripts/realtime-session.ts --request realtime-request.json [--project PROJECT]
# Configured future paid use only: existing project budget policy is mandatory.
pnpm tsx scripts/realtime-session.ts --request realtime-request.json --execute
```

`--dry-run` forces offline planning even together with `--execute`, supporting MCP paid-operation guards. Optional `--project` must match the nested request project ID. CLI interrupt signals request bounded closure and retain any ambiguous liability.

Execution prefers `FAL_REALTIME_TOKEN` (or `--token-env NAME`). Otherwise a configured `FAL_KEY` obtains a token with one bounded POST to the exact SDK `https://rest.fal.ai/tokens/` contract, `allowed_apps:["flux-2"]`, expiration 120 seconds. No redirects/retries are allowed and auth errors omit credentials/body. Auth happens only after policy reservation and local session lease. JWT URLs/keys/tokens are never journaled or returned.

This default-offline CLI reads Studio Console-managed keys only for explicit execution. For legacy `.env` keys, export the required variables or invoke `pnpm exec tsx --env-file=.env scripts/realtime-session.ts --request realtime-request.json --execute` explicitly. No such provider execution was used in verification.

The full quoted high cost is reserved before contact. Quotes are planning bounds, not provider-enforced billing ceilings; invoices can exceed them and must be reconciled honestly. Connect/send/cancel errors cannot be assumed free. Cancellation before any auth/connect intent releases a provably unsubmitted reservation; socket closure after contact does not imply a refund.

A private `.cache/realtime/PROJECT/SESSION_HASH/` journal stores immutable input intent, send intent, local write checkpoints, result checkpoints and interruption records. A dead worker lease can be reclaimed, but a missing durable result forbids replay. A complete cached result permits local publication retries without another token/socket. Successful captures produce an immutable `pipeline/realtime/SESSION_HASH.json` manifest and hash-addressed candidate images. Published resumes verify manifest and image hashes. Session ownership prevents concurrent workers from submitting twice.

Limitations: no provider ACK proof; no replay/reconnection; no webcam/UI integration; no continuous input stream; no invented server cancellation/refund; no live verification; unknown pricing needs a caller-supplied positive bound. The CLI returns one JSON envelope; pending/unknown/cancelled states have empty outputs and explicit next action.

```sh
pnpm tsx --test tests/realtime-session.test.ts
pnpm exec tsc --noEmit
```
