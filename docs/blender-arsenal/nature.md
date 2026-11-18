# Procedural nature — Blender 5.3.0

Status: experimental preview integration, 2026-11-15. No production-quality claim.

## Verdict

Experimental native nature wrappers; Sapling birch generation, isolated enabling, cache reuse and CPU pixel determinism passed. Infinigen deferred for runtime incompatibility; Gscatter rejected for account and licensing restrictions. Owner consent is the realism-wave authorisation of 2026-11-15.


## Official source research

- [Sapling 1.0.0](https://extensions.blender.org/add-ons/sapling-tree-gen/), GPL-3.0-or-later, Blender >=5.2.0; no permissions, wheels or account. [Source release](https://projects.blender.org/extensions/add_curve_sapling/commit/04507f83f0e200801179d510449a38d8abba161d). Source archive inspected for process/network/dynamic execution; presets parse literals. The user preset writer is confined by the isolated profile. Its archive is not vendored.
- [Infinigen pinned pyproject](https://github.com/princeton-vl/infinigen/blob/53033dd55c7191cbc436be6ffbb63c026935a509/pyproject.toml): BSD-3-Clause, Python ==3.11.*, bpy ==4.2.0. [Nature stable](https://github.com/princeton-vl/infinigen/tree/f5bcba8de47623da9b715348cf95822445e0e9a7) instead requires Python 3.10 / bpy 3.6. [Headless installation](https://github.com/princeton-vl/infinigen/blob/53033dd55c7191cbc436be6ffbb63c026935a509/docs/source/Installation.md) supports Mac ARM CPU terrain. [Export](https://github.com/princeton-vl/infinigen/blob/53033dd55c7191cbc436be6ffbb63c026935a509/docs/source/ExportingToExternalFileFormats.md): .blend/USD preserves instancing/materials better than GLB. A separate upstream environment and cached export is the future boundary; no untested wrapper pretends to run it in 5.3. No runtime or scene download performed.
- [Gscatter installation](https://graswald.notion.site/Download-Installation-Gscatter-and-Assets-dbe897a471fb47ce9661c48fdc23fec1): account required. [Asset guide](https://graswald.notion.site/Graswald-Web-App-Introduction-d10d2b75889b4df2b08e0fb8cad950a6) limits free assets to non-commercial use. [EULA](https://graswald.notion.site/End-User-License-Agreement-e8cac35ea7dc4240a57878ff5f9bc4a2). Commercially free add-on use does not establish an open-source code licence or CC0 assets. Rejected without install.

## Reproduction

Use `blender:recipe` for terrain, tree, vegetation-scatter and sky-atmosphere. They compose through `avc_recipes.apply`; empty scanned material ids use procedural substitutes explicitly. Scan ids fail clearly if missing. `tree.engine=sapling` requires the approved installed extension and `blender:run --extensions sapling_tree_gen`; native leaves use Geometry Nodes. Native species are approximate silhouettes, not botanical models.

The terrain's metre-scale UVs blend scanned ground/rock shaders by normal slope and world height. Planting uses a seeded density/clearing mask and linked clump meshes; optional camera cone is conservative and defaults to 360° for moving cameras. Match planting seed/relief to terrain. Tree wind is keyed from sine functions with shutter guards. No simulation or paid dependency. Existing Essentials scatter groups remain available; the new wrappers expose controllable clearing masks and species without modifying bundled files.

`product_in_nature.py` uses an original parametric ceramic flask on an eroded stone. It accepts palette, time_of_day, lens, fstop, seed, trees and iteration. The scan material is acquired through the asset CLI. Local outputs and evidence never enter git.

## Trial results

Compatibility qualification for the manifest; per-run logs and rendered examples remain ignored.

| Scope | Qualified setting |
|---|---|
| Sapling pin | 1.0.0; exact archive hash in the extension manifest |
| Native wrappers | 4 |
| CPU pixel comparison | 0 maximum RGB difference for frame-alone versus range |
| Preview size | 160×90, 4 samples |

## Runtime and source limits

Sapling presets are literal data: birch/oak/pine map to silver_birch/black_oak/small_pine. The wrapper overrides seed and scale, disables upstream wind/rig and applies keyed motion. Cached geometry keys include recipe/kit code, parameters, extension version and Blender version; complete blends publish atomically. No live RNG or simulation reaches render. Oak/pine lack visual qualification.

Poly Haven scan ids resolve through `libraries.json` and retain original source, CC0 evidence and file hashes; missing scan ids refuse. Cached bundled metadata must be rebuilt with `blender:assets index --bundled` after a Blender-version change. Sky parameters use supported RNA values, including the 5.3 `aerosol_density` field and the older `dust_density` field only where available.

Native species and fern shapes remain approximate; procedural bark, planting density and haze need shot-specific direction. Preview determinism does not establish photorealism, full-sequence pacing or human creative acceptance. Re-run native checks on the installed version and keep actual project receipts under ignored output.
