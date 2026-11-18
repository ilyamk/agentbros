# Several cameras and vertical reframing

Last updated: 2026-11-13

Three local commands, no API keys, no paid calls: `multicam:sync` puts several recordings of one event on one clock, `multicam:angles` proposes which camera to show when, and `reframe:track` turns a landscape shot into a vertical (or square) crop path that the timeline renders frame by frame. Schemas: `src/types/multicam.ts`. Code: `src/lib/multicam/`, worker `scripts/workers/multicam.py`.

## 1. Sync: `multicam:sync`

```sh
pnpm multicam:sync --inputs wide.mp4 close-a.mp4 close-b.mp4 lav-a.wav lav-b.wav --output pipeline/sync.json
```

- Every input needs sound. The first input is the reference (`--reference N` picks another); `--ids wide,camA,...` names the sources, otherwise file names do.
- Each input's first audio stream is decoded to 48 kHz mono PCM. The coarse offset comes from BBC [audio-offset-finder](https://github.com/bbc/audio-offset-finder) 0.5.5 (`--json`, run through `uvx`, about 16 ms resolution at its default 8 kHz). GCC-PHAT on 48 kHz audio then refines it within ±20 ms, with a sub-sample parabolic peak. Whitening is limited to 60–5000 Hz, because clock drift inside a window dephases higher bins.
- The offset is the median of the three loudest 2 s windows near the start of the overlap. The drift check repeats this near the end of the overlap (only when the overlap is at least 30 s; it searches up to 1000 ppm). `drift.ppm` is how much the offset grows per reference second, in millionths. `accumulatedMs` is the drift over the overlap. `needsResample` turns true when that drift exceeds `--drift-tolerance-ms` (default 16 ms, about half a frame at 30 fps). Resampling is reported, not done.
- **Sign convention:** `offsetSec` is the reference time at which the source's audio t=0 lands: `referenceSec = sourceSec + offsetSec`. A negative offset means the source started before the reference. `videoOffsetSec` adds the container's audio/video start difference (ffprobe `start_time`): it is where the source's first video frame lands, so use it for picture.
- **Confidence.** A source passes when audio-offset-finder's standard score is at least 10 (`--min-score`) and the GCC-PHAT peak is at least 3 times the next peak (`--min-peak-ratio`). Otherwise the command fails with `VALIDATION`, lists the reasons per source and writes nothing. The full report is in `details.report`. Typical causes are inputs that do not share audible sound, or a muted camera.

## 2. Angles: `multicam:angles`

```sh
pnpm multicam:angles --sync pipeline/sync.json --map angles-map.json [--transcript pipeline/transcript.json] \
  --output pipeline/angles.json --command-output pipeline/angles-edit.json [--sound-track-id programme]
```

The angle map says who sits where. Sources are sync ids:

```json
{"version":1,"speakers":[{"speaker":"S1","angle":"camA","mic":"lavA","position":0.3},{"speaker":"S2","angle":"camB","mic":"lavB","position":0.72}],"wide":"wide","audio":"wide"}
```

Evidence, in order of preference (`--method auto`):

