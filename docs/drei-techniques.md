# Frame-driven 3D shot techniques

Last updated: 2026-11-21

Use these techniques for a shot that needs spatial framing, a moving mechanism, material depth or an exact spatial grouping. Start with the shot's purpose and the current library. The techniques fit product promos, explainers, motion design films and animated infographics.

## Enable and choose

```bash
pnpm experiment --action enable --project <id> --id three-shot-techniques@1
pnpm library:list --for-shot reveal --query product --format vertical --project <id>
pnpm library:list --id camera-path-reveal
```

After binding the playbook, enable the pilot before the first `pnpm next`. The first affected owner brief pins the choice. The search returns up to three matches for the shot's function and checked format. Broad searches work with just `--for-shot`; narrow by the subject or move with `--query`. Each hit includes its card and preview path. Exact lookup stays available to library authors.

The experiment gate filters search only: `library:list` without `--project`, `--id` and the full catalogue in a film brief still show the gated blocks, so a baseline project in a comparison must not use them by hand.

At the beat sheet, use the existing shot `techniqueIds`, `blocks`, `route` and `renderTask`. Decide what changes in the shot and which frame carries the reveal, stop or action. A slow orbit or a clean cut can be the better treatment for a particular idea. At build, set the approved shot length, inspect the cue frames and use `shot:tournament` for alternatives on a hero beat. [Project experiments](experiments.md) · [Motion library](motion-library.md)

## Six original demonstrations

| Technique | Composition stem | Demo length |
| --- | --- | --- |
| [Fit a product](../design-reference/techniques/product-model-stage.md) | `DreiProjector` | 5 s |
| [Move from body to detail](../design-reference/techniques/camera-path-reveal.md) | `DreiConnector` | 5 s |
| [Open a mechanism on cue](../design-reference/techniques/gltf-clip-cue.md) | `DreiLatch` | 4 s |
| [Trace the visible geometry](../design-reference/techniques/technical-part-outline.md) | `DreiAirPath` | 5 s |
| [Reveal through frosted glass](../design-reference/techniques/frosted-product-window.md) | `DreiOptics` | 5 s |
| [Assemble exact groups](../design-reference/techniques/instanced-assembly.md) | `DreiCells` | 6 s |

Append `L` or `V` for landscape or portrait. The exhibition cut uses an original graphite-and-alloy projector with shaped optics and an animated battery cartridge. The material study has its own scene, with a bevelled transmission surface over a high-contrast form. The demos generate their geometry and lighting locally. For the full 30-second reel use `DreiReelL`. For glass A/B use the same composition stem with `Control` before the format suffix.

```bash
pnpm motion:render --entry src/motion/lab/drei.tsx --composition DreiReelL --output out/qa/drei/reel.mp4 --gl angle
pnpm motion:still --entry src/motion/lab/drei.tsx --composition DreiOpticsV --frames 24,82,125 --output out/qa/drei/optics --gl angle
RUN_DREI_RENDER_TESTS=1 pnpm exec tsx --test tests/drei-shot-render.test.ts
```

Mount a project asset through `model.src`, using a self-contained, uncompressed GLB under `projects/<id>/`. For a generic studio shot the existing `studio-product-stage` accepts `model` on the single stage. For motion, use `ModelShot` with the selected block's props. Normalised camera positions are multiples of the fitted camera distance and the target uses scene units. Confirm the lens, perspective and model placement at the intended frames. For the graph or chart behind a story, keep measurements in the source data and use the `viz` workflow where its recipes fit. [Generated meshes](../.agents/skills/engine-selection/references/generated-3d.md) · [Visualisations](visualisations.md)

Use the project experiment comparison to freeze brief, concept, script and sources. Keep the model, limits, asset hashes and titles matched across the baseline and candidate. Compare blind for material clarity, readability, pacing and fit. Promotion remains opt-in until the procedure in the experiment guide shows editorial parity across three unseen briefs and at least 20% fewer manual corrections on two, with zero critical failures. Record seconds per render and the GPU backend. [Compare and promote](experiments.md#compare-two-projects)

## Source studies and extensions

The [pinned PMNDRS examples](https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples) are technique references. The six entries in the catalogue cite their specific source. The original demos here use our own geometry, camera, graphics and copy.

| Example families | Route for further development |
| --- | --- |
| `baking-soft-shadows` | Fixed shadow bake or Blender plate; qualify the result against our contact shadow. |
| `bubbles`, `clouds`, `tilt-shift` | Seeded spatial fields; use existing sphere blocks when they fit; qualify the camera and postprocessing separately. |
| `diamond-refraction`, `inter-epoxy-resin`, `moksha` | Optics and inlays; compare a stable local Three pass with a Blender material shot. |
| `dbismut-furniture`, `router-transitions`, `react-spring-animations` | Frame-driven model swaps and transitions; settle or spring by the frame rather than by browser events. |
| `react-pp-outlines`, `monitors` | Selected outlines and secondary render targets; test against visible edges and existing device playback first. |
| `camera-shake`, `threejs-journey-lv-1-fisheye` | A short camera impulse or motivated lens distortion; derive the pose from an absolute timeline. |
| `cell-fracture`, `bestservedbold-christmas-baubles`, `bruno-simons-20k-challenge`, `object-clump`, `racing-game` | Bake physics in Blender or play a frame-addressable transform sequence. |
| `gpgpu-curl-noise-dof`, `r3f-alpha-6` | Research GPU fields or layered optical techniques as qualified plates before considering a reusable option. |

Every new production treatment needs its own card, original preview, seek proof and a motivated use case. Geometry and animation sampling use the Remotion frame. The assembly uses the underlying Three.js instanced mesh, writing matrices at commit. This avoids relying on Drei’s live instance registration when rendering an isolated frame. Stateful accumulation and runtime physics belong in an asset preparation or plate route. [Engine selection](../.agents/skills/engine-selection/SKILL.md) · [Credits](../CREDITS.md)
