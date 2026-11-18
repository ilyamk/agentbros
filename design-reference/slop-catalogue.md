# Slop catalogue

Last updated: 2026-11-15

The defaults a generated motion film falls into, each as a measurement that blocks in a sensor the chain already runs. A signature is a default, not a ban: an intended use is kept with a stated reason (`--allow` in motion:check; a plan says why in `curve`, `entrance` or `readingHoldSec`).

A threshold marked **provisional** is a hand-set starting point (`// provisional: recalibrated from ref:corpus` in code); one marked **calibrated** was set on the reference corpus, with the numbers in [calibration](calibration.md). A film:measure leg also lifts its ceiling to the reference's own reading plus 0.1, so a reference that does the same thing on purpose is not punished.

| Signature | Sensor, code | Threshold | Source | Fix |
|---|---|---|---|---|
| Linear easing on a moving entrance | plan:check `curve-linear` (fail) | `curve` names `linear` and `entrance` moves (not none, hold, cut or swap) | provisional | Name the curve for the feeling: expo-out to land, ease-in to leave, spring for overshoot; linear only for drift, tickers, marquees |
| Copy held long past reading it | plan:check `text-hold-long` (fail when `readingHoldSec` is stated, warn when inferred under 2× the bound) | hold > max(2.5 s, 3 × required reading time); the last shot is exempt | provisional | Cut the hold to reading time plus a beat, or give the time to something that moves |
| Many layers, no stated order | plan:check `entry-hierarchy` (warn) | a shot with ≥ 3 `layers` whose `entrance` and `intent` name no order (then, stagger, first, cascade, word by word, 4f apart ...) | provisional | Write the order into `entrance`: what lands first, what follows, how many frames apart |
| Everything enters at once | motion:check `SIMULTANEOUS_ENTRY` | ≥ 3 text blocks (distinct faders) whose opacity first passes 0.05 on the same sampled frame with the same opacity, rise, shift (±3 px) and scale (±0.03); cut-ins and blocks visible on the first frame do not count | provisional | Lead with the element that matters; stagger the rest 3–6 frames or move them differently |
| Everything centred | motion:check `TEXT_CENTRED_ALWAYS` | > 85% of text-bearing sampled frames (at least 4) have every settled block's centre within ±6% of the frame centre | provisional | Set type to a grid edge, a third or against the subject in some shots |
| Emoji in on-screen text | motion:check `EMOJI_TEXT`; `pnpm lint --project <id>` `SLOP_EMOJI` (advisory) | any emoji-presentation code point, a pictograph with VS16, or a flag pair (©, ®, ™, arrows excluded) | rule | Replace with a word or an icon drawn in the film's own system |
| Purple-blue gradient | motion:check `SLOP_PALETTE`; `pnpm lint --project <id>` `SLOP_GRADIENT` (advisory) | a linear or radial gradient whose visible stops (≥ 2) all sit at hue 230–290°, HSL saturation > 0.4, lightness 0.12–0.9, on an element over 0.5% of the stage | provisional | Take the palette from the brand or the reference (design.json); a gradient stays within the brand's hue or crosses hue families |
| Frosted-glass card | motion:check `SLOP_PALETTE` | `backdrop-filter` blur ≥ 4 px on a visible element over 0.5% of the stage | provisional | Separate the layer with scale, a solid plane, a hard shadow or space |
| Whole frame drifting | film:measure `motion-spread` | share of 10 Hz samples (away from cuts) in which over 70% of a 4×4 grid changed (a cell changes when over 5% of its pixels move beyond noise) > 0.4 | calibrated: corpus p90 0.29 + 0.1, 0 of 20 references fail; reference + 0.1 | Hold the ground; move one thing. Keep whole-frame moves for the beats that need them |
| Fast motion without blur | film:measure `fast-motion-sharp` (warn only) | of frames where over 15% of the picture moves in one frame (consecutive-frame pairs about 5 a second, never stepped by a multiple of 2 or 3, long side 480 px), the share at least 0.8× as sharp (Laplacian variance) as the settled frames of the same shot > 0.5; needs ≥ 3 such frames | calibrated: corpus p90 1.0, so advisory; reference + 0.1 | Add motion blur (`@remotion/motion-blur`, a speed-scaled directional blur), or slow the move |

Code: plan dimensions in `src/lib/film/plan-check.ts` (`SLOP_PLAN_DIMENSIONS`, kept out of the risk mean), motion:check lists in `src/lib/sensors/slop-signatures.ts`, film:measure readings in `src/lib/film/readings.ts` and `evidence.ts`, lint in `src/lib/verification/lint.ts`.

Calibration ([results](calibration.md), [method](../docs/reference-analysis.md#calibration)): `judge:calibrate` checks each sensor against a reference copy degraded on purpose before its threshold leaves provisional: `motion-spread` and `fast-motion-sharp` against `stutter`, `shot-length-variety` against `uniform-cuts`, `cut-sound-coverage` against `no-sfx`/`soft-transients` and `desync`, the sync readings against `desync`, and linear easing against `linear-motion` (no leg reads eases yet; a candidate reading stands in).

Not here, owned elsewhere: the cut-sound decision, repetition across films, and a film's signature element.

## 3D slop

The defaults a Blender or three.js shot falls into ([blender-3d](../.agents/skills/blender-3d/SKILL.md), kit in `scripts/blender/kit/`). A measurable one names its sensor; the rest are judged by the critic from frames and a motion strip.

| Signature | Sensor | Fix |
|---|---|---|
| Turntable with no idea: the product spins because it is 3D | critic; film:measure `motion-spread` reads whole-frame rotation | Write the shot intent (function, what to notice, beat); move the camera for that reason only |
| Linear or constant-speed motion on a subject | critic (no eases read from video yet) | `kit.curves` intents: `brake` in, `settle` out; anticipation before a jump, follow-through after a stop |
| Floating object: no contact, no contact shadow | `stage.report` floor gap in `craft-report.json` (> 2 mm prints `[craft]`) | `stage.rest_on`; a shadow catcher over the exact ground hex |
| Everything in focus on a small subject | critic | Role lens and f-stop (`detail` 100 mm f/2); `rack` to the reading point |
| Grey screens and washed brand colours under AgX | measurable against the source image (pixel delta of the screen area); critic | `look.screen_material` (inverse view colourspace, emission 1) with `agx-base`, or `standard` for an exact hex |
| Three-point light with nothing chosen, flat key-to-fill | critic | A `light.mood` chosen for the function: its ratio and colour temperatures |
| A camera that drifts for no reason, or a jittery shake | film:measure `motion-spread` | One motivated move per shot; `handheld` in the 0.6–2.5 Hz band, small |
| Character eyes that read as highlights, a character that never performs | critic | Matte eyes proud of the surface, catchlights painted; anticipation, a look, a blink, a settle |
| No motion blur on fast 3D motion | film:measure `fast-motion-sharp` | `look.motion_blur(scene, 0.5)`; on by default in the kit |
| Hero cropped or under the UI in 9:16 or 1:1 | `stage.report` safe excess per format | `camera.vertical_fill`, `frame_offset`; check every delivery format |
| CG-perfect surfaces: no roughness variation, no dust | critic | `stage.surface` imperfection; real material references |
