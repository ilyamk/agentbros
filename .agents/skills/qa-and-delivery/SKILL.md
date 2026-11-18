---
name: qa-and-delivery
description: Check final video, sound, captions, rights and requested formats with evidence and targeted repairs.
---

# Qa and delivery

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

## Decision and output

Produce `quality-report` in `pipeline/craft/qa-and-delivery.json` (or the owning stage artefact when its schema already covers these fields): approved snapshot, requested formats, frame count/dimensions, boundary frames, speech ownership, captions, media coverage, loudness/peak, rights and defect decisions. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Use `pnpm pipeline:check --project ID`, `pnpm validate:render --project ID`, and `pnpm qa:screenshots --project ID`. Parse the single stdout JSON envelope and keep reported defects.

For long-form projects, [local chapter navigation](../../../docs/local-review-ui.md) inspects exact chapter/source slices, protected context and the existing planner's cache decision at the current revision/format. `render-required` or an unverified cache receipt is not reusable output. Inspection starts no render worker and cannot replace final frame, sound, subtitle or delivery review.

For charts, pipeline check uses the actual renderer's series/axis/annotation resolver. `CHART_ANNOTATION_TARGET_INVALID` and explicit `CHART_DOMAIN_BINDING_MISMATCH` are errors; repair the exact artefact/JSON path. `CHART_SEMANTICS_REVIEW_REQUIRED` is nonblocking informational uncertainty for untyped charts and freeform annotations, including charts without annotations. A consistent `year-v1` binding checks declared years and visible labels only: verify quantity, source, spoken claim and the rendered frame separately. Do not infer factual approval from absent errors or silently invent a missing year/value.

Check explicit quantity/source correspondence against the current active chart, not an obsolete canonical scene. `blocked` means repair the conflicting metric, callout, target or stale source binding. `unverified` means the quantity or source connection still needs review; `declared-correspondence` establishes only the named record/value/declaration connection. All retain `factualTruth:unverified` and `humanApproval:not-inferred`. Review secondary labels in actual frames for clipping, overlap and line overpainting; numeric bounds alone cannot demonstrate readability.

Use `pnpm chart:inspect --project ID` for the canonical project or `pnpm chart:inspect --project ID --timeline` for the edited output. Parse the one JSON envelope; VALIDATION details identify blocking findings. See the [operator route](../../../docs/chart-evidence.md). A render dry-run checks explicit quantity/source conflicts before Chromium; it is not a visual or factual approval.

Source-bound review packs returned by QA/vision commands supplement existing evidence. Read their manifest and PNG pages, verify with `pnpm vision:inspect --manifest PATH`, then open full frames/crops for text and UI. Missing/omitted measurements are unverified, never zero or a pass. Distinguish diagnostic composition frames from delivered video pixels; cite exact frame IDs and current source hashes. A pack is evidence, not an approval.

## Worked decisions

- Extract the final non-EOF frame and verify that transition arithmetic has not produced a black tail.
- Measure the delivered mix and verify a source-aligned Russian phrase across a visual dissolve.

Failure to avoid: Declare a pass because rendering exited zero although captions or required assets are missing.

## Alternatives and review

Automated checks prove specific constraints; manual visual/semantic review remains explicit. A skipped quality stage cannot excuse an invalid final output.

After reviewed B-roll or pointer edits, render the current TimelineIR revision and check the affected cut boundaries, active captions and full retained speech. A muted cutaway must not add its embedded source audio. Verify source/plan/render hashes again; an earlier master or dry-run is not evidence for the changed revision. See [the candidate-to-apply route](../recording-recut/references/analysis-and-broll.md) when those tools were used.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.

## Evidence-bound release

Read [strict local delivery](../../../docs/delivery.md) and use `pnpm exec tsx scripts/delivery.ts --help`. Prepare its strict local request (formats, clean/captioned variants, target placements, explicit loudness target/tolerance/peak and required audio), then `--action snapshot --request REQUEST.json`. After rendering, `--action check --request REQUEST.json --snapshot SNAPSHOT.json` validates the final package; there is no `--output` flag. Keep the returned snapshot/report paths.

Every delivered file needs an immutable matching render receipt or explicitly named human-declared hash-bound binding, and a visual review bound to the exact bytes. Verify rights evidence for every contributing asset and all placements; educational/declared factual claims need reviewed source evidence tied to the story. Pipeline approval mode needs current done/approve events for brief/script/design/storyboard/QA; manual mode needs current snapshot/story approval. Do not treat a stale approval as current.

Declare advertising, endorsement and standalone resale in request `usage`. Review the effective context recorded in `reviewEvidence.resourceUse`: pinned product-ad forces advertising and requires the exact same marker in every identity. A generic rights review cannot clear a special-use blocker; named current-hash exceptions must explicitly cover each effective use and placement. Preserve provider acquisition provenance and credits after receipt loss. Context changes during QA block packaging; a declared context or human exception is not independent legal proof.

For explicit `subtitleTracks`, verify each supplied track's owner, declared language, filename and exact cues against the current snapshot. Both request and journal changes invalidate that selection. The release records `subtitleOutputs` and `reviewEvidence.subtitleSelection`; immediate and final readback must pass before `release.json`. Separate overlapping sidecars are supported, while each owner's timing constraints remain enforced. Existing legacy SRT/VTT requests remain compatible. Do not infer translation, alignment accuracy or visual caption review from a successful sidecar export.

Unresolved/over-budget paid operations block delivery; missing invoices warn while commitments remain reserved. A failed check returns VALIDATION and persisted report outputs; inspect and repair those defects rather than resubmitting generation by a new ID. `draft-needs-review` is an explicit draft status, never a production pass. Only `production-ready` yields the immutable release directory containing media, release.json, credits.md, checksums.json and requested SRT/VTT sidecars. Measured checks and hash bindings do not replace visual/semantic human review.

## Audio integration receipts

For new audio features, read [audio integrations](../../../docs/audio-integrations.md). Require exact source/take hashes and canonical timing, and resynchronise remote dubbing state before review/delivery. Localisation review must pin the selected target language/revision and its actual renderer audio lineage; stale known snapshots block readiness. Earshot reports (film:measure `sfx-evidence`, sfx-selection.json, critic audio-reviews.json) are optional advisory SFX evidence and never establish listening, musical suitability or whole-film quality. Keep paid mock-contract validation, live account acceptance and human acceptance distinct.


For a generated shot made from a reference pack, review the full result beside its pack and `refs:pack --action result-board` stills on the dimensions of `PackResultReviewSchema` (identity, wardrobe, preserved, other subjects, motion, naturalness, prompt fit, temporal consistency, audio); a failed dimension cannot pass and a reshoot is the user's call. Mechanical facts and sensor warnings are QA's; identity and naturalness are judgement. Dimensions and repairs: [failure modes](../reference-preparation/references/failure-modes.md).

For prepared Genjutsu assets, inspect the complete source/result pair and the `model:prepare --action result-board` samples. Review identity through turns/occlusions, motion/camera, preserved elements, other subjects, temporal consistency and audio; record exact-byte observations through `--action review-result`. A sampled board alone cannot establish temporal consistency. A repair/reshoot is unfinished; ask the user before a reshoot. Strict delivery follows preparation provenance and checks result review plus source-use placements/commercial/special uses; a generic final-output rights declaration cannot clear a missing source/result review. Do not claim the audio sounds good; the user judges it. [Recipe](../../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow).
