# Motion — Agent Rules

Last updated: 2026-11-21

Deterministic motion primitives for films that should not default to centred text fading over a gradient. Every value is a pure function of the frame; randomness only through remotion `random(seed)` or `noise2D(seed, ...)`. Import from `src/motion` in compositions; pure logic (`timing`, `text-split`, `series`, `camera-math`) needs no browser, so tests import those files directly.

The [motion grammar](../../.agents/skills/motion-and-typography/references/motion-grammar.md) says when each technique fits. Here is what exists and how to call it. `src/motion/lab/` holds one worked example per technique: read the matching piece before imitating it. `src/motion/showcase/` is one whole film built from them (composition `Showcase`), with its own entry, allow file and clip provenance.

```bash
pnpm motion:still --entry src/motion/lab/index.tsx --composition PosterStackL --frames 0,14,70 --output out/qa/me/poster
pnpm motion:render --entry src/motion/lab/index.tsx --composition LabReel --output out/qa/me/reel.mp4
```

| File | Exports | Reach for it when |
|------|---------|-------------------|
| `timing.ts` | `curves`, `progress`, `track`, `trackPoint`, `velocity`, `motionSigma`, `stagger`, `radialOrder`, `onSteps`, `beatCues`, `beatGrid`, `cueProgress`, `cuePulse`, `activeCue` | Anything that changes over time. A `track` with per-segment curves replaces chains of `interpolate`. |
| `timing.ts` (craft) | `intentCurves` (`snap`, `settle`, `glide`, `punch`, `float`, `brake`), `hierarchy`, `followThrough`, `speedAt`, `timeRemap` | Finishing a move: an ease named by its feeling, a frame entering in reading order, a swing after a stop, a speed ramp with no stutter (ramp curves must not overshoot). When each fits: [motion grammar](../../.agents/skills/motion-and-typography/references/motion-grammar.md). |
| `timing.ts` (music) | `cueFrame`, `cueFrames`, `audioPulse`, `energyAt` | Cuts and accents placed by the music: frames from an `edit:snap` cue sheet, reactions from an `audio:map`. Pass the sheet's `musicOffsetSec` as `offsetSec`; import the JSON in the composition, these helpers load nothing. |
| `ease-family.ts` | `easeFamily`, `familyProgress` | A reference's GSAP ease name (`circ.in`) as that exact shape, no GSAP. |
| `sync/` (`beatGrid.ts`, `CueSounds.tsx`) | `beatGridFromMap`, `fallbackGrid`, `beatAt`, `snap`, `snapFrame`, `shotLengthsFromSections`, `shotStarts`, `CueSounds`, `planCueSounds` | Picture and sound locked to the track: a parsed `audio:map` as frames (beats, downbeats, onsets, strong hits, surges, sections); `snap` with per-kind lead (cut 1 frame early, sfx on the frame, hit up to 3 early); shot lengths by section level; `fallbackGrid({bpm})` replaces a constant `beatFrames(bpm)` until the track exists; with `anchorFrame` it puts beat 0 (the drop) there, fills the beats before it and counts bars from it, and `beatAt(grid, k)` gives the frame of beat k (negative before the drop). `<CueSounds events>` plays `sfx:cues` output (or `planCueSounds` of block `cues()`) with `<Audio>` in Sequences. |
| `sync/curves.tsx` | `AudioCurvesProvider`, `useAudioCurve`, `AudioReactive`, `curveAt`, `curveIntegral`, `pulse`, `beatPhase`, `barPhase`, `useAudioCurvesFile`, `useAudioReact`, `demoCurves` | Motion that follows the music from `audio:curves` JSON (levels, bands, stems, kick/snare/hat/downbeat envelopes, beat and bar phase, energy; 0..1 per frame). Values interpolate sub-frames, phases wrap from the beat positions, speed comes from `curveIntegral` so it never runs backwards. The provider takes `curves` or a `src` under public/ (loaded once with `delayRender`) and puts the film's frame in reach of every block below: at the film root, a block inside `<Sequence from>` (or a `<Freeze>` there) reads the film's frame from the Sequence starts. An explicit `offsetFrames` overrides that: blocks read their own frame plus it. Remotion's `useAudioData`/`visualizeAudio` decode audio in the browser at render time and give FFT bins agents cannot read; prefer these curves. |
| `text-split.ts`, `text.tsx` | `splitGraphemes`, `splitWords`, `linesFor`, `MaskedLine`, `MaskedLines`, `Glyphs`, `glyphWeight`, `useFittedFontSize`, `useFittedLinesFontSize`, `FittedLine` | Type is the picture: poster stacks, masked lines, glyph events, weight as motion. |
| `series.ts`, `transitions.tsx` | `layoutSeries`, `cutTiming`, `whipPan`, `shapeWipe`, `coverScale`, `MatchCut` | A cut carries meaning. Use `layoutSeries` for every composition duration. A shape becoming a shape: block `match-cut`. |
| `camera-math.ts`, `camera.tsx` | `Camera`, `DepthLayer`, `projectLayer`, `shake`, `RegionCamera`, `regionTransform` | A flat layout must feel like a place, or the viewer must be taken to a detail. |
| `fx.tsx` | `Shutter`, `VelocityBlur`, `Trail`, `FilmGrain`, `grainSeed` | Fast object motion; dark ramps that band. |
| `ui.tsx` | `WindowFrame`, `DeviceFrame`, `ScreenPlayback`, `Cursor` | Showing real interface material. |
| `kinetic-math.ts` | `settle`, `hitDecay`, `hitsDecay`, `hitShake`, `smearAt`, `wordPose`, `wordSpeed`, `glyphRiseAt`, `dollyPosition`, `dollyWord`, `elasticEase`, `elasticAxes`, `scrambleGlyphs`, `scrambleChroma`, `captionWords`, `typingSchedule`, `typedCount`, `morphRect`, `growRect`, `collageCells`, `raceValue`, `odometerReels`, `radialLines`, `shockRingAt`, `lightBlobs` | Pure numbers under the kinetic pieces; tests import them. |
| `type-track.ts` | `caretTypingPlan`, `splitState`, `pullOutScale` and more | The pure numbers of three type blocks. |
| `kinetic-type.tsx` | `Smear`, `ZoomSmear`, `Slam`, `GlyphRise`, `DollyStack`, `ElasticWord`, `ScrambleWord`, `BuildingCaption`, `TypedLine`, `NumberRace`, `SliceWord`, `EchoWord` | Words that perform: land, stretch, corrupt, fly through the lens, type, race. |
| `layout-morph.tsx` | `LayoutMorph`, `GrowToScene`, `CollageGrid` | A container carries across a boundary, a button becomes the next ground, a grid divides on cues. |
| `backgrounds.tsx` | `RadialField`, `ShockRing`, `LivingLight`, `LightPath` | Any ground that would otherwise be a flat fill; lines and light that answer `energyAt` and hits. |
| `gsap.ts` (not in the index) | `useGsapTimeline`, `gsap`, `SplitText`, `MorphSVGPlugin`, `DrawSVGPlugin`, `MotionPathPlugin`, `CustomEase`, `Flip`, `TextPlugin`, the seeded `decodeText` plugin, `KINETIC_EASES`, `useFontsReady`, `toFrame` | Text splitting, SVG morph and draw, path travel and long orchestrated staggers. The only file that may import `gsap`; its header lists the rules. Blocks: `library/kinetic/`. |
| `fonts-flex.ts` (not in the index) | `flexFont` | The one face with a real width axis. Import it directly so that other films don't load it. |

