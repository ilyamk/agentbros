# Workers — Agent Rules

Last updated: 2026-11-18

Native helpers that a TypeScript caller in `src/lib/` spawns with a literal argument array. They are not public CLIs: never run one directly; use the `pnpm` alias that owns it. Blender shot scripts are in [scripts/blender](../blender/AGENTS.md).

## Map

| Worker | Spawned by | Command |
|---|---|---|
| `audio-map.py`, `audio-structure.py` | `src/lib/audio-map/analyse.ts` | `audio:map`, `ref:analyze` |
| `audio-stems.py` | `src/lib/audio-map/stems.ts` | `audio:stems` |
| `reference-analysis.py` (+ `reference-moves.py`) | `src/lib/reference/worker.ts` | `ref:analyze`, `ref:compare`, `film:targets`; film evidence (`film:measure`) |
| `footage-shots.py` | `src/lib/footage/shots.ts` | `footage:shots` |
| `multicam.py` | `src/lib/multicam/worker.ts` | `multicam:sync`, `multicam:angles`, `reframe:track` |
| `speech-local.py` | `src/lib/speech/local.ts` | `speech:local` |
| `sfx-clap.py` | `src/lib/audio/sfx-clap.ts` | `sfx:index`, `sfx:find`, `audio:describe` |
| `sfx-index.py` | `src/lib/audio/sfx-index.ts` | `sfx:index` |
| `local-analysis.py` | copied by `src/lib/local-engines/prepare.ts` | `media:prepare`, then `media:local`, `media:corpus` |
| `frame-ocr.swift`, `frame-visual.swift`, `frame-category.swift` | `src/lib/ingest/local-{ocr,visual,category}.ts` | `media:prepare` (OCR), `media:ocr`, `media:visual`, `media:category` |
| `frame-matte.swift` | `src/lib/matte/vision.ts` | `media:prepare --engines matte`, `matte` |
| `frame-matte-onnx.py` | `src/lib/matte/onnx.ts` | `matte` |
| `html-capture.ts`, `native-media-preparation.ts` | `src/lib/backends/html.ts` | `capture:html` |
| `blender_capture.py` | `src/lib/backends/blender.ts` | `backend` |
| `blender_scene.py` | `src/lib/backends/blender-bake.ts` | `blender:scene` |
| `blender/avc_extensions.py`, `avc_extension_inspect.py` | `src/lib/blender-arsenal/extensions.ts`; isolated install/enable/trial, seeded fracture, captured shake and render dependencies; stdlib ZIP inspection | `blender:ext`, `blender:run --extensions` |
| `blender/avc_recipes.py` | literal META discovery; composable recipes return created objects only | `blender:recipe`, `blender:run` |
| `blender/avc_run.py` (+ `avc_export.py`) | `src/lib/backends/blender-run.ts` | `blender:run` |
| `blender/avc_live.py` (+ `avc_live_ops.py`, `avc_live_protocol.py`, `avc_live_arsenal.py`) | `src/lib/backends/blender-live.ts` | `blender:live` |
| `blender/avc_live_replay.py` | a scene script for `blender:run`; rebuilds a `blender:live` recipe with the same ops | `blender:run` |

`footage-shots.py` and `reference-moves.py` import `reference-analysis.py`; `audio-structure.py` imports `audio-map.py`.

## Rules

- Host workers use `src/lib/python.ts`: Python 3.13.18 from `.python-version` (offset alone: 3.12.16), dependencies in root `pyproject.toml`/`uv.lock`, separate `.cache/python/<profile>` environments and locked `uv run`. The prepared `local-analysis.py`, Earshot and Blender retain their explicit runners. Historical `*_UVX` test overrides now require uv-compatible executables. See [Python runtime](../../docs/python-runtime.md).
- A uv worker takes its request from argv or a request file and prints one JSON object on stdout. The caller validates it and owns the CLI envelope.
- Model weights stay outside git: `~/.cache/agentbros` (speech: `SPEECH_LOCAL_CACHE`; multicam: `AGENTBROS_MODEL_CACHE`; BiRefNet in `matte/`, fetched by `assets:sync` to a `$MODELS/` target), the Hugging Face cache (CLAP), `.cache/audio-stems` (Demucs splits). Pin model revisions.
- Swift sources are compiled only by explicit preparation (`swiftc`); production runs the prebuilt executable and checks its hash. `frame-matte.swift` runs in a no-network `sandbox-exec` profile.
- Blender: 4.2 to 5.x, found by `src/lib/backends/probe.ts`; `blender:scene` needs 4.5.14. `avc_live_protocol.py` imports no bpy, so its tests run it with the pinned host Python.
- Python style: root `pyproject.toml` (`ALL`); embedded Blender configs target py311, host workers py313.
- Licence (2026-11-17): Python that runs inside Blender (`blender/**`, `blender_capture.py`, `blender_scene.py`, any file importing `bpy`) and tests that import it are GPL-3.0-or-later ([LICENSES/GPL-3.0-or-later.txt](../../LICENSES/GPL-3.0-or-later.txt)) and start with `# SPDX-License-Identifier: GPL-3.0-or-later`; every other worker is under the repository's Business Source License 1.1.

