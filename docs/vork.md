# Vork local 3D and VFX

Vork 0.5.1 is an optional local GPU renderer beside Blender. Agents author scene JSON, geometry and Slang programmes; this is code-driven rendering, not a generative video API. Remotion keeps montage, typography, captions, sound and delivery. No Voyager Cloud integration or provider spend is enabled.

The integration is experimental. The complete nine-case 1080p visual qualification, matched Blender comparison and two independent opposite-order reviews are deferred. Existing clips, previews and technical proofs do not establish production quality or creative acceptance. The qualification plan retains the remaining scope; qualification must pass for the exact rendered revision before it is described as qualified.

## Preparation

`pnpm vork:setup --action status` never downloads. `--action install` explicitly downloads the pinned complete release into the shared agentbros cache, verifies its full archive and records every runtime file. `--action verify` checks GPU/tool readiness without warming shaders. A working setup is not a qualified picture. `pnpm backend --action probe --backend vork` reports the local installation.

The built-in installers cover Apple Silicon macOS and NVIDIA Linux x64. Other prepared runtimes may be selected with `--executable`; the version must match. Only the local Mac is GPU-tested in this integration. The bundled compiler targets macOS 26+. There is no automatic fallback to cloud or CPU rendering on Mac.

All children disable Vork's update notifier. The archive, Slang, libraries and SDK stay together. No global npm package, shell startup change or Blender profile installation is needed. `uv` Python 3.12.16 is used for the SDK/authoring helpers; the main project keeps its existing Node minimum.

## Author and render

```bash
pnpm vork:recipe --action list
pnpm vork:recipe --action describe --id gpu-swarm
pnpm vork:scene --action init --id product-stage --output out/example/source
pnpm vork:scene --action brief --task out/example/source/task.json
pnpm vork:scene --action check --task out/example/source/task.json
pnpm vork:render --task out/example/source/task.json --output out/example/preview --frames 0-2 --resolution 480x270 --profile std/draft
pnpm vork:render --task out/example/source/task.json --output out/example/final --resolution 1920x1080 --encode h264 --purpose production
```

Output directories are fresh revisions. Inputs, including media, buffer files and shader modules, are hashed before and after rendering. A successful exit plus fresh completion metadata and complete frames is required. Logs, previews, contact sheets and the Vork receipt remain with the output. Failures retain diagnostics but publish no completion receipt.

`std/previs` omits indirect lighting, `std/draft` is an inexpensive lighting approximation, `std/final` approximates indirect transport, and `std/path` provides path transport. More samples cannot restore omitted paths. First-use compilation can take minutes; setup, compilation and frame cost are different measurements. Advanced fluid/cloth/fog recipes remain experimental unless their actual proofs and visual reviews justify more.

The task contract lives in `src/types/vork.ts`. Intent, notice, source, staging, effect, timing, seed and acceptance are explicit. `vork:scene brief` produces a focused agent prompt; `.agents/skills/vork-3d-vfx/` supplies progressive task guidance. Vork's own `check` remains the scene-schema authority.

`--params '{"duration":8,"simulationQuality":"final"}'` selects the denser native simulation preset. Preview remains the default: 81 cloth vertices versus 1024 in final (the SDK workgroup limit); fluid uses 10³ versus 48×12×48 marker budgets, 16³ versus 32×64×32 solver grids and 32³ versus 96×192×96 surface grids (a taller final domain with cubic cells). Final fluid begins as a mass-matched hydrostatic pool with gentle circulation and 50 pressure iterations; the cheap preview retains its small drop. The visible basin matches the solver's floor and side walls. Bulk-only water carries no floor-film mesh. These are authored experiments, not guaranteed impact or cloth quality. Inspect full motion before qualification.

The product preset uses rounded radial profiles, filtered machining marks and an explicit circumferential tangent for anisotropy; its camera arc exposes the opening. The swarm keeps its seeded GPU trajectories while varying instance scale, orientation and roughness. Final cloth carries rest UVs through the solver, with filtered weave, an edge band and OpenPBR fuzz. These improve authoring defaults; they do not remove the cloth topology limit or certify a finished shot. Use Blender when fine folds, garment construction or detailed contact exceed the native patch.

The fog preset places a closed ellipsoidal carrier behind the subject and eases its spatially homogeneous coefficients over the shot, preserving a clearer foreground. It uses supported numeric OpenPBR materials: arbitrary spatial density and custom surface callbacks alongside fog are outside this pinned runtime's supported subset.

## Results and provenance

PNG/RGBA, EXR, MP4 and ProRes are supported. Native depth, normals, motion, object IDs, shadow catcher and AOV channels can be requested through `--channels`. EXR remains linear; display PNG uses the scene's display transform. Do not apply AgX twice. ProRes is a finishing format; prefer encoded browser-compatible media or PNG sequences for Remotion.

