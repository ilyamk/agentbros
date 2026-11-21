# Photoreal 3D devices

How an agent makes an Apple-style device shot: a real phone or laptop model, lit in a studio, rendered in Blender and composited in Remotion. Why and the research behind it: [design-reference/photoreal-3d-pipeline.md](../design-reference/photoreal-3d-pipeline.md).

## Pick the route

| Shot | Route | Cost |
|---|---|---|
| Hero beat: the device is the subject, light and material must read as a photograph | Blender shot template in `scripts/blender/`, played by library block `blender-plate` | Render minutes (budget below) |
| Quick, data-driven or many variants; device is context | Library block `studio-product-stage` (`shape: "phone" \| "laptop"`, `hdri`) | Real time in three.js |
| UI is the subject, the device is a frame | `ui-phone-hero` or a flat screen | Real time |

Both 3D routes use the same models, so a three.js animatic can be replaced by a Blender plate without changing framing ideas.

Generated meshes use `public/projects/<id>/assets/3d/<name>.glb` (`ai-3d` → `model3d`); see [generated 3D](fal-catalogue.md#generated-3d-in-a-film) for frame-driven loading, the device-stage gap and the Blender handoff.

## Assets

| Path | What | Licence |
|---|---|---|
| `public/shared/3d/phone.glb` | Phone, 159.6 mm, titanium frame, camera island, screen mesh named `screen` with 0..1 UVs | Third-party model, not committed: "Apple iPhone 15 Pro Max Black" by polyman, CC BY 4.0, fetched and normalised by `pnpm assets:sync --family 3d`. The licence is recorded second-hand (from another project's credits file, not re-read on Sketchfab). Attribution is required wherever a render of it is published: the `attribution` line in `sources.json` |
| `public/shared/3d/laptop.glb` | 16-inch laptop, lid open, screen mesh named `screen` | CC BY 4.0, credit in `sources.json` |
| `public/shared/hdri/*.hdr` | Four Poly Haven 2k studio HDRIs: `studio`, `softbox`, `warm`, `loft` | CC0 |
| `public/shared/3d/plates/hero-turntable.mp4` | Default plate for `blender-plate` previews | Own render |

Both models depict Apple products. The owner accepted this for this repository; a film for a third party should use a generic device (design-reference doc, "Apple iPhone: no"). Credit CC BY models in the film's credits or description: the `attribution` line in `public/shared/3d/sources.json`.

To add a device, put its GLB beside the others' sources, add a `DEVICES` entry in `scripts/blender/prepare_devices.py` (screen object name, turn, real size) and run it; it writes the normalised GLB (metres, screen facing the camera, screen UVs laid in the display plane, no Draco).

## Shot templates

All run through the runner, which applies `--samples`, `--resolution`, `--frames`, `--film-transparent` and `--resume`, writes a contact sheet and `camera.json`:

```bash
pnpm exec tsx scripts/blender-run.ts --script scripts/blender/<shot>.py --output out/<id>/<shot> \
  --frames 1-90 --samples 16 --resolution 1920x1080 [--film-transparent] [--resume] \
  --script-args '["public/projects/<id>/assets/blender/<shot>.json"]'
```

The script argument is a JSON object or a path to one. Unknown keys fail. Common keys (`scripts/blender/studio_kit.py`):

| Key | Default | Meaning |
|---|---|---|
| `device` | `phone` | `phone`, `laptop`, or a path to a normalised GLB |
| `look` | `dark` | `dark` (near-black sweep), `light` (grey sweep), `none` (transparent, small shadow catcher; add `--film-transparent`) |
| `backdrop` | look's | Sweep colour, `#rrggbb` |
| `lights` | `softbox` | `softbox` (key, rim, top, edge strips), `rim` (two edge rims, low key), `bright` (high key) |
| `hdri`, `hdriStrength`, `hdriRotation` | `studio`, 0.8, 0 | Reflections and fill |
| `screen` | none | PNG/JPG, or a folder of numbered frames played one per scene frame |
| `screenBrightness` | 1 | Display emission |
| `frames`, `fps` | 60, 30 | Scene length |
| `lens`, `fstop` | 85, 2.8 | Real depth of field; `fstop: 0` turns it off |

| Script | Moves | Extra keys | Anchors in camera.json |
|---|---|---|---|
| `hero_turntable.py` | Device turns from back to front, camera eases in | `yawFrom`, `yawTo`, `tilt`, `push`, `height`, `fill`, `lift` | `screen_tl/tr/br/bl` |
| `screen_swap.py` | Device faces camera with UI on screen; slow drift and push | `yawFrom`, `yawTo`, `tiltFrom`, `tiltTo`, `push`, `fill`, `fit` (`contain`/`cover`) | `screen_*` |
| `exploded_view.py` | Parts slide apart along depth in `groups` layers and hold | `spread`, `groups`, `yaw`, `tilt`, `openAt`, `openFor`, `closeAt` | `part_0..N` |
| `macro_sweep.py` | 100 mm at f/1.8 slides along a detail | `path` (`camera`, `edge`, `bottom`), `travel`, `distance` | none |
| `multi_device.py` | Laptop and phone float on slow bobs in one light | `devices`, `screens` (per device), `bob`, `turn` | `laptop_*`, `phone_*` |

Make the screen UI from the library itself: render a still or a PNG sequence of a `ui` block (`npx remotion render src/motion/library/index.tsx Lib-ui-chat-thread-V out/<id>/ui --sequence --image-format=png`). A phone display is about 0.46 wide to tall; a 1080x1920 frame is letterboxed by `fit: "contain"`. Render UI at 1179x2556 to fill it exactly.

## Twins of browser blocks

`scripts/blender/toy_kit.py` and six shots give the reference techniques that were built as browser approximations a real Blender route. The browser block stays the cheap fallback; the plate is the high-quality option. Each shot keeps its block's timing keys, so the block's cues land on the plate.

Each is a directed 3-3.5 s shot built on the craft kit (`scripts/blender/kit/`, vocabulary in the blender-3d skill's [directing](../.agents/skills/blender-3d/references/directing.md) reference): an entrance with anticipation, one motivated camera move, a light mood, a settle.

| Shot | Block and prop | Shot intent and direction |
|---|---|---|
| `glossy_orb.py` | `shaded-orb` (glossy), `plate` | Hook, 96 frames: the ace t05 orb grows on the block's ACE_ORB windows with a squash that rings out, then lives: glances, blinks, a hop with anticipation. Matte pill eyes, contact shadow composited over the exact ground hex (Standard view), high-key light |
| `plush_character.py` | `blender-plate` | Hook, 105 frames: an original felt plush on an armature rig notices the camera, crouches, hops with squash and stretch, lands, says hello with a head tilt and a blink, bounces and holds. 75 mm hero push with a focus pull, soft-product light |
| `glass_dome.py` | `blender-plate` | Reveal, 105 frames: the plush types at a desk under a thin-film glass dome on a floating island, then looks up as tiles rise; orbit, crane and rack, golden-hour sun. `view` side or overhead (muse t03, t16) |
| `printing_slip.py` | `printing-slip`, `plate` | Proof, 84 frames: a white receipt unrolls and prints (block timing), the camera follows the print line with an operator's lag and pushes in on the total; matte legible ink, low-key raking key (polymarket) |
| `card_fan.py` | `depth-card-flythrough` (fan), `plate` | Reveal, 90 frames: a dozen metal cards fan on the block's fanAngles, each with its own follow-through; the camera cranes up and arcs round, a strip light glints across (flex t06) |
| `device_array.py` | `studio-product-stage` (array), `plate` | Reveal, 90 frames: phones drop into the isometric grid centre-out and bounce to rest, screens wake in true colour (inverse view colourspace), the block's orthographic truck plus an 8% push (cashfree) |

Render a plate with `pnpm assets:sync --id plates:<name>` (production settings, slow) or a proof with `pnpm blender:run --script scripts/blender/<shot>.py --output out/qa/<shot> --frames 1-96 --samples 16 --resolution 640x360 --encode h264` (the shot's own frame count, in its docstring), then pass `plate={{ src: "shared/3d/plates/<name>.mp4", frameCount: 96 }}`. Settings and measured times: [scripts/blender](../scripts/blender/AGENTS.md).

## Remotion side

`blender-plate` (`src/motion/library/three/BlenderPlate.tsx`) plays the plate and composites type over it:

```tsx
<BlenderPlate
  src="projects/<id>/blender/hero/frame-######.png" firstFrame={1} frameCount={90} fit="cover"
  background="radial-gradient(80% 60% at 50% 45%, #15161b, #050506)"
  headline="Every payout, settled." subline="In minutes, not days." textColour="#f5f5f7" textSide="left" textAt={34}
  camera="projects/<id>/blender/hero/camera.json" screenOverlay="projects/<id>/ui/frame.png"
/>
```

- Copy or render the frames under `public/projects/<id>/` so `staticFile` can serve them. A `#` run is the padded frame number; transparent PNGs show `background` through.
- `camera` plus `screenOverlay` pins an image to the four screen corners with a CSS `matrix3d`, so the UI stays editable without re-rendering Blender. Render the device with a dark screen (`screen` unset) when you do this.
- A video `src` (`.mp4`) also works, without alpha.
- Cues: `reveal` at `textAt`, `land` on the last plate frame.

`studio-product-stage` loads the same GLBs with `useGLTF` (Suspense is held by `ThreeCanvas`) and a real HDRI through drei `Environment`. Its single layout also accepts a local project GLB via `model.src` ([3D shot techniques](drei-techniques.md)). It has no depth of field: the deterministic-composer fix in the design-reference doc was not built, so depth of field comes from Blender.

## Render-time budget

Measured on this machine (M1 Max, Metal, Blender 5.2.3, Cycles with OIDN, machine shared with other renders):

| Pass | Time |
|---|---|
| Look frame, 960x540, 24 samples, phone | 5-13 s including launch |
| Hero turntable, 1920x1080, 16 samples, phone on dark sweep, 60 frames | 1041 s in all (17 s a frame on average: 8 s alone, 25-35 s while other agents rendered Remotion). Its contact sheet is not kept in the repository because the model shows the device maker's logo |
| Screen swap, 1280x720, 16 samples, transparent, 60-frame PNG-sequence screen | 573 s in all (9.5 s a frame, shared machine). Its composite is not published (third-party device model). |
| Exploded, macro, multi-device look frames, 960x540, 24 samples | 10-15 s each (frames not published: third-party device models) |

Plan a 3 s hero shot (90 frames, 1080p) as 12 minutes on a quiet machine and up to 50 minutes on a busy one. Run it in the background with `--resume` and a `--timeout` sized from a timed frame, and keep building Remotion scenes meanwhile.

## Quality loop

1. One look frame at 960x540 from the busiest moment; read it.
2. Name what is wrong: "screen washed by the HDRI reflection", "frame reads as grey plastic", "backdrop grey not black". Fix one group (lights preset, `hdriStrength`, `backdrop`, `screenBrightness`), look again.
3. Render the sequence, then read the contact sheet and `pnpm motion:strip` of `preview.mp4`.
4. Composite in Remotion and check the type against the moving device.
5. For a directed shot (twins, characters), the fuller loop with `craft-report.json`, `film:measure` and blind old-versus-new packets is the blender-3d skill's [quality loop](../.agents/skills/blender-3d/references/quality-loop.md); a [live session](../.agents/skills/blender-3d/references/live-session.md) keeps Blender open for the look-and-fix steps.

Known traps: dark glossy backdrops pick up the HDRI as a grey sheen (the kit keeps backdrop specular low); bright HDRIs wash a glossy screen (the kit lowers screen specular); a large shadow catcher records the key's fall-off (the kit uses a small disc).
