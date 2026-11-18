# Matte: free local cut-outs

`pnpm matte` cuts a subject or a person out of an image, a video or a folder of frames, on this machine, at no cost. Its output is the same as the paid `pnpm rmbg`: an RGBA PNG at the source's pixel size, subject opaque and everything else transparent. Anything that takes an rmbg cut-out, such as `paper-collage-assemble` `src`, `grade-step-flash` `matteSrc` or `parallax-rig` layers, takes this one too. Use `rmbg` only when the user approves paying for it, for example after `matte` has failed on a hard picture.

```bash
pnpm matte --probe                                            # which engines can run here, and what auto picks
pnpm matte --input photo.jpg --out public/projects/<id>/matte # <stem>.png (RGBA), <stem>.alpha.png, <stem>.matte.json
pnpm matte --input photo.jpg --output cutout.png              # rmbg drop-in: the cut-out exactly where --output says
pnpm matte --input clip.mp4 --out <dir> --kind person --start-frame 120 --end-frame 240 --prores
pnpm matte --input frames/ --out <dir> --refine               # a folder of frames, sorted by name
```

Frames give `cutout/frame-%05d.png` (RGBA) and `alpha/frame-%05d.png` (grey, 255 = subject), numbered by **source** frame. They also give `matte.json` and, with `--prores`, `cutout.mov` (ProRes 4444 with alpha, `yuva444p12le` from this ffmpeg). The `.mov` is for editors outside the harness. Inside Remotion, use the PNG frames. `--max-frames` (600) guards long ranges, and an output that exists needs `--force`. All flags: `pnpm matte --help`.

## Engines

| Engine | Where | Model | Kinds | Set up |
|---|---|---|---|---|
| `vision` | macOS | Apple Vision `VNGenerateForegroundInstanceMaskRequest` (subject, macOS 14+); `VNGeneratePersonSegmentationRequest` (person, macOS 12+, `--quality fast/balanced/accurate`) | subject, person | `pnpm media:prepare --engines matte` compiles `scripts/workers/frame-matte.swift` into `~/.cache/agentbros/local-engines/matte/`. Every run checks the executable's hash and runs it in a no-network sandbox |
| `onnx` | macOS, Linux, Windows | BiRefNet general lite (Swin-v1-tiny, 1024x1024, fp32, MIT), the author's own ONNX export | subject (person uses the same model) | `pnpm assets:sync --id models:birefnet-general-lite` downloads 224 MB into `~/.cache/agentbros/matte/`, sha256-pinned (`src/lib/matte/models.json`). Needs `uv`; the first run fetches onnxruntime 1.22.1, numpy and Pillow through `uvx` |

`--engine auto` (the default) picks `vision` on macOS when the worker is prepared and the OS serves the kind; otherwise it picks `onnx` and writes the reason into `matte.json` `fallback`. An explicit `--engine` that cannot run is an error naming its fix, never a silent switch. `pnpm preflight` prints a "Cut-out engines" line with both states and what `auto` picks. `assets:sync --all` leaves the weights alone unless you add `--include-slow`.

Why each choice:

- **Python worker, not onnxruntime-node.** It keeps a native npm dependency of about 100 MB per platform out of every install. It also uses the same pinned-`uvx` route as the other model workers (`scripts/workers/AGENTS.md`), and onnxruntime has CPU wheels for all three systems.
- **BiRefNet lite.**
  - It is the smallest official general BiRefNet: 224 MB. The full Swin-L models are 900 MB or more, and the 2K lite is 331 MB with a larger input.
  - It is the family the paid `rmbg` calls on fal, so the two routes look alike.
  - The ONNX export is the author's own, with the MIT licence on the repository.
  - It runs on the CPU provider only, so the same frame gives the same matte on every OS. CoreML would be faster on a Mac, but Vision already covers the Mac.
- **Vision on the Neural Engine first.** When the ANE has no free slots (another process holds them), the worker reruns that frame on the CPU and the receipt warns how many frames that happened to.

## Video: temporal stability

The engines matte each frame alone, so edges shimmer. For frames, `--temporal ema` (the default) smooths the alpha over time, but only where the picture is still:

- Each source frame is averaged over 8 px cells (at a 1080 short side), so grain cancels. The change from the previous frame is max-pooled over neighbouring cells.
- The history weight is `strength` (0.6) on a still cell and falls linearly to 0 at a mean change of 0.04 (about 10/255). Moving edges therefore take the raw matte, with no ghost trail; only edges over a still picture are averaged.
- `--refine` adds a guided filter (He et al. 2010, radius 4 px at 1080, eps 1e-3). It works only in the band where the local alpha is neither solid nor empty, so the edge follows the picture's own edges.

`matte.json` `temporal` measures this on every run:

