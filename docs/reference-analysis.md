# Reference analysis

Decomposes any video into standard JSON and pictures, so an agent can work out how it was made. Every command prints one JSON line. Nothing here is paid or uses a provider; speech and screen text run on the prepared local engines.

```bash
pnpm ref:add --file design-reference/library/inbox/film.mp4 --id film
pnpm ref:add --url https://example.com/watch/abc --id film --rights unknown
pnpm ref:analyze --id film
pnpm ref:analyze --id film --layers shots,sync,visuals
pnpm ref:validate --id film
pnpm ref:corpus
pnpm ref:redact --all                               # move a film's words out of the tracked speech-text.json
pnpm ref:contribute --id film                       # before a pull request: no media, no verbatim text, no private ids, credits
pnpm ref:compare --id film --render out/film/landscape.mp4
pnpm ref:replica-check --project film-replica --write-shots
pnpm ref:compare --id film --render out/film-replica/landscape.mp4 --render-shots public/projects/film-replica/pipeline/replica-shots.json --tolerance replica --project film-replica
pnpm motion:strip --input out/film/landscape.mp4 --output out/qa/film/hit.png --start-sec 24 --end-sec 26 --vs design-reference/library/film --vs-range 25:27
```

`--library-root` selects the library (default `design-reference/library`); a project may use `public/projects/ID/pipeline/reference`. `--help` lists every flag.

## Setup

- FFmpeg is required.
- `uv` supplies PySceneDetect, OpenCV, SciPy and librosa on first use, pinned in `src/lib/reference/worker.ts`. Nothing is installed globally.
- `pnpm media:prepare --engines asr,ocr` prepares speech and screen text. See [media ingest](media-ingest.md).

A layer that cannot run does not stop the others. Its JSON says so in `status` (`speech` and `screenText` in `speech-text.json`): `available`, `engine`, `unavailableReason` and `fix`. `metadata.layers` in the result repeats this, and `ref:validate` lists it under `unavailable`. `available: true` with a reason means a fallback ran, so read the reason.

## Adding a reference

`ref:add` writes `<id>/source.json` and copies the media to `<id>/media/`. A sidecar `<name>.md` beside the file becomes `notes`. Files under a `library/inbox/` directory default to rights `study-only`, everything else to `unknown`.

Links download through `uvx yt-dlp` without browser cookies. If that fails or the site wants a login, the error says so: ask the user for the file and use `--file`.

### Cropping to the picture

Phone screen recordings and letterboxed films carry bars that are not the film. `ref:add` looks for them and records what it found in `source.json` as `crop` (`{x, y, width, height, method, note}` in source pixels), or `null` when the picture fills the frame:

| `method` | Found by |
|---|---|
| `letterbox` | ffmpeg `cropdetect` on up to 120 frames; the union of their boxes, so only what is black in every sampled frame goes |
| `static-bands` | 12 frames across the film: the longest run of rows (or columns) whose content changes over time, with still bands on both sides. Catches UI bars that are not black. Each band must be still along its whole length (no more than 2% of its pixels ever change), end at a hard edge against the picture in most samples, and, when wider than 15% of its side, be uniform. A band that fails stays in the picture, so the film's own ground with a corner watermark is not cropped |
| `manual` | `--crop W:H:X:Y` |

Nothing is cropped if the picture keeps more than 85% of the frame. `--crop none` keeps the whole frame. To correct a crop fault on a reference already in the library, run `ref:add --id ID --crop none` (or `auto` to detect again, or `W:H:X:Y`) with `--crop-note` saying why: the replaced crop goes to `source.json` `cropHistory`, the cached detection is dropped, and `metadata.next` says to rerun `ref:analyze --id ID`. That run re-detects shots on the new picture, so shot ids can renumber: check `edit.json` corrections and technique shot references against the new `shots.json`. A record from before crops existed is checked when it is read; other readers (`ref:compare`, `motion:strip --vs`, `film:targets`) keep the result in the git-ignored `media/detected-crop.json`, and only `ref:analyze` (or `ref:add`) writes `crop` into `source.json`.

When there is a crop, picture layers (shots, screen text, motion, visuals), `ref:compare`, `film:targets` and `motion:strip --vs` read `media/analysis-WxH+X+Y.mp4`, a cropped copy made once (keyframe every 12 frames, same clock). Sound is measured on the source. Screen-text boxes are relative to the cropped picture.

## Layers

| File | Holds |
|---|---|
| `source.json` | Origin, SHA-256, probe, rights, notes |
| `shots.json` | Shots, the transition into each with a confidence, gradual transition spans, each shot's `colour`, `candidates` |
| `speech-text.json` | Structure only: word spans with letter counts; screen text with spans, refined `onsetSec`, boxes, word and character counts, case and an opaque `textId` per distinct text. The words are in the git-ignored `media/speech-text.full.json` |
| `audio.json` | Tempo, beats, estimated downbeats, onsets, sections, loudness, silence, optional stems |
| `motion.json` | Per-shot energy, peak time, camera estimate, the energy curve |
| `sync.json` | Merged events, and how often cuts and text land on beats and onsets |

