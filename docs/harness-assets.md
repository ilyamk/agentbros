# Portable agent-harness assets

This bridge plans and records a host-agent handoff. It never invokes a model, discovers tools through network requests, executes callbacks, reserves provider credits or makes a paid fallback. The exported TypeScript methods are `listCapabilities`, `requestAsset` and `importResult` in `src/lib/assets/harness-runtime.ts`. The CLI is `scripts/harness-assets.ts` (proposed alias `harness:assets`).

## Evidence and identity

A version-1 capability declaration comes from the current agent's observed tool inventory, or explicitly supplied runtime evidence. Preserve that evidence as a local file, provide its SHA-256, session identity, observation/expiry timestamps, exact tool identity and supported kinds/operations. Use `evidenceKind: "observed-runtime"` only after actually inspecting that runtime; fixture/manual declarations are `supplied-runtime`. This label is a declaration, not cryptographically authenticated platform attestation. No declaration means `unavailable`. Expired/future observations, exhausted quota, missing tools or tools without a local original-file output do not dispatch requests.

`toolId` and `requestedModel` differ. Leave `selectableModels: []` unless the tool really exposes a model selector. `allow-tool-default` records a requested model as an intention; it does not guarantee that model. `require-selectable-model` rejects unobserved choices and requires the fulfilled result to report that exact model. When a tool does not identify its model, the result records `model: "unknown"`.

Capability evidence and tool-result evidence are supplied source artifacts; hashes detect changes, not the truthfulness of their author. Do not include credentials or environment dumps. Nothing reads environment variables into these records. Evidence JSON is limited to 8 MiB; media originals are hashed in bounded chunks with a 32 GiB limit. All input and output paths must be contained in the trusted workspace, with no symlink components. Copy externally returned originals into a workspace `incoming/` directory first, preserving original bytes and a checksum.

## Codex / Claude procedure

1. Read the approved brief, pinned entity cards and resource rights. Observe the **current** Codex or Claude tool inventory. Do not infer subscription/model availability from the agent name.
2. Save a declaration JSON and observation evidence within the workspace. A tool entry has `toolId`, `available`, `kinds`, `operations`, `selectableModels`, `quota` (`unknown` unless observed), and `localOriginalOutput`.
3. Prepare the request: `schemaVersion: 1`, unique `requestId`, existing `projectId`, tool/kind/operation, purpose/prompt, acceptance criteria, optional dimensions/transparency/model policy, and pinned reference asset IDs/hashes. Optional entities require approved exact revisions/content hashes. An edit needs at least one pinned reference.
4. Run the offline commands below. The persisted request is `awaiting-import`; there has been no generation. Read its request hash and original reference files. The host agent may then call its actual available generation tool, **only within the user's authorisation**, passing the recorded prompt and originals. This step is deliberately external to the CLI; no executable paths or shell callbacks can be registered.
5. Preserve the returned original local media and tool response. If no downloadable/local original exists, leave the request `awaiting-import`; an inline screenshot is not the original.
6. Supply a fulfilled result with exact request ID/hash, runtime/tool, observed model or `unknown`, original `{file, sha256}`, tool response `{file, sha256}`, rights and billing. Billing stays `{ "status": "unknown" }` absent a genuine receipt. `reported` requires API USD and evidence source; a subscription is not proof of zero marginal API spend. This import records supplied billing; it does not charge a provider or mutate the paid-generation cost ledger.
7. Import and inspect the candidate asset/contact sheet. Link it into a **new candidate entity revision** if needed; normal explicit approval remains necessary. Import does not approve an asset, entity or project.

```sh
node node_modules/tsx/dist/cli.mjs scripts/harness-assets.ts --action capabilities
node node_modules/tsx/dist/cli.mjs scripts/harness-assets.ts --action capabilities --capabilities incoming/capabilities.json
node node_modules/tsx/dist/cli.mjs scripts/harness-assets.ts --action request --capabilities incoming/capabilities.json --request incoming/request.json --dry-run
node node_modules/tsx/dist/cli.mjs scripts/harness-assets.ts --action request --capabilities incoming/capabilities.json --request incoming/request.json
node node_modules/tsx/dist/cli.mjs scripts/harness-assets.ts --action import --project PROJECT --result incoming/result.json --dry-run
node node_modules/tsx/dist/cli.mjs scripts/harness-assets.ts --action import --project PROJECT --result incoming/result.json
node node_modules/tsx/dist/cli.mjs scripts/harness-assets.ts --action status --project PROJECT --request-id REQUEST
```

Every command emits one JSON envelope. `--scope-root` is a trusted launcher option for workspace containment, not an untrusted tool parameter. The orchestrator must enforce project scope against the nested request's `projectId` as well as any CLI project argument before exposing request operations over MCP. This module does not expose arbitrary code execution.

## Resume and immutable receipts

Requests pin the project configuration, capability evidence, prompt, references and approved entity revisions. A repeated ID with changed content fails; a new attempt needs a new ID and explicit generation decision. Identical resumes do not invoke generation, including after capability expiry; expiry only prevents new handoffs. Configuration or reference changes require a new request, preventing a fulfilled result from silently joining a different project state.

Import pins its full result before the asset registry write. A restart can finish an `importing` operation after the original/registry was already committed. A result with altered original path/hash, rights, tool, model or billing cannot replace that attempt. Completed receipts validate their pinned result and immutable registry original. Locks report `TIMEOUT`; inspect process ownership before manually clearing a stale lock. No automatic lock deletion or resubmission occurs.

The registry is content-addressed and preserves the first record for identical media. When the same bytes already have different metadata, the bridge keeps that record intact and stores **operation-specific** provenance/rights in the handoff receipt, with `registryMetadataPreserved: true`. Do not treat this receipt as rewriting the registered asset's licence or as a second independent generation of different media. Receipt creative approval is always `required`; copyright, likeness/consent, visual acceptance and model identities still need real evidence.

## Acceptance limits

Local fixtures exercise both `runtime: "codex"` and `runtime: "claude"`, durable handoff and immutable imports. They are not actual harness generation tests, quota checks, subscription checks or human creative approval. Real current tools must be observed by their owning host agent; actual original-file return and creative acceptance remain separate checks. Missing runtime, inaccessible originals and uncertain rights stay explicit rather than triggering provider fallback.
## Modern provider reference binding

After `asset:import`, put `asset://sha256/HASH` into an exact provider `_url`/`_urls` input field and invoke `generate:model --project ID`. Local resolution verifies registry membership, original checksum/bytes and real media metadata, then passes deterministic data URIs through the normal schema/budget/job boundary. No upload or API call occurs during resolution or dry-run. Unique inline originals are bounded to 32 MiB; large video/audio references need an explicitly uploaded HTTP(S) URL. A plain local path in a `_url` field (for example `public/projects/ID/assets/keyframe.png`) is inlined the same way for fal requests too (2026-11-17), contained in the MCP `--scope-root` or else the working directory, typed by its leading bytes or extension, and counted against the same 32 MiB total; an overflow names the total and the limit. It carries no registry provenance, so prefer an imported reference. Output provenance retains reference asset IDs. This route makes harness-generated character/location stills usable by modern image-edit/i2v/reference modes without a second still generation charge. Subscription entitlements and actual API costs remain unknown unless evidenced. Provider live acceptance has not been run.
