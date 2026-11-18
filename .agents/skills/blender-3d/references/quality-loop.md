# Quality loop for a Blender shot

Agents cannot watch a video; they read stills, contact sheets and motion strips. The loop is built on that.

## 1. Stills before sequences

Render three frames at half size and 8–16 samples: the entrance's key pose, the busiest frame, the last frame. A [live session](live-session.md) is the fastest way to iterate here: `run-kit` the shot, `still`, look, `set`, `still` again.

```bash
pnpm blender:run --script scripts/blender/plush_character.py --output out/qa/ID/look --frames 40-40 --samples 16 --resolution 960x540
```

Open each image with your image tool. Name what is wrong in concrete terms ("the paper reads beige", "the eyes look like highlights", "the dome's film is invisible against the sky") and change one group of settings: light, material, camera or timing. `craft-report.json` beside the frames lists every role outside the safe frame of vertical, square and landscape, and any contact object off the floor.

## 2. Motion proof

When the stills are good, render the whole shot small, with motion blur on, and strip it:

```bash
pnpm blender:run --script scripts/blender/plush_character.py --output out/qa/ID/proof --frames 1-105 --samples 16 --resolution 640x360 --encode h264
pnpm motion:strip --input out/qa/ID/proof/preview.mp4 --output out/qa/ID/proof/strip.png --step 4 --columns 7 --width 300
```

Read the strip for the shot's structure: is there an anticipation before the main action, an overshoot, a settle, and do the last frames hold? Is the camera's move visible and slower than the subject's? Does the hero stay in frame? For an exact peak, strip a narrow window (`--start-frame`, `--end-frame`, `--step 1`).

## 3. Measurements

- `pnpm film:measure --render out/qa/ID/proof/preview.mp4 --output out/qa/ID/proof/measure.json`: on a silent plate the target and audio legs fail by design; read `frozen-spans`, `motion-spread` and `fast-motion-sharp`.
- `motion:check` reads a Remotion composition, not a video: run it on the block that plays the plate, once the plate is in.
- Determinism: a frame rendered alone equals the same frame inside a range on CPU (compare pixels, not PNG bytes); `RUN_BLENDER_TESTS=1` checks the twins.

## 4. Blind comparison

When a shot replaces an earlier version, or two directions compete, give a critic both renders blind, in `shot:tournament`'s packet shape: the same size and codec for each, labels assigned from a seed (`assignLabels`, `tournamentSeed` in `src/lib/film/tournament.ts`), a packet per order of each pair (`AB` and `BA`), a strip beside each clip, and the label key kept outside the packet folder. The critic answers `{pairId, order, winner, reason}`; a win counts only when it holds in both orders. Report honestly where the new version does not win.

## 5. Production

Time one full-size frame at production samples, multiply by the frame count and fit the budget (the plate table in [scripts/blender](../../../../scripts/blender/AGENTS.md)). Render the final through the plate recipe, then read its contact sheet and strip once more. Samples remove noise, not bad direction.

## First blind check (2026-11-15)

The six redirected scenes against their first proofs, one fresh creative-critic per scene and order: the new version won 12 of 12 judgements, agreeing in both orders on every scene. What the critics still flagged, the next pass for each:

- glossy-orb: the eyes read as specular streaks at small size.
- plush-character: no contact shadow during the hop's hang time; flat light.
- glass-dome: hazy, low contrast.
- printing-slip: no ground or contact surface.
- device-array: phones look nearly floating at the end; overlap during the drop.
