# Directing with the craft kit

The vocabulary of `scripts/blender/kit/`. Every function is a pure function of the frame (seeded noise only), so a frame rendered alone equals the same frame inside a range. Blender frame 1 is block frame 0: kit functions take the block frame.

## Motion: `kit.curves` and `kit.anim`

Intent curves, the same numbers as `src/motion/timing.ts` (`tests/blender-kit.test.ts` holds them equal):

| Intent | Bezier | Feels like | Use for |
|---|---|---|---|
| `snap` | 0.87, 0, 0.13, 1 | decisive, mechanical | cuts on action, whips, a switch flipping |
| `brake` | 0.16, 1, 0.3, 1 | fast arrival, long brake | entrances, reveals, a camera landing |
| `glide` | 0.45, 0, 0.55, 1 | even and calm | camera moves, light sweeps, drifts |
| `float` | 0.37, 0, 0.63, 1 | weightless | hovering, breathing, idle |
| `punch` | 0.34, 1.56, 0.64, 1 | overshoots and returns | pops, hook beats, a stamp |
| `settle` | spring | arrives and rings out | the end of anything with weight |

- `track(frame, [(at, value, intent), ...])`: keyframes where each segment's intent shapes its arrival.
- `anticipate(frame, at, wind, action, amount, overshoot)`: a wind-up against the move, the action, an overshoot and a settle.
- `follow_through(frame, stop, amplitude, damping, frequency)`: a damped ring after a stop (hair, a hanging sheet, a card with weight). `jiggle` sums several.
- `volume_scale(stretch)`: (sx, sy, sz) with sx·sy·sz = 1. `hop(...)` returns lift and stretch for crouch, take-off stretch, air, landing squash and settle. `bounces`, `arc`.
- `breathe(frame, period, amount)` for holds that are alive; `blink(frame, at)` and `blinks` (2 frames closing, 1 closed, 4 opening); `delayed(fn, frame, frames)` and `smoothed(fn, frame, half_life)` for a part that lags its leader (body after eyes, camera after subject).
- `stagger(count, step, kind)` and `hierarchy(...)` (timing.ts): hero first, support after a gap, details last.
- `noise`, `band_noise(seconds, seed, low, high)`, `handheld(frame, seed, fps, rotation, translation, band)`, `flicker`: seeded, band-limited.

`anim.key_intent(owner, path, f0, v0, f1, v1, intent)` writes one move as two keys with free bezier handles (editable in the graph editor). `anim.Timeline(frames)` takes per-frame functions (`add(owner, path, fn)`; several on one channel are summed) and bakes linear keys on its own channels only. Node sockets and pose bones work as owners.

## Camera: `kit.camera.Rig`

`Rig(a, role, target, subject, lens, fstop, yaw, pitch, distance, fill)` frames `subject` (width, height in metres) at `fill` of the frame for the lens and sensor. Role defaults:

| Role | Lens | f-stop | Use |
|---|---|---|---|
| `hero` | 85 mm | 2.8 | the subject performing; compression and separation |
| `reveal` | 50 mm | 4 | showing the thing and its place |
| `detail` | 100 mm | 2 | a material, a number, a screen |
| `establishing` | 35 mm | 8 | the set, scale, a group |