## Examples

Read the [worked primitive examples](../../docs/motion-examples.md) and the [3D exhibition cut](../../docs/drei-techniques.md#six-original-demonstrations).

## Traps found by looking at frames

- **Masked reveals are the sanctioned exception** to the root rule against translating text in: the motion is hidden behind the mask, as the motion grammar describes.
- A mask bleed zone is visible while a line travels: a rising line shows up to `bleed.bottom` below its own box. Keep rows further apart than that, or pass a tighter `bleed` for capitals (see `lab/AlphabetStagger.tsx`).
- `Shutter` costs `samples` times the render of its children, and children get fractional frames: floor before seeding, keep windows short. Pass the shot's flat ground as `ground` (also on the library's `MotionBlur`), or set `opaque` when the children paint an opaque ground: the samples are then averaged exactly (each at 1/k over the k-1 beneath). Without either, samples are added with `plus-lighter`, which lifts every channel by a few levels, so a ground painted inside comes out lighter on blurred frames. At high speed, samples show as steps; blur each sample by the gap to the next (see `lab/ShutterStop.tsx`), or use `VelocityBlur`, one clean directional pass at no extra render cost, for large type crossing the frame.
- `whipPan` and `shapeWipe` shape progress themselves. Give them `cutTiming`, never an eased timing, or the blur no longer matches the speed.
- `useFittedFontSize` (one line) and `useFittedLinesFontSize` (the smallest size at which every line fits; captions use it per page) wait for the font, because `fitText` caches widths. Pass the text as displayed, cased; `textTransform` is not measured.
- A full stop or dot that carries through `MatchCut` stays on top of the next scene; author later foreground so that it never has to pass behind.
- `Glyphs` and per-glyph columns lose kerning. Do not add negative tracking on wide faces such as Unbounded, where neighbours collide.
- Sofia Sans Extra Condensed (`cyrillicCondensedFont`) uses Bulgarian lowercase forms, so д looks like g. Use it in capitals for Russian; use Golos Text for mixed case.
- `Sofia` tabular figures sit wide at thin weights; tighten with negative letter-spacing on large counters.
- `Smear` is a filter, and a filter inside a transform is scaled with it: divide speed by the parent's scale, or a word landing at 0.36 gets a third of its blur. `Slam` already does.
- At high speed a word's streak becomes one flat band unless its rows are cut; `Smear` cuts them from `rowCut`. Words with few horizontal strokes rely on this entirely.
- A variable face cannot overshoot past its axis limit: aim `ElasticWord` under the maximum (wdth 128 of 151), or the overshoot is flat.
- `-webkit-text-stroke` on a variable font draws its overlapping inner contours, so letters show lines inside. `EchoWord` builds its outline from the silhouette instead; do the same for any outlined word.
- A 3D transform (`perspective`, `rotateX`, `rotateY`) puts an element on a layer that keeps the raster scale it had earlier, so large creeping type differs between a frame reached in order and one opened directly, and `motion-check` reports `NON_DETERMINISTIC`. Go back to a 2D transform once the rotation has settled, as `Slam` and `GlyphRise` do.
- GSAP's default `force3D: "auto"` and lazy first renders both make a seeked frame depend on seek history (a settled glyph rasterised differently between render workers; a chained morph read its start too early). `src/motion/gsap.ts` turns both off; do not turn them back on. MorphSVG `type: "rotational"` also showed the wrong shape after a fresh seek past its end. `RUN_GSAP_RENDER_TESTS=1 pnpm exec tsx --test tests/gsap-determinism.test.ts` proves a block.
- `loadVariableFont` for Roboto Flex types its style as `"oblique 0deg 10deg"`, not `"normal"`. Upright text is still what renders.
- `DollyStack` words next in line show only once the camera starts to move; lower `far` to see them earlier, at the cost of a tiny smudge inside the current word.
- Interface zooms beyond about 1.5x need a capture at higher resolution than the frame. `public/motion-lab/studio-recording.mp4` is 2x.

## Lab assets

`public/motion-lab/` holds real captures: a Remotion Studio screenshot and frame-stepped recording, and the vertical poster render. They are git-ignored and private; manifest `public/motion-lab/sources.json` (family `lab`, [docs/assets.md](../../docs/assets.md)) names them, and a lab render stops with `ASSET_MISSING` when they are absent. Regenerate them when the Studio layout of the lab changes materially; they are illustrative footage, not reference pixels.

`viz/` displays prepared format-specific plans; layouts and data parsing remain in the Node-side domain library.
