# Offline candidates and reviewed B-roll

Use this route to find candidate spans or cover a reviewed cut with supporting footage. The [supplied recording workflow](local-workflow.md) remains responsible for speech edits, complete contextual statements and precise word timings. B-roll adds an independent muted visual track; it does not remove or retime the spoken statement.

## Candidate analysis

Read [local ingest](../../../../docs/media-ingest.md) and inspect the actual source index, original checksum, decoded timestamps and relevant surrounding statement. Transcript/OCR/tag ranking describes candidates. A sampled OCR image does not prove that its text stays visible throughout the proposed interval. A high semantic score does not prove that footage illustrates the spoken claim.

If the user permits installed local inference and a trusted engine/model configuration is already available, use the CLI-only adapter:

```bash
pnpm media:local --action probe --config ASR_CONFIG.json
pnpm media:local --action asr --project ID --source ORIGINAL.mp4 --config ASR_CONFIG.json --options INGEST_OPTIONS.json
pnpm media:local --action corpus --project ID --config EMBEDDING_CONFIG.json
pnpm media:local --action query --project ID --config EMBEDDING_CONFIG.json --corpus CORPUS_PACK.json --query "The spoken claim to illustrate" --context 1.5 --limit 10
```

Parse the single JSON envelope. `probe` can succeed with `metadata.available=false`; this is an unavailable engine, not permission to download one or call a provider. `asr` produces review-required segment timestamps. These are not forced-aligned word timings and cannot replace the recording workflow's required supplied alignment. Check sentence context, negations, attribution and caveats against the original; retain uncertainty when ASR boundaries are imperfect.

`corpus` returns its pack file in `outputs` and `metadata.file`. `query` returns the exact query object in `metadata.query`; save that object as a project-local JSON file if passing it to B-roll. The worker-evidence file in `outputs` is a different envelope and is not a query file. Corpus and query must use the same pinned embedding space; changed originals/model/indexes require new evidence. Executable-bearing configuration is trusted CLI-only, never an agent-supplied MCP field. Preparation or an earlier synthetic benchmark does not prove an installed runtime is available in this checkout.

For text visible in already indexed footage, an installed prepared Apple Vision runtime can add independent frame evidence:

```bash
pnpm media:ocr --action probe --config OCR_CONFIG.json
pnpm media:ocr --action ingest --project ID --index BASE_INDEX.json --config OCR_CONFIG.json
```