Moves (each with `at`, `frames`, `intent`): `dolly(factor)`, `push_in(factor, pull_from=...)` (a push with a focus pull), `truck`, `crane(pitch_from, pitch_to, boom)`, `orbit(yaw_from, yaw_to)`, `follow(fn, half_life, weight)` (an operator's lag), `handheld(amount, seed, band=(0.6, 2.5))` (hertz: a held camera, not jitter), `whip(at, frames, degrees)` (needs motion blur), `rack(point_from, point_to)` (points or functions of the frame), `zoom`, `roll`, `frame_offset(x, y)` (lens shift for composition). `vertical_fill(a, subject, lens)` gives the distance that fills a 9:16 frame. Rules of thumb: the camera is slower than the subject; one primary move per shot; a move starts before the action it follows and lands after it.

## Light: `kit.light.mood`

| Mood | Key:fill | Kelvin (key / fill / rim) | HDRI, world | View, grade | For |
|---|---|---|---|---|---|
| `soft-product` | 2.2:1 | 5600 / 6300 / 6800 | softbox, 0.3 | agx, clean | objects, toys, packaging |
| `high-key` | 1.25:1 | 6000 / 6300 / 6500 | studio, 0.8 | agx-base, clean | bright commercial, white grounds |
| `low-key` | 17:1 | 4300 / 6500 / 7800 | studio, 0.05 | agx-contrast, filmic | drama, paper, metal on black |
| `rim-hero` | rims only | 7200 and 5200 rims, 5600 key | studio, 0.12 | agx-contrast, filmic | silhouettes, glass, dark products |
| `golden-hour` | 3.6:1 | sun 3000, sky 9500, bounce 3600 | warm, 0.35 | agx-punchy, filmic | outdoors, warmth, glass domes |
| `neon-night` | 25:1 | coloured key and rim, 8000 fill | loft, 0.03 | agx-punchy, filmic | night, tech, hooks |
| `overcast` | 1.8:1 | 6800 / 6500 | loft, 0.7 | agx-base, clean | calm, even, documentary |

Lights sit in polar coordinates around the subject relative to the camera, sized in subject sizes, so a mood transfers between scenes. `mood(name, target, size, camera_yaw, exposure, world_strength, use_world, only, scale)`; `scale={"rim": 1.5}` adjusts one light. Animate with `sweep(name, az_from, az_to)` (a highlight travelling across a surface), `flicker`, `reveal`.

## Look: `kit.look`

| View preset | Why |
|---|---|
| `agx` | photoreal default: highlights roll off without skew; medium-high contrast restores punch |
| `agx-base` | bright grounds and screens: base AgX keeps whites white and inverts the screen colourspace exactly |
| `agx-contrast` | low-key and rim: deep blacks without crushing the rim |
| `agx-punchy` | saturated light that is the subject (sunset, neon) |
| `filmic` | matching older Filmic renders only |
| `standard` | an exact hex: a ground or brand colour that must equal Remotion's; light gently, it clips |

**Screens.** AgX desaturates emissive colour on purpose, so a phone screen at strength 1 tagged sRGB renders pale (sRGB 0.78, 0.95, 0.49 measured 0.69, 0.75, 0.55). `look.screen_material` tags the image with the view's inverse (`AgX Base sRGB`, `Filmic sRGB`) and emits at 1, which renders 0.75, 0.89, 0.49 under `agx-base`; any AgX look (Punchy, contrast) shifts it again, so pair screens with `agx-base` or `standard`. Brightness is exposure, not emission strength.

Grades (`look.grade(scene, preset, background=None, **overrides)`, a compositor node group): `clean` (bloom 0.04, vignette 0.08), `filmic` (bloom 0.12, vignette 0.18, warmth 0.04, slight dispersion), `tactile` (bloom 0.03, saturation 0.92, warmth 0.07, lift). Grain belongs to Remotion's FilmFinish, not the plate. `background` composites a transparent render with a shadow catcher over an exact hex. `look.motion_blur(scene, 0.5)` is on by default; turn it off only for a freeze frame.

## Stage: `kit.stage` and `kit.character`

`sweep`, `floor(kind=plaster|wood|paper)`, `plinth` and `surface` carry a little roughness imperfection, so no surface is CG-perfect. `rest_on` puts objects on the floor. `roles(hero, support, detail)` staggers entrances by importance. `report(scene, cam, {role: [objects]}, floor_z, contact, frames)` writes `craft-report.json`: each role's frame box, how far it leaves the vertical, square or landscape safe frame (design-token safe zones), and the floor gap of contact objects, and prints `[craft]` lines for every problem.

`character.rig_plush(root, body, height)` converts a metaball toy to a mesh with an armature (root, body, head, ears, arms) and features parented to bones; animate pose bones (Y along the bone: a squash scales Y; on the head, x nods, y yaws, z tilts). `blink_scale` and `look_angles` drive eyes.
