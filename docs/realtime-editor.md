# Offline continuous realtime editor drafts

`RealtimeEditorStore` keeps up to 32 revision requests and 256 immutable state snapshots in private `.cache/realtime-editors/PROJECT/EDITOR_HASH`. Each request retains exact inline input, concrete seed, input hash, quote and limits. Requests are bounded to 6 MiB JSON (the actual encoded operation still has the existing 4 MiB ceiling); snapshots are bounded to 64 KiB. Expected sequence numbers and exclusive immutable snapshot publication reject stale/concurrent writes. Neither originals nor selected preview media are changed.

The controller supports repeated local editing, one replaceable unsent queue slot, at most one handed-off capture, and selection of any verified completed preview. A handoff is an **explicit local intent**, not a send or provider acknowledgement. It retains the full positive quote against the editor's aggregate planning ceiling before an external caller can execute. This cumulative allowance is separate from the existing financial store's required project policy and each one-revision session reservation; it is not a provider billing ceiling. Completed or uncertain captures retain their allowance, even if actual pricing is unknown. No release/refund is inferred.

```sh
pnpm exec tsx scripts/realtime-editor.ts --project demo --editor composition --action create --ceiling 2
pnpm exec tsx scripts/realtime-editor.ts --project demo --editor composition --action add --expected 0 --request INPUT.json
pnpm exec tsx scripts/realtime-editor.ts --project demo --editor composition --action queue --expected 1 --revision revision-1
pnpm exec tsx scripts/realtime-editor.ts --project demo --editor composition --action handoff --expected 2
pnpm exec tsx scripts/realtime-editor.ts --project demo --editor composition --action status
```

For future authorised execution, a caller can inspect `--action request --revision revision-1` and explicitly invoke the existing bounded realtime executor separately. The controller never obtains provider tokens, connects provider sockets or invokes execution callbacks. The review UI additionally offers an explicitly opened local loopback channel, described below. Each revision requires a unique session ID: there is no invented persistent multi-input provider session. The CLI has no execute action and no transport reconnect. A caller must not execute a superseded, unqueued or previously handed-off request merely because it can inspect it.

After a durable capture is published, attach its manifest with `--action complete --expected SEQUENCE --revision revision-1 --manifest PATH`. Attachment checks project/session/revision/input identity, exact frame count, scoped immutable frame hashes, manifest hash and **published financial job evidence**. `--action select` requires a completed verified preview. Selection is local editing state, never production approval or rights clearance. Readback rechecks all pins, so a changed result cannot remain silently selected.

`--action cancel` cancels unsent queued work and marks a handed-off capture uncertain; it does not cancel another process or imply provider cancellation. The executing caller must separately abort its executor. `--action recover` conservatively marks an in-flight handoff uncertain after a restart. Uncertain captures block new handoffs; only an existing verified cached result can close that state through completion. There is deliberately no user-supplied “unbilled” switch, automatic reconnect, replay or automatic paid callback. Missing/expired transport credentials are handled by the existing executor; credentials are never stored by this controller.

Still open in REALTIME-01: native continuous provider editing with provable response association, provider ACK/resume/billing contract and webcam input. The finite local review channel does not establish these guarantees. Existing protocol documentation does not establish those guarantees. Offline continuous drafts and bounded capture integration do not certify live provider acceptance.

## Authenticated local review panel

Run `pnpm review:ui --project PROJECT --open` to open the project's Timeline page in the studio console. Expand **Offline realtime editor**. The panel discovers up to 64 local editor directories, selects an editor and shows revisions, input/request/result hashes, per-revision quote upper bounds and retained aggregate planning liability. Creation, draft addition, queuing, explicit handoff, cancellation, recovery, result attachment and preview selection call the existing durable controller with an expected sequence. Handoff records intent/liability only; there is no execute button, transport reconnect, token acquisition or paid callback.

Small requests can be pasted as exact `RealtimeSessionRequest` JSON. HTTP mutation bodies retain the existing 64 KiB limit; larger inline originals use **Add from project file**, a regular symlink-free project-relative request JSON bounded to 6 MiB. The request inspector returns its pinned exact request/quote for the separately authorised caller. Superseded/unsubmitted/previously handed-off work must not be executed just because it can be inspected.

