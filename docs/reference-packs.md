# Reference packs

Current models take more than a prompt: character, location, product and style images, first and last frames, motion, camera and control videos, voice clips. A **reference pack** prepares, binds and checks those inputs for one generation, so every paid request that takes references is made from hash-pinned files with a compiled prompt the user approved. Design and decisions: [RFC 0003](rfcs/0003-reference-packs.md). Agent craft: the `reference-preparation` skill (`.agents/skills/reference-preparation/`).

## Concepts

| Term | What it is | Where |
|---|---|---|
| Reference role | What an input is for: `identity`, `wardrobe`, `expression`, `prop`, `product`, `location`, `lighting`, `style`, `first-frame`, `last-frame`, `keyframe`, `motion`, `performance`, `camera`, `depth`, `pose`, `edge`, `mask`, `source-video`, `voice`, `sound`, `music` | `ReferenceRoleSchema`, `src/types/references.ts` |
| View role | The tag on an entity card's reference (`front`, `profile-left`, `packshot-front`, `plate-wide`, `style-board`, `voice-sample`, `expression:*`, `outfit:*`, …) | `EntityViewRoleSchema`, `src/types/reference-view.ts`; [entity cards](entity-workflow.md#coverage-and-view-roles) |
| Profile | What one model family accepts: slots per modality with JSON pointers, roles, limits, marker dialect, prompt order, real-face policy, guidance; every limit with an evidence tier, source and `checkedAt` | `src/lib/models/reference-profiles.json`, `src/lib/references/profiles.ts` |
| Requirement | One input a shot needs: role, modality, source (card view, asset, derivative or another shot's frame), preparation steps, role sentence, status | `pipeline/references.json` (`ReferencesPlanSchema`) |
| Derivative | A file made reproducibly from a pinned input by recorded steps, with a receipt; imported into the asset registry with origin `derivative` | `pipeline/reference-derivatives/<id>/` |
| Pack | One generation's endpoint, ordered attachments (hash, role, marker, pointer), compiled prompt, exact request, board, rights, approval and result reviews; immutable | `pipeline/reference-packs/<id>/` |

## Flow

```text
shot spec, script, approved cards ──► refs:plan draft/check ──► pipeline/references.json
                                         │ (status names the command for each open input)
entity:card coverage ── refs:derive ─────┤
                                         ▼
                              refs:pack prepare ──► board, compiled prompt, request.json
                                         ▼
               user: rights and approval (their words) ──► generate:model with context.referencePack
                                         ▼
                   refs:pack result-board / review-result ──► memory
```

Agents never write markers (`@Image1`, `@Element1`, "image 2"): the compiler emits them from the profile's dialect and checks that every marker names exactly one attachment and every marked attachment is named.

## Storage

```text
public/projects/<id>/
  entities/<kind>/<entity>/versions/NNNNNN.json    # cards: facts, fixedSentence, voice samples
  pipeline/asset-registry.json                     # derivatives registered with origin "derivative"
  pipeline/references.json                         # requirements per shot (revisable, validated on write)
  pipeline/references-board.html                   # refs:plan --action board --save
  pipeline/reference-derivatives/<id>/             # spec.json, receipt.json, board.html; a pending.json while a paid step runs
  pipeline/reference-packs/<id>/
    spec.json  board.html  visual-review-template.json  request.json
    receipt.json                                   # written last: the pack is complete
    rights.json  approval.json                     # the user's statements, bound to the pack hash
    results/<outputSha256>/                        # result.json, board.html, stills, review-template.json, review.json
  pipeline/model-preparations/<id>/                # the Genjutsu path (model:prepare)
```

Derivatives and packs are immutable: the same id with the same spec returns the stored one; a changed spec under the same id is `FILE_EXISTS`. Hashes: `receipt.requestSha256` is the canonical-JSON sha256 of `{provider, endpoint, input}`; `packSha256` is that of the parsed receipt; `request.json` is that request plus `context.referencePack: {id, sha256: packSha256}`.

## Commands

| Command | Actions | Spend | MCP |
|---|---|---|---|
| `refs:profiles` | `list`, `show --family F`, `for --endpoint E [--provider]`, `check` (profiles against the catalogue, input schemas and guards) | none | `refs_profiles` |
| `refs:plan` | `draft --shot --material-item --intent (--family \| --endpoint) [--entity kind:id[@rev]]… [--asset role:sha256:HEX]… [--chain-from SHOT] [--write]`, `check`, `status`, `board [--save]` | none | `refs_plan`; `--save` is CLI only |
| `entity:card` | `coverage --kind K --id E [--revision N]` (advisory) | none | `entity_card` |
| `refs:derive` | `plan --spec`, `run --spec [--confirm-spend] [--max-cost-usd]`, `show --id` | `may-spend` (fal steps only) | `refs_derive`: `plan` and `show`; `run` is CLI only |
| `refs:pack` | `prepare --spec`, `check`, `board`, `list`, `rights`, `approve --review --answer`, `request`, `result-board --result`, `review-result --review` (all but `prepare` and `list` take `--id`) | none | `refs_pack`: `prepare`, `check`, `board`, `request`, `result-board`; `rights`, `approve` and `review-result` are CLI only |

`--entity` and `--asset` repeat or take comma-separated lists. Every command emits one JSON line ([CLI contract](../scripts/AGENTS.md)).

In a bespoke film the `material` step lists `refs:plan`, `refs:profiles`, `entity:card`, `refs:derive` and `refs:pack` among its commands, so the [step lease](step-lease.md) admits them there. `refs:derive` is registered `may-spend`: under an enforcing lease, `--action plan` and `show` run with `--dry-run` before the user's material approval, and `run` waits for it like any other material spend.

## Profiles

From `src/lib/models/reference-profiles.json` (checked 2026-11-17; `pnpm refs:profiles --action show --family F` for the full slots, pointers, pixel and fps limits, guidance and evidence). Slot counts are per request unless noted; `element-references` counts per element; "positional" slots are bound by field and never named by a marker.

| Family | Provider | Endpoints | Dialect (tier) | Slots | Real faces |
|---|---|---|---|---|---|
| `seedance-2.0` | fal | 3 | at-indexed (wrapper) | `images` ≤9; `videos` ≤3; `audio` ≤3 | rejected |
| `seedance-2.5` | fal | 2 | at-indexed (wrapper) | `images` ≤30; `videos` ≤10 (1.8–30.2 s); `audio` ≤10 (1.8–30.2 s); total ≤50 | rejected |
| `kling-o1` | fal | 2 | at-element (official) | `images` ≤4; `elements` ≤4; `element-references` 1–3 | unknown |
| `kling-o3` | fal | 3 | at-element (wrapper) | `images` ≤4; `elements` ≤4; `element-references` 1–3; `element-video` ≤1 (3–10.05 s); `start`, `end` positional; with a video, images plus elements ≤4 | unknown |
| `kling-o3-video` | fal | 6 | at-element (wrapper) | `source` video 1 (3–15.05 s); `images` ≤4; `elements` ≤4; `element-references` 1–3; with a video, images plus elements ≤4 | unknown |
| `kling-v3-motion-control` | fal | 2 | at-element (wrapper) | `character` image 1 and `motion` video 1 (3–30 s), both positional; `face` ≤1; `face-references` 1–3 | unknown |
| `kling-v2.6-motion-control` | fal | 2 | natural (unverified) | `character` image 1 and `motion` video 1 (3–30 s), both positional | unknown |
| `nano-banana-2.1` | fal | 1 | prose-indexed (wrapper) | `images` ≤14; `video` ≤1 | unknown |
| `flux-2` | fal | 3 | prose-indexed (official) | `images` 1–4 | unknown |
| `gemini-omni` | fal | 2 | natural (official) | `images` ≤6; `videos` ≤3 (≤3 s) | unknown |
| `genjutsu-object-swap` | higgsfield | 1 | at-indexed (observed), `genjutsu-legacy` template | `source` video 1 (4–30 s); `images` 1–8 | consented-flow |
| `genjutsu-motion-transfer` | higgsfield | 1 | at-indexed (observed), `genjutsu-legacy` template | `source` video 1 (4–30 s); `images` 1–8 | consented-flow |
| `genjutsu-restyle` | higgsfield | 1 | at-indexed (observed), `genjutsu-legacy` template | `source` video 1 (4–30 s); `images` ≤5 | consented-flow |

Dialects: `at-indexed` emits `@Image{n}`, `@Video{n}`, `@Audio{n}`; `at-element` emits `@Element{n}` for elements and indexed markers for the rest; `prose-indexed` "image {n}"; `natural` a role description from the role sentence. `at-named` and `parameter` exist in the schema with no profiled family. An endpoint with no profile (`refs:profiles --action for` answers `profiled: false`) cannot be packed. Profiles change only with a source and a test; `refs:profiles --action check` keeps them in step with the catalogue schemas and the provider guards.

## Requirements and the material gate

`refs:plan --action draft` proposes a shot's requirements from its intent (`keyframe-image`, `image-to-video`, `reference-to-video`, `video-edit`, `motion-transfer`, `character-replace`, `control-to-video`, `lip-sync`, `voice`, `extend`), the target profile, linked cards (front first, then one view per angle group, every character's second angle before any third) and imported assets, keeping only what fits the profile's slots; `dropped` and `notes` say what was left out and why. `--chain-from SHOT` takes the first frame from that shot's last frame and sets `chaining: "anchor-reinject"`, so identity references are attached again.

