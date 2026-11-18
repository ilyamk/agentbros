# Local project review

Initialize the existing edit journal first if timeline editing is needed:

```bash
pnpm timeline:edit -- --project my-video --init
pnpm review:ui -- --project my-video
```

`pnpm review:ui --project my-video [--port N] [--open] [--print-token]` opens the review in the studio console ([RFC 0004](rfcs/0004-studio-console.md)): it starts or reuses the console (detached, one server per checkout, loopback only) and prints one JSON envelope (`projectId`, `url`, `origin`, `paidActions: false`, `ui: "console"`, `campaign`, `reused`, `port`, `pid`, `tokenInUrl`), then returns. The URL opens the project's Timeline page (`#token=…&project=<id>&view=timeline`); a campaign container opens its campaign view there (members, pinned variants, keep/fix/reject review drafts with the same 409 rules). The console token is per checkout and survives restarts, so the token URL is printed only to a terminal or with `--print-token`, which the guard hook denies to agents (otherwise `metadata.url` is a one-use pairing link, `#pair=<code>&project=<id>&view=timeline`, valid once for 10 minutes; `--open` opens the token URL in the browser without printing it). Keep it private; stop the server with `pnpm console --stop`. When the console cannot start (for example with `AGENTBROS_CONSOLE=off`) the command fails with `INTERNAL` and names the server log. The console replaced the standalone HTML-string review page (RFC 0004 WP13); the review services and their HTTP routes are unchanged, served under `/api/review/<project>/`.

Click a clip to populate an exact-frame move command, or paste any validated timeline edit command (trim, split, ripple, replace, rate, captions, transition, batch). Apply, undo and redo use `TimelineEditStore` and the revision shown in the interface. If another editor changes the journal, the UI shows the revision conflict; refresh before making a new decision. Opening the server does not initialize or modify the project. Changes update the canonical edit journal used by the timeline render path.

For authored screen text, choose **Edit authored on-screen copy**. Select **set**
for the headline or subtext to change, **keep** for an unchanged field, or
**remove** for subtext. Prepare resolves the selected scene's effective legacy
fields or exact `scene.hook` version1 props, validates without writing and
returns the precise command. Inspect it, explicitly Apply at the displayed
revision and verify one Undo. Selection/input changes, Refresh and Escape
invalidate drafts and late responses. Both fields set to keep cannot prepare an
edit.

Initial support is plain legacy title/feature/product/CTA and `scene.hook` title
scenes. Headline80/subtext160 UTF-16 code-unit caps and3/4 LF-line bounds aid
drafting; they do not establish rendered fit. Talking-head/media/proof scenes,
declared factual/educational/recipe and source-owned workflow projects refuse.
Do not bypass this by removing their evidence. Spoken text and timed captions
stay independent. Render the active journal with `pnpm render -- --project ID
--timeline`, then inspect actual copy, wrapping and safe zones in each requested
format. Independent technical acceptance
covers two title routes, complete text fragments in eighteen frames and exact
Undo pixels; element-box failures are retained separately, and broader fonts,
animation, glyph ink and creative approval remain unproven.

For a supporting visual, choose **visual-split**, enter an exact rational output cut and a new right-hand clip ID, then **Prepare**. The server resolves the actual imported kind, original hash and composition clock; it does not trust a client-supplied media kind or FPS. Prepare returns the existing split command without writing. Explicit Apply uses the displayed revision and one Undo. The right part can then move independently. Input changes, Refresh and Escape invalidate pending or late proposals.

The form supports static JPEG/PNG and plain muted imported video with exactly representable rendered source phase. Caption-bearing visuals, presenter/talking-head layouts, attached fades, animated image formats and authored video-scene animation/loop resets refuse. Unsupported fractional source phase is not rounded. Existing generic split commands remain available under their original contract. Preparation checks the original; generic Apply performs timeline CAS rather than a filesystem transaction. If the original changes afterwards, the renderer's SHA check refuses it. Inspect source boundaries and protected speech/captions in the new render.

