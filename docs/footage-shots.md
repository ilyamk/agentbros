# Footage shots

Last updated: 2026-11-13

Finds every cut, dissolve and fade in a user's own video, to the frame, and draws a storyboard. Nothing is paid; it runs locally. For reference films made of motion graphics, use [reference analysis](reference-analysis.md) instead (see "Which detector" below).

```bash
pnpm footage:shots --input talk.mp4 --output-dir out/talk/shots
pnpm footage:shots --input talk.mp4 --output-dir out/talk/shots --strips
pnpm footage:shots --input phone.mov --output-dir out/phone/shots --fps 30
```

| Flag | Meaning |
|---|---|
| `--engine` | `auto` (default) tries TransNetV2 and falls back to the reference detector; `transnetv2` or `reference` forces one |
| `--fps` | Convert to this constant frame rate first. Variable frame rate input is converted to 30 by default, a late-starting stream at its own rate |
| `--strips` | Also write `strips/<shot>.jpg`, up to 12 frames of each shot |
| `--width` | Storyboard tile width |

## Setup

FFmpeg and `uv` are required. The first run downloads, through uv, `transnetv2-pytorch` 1.0.5 with its weights (about 30 MB, inside the wheel), torch 2.15.0 and PySceneDetect 0.7.2, all pinned in `src/lib/footage/shots.ts`. They stay in uv's cache; nothing is installed globally and no weights are committed. If that download fails, the reference detector runs instead and `detector.fallback` in `shots.json` says why and how to fix it.

TransNetV2 always runs on CPU. The port documents different results on Apple's MPS (66 against 108 scenes on one film), and `tests/footage-shots.test.ts` asserts the device. CPU is fast enough: about 6 s for a 9 s clip, including start-up.

## How it works

1. **Frames.** Frame numbers are indexes of decoded frames, from 0. Variable frame rate input (average rate different from the base rate) is first converted with recording-edit's filter, `fps=fps=30:start_time=0:round=near`, into `cfr.mp4` in the output directory; so is a video stream that starts more than half a frame after the container (usually after the audio), at its own rate, because that filter pads the start. Frame N is then frame N of a 30 fps recording-edit master made from the same file, except for one possible extra frame at the very end, where recording-edit holds the last frame. The padding shifts frames: `source.startOffsetSec` records how late the video stream starts, and analysed frame F is frame F − round(`startOffsetSec` × `fps`) of the original stream (`originalStreamFrame()` in `src/lib/footage/shots.ts`). A consumer that decodes the original, such as `reframe:track`, subtracts it; one that reads `analysedPath` or a recording-edit master does not. Absent means 0. `source.analysedPath` names the file the frames belong to.
2. **Candidates.** TransNetV2's single-frame head over 0.5 proposes cuts. Its all-frame head over 0.5 for at least 3 frames proposes gradual transitions, because the single-frame head often stays low through a dissolve. PySceneDetect's threshold detector (level 12) proposes fades through black.
3. **Refinement**, on the decoded frames at 128x72:
   - **Cut:** the frame with the largest mean pixel difference within 3 frames of the candidate. A cut is that frame standing at least 3 times above its neighbours. `frame` is the first frame of the new shot.
   - **Fade:** a near-black hold (mean under 16, spread under 6), then outwards while brightness keeps falling towards it. At least one side must ramp over 2 or more frames; hard cuts into and out of black stay cuts. `frame` is the middle of the black hold.
   - **Dissolve:** a three-level fit (before, raised, after) of coarse composition change on a 16x9 Lab grid, within 1 s of the candidate, where texture, grain and camera moves average out. The raised level must be at least 1.3 times the higher side. `frame` is the middle of the span.
   - A single-frame candidate that is neither stays a cut with half confidence and `measures.uncertain`: shots that look alike cut softly. An all-frame candidate that is neither is dropped, because that head also rises on slow camera moves.

`PARAMS` in `scripts/workers/footage-shots.py` holds every threshold.

## Output

| File | Holds |
|---|---|
| `shots.json` | `FootageShotsSchema` in `src/types/footage-shots.ts` |
| `storyboard-NN.jpg` | One tile per shot, the middle clean frame, with its frame range, timecodes and the transition into it; 120 shots a sheet |
| `strips/<shot>.jpg` | With `--strips`: up to 12 frames of each shot |
| `cfr.mp4` | Only when the input was converted |

`cuts[]`: `frame`, `type` (`cut`, `dissolve`, `fade`), `startFrame` and `endFrame` (the first and last blended frames; equal to `frame` for a cut), `confidence`, `timeSec`, `timecode` (`HH:MM:SS.mmm`) and `measures`.

`shots[]`: `id`, `startFrame` and `endFrame` (inclusive), `startSec` and `endSec` (end exclusive), `durationFrames`, `cleanStartFrame` and `cleanEndFrame` (without the frames of a dissolve or fade at either end), `transitionIn` and `timecode`. A shot runs from one transition's `frame` to the frame before the next.

`shots.json` is also a valid `motion:strip --by-shots` file. Reframing (`reframe:track`) resets its crop path at each shot start; use the clean span when a smooth path must not see blended frames. `toReferenceBoundaries()` in `src/lib/footage/shots.ts` turns the result into reference boundaries for `shotsLayer`.

## Accuracy

On the synthetic fixture in `tests/fixtures/footage-shots-video.ts` (six moving shots with grain, hard cuts at 45, 90 and 216, a 12-frame dissolve blending frames 121–131 and a fade through black blending 157–179), TransNetV2 on CPU found every cut on its exact frame, the dissolve as 122–131 and the fade as 157–179, stable across four grain seeds. The reference detector found the cuts exactly, missed the dissolve (it was only a below-threshold candidate) and called the fade a cut at 159.

Limits:

- Fades to or from white are not typed as fades; they come out as dissolves or cuts.
- The first frame of a dissolve can be called one frame late when the outgoing shot moves fast: its first blended frame changes little.
- Motion graphics: on `ugc-app` from the reference library, every cut it reported was on a judged cut, but it found 7 of about 25 judged ones, missing fast page flips with similar layouts. Use `ref:analyze` there.

## Which detector

`footage:shots` is for camera footage: talking heads, interviews, events, b-roll. `ref:analyze` keeps its own detector, tuned on motion-graphics films and typing wipes, whips, match cuts and continuous moves, which this one does not. On the fixture this one is clearly better at dissolves and fades. On the motion-graphics library film above it misses fast cuts the reference detector finds. So `ref:analyze` is unchanged; the reference pipeline can take these cuts through `toReferenceBoundaries()` when a reference is camera footage.

Run tests: `node --import tsx --test tests/footage-shots.test.ts` (fallback and frame-rate tests need uv and ffmpeg); `RUN_SHOTS_MODEL_TESTS=1` adds the TransNetV2 test.