Use the existing non-OCR video index as `BASE_INDEX.json`; all its sampled thumbnails need an exact next decoded PTS and must fit the configured frame bound. Read the [offline frame OCR contract](../../../../docs/media-ingest.md#prepared-offline-frame-ocr) before execution. `probe` may report unavailable; do not prepare/download a runtime or invoke a cloud fallback without authorization. `ingest` returns the derived index in `metadata.file` and its immutable raw receipt in `metadata.receiptFile`; keep the base index. Search the derived index using existing selects; embedding packs made from the base index need new evidence for the derived corpus.

OCR intervals represent only a decoded sampled frame. Do not use sparse observations as proof of video-wide text persistence, precise speech alignment or permission to delete a caveat. Inspect the original frame, confidence/box and surrounding statement before selecting B-roll. The prepared executable/config stays trusted CLI-only and cannot be supplied through MCP or review UI.

## Fixed existing corpus diagnostics

For the six audited existing EN/RU AI/TTS sources, use the trusted CLI-only corpus contract:

```bash
pnpm media:corpus --action prepare --source-root ORIGINAL_REPOSITORY --output NEW_ARTIFACT_DIRECTORY
pnpm media:corpus --action inspect --manifest MANIFEST.json --manifest-sha256 REVIEWED_SHA256
pnpm media:corpus --action run --manifest MANIFEST.json --manifest-sha256 REVIEWED_SHA256 --config TRUSTED_CONFIG.json --project ISOLATED_DIAGNOSTIC_PROJECT
```

Run requires an already installed native-word Whisper configuration and observed OS network denial. Preserve original hashes, source offsets and explicit PCM-derivative lineage; derivatives have their own zero clock and no automatic mapping to original MP3 timelines. Current acceptance contains four native hypotheses with estimated proposals and two double clock refusals. A diagnostic paragraph retry is limited to one operation after the exact fresh native-word clock refusal; cache corruption and other failures cannot trigger it. Both clock refusals remain visible if paragraph validation also fails.

Intended generation text is a comparison reference, not an independent human transcript. Token edits cannot prove ASR accuracy or timing quality. Keep unknown rights, review-required status and protected source spans. This command neither approves captions nor edits the timeline; manifests do not authorize executable selection. Optional rejected observations are now separately quarantined. Add `--retain-rejected-observation` only when explicitly retaining diagnostics; original clock errors still refuse, and raw segments/words cannot become captions or edit timings. Read an observation through the pinned CLI action:

```bash
pnpm media:corpus --action inspect-rejected --manifest MANIFEST.json --manifest-sha256 REVIEWED_SHA256 --project ISOLATED_DIAGNOSTIC_PROJECT --entry ENTRY_ID --receipt RECEIPT.json --receipt-sha256 REVIEWED_RECEIPT_SHA256
```

Keep exact observed text, including mistakes, separately from intended scripts or reviewed transcripts. Successful readback verifies recorded bindings and bytes; it approves neither speech accuracy nor timings. Invalid cache/protocol or changed source/model/runtime cannot generate quarantine. Full engine JSON/token metadata is unavailable; retained data is the bounded normalized worker envelope.

## Estimated word proposals

An explicitly configured installed whisper.cpp runtime can retain native estimated word intervals with `wordTimingMethod:"native-word-segments-v1"`. Follow the [word proposal contract](../../../../docs/offline-word-timing.md) before running it. Existing segment-only indexes cannot supply those words; no implicit second inference, download or paid alignment follows a refusal.

```bash
pnpm media:words --project ID --index INDEX.json --output public/projects/ID/pipeline/words-proposal.json
```

This creates a new pinned proposal with `estimated:true`, `reviewRequired:true`, `approved:false`, original seconds and raw-row references. Listen to the original around every intended cut; check omitted words, negations, attribution, pauses and word boundaries. Keep the source/index/transcript/model/runtime hashes. The proposal does not approve deletion or automatically create a recording-edit request. Do not invent alignment confidence or copy its entire object into a different strict schema.

Optional `--frames` verifies the original zero-origin CFR video's physical rate and decoded timestamps. It refuses VFR/audio, stale rate and collapsed words; it is not a target-30fps conversion. Review the resulting words and complete context before authoring the workflow's source-frame transcript and edit hash. For VFR use the separate reviewed PTS normalization workflow; never multiply source seconds by nominal FPS. Preserve the immutable estimated proposal when creating a revised reviewed transcript.

## Reference-image candidates

When the brief supplies a permitted visual reference, import its original image and use the prepared CLI-only image-distance route:

```bash
pnpm media:visual --action probe --config VISUAL_CONFIG.json
pnpm media:visual --action search --project ID --index BASE_INDEX.json --query-asset sha256:HASH --config VISUAL_CONFIG.json
```

Read the [reference-image contract](../../../../docs/media-ingest.md#prepared-offline-reference-image-search). Native distances sort ascending; they are not confidence, semantic understanding or evidence that an object persists. Check the actual image/EXIF orientation, candidate frame, next decoded PTS and surrounding footage. The result pins the registered reference bytes+metadata, base index, sampled frames and prepared OS/runtime. Preserve those pins and all ranks; mismatches refuse rather than recomputing silently. Do not download/compile a missing runtime or fall back to paid generation.

Use the returned derived `metadata.file` as the B-roll index and `retrieval:{"method":"native-image-distance"}`. Select the exact `segmentId`, review source context/rights and placement, then use the same explicit dry-run/Apply/CAS/undo path. A sampled frame does not prove whole-clip continuity; retain existing speech/captions and independent muted visual ownership. OCR must run before visual derivation if both are needed. This does not supply spoken word alignment.

## Cutaway planning and application

For an already prepared macOS native category runtime, use the exact supported category ID and taxonomy hash rather than a natural-language prompt:

```bash
pnpm media:category --action probe --config CATEGORY_CONFIG.json
pnpm media:category --action classify --project ID --index BASE_INDEX.json --query public/projects/ID/pipeline/category-query.json --config CATEGORY_CONFIG.json
pnpm media:category --action search --project ID --index CATEGORY_INDEX.json --query public/projects/ID/pipeline/category-query.json
```

Read the [native category contract](../../../../docs/media-ingest.md#prepared-offline-native-category-search). Preparation/config selects a reviewed local executable; receipts are data and never select tools. No runtime is compiled/downloaded automatically. `search` verifies stored immutable rows and runs no inference. All returned native scores and misses remain observations, not calibrated confidence, object persistence, rights or human labels. Category frame spans end at the next decoded PTS; review surrounding footage and retain protected speech. For B-roll use `retrieval:{method:'native-image-category',queryFile:'pipeline/category-query.json'}` relative to the project, then the same dry-run/Apply/CAS/Undo route. Classifier/OCR/reference derivations must preserve and validate lower evidence layers.

Read `src/lib/ingest/broll.ts` for the strict request/review schemas and acceptance limits. Prepare a version-1 request inside the target project. `indexFile`, and embedding `packFile`/`queryFile`, are relative to that project's directory. Choose `retrieval.method="lexical"` with `query`, or `"supplied-embedding"` with the saved pack/query. The latter accepts locally computed evidence too; it performs no inference itself.

Pin the chosen `segmentId`, `contextSec`, current `expectedRevision`, fresh `trackId`/`clipId`, target `usage` and `outputStart` as an exact rational **timeline frame coordinate**, not seconds. Inspect the actual returned span before fitting the placement. Planning rejects placement outside the existing master and does not truncate context to make it fit. The registered original must be zero-origin CFR; VFR footage needs explicitly reviewed normalization first. Rights and required credits must be supplied and checked for the declared use. Tags and inference do not clear those rights.

```bash
pnpm media:broll --project ID --action plan --request public/projects/ID/pipeline/broll-request.json
pnpm media:broll --project ID --action apply --plan public/projects/ID/pipeline/broll-plan.json --review public/projects/ID/pipeline/broll-review.json --dry-run
pnpm media:broll --project ID --action apply --plan public/projects/ID/pipeline/broll-plan.json --review public/projects/ID/pipeline/broll-review.json
```

Save the **whole plan from `metadata`**, not the outer CLI envelope. Review source frames with surrounding context, proposed output placement, rights and how the image supports the spoken claim. Bind the supplied review's `planHash` and `assetHash` to this exact plan; `reviewedBy`/`evidence` record a declaration, not authenticated approval. Do not invent a person's review. A changed revision, source, index, query or rights invalidates the plan; replan and review changed evidence rather than retrying stale apply.

Apply only the reviewed proposal within the user's authorized editing scope. It uses CAS/readback and preserves existing tracks; undo through the existing revision command service remains available. Render the current TimelineIR revision and inspect the cutaway entrance/exit, active captions, preserved full speech and muted cutaway audio. Technical success leaves `productionApproved=false`; final rights, semantic/visual review and delivery checks still apply. If the image contradicts or distracts from the claim, revise the candidate instead of using a score as justification.