A published capture manifest is supplied as a project-relative `pipeline/realtime/...` path. Attachment verifies the controller's original request/session/input pins and published financial job evidence. Select a completed preview to load its original frame through the existing authenticated cookie/ranged `/file` route, using opaque editor/manifest-SHA/frame references. A reference from a previous selection is rejected after selection changes; it can never silently resolve to a different original under the old label. Both controller pins and the actual opened file descriptor are checked before media streaming. This path does not expose arbitrary private files or external paths. Selected previews remain local choices, never creative approval or licence clearance.

The panel polls read-only at 2.5-second intervals while expanded and visible, with one poll in flight. Collapse, page hide or editor change invalidates late read responses. Mutations are explicit and disabled while pending; stale or ambiguous responses cause readback without replay. A failed integrity read clears the unverified preview/actions. Refresh/reload does not submit or reconnect. Use the original session URL again after browser reload, as with the existing review workspace; API header tokens are not persisted in browser storage.

The HTTP routes keep the existing loopback Host/origin/header-token/CSRF, content-type, CSP and body limits. New API actions are a strict fixed allowlist; no executables, sockets, external paths or provider secrets can be configured through this UI. Native continuous provider sessions, verified provider ACK/resume/billing, webcam input and human approval are still open in REALTIME-01.

## Edit a pinned request as a new local draft

Use **Edit as new local draft** on an existing revision. The form loads a small authenticated control summary; it does not return the inline original or inherit the previous quote. Enter new revision/session IDs, edit supported controls and enter a positive new upper planning bound. Saving creates only a draft. Queue and handoff remain separate explicit actions. The UI records low0 and expected/high equal to your conservative bound; these are planning numbers, not measured provider costs or a provider-enforced cap.

The CLI accepts a small strict JSON patch:

```sh
pnpm realtime:editor --project demo --editor composition --action derive --expected 1 --patch PATCH.json
```

```json
{
  "sourceRevision": "revision-1",
  "revisionId": "revision-2",
  "sessionId": "session-2",
  "input": { "prompt": "Turn this into a minimal product illustration", "seed": 35, "num_inference_steps": 4 },
  "quote": {
    "currency": "USD",
    "lowUsd": 0,
    "expectedUsd": 0.5,
    "highUsd": 0.5,
    "bounded": true,
    "confidence": "user-bound",
    "providerEnforced": false,
    "source": "My explicit upper planning bound for this new revision",
    "asOf": "2026-10-11"
  }
}
```

Patches are limited to16KiB and at least one explicit edit. Allowed input fields are exactly prompt (1–4096 characters), concrete nonnegative safe-integer seed, num_inference_steps1–8, schedule_mu0.3–2.5, output_feedback_strength0–1, image_size(square/square_hd), enable_interpolation(boolean). The checked-in provider schema and existing planner validate the final request too. Feedback remains a schema parameter of the separate bounded capture, not persistent latent state across sessions. Interpolation must fit the original maxFrames; limits are never silently expanded.

The server copies the source's exact inline-image string, operation identity and limits. New IDs must be unique; the explicit new quote must be user-bound and not claim provider enforcement or video forecast evidence. Immutable optional derivedFrom metadata records source revision/request SHA, verified again on every read together with preserved originals and limits. Old snapshots remain valid. Unknown fields, new image/endpoint/limits, changed source pins, stale CAS and capacity violations refuse the mutation. Originals, selection and existing retained liabilities remain intact.

File reads reject nonregular files, symlinks and oversize content before opening, then use nonblocking/no-follow descriptors with repeated regular-file/size checks. Authenticated HTTP derives through a strict small body; the form's source summary excludes image and quote. Derivation adds no provider token/socket, model call, billing acknowledgement, financial reservation or execution. Native continuous provider transport remains open.

## Explicit finite local WebSocket channel

In **Offline realtime editor**, select an editor, enter a new **Local session ID** and press **Open local channel**. Opening is explicit and uses the authenticated console server's same-origin loopback WebSocket. **Inspect channel status** reads its durable history; **Close channel** ends the connection. The server allows one connection per editor, at most four per project, with a 120-second lifetime, 15-second idle deadline, 64 commands and a 16 KiB command bound. Admission uses a single-use five-second ticket sent in the protocol exchange, never in the URL. Browser compression offers are declined; no extension is negotiated.

