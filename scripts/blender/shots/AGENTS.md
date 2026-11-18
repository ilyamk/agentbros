# Blender shot templates

Last updated: 2026-11-15

Run only through `blender:run` with isolated profiles. These are reusable scene scripts, not public CLIs. Follow [Blender rules](../AGENTS.md). `product_in_nature.py` composes nature recipes and acquired CC0 scans; its docstring lists the JSON controls. Render, open and critique low-resolution key frames before a sequence. Evidence and presets belong in `out/` or a project, never tracked media.

Directed scene templates composed from the kit and arsenal recipes. Run only through `pnpm blender:run`; isolated profiles and frame-driven animation follow [the Blender rules](../AGENTS.md).

`city_flyover.py`: dusk drone arc over `procedural-city`, office lights switching on, then the central landmark's rooftop wordmark. JSON keys: `seed` (31), `frames` (96), `variant` (`a` or `b`), `logo` (`AVC`), `blocks` (5). `a` is the wider first look; `b` is the revised closer hero composition. Writes a city-shot JSON receipt with geometry/cache/camera evidence. Local outputs: `out/qa/realism/city-tournament/`; media is never tracked.

City recipe contracts and cache paths: [recipes](../recipes/AGENTS.md). Real render and exact CPU determinism: `RUN_BLENDER_TESTS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-city.test.ts`.

`product_splash.py` is an original parametric citrus can, cached Mantaflow crown and frame-pure freeze ramp. Run with `blender:run`; proof settings: resolution 32, mesh_scale 1, simulation_frames 24, 480×270, 8 samples. Use 64/2 for look development, 128–192 for an approved final. Variants `a` and `b` change lighting only and reuse the same bake. Supports product-ad and bespoke film hook/material steps. The current visual verdict and tournament paths are in `docs/blender-arsenal/fx-realism.md`; experimental means no production-quality claim.
