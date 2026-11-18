---
name: blender-3d
description: Direct a Blender shot from shot intent to motion curves, camera rig, lens, light and look, with realistic materials, simulations and ready-made models. Use for photoreal product shots, characters, physical pours and falls, complex scenes, or any request naming Blender.
---

# Blender 3D: directing a shot

Read the approved brief first. Existing approval and no-spend instructions take precedence. `blender:scene` stays the route for simple deterministic scenes pinned to Blender 4.5.14; this skill covers everything richer.

A Blender render is not good because it is photoreal. It is good when it is a directed shot: one idea, a subject that performs, a camera that moves for a reason, light that has a mood and a frame that settles. Correct physics with no direction is 3D slop (section 7).

## 1. Is Blender needed?

Stay in Remotion with three.js when all of these hold: simple shapes, flat cards or light 3D type; no believable shadow, reflection or material is the point of the shot; the look can be judged in a browser at 30 fps.

Choose Blender when any of these hold:

- A viewer should believe it is a photograph: glass, metal, skin, food, fabric, felt or soft window light.
- Objects must physically interact: pours, falls, cloth, fluid, smoke, many colliding parts.
- Depth of field, motion blur or global illumination carries the shot.
- A complex ready-made model or `.blend` is the starting point.

If neither list clearly applies, make a three.js style frame first. It costs less and may be enough. Engine choice in general: the `engine-selection` skill.

Prepared spatial charts and diagrams use `pnpm viz:list`, `viz:prepare`, then `viz:preview --backend blender` for three inspection frames and `viz:render --backend blender` for the complete sequence. Use a pinned revision and prepared layout for every format. The trusted adapter takes JSON, material/light presets and manifest-backed PBR maps; it cannot execute agent-supplied Python. Inspect a full-size settled composite before accepting a sequence. Mount complete render receipts with `viz:mount`; see [visualisations](../../../docs/visualisations.md).

## 2. Shot intent first

Before any code, write the shot in one line: its **function** in the film, **what the viewer must notice** and **the beat it lands on**. Then pick everything else from the function, not from what looks impressive.

| Function | Motion curves | Camera rig (role) | Lens | Light mood | Look |
|---|---|---|---|---|---|
| **hook** (first 2 s, stop the scroll) | `punch`, `snap`; anticipation, overshoot | `hero`: push-in or whip | 50–85 mm | `rim-hero`, `neon-night`, `low-key` | `agx-punchy` or `agx`, `filmic` grade |
| **reveal** (show the thing) | `brake` in, `settle` out; staggers | `reveal`: crane, orbit, dolly back | 35–50 mm | `golden-hour`, `soft-product` | `agx`, `clean` or `filmic` |
| **proof** (read a detail, a screen, a number) | `glide`, `brake`; holds with breathing | `detail`: slow push, rack focus | 85–100 mm, f/2–2.8 | `soft-product`, `high-key`, `overcast` | `agx-base` (screens) or `standard`, `clean` |
| **cta** (land, hold, end frame) | `settle`, `float`; the last 10–20 frames still | `hero` or `establishing`: tiny drift | 35–60 mm | `high-key`, `soft-product` | the brand's: `clean` |

The structure inside a shot is anticipation → action → overshoot → settle. A 3–4 s shot is: entrance (with anticipation), a motivated camera move, one secondary beat (a look, a blink, a glint), and a settle the cut can leave from. Every move has a reason you can name: following the action, revealing scale, landing on the proof.

## 3. The craft kit

`scripts/blender/kit/` holds the directing layer; use it before writing keys by hand ([directing](references/directing.md) has the full vocabulary and the numbers):

