# Local Vork acceptance examples

Run from the repository root with a prepared Vork 0.5.1 runtime, Blender 5.3.0, FFmpeg and uv. All output paths below are fresh, git-ignored revisions. Keep native GPU jobs sequential on this host. No provider or cloud API is used. Receipts establish technical completion; inspect motion and picture separately.

## Product, geometry and 100k instances

```bash
pnpm vork:recipe --action render --id product-stage --output out/vork-trial/product --resolution 1920x1080 --samples 16 --encode h264 --purpose production
pnpm vork:recipe --action build --id procedural-vessel --output out/vork-trial/geometry-source
pnpm vork:bridge --action to-blender --input out/vork-trial/geometry-source/scene.json --output out/vork-trial/returned --frames 90
pnpm blender:run --blend out/vork-trial/returned/scene.blend --output out/vork-trial/geometry-final --frames 1-90 --engine eevee --samples 16 --resolution 1920x1080 --encode h264
pnpm vork:recipe --action render --id gpu-swarm --params '{"count":100000,"duration":4}' --output out/vork-trial/swarm --resolution 1920x1080 --samples 4 --profile std/draft --encode h264 --purpose production
```

## Blender source plus authored surface effect

```bash
pnpm blender:run --script examples/vork/blender-source.py --output out/vork-trial/blender-setup --no-render --script-args '["{\"blend\":\"out/vork-trial/source.blend\"}"]'
pnpm vork:bridge --action from-blender --input out/vork-trial/source.blend --output out/vork-trial/export
pnpm exec tsx examples/vork/reveal-export.ts --input out/vork-trial/export --output out/vork-trial/effect-source
pnpm vork:render --task out/vork-trial/effect-source/task.json --output out/vork-trial/effect-final --resolution 1920x1080 --samples 8 --encode h264 --purpose production
pnpm blender:run --blend out/vork-trial/source.blend --output out/vork-trial/baseline --frames 1-120 --engine eevee --samples 16 --resolution 1920x1080 --encode h264
pnpm vork:eval --action pack --baseline out/vork-trial/baseline/render.mp4 --candidate out/vork-trial/effect-final/render.mp4 --reference 'A sculptural object on a studio floor; the progressive surface-light reveal must remain readable and motivated' --output out/vork-trial/blind
```

This is a capability comparison with an added authored effect, not a controlled transport-performance benchmark. Both movies must have matching shape and duration before packet creation. Keep `key.json` away from critics.

## Footage and advanced probes

The original deterministic `calibrated-fixture.py` exercises the planar solver against known camera displacement through `RUN_VORK_VFX_TESTS=1 pnpm exec tsx --test tests/vork-vfx.test.ts`. For photographed footage, retain the original, rights evidence and the derived plate; create a strict `VorkVfxSchema` request. `vork:vfx prepare` records PTS, `solve` retains held-out overlays, and `build` accepts that camera plus optional existing local foreground matte/proxy. Four corners must represent a calibrated rectangle, or an explicit initial pose must define their ray-plane intersections. General handheld camera solves are outside this worker's scope.

```bash
pnpm vork:vfx --action solve --request REQUEST.json --output out/vork-trial/solve
# Add camera: "solve/camera.json" to a new request revision, relative to that request.
pnpm vork:vfx --action build --request CAMERA-REQUEST.json --output out/vork-trial/insert-source
pnpm vork:render --task out/vork-trial/insert-source/task.json --output out/vork-trial/insert-preview --frames 0-2 --resolution 640x360 --samples 4
pnpm vork:eval --action run --output out/vork-trial/probes
pnpm vork:recipe --action build --id program-hooks --output out/vork-trial/hooks
pnpm vork:render --task out/vork-trial/hooks/task.json --output out/vork-trial/hooks-controls --frames 0-2 --resolution 320x180 --samples 4 --channels all
pnpm vork:render --task out/vork-trial/hooks/task.json --output out/vork-trial/hooks-exr --frames 0-0 --resolution 320x180 --samples 4 --channels all --format exr
```

Compare the retained qualification evidence, including unsuccessful GPU trials and the limits of each result. Do not turn an isolated frame or numeric residual into a creative approval.
