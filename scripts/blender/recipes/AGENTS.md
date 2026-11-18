# Blender recipes — Agent Rules

Last updated: 2026-11-18

Built-in and pinned-extension effects, composed through `scripts/workers/blender/avc_recipes.py`. Built-ins never download; optional tree engines need explicitly enabled, approved extensions; city imports read a consented offline cache. Dependencies are declared in optional `requires`; capability tags support arsenal discovery. Reach for a recipe before writing an effect. Current verification: Blender **5.3.0**, the original 16 comprise 11 ready and 5 experimental; five FX wrappers are experimental; nature and city recipes are experimental ([nature](../../../docs/blender-arsenal/nature.md), [city](../../../docs/blender-arsenal/city-realism.md)). Scores are the implementing agent’s visual judgement, not blind critic acceptance. Measured evidence.

## Contract

Each module opens with shot intent and meaningful knobs. `META` is one literal dict, read through Python AST without execution: `id`, `title`, `category`, `intent`, `params` (type, default, doc, numeric min/max), `frames_hint`, `cost_hint` (Cycles/EEVEE seconds per 640×360 / 16-sample frame, null when unmeasured), `needs_bake`, `status` (`ready`/`experimental`), optional `capabilities`, `inspired_by` and `requires: {extensions: [], generators: []}` (required extension ids flow into the isolated runner; `tree.engine=sapling` needs `--extensions sapling_tree_gen`). Schema: `src/lib/blender-arsenal/recipe-schema.ts`. Any visual axis below 3/5 means experimental; retain it in the catalogue.

`apply(scene, params, timeline=None)` adds to the current scene and returns `{objects:[names], materials:[names], bake:{path,reused,seconds}|None}`. The helper inventories created datablocks; supplied heroes are never returned as created. Unknown params fail. Empty `object` makes a proof subject; an existing named mesh must exist. Scatter snapshots static mesh geometry and inherits animated object transforms: apply before reveals, use a static duplicate for deformations; shape keys and deformation/topology modifiers are rejected. Grow adds a non-destructive capped Boolean; dissolve copies the target mesh datablock and replaces its material. Neon/dissolve insert owned glare without replacing an existing composite; Blender 4.x uses the legacy compositor branch, 5.x the scene node group. Blender 4.2–5.1 was not executed in this round.

A supplied kit Timeline is populated and the caller bakes it once; otherwise the recipe keys the scene range with shutter guard frames. Motion is a pure function of frame and seeded variation. Named node groups use `AVC`. Ribbon samples already deterministic/baked transforms over frames 1–64. Do not compose it over an unbaked simulation.

No live simulation reaches rendering. `_common.bake()` publishes complete JSON atomically under `avc_arsenal.paths()["bakes"]/<recipe>/<hash>/bake.json`, keyed by normalised params, code/kit AST and context. Editorial META/docstring edits do not invalidate a bake; code changes do. Dust caches drag/gravity paths; cloth simulates sequentially in an isolated collider/effector collection, exports mesh snapshots, removes the simulation modifier, then uses shape keys. Cloth includes Blender version, fps, gravity and units in its key. Never use rigid-body `point_cache.use_disk_cache` in background 5.2.3 (native crash). Keep caches/profile/system extensions under ignored `local/`.

## Measured catalogue

Seconds/frame on M1 Max Metal, shared machine. P = full 640×360 / 16 samples (six tournament recipes only). K = median of five single-frame 480×270 / 8-sample renders, denoised. K excludes cold-start outliers by using the median, not an inferred P cost. EEVEE is unmeasured. Load and Blender versions differ from v1; do not claim a controlled speedup. Default shot: 64 frames at 30 fps.