## Change checklist

- Changing a worker's output: update the caller's Zod parse and that domain's tests.
- Run the caller's suite: `tests/audio-map.test.ts`, `tests/reference-measurements.test.ts`, `tests/footage-shots.test.ts`, `tests/multicam-sync.test.ts`, `tests/speech-local.test.ts`, `tests/sfx-index.test.ts`, `tests/local-inference.test.ts`, `tests/local-ocr.test.ts`, `tests/html-frame-adapter.test.ts`, `tests/blender-run.test.ts`, `tests/blender-scene.test.ts`, `tests/matte.test.ts`, `tests/matte-engines.test.ts`, `tests/blender-live.test.ts` (`RUN_MATTE_TESTS=1`). `test:fast` skips `audio-map`, `local-ocr`, `blender-run`; model, Blender and capture cases need `RUN_SHOTS_MODEL_TESTS`, `RUN_BLENDER_TESTS` or `pnpm test:integrations`.
- `pnpm python:check` for Python; `--mode profiles --profile <group>` checks installed dependency APIs; `--mode native` requires Blender.
- `tests/helpers/*-pins.json` pin worker hashes as historical evidence; do not regenerate them.

## See also

[src/lib](../../src/lib/AGENTS.md), [scripts](../AGENTS.md), [optional backends](../../docs/optional-backends.md). The repo-root `workers/` folder is the separate [Resolve worker](../../docs/resolve-worker.md).

`blender/avc_assets.py`: session-only library registration, local model/material/HDRI/node-group and bundled Essentials append; usage log for credits. `blender/avc_asset_unpack.py`: inert ZIP extraction after full member validation, called by `blender:assets`. Test: `tests/blender-assets.test.ts`, pure helpers: `uv run --locked python tests/blender-assets-helpers.test.py`; real Blender gated by `RUN_BLENDER_TESTS=1`.

`blender/avc_asset_probe.py`: isolated offline native asset names/types/catalogue probe for `blender:assets`, including the bundled node/matcap/world inventory. Bundled files are referenced in place; no preferences are saved.

`avc_live_arsenal.py`: typed local append, validated recipe application, approved installed extension enable and read-only inventory. Journals pin receipt/payload hashes, resolved recipe params/code and extension versions; replay rejects drift. Live start isolates every profile, and `--extensions` selects the installed arsenal profile. Tests: `tests/blender-live-arsenal.test.ts` (fixture-only; native cases need `RUN_BLENDER_TESTS=1`).
`blender/avc_eval_plan.py` parses proposed scene Python without execution: reachable calls, imports, dependency literals, task setups, actual lens/light/material parameters and physics bake evidence. Caller: `src/lib/blender-arsenal/eval-executable.ts`; tests: `tests/blender-arsenal-executable.test.ts`.
CPU Blender runs pin Cycles, denoising and compositing to CPU and disable output dithering. Blender 5.3 defaults compositing to GPU; unseeded display dithering caused one-level frame-order drift in the recipe proof.

`apple/{Support,Text,Translation,TTS,Speech,Audio,Vision,Foundation}.swift`: independent domain workers compiled with the shared Support source by `media:prepare --engines apple-<domain>`. Probe never prompts/downloads; only authorised preparation permits network. Task inference runs under deny-network, with versioned bounded JSON and hash-pinned binaries. Tests: [capabilities](../../tests/local-capabilities.test.ts), gated [native tasks](../../tests/apple-actual.test.ts).

FX replay: recipe source identity includes procedural materials. `molecule` is refused in live operations until external PDB/CIF payloads can be pinned; use `blender:recipe` for attributed offline renders.

Vork (2026-11-16): `vork-simulation.py` authors bounded SDK fluid/cloth scenes; final cloth preserves UVs for filtered weave/fuzz shading within the 1024-vertex patch limit. Fluid surface resolution is independent of the solver grid and controls distance-band reconstruction capacity. `vork-track.py` estimates explicitly calibrated rigid-plane cameras with pinned OpenCV/SciPy through `vork:vfx`. `blender/avc_vork_bridge.py` is a separately GPL-labelled file-exchange worker run only through `blender:run`; no automatic scripts or user-profile modification. `blender/avc_vork_outputs.py` retains masks/linear passes; `blender/avc_vork_vfx.py` builds the explicit Cycles receiver/linear composite, EXR and subject masks through `vork:vfx --action render`.

`earshot.py` runs only in its explicitly prepared pinned Python 3.13.18 environment (`audio/earshot-runtime.ts`). Allowed bank/list/render/check/find operations; no external bank or recipe code. Provider keys/environment overrides are stripped. Requirements are locked in the root `pyproject.toml` earshot group and `uv.lock`; semantic weights have their own safetensors pin.
