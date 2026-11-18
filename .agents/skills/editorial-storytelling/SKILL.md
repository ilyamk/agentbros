---
name: editorial-storytelling
description: Build motivated cuts, holds, continuity and J/L audio edits in a project timeline with reversible `timeline:edit` commands.
---

# Editorial storytelling

Read the approved brief, relevant project artefacts and `AGENTS.md` first. Use this skill when its decision is needed; do not invoke every craft skill for a simple edit. Keep leaf-agent work at depth one. Existing approval and no-spend instructions take precedence.

## Decision and output

Produce `edit-plan` in `pipeline/craft/editorial-storytelling.json` (or the owning stage artefact when its schema already covers these fields): before/after source ranges, track IDs, revision, cut purpose, speech/caption mapping, continuity risk and preview evidence. Distinguish observed facts, artistic choices and unresolved assumptions. Preserve approved source/version pins.

Use `pnpm timeline:edit --help`; preview with dry-run at the expected revision, apply atomically, then render with `pnpm render --project ID --timeline`. Undo/redo restores the recorded timeline.

## Worked decisions

Prepared visualisations mount through `viz:mount`: native overlays or complete format-specific render receipts. Preserve exact rational spans and independent speech/caption tracks. A missing format or mismatched duration is a refusal, never an implicit ripple or stretch; see [visualisations](../../../docs/visualisations.md).

- Hold one chart through two beats that use the same evidence instead of manufacturing a panel cut.
- Begin room tone or dialogue before B-roll as a J cut while the picture track changes independently.

Failure to avoid: Ripple every track because one visual insert was shortened, breaking presenter captions.

## Alternatives and review

A hard cut can emphasise a deliberate reveal; a dissolve can maintain visual continuity. Use explicit per-track ripple and inspect source/output mappings after rate changes.

To move a supporting visual between layers, use the exact rational `transfer` command in the [timeline contract](../../../docs/timeline-edit.md). Both tracks must be visual; preserve source range/rate/captions/payload and inspect the resulting layer order. Attached fades require an explicit transition decision before transfer. Prepare/dry-run against the current revision, then apply only within authorized editing scope and verify undo/readback; the UI drag gesture proposes an edit. Speech/audio/caption tracks stay independent.

When adjacent supporting shots need the same shift, use an atomic `batch` of visual `move` commands so temporary intermediate overlap does not reject a valid final arrangement. The [review UI group controls](../../../docs/local-review-ui.md) resolve 2–24 selected visual IDs and an exact signed output-frame delta into a readonly proposal. Prepare, inspect the final spacing/reading holds/fades, then explicitly Apply at that revision and verify one Undo. Keep dialogue and captions independent; this group move stays inside the current duration and does not ripple other tracks.

To separate a supporting visual into independently movable parts, use the same review UI's `visual-split` form with an exact output cut and a new right ID. Prepare resolves registered static JPEG/PNG or plain muted video and refuses source phase rounding, caption-bearing visuals, attached fades and scene animations that would restart. Apply at the displayed revision, verify one Undo, then inspect the cut and any moved right part in the rendered output. Dialogue, captions and original files remain independent. Generic Apply is timeline CAS; changed original bytes are caught by the renderer, not an atomic filesystem transaction.

For music/SFX attenuation or repetition, use typed `audio-gain`/`audio-loop` commands in the same timeline contract. Gain0 mutes; gain:null removes the multiplier without rewriting existing automation. New loop edits need a registered physical original and local ffprobe; ambiguous duration, nonzero looping source origin and stale evidence refuse before writing. Loop-off beyond the original requires an explicit trim+off batch. Inspect dry-run, apply at the exact revision, then verify readback/undo. These controls never target speech/presenter/caption tracks. Old exports and a mounted measured master do not change with the journal: explicitly remix audio and render the new verified output; direct playback is not the mixer automation/ducking result.

To select another moment of the same B-roll without moving its edit, use **Slip plain video source** in the [review UI](../../../docs/local-review-ui.md). Prepare an exact signed source-frame delta, inspect the resulting source interval, explicitly Apply at the displayed revision and verify one Undo. The initial physical subset is bounded zero-origin CFR H264 MP4, plain muted video without captions/fades/loops/presenter or scene animation. Refuse unsupported clocks, VFR, rounding and physical overflow. Preserve the output interval, rate, original, dialogue/music/SFX and caption tracks; review the actual rendered source moment. Generic Apply checks journal CAS, while render planning rechecks original bytes. A valid source window alone does not establish continuity or creative approval.

To remove a supporting insert without closing its space, use `remove-visual` in the [timeline contract](../../../docs/timeline-edit.md) or the typed **Remove plain visual (keep gap)** review UI. Prepare/dry-run, inspect the exposed lower visual/background, explicitly Apply at the current revision and verify one Undo. Preserve speech/music/SFX/captions and original files. Plain imported static PNG/JPEG or supported muted CFR H264 are the initial UI subset; captions/fades/authored animation/talking-head cases refuse. The final exact duration must remain unchanged, including nested removal batches; do not use an implicit ripple to repair a refused final-owner removal. Render the gap and check its narrative purpose before creative approval.

Review: Does every decision serve the brief? Is there concrete evidence for technical/factual claims? Are timing, continuity, rights and cost assumptions explicit? Can another agent reproduce or revise the decision from the recorded artefact? Use [evaluation briefs](../creative-studio/references/evaluation.md) for review; heuristic scores do not prove audience response.

For aspect-ratio adaptation of a plain supporting visual, use the [review UI's per-format reframe](../../../docs/local-review-ui.md): choose configured format, normalized `x`/`y` cover alignment or reset, readonly Prepare, explicit Apply at revision and one Undo. Keep a face, product detail or evidence in frame without inventing a zoom. Validate the actual crop in every requested format. This limited operation preserves source/timing/protected tracks and rejects authored/presenter/caption/fade cases; compatible plain Slip/Split/group edits retain its map. Source checks and static diagnostic acceptance do not approve moving footage or composition quality.

For a shorter hook or clearer on-screen message, use `authored-copy` in the
[timeline contract](../../../docs/timeline-edit.md) or **Edit authored on-screen
copy** in the review UI. Keep/set headline and subtext, or remove subtext;
Prepare/dry-run, inspect effective fields, explicitly Apply at the current
revision and verify one Undo. Initial support is plain legacy
title/feature/product/CTA or exact `scene.hook` version1 title scenes. Drafting
length/line bounds do not prove fit: render with `--timeline` and review complete
copy, wrapping and safe zones in every requested format. Spoken text and timed
captions stay independent. Talking-head/media/proof and source-owned
factual/educational/workflow projects refuse; retain their evidence and route
changes through the owning approved stage instead of bypassing the guard.