| Id | Intent / implementation | P s/f | K s/f | Bake | Status |
|---|---|---:|---:|---|---|
| abstract-field | Grounded GN pins carry a wave into a hold | 0.639 | 0.90 | no | ready |
| caustics-glass | Polished optical ring with moving hard key and Cycles shadow caustics | — | 1.20 | no | ready |
| cloth-drape | Burgundy satin drops and folds over an isolated support | — | 1.20 | mesh snapshots | ready |
| confetti | Seeded foil burst, tumble and flat landed hold | — | 1.20 | no | ready |
| dissolve | Noise boundary burns through a metallic form; blind sparse comparison leaves edge realism unresolved | — | 1.40 | no | experimental |
| dust-burst | Impact motes plus fading noise veils; underlit proof remains experimental | 1.683 | 0.90 | trajectories | experimental |
| grow-in | Axis reveal with a capped Boolean edge and follow-through | — | 1.30 | no | ready |
| light-sweep | Kit strip light reveals a machined surface | 0.673 | 0.90 | no | ready |
| liquid-pour | Cached Mantaflow pour into a vessel; frame-pure remap | — | — | mesh cache | experimental |
| liquid-splash | Analytical crown and droplets; stylised material remains experimental | — | 1.30 | no | experimental |
| molecule | Molecular Nodes structure from local PDB/CIF or attributed `pdb_id` | — | — | structure | experimental |
| neon-glow | Drawn emissive loop, preserved compositor and grounded proof mount | — | 1.50 | no | ready |
| osm-city | Cached real-place closed OSM ways; tagged heights; local material override | — | — | static blend | experimental |
| pattern-surface | Tissue tessellation over a product surface | — | — | no | experimental |
| procedural-city | Seeded GN blocks, floor/window grids, streets; day/night | — | — | static blend | experimental |
| product-splash | Cached Mantaflow crown around a product; freeze ramp | — | — | mesh cache | experimental |
| ribbon-trail | Tapered copper trail follows deterministic sampled transforms | — | 1.90 | no | ready |
| scatter-surface | Gold pearls grow over a static mesh; canonical area sampling and linked meshes | 0.959 | 0.80 | no | ready |
| shatter | Voronoi monolith compresses, bursts and lands; deterministic trajectories | 0.823 | 1.00 | no | experimental |
| sky-atmosphere | 5.3 physical sky, time presets, sun and bounded volume; woodland stage | — | — | no | experimental |
| smoke-plume | Mantaflow VDB plume or frame-driven density grid | — | — | VDB / no | experimental |
| smoke-wisp | Animated GN density grid (46,080 voxels); narrow soft proof remains experimental | — | 1.30 | no | experimental |
| studio-floor | Seamless cyclorama and optional transparent shadow receiver | — | 0.90 | no | ready |
| terrain | Cached seeded displaced mesh; scan shaders blend by slope/height | — | — | grid | experimental |
| text-3d | Bevelled metal title, accelerating staggered landing; Bfont or local font | 0.863 | 0.90 | no | ready |
| tree | Native GN leaf instances or pinned Sapling; birch/oak/pine, keyed sway | — | — | skeleton / Sapling .blend | experimental |
| vegetation-scatter | Cached density/clearing/camera mask, linked grass, flowers and rocks | — | — | positions | experimental |
| window-lights | Seeded emissive office panes switching on as a pure frame function | — | — | no | experimental |

## Commands and quality loop

```bash
pnpm blender:recipe list
pnpm blender:recipe describe --id dissolve
pnpm blender:recipe render --id text-3d --params '{"text":"FORM"}' --frames 1-64 --samples 16 --resolution 640x360 --output out/qa/recipes/title-new
pnpm blender:recipe bake --id cloth-drape --output out/qa/recipes/cloth-bake-new
pnpm blender:recipe proof --all --frames 16-18 --samples 4 --resolution 160x90 --device cpu --output out/qa/recipes/check-new
```

Runner: `scripts/blender-recipe.ts` → existing `runBlender`. CLI `--device auto` selects GPU; library API defaults to CPU. User resources/config/scripts/extensions/datafiles and system extensions are isolated under `local/trials/recipe-profile/`. `list`/`describe` need Python, never bpy. `render` writes a manifest, stats, frames, preview and contact sheet. `bake` uses no-render mode; `--bare` omits proof lights/floor; `--dry-run` validates. Output must be new.

For economical iteration render frames **1, 12, 26, 44, 64** separately at 480×270 / 8 samples, inspect a strip plus three full PNGs, and cap at two critique passes. Score motion/light/material/composition honestly. Render full 640×360 / 16-sample sequences only for selected final effects. Run one Blender process at a time on a shared machine. Do not mistake five sparse frames for full flicker evidence.

`proof` renders a range, midpoint alone and matching empty stage, measures pixels and geometry, and verifies the same bake path is reused. CPU disables output dithering and pins compositing/denoising to CPU; max RGB difference must be 0 (null PSNR = infinity). Metal permits max ≤2 and PSNR ≥80 dB; it also gets an exact CPU pair. A version change during the run fails explicitly. Sensors cover non-empty luminance/variance, clipping, difference coverage, activity/flicker and projected floor darkening. Sparse `frameNumbers` normalise by elapsed gaps; activity is gap-weighted. Full-sequence temporal-only analysis may explicitly disable coverage; coverage/contact still need matching baseline evidence. Glass uses a rear/right receiver patch because refraction can brighten the front. Counts include the proof stage and evaluated instances; volume mesh polygons do not describe voxel cost.

`RUN_BLENDER_TESTS=1 pnpm exec tsx --test tests/blender-recipes.test.ts` checks each recipe’s frame 17 alone against 16–18 on CPU and tests compositor/created-object ownership. `BLENDER_RECIPE_TEST_OUTPUT` retains its evidence; `BLENDER_EXPECTED_VERSION` pins the assertion. Pure helpers: `uv run --locked python tests/blender-recipes.test.py`. Ruff retains ALL rules with scoped dynamic-bpy/numerical-graph exceptions. Contribute code, tests, measured numbers and a visual verdict, never renders.

Nature, city and FX families (checks, caches, acquisition, dependencies): [recipe families](../../../docs/blender-arsenal/README.md#recipe-families).

2026-11-18: fluid callback attribute diagnostics use ty's current `missing-attribute` rule.
