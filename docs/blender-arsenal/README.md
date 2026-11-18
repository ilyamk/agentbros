# Blender arsenal

Pinned extensions, local asset libraries and built-in scene recipes expand what a film can show. The tracked map is [blender-arsenal/AGENTS.md](../../blender-arsenal/AGENTS.md); downloaded code and generated media stay in `blender-arsenal/local/`.

## Index

- [Overview and audit](#overview-and-audit)
- [Nature wrappers and tool trials](nature.md) (terrain, trees, vegetation and sky; experimental)
- [Extensions](#extensions) and [researched alternatives](#researched-shortlist)
- [Asset libraries](#asset-libraries) and [measured acceptance](#measured-acceptance-2026-11-15)
- [Built-in recipes](#recipes)
- [Planning evaluation](#planning-evaluation)
- [Growth process](../../.agents/skills/blender-3d/references/arsenal.md), [contribution gates](CONTRIBUTING.md), [evaluation template](_template.md)

## Overview and audit

`pnpm blender:arsenal status` gives an agent one offline view: extensions by approval/installed/drift state, local library counts by kind/source, collection availability with acquisition commands, recipe statuses/costs and bake-cache bytes. It never rebuilds the index, starts Blender or downloads. Rebuild a stale library index explicitly with `pnpm blender:assets --action index`. `init` creates the standard local directories; `candidates` merges proposed and rejected extensions/sources before further research. `audit` reports all manifest, approval/evaluation, rejection, collection-source and recipe-META problems with fixes; it uses `git ls-files` to reject tracked local payloads. Consent is the owner's actual decision, never an agent-generated string.

Recipe costs/status remain **unmeasured** unless supplied with a validated proof: `pnpm blender:arsenal status --proof out/qa/PROOF/index.json`. Measured results carry their settings/path; a supplied proof can be historical and is not automatically evidence for changed source. Preserve old/new indices. The audit requires each approved extension/source to have consent, an existing evaluation, a completed `## Verdict` and numerical `## Trial results`. It does not establish legal permission or creative acceptance. Proposed evaluations may explicitly remain pending. Rejected records need a reason.

## Extensions

Start with built-in Blender. Add an extension when it improves a named shot or supplies a capability the kit lacks. Third-party Python executes with the current user's permissions: profile isolation is not an operating-system security sandbox. Read the code before trialling it.

1. Inspect a local ZIP: `pnpm blender:ext inspect --file /path/candidate.zip`. This reads TOML without extracting or executing code; it flags file/network permissions, native code/wheels and unverified GPL compatibility. Licence flags are review prompts, not legal clearance.
2. Propose it: `pnpm blender:ext propose --file /path/candidate.zip --purpose "What this gives a film"`. This stores its hash, exact version, archive size and manifest facts, caches the original ZIP and creates an [evaluation](./_template.md). Local proposals have `archive.url: null`; never invent a download URL. Fill the licence URL, account requirement, headless result and determinism evidence after research.
3. With user authorisation to execute the candidate, trial it: `pnpm blender:ext trial --file /path/candidate.zip --name candidate-01`. Each fresh name gets its own `local/trials/<name>/blender-user`, installation timing, enable timing and added operators/node groups. Trials never install into the main isolated profile. Review source before running any operator. A trial does not imply approval.
4. Complete the evaluation, including a non-placeholder **Verdict**, install/enable timings, launch-inclusive render overhead and pixel determinism evidence. Update the pin's `verified` date, headless and deterministic notes. Extensions with `network` permission or that need an account (for example BlenderKit) remain trial-only unless the user explicitly approves that dependency.
5. Record the user's decision: `pnpm blender:ext approve --id ID --consent "User, date, reason"`. Network/account approval additionally requires `--allow-network-account`. Consent text records the user's decision; it must never be invented by an agent.
6. Install the verified approved archive: `pnpm blender:ext install --id ID`. For a remote pin, first use `pnpm blender:ext fetch --id ID --consent "User, date, reason"`. Fetch only uses the pinned HTTPS URL, refuses redirects and rejected entries, verifies size and SHA-256 before rename, and records download consent separately from approval consent. Tests inject fake downloads; nothing downloads automatically.
7. Use it: `pnpm blender:run --script path/shot.py --output out/shot --extensions ID`. Comma-separated ids or `--extensions approved` select approved, installed, drift-free pins. The runner keeps factory startup and records enabled versions and enable timings. Shot scripts can call `avc_extensions.require("id", "1.0.0")`. `pnpm blender:ext list` reports installed versions, enableability and drift; `pnpm blender:ext doctor` also probes Blender and shows the isolated environment.

Never install into the user's Blender profile, use unpinned installs, or use `--no-factory-startup` to load extensions. Every Blender process redirects `BLENDER_USER_RESOURCES`, `BLENDER_USER_CONFIG`, `BLENDER_USER_SCRIPTS`, `BLENDER_USER_EXTENSIONS`, `BLENDER_USER_DATAFILES`, `BLENDER_SYSTEM_EXTENSIONS`, HOME and XDG directories inside its workspace profile. `user_default` is a local repository configured for each factory-startup process; the helper checks Blender's actual CONFIG/SCRIPTS/EXTENSIONS resource paths against the isolated environment before installation or enabling; install uses Blender's `extension install-file -r user_default` command without enabling the candidate. Only a trial or an approved render explicitly enables it.

Both default `user_default` and the read-only `system` repository were verified on Blender 5.2.3 under factory startup and offline mode. The harness keeps `user_default`: Blender's verified `install-file --no-prefs` route handles extraction, compatibility and wheels, so a second system-repository unpacker is unnecessary. Custom saved repos and enabled state are ignored by factory startup; each run explicitly enables its pinned set. `default_set=True` creates the in-memory preference entry required by Add Camera Rigs without saving user preferences. For an extension-enabled `.blend`, the worker registers the pinned RNA types before opening the file with scripts disabled; late registration changes Camera Shakify output. `BLENDER_SYSTEM_EXTENSIONS` also points inside the isolated profile, and every `blender:run` redirects the profile, including a run without extensions.

## Researched shortlist

The later [nature trial](nature.md) adds owner-approved Sapling 1.0.0; its native companions remain experimental.

The research identified seven add-on adopts, all still proposed. On Blender 5.3.0 six passed revalidation; Node To Python enables but refuses export. Fourteen “maybe” candidates and twenty-two rejections are pinned too; [research decisions](research-shortlist.md) prevent repeated research. Bradley and Poly Haven asset-library extensions are accepted by Blender 5.3; the direct library route remains preferred for headless work.

| Id | What it gives a film | Helper / headless call |
|---|---|---|
| `add_camera_rigs` | Editable dolly, crane and 2D rigs | `require()` then `object.build_camera_rig(mode="DOLLY")` |
| `camera_shakify` | Captured handheld motion | `camera_shake(camera, "THE_CLOSEUP", 0.25)` |
| `cell_fracture` | Seeded mesh shards | `fracture_object(mesh, seed=42)` or `with seeded(42)` |
| `light_it_up` | Editable studio lighting presets | `require()` then `light_it_up.high_key()` |
| `extra_mesh_objects` | Parametric gears, gems and rocks | `require()` then `mesh.primitive_gear(number_of_teeth=12)` |
| `enhanced_svg` | Colour-aware logo SVG import | `require()` then `import_scene.import_svg(..., allow_external_images=False)` |
| `node_to_python` | Export blocked on Blender 5.3.0 despite API compatibility | `require()` then `ntp.export()` in ADDON mode; `--no-render` |

`require()` and the named wrappers are in `avc_extensions`; operator calls are `bpy.ops`. A saved Camera Shakify scene must enable the same pin when rendered. `camera_shake` records that dependency in `scene["avc_required_extensions"]`; the runner refuses a missing dependency. Avoid the add-on's embedded render-farm script. `seeded` restores Python's RNG state; Blender exposes no noise-state getter, so seed each noisy operation. Seeds must be positive integers; zero selects a time seed in Blender. Cell Fracture creates geometry; any later rigid-body simulation needs a fixed-seed bake before rendering.

Node To Python is marked `usage: "authoring"`: render runs exclude it from `--extensions approved` and reject it when explicitly requested; use `--no-render`. Its 4.2.0 archive explicitly refuses Blender >= 5.3.0; keep approval pending upstream support. File export was verified only on 5.2.3, where background clipboard export returned no text. Enhanced SVG ships lxml wheels; the tested macOS arm64 pin and Python version must be re-tested on upgrade. Retain `allow_external_images=False` and inspect SVG references. Native wheels share the isolated profile store; conflicting wheel combinations have not been tested.

## Native asset-library extensions on 5.3

Blender 5.3.0 native asset-library trial: Poly Haven Lite 1.0.0 installed and enabled its 393-byte, SHA-256-verified descriptor in 104.902 ms (1,043 ms including launch), while Blender remained offline. It registered a remote Asset Browser library but installed no .blend assets and did not pin individual asset files; its default cache path also resolved to the OS cache outside the arsenal despite profile overrides. Keep LIB’s verified per-file .blend download + append for headless films: it supplies reproducible content, explicit consent and controlled paths. Native extensions may help interactive browsing, but this trial provides no reason to change the LIB adapters.

## Built-in first

| Need | Use before installing an add-on |
|---|---|
| Scatter, randomise, array, instancing | Geometry Nodes and Essentials Scatter on Surface, Randomize Transforms, Random Rotation, Array, Instance on Elements |
| Effectors, falloffs, stagger | Geometry Nodes and kit Python; optional CC0 Bradley groups through the library route |
| Particles, fluids, smoke, cloth, hair | Simulation zones, Mantaflow and Essentials dynamics; bake before rendering |
| Fracture | Optional Bradley G_Cell Fracture / G_Voronoi Debris; built-in Rigid Body for baked motion |
| Looping noise and wiggle | F-Curve NOISE + ENVELOPE, or frame-driven GN noise |
| Turntable and orbit | Empty parent, keyed rotation and Cycles modifier |
| Easing and overshoot | Kit curves or built-in BACK / ELASTIC / BOUNCE interpolation |
| 3D text | FONT objects or String to Curves; optional Bradley G_Text Mesh |
| Plain SVG / model import | Bundled io_curve_svg, glTF, FBX; native USD, Alembic, OBJ, PLY, STL |
| Studio HDRIs and materials | CC0 Essentials, Poly Haven or ambientCG library files |
| Compositor finishing | Essentials Film Grain, Chromatic Aberration, Vignette, Sensor Noise, Split Toning, Tune Image, Unsharp Mask; online Depth Atmosphere, Rim 2D, Dithering |
| Node editing and rigging | Bundled node_wrangler and rigify |
| Screen-space alignment | Essentials 3D to Screen Space, Screen to 3D Space, Project with Depth |

## Verification and approval

Blender 5.3.0 revalidation and historical 5.2.3 measurements cover real isolated install, enabling, meaningful operators, frame-alone/range pixels and launch-inclusive fixture overhead. Re-run the fixture with `RUN_BLENDER_TESTS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-ext.test.ts`. With already consented archives in the local cache, exercise the shortlist with `RUN_BLENDER_EXTENSION_TRIALS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-ext-adoption.test.ts`; this test never downloads.

After the owner supplies their actual approval as `OWNER_APPROVAL`, each of the six verified 5.3 candidates can be approved independently; Node To Python is pending:

```bash
pnpm blender:ext approve --id add_camera_rigs --consent "$OWNER_APPROVAL"
pnpm blender:ext approve --id camera_shakify --consent "$OWNER_APPROVAL"
pnpm blender:ext approve --id cell_fracture --consent "$OWNER_APPROVAL"
pnpm blender:ext approve --id light_it_up --consent "$OWNER_APPROVAL"
pnpm blender:ext approve --id extra_mesh_objects --consent "$OWNER_APPROVAL"
pnpm blender:ext approve --id enhanced_svg --consent "$OWNER_APPROVAL"
# node_to_python: pending upstream Blender 5.3 support
```

Reference sources: [extensions API](https://extensions.blender.org/api/v1/extensions/?blender_version=5.2.3&platform=macos-arm64), [extension CLI](https://docs.blender.org/manual/en/latest/advanced/command_line/extension_arguments.html), [directory layout](https://docs.blender.org/manual/en/latest/advanced/blender_directory_layout.html). Runtime tests use the installed 5.2.3 build, rather than assuming the latest manual describes that version.
Last verified: 2026-11-15, Blender 5.2.3 LTS, macOS arm64.

## Asset libraries

`pnpm blender:assets` discovers, pins and stores per-shot materials, models, HDRIs, fonts and native node assets. `libraries.json` is the reviewed source registry and exact-file lock. Payloads, receipts, the search index and downloads stay under git-ignored `blender-arsenal/local/`. `assets:sync` continues to own shared media the harness needs, including device GLBs and shared HDRIs; those files are not moved.

### Verified sources

“Verified” records dated upstream research, not a claim that every item was rendered. All actual sample acquisitions below were opened or imported on 5.2.3. Keyed providers were not exercised with a user account.

| Source | Adapter / route | Licence and attribution | Acquisition |
|---|---|---|---|
| Poly Haven | `polyhaven-api`, published API v2 at `api.polyhaven.com` | CC0; retain **Powered by Poly Haven** live-API credit | Automatic after consent. Verify published MD5 + size; compute/pin SHA256. Model `include` files retain relative paths. |
| ambientCG | `ambientcg-api`, `/api/v3/assets` | CC0; optional credit | Automatic after consent. Validate `type` and `include` locally because invalid types fail open upstream. Pin stable `/get?file=` URL, follow only approved download-host redirects. |
| Kenney | `manual` | CC0 per pack; optional credit | User downloads the chosen pack, then ZIP import. No stable anonymous pack URL. |
| Quaternius | `manual` | CC0 per pack; optional credit | User downloads via itch.io, then ZIP import. Source `.blend` availability varies by tier. |
| Poly Pizza | `poly-pizza-api` or manual | Per-model CC0 / CC-BY-3.0 / CC-BY-4.0; preserve API Attribution verbatim | Requires a free user `POLY_PIZZA_API_KEY`; without it, give manual steps. No key enters a pin or receipt. |
| Khronos glTF Sample Assets | `khronos-git`, pinned commit | Every `legal[].spdx` must be CC0-1.0, CC-BY-4.0 or a LegalMark notice; preserve credits/notices | Automatic after consent. Verify git blob SHA and SHA256. Exclude NC/EULA/unknown restrictions, including DamagedHelmet, Duck, Sponza, BrainStem, VirtualCity, EnvironmentTest and PlaysetLightTest. Avoid trademarked models in client films. |
| Smithsonian | `smithsonian-api` | Both metadata usage and the selected 3D media must explicitly be CC0 | Join 3D file metadata to an explicitly CC0 media package; require a sized GLB. Unmatched or ambiguous records fail for manual review. `SI_API_KEY` or limited DEMO_KEY for metadata. |
| Google Fonts | `google-fonts-git`, pinned commit | OFL families only; store `OFL.txt` alongside the font | Automatic after consent. Verify git blob SHA and SHA256. Blender uses the default variable-font instance; static axis instancing remains manual. |
| Bundled Essentials / studio lights | `bundled`, `index --bundled` | Shipped CC0 licence files; optional credit | No download or payload copy. Index installed files in place, including node groups, matcaps and world HDRIs. |
| Bradley Node Presets | `blender-library-server` | CC0 for the individually declared node assets | Automatic file fetch after consent. Select 5.2 file; verify index, pages and `.blend` SHA256. |
| Online Essentials | `blender-library-server` | CC0 per declared asset | Same. Includes native Glass / Glass - Frosted, metals, fabric and other studio materials. |
| Poly Haven online library | `blender-library-server` | CC0 per declared asset | Same; native materials, models and worlds. |
| ambientCG online library | `blender-library-server` | CC0 per declared asset | Same; native normal/displacement variants, worlds and objects. |
| Charge Open Movie library | `blender-library-server` | CC0 per declared asset | Same; materials, props and VFX elements. Simulation assets still need deterministic bakes before rendering. |

Library-server extensions require Blender 5.3, but their compatible **files** append directly on 5.2.3. This route never installs an extension or enables online access inside Blender. Metadata follows `_asset-library-meta.json` → hashed index → hashed pages → hashed payload. Incompatible minima are excluded. Mixed-content files expose a licensed **name + datablock category** view; unlicensed items and unsupported brush-only files cannot be appended through that view.

Download hosts are source allowlisted, including every redirect hop. `ihdri.com` is explicitly rejected: the former HDRI domain became a betting site. Canonical pins accept only non-secret `file`/`download` query keys; temporary CDN tokens never become pins. No automatic re-pinning on a mismatch.

### Commands and consent

```bash
pnpm blender:assets --action sources
pnpm blender:assets --action search --query wood --kind materials --local
pnpm blender:assets --action search --query "Radial Array" --source bradley
pnpm blender:assets --action add --id ambientcg:Wood096 --resolution 1k --consent "who / when / why" --pin
pnpm blender:assets import --file PACK.zip --source kenney --licence CC0-1.0 --source-page https://kenney.nl/assets/furniture-kit --consent "who / when / why"
pnpm blender:assets --action index --bundled
pnpm blender:assets --action index
pnpm blender:assets --action show --id ambientcg:Wood096
pnpm blender:assets --action collection --name cosy-desk
pnpm blender:assets --action credits --project demo
pnpm blender:assets --action doctor
```

A download requires an approved source **and** explicit consent. `--consent` accepts plain text or JSON `{by,date,note}`; the date may be an ISO date or timestamp. This round's sample acquisitions record the repository owner's 2026-11-15 trial consent, rather than pretending agents authorised them. Approval and past trial consent do not authorise arbitrary future files.

`--pin` writes measured original-file SHA256, bytes, format, resolution, provenance and dependencies to `items[]`. MD5 and git blob hashes are retained when supplied. Without `--pin`, the item remains local. Each file has independent hashes; a clean-machine reacquisition is tested. A manual import records the supplied licence, original page, consent and measured archive SHA256 in its local receipt; acquiring that manual pack on another machine still requires the user's original archive.

The downloader uses bounded reads, deadlines and a 512 MiB per-file cap. ZIPs are validated before extraction, with traversal/link/duplicate/reserved-name and expanded-size limits. Verified originals are content-addressed; extraction uses a staging directory and atomic installation. Existing assets are not silently replaced. Original archives retain all data; material maps, `.blend`, MaterialX and related inert files are unpacked. ambientCG material appends prefer the PBR maps; `name=` explicitly selects a native `.blend` material instead.

### Append in a shot

```python
import avc_assets

avc_assets.register_library()  # current session only; never saves preferences
material = avc_assets.append("ambientcg:Wood096", scale=2, normal_strength=0.35, project="demo")
sphere.data.materials.append(material)
model = avc_assets.append("khronos-samples:SheenChair", normalise_scale=1.2, project="demo")
world = avc_assets.append("polyhaven:brown_photostudio_02", strength=0.25, rotation=65, project="demo")
# Native file ids and their permitted datablock names come from search/show:
# group = avc_assets.append(BRADLEY_FILE_ID, name="G_Radial Array", project="demo")
# glass = avc_assets.append(ESSENTIALS_MATERIAL_FILE_ID, name="Glass - Frosted", project="demo")
```

Models support GLB/glTF (with relative companion files), FBX, OBJ and native objects/collections. For a multi-model manual pack, `name="chair.glb"` selects a member file. Native `link=True` uses licensed local collection instances, with no scale normalisation. Material trees use sRGB colour, Non-Color data, GL normals (DX fallback inverts green), optional displacement, AO and UV mapping. `normal_strength` defaults to 0.5; UV scale must match the subject and real surface size. HDRI rotation is degrees. Matcaps return image datablocks for look development; they do not masquerade as PBR materials. Fonts return Blender vector-font datablocks. Unknown keywords fail.

`blenderAssets` in receipts/indexes records native asset names, categories and catalogue UUIDs, read by an isolated offline headless Blender. `blender_assets.cats.txt` groups local files by kind/source with deterministic UUIDv5 IDs. Raw GLBs/PBR maps are appended by the helper; they are not silently converted into new asset-browser `.blend` files.

Every append logs asset id, caller script, UTC time and explicit project (or `AGENTBROS_PROJECT_ID`). Pass `project=` for scripts outside project folders. Credits deduplicate usage and fail when used provenance is missing. Carry them into the render's `--metadata` sidecar.

### Bundled inventory and checked starter sets

The 5.2.3 inventory contains **83 node groups** in six files: 28 geometry utilities, 6 dynamics, 17 compositor effects, 4 shading-coordinate utilities, 2 principal-component groups and 26 hair groups. Useful names include Array, Scatter on Surface, Randomize Transforms, Film Grain, Chromatic Aberration and Vignette. There are **26 user matcaps** (the internal `brush_thumbnail_preview.exr` is excluded), **8 world HDRIs** (city, courtyard, forest, interior, night, studio, sunrise, sunset) and nine brush files outside this append index. Bundled shading utilities contain no studio materials; those come from the online library. Exact names, hashes and the Blender version are local in `library/blender-bundled.json`.

The three collections resolve to ten unique pinned files:

- `studio-product`: Poly Haven Brown Photostudio 02, ambientCG Metal051A and Concrete048, online Essentials Glass - Frosted. ambientCG had no frosted-glass search match, so the verified CC0 native material supplies that role.
- `abstract-tech`: Bradley's 5.2 file, Poly Haven Studio Small 08 and ambientCG Metal051A.
- `cosy-desk`: ambientCG Wood096 and Fabric082A, Poly Haven Kiara Interior and the CC0 Khronos SheenChair at a pinned commit.

All selected HDRIs/maps use 1K originals. The collections' ids resolve to exact hashes; payloads remain local. Proofs use the existing stage/camera/light kit and live in `out/qa/blender-assets/<collection>/`, with contact sheets and append/material evidence.

### Measured acceptance (2026-11-15)

Apple M1 Max, 32 GiB, shared load. Ten original files total **39,290,139 bytes**. The recorded successful acquisition operations total **38.04 s**, including metadata, verification, extraction and native inspection; the successful Glass operation reused its already-verified download after a probe repair. These are operation times, not isolated network throughput.

| Original file / item | Bytes | Successful acquire + inspect (s) |
|---|---:|---:|
| PH Brown Photostudio 02, 1K HDR | 1,648,130 | 0.97 |
| PH Studio Small 08, 1K HDR | 1,508,872 | 0.74 |
| PH Kiara Interior, 1K HDR | 1,716,307 | 0.66 |
| ambientCG Metal051A, 1K JPG ZIP | 3,086,692 | 7.42 |
| ambientCG Concrete048, 1K JPG ZIP | 7,536,748 | 6.65 |
| ambientCG Wood096, 1K JPG ZIP | 5,358,165 | 4.49 |
| ambientCG Fabric082A, 1K JPG ZIP | 5,156,029 | 4.52 |
| Khronos SheenChair GLB | 4,125,648 | 2.82 |
| Bradley 5.2 native file | 7,037,282 | 8.04 |
| Online Essentials materials file | 2,116,266 | 1.72 (cached original) |

All three contact sheets were opened. Exposure was reduced and wood UV repetition corrected after the first pass. Metal and frosted glass are visually distinct; the fine fabric weave is below the wide proof's resolving scale, so no claim of close-up fabric acceptance is made. Node evidence confirms sRGB colour, Non-Color data, GL normals at strength 0.35 and explicit UV scale. Bradley's G_Radial Array evaluated and rendered.

| Collection, 640×360 / 16 samples / CPU | Frame render (s) | Full runner (s) |
|---|---:|---:|
| studio-product | 37.5 | 48.48 |
| abstract-tech | 35.6 | 47.27 |
| cosy-desk | 36.4 | 48.28 |

These proof timings were taken with three 3-thread Blender processes under heavy concurrent test load. Later append measurements under that load were PBR maps 14.75–277.69 ms, native glass 158.96 ms, HDRIs 335.04–784.89 ms, Bradley 2,133.61 ms and SheenChair 1,564.39 ms. A quieter synthetic real-Blender case measured material/model append at 22.69/12.26 ms and 160×90 PBR/flat renders at 119.02/79.68 ms. Indexing 200 synthetic receipts took 56.02 ms; local search 1.75 ms. These are observations, not performance thresholds.

Exact local receipts, hashes, append evidence and proof manifests remain in the store and `out/qa/blender-assets/`; `local/trials/lib-round2/acceptance-measurements.json` retains acquisition and proof timings. A resumed metadata pass attached source/credit sidecars without re-rendering the checked frames.

### Contributions and verification

Contributors can provide reviewed source entries; exact item URLs, variants, sizes and hashes with licence/credit evidence; curated collections with one-line reasons; original procedural material/studio-rig recipes referencing item ids; scale/UV/normal/polycount/load-time evaluations; licence/upstream-change reports; and evidence-backed deny-list entries. Never contribute third-party payloads, downloaded `.blend` files, fonts, textures, secret keys or temporary signed URLs. Original recipes are reviewed code; generated evaluation media stays local.

```bash
pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-assets.test.ts
python3 tests/blender-assets-helpers.test.py
RUN_BLENDER_TESTS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-assets.test.ts
```

Tests use fake metadata/transports and generated tiny files; they never download sample assets. The real case generates PNGs and a GLB, checks PBR nodes/colour spaces, renders PBR and flat frames, measures append/render times and appends an installed Essentials node asset. Source/API/account support beyond the checked sample paths remains subject to upstream drift; mismatches fail rather than changing pins.
Built-in scene recipes complement the isolated extensions and local asset store described in [the arsenal map](../../blender-arsenal/AGENTS.md). Files fetched or generated on a machine stay under ignored `blender-arsenal/local/`; project work stays in its existing ignored footprint.

## Recipes

Reach for a [directed recipe](../../scripts/blender/recipes/AGENTS.md) before building an effect from scratch. Sixteen built-in effects cover geometry, shader reveals, dust, a deterministic crown splash, cached cloth, volume wisps, neon, fields, confetti, light, glass, text, ribbons and a grounded cyclorama. No recipe installs anything or downloads media. Catalogue costs and readiness are measured in the [recipe table](../../scripts/blender/recipes/AGENTS.md); experimental effects remain visible.

```bash
pnpm blender:recipe list
pnpm blender:recipe describe --id scatter-surface
pnpm blender:recipe render --id scatter-surface --params '{"seed":42}' --frames 1-64 --output out/qa/recipes/scatter-v1
pnpm blender:recipe bake --id cloth-drape --output out/qa/recipes/cloth-bake-v1
pnpm blender:recipe proof --all --output out/qa/blender-recipes-v1
```

Every rendered invocation uses the existing `blender:run` backend with an isolated worktree profile. `--bare` omits the proof floor and lights; `--resolution`, `--samples`, `--frames`, `--engine`, `--device auto|cpu|gpu` and `--executable` control the backend. `--dry-run` validates without launching Blender. Unknown flags and unknown JSON parameter keys fail. `list`/`describe` parse literal metadata with Python AST and work without Blender.

From a trusted shot script run with `pnpm blender:run`:

```python
from avc_recipes import apply
apply("scatter-surface", {"object": "Product", "seed": 42})
apply("light-sweep", {"object": "Product"})
```

`avc_recipes.apply` also works without a supplied timeline, preserves the current scene and returns created datablock names and cache evidence. The helper makes the kit importable on first application. Named objects must already exist; misspelled names fail. Returned object names belong to the recipe, never to an existing supplied hero. Scatter takes a static mesh snapshot (object transforms may animate); apply it before topology reveals, and use a static duplicate for deforming sources. Dissolve and neon insert glare into an existing compositor output chain without discarding the shot grade. Geometry reveals modify the target through a modifier; dissolve replaces its material. Ribbon follows already deterministic/baked object transforms sampled at frames 1–64. Effects use metres and a 30 fps motion vocabulary.

To add a recipe, create one Python module with a literal `META` and `apply(scene, params, timeline=None)`, opening with the film intent and meaningful knobs. Build named `AVC` node groups in code. Use kit intent curves and a fixed seed; cache every simulation through `_common.bake` before frame rendering. Include Blender version, fps/fps_base, gravity and any other simulation dependencies in its cache context; isolate colliders/effectors. Keep AST discovery and parameter validation tests passing. Contribution: **recipe code + tests + proof numbers and a visual verdict**, not rendered media. Record any outside inspiration in `CREDITS.md` and `META.inspired_by`.

The proof command writes `index.json`, per-recipe previews/contact sheets, and a combined sheet. The CLI defaults to automatic GPU selection; the library API defaults to CPU. It renders midpoint alone versus in-range, compares decoded RGB pixels (null PSNR means infinity/exact match), and adds an exact CPU pair when the proof uses Metal. CPU requires max difference 0; Metal permits sparse rounding only (max ≤2, PSNR ≥80 dB). It measures time/frame and scene geometry, tests cache reuse, and runs non-empty, clipping, coverage, temporal/flicker and floor-contact sensors. Stage-only recipes are exempt from temporal activity. Floor darkening uses a projected patch and the same empty stage. These are diagnostics; inspect the actual sheet before accepting a recipe. Repeat in a new output directory after changing defaults to retain before/after evidence.



Use an economical iteration: separately render frames **1, 12, 26, 44, 64** at 480×270 / 8 samples, form a contact strip and inspect three PNGs. Cap at two critique passes; score motion/light/material/composition from 1–5, and mark any axis below 3 experimental. Full 640×360 / 16-sample sequences are for selected finals. Keep one Blender process at a time on shared machines.

```bash
RUN_BLENDER_TESTS=1 BLENDER_EXPECTED_VERSION=5.3.0 pnpm exec tsx --test tests/blender-recipes.test.ts
pnpm blender:recipe render --id text-3d --frames 1-64 --samples 16 --resolution 640x360 --output out/qa/recipes/title-new
```

The current blind packet is `out/qa/blender-recipes-tournament/` (24 anonymised clips); its sibling key is `out/qa/blender-recipes-tournament-key.json`. Baselines were rendered on 5.2.3 LTS and final clips on 5.3.0, per the revised brief; this renderer-version confound is recorded in the key. No independent critic verdict is claimed.

## Planning evaluation


## Live

`blender:live` and MCP `avc_blender_live` now append local assets and apply built-in recipes directly to the current scene. `arsenal` reports local asset counts/ids by kind, recipe params, approved installed extensions and collection gaps without writing. `enable-extension` requires a session started with `--extensions <ids|approved>`; all sessions isolate the user profile. There are no live downloads or installs.

```bash
pnpm blender:live --action start --session look
pnpm blender:live --action arsenal --session look --params '{"kind":"materials","limit":5}'
pnpm blender:live --action apply-recipe --session look --params '{"id":"studio-floor","params":{}}'
pnpm blender:live --action export-recipe --session look --params '{"name":"studio-look"}'
pnpm blender:live --action stop --session look
```

Every append records the asset id, receipt hash and measured payload hashes; recipe params include resolved defaults and a code hash. Replay refuses drift. Exported scripts call `avc_assets.append` and `avc_recipes.apply` through the same checked wrappers. Baked recipe data stays under `local/bakes/`. The [worked live example](../../.agents/skills/blender-3d/references/live-session.md#arsenal-worked-example) builds a lit, textured still and exports its shot.
```bash
pnpm blender:arsenal --action eval --harness codex --samples 2 --concurrency 2 --out out/qa/arsenal-eval/current-v2
pnpm blender:arsenal --action eval --harness codex --samples 2 --concurrency 2 --repo /path/to/baseline --out out/qa/arsenal-eval/base-v2
```

Version 2 measures executable, specific plans. A fresh read-only agent supplies command arrays, complete Python for future scene scripts, real recipe ids with JSON-encoded parameter objects, asset/extension dependencies and numeric render/camera/light/material settings. Codex uses `exec --sandbox read-only --ephemeral --ignore-user-config`, default model `gpt-6.1-sol`; Claude uses print mode with restricted Read/Glob/Grep, plan permissions, empty strict MCP config and no persisted session (default `sonnet`). Claude has no equivalent OS filesystem sandbox. `--model` overrides the model. This invokes a model service; its subscription/billing is external. Tests inject `ARSENAL_EVAL_HARNESS_BIN` and never call services.

The evaluator reads the **target checkout's** command registry and parser specifications with the repository's TypeScript AST API, never executing its CLIs. Every command alias/flag/type/enum/required argument is checked; recipe parameters and frame bounds use that checkout's literal META. Asset ids must occur in pins, collections, the bundled Essentials inventory or the local index; extension ids must exist and proposed extensions require explicit approval conditions. The saved `checkout-inventory.json` records the exact contracts used. A source listing does not grant download consent.

Weights: commands 20, references 20, implementation 20, determinism 15, specificity 15, safety 10. Partial category credit is the proportion of passing checks; every failure carries its reason. Python is parsed, never executed: checks include syntax, imports, undefined globals, reachable scene construction, task-specific native setups or suitable recipes, actual lens/temperature/socket assignments or kit calls, frame keys/seeds and solver bake calls. Transform-key baking does not satisfy a cloth/physics bake. Merely declaring parameters, mentioning a recipe, listing unused numbers or supplying an uncalled scene function is insufficient. Native alternatives remain valid on plain main.

Static analysis is conservative, not a Blender API/type proof or full control-flow analysis. Dynamic parameters/imports and complex equivalent implementations can lose points. The scorer does not render, establish visual quality, simulate cloth, verify every native operator's signature or prove that every node is connected correctly. Keep failures alongside scores and inspect representative plans. Historical version-1 schemas/reports remain readable but are not used by the current runner; their 97%/99% adherence result is not comparable to v2.

`--tasks` selects comma-separated ids; omit for all ten. `--tasks-file` supplies another strict task manifest. `--samples` is 1–10 independent sessions/task (default 1); `--concurrency` is 1–4 (default 1); `--timeout` defaults to 360 s/task. `--repo` changes only the agent's read-only working checkout. Outputs must be a new directory. Reports checkpoint after each response: strict JSON, Markdown, prompts, schema, checkout inventory, raw final responses, event JSONL and stderr. Failed launches/schema/static-inspection errors score zero and cause non-zero exit after the remaining jobs. Valid low scores are successful measurements.

Reports include per-task mean, population SD, min/max and n; overall spread is across all task/sample plans, combining task difficulty and sample variation. Two samples are not a confidence interval. Compare frozen identical task/schema/scorer hashes and models; inventories deliberately differ between checkouts. Freeze source before collection, retain all samples, and report principal failure modes with examples. The prompt hides expected ids/scores and forbids reading bench/runs or other checkouts; that is a planning constraint, not an access-control boundary.

Source consent and capability status are maintained in the manifests. Check `blender:arsenal audit` before acquisition or planning; never infer licence/consent from an old qualification run.

Offline corrections preserve every raw response: `pnpm blender:arsenal rescore --report out/qa/arsenal-eval/RUN/report.json --out out/qa/arsenal-eval/RUN-corrected`. This validates the saved task/schema/inventory identities and raw-plan equality, verifies existing Python against the recorded commit, and writes a new report/provenance. A corrected static-inspection error can recover; genuine harness/schema failures stay zero. Modified Python helpers require a new collection instead of silently rescoring different source.

CPU device overrides disable output dithering and pin denoising/compositing to CPU; otherwise Blender 5.3 can introduce one-level frame-order differences. Pixel comparison remains exact on CPU. The historical 5.2.3 solver trial measured 48³/64-frame Mantaflow at 116.10 seconds to bake and 0.0038 seconds to reuse; that trial was not visually judged or repeated on 5.3. The analytical splash remains experimental, with shape control and iteration speed prioritised. Blender 4.2–5.1 binaries and EEVEE remain unverified in this round. Do not enable rigid-body `point_cache.use_disk_cache` in background 5.2.3 (native crash).

## Guarded improvement loop

[Self-improvement](../../.agents/skills/blender-3d/references/self-improvement.md) directs `pnpm blender:improve`: sanitised blind packets, fresh critics in opposite orders, numeric scoring, append-only tracked logs, ranked gaps and target history. Relative wins require both-order agreement plus sensors/tests; failed changes are reverted and retained in history. `blender:arsenal candidates --capability TAG` also lists unresolved gaps.

The [structured improvement history](../../blender-arsenal/improvements/2026-11-15-dissolve-mask-offset-blocked-determinism.json) records a both-order visual win that was reverted because exact frame determinism failed.

## Cities and buildings

[City realism evaluation](city-realism.md) records the native GN skyline, cached OSM importer, pure-frame window lights and directed dusk flyover. `pnpm blender:arsenal candidates --capability city` lists verdicts including usable offline choices. Fetch OSM once with `pnpm blender:city --lat 40.709 --lon -74.01 --radius 250 --consent "who/when/why"`; the `osm-city` recipe renders the hashed cache offline, retaining © OpenStreetMap contributors, ODbL. `procedural-city` needs no download. `generators.json` carries non-add-on pins/install/licence/capabilities/cost/verdict contracts. BlenderGIS remains proposed after a legacy trial; SRTM and Buildify acquisition are unverified. Experimental visuals and reproducible QA paths are in the evaluation.

## Realism FX

[FX evaluation](fx-realism.md): cached Mantaflow liquid pour/product splash and VDB smoke, frame-driven density grids, thirteen original procedural materials, Molecular Nodes structure imports and Tissue tessellation. All five new wrappers remain experimental. [Tissue](tissue.md) and [Molecular Nodes](molecularnodes.md) have scoped owner-approved Blender 5.3.0 integrations; this supersedes their earlier aggregate shortlist verdicts for these uses only.

`generators.json` records built-in/internal tools with version + build/source pins, licence, capabilities, deterministic behaviour, measured cost scope and visual verdict. `pnpm blender:arsenal candidates --capability materials` includes approved tools and recipes; without the filter the existing proposal/rejection list is preserved. `blender:recipe` selects declared extension dependencies automatically. `pnpm blender:recipe render --id molecule --params '{"pdb_id":"1CRN"}' --output out/qa/molecule` acquires SHA256-pinned, attributed CC0 RCSB data before its offline render; alternatively pass a local `file`. A static molecule is excluded from live replay until external input bytes can be pinned.

The FX wave retains the three existing visual implementations after blind comparisons. Dissolve is now explicitly experimental because the boundary mechanics/realism remained below 3/5 in the sparse review. Current catalogue after the realism wave: 11 ready, 17 experimental (28 total).

## Recipe families

Nature checks: `RUN_BLENDER_TESTS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-nature.test.ts`. Static terrain/sky proofs omit temporal-activity requirements; sky baselines restore the preceding world and hide its sun/volume. Use 360° planting for a moving camera; narrower cones are an explicit conservative view mask.

City generators: [evaluation](city-realism.md). `pnpm blender:city --lat <degrees> --lon <degrees> --radius <metres> --consent <who/when/why>` fetches once; `osm-city` never fetches during render. Sources and generated `.blend` files/receipts/credits live under `local/generated/{osm-source,osm-city,procedural-city}/`; caches include source/code identity. OSM attribution: © OpenStreetMap contributors, ODbL. No SRTM, relation holes or real facade detail. Built-in skyline remains experimental. `window-lights.object` accepts an AVC city pane mesh or creates a facade; seed sets its switch-bank ordering. City recipe proofs use their own metre-scale camera; tests: `tests/blender-city.test.{ts,py}`, real cases gated by `RUN_BLENDER_TESTS=1`.

FX: `liquid-pour`/`product-splash` cache Mantaflow meshes; `smoke-plume` caches VDB or uses a frame-driven grid; `molecule` needs a local PDB/CIF or public `pdb_id` acquisition with attribution; `pattern-surface` uses Tissue. Dependencies are auto-selected by `blender:recipe`. Static molecules are excluded from live replay until external inputs can be pinned. New native FX cases: `RUN_BLENDER_TESTS=1 pnpm exec tsx --test tests/blender-fx.test.ts`; legacy recipe tests remain separate. Changing fluid topology holds snapshots and does not support deformation motion blur.

The dissolve proof disables Cycles persistent data: baseline and one-thread probes both drifted by one RGB level; fresh shader data restored exact CPU frame-order pixels. The visual implementation is retained and remains experimental after the blind edge critique.

## Vork

The optional Vork generator is an external local renderer, not a Blender add-on. Discover its capabilities with arsenal and use the [Vork guide](../vork.md). The strict Blender bridge targets our 5.3.0 build; GPU-only geometry may require rendered passes rather than a GLB return. [Evaluation](vork.md).