`refs:plan --action check` refuses over-limit counts, a role in a slot that does not take it, `ready` without a resolvable source, media outside a slot's limits after its preparation steps, last-frame chaining without anchor re-injection, and a consented real face aimed at a `realFaces: rejected` profile. `status` lists open inputs per shot with the command that resolves each.

The film chain's `material` step checks `references-ready` in two phases ([material](production-chain/material.md)): every generated visual item not yet acquired (`generated-image`, `generated-video`, or any non-audio item on the `generated` route) has a shot in `references.json` or `referencePlan: {mode: "none", reason}`. Before the material approval, those shots have no check error and no required input left `missing`; after it, every required input is `ready` and the item's `referencePack: {id, sha256}` names an approved, current pack. An acquired item is not re-checked here; `material-sourced` keeps it bound to the pack revision it was made from (approval bound to that receipt) and requires its file's sha256 in that pack's `outputs.json`, so a later profile or schema refresh does not reopen it. A film whose material was sealed or approved before reference packs (no `references.json`, no item with `referencePack` or `referencePlan`) gets advisories instead of failures.

## Derivatives

A file outside a slot's limits is never repaired silently: the compiler refuses it and names the derivative step that fixes it. `refs:derive --action plan` reports each step's engine, status and, for a fal step, the request and offline quote.

