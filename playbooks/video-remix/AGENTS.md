# Video remix — Agent Rules

Last updated: 2026-11-17

## Start

Start: `pnpm film:init --project <id> --playbook video-remix --product <path>`, then `pnpm next --project <id>`. Existing films keep their playbook: use this preparation at their material step. A source clip or a character reference is not by itself the reference-style modifier; an explicit request to borrow a film's style still is.

## What good looks like

- An unambiguous target, usable originals and deliberate in/out points; no accidental first-30-second truncation.
- Recognisable approved identity through turns and occlusions; motion, camera and preserved elements follow the chosen mode.
- Source audio is explicitly retained, muted or replaced in the edit. A trending song is not automatically cleared.
- The result carries preparation provenance and a passing exact-byte review; source-use rights cover every actual placement and commercial/special use.
- This playbook is draft: offline fixtures verify the harness contract, not live Genjutsu output quality.

## Method

1. Choose the operation: **object-swap** changes only an identified person, face, outfit or object; **motion-transfer** rebuilds the scene around source movement and camera; **restyle** changes the look with a current preset. Inspect `pnpm model:prepare --action profile --mode <mode>` and [the input recipe](../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow). Do not treat the website's limits as the API's limits.
2. Missing clip: inspect `pnpm motion:library --action sources`, research candidates for the requested market and category, and add dated observations with `--action add --input <candidate.json>`. Search with `--action search --project <id>`. Reuse an authorised local original first. `media:fetch --dry-run` plans acquisition of a supported public post; execution needs its own quota/budget. A Higgsfield library preview is not an authorised original export and no public library API is established. If no authorised clip is available, leave it pending and offer licensed footage or a newly recorded performance; do not label either a current trend without evidence.
3. For a supplied link, use `hf:media --action resolve` then `--action acquire` on an exposed public original. A dynamic/private card without an original stays pending or uses a permitted export. The receipt imports bytes for review and can avoid reuploading: set its assetId and `remoteSource` binding in a new preparation only for a full conforming clip without crop/audio changes ([remote recipe](../../docs/higgsfield-prompting.md#remote-genjutsu-source)). Otherwise prepare a local derivative. Import the source and reference originals. Pin approved `entity:card` revisions and roles; record real likeness consent, or not-applicable for an invented character. Use separate clear images, matched to source angles; the board is for review, not an automatic multi-face model input. Do not generate new views of a real person and assert their identity without inspection and approval.
4. At material, write `ModelPreparationSpec` from `src/types/model-preparation.ts`. Specify segment, optional crop, target, change, preserved elements, other subjects, reference order, resolution, style preset where needed and audio policy. The orchestrator runs `model:prepare --action prepare`; the read-only asset-planner only plans and checks. Originals stay immutable. Review the board and full source clip; complete a separate copy of the visual-review template with observed evidence. The house recommendation of a 512-pixel short edge is not a provider minimum.
5. Write the target, change, invariants and other subjects in plain words; `model:prepare` compiles the attachment markers from the prepared source and the exact `image_urls` order ([prompt markers](../../docs/higgsfield-prompting.md#marker-prompting)). Never type a marker or carry this syntax to another model; other endpoints get theirs from `refs:pack`. Markers are a house convention and prove no faithful result.
6. Record the user's source-use decision with `film:rights --preparation <id>` (the exact flags are in `--help`), then their approval with `model:prepare --action approve --id <id> --review <review.json> --answer <their-words>`. These records are declarations, not authentication or independent legal proof. Study-only never authorises publication. A changed clip, reference, prompt, schema or scope needs a new preparation ID and approval. Keep the binding in the material brief as `modelPreparation` and in the generated request's context.
7. `model:prepare --action check`, `hf:quote`, `generate:model --dry-run`, budget review, then the existing authorised durable job. The material gate still controls spend; neither a reference approval nor a source-use receipt authorises unlimited attempts. Preserve the request and output identity on resume. Keep Genjutsu Light pending unless its separate schema/estimate path is established; never inherit this recipe's limits.
8. After publication, `model:prepare --action result-board --id <id> --result <file>` creates result stills and a review template. Inspect the full source/result, identity, motion, preserved elements, other subjects, temporal artefacts and audio. For motion/occlusion windows, follow its returned `vision:pack` arguments, verify each manifest with `vision:inspect`, and open the actual PNG pages/full frames; cite their source hashes and frame IDs in review evidence. Record the completed review with `--action review-result`. Reshoots require the user's decision and a new authorised attempt. A passing review covers exact bytes only. Finish through the existing edit, audio and strict delivery checks.

## Tools

- `model:prepare`: inspect mode requirements, prepare/check inputs, record actual approval, inspect/review results.
- `motion:library`, `hf:media`, `media:fetch`, `asset:import`: dated source research, separately authorised acquisition and immutable originals.
- `entity:card`, `asset:board`: version-pinned identities and review material.
- `refs:profiles`, `refs:plan`, `refs:derive`, `refs:pack`: reference inputs on any other endpoint ([packs](../../docs/reference-packs.md)).
- `hf:quote`, `generate:model`, `budget`, `cost:report`: the existing exact-request paid execution path.
- `film:rights`, `film:approve`, `delivery`: distinct source-use, material/spend and final delivery checks.

## Anti-patterns

- Choosing motion-transfer for a face-only swap that must retain the environment.
- Guessing an API field from a web control, a sibling model, or an unverified Motion Library endpoint.
- Calling a clip trending without dated evidence, or cleared merely because it can be downloaded.
- Approving a template without inspecting the inputs; dropping preparation provenance on an edited derivative.

## References

[Prepared recipe](../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow), [entity cards](../../docs/entity-workflow.md), [media acquisition](../../docs/media-fetch.md), [official mode guide](https://higgsfield.ai/creator-hub/help-center/tools/how-do-i-use-genjutsu).

## Done when

The exact prepared inputs, source-use permissions and authorised budget are current; the published result retains its full source lineage and a passing exact-byte comparison review; replacement audio is completed; and the existing delivery check and user's film approval pass. Pending originals, repairs, reshoots or unknown rights remain unfinished.
