# Blender shots — Agent Rules

Last updated: 2026-11-18

Studio kit and shot templates for photoreal device shots, played in a film by the library block `blender-plate`, and a toy kit whose shots are the high-quality twins of six browser blocks. When a shot needs Blender at all: the `engine-selection` and `blender-3d` skills and [photoreal 3D](../../docs/photoreal-3d.md).

## Start here

```bash
pnpm blender:run --script scripts/blender/hero_turntable.py --output out/<id>/hero --frames 1-60 \
  --samples 24 --resolution 1920x1080 --film-transparent \
  --script-args '["public/projects/<id>/assets/blender/hero.json"]'
pnpm blender:run --script scripts/blender/hero_turntable.py --output out/qa/hero --dry-run
```

## Map

| File | Role |
|---|---|
| `viz_scene.py`, `viz_math.py` | Trusted prepared visualisation adapter: shared frame states, orthographic projection, PBR maps and depth-tested routes; invoked by `viz:preview` / `viz:render` (no arbitrary Python over MCP). |
| `shots/` | `product_in_nature.py`: experimental ceramic-product clearing, scan pedestal, sun/haze and lens/palette controls; [contract](shots/AGENTS.md), [evaluation](../../docs/blender-arsenal/nature.md); `city_flyover.py`: experimental dusk drone arc over `procedural-city` |

| `recipes/` | Built-in VFX and scene elements; `pnpm blender:recipe` lists, renders, bakes and measures proofs ([contract](recipes/AGENTS.md)) |
| `materials/`, `shots/` | Thirteen procedural surfaces, two-mood shader-ball proofs and a cached Mantaflow citrus-can flagship; product-ad/bespoke film material steps |
| `studio_kit.py` | Shared stage: devices, HDRIs, light rigs, ground, camera, the `COMMON` keys every shot accepts |
| `hero_turntable.py`, `screen_swap.py`, `exploded_view.py`, `macro_sweep.py`, `multi_device.py` | Shot templates, each with its own keys documented in its docstring |
| `toy_kit.py` | Shared pieces of the stylised shots: `COMMON` (`frames`, `fps`, `seed`, `lens`, `fstop`, `width`, `height`), GSAP eases, `per_frame` keys, flat ground, sky, felt `fabric`, the original `plush` character |
| `kit/` | The craft layer: `curves` (intent curves equal to `timing.ts`, anticipation, follow-through, squash and stretch, hops, blinks, seeded noise, handheld, safe frames; pure Python), `anim` (F-curve keys with handles, `Timeline`), `camera` (`Rig` with role defaults and moves), `light` and `presets` (moods), `look` (views, grade node group, screen colour), `stage` (sets, staging, `craft-report.json`), `character` (plush rig), `passes` (`refs:derive` blender-pass: depth, normal, mist, clay, beauty, camera path; runs with `--blend --no-render`). Vocabulary: [directing](../../.agents/skills/blender-3d/references/directing.md) |
| `glossy_orb.py`, `plush_character.py`, `glass_dome.py`, `printing_slip.py`, `card_fan.py`, `device_array.py` | Twins of `shaded-orb` (glossy), the muse plush and dome (`blender-plate`), `printing-slip`, `depth-card-flythrough` fan, `studio-product-stage` array; keys in each docstring |
| `prepare_devices.py` | Normalises downloaded GLBs into `public/shared/3d/{phone,laptop,tablet}.glb`; run with `--no-render`. `pnpm assets:sync` rebuilds those GLBs from it |

## Rules

