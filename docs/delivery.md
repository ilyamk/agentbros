# Strict local delivery

`delivery.ts` is a local release check and packaging command. It makes no provider requests and does not create creative or legal approvals. Requests use `DeliveryRequestSchema` in `src/types/delivery.ts` and reject unknown fields.

```sh
pnpm tsx scripts/delivery.ts --action snapshot --request delivery-request.json
# Render each requested format and clean/captioned variant, then review outputs.
pnpm tsx scripts/delivery.ts --action check --request delivery-request.json --snapshot public/projects/PROJECT/pipeline/delivery/snapshots/HASH.json
```

Minimal capture request:

```json
{
  "version": 1,
  "projectId": "PROJECT",
  "formats": ["landscape"],
  "variants": ["clean", "captioned"],
  "placements": ["youtube"],
  "commercial": true,
  "loudness": {"targetLufs": -16, "toleranceLu": 1, "maxTruePeakDb": -1, "audioRequired": true}
}
```

Capture precedes rendering. The snapshot binds canonical props, story, optional timeline revision, source media, alignment JSON, source code, fonts and dependency/config files. Provider jobs, stage history and QA progress remain separate evidence; updating those does not invalidate the render. Remote assets must first be imported locally and hashed. Sources and output paths cannot escape their allowed directories through symlinks.

For automated renders, each output requires the renderer's matching `OUTPUT.mp4.receipt.json`. Older outputs may instead use an explicit `renderBindings` record with `evidence: "human-declared"`, current output/source/props hashes, format, caption mode, exact source list, named reviewer and explanation. Such a binding records a human declaration; it does not reconstruct an unobserved render.

An excerpt rendered with `pnpm render --frames START-END` is written as `{format}-frames-START-END.mp4` and its receipt carries `partial: {startFrame, endFrame, totalFrames}`. The check refuses it with `PARTIAL_RENDER`: an excerpt is for inspecting a stretch, never a final deliverable.

`pnpm render` watches the renderer's progress. If the rendered-frame count does not advance for `--stall-minutes` (default 5), it kills the render's whole process tree and restarts it once from scratch; a second stall fails with `RENDER_STALLED`, whose details name the stuck frame. Render around that frame with `--frames` to inspect it.

Every project must set `approvalMode: "manual"` and supply `manualApproval` with reviewer, timestamp, evidence, `storyHash` and the complete snapshot's `id` as `sourceSnapshotHash`. A leftover legacy `pipeline-state.json` is ignored: its stage approvals no longer count. All output hashes need a `visualReview` for that same snapshot. These reviews are supplied evidence, not automated semantic judgement.

Declare special uses in the strict request: `"usage": {"advertising": true, "endorsement": false, "standaloneResale": false}` for an advertisement. Omitted flags default false for ordinary legacy requests. A product-ad workflow's exact source-pinned marker makes effective advertising true even if the caller omits or sets that flag false; other workflows do not automatically imply advertising. The marker must match every requested render identity, and changes block delivery.

Every used media checksum needs usable original rights records or explicit `rightsReviews` covering that exact hash, commercial use, modification and every requested placement. For each effective special use, the named review also needs explicit true coverage in its own strict `usage` object. A generic review does not clear those blockers. Existing Pexels/NASA route restrictions persist for identifiable imported assets after a resource receipt is removed; current-hash, fully covered human exceptions remain declared evidence. Manifest rights and `reviewEvidence.resourceUse` retain requested/effective flags, derivation pin and context SHA. Required credits enter `credits.md`. Platform-specific music permission is not universal permission. Human rights reviews are declared evidence, not independent legal proof.

