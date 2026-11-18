# Blender arsenal — Agent Rules

Last updated: 2026-11-16

What a Blender shot may draw on beyond Blender itself: pinned extensions, asset libraries, VFX and scene recipes. Directing a shot: the `blender-3d` skill; running one: [scripts/blender/AGENTS.md](../scripts/blender/AGENTS.md).

## Layout

| Path | Tracked | Holds |
|---|---|---|
| `extensions.json` | yes | Research pins: version/hash/size, licence, permissions/platforms, verdict, recommendation, render/authoring usage, status, evaluation |
| `generators.json` | yes | Strict optional generator pins, capabilities, install boundary, cost/verdict/evaluation; Infinigen deferred, Gscatter rejected, native nature and city experimental, Buildify manual; built-in Mantaflow/volume grids and source-hashed procedural materials |
| `libraries.json` | yes | Asset sources: licence, attribution, adapter, how an item is fetched and verified |
| `collections/*.json` | yes | Curated asset ids per use case (a studio product shot, a desk scene); ids only, never files |
| `local/` | no | Everything fetched or generated on this machine |
| `local/blender-user/` | no | `BLENDER_USER_RESOURCES` for runs with extensions; your own Blender profile is never touched |
| `local/downloads/` | no | Verified archives, named by sha256 |
| `local/library/<kind>/<source>/<asset-id>/` | no | Unpacked assets, each with an asset record (licence, source, sha256); kinds: models, materials, hdri, textures, node-groups, fonts, decals |
| `local/library/index.json`, `blender_assets.cats.txt` | no | Generated search index and Blender asset catalog |
| `local/generated/` | no | City source snapshots and code/parameter-addressed `.blend` geometry with receipts/credits |
| `local/bakes/<recipe>/<hash>/` | no | Simulation caches |
| `local/trials/<candidate>/` | no | Sandbox trials of candidates not yet approved |

Paths in code: `src/lib/blender-arsenal/paths.ts` and its Python twin `scripts/workers/blender/avc_arsenal.py`. Recipes are code in `scripts/blender/recipes/`. Evaluations of candidates: [docs/blender-arsenal/](../docs/blender-arsenal/).

## Rules

- Nothing under `local/` enters git; a contribution is a manifest entry, a collection, a recipe or an evaluation.
- Built-in Blender first (Geometry Nodes, simulation nodes, the bundled Essentials); an extension or library only where it adds what built-in cannot.
- Extensions: `pnpm blender:ext` inspects, proposes, trials, approves and installs pins; [guide](../docs/blender-arsenal/README.md). `blender:run --extensions ID` enables approved installed pins under factory startup. Network/account dependencies need explicit approval.
- `local/blender-user/installed.json` records installed versions and hashes; `list`/`doctor` detect drift. Trials have separate profiles. Never load the user profile.
- `BLENDER_SYSTEM_EXTENSIONS` is isolated too. Two scoped FX integrations (Tissue and Molecular Nodes) are approved under the owner’s realism-wave consent; wrappers remain experimental. Seven earlier adopts remain proposed: six pass Blender 5.3; Node To Python export is blocked. Fourteen maybes and twenty-two rejections are pinned. Native asset-library descriptors add browsing metadata; direct pinned append remains the headless route. Owner approval is separate from trial/download consent.
- Downloads and installs need the user's consent; record it in the manifest entry.

## Asset libraries

`pnpm blender:assets` searches approved sources, fetches only with `--consent`, optionally pins exact bytes with `--pin`, indexes PBR roles/catalogues, resolves collections and reports project credits. Sources have dated licence/API research; starter collections resolve to exact sample pins. `--action import` ingests user-downloaded ZIPs; `index --bundled` indexes installed Essentials in place. Download consent is per acquisition, not implied by source approval. Library-server appends enforce licensed names/types and 5.2 compatibility. Contracts: `src/lib/blender-arsenal/libraries/schemas.ts`; append in Blender with `avc_assets.append`, `register_library`, `bundled_assets` (session only; never save preferences). [Guide](../docs/blender-arsenal/README.md). `assets:sync` still owns shared harness media; this store holds per-shot picks.

## Live look development