| Op | Engine today |
|---|---|
| `trim`, `crop`, `scale` (`pad`, `crop`, `exact`), `fps`, `snap`, `extract-frame`, `flatten`, `strip-audio`, `audio-trim`, `loudness`, `contact-sheet`, `edge-video` (`canny`) | ffmpeg, local and deterministic: the same spec gives the same bytes on the same ffmpeg |
| `cutout` | local matte ONNX model (`src/lib/matte`) |
| `depth-video`, `pose-video`, `mask-video`, `audio-clean` with engine `fal` | paid: one durable job through the `generate:model` library path, budget admission and a stable operation id; `pending.json` until published. Default endpoints in `src/lib/references/derive/fal.ts` |
| `blender-pass` (`beauty`, `clay`, `depth`, `normal`, `mist`, `camera-path`) | local Blender through `blender:run`'s machinery and `scripts/blender/kit/passes.py`; the input asset is the target whose size and frame count the pass matches |
| local `depth-video`, `pose-video`, `mask-video`, `audio-clean`; `edge-video` `lineart` | not built yet; `plan` says so |

A paid or Blender step must come first; chain local steps after it in a second derivative whose `input` is `{derivativeId}`. A paid step runs only with `--confirm-spend` after the user's yes to its quote, and `--max-cost-usd` when its price is unknown.