To shift several supporting visuals together, select 2–24 visual clips in **Move visual group**, enter an exact output-frame delta numerator/positive denominator, and press **Prepare visual group move**. Signed deltas support either direction within the current timeline. Prepare resolves current clip IDs and validates one atomic batch without writing. Explicit **Apply** commits one history record at that revision; **Undo** restores the group. Relative spacing, source spans/rates/asset pins and all other tracks stay unchanged. Final collisions, negative starts, timeline overflow or broken fade adjacency refuse the entire proposal. Selection/delta changes, Refresh and Escape cancel the prepared draft and invalidate late replies. This form does not group-drag or ripple audio/captions.

For an existing music/SFX clip, select **audio-position** or **audio-trim** and enter exact rational output/source frames. Position changes only the output start. An inward start trim moves the output start forward by the removed source duration at the current playback rate, preserving the old output end; an inward end trim preserves the output start. Prepare validates the final existing move/trim/batch command without writing; Apply checks the current revision and records one Undo. Input changes, Refresh and Escape invalidate pending replies. Physical original duration, zero-origin loop, current bounds and overlap checks apply to impacted edits. Original bytes, rate, gain/keyframes and other tracks stay unchanged. Unsupported loop trims refuse; the form never switches looping off automatically. Remix a mounted master explicitly after audio edits; legacy unbound masters can bypass timeline audio.

To choose a different source moment while holding the edit in place, use **Slip plain video source**. Enter a signed, nonzero rational delta in the selected source's frame clock and press **Prepare**. The server checks the physical decoded clock and original hash; it refuses rounding, out-of-bounds windows, VFR, nonzero-origin footage and unsupported source/rate phases. Initial support is a bounded local H264 MP4 with a plain muted video clip, without captions, fades, loops, scene animation or a presenter layout. The proposed same-asset replacement preserves output start/end, duration, rate, metadata and every other track. Inspect the proposed source interval, explicitly **Apply** at the displayed revision, then verify one **Undo** and the rendered source moment. Input/selection changes, Refresh and Escape invalidate drafts and late responses. Apply uses journal CAS; original-file changes are checked again by rendering.

To remove a supporting insert while keeping its place empty, select **Remove plain visual (keep gap)** and **Prepare**. Inspect the proposed `remove-visual`, explicitly Apply at the current revision and verify one Undo. Remaining clips, dialogue/music/SFX/captions and original media files stay in place. Initial support is registered imported static PNG/JPEG or plain muted CFR H264 MP4; caption-bearing visuals, attached fades, authored animation and talking-head layouts refuse. The exact final timeline duration must stay unchanged: removal of the last clip refuses if it would shorten the video. The exposed lower layer/background is the resulting gap; review it in the render. Prepare rechecks original/config/registry/journal; Apply remains journal CAS.

To frame the same supporting visual for different aspect ratios, choose **Reframe plain visual**, a configured format and normalized position `x`/`y` from0 to1. Center is0.5; reset removes only that format's override. Prepare is readonly, then explicitly Apply at the displayed revision and verify one Undo. Coordinates select static cover alignment, without zoom or stretching. Initial support is registered imported static PNG/JPEG and bounded plain muted CFR H264 video; authored animation, transforms, captions, fades and presenter layouts refuse. Valid per-format maps survive plain slip/split/remove/group edits; other tracks and original bytes stay independent. Format/coordinate/reset/selection changes, Refresh and Escape invalidate drafts and late replies. Prepare's bounded source/config/journal rechecks are finite observations; Apply remains journal CAS and rendering verifies original hashes. Review the resulting crop in each requested format, especially faces and visual proof. Independent acceptance covers UI and nine tiny static diagnostic frames, not moving-video or creative approval.