`ref:validate` checks present layers against `REFERENCE_LAYERS` in `src/types/reference.ts`, and lists missing measured and judged layers separately. Judged layers (`story`, `visual`, `edit`, `techniques`, `blueprint`) are written by the [`reference-analyst`](../.agents/agents/reference-analyst.md) agent after looking; this tooling only validates them. It also rejects a blueprint whose slots leave a gap or overlap above 0.1 s, or do not span the film from `source.json`. Detector faults the analyst finds go in `corrections` in `edit.json`; `shots.json` stays as measured. Kinds: `merge` (the first id stays), `reject` (the cut before each shot goes), `split` (a cut at `timeSec`; `shotIds` names the detector shot it falls in), `retype` (with `transition`), and `move` (`shotId` and `toSec`: the cut before that shot was placed a few frames off). Besides the detector's transitions, `retype` and `split` may name `iris`, `morph` or `bleach` (a flash to white). Every reader applies them through `correctedShots`. `ref:validate` adds `warnings` (never failures) for a split without `timeSec` or outside its named shot, a move outside the film, an unknown shot id; for `audio.json` and `audiomap.json` tempos more than 10% apart and in no 2:1 or 3:2 ratio (127.6 against 163 BPM on one reference); for a beat grid whose phase slips over 0.1 s against the onsets across a section (`sync.json` `warnings` too, numbers unchanged); and for the film's own words left in the blueprint, matched by stem, with function and everyday words, schema words and technique ids ignored and `referenceId` not read (`blueprintLeaks`: `name` for words capitalised mid-sentence and never lower case in the film, else `word`). When `edit.json` exists, `film:targets` takes its cut list, cut rate, median and variety from the judged cuts (`shots.json` with the corrections applied) and keeps the detector's count as a cross-check: `metadata.crossCheck` and `measuredFrom.detectorDisagreement`, with a warning when the two counts differ by more than 25% of the judged one.

### Reading shots

A boundary is a change of composition, found three ways. PySceneDetect's adaptive detector and a one-frame spike test find hard cuts. Foote novelty on a 16x9 Lab grid finds gradual ones at two time scales, because it compares two runs of frames rather than neighbours. `scene > 0.3` fails on crossfaded films for that reason.

`startSec` of a shot is the cut, or the middle of a gradual transition, whose span is in `transitionStartSec` and `transitionEndSec`. The measurements behind each call are in `transitionMeasures`.

| `transitionIn` | Measured as | Trust |
|---|---|---|
| `cut` | One-frame jump that changes the composition | High |
| `match` | Hard cut keeping the layout (edge correlation over 0.65) | Low: 0.45, look at it |
| `fade` | Passes through a near-uniform black or white frame | High |
| `wipe` | Pixels are exactly A or B, and the changed area sweeps | Medium |
| `whip` | Fast, coherent optical flow across the frame | Medium: also fires on fast slides |
| `dissolve` | Frames fit a blend of A and B, with a rising mix | Medium to high |
| `continuous` | A sustained change that fits none of these | Low: 0.4, look at it |
| `unknown` | First shot, or the ffmpeg fallback | None |

**Limits, measured on the inbox films:**

- Text swapped on a flat background moves too little colour to count as a shot, and it looks the same as an element added to a held layout. These go to `candidates` and screen-text onsets, not shots. On sparse text-led films, read those too.
- Fast kinetic type can register as a cut.
- Collage build-ups, where images keep arriving on a held layout, still over-count: about 70% of `cashfree`'s first 30 boundaries were real.
- A shape morphing into new content can read as one shot, such as `polymarket`'s coin becoming a card.
- Whisper can loop one token over music when it detects the language itself. Such runs are dropped and `speech.unavailableReason` says how many; rerun with `--language`.
- `whip` and `continuous` describe what moved, not what the editor called it. A zoom through a collage can read as either.

Each shot's `colour` holds its mean `L`, `a`, `b`, the 10th, 50th and 90th percentile of each channel, and the number of 4 Hz samples behind them (`samples`). They are measured exactly as `ref:compare` measures its reference side (an 8x4-grid sample film at 4 Hz on the analysis media, 32-bin Lab histograms with `a` and `b` bins centred on zero, the first and last 0.1 s of the shot left out), so a replica's colour target copied from here is what compare will read. Records measured before 2026-11-15 read about a = +4, b = −4 on neutral shots: zero sat on a bin edge. `ref:analyze --id ID --layers colour` re-measures every shot's colour on the existing `shots.json` without detecting shots again. On a record without colour, `--layers shots,visuals` also adds them; it re-detects the shots (with unchanged detector parameters the ids and times come out the same, as they did on `polymarket`), and `visuals` restores the strip and thumbnail paths.