- `flickerBefore` / `flickerAfter`: the mean |alpha_t - alpha_t-1| (0..255) over pixels whose source picture is stable, over all of them (`stable`) and over edge pixels (`stableEdge`, alpha strictly between 5 and 250).
- `movingDelta`: the mean |smoothed - raw| where the picture moves, the lag the smoothing costs. It stays near zero by design; a large value means ghosting.

The maths is pure TypeScript in `src/lib/matte/temporal.ts`, unit-tested in `tests/matte.test.ts`.

## Quality evaluation (2026-11-15)

Test set, made for this:

- **bust**: a Blender EEVEE render of a subdivided head on a plinth in a room. It has wall boxes as clutter and a fan of seven 12 mm wires as fine detail. Our own scene, so the licence is clean.
- **bust clip**: the same scene turning ±29° over 36 frames at 1080x1080, with ffmpeg grain (`noise=alls=5:allf=t`) and H.264, so a real codec and real noise reach the engines.
- **Ground truth**: the same scene re-rendered with the room as a holdout on a transparent film, giving the exact subject alpha.
- **Person**: two frames and a 30-frame span (0.5 s at 60 fps) of a talking-head shot from one git-ignored reference film, used only locally. No frame from it is in the repository.

Machine: macOS 27.2.1, Apple Silicon (10 cores). The machine was shared with other agents throughout (load average 28 to 33), so every time below is slower than the engine's own speed. `matte.json` records the load of each run.

### Against ground truth (bust)

| | IoU at 0.5 | MAE (0..255) | Edge-band MAE | False positive / negative share |
|---|---|---|---|---|
| Vision subject, still | 0.904 | 2.27 | 48.7 | 0.07% / 0.74% |
| ONNX, still | 0.890 | 2.60 | 13.9 | 0.98% / 0.05% |
| Vision, clip (36 frames) | 0.904 | 2.26 | 49.4 | 0.09% / 0.72% |
| ONNX, clip (36 frames) | 0.933 | 1.54 | 15.5 | 0.49% / 0.10% |
| Vision, clip, `--refine` | 0.909 | 2.37 | 51.6 | 0.03% / 0.73% |
| Vision, still, body only (no wires) | 0.989 | 0.75 | 21.1 | |
| ONNX, still, body only (no wires) | 0.912 | 3.13 | 7.8 | |

The edge band is ±6 px around the true edge. Read side by side on a checker (contact sheet `out/qa/matte/edges-bust.jpg`, regenerated locally, not committed):

- **Vision** gives a clean, slightly soft silhouette of the main object. It **drops detached fine detail** (the wire fan is missing entirely) and keeps no background clutter.
- **ONNX** keeps **every wire** with crisp, thin edges (edge MAE 3 to 6 times lower). It also **pulls in background objects** near the subject: one wall box under the wires and part of another.
- Choose by the picture. One clean subject on clutter: `vision`. Fine structure (hair, wires, plants) on a plain ground: `onnx`. A person on a plain ground, where seconds per frame are affordable: `onnx` gave the cleanest and steadiest edge in our test (below).

### Person

No ground truth exists for the film, so the engines are compared with each other and read on a checker (contact sheets regenerated locally, not committed). Both frames are 1280x720 on a plain white studio ground: **desk**, a man seated at a desk, still; **thumb**, a man seated with a motion-blurred hand and forearm giving a thumbs-up in the near foreground.

| Frame | Agreement IoU at 0.5: person–subject / person–ONNX / subject–ONNX | Soft pixels (alpha 5 to 250): Vision person / Vision subject / ONNX |
|---|---|---|
| desk | 0.986 / 0.979 / 0.989 | 0.82% / 1.28% / 0.86% |
| thumb | 0.989 / 0.985 / 0.988 | 4.96% / 2.19% / 1.64% |

All three find the same people; the difference is the edge:

- **Vision person** (`accurate`) keeps the foreground hand, but turns the **motion-blurred forearm semi-transparent**, which is where its higher soft share comes from. The hair edge is clean.
- **Vision subject** keeps the hand and forearm solid, but its edges are **stair-stepped** where the mask is scaled up from a lower resolution (the thumb), with a light halo on the hair.
- **ONNX** gives the tightest edges on hair and thumb and keeps the forearm solid.

### Time per frame

| Engine | Mean | Max | Start (load) |
|---|---|---|---|
| Vision subject, 1080x1080 | 89 ms | 286 ms | about 0.2 s |
| Vision person `accurate`, 1280x720, 30-frame clip | 109 ms | 315 ms | |
| ONNX CPU, 8 threads, 1280x720, 30-frame clip | 8.2 s | 15.8 s | 1.2 s |
| ONNX CPU, 8 threads, 1080x1080 | 9.4 s | 27.0 s | 1.2 to 5.4 s |

