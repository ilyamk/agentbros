# Motion grammar

A repertoire to reach for once the idea is clear, arranged by the moment you are in and what it has to mean. Nothing here is required, and using many things once each makes an effects reel. Choose by what the shot says and how the music moves. Pace comes from the reference's numbers and the music, not from this page.

Each entry names a primitive from `src/motion` or a card in [techniques](../../../../design-reference/techniques). How to call a primitive is in [src/motion/AGENTS.md](../../../../src/motion/AGENTS.md), which also lists kinetic type primitives as they arrive. A card gives timing, a demo and pitfalls. Timings here are frames at 30 fps and are starting points.

The one hard rule: every value is a pure function of the frame. Any frame opened directly must look the same as that frame reached by playback. Randomness comes only from `random(seed)`.

**Find it by moment:** [the camera](#the-camera) · [crossing a boundary](#crossing-a-boundary) · [something arrives](#something-arrives) · [type as performer](#type-as-performer) · [landing and leaving](#landing-and-leaving) · [building a frame](#building-a-frame) · [rhythm of the film](#rhythm-of-the-film) · [endings](#endings) · [build notes](#build-notes)

## The camera

A camera has an operator. The difference between a move and a keyframed slide is how late it follows, how it lands and whether it has a reason.

| Moment | Move | Reach for |
|---|---|---|
| A subject is travelling | Follow it a little behind, then catch up as it slows | `Camera` with a `track` keyed a few frames after the subject; `camera-2-5d` |
| The next thing lands elsewhere | Snap to the landing point, fast out and slow in, with blur only at speed | `track` with `inOut`, `Shutter`; `shutter-motion-blur` |
| Attention tightens | Push in while the thing is happening, not after it | `Camera` `dolly`, or `RegionCamera` on an interface; `real-interface-playback` |
| Showing what it was part of | Pull back through something that changes meaning | `Camera` `dolly`, `DepthLayer` |
| A hit | A small shake on the landing, decaying in a few frames | `shake`, `cuePulse` |
| A person is holding it | Faint hand wobble while it travels; steady once it settles on a detail | `shake` at low amplitude |
| A hold that must still live | A breath, not a drift: a few pixels of seeded wander, a slow scale in and out, a faint roll; a punch-in on the hit that releases by itself | `camera-breath` block (`breathPose`) |
| Nothing should move | Lock it, and state what moves instead. A locked frame after movement is loud | |

Plain ground hides camera travel, because the eye has nothing to measure it against. Give it depth marks or a far plane. A constant drift on every shot is a screensaver. Vary moves through the film, at least four kinds.

## Crossing a boundary

Name what the eye follows from one shot into the next. If there is nothing, the viewer simply gets a new picture.

| What it means | How it crosses | Reach for |
|---|---|---|
| These two things are linked | One element keeps moving through a hard cut | `MatchCut`; `match-cut` |
| One shape becomes another | The old shot pushes in on its subject; the cut lands where the new subject has the same place and size; the new shot pulls back to say what the shape is now | `match-cut` block (`MatchCutMove`); put the cue on its `seamFrame` |
| The action caused the next scene | The next scene opens from the thing that was pressed or hit | `shapeWipe`; `shape-wipe` |
| The change of place has energy | Both shots move together under one blur | `whipPan`, `cutTiming`; `whip-pan`, not more than two or three in a film |
| This is the argument's thread | One element stays above the cuts and takes new roles | Render it above the series, see [build notes](#build-notes) |
| The message flies past to reveal the thing | A headline or logo scales through the lens, the next scene already in place behind it | `track` with `expoIn`, `VelocityBlur` |
| A brand shape opens onto the next scene | The shape grows until its hole is the frame | `shapeWipe` with a custom shape |
| Going inside something | The target stays fixed and everything grows around it | See [build notes](#build-notes) |
| One selected from many | The chosen item expands until it is the next workspace | `RegionCamera`, or a `track` on its box |
| An object covers the lens | Paper, a hand or a passing thing is the wipe, and it brings the next shot with it | Author both sides from the same object; `camera-2-5d` |
| Same process, new words | A line or rail survives while the text changes | `Trail`, `@remotion/paths` |
| A look matters more than a meaning | A named shader | `hyperframes-shader-transition`, by [engine selection](../../engine-selection/SKILL.md) |
| Rhythm, and it is meant | A bare hard cut, in a burst or on a stop. State why | `cueFrame` |

Match direction and speed across a cut, and cut 2 to 4 frames before the thing would settle. Keep one wipe direction through a run of similar shots. Check both sides of the boundary in a frame strip.

## Something arrives

The entrance comes from what the thing is doing in the story. If two neighbouring things arrive the same way, ask whether they mean the same.

| What it means | Entrance | Reach for |
|---|---|---|
| Heavy, final | Falls, lands with weight, shakes the frame | `track` with `overshoot`, `shake`; `curve-character` |
| Composed, considered | Rises from behind a mask, then the emphasis lands | `MaskedLine`, `MaskedLines`; `masked-lines` |
| Filling the frame like print | Line by line to the column's width | `FittedLine`, `linesFor`; `poster-stack` |
| One word is the event | Letters land separately, repeatable disorder | `Glyphs`, `stagger`; `seeded-glyph-stagger` |
| A list that adds up | Builds on one axis, the order saying something | `stagger`; `stagger-maps` |
| A value changing | Rolls, with its unit visible and blur only at speed | `VelocityBlur`, `track` |
| A correction | The old one is struck through and replaced | `@remotion/paths` for the stroke |
| A result being produced | The shell first, then its regions fill in order | `stagger` |
| A state changing | No entrance: it changes in place, on the hit | `cuePulse` |
| Overload resolving | Many arrive and collapse to one actor | `stagger`, `track` |
| Already there | Revealed by what leaves | Author it behind |
| Real material | Plays inside the world, with the camera taking you to the action | `ScreenPlayback`, `DeviceFrame`; `device-playback` |
| Physical, must be believed | Falls and collides for real | `blender-physical-pour`, by the [Blender skill](../../blender-3d/SKILL.md) |

Frame 0 of a film is a finished composition, never a half-entered word.

## Type as performer

A word is an actor. It has weight, it gets hit and it reacts. Type carries the frame only when treatments change with meaning, and when the reader still has time to read.

| What the word does | Reach for |
|---|---|
| Weight runs through it as the sound passes | `glyphWeight`; `weight-wave` |
| Fills the frame by size alone | `FittedLine`; `poster-stack` |
| Is hit by the sound: pushed, then returns | `cuePulse`, `audioPulse` |
| Is cut, pressed, stretched or bent by something in the scene | Kinetic type primitives, in [src/motion/AGENTS.md](../../../../src/motion/AGENTS.md) |
| Streaks past as the camera hits it | `VelocityBlur` |
| Sits in the world rather than over it | `DepthLayer`, and an object can occlude it |
| Keeps its place while a new word replaces it | `MaskedLine` per line |

Size words by meaning: one huge, the small ones beside it. Over voice, bind each word to its timestamp and land 1 or 2 frames before the syllable. As punctuation between sections, a big word can take one or two beats, then a hard cut. Reading time is not negotiable: if pace forces text off early, cut words. Inline-block glyphs lose kerning, so check large mixed-case words. Set line breaks by hand per format.

## Landing and leaving

The basic shape of a kinetic film. The eye arrives slowly enough to read, and the exit is fast enough to throw it onward. A move at one even speed is dead at any speed.

| Moment | Shape | Reach for |
|---|---|---|
| Landing | Fast arrival, long settle | `curves.expoOut` in a `track` |
| Landing with weight | Passes the target once, 3 to 8% | `curves.overshoot`, or `spring` with `measureSpring` |
| Readable, then gone | Barely moves, then accelerates away | `curves.expoIn` on the exit, starting on a cue |
| Fast motion | Real blur, only while it moves | `Shutter`, `VelocityBlur`, `Trail`, `motionSigma` |
| A stop as an event | Everything halts on one frame, on a planned sound | A `track` with no ease, `cueFrame` |
| Weight carries past the stop | A tag, a card or a word swings once past where it stopped and settles within half a second | `followThrough` added to the stopped value |

Name the ease by what the move should feel like, so plan and build agree: `intentCurves.snap` (position to position, interface moves, whips), `brake` (thrown into place: the confident entrance), `settle` (comes to rest with one small give, about 4%), `punch` (passes the target once, about 10%: hits, stamps, numbers that land), `glide` (long even travel: camera moves, parallax), `float` (barely moves at either end: breathing, ambient drift). Choose the curve by what the object is, not one per film: `curve-character`. Do not end two neighbouring shots the same way, except in a burst. Anticipation of 2 to 4 frames in the opposite direction adds force.

## Building a frame

A frame is rarely one element on a flat fill, and motion has a hierarchy: one main move, supporting staggers, and fine detail, overlapping. If the whole frame starts and stops on each beat, it reads as slides.

| Layer | Purpose | Reach for |
|---|---|---|
| Far plane, moving differently | The frame becomes a place | `DepthLayer`, `Camera`; `camera-2-5d` |
| Foreground passing the lens | Depth, and a natural wipe | `DepthLayer` with a negative depth |
| Focus | Says where to look | `Camera` `focus` |
| A small persistent detail | Continuity between shots | Render above the series |
| Light and grain | Holds dark ramps together, gives material | `FilmGrain`, `grainSeed` |
| Material over the frame | Paper fibre for print and collage, a halftone screen for posters, scan lines for a screen; low opacity, still unless the story moves it | `texture-overlay` block, or `FilmFinish preset="tactile"` |
| A finished look for the whole film | One finish preset instead of hand-set numbers: `clean` for interface and product, `filmic` for shot material and mood, `tactile` for paper and editorial | `FilmFinish preset` |
| Subject at scale | 60 to 85% of the usable frame in feature beats | `coverScale`, `useFittedFontSize` |
| Real material | Real interface and output, not a rectangle standing in | `WindowFrame`, `DeviceFrame`, `Cursor`; `real-interface-playback` |
| Data, when it is the point | Registered to what it describes | [SKILL](../SKILL.md) on charts |

A frame enters in reading order: the hero alone, the support after a breath of about 10 frames, the detail on a quick stagger of 3. If all three arrive together, nothing leads. `hierarchy({ hero, support, detail })` gives the frames; the `hierarchy-reveal` block is the typographic case. Vary scale and axis between neighbours: macro, wide, overhead, close interface, type. Keep one or two things to read at a time: dense does not mean competing. Show cause and effect, so that every action visibly produces its result.

## Rhythm of the film

| Moment | Means | Reach for |
|---|---|---|
| A burst | Several big changes inside 1.5 s, on a run of hits, then out | `cueFrames`, `layoutSeries`; `cue-grid-beat-cuts` |
| One clear acceleration | Shots get shorter towards a turn | The cue sheet, by section |
| A breath | One long shot where the music rests. It still has one thing moving | `energyAt` to tie it to the track |
| Time itself bends | Slow, a surge with blur that grows with the speed, slow again, landing the return on a hit; continuous, never a stutter | `timeRemap`, `speedAt`; `speed-ramp` block. An RGB split on the surge only with a story reason: `chroma-edge` (sparing) |
| A stop | The loudest moment: picture and sound halt together, once | `cueFrame` on a `stop` cue |
| Picture played by the music | A push on the kick, glow with the high band | `audioPulse`, `energyAt` |

Speech comes first: never move a cut off the sense of a sentence to catch a beat. Hits take a small accent, not a jump in everything. Silence gaps of 400 ms or more are the cleanest cut points in speech. Every cut has to work on both tracks at once.

## Endings

The final frame does not fade unless the script intends it. It serves as thumbnail and loop frame, so the last composition must be complete and readable for as long as its words need. A slow camera drift can continue under it. For a seamless loop, make the last frame match the first or move through it with a match cut. Check reveal, hold and last frames in every format; text contrast while moving as well as at rest; and the same frame opened directly and reached by playback.

## Build notes

For moves with no primitive yet. Installed: `@remotion/transitions`, `@remotion/paths`, `@remotion/light-leaks`, `@remotion/three`, `@remotion/motion-blur`, `@remotion/shapes`, `@remotion/noise`, `@remotion/layout-utils`, `@react-three/postprocessing`.

### Thread element above the cuts

Render it above the `<TransitionSeries>`, in the composition, so that scene changes never touch it. Drive it from global frames, with cut positions from the shared timeline. Reposition over 8 to 14 frames straddling the cut.

```tsx
const x = interpolate(frame, [cutA - 6, cutA + 6, cutB - 6, cutB + 6], [120, 540, 540, 900], { ...clamp, easing: inOut });
```

### Zoom-through

12 to 20 frames with `expoIn` on the outgoing scene, while the incoming scene settles from about 1.4 to 1 over 12 to 18 frames with `expoOut`. Overlap by 2 to 4 frames. Put `transformOrigin` on the target so it stays fixed, then scale from 1 to 8 or more, and fade only over the last 2 or 3 frames to hide the hand-over. `zoomBlur` and `crossZoom` in `@remotion/transitions` draw through WebGL: confirm them in a real render before relying on them.

```tsx
const scale = interpolate(frame, [0, 16], [1, 12], { ...clamp, easing: expoIn });
<AbsoluteFill style={{ transform: `scale(${scale})`, transformOrigin: `${targetX}px ${targetY}px` }}><Outgoing /></AbsoluteFill>
```

### Speed ramps

To show a detail in footage: fast approach, slow on the moment, fast out. Ramp over 6 to 12 frames into 20 to 40% speed, stay 15 to 40 frames, ramp out over 4 to 8. Rarely suits a person speaking.

For graphics, remap time with `<Freeze>`. The mapping must always increase, unless a rewind is intended.

```tsx
const local = interpolate(frame, [0, 10, 40, 48], [0, 24, 34, 60], clamp);
<Freeze frame={Math.round(local)}><AnimatedChild /></Freeze>
```

For footage, `playbackRate` is constant per `<Video>`: use consecutive `<Sequence>` segments, each with its own rate, and advance `trimBefore` by what each one consumed. Six or more segments hide the steps.

```tsx
let source = clipStart;
segments.map(({ from, frames, rate }) => {
  const trimBefore = Math.round(source);
  source += frames * rate;
  return <Sequence key={from} from={from} durationInFrames={frames}>
    <Video src={src} muted trimBefore={trimBefore} playbackRate={rate} />
  </Sequence>;
});
```

Audio for the ramp comes from a separate track. Slowing below 50% exposes repeated frames in 30 fps footage, so bake a slow-motion source or capture at a higher frame rate. Check the seam frames in a render.

### Cuts without a cue sheet

In template mode, or with no map, frames per beat are `1800 / BPM`. Compute each position from the start, `Math.round(n * 1800 / BPM)`, so that rounding errors do not build up. In the bespoke chain, frames come from the cue sheet through `cueFrame`.

### Effects that follow a subject

One world-to-screen function per shot: the camera's transform applied to world coordinates. Every follower (iris, zoom target, spotlight, leader line, label) goes through it; a hand-typed screen position drifts off the subject as soon as the camera moves.

### Stepped looks

Stop-motion, pixel and cel looks animate on twos (`Math.floor(frame / 2) * 2` for the drawing), but the camera and the light move every frame: a stepped camera reads as lag.

### True 3D

Use `<ThreeCanvas>` and set the camera from `useCurrentFrame()`. R3F's `useFrame` is forbidden. For real perspective in CSS, set `perspective: 1200` on the parent and `translateZ` per layer. For cut-out layers from one image, split the subject and keep the original.

## Sources

Adapted from motion-video-kit business-motion-film references/motion-grammar.md and launch-film-notes.md (MIT, echris6): foreground as transition, persistent actor, density through hierarchy, landing and exit, cause and effect, and several mechanisms above. Adapted from lemo-opuscar DIRECTOR.md §8 and TECHNIQUE.md §2 (MIT, LemoLab): camera moves with reasons, one world-to-screen function, stepped drawing with a smooth camera. Adapted from video-use SKILL.md, cut craft (MIT, Browser Use): silence gaps, both tracks at once. Adapted from code-video-showcase references/big-card-and-typography.md (MIT, Moessif): a big word as punctuation.

### Micro-craft helpers

From `src/motion/timing.ts`. A speed ramp's curve must stay inside 0..1, or the source would run backwards; `timeRemap` refuses it.

```tsx
const plan = hierarchy({ hero: 1, support: 1, detail: 3 }, { at: 6 }); // hero 6, support 16, details 23, 26, 29
const rise = progress(frame, plan.hero[0], 20, intentCurves.brake);
const tilt = followThrough(frame, landAt, { amplitude: 3 }); // 3 degrees past the stop, gone in half a second
const ramp = [{ at: 30, speed: 4, ramp: 10 }, { at: 64, speed: 0.25, ramp: 14 }];
<Freeze frame={timeRemap(frame, ramp, 0.3)}><Shot /></Freeze> // or the speed-ramp block, which adds the blur
```