`--project ID --import` registers an encoded output or a single PNG through the existing asset importer. The optional `vorkResult` binds the imported hash to its receipt and original source dependencies. Existing registries need no migration. A draft or unresolved warning cannot pass production delivery. Source files must remain available inside the workspace; retain them when moving a project. The renderer owns no paid-provider billing claim.

`render-plate` is a thin wrapper over the existing plate player, with explicit source FPS. Its default is an offline vector preview, not a Vork render. Existing `blender-plate` behaviour stays unchanged.

## Blender

```bash
pnpm vork:bridge --action from-blender --input scene.blend --output out/export
pnpm vork:render --task out/export/task.json --output out/export-render --encode h264
pnpm vork:scene --action export --scene out/example/source/scene.json --output out/vessel.glb --node hero
pnpm vork:bridge --action to-blender --input out/example/source/scene.json --output out/returned
```

The separate GPL bridge runs through `blender:run`, not in the main process. It targets Blender 5.3.0 and retains the upstream 5.2.1 version boundary. Material translation is strict; unsupported graphs fail. Inspect `export-report.json`, including omissions, material reports and build identity. OpenPBR is not a promise of identical Blender BSDFs. A saved live-session snapshot can use the same route.

Native geometry and supported standard material/TRS subsets return through GLB. `vork:bridge --action render-return --input SCENE --output FRESH --frames 90 --samples 32 --purpose production` explicitly presents a static return with Cycles, a named hybrid receipt and hero masks. `--frame-range` uses zero-based source indices for isolated repeat checks; the Blender presentation starts at frame one. GPU-compute-only geometry, arbitrary shader programmes and unsupported animation cannot be promised as editable round trips. Use image/EXR passes instead. `vork:bridge --action composite --input request.json --output out/composite` takes `blend`, `image`, optional `frames` and `start`, and adds alpha-over before the existing output in a new file.

## Real-footage inserts

`vork:vfx --action prepare|solve|build|review --request REQUEST --output FRESH` preserves the original plate and its presentation timestamps. Supply a centred calibrated camera or explicitly calibrated rigid plane. Planar estimation uses pinned NumPy/SciPy/OpenCV authoring dependencies, alternating fit/held-out tracks and retained overlays. It estimates neither general camera motion nor arbitrary depth, rolling shutter or lens distortion. Foreground mattes may come from the existing local matte tools. Depth is reference evidence until an explicit proxy is authored.

The VFX build combines premultiplied CG and the source plate. Supplied masks protect the photographed foreground. Its lighting is an artistic estimate; small residuals do not establish correct contact or realistic reflections. Inspect all frames, masks and slow-motion overlays. CUDA model packages from upstream demonstrations are not mandatory for this Mac workflow.

An optional calibrated initial pose binds marked points to the plane through ray intersections; without it the four corners must describe the specified rectangle. An inconsistent first-frame rectangle is refused. A picture-only insert explicitly acknowledges Vork's `video_only` warning and retains its reason; soundtrack ownership stays with the existing edit. Other unacknowledged warnings still block production delivery. Run GPU jobs sequentially during qualification and retain device-loss failures instead of blindly retrying them.

Native shadow-catcher transport failed on the tested M1 Max host. An explicit request revision may choose `shadowMode: contact` (a projected contact approximation) or `none`; no automatic fallback changes the requested effect. Use Blender for a physical receiver/reflection until that native path is qualified. Flat and native nested camera matrices are accepted with matching zero-origin FPS, square pixels and no distortion. Use the common `vision:pack` motion profile for paginated source-bound review of the completed movie.

### Explicit physical Cycles route

Set `renderBackend: "blender-cycles"` and `shadowMode: "shadow-catcher"` in a fresh VFX request. Optional `receiver` supplies square `size` or `[width,depth]`, Y-up `position`, `roughness` and linear `colour`; defaults are an estimated neutral receiver. Match the finite physical receiving surface, so reflections stop at its edge. `lighting` supplies `world: {colour,strength}` and `areas: [{name,position,target,colour,energy,size}]`; the same authored estimate is translated to the chosen renderer. `build` returns `hybrid-job.json` and the actual render command. Native Vork remains the default; no failure switches renderers automatically.

```bash
pnpm vork:vfx --action build --request request.json --output out/physical/source
pnpm vork:vfx --action render --request out/physical/source/hybrid-job.json --output out/physical/preview --resolution 640x360 --frames 0-24 --samples 16
pnpm vork:vfx --action render --request out/physical/source/hybrid-job.json --output out/physical/final --samples 64 --purpose production
```

This route strictly exports the isolated static native hero and supported material subset to GLB, imports it once into Blender Z-up, applies the same world rotation to calibrated camera poses, and uses Cycles' physical Shadow Catcher pass. The scene-linear compositor multiplies that pass into the decoded plate, overlays CG, and restores original foreground through the holdout. It retains multilayer linear EXR and full-resolution object masks. Lighting, material and receiving geometry remain authored estimates. Custom Slang, compute geometry, simulations and animations need an explicit bake/pass route; unsupported static transfer fails. Embedded GLB animations are refused too.