- Run a shot only through `blender:run` (`scripts/blender-run.ts`), or `blender:live --action run-kit` to find a look ([live session](../../.agents/skills/blender-3d/references/live-session.md)); never Blender directly. The runner finds Blender 4.2 to 5.x, puts `scripts/workers/blender/` on `sys.path` (so `import avc_export` works), applies the CLI's frames, samples, resolution and transparency, verifies frames and makes a contact sheet. It runs arbitrary Python, so it is not exposed over MCP.
- `blender:run --extensions <id,id|approved>` loads approved installed pins from the isolated arsenal profile, keeps factory startup and records enabled versions. `avc_extensions.require` checks versions; `seeded`/`fracture_object` seed both RNGs; `camera_shake` records a render dependency. All runs isolate user/system extension paths; extension runs enable RNA before opening a blend; saved shake scenes need the same pin enabled. Authoring-only pins need `--no-render`. See [extensions](../../docs/blender-arsenal/README.md).
- The first script argument is a JSON object or a path to a `.json` file. Unknown keys are an error, so a typo never falls back silently. Keep a project's shot JSON in `public/projects/<id>/assets/blender/`, not here.
- Scene convention: metres, Z up, the device's screen faces -Y, the camera looks along +Y. Device GLBs carry real size and a display object named `screen` with 0..1 UVs.
- Media stays out of git: HDRIs and GLBs come from `pnpm assets:sync` (sources and licences in `public/shared/3d/sources.json`); renders go to `out/`.
- Licence (2026-11-17): every Python file here, and every module of `scripts/workers/blender/` it loads, runs inside Blender and is GPL-3.0-or-later ([LICENSES/GPL-3.0-or-later.txt](../../LICENSES/GPL-3.0-or-later.txt)), unlike the rest of the repository (Business Source License 1.1). Each starts with `# SPDX-License-Identifier: GPL-3.0-or-later`; a new file keeps that header.
- A shot script runs repeatedly in one Blender process (`blender:live --action run-kit`): a JSON object argument, no `sys.exit`, only handlers it registers itself, files written through `avc_export.output_path`.
- Deterministic: every animated value is a pure function of the frame (`kit.anim.Timeline` or `toy_kit.per_frame` keys each frame; `printing_slip.py` places vertices in a `frame_change_pre` handler from the frame alone), seeds are fixed; physics recipes render verified baked snapshots, never a live solver. CPU runs disable output dithering; a frame alone matches it in a range pixel for pixel; on Metal sparse pixels can differ by two levels (recipe proof tolerance: max ≤2 and PSNR ≥80 dB), and PNG bytes differ by metadata, so compare pixels, not file hashes.
- A twin keeps its block's timing keys and defaults, so the block's cues land on the plate (`tests/blender-plates.test.ts`); what it adds (performance, camera, a longer shot) is stated in its docstring. Defaults never name a plate.
- A twin is a directed shot: its docstring opens with the shot intent, and its motion, camera, light and look come from `kit/`.

## Twins: proofs and production

Proof (look and motion): `--samples 16 --resolution 640x360 --encode h264`, Cycles with OIDN on Metal (M1 Max, shared machine; the proof times below were taken under a load average above 100, so they are upper bounds). Production is the recipe in `public/shared/3d/plates/sources.json`: 1920x1080, `--encode h264`, rendered by `pnpm assets:sync --id plates:<name>`: frames stay in `.cache/assets/plates/<name>/` and `--encode-to` copies only the video to `public/shared/3d/plates/<name>.mp4` (git-ignored), so bundles skip the PNGs. Play it with the block's `plate` prop, `{ src: "shared/3d/plates/<name>.mp4", frameCount }`.

| Plate | Frames | Proof | Production samples | Production, one frame (launch included) |
|---|---|---|---|---|
| `glossy-orb` | 96 | 122 s | 64 | 13 s |
| `plush-character` | 105 | 216 s | 96 | 19 s |
| `glass-dome` | 105 | 457 s | 128 | 24 s |
| `glass-dome-overhead` (`view: "overhead"`) | 36 | 64 s | 128 | 28 s |
| `printing-slip` | 84 | 392 s | 64 | 9 s |
| `card-fan` | 90 | 377 s | 96 | 15 s |
| `device-array` (needs `3d:phone`) | 90 | 301 s | 64 | 18 s |

The one-frame production times predate the craft redo, which turns motion blur on; re-time one frame before a production run.

Budget a production plate as frames times the one-frame time: 6 to 25 minutes each. Look at one full-size frame before the sequence.

2026-11-18: kit and native-boundary annotations match ty 0.0.105; embedded Blender syntax remains Python 3.11.

## Change checklist

- A new `COMMON` key or device: update `studio_kit.py`, the shot docstrings and [photoreal 3D](../../docs/photoreal-3d.md).
- A new device: add a `DEVICES` entry in `prepare_devices.py` and its source in `public/shared/3d/sources.json`, then `pnpm exec tsx --test tests/shared-assets.test.ts`.
- Kit changes: `pnpm python:check` (including Python 3.11 syntax); native regressions: `pnpm python:check --mode native`. `uv run --locked python tests/blender-kit-maths.test.py` and `pnpm exec tsx --test tests/blender-kit.test.ts` (curves against `timing.ts`); `RUN_BLENDER_TESTS=1 pnpm exec tsx --test tests/blender-craft.test.ts` renders a frame of every twin and checks determinism.
- Runner changes: `pnpm exec tsx --test tests/blender-run.test.ts` (a real Blender case runs with `RUN_BLENDER_TESTS=1`).
- A twin's timing key or a block's timing default: change both, then `pnpm exec tsx --test tests/blender-plates.test.ts`; a new plate gets a recipe in `public/shared/3d/plates/sources.json`.

## See also

[Workers](../workers/AGENTS.md) (the runner `blender/avc_run.py`), [optional backends](../../docs/optional-backends.md), [scripts](../AGENTS.md).

The runner creates only named profile directories, preserving PATH and scalar environment values. Explicit recipe profiles win when no extensions are selected; approved extensions use their managed profile. Regression: `tests/blender-ext.test.ts`, `tests/blender-recipes.test.ts`.

System weaknesses follow `pnpm blender:improve`: fresh blind critiques, advisor diagnosis, one change, both-order A/B plus sensors/tests, tracked log and local memory gap. See [self-improvement](../../.agents/skills/blender-3d/references/self-improvement.md).