The thresholds are in `PARAMS` in `scripts/workers/reference-analysis.py`. They were tuned by looking at `boundaries-NN.jpg` for each film and labelling what was real, not by detector agreement. PySceneDetect alone gave 1 cut on `paper-style`, which has 8 whip transitions, so novelty finds the gradual ones. It also over-fired on elements popping onto a held layout: `changed - 0.6 x edge similarity` under 0.12, with novelty under 12, now rejects those, because the cuts labelled false scored low there and most real ones scored high.

### Reading audio and sync

Tempo comes from librosa. `confidence` is how strongly the onset pattern repeats at the beat period, and `beatRegularity` how even the beats are: speech-led or free-time audio still returns a number, so check both. Downbeats are an estimate from the strongest bar phase, with their own `downbeatConfidence`. Sections are labelled by loudness only (`2-loud`). `--stems` adds demucs stems under `media/stems/` and makes a large download on first use.

Without uv, the existing RMS rhythm kernel runs instead and reports a tempo only for a very regular pulse.

**Always compare `cutsOnBeatRatio` with `cutsOnBeatChance`.** At 120 BPM with the default 0.08 s tolerance, random times score about 32%. Only a ratio well above chance suggests cutting to the beat. At fast tempi the ±0.08 s window covers half the timeline (174 BPM: ~46 %), so `sync.json` also reports `cutsOnBeatLift` (ratio over chance), `cutsOnDownbeatFrameRatio`, `…Chance` and `…Lift` (cuts within ±1 frame of a downbeat; the reference audio layer has no hit strengths, so downbeats stand in for strong hits) and `signedMedianCutToBeatSec` (negative: the picture cuts before the beat).

Screen text is sampled twice a second, then refined to the frame where its box changes most (`onsetSec`), so it uses the same tolerance as cuts when that ran. Otherwise `textToleranceSec` widens to 0.25 s, where the ratio says little at most tempos.

Word times are whisper.cpp estimates with no confidence. Words can be misheard, especially names and over music, so check them against the sound and the screen before relying on them.

### The film's words stay local

`ref:analyze` writes the recognised words to `media/speech-text.full.json`, git-ignored with the media, and the tracked `speech-text.json` as structure only (`content: "structure"`): every count, box and time, with `textId` standing in for the text so repeated samples still group. Only three readers need the words: the blueprint leak check, the verbatim check and `ref:replica-check`; each reads the local file and says when it was skipped for lack of it. Every other reader, `ref:corpus` included, reads the structure, so its numbers are the same on any checkout. `ref:redact --id ID` (or `--all`) moves words left in a tracked layer to the local file, and on a checkout with only the structure recovers them from git history when they were committed and the structure still matches.

`ref:validate` also warns when a judged layer or Markdown file quotes the film beyond four words, or (with the local words) copies a run of five of them without quotation marks; `ref:contribute` refuses both. Describe copy by role, word count, case, size and timing, and cite screen text by index and time. What may be contributed, the check, and private references (`ref:add --private`): [contributing references](contributing-references.md).

### Reading motion

`motion.json` measures optical flow on frames reduced to 128 px wide, in frame widths per second, leaving out gradual transitions. Without uv it falls back to frame difference (0-255), with camera `unknown`; `method` says which. `cameraEstimate` models the whole frame: motion-graphics films mostly read `complex` or `static`, which describes moving elements on a still frame rather than a camera.

With uv, each shot also has:

- `camera`: the camera integrated over the shot from tracked corners (Lucas-Kanade with a forward-backward check, then a RANSAC similarity per frame; dense flow measured a known 25% push a third short). `amount` is the net travel: `x` and `y` in frame widths (camera right and down positive), `z` in log scale (push in positive; `exp(z) - 1` is the zoom), `r` in radians. `kind` names the moves (`push_in`, `move_left`, `shake`, `static` and so on). For the main move: `startSec`, `durationSec`, `span90Sec` (5% to 95% of the travel, the length to compare), `holdBeforeSec`, `holdAfterSec`, `overshoot`, `cutOff` and `leadInSec` when a cut interrupts it, `progress` (21 points), and `ease`: the start, length, amount and curve are fitted together as `x(t) = B + A·E(clip((t - t0)/D, 0, 1))`, so a slow tail is not cut off. A zoom is fitted on the scale itself, not its log, because that is what a tween animates. `ease.gsap` is the nearest GSAP name, `ease.css` a `cubic-bezier()`, `ease.spring.remotion` a `{mass, stiffness, damping}` for Remotion's `spring()`; `ease.pick` says which to use (the GSAP name when it fits nearly as well as the best). `otherMoves` and `drift` hold smaller moves and a slow travel under the whole shot. `trackedShare` is the share of frame steps the tracker trusted: under about 0.5, read the numbers as rough. `suspect: true` with `suspectReasons` marks a fit that is probably not a camera ease: under 0.5 tracked (element motion), a fit error above 0.1, a bezier with x outside 0-1 or y beyond ±2.5, or a fitted length over 1.5 times the shot. `ref:corpus` applies the same test to older files.
- `cadence`: how many new drawings a second while things move. A frame that repeats the previous one inside motion is held; `framesPerDrawing` 2 with `label` `on twos` is limited animation. Without enough motion only `movingFrames` is given.