Save named snapshots to freeze the complete timeline by SHA-256. Compare two snapshots to see their exact source intervals, captions and transitions. Choose a take with an explicit decision author: the decision pins the snapshot hash/revision plus the current journal hash/revision. Choice is a review record, not an implicit restore or user-authentication assertion; use validated edit commands to change the active timeline.

For a project with `pipeline/chapters.json` and an initialized timeline, choose a format in **Chapters** and press **Inspect chapters**. Select a chapter to inspect its exact rational output bounds, source slices, protected context and cache decision. No chapter manifest is a compatible absence. A cache receipt is a candidate until the existing chapter planner verifies dependencies, renderer/config fingerprint and output hash; `render-required` explains why reuse is unavailable. Changing format, refreshing or editing invalidates old inspection replies. Inspection writes no cache or journal and launches no render worker. Unsupported derived workflow/evidence contexts remain visibly unavailable for reuse. This is a bounded observation with final input rechecks, not a filesystem transaction or delivery approval.

The asset/entity board displays canonical card revisions, originals, licence and billing metadata. Budget view separates quotes, reserved amounts, actual receipts and unknown/unreconciled jobs. Missing budget setup remains uninitialized. No generation, provider requests, paid job retry, shell execution or credential controls are exposed.

Expand **Offline realtime editor** for pinned revision drafts, an unsent queue and explicit handoff/recovery. To keep supported actions on one finite local connection, enter a fresh local session ID and press **Open local channel**; inspect its status and close explicitly. The channel never executes generation, reconnects automatically or releases retained planning liability. Unresolved outcomes block mutations across sessions and HTTP. See [realtime editor controls and limits](realtime-editor.md) before deriving or reconciling work.

To reuse a supplied image, use **Load registered stills** in the offline editor. Close the local channel explicitly, inspect current registry/source hashes, select one static imported PNG/JPEG, enter fresh revision/session IDs, prompt, concrete seed, positive new planning bound and explicit finite limits, then **Save new offline draft from still**. Metadata discovery has no preview or paid generation. The server preserves the original bytes and refuses stale pins/CAS, unknown outcomes and active leases; closing alone cannot resolve unknown history. Input/editor/visibility/channel changes invalidate pending responses. Existing derive cannot replace the image. CLI/MCP accept a strict small **project-relative** selector through `add-asset`; see [the exact still workflow](realtime-editor.md#fresh-unsent-draft-from-a-registered-still). Saved sourceInput remains `physicalDecodeVerified:false`, with no provider ACK/charge or historical-registry provenance claim.

QA reports/contact sheets and rendered formats are available only through the selected project's allowlist: registered imported originals, fixed project QA/animatic/board files and known format outputs plus QA screenshots under `out/{project}/qa-screenshots`. HTML reports are displayed as escaped text. Image/video outputs can be previewed; no report scripts run. Unknown files, other projects, symlink escapes, raw operation storage/provider responses and `.env` are inaccessible. The token authenticates every data/file request; mutations additionally require a matching Origin. DNS-rebinding Host headers are refused, and strict JSON bodies are limited to 64 KiB.

Verify without APIs:

```bash
pnpm exec tsx --test tests/review-ui.test.ts tests/console-review-host.test.ts tests/review-ui-console.test.ts
pnpm console:test
RUN_CONSOLE_E2E=1 pnpm console:e2e
pnpm exec tsc --noEmit
```

The service tests drive the review services over their HTTP API; the console's Vitest and Playwright suites (`apps/console/e2e/timeline-*.e2e.ts`, `campaign.e2e.ts`) exercise visible edit/undo/redo/conflict handling, escaped malicious clip/report text, snapshots, takes, chapters, the realtime editor and the campaign view against the real console server. Production review still requires checking the actual rendered frames and audio.

QA evidence listings also expose declared review manifests, paginated PNG/HTML pages and their frames/crops/diffs under each evidence run, using the existing project path confinement.