While the channel is active, supported editor actions use correlated local messages and expected-sequence checks. Polling pauses. **Edit as new local draft** requires fresh revision/session IDs and an explicit positive planning bound; its original image, operation and limits remain pinned. Queue and handoff are separate actions. Handoff retains planning liability and records local intent; it does not submit a generation or acknowledge a provider request.

Closing, collapse, page hide, editor change, reload or a deadline never reconnects or replays automatically. An unresolved outcome across any local session blocks subsequent mutations/handoffs until explicitly inspected and reconciled; switching to HTTP or a new session cannot bypass it. Closing/cancel/recovery does not refund retained liability. Current-state pins are checked separately from historical message receipts; a historical success does not prove the current revision is unchanged.

Independent installed-browser acceptance covers opening, status, deriving, queueing, handoff, recovery, reload without reconnect and closing. It preserves the first handshake refusal and the separate source correction. This is local editor acceptance, with no provider connection, ACK, invoice, webcam or human creative approval.

## Fresh unsent draft from a registered still

Reuse an imported immutable PNG/JPEG instead of generating a new image. Import an original once with `pnpm asset:import --project demo --input ORIGINAL.png --origin agent-harness` and preserve its provenance/rights. The initial still route supports static originals up to2MiB,4096px per side, without audio. The authenticated review panel's **Load registered stills** reads metadata and the current registry SHA; it is not an image preview or generation. It requires an explicit selection.

Close any active local channel explicitly before loading/saving. Resolve unknown predecessor outcomes through the existing channel inspection; switching to HTTP/CLI/MCP cannot bypass the editor-wide barrier. Choose fresh revision/session IDs, an explicit prompt, concrete nonnegative seed, positive new planning upper bound and finite input/frame/response/control/deadline limits. **Save new offline draft from still** creates only an unsent draft; queue/handoff/execution remain separate. Existing derive preserves its prior image; use this separate add-asset route when choosing a different registered image.

CLI and MCP use the same small strict selector JSON, at most16KiB, stored inside the selected project:

```json
{
  "assetId": "sha256:ACTUAL_ORIGINAL_SHA256",
  "assetSha256": "ACTUAL_ORIGINAL_SHA256",
  "registrySha256": "CURRENT_REGISTRY_JSON_SHA256",
  "revisionId": "still-1",
  "sessionId": "still-session-1",
  "input": { "prompt": "Turn this original into a minimal product illustration", "seed": 35 },
  "highUsd": 0.5,
  "limits": {
    "maxFrames": 1,
    "maxInputBytes": 4194304,
    "maxResponseBytes": 1048576,
    "maxControls": 4,
    "timeoutMs": 2000
  }
}
```

Replace all three SHA placeholders with verified current identities; the example does not supply asset authority or an approved budget. Save as `public/projects/demo/pipeline/still-selector.json`, inspect current editor sequence, then explicitly save:

```sh
pnpm realtime:editor --project demo --editor composition --action status
pnpm realtime:editor --project demo --editor composition --action add-asset --expected 0 --asset-draft pipeline/still-selector.json
```

For `avc_realtime_editor`, pass the same fields as JSON: `{"project":"demo","editor":"composition","action":"add-asset","expected":0,"asset-draft":"pipeline/still-selector.json"}`. The selector stays **project-relative**, not workspace-relative or absolute; the MCP bridge deliberately does not absolute-normalize it. Existing request/patch/manifest path handling is unchanged. Refresh the expected sequence after any edit; never replay a stale/unknown outcome automatically. Source originals, registry/config pins, unique IDs, CAS and unknown/active lease guards are checked before publication.

The request stores the exact original bytes as an inline image; sourceInput reports current original/registry/request/input hashes and `physicalDecodeVerified:false`. Current registry SHA is not an archived provenance receipt, and static JPEG byte/registered metadata checks do not claim a fresh full JPEG decode. The explicit upper bound is planning liability, not a charge or provider-enforced cap; unsent draft committedUSD stays0. Independent tiny local acceptance covers two24×16 originals, two drafts and original/saved raster equality, with the first CSP-bound observation failure retained. It does not establish live generation, legal/creative approval or general image decoding.
