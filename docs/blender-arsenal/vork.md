# Vork 0.5.1

## Purpose for films

Programmable local GPU rendering complements Blender's modelling, assets, rigging and scene tools. Vork is useful for authored Slang materials, compute-driven instances, custom optics and compositor/AOV work. It is a code-driven renderer: prompts direct the agent's scene authoring rather than invoke a text-to-video model. Remotion remains the edit, sound and delivery engine.

## Licence & permissions

The [Preview License](https://github.com/voyager-so/vork/blob/v0.5.1/LICENSE) allows local/internal rendering and distribution of finished media, including commercial media. Hosted rendering for third parties needs separate written permission. The external runtime is downloaded explicitly into the agentbros cache, never distributed in this repository. The file-exchange bridge is separately GPL-3.0-or-later, with full licence and provenance under `vendor/vork-blender`. There is no account or cloud dependency in this integration. The user authorised local implementation and trials with “Implement the plan.”

## Maintenance & compatibility

Pinned release v0.5.1, source commit `011e3f12e6c17696b3d854c173dca37a8159c6c4`. Apple Silicon archive SHA-256 `ce9b28b13e002fc93b8017bf0d2e7e05ca1fc00f3232f0c3066814031582a625`; Linux x64 has its own pin in `src/lib/vork/runtime.ts`. The qualified host is Apple M1 Max, macOS 27.2.1, Blender 5.3.0. Upstream bridge 5.2.1 remains admitted; other Blender versions fail explicitly. Linux runtime installation is supported but its GPU rendering is untested here. Version changes require new qualification.

## Headless & determinism test

Commands use literal arguments, bounded subprocess ownership and fresh output revisions. Blender runs through the existing factory-startup runner. Scenes use fixed frame time and explicit seeds; receipts hash dependencies, runtime, outputs, actual settings and warnings. Nine original recipe probes rendered frames 0–2 and frame 1 alone at 320×180, four samples. All nine decoded comparisons were exact on this host, including the coarse cloth/fluid experiments. This does not establish cross-device identity or full-clip temporal stability.

## Trial results

Evidence is retained locally under `out/qa/vork-integration`; the dated verification record records final checks and demonstrations. Initial three-frame-plus-isolated render wrapper totals ranged from 5.99 s for the 1,000-instance swarm to 233.81 s for coarse fluid, including launch and compilation. Those are different workloads and not comparative renderer benchmarks. Full-resolution native product and Blender-export-plus-surface-effect movies were rendered, along with supported geometry returned to Blender. Real-footage tracking and compositing trials retain failures and diagnostics as well as usable results.

The saved Blender source and imported geometry remain editable. GLB exports require an explicit supported subtree such as `--node hero`; scene lights, arbitrary programmes, compute-only geometry and unsupported animation cannot silently become editable Blender content. Use RGBA/EXR passes for those effects. Translation of Blender materials is strict, with full material reports. Neither OpenPBR nor an accepted export implies identical BSDFs.

## Critique

| Intent | Visible success | Flaw | Repair | Remaining limit |
|---|---|---|---|---|
| Product shot | Machined profile, reflective material and contact read clearly | Simple authored demonstration | Direct camera/light/material from the actual brief | No claim of generated product accuracy |
| Blender surface effect | Exported sculpture retains staging; progressive luminous lines are visible | Alternate renderer changes appearance | Compare matched source and retain material report | Shader/BSDF parity is not guaranteed |
| Large instance field | 100k opaque instances animate without CPU geometry generation per frame | First camera clipped the formation | Wider fixed camera and settled end | Previs and final transport differ |
| Real plate insertion | Camera evidence and foreground masks are explicit | Estimated calibration and artistic light | Inspect held-out tracks and all mask boundaries | No universal camera or depth solve |

## Verdict

**experimental** — approved local integration with technical evidence, not a blanket creative-quality approval. Select Vork per shot; keep Blender for capabilities it supplies well. Human creative acceptance, new hosts and larger simulation workloads remain separate qualification work.

## Recipes that use it

`vork:recipe list` exposes ten original authoring recipes, spanning product/geometry, surface/displacement, instances, fluid, cloth, medium, propagation, compositing and camera/sensor/display/custom AOV programmes. `.agents/skills/vork-3d-vfx/` explains prompting, interchange and constrained footage work. See [Vork operations](../vork.md) and [the implementation specification](../vork.md).
