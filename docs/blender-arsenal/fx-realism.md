# FX generators: scope and limits

## Verdict

Experimental FX integration on Blender 5.3.0, macOS ARM64. No production-quality or blind-win claim is implied by registration or deterministic pixels. Current qualification is limited to the wrappers and settings below. All renders and downloads remain ignored; no user Blender profile is used.

## Routes

The new recipes are `liquid-pour`, `product-splash`, `smoke-plume`, `molecule` and `pattern-surface`. Discover with `pnpm blender:arsenal candidates --capability fluids` (also `volumes`, `science`, `pattern`, `materials`). Capability filtering includes approved entries and recipe verdicts; the unfiltered legacy listing still lists proposals/rejections only.

`molecule` accepts `file` (local PDB/CIF) or `pdb_id` (four-character public RCSB id acquired by `blender:recipe` before Blender starts). Public data gets exact SHA256, author/title/journal attribution and a CC0 receipt under `local/generated/molecularnodes/<hash>/`; the receipt is included in `blender-recipe.json`. Blender stays offline. Single structure model only; no live replay until external structure bytes are journal-pinned. This is molecular visualisation, not a physical simulation. [RCSB 1CRN](https://www.rcsb.org/structure/1CRN), [wwPDB usage](https://www.wwpdb.org/about/usage-policies).

Mantaflow defaults are 64 domain voxels, surface upsampling 2, 40 cached frames; 128–192 voxels are available for approved finals, not verified here. Proofs use 32/1 or 64/2. The cache key includes recipe/kit code, normalised simulation parameters, Blender version, fps, gravity and units. Editorial freeze remapping does not rebake. Mesh/VDB payloads are hashed, completion receipts publish atomically, and incomplete/changed payloads rebuild. No live solver reaches render. Changing fluid topology holds the nearest cached frame; Cycles disables deformation motion blur on those meshes. This is a documented limitation, not a motion-blur proof. Whitewater is not implemented.

`smoke-plume` has `method: "mantaflow"` (cached VDB) or `"grid"` (seeded frame-driven Volume Cube density). The latter is an economical layout alternative, not a physical simulation. No unbaked simulation zone is rendered.

`materials/` supplies thirteen original shader-tree factories: brushed/anodised metal, frosted/tinted glass, clearcoat car paint, fabric, velvet, ceramic, thin-film iridescent, holographic foil, juice, ice and soft plastic. These are approximations rather than measured BRDFs. Existing `blender:assets` Poly Haven/ambientCG routes remain the scan sources. `materials/preview.py` renders every surface under two moods. No external generator package was added: Mantaflow, volume grids and shaders are built-in; the only external tools are the two pinned add-ons.

## Trial results

Concise compatibility qualification consumed by the arsenal audit; individual run receipts are ignored output.

| Scope | Qualified setting |
|---|---|
| Native variants | 6 |
| CPU pixel comparison | 0 maximum RGB difference for frame-alone versus range |
| Preview size | 480×270, 8 samples |
| Material factories | 13 |

Re-run `tests/blender-fx.test.ts` with `RUN_BLENDER_TESTS=1` for the installed Blender version. Registration, deterministic pixels and sparse frames do not establish creative acceptance.

## Operational limits

Liquid remains experimental where label occlusion or thick surfaces compromise the brief. Mantaflow smoke is experimental; the grid alternative is illustrative. Molecular output is a rigid visualisation of one supplied structure, without trajectories, force-field simulation or scientific annotation. Tissue supports only its isolated tessellation wrapper.

No 1080p/final-sample, 128–192-voxel, portrait/square or cross-platform visual qualification is inferred from preview checks. Whitewater, live solver rendering and general upstream add-on support are outside the contract. Keep source attribution and cache receipts with the actual project; no global test log authorises delivery.
