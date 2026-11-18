# Prepared visualisations

Prepared visualisations v1 provides the bounded recipes, rendering backends and integration contracts below. The owner approved the exact unmodified `elkjs@0.12.1` package under EPL-2.0; the package-scoped policy, notices and source obligations are recorded in the review. This approval does not apply to other EPL packages.

## Agent workflow

Use commands and JSON requests. Start with `pnpm viz:list --recipe bars`: it returns the strict request schema and an example. Prepare with `pnpm viz:prepare --project ID --request REQUEST.json --dry-run`, then repeat without dry-run. The response identifies an immutable revision. A revision of an existing scene requires `--expected-revision HASH`.

`viz:inspect` lists prepared formats. `viz:preview` writes inspection frames; `viz:render` writes a local video and receipt. Use explicit `--revision HASH`, `--format landscape` and, for 3D, `--backend three` or `--backend blender`. New revisions never overwrite old bundles. Interrupted clip renders never publish their partial MP4; retry the same pinned command. Blender retries verify and resume completed frames. Requests and input files are limited to 8 MiB; compiled revision bundles, including archived sources, are bounded at 64 MiB.

Review rendered videos with `pnpm vision:pack --input VIDEO --output REVIEW_DIR --profile motion`, then `pnpm vision:inspect --manifest REVIEW_DIR/manifest.json --frame FRAME`. These [source-bound review tools](agent-vision.md) verify the video and review images; they do not replace visualisation evidence or delivery checks.

Prepare every configured project format. Layouts are independent; there is no landscape-to-portrait scaling fallback. IDs must not collide with generated IDs or event aliases in that layout (axis paths, ticks, units, legends, series paths, labels and tree edges). Preparation identifies the collision and asks you to rename the supplied ID; ordinary IDs remain available when no corresponding generated element is emitted. Compiled primitive IDs are unique. Graph data uses stable node and edge IDs; source and target values are IDs, never media paths. CSV/TSV mappings are explicit. Dates require `xScale: "utc"` and canonical `yyyy-mm-dd` dates. Missing numeric observations remain gaps. Stacks require explicit nonnegative cells for every category/series pair.

Layered process/network recipes use ELK. Optional `groups` contain stable `id`, `label` and `parent`; datum `group` assigns membership (four levels maximum). Each datum can declare up to eight globally unique `ports` with `id` and `side` (`NORTH`, `EAST`, `SOUTH`, `WEST`). Edges select `sourcePort` and `targetPort` belonging to their endpoints. Compound offsets and routed bends are compiled separately for every format; unreadably dense layouts fail. Force layouts, trees and Sankey reject these layered-only features.

## Mounting and editing

`viz:mount` proposes changes by default. `--apply` commits; it cannot be combined with `--dry-run`.

- Native 2D overlays use `--overlay NAME --timeline-revision N`, and preserve phase through timeline slicing. Timeline undo/redo applies normally.
- Template slots use `--target-scene SCENE --config-hash SHA256`; the slot must explicitly have the prepared duration.
- Rendered clips use `--track TRACK --clip CLIP --timeline-revision N`. A single-format project takes `--receipt FILE`. Multiple formats require `--receipts FILE`, a strict `{version:1,receipts:[{format,receipt}]}` manifest covering every configured format.
- Visualisation-only bespoke films use `--shot SHOT --plan-hash SHA256`; an existing generated build also requires `--build-hash SHA256`. Every shot must have a prepared binding, exact 30fps duration and explicit cuts. This command refuses to overwrite a custom bespoke build.

Clip replacement validates physical dimensions, frame count, fps, registered bytes and exact rational duration. It does not stretch, ripple or hold a mismatched source. Caption-bearing clips are refused. Format variants are selected explicitly by the project renderer; missing variants fail. Per-mount receipt bindings keep data ownership separate from content-hash deduplication of video assets.

## Provenance and checks

Blender previews render only the opening, middle and final frames. Full sequences resume verified existing frames. Spatial chart bars and network/process nodes use extruded blocks; `circle` is the 2D network symbol and its diameter supplies the spatial block extent. Shared frame states and orthographic camera projection feed Three and Blender; paths are depth-tested behind solids, while upright text remains a projected overlay. Acceptance compares anchors within one pixel rather than comparing unlike engines' pixels.

Derived shorts copy texture, evidence, original bundle and receipt ancestry into their own project before computing immutable episode hashes. Claim ownership and paths are rebound, and rendered receipts explicitly retain the original pixels' ancestry; they are never relabelled as newly rendered pixels. Deleting an ancestor project does not remove the descendant's closure.

Data and source copies are frozen in revision bundles. Active render identity captures pinned bundles, receipts, texture maps and relevant code. Before/after render checks reject changed textures or renderer inputs. Native overlays cannot supply internal Blender plate paths.

Quantity evidence uses exact local records and existing owning workflow claims. The collector uses actual mounted scene/clip ownership. Missing ownership or claims remain unverified. Technical checks never grant factual, creative or rights approval. Inspect real frames and motion; a JSON output path is not a visual review.

## Verification

Fast tests cover strict contracts, quantitative domains, compound ports, source hashes, generic and legacy quantity identities, ownership, native/template/clip mounting, MCP scope, review summaries, bespoke film gates, content-addressed props and delivery snapshots. Derived workflow tests exercise planning, publication, readiness, idempotence, all rendered variants and repeated ancestry after deleting source projects.

`RUN_VIZ_RENDER_TESTS=1` enables real opening/middle/final browser frames for every recipe/format, partial named-event frames, a complete generated bespoke clip and CLI cancellation followed by retry. `RUN_VIZ_BLENDER_TESTS=1` enables actual CPU frames for all three spatial recipes in every format, moving-camera origin and animated extent parity within one pixel, a full sequence, verified resume and fresh singleton-versus-sequence pixel equality. Python colour and coordinate checks use pytest on Python 3.12.16, ruff with all rules and ty. Acceptance images are written under `out/qa/viz-acceptance` and `out/qa/viz-blender-acceptance`; low-resolution one-sample images prove geometry, not final material quality.

Final acceptance also requires viewing full-size settled Three/Blender composites, inspecting readable labels and depth, repository integration checks and independent review. Technical acceptance does not approve an individual film's claims or creative treatment. Production delivery remains governed by the existing snapshot and check commands.