- `curves`: the intent curves of `src/motion/timing.ts` (`snap`, `settle`, `glide`, `punch`, `float`, `brake`) and anticipation, follow-through, jiggle, squash and stretch with volume kept, hops, arcs, breathing, blinks, staggers, seeded noise and a handheld shake in a physical frequency band. Pure Python, tested against `timing.ts`.
- `anim`: `key_intent` writes one move as F-curve keys with handles; `Timeline` sums per-frame functions and bakes only the channels it owns.
- `camera.Rig`: role defaults (hero 85 mm f/2.8, reveal 50 mm f/4, detail 100 mm f/2, establishing 35 mm f/8) and moves `dolly`, `push_in` (with a focus pull), `truck`, `crane`, `orbit`, `follow`, `handheld`, `whip`, `rack`, `zoom`, `roll`, `frame_offset`; `vertical_fill` for 9:16.
- `light.mood`: `soft-product`, `high-key`, `low-key`, `rim-hero`, `golden-hour`, `neon-night`, `overcast`, each with ratios, colour temperature, HDRI and world strength; `sweep`, `flicker`, `reveal` animate a light.
- `look`: view transform per preset with its reason, motion blur, the `clean`/`filmic`/`tactile` grade node group, and `screen_material` for phone screens that keep their colour.
- `stage`: sweep, floor, plinth, contact on the floor, hero/support/detail staging, and `report`, which checks safe frames for vertical, square and landscape and the floor gap.
- `character`: `rig_plush` turns a toy into an armature-driven character; blink and look-at helpers.

The six twins (`glossy_orb`, `plush_character`, `glass_dome`, `printing_slip`, `card_fan`, `device_array`) are worked examples of every function above; each docstring states its shot intent ([scripts/blender](../../../scripts/blender/AGENTS.md)).

Reach for a [built-in recipe](../../../scripts/blender/recipes/AGENTS.md) before writing an effect: `pnpm blender:recipe list`. Compose with `avc_recipes.apply`; require measured proofs and inspect its sheet. For a gap, follow [grow the arsenal](references/arsenal.md): built-in first, candidates, research, consented trial, evaluate, owner approval, pin/test/contribute.

## 4. Probe, consent, route

```bash
pnpm exec tsx scripts/backend.ts --action probe --backend blender
```

`metadata.version`, `path` and `routes` say what this machine can do. Ask, and wait for a clear yes, before installing Blender or starting Blender work on a brief that did not ask for 3D, downloading models, textures or plugins, connecting MCP (it changes harness configuration), enabling an add-on, and any paid generator.

| Route | Use for |
|---|---|
| Headless `blender:run` (default) | Everything scriptable. Repeatable, logged, hashed, every harness |
| Live session (`blender:live`) | The look-and-fix loop: one Blender kept open, a still after each change, `run-kit` to load a twin or template and adjust it, every change journaled back into a `blender:run` recipe. See [live session](references/live-session.md) |
| MCP | Third-party servers, after consent: [MCP routes](references/mcp-routes.md) |
| GUI through computer use | Add-on panels with no Python path, after consent |

Shot scripts must run repeatedly in one Blender process (that is how `run-kit` executes them): a JSON object as the argument, no `sys.exit`, and handlers or state created by the script only, from the frame alone.

## 5. Devices and twins

For a phone or laptop, start from the studio kit and the shot templates (`hero_turntable`, `screen_swap`, `exploded_view`, `macro_sweep`, `multi_device`), which load the normalised models in `public/shared/3d/` and export screen-corner anchors to `camera.json`. Play the render with library block `blender-plate`. Keys and render budgets: [photoreal 3D](../../../docs/photoreal-3d.md). A real product's screen shows the real UI (`capture:app`), never a stand-in.

## 6. Run

Keep a project's scene scripts and `.blend` files in `public/projects/<id>/assets/blender/`.

```bash
pnpm blender:run --script public/projects/ID/assets/blender/shot.py --output out/qa/ID/look1 --frames 40-40 --samples 16 --resolution 960x540
pnpm blender:run --script public/projects/ID/assets/blender/shot.py --output out/qa/ID/proof --frames 1-96 --samples 16 --resolution 640x360 --encode h264
pnpm blender:run --blend public/projects/ID/assets/blender/shot.blend --output out/ID/shot --frames 1-120 --samples 64 --resolution 1920x1080 --encode h264 --project ID --import --metadata sources.json
```