The layer also has a whole-film `cadence` and `staticOverlayShare`: pixels that never change across cuts (a logo, a watermark), left out of camera tracking. Inside a single shot nothing is masked, because the centre of a slow zoom barely changes either.

## Visuals

Written to `<id>/visuals/` and git-ignored. Open them with your image tool, as in [agent vision](agent-vision.md).

| File | Use |
|---|---|
| `contact-sheet-NN.jpg` | First, middle and last settled frame of each shot, 40 shots a sheet |
| `boundaries-NN.jpg` | Frames across each transition, to check it is real and what kind it is |
| `edit-map.png` | Shots, waveform, beats, onsets, speech, text and motion on one time axis; cuts run through every track |
| `strips/<shot>.jpg` | Up to 12 frames of one shot |
| `thumbs/<shot>.jpg` | Middle frame of one shot |

Detected boundaries are candidates until looked at. Check `boundaries-NN.jpg` before relying on a count.

## Corpus

One reference is one film's taste. `ref:corpus` reads every analysed reference in the library together, so an agent picks a pace, a hold or a technique from many films' numbers and by what it does for the viewer. The [edit-research skill](../.agents/skills/edit-research/SKILL.md) is the working method around it: typed techniques from strips, the corpus before a new move, a technique seen in two or more references promoted to a technique card and a library block, and sensors calibrated below.

```bash
pnpm ref:corpus                                   # design-reference/library/_corpus.json
pnpm ref:corpus --playbook product-promo --exclude film-a,film-b
pnpm ref:add --id film --playbooks product-promo,teaser-trailer   # tag an existing reference
pnpm film:targets --corpus --playbook product-promo --project ID
```

It reads every directory under `--library-root` with a `source.json`, except `inbox` and names starting with `_`. A missing or invalid layer is reported under the reference (`present`, `missing`, `invalid`, `unavailable`) and in `warnings`; it never stops the run. `--playbook` keeps references whose `source.json` `playbooks` lists the id, and fails when none does. `_corpus.json` is git-ignored: rebuild it after analysing a reference. Private references (`private: true`, or ignored in `.git/info/exclude`) count like any other; `references[].private` and `privateReferenceIds` mark them so their ids are never copied into a tracked card, block or note.