A replica whose `pipeline/replica-rights.json` (the user's answer, from `film:rights`) is `study-only`, or does not validate, is blocked with `REPLICA_STUDY_ONLY`: it renders and checks locally (draft mode still succeeds), but `productionReady` is false and the result says `publication: "study only, not for publication"`; `film:next` repeats it at the human step and after it.

Educational content and declared facts require a current story-bound `claimsReview` with source URLs and explicit claim IDs, plus `declaredClaims` identifying text and scene. Embedded facts must match those declarations. Spoken declarations are checked against available aligned caption text. The check does not independently verify factual truth.

The encoded video is probed for exact dimensions, actual 30fps and compiled duration, then fully decoded. Audio must satisfy the explicit LUFS tolerance and true-peak ceiling. Requested SRT/VTT files require real aligned cues. Missing variants, stale alignment/media/code, unbound outputs, unresolved generation jobs, errors and budget overruns block production. Published generation without an invoice produces a warning while retaining its financial commitment; estimated cost is never presented as actual/free billing.

To deliver separately supplied caption or speaker tracks, add `timeline: true` and an ordered `subtitleTracks` selection to the complete request, and omit legacy `subtitles`:

```json
{
  "timeline": true,
  "subtitleTracks": [
    {"trackId": "captions-ru", "language": "ru", "filename": "captions.ru.srt", "format": "srt"},
    {"trackId": "captions-en", "language": "en", "filename": "captions.en.vtt", "format": "vtt"}
  ]
}
```

This is a request fragment. Select 1–16 existing captions/voiceover/presenter owners with portable, distinct local filenames. Each track uses its own retained source/output timing; overlapping tracks export separately. Empty tracks, visual supporting copies, unsafe names and ambiguous selections refuse. The snapshot binds ordered declarations, every render identity's exact edit-journal hash/revision and selected track/cue/output bytes. Selection or source changes require a fresh snapshot. Publication rechecks subtitle bytes and source pins before writing `release.json`; a corrupted or stale package has no successful release marker. Existing default SRT/VTT exports remain compatible. `language` declares supplied content; this route neither translates nor validates language, alignment accuracy or speaker identity.

A successful production check creates an immutable directory `out/PROJECT/releases/HASH/` containing video variants, optional subtitle sidecars, credits, checksums and `release.json` as the final commit marker. Failed checks return nonzero and one JSON envelope with the persisted report path and blockers. `mode: "draft"` always returns `draft-needs-review`, never a production-ready package.

Verify locally:

```sh
pnpm tsx --test tests/delivery.test.ts
pnpm exec tsc --noEmit
```

Optional `fontContext` points to the same declarative JSON passed to rendering. Capture and check validate actual displayed text against registered local font faces, freeze the context and controlled role module, and hash selected original fonts and licence records. Raw and frozen contexts reproduce the same render identity. Arbitrary JavaScript and unknown JSON fields are rejected. Font binaries are used assets: a strict release requires rights evidence for their exact hashes, as for other originals.

The check consumes matching `pipeline/qa-evidence/*/evidence.json` reports only when both the current MP4 checksum and exact render props match. It verifies frame file containment and checksums, and propagates extraction/browser failures as blockers even when a human `visualReview` is supplied. Missing DOM evidence, omitted event samples and offline/substitute font mode are explicit warnings; they never count as automatic layout or production-font approval. The mandatory named visual/font review is the manual exception when no complete production browser evidence exists. Evidence report and frame hashes are recorded in the release manifest.

## Bespoke films

A film-chain project (`brief.renderMode: "bespoke"`, no `project.json`) is delivered by its own route (`src/lib/delivery/bespoke.ts`), with the same snapshot and check:

- **Render** with `pnpm film:render --project PROJECT --composition <build.json's composition> --audio <master>` to the default `out/PROJECT/film.mp4`. For a full render of the build's own composition and entry, without `--props` or `--draft`, to exactly that path, film:render also publishes delivery's `out/PROJECT/film.mp4.receipt.json` (`deliveryReceipt` in its receipt); otherwise it warns why there is none. Its own receipt stays at `pipeline/film-render.json`.
- **Request**: `formats` is the brief's one format, `variants: ["captioned"]` (the type is in the picture: there is no clean variant), `audioMaster` the same master passed to film:render, and no `timeline`, `subtitles`, `subtitleTracks`, `fontContext` or `platformAudioPlacement`. Anything else is refused (`BESPOKE_REQUEST_INVALID` at the check).
- **Identity**: the composition and entry from `pipeline/build.json`, the length from `motion-plan.json`, and the hashes of the authored pipeline files (brief, motion plan, cue sheet and placements, build, music decision, sound cues, replica spec), the project's files outside `pipeline/` (so keep the delivery request in `pipeline/`), the sounds `sound-cues.json` places, the audio master, the code and fonts. A later edit to any of them is `SOURCE_CHANGED`: render again.
- **Approval**: the chain's approvals are not read. Supply `approvalMode: "manual"` and `manualApproval` naming the user who accepted the film, bound to the snapshot id and its `storyHash`, plus `visualReview` of the output hash. Rights, loudness, resolution, frame rate and duration are checked as for any project; declared claims need a story-bound `claimsReview`.

## Native platform-audio handoff

Use `--action handoff` for an explicitly declared native-platform selection that will be added manually in the platform editor. The supported local timeline contains speech and SFX, with no local music or `audioMaster`; the platform track is declared in `platformAudioPlacement`, not downloaded or mixed into the local movie. Supply the exact project-local selection/rights/account/territory review evidence required by the strict schema. These declarations do not prove platform availability or grant rights.

Capture first, render the requested current timeline and variants with the same font context, then supply current visual/source reviews and run the existing check. Ordinary `snapshot`/`check` requests remain compatible; a native handoff does not replace a normal production release.

```sh
pnpm tsx scripts/delivery.ts --action snapshot --request public/projects/PROJECT/pipeline/delivery-request.json
# Render and review the current requested outputs; retain their renderer receipts.
pnpm tsx scripts/delivery.ts --action check --request public/projects/PROJECT/pipeline/delivery-request.json --snapshot public/projects/PROJECT/pipeline/delivery/snapshots/HASH.json
pnpm tsx scripts/delivery.ts --action handoff --project PROJECT --request public/projects/PROJECT/pipeline/delivery-request.json --snapshot public/projects/PROJECT/pipeline/delivery/snapshots/HASH.json
```

The guarded handoff worker currently requires macOS OS sandbox support. Request/evidence/source paths must remain within their allowed local scopes; aliases, stale pins, missing outputs, audio or review blockers refuse. A successful command returns `metadata.packetId` and a marker at `out/PROJECT/handoffs/PACKET_ID/handoff.json`, with the checked movie, requested subtitles and checksum records. Its state is `draft-needs-review`, status `pending-manual`, and `productionReady: false`. Place the declared native track manually using its reviewed offset/marks; this command does not upload, publish or approve the final platform mix.

Recover by the **exact returned content ID**, using the same current request and snapshot:

```sh
pnpm tsx scripts/delivery.ts --action handoff --project PROJECT --request public/projects/PROJECT/pipeline/delivery-request.json --snapshot public/projects/PROJECT/pipeline/delivery/snapshots/HASH.json --recover PACKET_ID
```

Recovery rechecks source/render/packet identity and existing delivery gates. For native font-context recovery, the previously prepared cache must exist and match its registered original fonts, licences and displayed text; recovery reconstructs it read-only. Missing, corrupt or stale cache/packet/source data refuses instead of preparing replacements, copying a new packet or replaying work. Keep the matching request, snapshot and marker; a changed project requires a new snapshot/render/review rather than rebinding an old receipt.

The bounded local diagnostic covered a 3s FullHD render, six QA frames, original-derived speech/SFX PCM checks, guarded handoff and read-only recovery; it is technical acceptance, not human listening/creative approval or legal/platform-account verification. See the independent physical evidence. Historical refused runs remain recorded separately.