Results include a contact sheet, `preview.mp4`, frames with hashes, `blender-run.json` and, from `stage.report`, `craft-report.json`. Open images with your harness's image tool ([agent vision](../../../docs/agent-vision.md)); a path in JSON is not a look. Read [rendering craft](references/rendering-craft.md) before the look pass, and [the worked pour](references/examples/coffee_pour.py) for a script that bakes a simulation once and iterates on look without re-simulating.

**Passes for a generated shot.** When a blockout guides a video model rather than being the shot, render conditioning passes with `refs:derive` `blender-pass` (`depth`, `normal`, `mist`, `clay`, `beauty`, `camera-path`; `scripts/blender/kit/passes.py`) at the target's size and frame count, so each is a hash-pinned derivative with a receipt. A clay or beauty render is a picture for a camera or key-frame reference, not a depth map; depth conditioning needs the exported depth pass and a model profile that takes it ([previs](../reference-preparation/references/previs-3d.md)).

## 7. Checklist and 3D slop

Before a sequence render, every answer is yes:

1. The shot has a written intent (function, what to notice, beat), and its curves, rig, lens and mood come from it.
2. The subject enters with anticipation and leaves the shot settled; nothing moves on `linear` except mechanics.
3. The camera move has a named reason and is slower than the subject; it never fights the action.
4. Contact: objects sit on the floor (`craft-report.json` floor gap ≈ 0) with a contact shadow.
5. The key-to-fill ratio and colour temperature are chosen, not defaults; the subject separates from the background.
6. Screens and brand colours match their source (`agx-base` with `screen_material`, or `standard`).
7. Motion blur is on; depth of field serves the reading order; the hero is inside the safe frame of every delivery format.
8. The last frames hold still enough to be a thumbnail and a cut point.

The slop list, all in [the slop catalogue](../../../design-reference/slop-catalogue.md#3d-slop): turntable with no idea; linear or constant-speed motion; floating objects without contact shadows; everything in focus at f/8 on a macro subject; grey AgX screens and washed brand colours; a three-point light with nothing chosen; a camera that drifts for no reason; plastic eyes that read as highlights; no motion blur; the hero cropped in 9:16; and polish without performance (a character that never anticipates, looks or blinks).

## 8. Quality loop

Render stills before sequences, judge them by name, change one group of settings at a time, then prove the motion; the full loop with stills, proofs, contact sheets, motion strips, `film:measure` and blind old-versus-new packets is in [quality loop](references/quality-loop.md). Samples remove noise, not bad direction.

## 9. Assets, rights, security

Read [assets and plugins](references/assets-and-plugins.md). Every third-party file gets its source and licence in the `--metadata` sidecar; a render with unknown rights stays unknown. Never run an untrusted `.blend` with auto-run scripts. The `--script` file is arbitrary Python with your user's permissions: run only code you wrote or read. MCP servers execute arbitrary Python too: keep them on localhost, pin the version, turn telemetry off and save work first.

Review: Does the shot need Blender? Is its intent written, and does every choice follow from it? Did you look at actual frames and a motion strip? Is every licence recorded? Can another agent re-render it from the script and sidecar?

A critic axis below 4 or a missing capability triggers [guarded self-improvement](references/self-improvement.md): fresh blind critics in both orders, advisor diagnosis, one system change, sensors/tests, then keep or revert and log.

## Optional Vork companion

For a named programmable GPU effect or alternate scene renderer, consult `vork-3d-vfx`. Keep the Blender craft kit for direction, export a saved copy through the qualified bridge, and inspect material/animation omissions. Native geometry may return through GLB; GPU-only results return as plates/passes.
