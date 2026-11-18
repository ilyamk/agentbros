# Replica spec

`public/projects/<project>/pipeline/replica-spec.json`, the build sheet and the round log, validated by `pnpm ref:replica-check --project <project>` against the reference (schema: `ReplicaSpecSchema` in `src/types/reference-replica.ts`). `--write-shots` writes `replica-shots.json` beside it from the spec's frames, for `ref:compare --render-shots`; never edit that file by hand. Details: [reference analysis](../../../../docs/reference-analysis.md#replica-spec-check).

Start from the check's `metadata.measured`: one row per corrected reference shot with its id, frames at the spec's `fps`, transition, measured `colour` and screen `text`.

## Shape

```json
{
  "reference": "<ref>",
  "fps": 30,
  "format": "vertical",
  "rights": { "status": "owned", "userStatement": "<their words>", "askedAt": "2026-11-13" },
  "swaps": [{ "what": "logo in s003", "from": "reference owner's mark", "to": "user's logo", "why": "another owner's brand", "shots": ["r03"] }],
  "shots": [],
  "rounds": []
}
```

One `shots[]` entry per reference shot, after `edit.json` `corrections`:

| Field | From |
|---|---|
| `id`, `referenceShot` | The corrected shot list: a merge keeps its first id, the parts of a split shot are `<id>.1`, `<id>.2`… |
| `startFrame`, `durationFrames` | From `measured`: start and length × fps, rounded; the first starts at 0, each where the last ends, and they sum to the reference's length within a frame |
| `transitionIn` | `shots.json` `transitionIn`, checked on `boundaries-NN.jpg`; gradual ones keep their span in frames |
| `framing` | What fills the frame and where, from the shot's strip and thumb: subject size as a share of height, position, safe margins |
| `camera` | `motion.json` `shots[].camera`, mapped as below; `kind` is required, and `ease` needs `pick` plus that form's field, equal to the fit |
| `cadence` | `shots[].cadence.framesPerDrawing` when it is 2 or 3 |
| `colour` | `{L, a, b, keyHues, source}`; see below |
| `type` | Each text element: words (or the user's swap), font or nearest licensed face, size as a share of frame height, weight, tracking, colour, position, how it enters and leaves (from screen-text spans and `onsetSec`) |
| `cues` | Sound events that land in the shot: beat, onset or hit, with frame offsets from `sync.json` |
| `blocks` | The library blocks and props that build it, or `new:<name>` |
| `content` | `keep` or the swap the user asked for |
| `confidence` | `measured`, `observed` or `rough` (camera `trackedShare` under 0.5, or no fit) |
| `unreachable` | Only for a mechanism out of reach: `{nearest, residual}` |

A swap that changes a shot's colour or type lists the spec shot ids in `swaps[].shots`, which exempts them from the colour check.

## Camera to code

Amounts are in frame widths and log scale: `x`, `y` move the camera right and down (the picture moves the other way, so translate by `-x × width`, `-y × width`), `z` is `log(scale)` (scale `exp(z)`), `r` is radians. Start the move at `camera.startSec`, after `holdBeforeSec`, and hold `holdAfterSec` at the end. Use the form `ease.pick` names:

| `pick` | Code |
|---|---|
| `spring` | `spring({ frame: frame - startFrame, fps, config: ease.spring.remotion })`. The fit is in real seconds (`stiffness = ω²`, `damping = 2ζω`, mass 1), so do not pass `durationInFrames`; it rescales the physics. It settles in about `ease.spring.settleSec` |
| `gsap` | A tween in `useGsapTimeline`, imported only through `src/motion/gsap.ts`, with `ease: ease.gsap`, from `startSec` for `durationSec` |
| `bezier` | `interpolate(frame, [startFrame, startFrame + durationFrames], [from, to], { easing: Easing.bezier(...ease.cubicBezier), extrapolateLeft: "clamp", extrapolateRight: "clamp" })` |

`ref:compare` judges the move on `span90Sec` (5% to 95% of the travel) and the 21-point `progress` curve, so check those, not only the start and end. Keep `overshoot`, `otherMoves`, `drift` and `shake` as separate layers on the same transform. Cadence on twos or threes is frame-pure: drive the animated values from `Math.floor(frame / n) * n`, never a timer.

## Colour

`ref:replica-check` measures each corrected shot's Lab from the reference media (mean and 10/50/90th percentiles in `measured[].colour`), the same way `ref:compare --tolerance replica` reads its reference side; `ref:analyze` keeps the detector shots' Lab in `shots.json`. Copy the mean into `colour` with `source: "measured"`; the check refuses a target more than 2 (CIE76) from it unless a swap lists the shot. Only when the media is gone and a shot is a split part is there no measurement: then fill it from `visual.json`'s palette and stills, then from the first `ref:compare`'s `shots[].colour.reference`.

## Type

`measured[].text` gives each screen-text line whose onset falls in the shot: words, times, the OCR box as shares of the frame, `heightShare` (line-box height) and `centre`. Use them for size and position; font, weight, tracking and line breaks come from the strips.

## Tolerances

`ref:compare --tolerance replica` writes findings at these and counts `held`, `failed`, `notMeasured` and `exempt` per measure in `summary.withinTolerance`. With `--project` (or `--spec`), shots in `swaps[].shots` are exempt from `lightness` and `warmth`. The constants are `REPLICA_TOLERANCES` in `src/lib/reference/replica.ts`; they are the source of truth.

| Measure | Holds when |
|---|---|
| `alignment` | The film's cut offset is at most 1 frame |
| `cuts` | Every reference cut has a cut here within 1 frame after that offset, and no extra cut |
| `coverage` | Every corrected reference shot has a replica shot |
| `shotDuration` | Within 1 frame or 3% of the reference shot, whichever is larger |
| `cameraKind` | `kindMatch` 0.8 or more |
| `cameraLength`, `cameraAmount` | Within 10% either way |
| `ease` | Same GSAP name, or a neighbour (`easeNote` gives the RMSE) |
| `lightness` | `emdL` 5 or less |
| `warmth` | Mean `b` within 4 |
| Type | Not measured by compare: `--vs` strip at the reading hold, same size, line breaks and position by eye |

A deliberate difference (the user's longer product name, their brand colour) is recorded in `swaps` and exempt from the matching tolerance; say so in the hand-over.