## Packs, approval and generation

`refs:pack --action prepare --spec SPEC.json` resolves each attachment from the asset registry, measures it, orders and binds it to the slot's pointer, emits markers, composes the prompt in the profile's order (action, bindings, invariants, camera, audio, preserve, other subjects, avoid, additional), checks the marker bijection, validates the input against the endpoint schema and the provider guard, and writes the pack. Likeness and voice consent are checked from the cards (`src/lib/references/packs/consent.ts`).

`rights` (needed for any video attachment and any input whose provenance is not generated) and `approve` (a completed `visual-review-template.json` and `--answer` with the user's words) record the user's statements, bound to `packSha256`. `request --id` emits the request; pass it to `generate:model` unchanged.

`generate:model` recognises profiled endpoints. A request with `context.referencePack` must match the pack's hash, approval and request bytes; a tampered request fails. A profiled endpoint receiving reference fields without a pack is governed by `AGENTBROS_REFERENCE_PACKS`: `warn` (default) warns on stderr, `enforce` refuses fresh paid submissions, `off` skips the check (case-insensitive). The rule applies to every fal paid submission (`executeFalOperation`: `generate:video`, `generate:image` and the rest), not only `generate:model`; only a Genjutsu endpoint with `context.modelPreparation` is exempt. A job resumes past the gate only once it may have reached the provider (a provider request ID, receipt or release, or an ambiguous `submitting`/`unknown` submit); a merely reserved job is admitted again. A resumed job keeps the pack binding it was submitted with: a pack deleted or changed since only warns. Published outputs of a pack are recorded in `pipeline/reference-packs/<id>/outputs.json`, best-effort: when the pack on disk is no longer the bound revision, the output is still published and the record is skipped with a warning (`metadata.warnings`). Such an output is not linked to any pack, so a material item made from it fails `material-sourced` until it is rebound or regenerated from the current pack. `model:prepare --action as-pack` checks parity before writing, so a mismatch leaves no pack.

## Sensors and result review

Sensors (`src/lib/references/sensors.ts`) measure each derivative output and pack attachment against its role: format and slot limits, alpha, border uniformity (a neutral-background heuristic), luminance spread (an even-light heuristic), scene cuts and camera motion in motion or performance clips, black or frozen spans, temporal flicker and frame count of control videos, audio clipping, noise floor and silence, and the spread of declared yaw angles. A sensor is evidence with a severity, never a verdict; thresholds change only with a test.

`result-board --id PACK --result FILE` makes stills and a review template for one published output; `review-result` records `PackResultReviewSchema`: `identity`, `wardrobe`, `preserved`, `otherSubjects`, `motion`, `naturalness` (no copy-paste of a reference's pose, light or background), `promptFit`, `temporalConsistency`, `audio`, and a `verdict` of `pass`, `repair` or `reshoot`. A failed dimension cannot pass; a reshoot is the user's decision. Identity similarity is optional evidence with its model and version. Each review becomes a memory observation (family, roles, verdict, failing dimension); a problem seen twice becomes a profile guidance line, coverage rule or sensor threshold with a test.

## Genjutsu

The three Higgsfield Genjutsu modes are profiles with the `genjutsu-legacy` prompt template, which reproduces the existing prepared prompt byte for byte. `model:prepare` stays the Genjutsu entry point with the same CLI, and compiles its markers through the pack compiler; existing `pipeline/model-preparations/` records and `context.modelPreparation` bindings remain valid. Mode choice, source rules and result review: [Genjutsu prompting](higgsfield-prompting.md#prepared-genjutsu-workflow).

## Checks

`tests/reference-profiles.test.ts`, `reference-profile-snapshots.test.ts`, `reference-compile.test.ts`, `reference-packs.test.ts`, `reference-plan.test.ts`, `reference-derive*.test.ts`, `reference-sensors.test.ts`, `reference-schemas.test.ts`, `reference-pack-generation.test.ts`, `reference-review-fixes.test.ts`, and `reference-preparation-skill.test.ts` (every model-specific number in the skill carries a source, tier and date).