The bust rows were measured at load average 28 to 33, the person rows at 129 to 167 (single stills: Vision 0.22 to 0.44 s, ONNX 7.3 to 7.9 s). On an idle machine an ONNX frame should take a few seconds; we did not measure an idle run. Measured with `--threads 0`, onnxruntime's default, a 1024 frame took 21 to 28 s at the same load. Budget the ONNX route at seconds per frame, so a 10 s clip at 30 fps takes minutes: matte the range you need (`--start-frame`, `--end-frame`).

### Flicker (stable pixels, 0..255)

| Clip | Engine | Edge before | Edge after `ema` | All stable before / after | Moving delta |
|---|---|---|---|---|---|
| bust, 36 frames, grain | Vision | 2.40 | 1.71 (-29%) | 0.012 / 0.009 | 0.34 |
| bust, 36 frames, grain | ONNX | 14.20 | 11.03 (-22%) | 0.078 / 0.055 | 0.88 |
| bust, 36 frames, grain | Vision `ema` + `--refine` | 2.40 | 2.31 | 0.012 / 0.023 | 2.49 |
| person, 30 frames (0.5 s at 60 fps), H.264 | Vision person `accurate` | 11.75 | 7.10 (-40%) | 0.501 / 0.321 | 1.89 |
| person, 30 frames (0.5 s at 60 fps), H.264 | ONNX | 0.99 | 0.82 (-18%) | 0.013 / 0.011 | 1.24 |

- The ranking flips between the two clips. On the grainy bust, ONNX's softer edge probabilities flicker about six times more than Vision's. On the real person, Vision's person mask flickers about twelve times more than ONNX: its semi-transparent, motion-blurred forearm changes from frame to frame (coverage 22.4% to 24.4% against ONNX's 24.1% to 24.2%).
- The EMA removes a fifth to two fifths of the flicker at a moving cost under 2/255.
- `--refine` follows the picture's own edges, grain included. It sharpens a soft edge on a still, but on a grainy clip it brings back flicker. Leave it off for video unless the edge is visibly soft.

## Limits

- **Platforms tested**: macOS 27.2.1 on Apple Silicon only, for both engines. The ONNX route is cross-platform by construction (onnxruntime CPU wheels, Pillow, numpy through `uvx`; no macOS calls), but it has **not been run on Linux or Windows**. Vision is macOS only.
- **Orientation**: every engine reads the frame as ffmpeg decodes it. EXIF rotation on a phone JPEG is not applied, so rotate the photo first if it shows sideways.
- **Kinds**: ONNX has no person-specific model. `--kind person` there segments the salient subject and the receipt warns. A person holding an object, or two people, may come out differently from Vision's person mask.
- **Empty frames**: when an engine finds nothing, that frame's cut-out is fully transparent. The receipt lists them in `coverage.emptyFrames`, and the receipt warns.
- **Hard cases** for both engines: fine hair against a busy ground, glass, smoke, motion blur. ONNX adds background objects next to the subject; Vision drops thin or detached parts.
- **Video**: the EMA cannot fix an engine that changes its mind (an object counted as subject on one frame and not the next). Check `coverage.min`/`max` and the stills at the widest gesture.
- Frames are held in memory one at a time, but extraction writes every source frame of the range to a work folder first. A 4K range of hundreds of frames needs several GB of free disk while it runs.

## In the library

- `grade-step-flash` `matte` step: `pnpm matte --input <plate> --out <dir>`, then `gojiberryXrayFromCutout("<dir>/<stem>.png")` (inside `public/`). The plate shows as a cyan negative on dark for 4 frames. Checked end to end on the bust still (`out/qa/matte/xray-sheet.jpg`).
- `subject-occlusion`: a title between the plate and its subject. Give it the clip and `cutout/frame-%05d.png`, plus `matteStart`, `matteFrames` and `sourceFps` from `matte.json` `input`. The subject layer is the plate masked by the matte, not the cut-out drawn on top, so colour matches by construction. Checked on the bust clip in square and vertical (cover-cropped).

The local checks above ran through a scratch entry, `out/qa/matte/entry.tsx` (git-ignored), with `pnpm motion:still --entry out/qa/matte/entry.tsx --public-dir out/qa/matte/public`.

## Tests

- `tests/matte.test.ts` (fast): engine selection, the receipt schema, the model manifest, the EMA, guided filter and flicker maths.
- `tests/matte-engines.test.ts`: the real engines with `RUN_MATTE_TESTS=1`, Vision when prepared, ONNX when the weights are present. It checks the rmbg output contract, the frame naming, the flicker fields and the ProRes pixel format on a synthetic ffmpeg picture.