| Field | Holds |
|---|---|
| `metrics` | Across references, `n`, `min`, `p10`, `p25`, `median`, `p75`, `p90`, `max` of: `cutsPerMinute`, `medianShotSec`, `shotCount`, `shotLengthVariety` (p90/p10, five shots or more), `flowStillShare` and `flowLongestStillSec`, `cutsOnBeatRatio`, `cutsOnBeatLift`, `cutsOnDownbeatFrameLift`, `signedMedianCutToBeatSec`, `cutsOnOnsetRatio`, `cutsOnOnsetLift`, `onsetsPerCut`, `integratedLufs`, `screenTextDwellSec`, `centredTextShare`, `screenTextPerMinute`. `definitions` says how each is read |
| `references[]` | Each reference's own values, its cut source (`judged` or `detector`) and layer coverage |
| `easeNames` | Fitted camera eases from `motion.json`, counted over shots |
| `easeFamilies` | The same fits (`motion`) and the techniques' eases, each phase counted (`techniques`), by family: `linear`, `in`, `out`, `inOut`, `spring`, `steps`, `unknown`, with a strength where the name gives one (`out:3`; sine 0.5, power1 1 to power4 4, circ 3, expo 5; `steps:N` the step count). `normaliseEaseName` in `src/lib/reference/corpus.ts` reads GSAP names, `none`, CSS keywords, `cubic-bezier()` (by its shape), `spring(...)` and `steps(n)`/`hold`; a free-text name is read by its first ease |
| `excludedEaseFits` | Fits left out of both: those spanning a cut the analyst added (a `split` or `move` inside the fit's window, one frame in from each end) and suspect ones |
| `techniques.byFunction` | Every technique under its `function` (`hook`, `reveal`, `proof`, `transition`, `emphasis`, `cta`, `breath`) or `unclassified`, with `refId`, `techniqueId`, `name`, `spans`, `route`, `difficulty`, `timing`, `ease`, `sound` |
| `gaps` | `missingPrimitives` (the name before the first comma of each `missing:` primitive), named `edit.json` `signatureMoves`, and technique names, each with the references that have it, most references first |

How the numbers are read:

- Cuts are the judged cuts (`shots.json` with `edit.json` corrections) when `edit.json` exists, as in `film:targets`. Sync is recomputed on them from `audio.json` beats with the sync layer's tolerances (80 ms, downbeats within a frame); `sync.json`'s ratios, taken on detector cuts, are the fallback only when there is no beat grid. `onsetsPerCut` counts audio onsets within 80 ms of each cut: how much sound marks a cut.
- Stills come from `motion.json` optical flow under 0.001 frame widths a second for 0.5 s or more, flow layers only. That is not `film:measure`'s pixel-change reading, so these are reported, never targets.
- Screen text: OCR samples (2 fps, confidence 0.5 or more, two characters or more) of the same text (`textId`, or the normalised words in a layer not yet redacted) are merged while they touch, then each appearance's length is its dwell and its first box gives its centre. OCR noise and UI text count too, so dwell sits near the 0.5 s sampling floor on films whose text keeps changing.

`film:targets --corpus` builds targets from the same corpus with no media and no FFmpeg: median shot and cuts a minute take the corpus's p10 divided by 1.5 to its p90 times 1.5 (`CORPUS_PACE_SLACK`; a gate, so the middle half, which failed half the professional references, stays in `measuredFrom` as `corpus<Metric>P25` and `P75`, the aim), variety at least 0.8 of the p10 (between 1.5 and 3), loudness the p10 less 2 LU to the p90 plus 2, widened to always accept -17 to -11 LUFS ([calibration](../design-reference/calibration.md)), and sync as v2 against the corpus's median lifts. Each metric's median and `n` are kept in `measuredFrom` (`corpus<Metric>Median`, `corpus<Metric>N`), the references in `corpus.referenceIds`, and `source` is `corpus`. It sets no still-share, longest-still or climax limits, and warns when the corpus holds fewer than three references. A replica still needs `--reference`.

### Typed techniques

`techniques.json` items carry optional typed facts the corpus indexes: `function`; `timing` (`durationSec`, `startOffsetFromCutSec`, `onBeat`); `ease` (`name`, `cubicBezier`, `source`: `motion.json`, `strip` or `inferred`; `phases` for a move in parts, each `{part: exit|entry|hold|settle|overshoot|main, name?, cubicBezier?, durationSec?}`; `truncated` when a cut cuts the fitted ease off); `sound` (`kind`: `sfx`, `music-hit`, `music-bed`, `dip` (the music breaks or drops out as the accent), `voice`, `silence` or `unknown` when nothing is established; `layers`, `note`; `timingBasis` and `sourceBasis` when the timing is measured but the source inferred); `typography`, one object or one per role (`role`, `entry`, `alignment`: `left`, `centre`, `right`, `free` or `split-edges`; `size` as a share of the frame height); `layers`; for a transition, `fromShot` and `toShot`; for a move across several shots, `shots` (ids after corrections); and `occurrences` when the technique recurs, each `{span, fromShot?, toShot?, shots?, timing?}`. `timing`, `sound` and `typography` take a `basis`, `evidence` and an optional `confidence` (0-1) like a claim; `ease` takes `confidence` too. `edit.json` signature moves take an optional kebab-case `name` so the same move is counted across films, and `spans` when it recurs.

`requiredPrimitives` entries name what they are by prefix: `remotion:<Api>` (Remotion itself), `block:<id>` (a motion library block; `library:` reads the same), `missing:<name>, what it must do`, and a plain name (or `repo:<name>`) for an export of this repository. Only `missing:` entries count as gaps. Older files without these fields still validate and land under `unclassified`.

## Calibration

A sensor or a critic earns a gate only after it has told a professional segment from a copy made worse on purpose, often enough and on enough pairs. `ref:degrade` makes the pairs; `judge:calibrate` scores the judges on them. Both are local, free and git-ignored under `out/qa/calibration/`.

```bash
pnpm ref:degrade --id film --auto 4                       # out/qa/calibration/film/seg-<start>-<end>/manifest.json
pnpm ref:degrade --id film --start-sec 12 --end-sec 15 --kinds stutter,desync
pnpm judge:calibrate                                      # every manifest under out/qa/calibration; report.json
pnpm judge:calibrate --sensors none --critic-pack --batches 12   # one batch per fresh critic in out/qa/calibration/critic
pnpm judge:calibrate --sensors none --critic-results out/qa/calibration/critic/results-0.json,out/qa/calibration/critic/results-1.json
```

A segment is 2–4 s of the reference's picture (the cropped analysis copy when there is a crop) with the source's sound; `--auto N` picks N windows that hold cuts and motion, never overlapping. The frames are decoded once at the reference's frame rate (long side at most 960) and every clip, the original included, is encoded from them with the same settings, so a difference is the degradation and not the codec. The same request writes the same files and hashes on the same machine and ffmpeg build. Each segment's `manifest.json` (`src/types/calibration.ts`) names the original, every variant with its `kind`, `params` and the clip it degrades (`against`), skipped kinds with the reason, the reference's beat grid in its own time, and the sha256 of each clip.

| Kind | What it simulates | How, and its honest limit |
|---|---|---|
| `linear-motion` | Eases flattened to constant speed | Within each shot (shots.json, snapped to the biggest change within 2 frames), frames are re-picked so the cumulative luma change (64×36) grows evenly with time. Frame selection only: no in-betweens are made, so a fast stretch skips frames and a slow one holds; one curve stands for every moving thing in the frame; `motion.json`'s energy curve is too coarse (one sample per stride) to retime frame by frame, so it is not used |
| `stutter` | Smooth motion turned strobe-sharp | Every third frame held for three. It adds no blur and removes none: a source with heavy blur stays blurred, only stepped |
| `uniform-cuts` | Rhythm variety destroyed | On an 8–12 s span grown to hold five shots, every shot gets the same length: a long one is cut short, a short one held on its last frame. Sound untouched, so cuts also leave their hits. Compared with `originalLong`, not the 2–4 s original; skipped under three shots |
| `desync` | Cuts off the beat | Picture shifted 4 frames against the sound, both ways (`desync-late`: sound first; `desync-early`). Edges are clamped to the decoded margin |
| `no-sfx` | Sound effects removed | With stems (`ref:analyze --stems`), the sound is every stem but drums. Demucs has no SFX stem: drums are where percussive hits and most SFX land, and real drums go with them |
| `soft-transients` | Hits blunted (no stems) | Compressor with a 0.2 ms attack, then a 3 kHz low-pass: attacks squashed and highs cut, not effects removed. Loudness changes too |
| `flat-grade` | A colour control | Saturation 0.75, contrast 0.85; timing untouched, so no timing sensor should move |

Sensor mode reads each clip with the existing sensors (`gatherEvidence` through `evidenceFor`, cached beside the clip, then `measureFilm`): `shot-length-variety` (five shots or more), `motion-spread`, `fast-motion-sharp`, and `cut-sound-coverage` on a cue sheet that makes every detected cut a sound; with a grid, `readSync`'s `cuts-on-beat` and `cut-to-beat-offset` (distance from a one-frame lead). Two candidates that are not film:measure legs: `motion-energy-contrast` (within-shot unevenness of motion) and `colour-saturation` (signalstats). `SENSORS` in `src/lib/reference/calibrate.ts` says, for each, which way is worse and which kinds it should catch; it detects a pair when it reads the variant worse than its original in that direction. Every other kind is its control: `falseAlarms` counts pairs it read clearly worse (by over 10% of the original and 0.02). Read `stutter` with care: the 10 Hz motion pass on 30 fps picture samples frames 0, 3, 6, the very frames a step-3 stutter keeps, so `motion-spread` may see no change for sampling reasons, while `fast-motion-sharp`'s pairs are stepped by `sharpnessStep`, never a multiple of 2 or 3, so some of them straddle a hold.

Critic mode writes blind packets: per pair both orders, under neutral ids, with a strip (ten spread and ten consecutive frames of A, then of B) and a waveform image, the questions shuffled by a seed. The answer key, `critic-key.json`, is written beside the critic's folder, never in it (`--critic-key` moves it, still outside). Give the critic that folder and confine its brief to it: the neutral clips are hard links of the labelled ones, whose hashes the manifests list, so a critic that searches `out/qa/calibration/` can unblind itself. Results are `[{pairId, order, winner: A|B|tie, reason}]`. A pair is right only when both orders name the original (`agreedPairs` from `creative-rubric.ts`): a tie, a disagreement or a missing order is not, and every pair in the key counts. The critic cannot hear, so sound kinds rest on the waveform.

One critic must never see the same original twice. Every degradation kind of a segment is paired with the same original, so a critic that sees several pairs spots the original as the clip that recurs; and the `ba` clips are byte-identical swaps of the `ab` ones, so a critic that sees both orders carries one judgement across them and the both-orders agreement means nothing. Calibration critics reported doing both. So pack with `--batches N`: it writes `batch-<k>.json` and a `batch-<k>/` folder per batch (no `pairs.json`), deals each original's pairs so a batch holds at most one of them, and puts the two orders of every pair in different batches. N must be at least twice the most pairs one segment has (refused below it). Inside a batch each question has its own hashed id (`q…`, never the pair id), its clips are copies rather than links, and A/B are as shown (`order: "ab"`); the key outside maps each id back to its pair and order. **Give each batch to its own fresh critic**, confined to `batch-<k>.json` and `batch-<k>/`, and never one critic two batches. Pass all results comma-separated: `--critic-results results-0.json,results-1.json,…`; an unknown id, a question judged twice or a batch left unanswered is refused. Without `--batches` the single `pairs.json` remains, for a quick look, not for calibration.

`report.json` gives, per sensor and kind, `n`, `detections`, `accuracy`, `notMeasured`; per kind each judge's accuracy; `failures`, naming which judge missed which pair and why; and `eligibleGates`. A judge is eligible as a gate for a kind at accuracy 0.85 or more on six pairs or more (a segment gives one pair per kind, two for `desync`, so six segments across two references or more); below that its reading stays advisory for that kind. Eligibility is evidence for a decision, not the decision: a gate changes in `film:measure` by a reviewed commit. The latest results and the decisions taken on them are in [calibration](../design-reference/calibration.md).

## Comparing a recreation

`ref:compare` writes `<id>/compare/`: `compare.json`, `sheet.jpg` (original and recreation at the same times) and `side-by-side.mp4` (original in the left ear, recreation in the right).

It first aligns the two films in time: DTW (Sakoe-Chiba band 0.25) over 4 Hz samples of an 8x4 Lab grid and frame change. Each recreation shot (detected, or from `--render-shots shots.json`) is then paired with the reference shot its span maps back to, and compared with it rather than with whatever plays at the same clock time.

| Field | Meaning |
|---|---|
| `durationSec.difference` | Recreation minus original |
| `cuts.meanNearestSec` | Mean distance from each cut to the nearest in the other film, both ways, on the same clock |
| `cuts.referenceMatched`, `cuts.renderMatched` | Share of cuts with a partner within 0.1 s, same clock |
| `cuts.aligned` | The same, with reference cuts mapped through the alignment |
| `palette.meanDistance` | Share-weighted Lab distance between five colours per frame, over 12 shared times. Lower is closer |
| `motion.correlation` | Pearson correlation of frame-difference curves on the shared time axis |
| `motion.alignedCorrelation` | The same along the alignment path |
| `alignment` | `medianOffsetSec` (positive: the recreation runs late), `offsetRangeSec`, `meanCost`, and `path` as `[referenceSec, renderSec]` pairs (at most 200) |
| `shots[]` | Per recreation shot: `referenceShot`, `referenceSpan` (its span in reference time), `overlapShare`, `durationSec`, `frameChange`, `colour`, and `camera` when both sides have fitted moves |
| `shots[].colour` | Wasserstein (earth mover's) distance between 32-bin Lab histograms per channel, `emdL` in lightness points, `emdA` and `emdB` in colour points, with mean `L`, `a`, `b` of both |
| `shots[].camera` | `kindMatch` (soft overlap of what the moves do, 0-1), `durationRatio` (recreation over reference, on `span90Sec`), `amountRatio`, `easeRmse` between the two progress curves, both GSAP names and the reference's `cubic-bezier` |
| `look` | Whole-film Lab histogram distance, each shot weighted by its length |
| `findings[]` | `{component, where, severity, text, renderSec?, referenceSec?}`, major first |
| `cameraNote` | Why moves were not compared: the reference's `motion.json` lacks them, uv is missing, or `--no-camera` |

Findings are numeric sentences tied to a shot pair or a time, such as `s3 vs ref s004: the push takes 1.24 s against 0.90 s (38% slower)`, `s2 vs ref s003: darker than the reference (mean L 41 against 58, EMD 17.2)` or `Reference cut at 4.20 s (aligned to 4.65 s here) has no cut within 0.1 s.` Components: `alignment`, `cuts`, `timing` (shot length off by more than 41%), `motion` (frame change off by more than 52%), `camera` (another kind of move; length off by more than 27%; amount off by more than 52%; easing curves apart by more than 0.08, with the reference's `cubic-bezier` to use), `colour` (L distance over 10, or Lab b shifted over 8), `palette` (whole film). Fitting the recreation's moves runs the uv motion worker on the render.

Numbers show where to look; they do not say a recreation is good, and there is no overall score. Shot lengths and timing may differ on purpose when a replica is retimed to its own music.

### Replica tolerance

`--tolerance replica` is for an exact remake ([reference replica](../.agents/skills/reference-replica/SKILL.md)); the default, `style`, keeps the loose findings and output above unchanged. In replica mode the reference side is the analyst's corrected shot list (`shots.json` with `edit.json` `corrections` applied, as `ref:replica-check` reads it; `referenceShots.source` says whether there was an `edit.json`). A fitted reference move is compared only on a corrected shot that is one whole detector shot. The alignment, cut, timing, colour and camera findings are replaced by findings at the constants in `REPLICA_TOLERANCES` (`src/lib/reference/replica.ts`), in the same `{component, where, severity, text}` shape; `motion` and `palette` findings stay at their usual thresholds.

| Measure | Holds when |
|---|---|
| `alignment` | The film's offset (the one most matched cuts share, within a frame) is at most 1 frame |
| `cuts` | Each reference cut has a recreation cut within 0.5 s of where the alignment puts it, and after taking out the film's offset lands within 1 frame; every recreation cut has a reference cut |
| `coverage` | Each reference shot has a recreation shot |
| `shotDuration` | Within whichever is larger, 1 frame or 3% of the reference shot |
| `cameraKind` | `kindMatch` 0.8 or more |
| `cameraLength`, `cameraAmount` | `durationRatio`, `amountRatio` within 10% either way |
| `ease` | The same GSAP name, or a neighbour (same `.in`/`.out`/`.inOut`, one step along none, sine, power1, power2, circ, power3, power4, expo; `back` only itself), noted with the curves' RMSE in `shots[].camera.easeNote`; RMSE 0.05 or less when a side has no name |
| `lightness` | `emdL` 5 or less |
| `warmth` | Mean Lab `b` within 4 |

A miss beyond three times its tolerance is `major`. `summary.withinTolerance` counts `held`, `failed`, `notMeasured` and `exempt` per measure (camera measures are `notMeasured` without uv or a fitted reference move); `summary.offsetSec` is the film's offset and `summary.tolerances` the constants. There is no score: the counts say where to look, and a measure that holds everywhere still says nothing about taste. Cut times compare at frame precision because the alignment only points where to look (it runs at 4 Hz). Pass the replica spec with `--spec <file>` or `--project <id>` (its `pipeline/replica-spec.json`; either needs `--tolerance replica`, and the spec must name this reference): a shot listed in `swaps[].shots` gets no `lightness` or `warmth` finding and counts `exempt` there, never `held`. Swap ids are spec shot ids, which match the recreation's shot ids when `--render-shots` is the spec's `replica-shots.json`. Without the spec, swapped shots are judged like any other.

## Replica spec check

`ref:replica-check --project <id>` (or `--spec <file>`) validates `public/projects/<id>/pipeline/replica-spec.json` (`ReplicaSpecSchema`, `src/types/reference-replica.ts`) against the reference it names, in `--library-root`. A spec that does not parse stops with `VALIDATION`; otherwise `metadata.passed` is false while `issues` are left:

- `rights.status` differs from `source.json`.
- Frames: the first shot starts at frame 0, each starts where the previous ends, and the shots sum to the reference's length (`source.json` duration × the spec's `fps`) within one frame.
- Coverage: every corrected reference shot is covered by exactly one spec shot, each spec shot starts within one frame of its reference shot, and `referenceShot` names a corrected id (a merge keeps its first id; a split shot's parts are `<id>.1`, `<id>.2`…; the message says when an id was merged or split).
- Eases: a shot's `camera.ease` must be the reference shot's fitted ease in `motion.json` for the form `ease.pick` names: the same `gsap` name, a `cubicBezier` within 0.001, or `spring.remotion` within 1%. A missing `motion.json` or fit names its fix.
- Colour: each shot's `colour` target within a CIE76 distance of 2 of the measured corrected shot, unless a swap lists the shot in `swaps[].shots`. With the reference media present, each corrected shot (split parts and merges too) is measured from it exactly as `ref:compare --tolerance replica` reads its reference side; without it, `shots.json` `colour` stands in (a merge averaged by samples, a split part unmeasured).
- `replica-shots.json` beside the spec is out of step with its frames. `--write-shots` writes it.

`metadata.specSha256` is the hash of the spec checked and `ref:compare --tolerance replica` reports `renderSha256`, so the film chain's `replica` route ([production chain](production-chain.md#the-replica-route)) holds each result to the exact spec and render it read.

`warnings` cover what is advice: no `edit.json`, no measured colour (media missing), a moving camera without an ease, an `ease.pick` other than the fit's, screen text measured in a shot whose `type` is empty. `metadata.measured` lists every corrected reference shot with its frames at the spec's `fps`, transition, `colour` and `text`: the screen-text items whose onset falls in the shot, with the OCR box as shares of the (cropped) frame, `heightShare` and `centre`. That is the typography measurement: line-box height and position from the local OCR engine, not font, weight or tracking, which stay judged from strips.

## Strips against the reference

`motion:strip --vs <reference> [--vs-range start:end]` samples the reference stretch into as many frames as our window and puts each reference row (`REF`) directly above the matching row of ours (`OURS`), so a build, a hit and a hold line up. Pass the reference directory (or its `media/source.*`): the cropped copy is used when there is a crop. Without `--vs-range` the same times are used. A reference stretch that comes out black in 80% of frames stops with `VALIDATION` rather than drawing a false comparison. `metadata.frames[]` gives each tile's `timeSec` and `referenceSec`.

## Climax shape

`film:targets` and `film:measure` draw a tension curve for the film they measure, the same way for a reference and a render: loudness (RMS dB) of the sound, frame change, cut density and flashes (brightness above its running median), each mapped from its 5th-95th percentile to 0-1 but never stretching a range smaller than a viewer notices (`JND` in `src/lib/film/tension.ts`: 6 dB, 0.02 frame change, 0.5 cuts a second, 0.05 brightness), with dead zones taken off frame change and flashes first. The weights are ReelMimic's renormalised over these four; its optical-flow camera, local motion and spectral flux are not measured here. The curve and its three most prominent peaks are kept in the evidence (`tension`).

The climax is the peak with the largest prominence times height. `film:targets` records it in `measuredFrom`: `climaxTimeSec`, `climaxTimeShare`, `climaxHeight`, `climaxProminence`, `climaxBuildSlope` (curve per second over up to 8 s before the breath), `climaxBreathSec` and `climaxBreathDepth` (the dip before the hit), `climaxRiseFrames` (video frames from the bottom of the dip to 90% of the hit), `climaxHoldSec`, `climaxDecaySec` and, with a beat grid, `climaxBeatOffsetFrames` (negative lands before the beat). Its `climax` ranges are: place within 15% of the film of the reference's, prominence at least 60% of it, a breath at least half as deep when the reference holds one (depth 0.1 or more), at most 1.8 times the frames to land plus 2, a hold at least half as long when the reference holds over 0.3 s, and within one frame of the beat when the reference's hit is on it.

`film:measure`'s `climax-shape` leg compares the render's climax with these and only warns: it never fails a film. It is skipped when the targets have no `climax` (written before this, or by hand).