`blender:live` exposes local-only `append-asset`, `apply-recipe`, `enable-extension` and read-only `arsenal`. Start with `--extensions <ids|approved>` to use approved installs. Journals pin receipts/payloads, recipe defaults/code and extension versions; `export-recipe` writes a shot script calling the arsenal helpers. See [live session](../.agents/skills/blender-3d/references/live-session.md).
## Agent overview, growth and evaluation

`pnpm blender:arsenal status` reads approval/installed states, local kind/source counts, collection present/missing commands and bake bytes. `--proof PATH/index.json` adds measured recipe costs/status; without a proof every recipe is unmeasured. `init` creates the local map; `candidates` merges proposed/rejected extensions and sources; `--capability TAG` also includes approved tools, generators and recipe verdicts. `audit` is the offline contribution gate (schema/evidence/consent/reasons/known collection sources/literal META/no tracked local files), with problems and fixes. None of these actions downloads or enables code.

Follow [grow the arsenal](../.agents/skills/blender-3d/references/arsenal.md), then [contribute](../docs/blender-arsenal/CONTRIBUTING.md). `pnpm blender:arsenal --action eval --harness codex` runs fresh read-only executable-plan agents for ten briefs in `bench/blender-arsenal/tasks.json`, writes raw responses and scored reports under `out/qa/arsenal-eval/`. Claude uses restricted Read/Glob/Grep only. `--repo` selects a read-only baseline checkout, `--tasks` selects comma-separated ids, `--out` must be new. Tests inject `ARSENAL_EVAL_HARNESS_BIN`; no tests contact a harness service. [Evaluation limits](../docs/blender-arsenal/README.md#planning-evaluation).

Eval v2: `--samples 2 --concurrency 2`; target-checkout registry/parser flags, META params, pinned/indexed assets and extension approval are verified offline. Python AST checks actual scene/parameter/bake evidence; reports give mean/SD/range. Ten CC0/bundled sources have owner consent; mixed-licence/keyed/OFL registries remain proposed. Manual sources stay manual.

`rescore --report PATH/report.json --out NEW` rechecks all saved replies against frozen contracts without model calls, preserving originals and correction provenance. Changed raw replies, Python source or task/schema identities are refused.

## Improvement history

Tracked `improvements/<date>-<slug>.json` holds strict numeric A/B logs, diagnoses, typed changes, kept/reverted decisions and gaps; no media. `pnpm blender:improve` builds sanitised packets (private key separate), runs fresh read-only critics/advisors, scores both orders, logs, ranks gaps and reads target history. `blender:arsenal candidates --capability TAG` includes open gaps from logs and local Blender memory. See [self-improvement](../.agents/skills/blender-3d/references/self-improvement.md). Only both-order wins with passing sensors/tests may be kept.

Nature: `candidates --capability nature|terrain|trees|vegetation|rocks|sky` includes approved tools and verdicts. `src/lib/blender-arsenal/generators.ts` validates external commit pins; status/audit read them without installing. Sapling 1.0.0 is owner-approved for this wave. `local/generated/sapling-tree/<hash>/tree.blend` caches trees; terrain/planting data use `local/bakes/`. See [nature evaluation](../docs/blender-arsenal/nature.md).

City choices: `pnpm blender:arsenal candidates --capability city` includes approved generators, proposed BlenderGIS and manual Buildify with verdicts. Without a filter, the existing non-approved view remains. The offline audit validates the generator schema/evaluations and recipe dependency references. `pnpm blender:city` acquires bounded OSM footprints once, with consent, SHA-256 and © OpenStreetMap contributors, ODbL; `osm-city` renders only cached data. Native GN `procedural-city` and `window-lights` need no download. [Measured scope and limits](../docs/blender-arsenal/city-realism.md): skyline is experimental; no SRTM or Buildify payload. BlenderGIS is legacy/proposed, not accepted by the modern extension installer; its import can download an undeclared native dependency.

Vork (2026-11-15): external pinned local renderer, experimental generator verdict. `vork:setup` owns installation; it is not enabled as an add-on. The separately GPL bridge and supported mesh/plate hand-offs are documented in [Vork](../docs/vork.md).

Procedural materials 1.0.1 (2026-11-16) updates the active source hash after AST-identical Python formatting; historical evaluation/receipt hashes are retained.