Centred fixed intrinsics, nominal zero-origin source timestamps and matching raster/aspect are required. `--first-frame` maps source zero to an explicit Blender frame, including non-zero starts; `--frames` always names source indices. Blender's float `fps_base` is checked within 0.00001 fps; encoded frames and source duration are checked separately. `--device cpu` permits explicit CPU trials.

Hybrid receipt v2 names `engine: vork-blender`, `renderBackend: blender-cycles`, Blender version, both tool/runtime pins, geometry export receipt and frame mapping. Native receipt v1 stays valid. Both follow existing import/delivery provenance and draft guards; the hybrid geometry export must also be retained and valid.

## Qualification and comparison

`pnpm vork:eval --action run --ids product-stage,gpu-swarm --output out/proof` renders range/isolated frames and retains both successes and failures. `--action report --input out/proof/evaluation.json` reads it. `--action pack --baseline BASE --candidate CANDIDATE --reference INTENT --output out/blind` reuses the existing matched-media two-order A/B packets. Keep the mapping key away from critics.

`--mode proof` is the default. Its aggregate pass now includes diagnostics, warnings and repeatability; it never claims full qualification. `--mode qualification --input SUITE --output FRESH` assesses existing complete 1080p receipts and movies, without launching or hiding generation. A suite declares each clip's duration, FPS, resolution, criteria, full/isolated receipts, and ordered framing passes. Native framing requires receipt-bound `object_index` PNGs with IDs matching declared subject names in native metadata; hybrid framing uses its bound hero masks. Imported glTF child names use `model/Cylinder` style identities (or `model/#nodeIndex` for unnamed nodes); include every primitive of each named subject. All silhouettes must stay at least 5% inside every image edge. Missing masks fail; masks are never resized.

Each case names the bound `source` task (or the single native scene when there is no task), and uses `movie`, `receipt`, `duration`, `fps`, `resolution`, `criteria`, `repeat: {receipt, frame}` and `framing: {maskFiles, objectIds, subjects, minimumInset}`. Paths resolve against the suite. Defaults are hero/pass 1, 5% inset and required motion. Tracking cases declare the `tracking` criterion and `tracking: {report, plate, camera}`; every frame needs at least eight independent held-out features and p95 <=2 px. Reports bind the exact plate/camera hashes. The solver excludes supplied foreground independently of residuals and fits robustly on the training partition only.

Two independent review files may be supplied with `--reviews FILE_A,FILE_B`. Each has `schemaVersion:1`, a distinct `reviewer`, opposite `order: forward|reverse`, `suiteSha256`, and `assessments: [{id,movieSha256,scores,criticalDefects,observations}]`. Every declared criterion needs >=4/5 from both and no critical defect. Preserve raw blinded packets and reviews. Missing/stale reviews remain pending/failed; they cannot pass. Reassessment writes a new report. This is agent qualification, never user approval.

Completion, warnings, same-host repeatability, full-sequence temporal diagnostics, framing, applicable tracking and independent visual assessment must all pass. Execution identity binds the host/backend; runtime and author inputs must match. Historical receipts without this identity stay importable but need new renders for qualification.

Strict same-host Metal repeatability uses max pixel difference <=2 and PSNR >=80 dB. Simulations may replay with floating-point noise and remain experimental. Three-frame checks are not full-clip flicker evidence. Cross-renderer visual differences are not pixel regressions. Independent visual scoring and the user's acceptance remain separate from technical success. Run contract tests with `pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/vork.test.ts`; `RUN_VORK_TESTS=1` adds a real smoke render.

## Licence and source boundary

Vork's Preview License permits internal/commercial rendering and delivering finished media. It is not an open-source licence, and a hosted renderer accepting third-party jobs requires separate written permission. The renderer is downloaded unchanged, not vendored or redistributed by this repository. Its scene examples are not copied into our own recipes.

`vendor/vork-blender/` is the separately licensed GPL-3.0-or-later bridge only, with its licence, source hashes and described modifications. Our own Python that runs inside Blender, including `scripts/workers/blender/avc_vork_bridge.py`, is GPL-3.0-or-later ([LICENSES/GPL-3.0-or-later.txt](../LICENSES/GPL-3.0-or-later.txt)) and carries an SPDX header; the rest of the repository is under the Business Source License 1.1 ([LICENSE](../LICENSE)) and communicates with it by files and subprocess. This boundary does not change the renderer's terms or clear other asset licences. The renderer is under the [upstream Preview License](https://github.com/voyager-so/vork/blob/v0.5.1/LICENSE); the bridge is under the [integration's own GPL-3.0-or-later licence](https://github.com/voyager-so/vork/blob/011e3f12e6c17696b3d854c173dca37a8159c6c4/integrations/blender/LICENSE), copied unchanged as `vendor/vork-blender/LICENSE` and recorded with its hash in `vendor/vork-blender/PROVENANCE.json`.
