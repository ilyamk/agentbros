# motion-director: worked examples

Moved out of `.agents/agents/motion-director.md`. Read before writing a first plan.

## Bad: our own film, read as a plan

`src/motion/showcase`, rebuilt as a plan and run through `plan:check` against one reference, failed six dimensions: median 4.2 s against 0.42–1.51 s, 7.4 shots per 30 s against at least 10.6, four shots on a still camera with one layer for over 1.43 s, the same masked rise on 67% of shots, and none of its eight boundaries saying what crosses them.

```json
{ "id": "thursday", "durationFrames": 126, "camera": "static", "composition": "big word on orange fill", "entrance": "masked lines rise", "exit": "cut", "layers": ["type"], "transitionToNext": "cut" }
```

The turn of the film: a title card held 4.2 s, with the entrance every other word had. Nothing hits it, nothing crosses out of it.

## Bad: a plan that passed and was still wrong

A first draft of a knife-sharpening test film passed at risk 0. Read against the map:

- The fastest cuts sat over a stretch with few strong events, while the real run of kicks at 12.2–13.0 s played under one long stroke.
- `beatSync` said "nothing hits until the surge", while the map had an onset every 0.17 s. Those ticks became the idea: the edge goes flat one tick at a time.
- "The first bass is the blade hitting the board" was put on the surge, but the low band returns 0.5 s later.
- One macro take was split at a change in sound and counted as two shots.
- Ten-frame shots listed "tendons shift in the wrist" to reach two layers.
- Twenty-two entrances were twenty-two wordings of about ten treatments.

## Good: a shot that can be built (plan only, not yet built)

```json
{ "id": "s19-line", "startFrame": 396, "durationFrames": 109, "intent": "signature 1: in the quiet the ragged edge goes flat, one tick at a time, until it is a single line of light", "subject": "the edge in extreme close-up: a ragged ridge like a skyline, flattening to a line", "subjectFill": 0.8, "framing": "extreme macro along the edge, ending with the line as the only horizon", "composition": "extreme macro on the horizontal, ridge then line in the middle third; still: the dark steel below", "blocks": ["LightSweep"], "layers": ["one bead of water runs along the ridge and falls off", "the ridge flattens right to left, a section on each tick", "a thin glint runs ahead of the camera"], "camera": "barely travels right, 2% until the bass goes and 6% after, because the result is shown one inch at a time", "entrance": "holds dead, the stillest frame of the film", "exit": "falls away, the line drops out of frame and takes the eye with it", "curve": "linear until the last 8 frames, then expoIn on the line", "beatSync": "quiet from 13.21; bead falls on the tick at 13.48; bass gone from 14.88; flattening on the onsets every 0.17 s from 15.04 to 16.59; thump at 16.25 completes the line", "carry": "the line of light at centre frame: it drops and is the cut through the tomato at the same x", "route": "blender", "techniqueIds": [] }
```

## Carries

| Fails | Passes |
|---|---|
| "whip" | "the blade's direction: right to left at full speed, the next shot's stone continues it at the same height" |
| "the product" | "the paper itself: it fills the frame, lifts, and is the parcel in the walking hand" |
| "smooth transition" | "hard-cut: the music drops on this frame and picture and grinding must stop with it" |

## Grid trust detail

| Grid | Hang cuts on | Snap with | Never |
|---|---|---|---|
| `reliable` | Downbeats, strong hits; single beats only in a burst | `downbeat`, `key-moment`, `event`, `beat` in a burst | Cutting every beat for long (174 BPM = 0.35 s metronome) |
| `reliable`, outside `beatsSec` | Phrases, sections | `phrase`, `key-moment` | Extending the grid past where it was measured |
| `weak` | Phrases, sections, key moments, real events | `phrase`, `key-moment`, `event` | `beat` or `downbeat` |
| `none` | Phrases, sections, energy | `phrase`, `key-moment` | Any imposed pulse |
| Silence | The picture's own causes | — | A rhythm on an invented grid |

Sources: motion-video-kit business-motion-film (MIT, echris6); lemo-opuscar DIRECTOR.md §7–8 (MIT, LemoLab).