1. **`mic-energy`**: every mapped speaker has their own mic. A mic speaks when it is 10 dB above its own floor (20th percentile) and within 6 dB of the loudest mic, so bleed from a neighbour does not count.
2. **`diarisation`**: the transcript (`TranscriptSchema`) is diarised with at least two speakers. Words closer than 0.35 s join one turn. The transcript's source is found by sha256 among the synced inputs, else `--transcript-source`, else the reference.
3. **`visual-asd`**: shared audio, with an `--asd` result of per-face speaking scores (`AsdResultSchema`). Faces map to the speaker whose `position` is nearest. See [Visual active-speaker detection](#visual-active-speaker-detection): the worker for it is not shipped.
4. **`wide-only`**: no evidence, so the proposal is one wide shot.

Rules, in this order:

- A single speaker gets their angle.
- Overlapping speech longer than `--overlap-wide` (2 s) goes to the wide shot. Shorter overlaps and silence hold the current shot. Before any speech, the wide shot holds.
- Cuts snap to a transcript sentence start within 0.6 s.
- Shots shorter than `--min-shot` (1.5 s) are absorbed by the shot before them.
- A camera with no picture at that time falls back to the wide shot, then to any covering camera, and a note records it.

Segments are output frames on the reference timeline, with a `reason` (`speaker`, `overlap-wide`, `overlap-hold`, `silence-hold`, `fallback-wide`).

**Into the timeline.** TimelineIR already holds synced multicam, so no new IR type was added: one visual track whose clips switch `assetId`.

- `--command-output` writes an `add-track` command (a `batch` with `--sound-track-id`, which adds the programme sound on a `voiceover` track). Voiceover tracks render audio assets only, so the sound source must be an audio-only input (`map.audio`), or a camera whose extracted audio was imported and passed as `--assets cam=<audio asset id>`; otherwise the command refuses.
- Each clip reads its camera from `referenceSec − videoOffset(t)`, with drift applied at the clip's start, at 1/48000 s precision, in that camera's own source timebase.
- Clip duration equals the segment exactly, so the clips are contiguous.
- Asset ids default to `sha256:<file hash>`, which is what `asset:import` registers. Pass `--assets camA=sha256:...` when they differ.
- Dry-run and apply with `timeline-edit --command-file`. The plan's `--fps` must equal the timeline timebase.
- Drift inside one long clip is not corrected. A rational clip `rate` could absorb it; that is not built.

## 3. Reframing: `reframe:track`

```sh
pnpm reframe:track --input wide.mp4 --format vertical [--shots pipeline/shots.json] \
  [--follow pipeline/angles.json --sync pipeline/sync.json | --transcript pipeline/transcript.json] [--map angles-map.json] \
  --output pipeline/crop-path.json [--command-output reframe-edit.json --track-id visual --clip-id c1]
```

**Detection.**

- [YuNet](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) (opencv_zoo, MIT) runs through OpenCV's `FaceDetectorYN`, at `--sample-fps` 5 on frames downscaled to 640 px wide.
- On samples with no face, OpenCV's built-in HOG people detector (no download) finds people instead.
- The YuNet ONNX is downloaded once from a pinned opencv_zoo commit, checked by sha256, into `~/.cache/agentbros/reframe/`.
- Ultralytics/AGPL detectors are not used.
- `--save-detections` and `--detections` reuse one detector pass while tuning.

**Subject per shot.** Face detections are linked into tracks (nearest centre within 6% of the frame). Only tracks present in at least 30% of a shot's samples count, so a stray detection (a picture on the wall, a hand) never moves the crop. Each track is weighed by coverage × mean face area × score, with a bonus for being near the centre. The subject is, in order:

- the followed speaker's track, nearest the follow point (see below);
- all tracks, when they fit inside 90% of the crop together;
- the heaviest track, held for the whole shot (no switching between faces sample by sample);
- people, when the shot has no face track;
- nothing, which keeps the centre.

On a vertical crop the face sits 10% of the crop height above centre (headroom). The subject's box always stays inside the crop with a margin of half its size (at least 2% of the frame), even when the deadzone holds the crop still.

**Per shot**, an AutoFlip-style path:

- If the subject's motion stays within `--deadzone` (50%) of the crop width, the shot gets one **stationary** crop centred on the motion.
- Otherwise the shot is a **pan**. Moves under `--min-move` (5% of the frame) are ignored, and the held path is smoothed forwards and backwards with a Gaussian (`--smoothing` 0.5 s sigma).
- In a wide shot (median face narrower than 5% of the frame) `--min-move` is doubled and the smoothing tripled, so small faces do not swing the crop.
- The path is simplified to keyframes within 0.002.
- Shots reset the path: two keyframes on adjacent frames make a step, and nothing interpolates across a cut.
- `--shots` takes `footage:shots` output, validated with `FootageShotsSchema` (`src/types/footage-shots.ts`). Its frames index the decoded frames of `source.analysedPath` with an inclusive `endFrame`; they are shifted back by `source.startOffsetSec` (the padding `footage:shots` adds to a late-starting stream; absent means 0) and rescaled from its `fps` to the video's. Whole shots are used, dissolve and fade frames included (`cleanStartFrame`/`cleanEndFrame` are not applied). Pass the same file `footage:shots` analysed. A document that is not `FootageShotsSchema` is read as a plain `{shots:[{startFrame,endFrame}]}` list with an exclusive end.

**Following the active speaker.** With `--follow angles.json --sync sync.json`, each speaker segment gives a point in this camera:

- the segment's `focus`, when the plan's `focusSource` is this camera;
- otherwise the speaker's `position` from `--map`, when this camera is the map's `wide`.

With `--transcript transcript.json --map angles-map.json` (diarised `TranscriptSchema`), each speaker turn gives that speaker's `position` from the map, at the face's height. Words of one speaker less than 0.35 s apart join one turn; a turn shorter than 1.5 s (an interjection) is folded into the turn before it. Transcript times are taken as this video's seconds; when the transcript was made from another file (its extracted audio), a note says so. `--transcript` and `--follow` are exclusive.

The face track nearest the point is followed. A shot is split where the followed track changes, and each part is planned on its own (stationary or smoothed pan), so smoothing never settles between two people. The crop moves to a new speaker with a 0.5 s eased pan starting at the turn. A part shorter than 1 s (a turn that only grazes the start or end of a shot) takes its neighbour's subject. Without either flag, a shot with two people apart holds on the heaviest face; it does not cut between them.

**Output.** `crop-path.json` (`CropPathSchema`) holds the crop size, each shot's mode, subject and coverage, and `keyframes` in **source frames** with `x`/`y` as cover alignment (CSS `object-position` fractions, `p = (centre − crop/2)/(1 − crop)`), not crop centres.

**Rendering.** `reframe-visual` now accepts `position: {keyframes:[{frame,x,y}]}` (at most 20 000, increasing frames) as well as the static `{x,y}`:

- `TimelineComposition` reads the path at the clip's current source frame, so trims, splits and slips keep the crop on the same picture.
- Interpolation is linear, held outside the keyframes.
- A static position and an absent one render exactly as before.
- `--command-output` writes that command for one clip. With `--timeline pipeline/timeline-edit.json`, `--clip-id` also takes a comma list or `all` (every clip of this video on `--track-id`, matched by `sha256:<file hash>`, or, with `--recording-edit`, every clip whose `payload.sourceHash` is this file's), and each clip's command carries only the keyframes of its own source span, so the journal does not repeat the whole path per clip. One batch holds at most 100 clips. The keyframes must be in that clip's source timebase, the video's own frame rate.

**Recuts.** `recording-edit` picture clips (payload `volume`, `sourceHash`, `editHash`, and an optional punch-in `transform`) accept a crop path, and their payload is kept. A punch-in scales the already-cropped frame about the output centre, so a subject the path centres stays centred; at a clamped edge of the frame it can drift off-centre under the zoom. Recut clips read a 30 fps source grid: the original's own frames when it was 30 fps CFR, else the normalised master. With `--recording-edit pipeline/recording-edit.json` the command's keyframes are re-keyed through its `normalization.masterToDecodedFrame` (each master frame takes the value of the original frame it shows), so shot steps land on the right master frame. The crop-path file itself stays in original frames. Without a normalised master, a non-30 fps input is refused.

**Frame accuracy.** The renderer reads a path at the decoded source frame it shows (from the same rounded `trimBefore` as the media, then floored), so a shot step never blends for one frame when the source rate differs from the timeline's (25 or 29.97 on 30).

The talking-head presenter crop (`talkingHead.presenterCrop`) is still static.

## Visual active-speaker detection

Light-ASD (MIT) is the intended model. It is about 1M parameters and runs on CPU, taking 112×112 grey face crops at 25 fps plus 13-band MFCC at 100 fps, and prefers its AVA-trained `pretrain_AVA_CVPR.model` weights. The TalkSet fine-tune is built from VoxCeleb2 and LRS3, whose terms need checking.

- **Built:** the consumer side. That is `AsdResultSchema` (per-face mean position and per-hop speaking score, positive meaning speaking, in the camera's own time), `activityFromAsd` and `multicam:angles --asd`.
- **Not built:** the worker that runs the model. In this session the network request to inspect the Light-ASD repository was not permitted, so neither its code nor its weights were fetched or run. Nothing claims they work.

A worker must:

1. detect and track faces with YuNet at 25 fps;
2. crop each track and compute MFCC with `python_speech_features`;
3. load `ASD_Model` and `lossAV` from a pinned commit;
4. write `AsdResultSchema`;
5. be gated behind `RUN_ASD_TESTS=1`.

## Tests

- `tests/multicam-sync.test.ts`:
  - synthetic pink noise in MOV (PCM) and WAV, with known offsets of +3.2105 s and −1.5 s, asserted within 1 ms;
  - a 312 ppm resampled copy, whose drift is asserted within 15 ppm, with `needsResample`;
  - unrelated noise, which must fail with `VALIDATION`.

  It needs uv and ffmpeg and skips otherwise.
- `tests/multicam-angles.test.ts`: the rules and the timeline command through `applyEdit` and `compileTimelineIR`. No worker is needed.
- `tests/reframe-track.test.ts`: the planner on injected detections. `RUN_REFRAME_MODEL_TESTS=1` runs YuNet on a moving public-domain portrait (Lincoln O-77, Wikimedia Commons, sha256-pinned and cached) over two shots, and checks stationary then pan within 8% of the true centre.
- `tests/reframe-path-timeline.test.ts`: the schema, the reducer and split. `RUN_REFRAME_RENDER_TESTS=1` renders vertical stills in Chrome and checks the path moves the crop from the left column to the right.
