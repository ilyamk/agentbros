# Previs in 3D: blockouts, passes and camera paths

Tiers and dates: [legend](../SKILL.md#references). Blender kit and directing: the `blender-3d` skill.

## When

- A shot needs exact geography or a camera move a model will not invent consistently: a reveal around a set, a product turn, several shots of one space.
- Several shots must agree on layout: one blocked-out scene, rendered per shot, is the geometric memory the 2D references lack.

## Prepare

- A blockout `.blend` inside the project (proxies at true scale, the camera on its rig, the move timed to the shot).
- The target asset the pass must match: the derivative's input is the clip or frame whose size and frame count the pass takes.
- A `blender-pass` derivative per pass: `beauty`, `clay`, `depth`, `normal`, `mist` or `camera-path`, with `scene` naming the project-relative `.blend`.
- The pass the route can use: a clay or beauty render is a picture for a `camera` or `keyframe` reference; a depth or normal pass is a control signal only where a profile takes one.

## Specs and sources

- A grey or clay render is a composition and camera reference, not a depth map; depth conditioning needs a real exported depth pass and a route that accepts it ([3P], RFC 0003 §3.7).
- Working pipeline: a clay 3D render used as the video reference for a generated action short — [3P] [fal blog, clay render to action short](https://fal.ai/blog/from-clay-3d-render-to-a-real-action-short-a-3d-to-ai-pipeline-with-total-control), checked 2026-11-17.
- Research converges on a 3D proxy (point cloud, mesh, Gaussian splats) as geometric memory with per-shot renders as conditioning: [GEN3C](https://research.nvidia.com/labs/toronto-ai/GEN3C/paper.pdf), [ReCamMaster](https://arxiv.org/abs/2503.11647), [NeoVerse](https://arxiv.org/pdf/2601.00393) ([P], checked 2026-11-17).
- Generated motion follows the guide; it is not keyframe-exact ([3P], RFC 0003 §3.7). Plan holds and cuts that tolerate drift.

## In our system

| Pass | Output | Use as |
|---|---|---|
| `beauty`, `clay` | a preview MP4 with its PNG sequence beside the receipt, or a PNG still for a still target | `camera` or `keyframe` reference; a first frame from `extract-frame` |
| `depth`, `normal`, `mist` | a normalised preview MP4 plus the PNG sequence and its near and far range in the receipt | `depth` on a route that takes it; otherwise review only |
| `camera-path` | `camera.json`, a data output no further step takes | the move for the build, or the prose of the camera sentence |

- `pnpm refs:derive --project ID --action plan --spec SPEC.json --dry-run` checks the scene path and the step chain; `run` needs Blender on the machine (`blender:run` discovery). A Blender step leads its derivative.
- Note in `cinematography`'s shot spec whether a shot needs a previs pass, so the material step plans it.

## Failure modes

- Calling a clay render a depth map: the model treats it as a picture and copies its grey look.
- A pass at a different size or frame count from the target: refused by the slot limits; re-render at the target size.
- Expecting keyframe-exact motion from a guided generation: the result drifts; cut before it shows.
