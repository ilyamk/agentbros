# Motion primitive examples

Read the matching example before composing a primitive. Source paths in this guide are relative to `src/motion/`.

**timing** — cues from seconds, then an accent on the frame:

```tsx
const cues = beatGrid(fps, 120, 8);
const scale = 1 + 0.05 * cuePulse(activeCue(cues, frame) ?? cues[0], frame);
const x = track(frame, [{ at: 0, value: -400 }, { at: 16, value: 0, curve: "expoOut" }, { at: 40, value: 20 }]);
```

**music** — cuts from the cue sheet, a kick that pushes and energy that opens:

```tsx
const shotTwo = cueFrame(sheet, "cut-002");
const push = 1 + 0.04 * audioPulse(frame, fps, map.events, { offsetSec: sheet.musicOffsetSec, kinds: ["kick"], minStrength: 0.4 });
const glow = energyAt(frame, fps, map.energyCurve, { offsetSec: sheet.musicOffsetSec, band: "high" });
```

**text** — hand-set breaks, fitted lines, masks that cannot clip Й Ё у р щ д:

```tsx
const lines = linesFor({ vertical: ["КАЖДЫЙ КАДР", "ФУНКЦИЯ"], fallback: ["КАЖДЫЙ КАДР ФУНКЦИЯ"] }, formatOf(width, height));
lines.map((line, i) => (
  <FittedLine key={line} text={line} withinWidth={column} fontFamily={cyrillicCondensedFont} fontWeight={800}>
    {(fontSize) => <MaskedLine reveal={progress(frame, i * 5, 22)} lineHeight={0.84} style={{ fontFamily: cyrillicCondensedFont, fontWeight: 800, fontSize }}>{line}</MaskedLine>}
  </FittedLine>
));
```

**transitions** — duration from the layout, whip timing always linear:

```tsx
const layout = layoutSeries([{ id: "a", frames: 60 }, { transition: 9 }, { id: "b", frames: 60 }]); // layout.totalFrames === 111
<TransitionSeries.Transition presentation={whipPan({ direction: "left" })} timing={cutTiming(9)} />
<TransitionSeries.Transition presentation={shapeWipe({ shape: "play", originX: 1500, originY: 540, fromSize: 128 })} timing={cutTiming(16)} />
<MatchCut cutAt={44} before={<Stop />} after={<Dawn />} carry={<Dot />} />
```

**camera** — one pose, every layer derives its parallax and focus:

```tsx
const hand = shake(frame, { seed: "desk", amplitude: 5, rollAmplitude: 0.12 });
const pose = { x: track(frame, panKeys) + hand.x, y: hand.y, dolly: track(frame, pushKeys), roll: hand.roll, focus: track(frame, rackKeys) };
<Camera pose={pose} lens={{ aperture: 0.024 }}>
  <DepthLayer depth={700} overscan={400}><BackSheet /></DepthLayer>
  <DepthLayer depth={0}><Table /></DepthLayer>
</Camera>
```

**fx** — blur only while moving, grain over dark ramps:

```tsx
<Shutter windows={[[0, 22], [38, 56]]} samples={16} shutterAngle={220}><Stage /></Shutter>
<VelocityBlur axis="y" speed={velocity(drum, frame) * rowHeight} maxBlur={70}><Rows /></VelocityBlur>
<FilmGrain seed="dusk" opacity={0.2} frequency={0.72} />
```

**ui** — zoom the viewport; cursor and footage share stage coordinates:

```tsx
<WindowFrame width={1500} height={892} title="Remotion Studio">
  <RegionCamera stage={{ width: 1500, height: 848 }} frame={frame} keys={zoomKeys}>
    <ScreenPlayback kind="video" src="motion-lab/studio-recording.mp4" />
    <Cursor keys={cursorKeys} clicks={[104]} size={24} />
  </RegionCamera>
</WindowFrame>
```

**kinetic** — one cue sheet drives a stack: a word, its hit on the ground, a persistent caption:

```tsx
const hit = cueFrame(sheet, "hit-1");
const energy = energyAt(frame, fps, map.energyCurve, { offsetSec: sheet.musicOffsetSec });
<LivingLight ground={night} lights={[indigo]} energy={energy} flash={hitDecay(frame, hit, 6) * 0.5} />
<RadialField energy={Math.max(energy * 0.4, hitDecay(frame, hit, 18))} color={chalk} />
<Slam motion={{ at: hit, tilt: { y: -22, z: -6 }, exitAt: hit + 26, exit: "left" }} pulse={audioPulse(frame, fps, map.events) * 0.02} style={type}>КАЖДЫЙ</Slam>
<BuildingCaption words={[{ text: "Каждый", at: hit }]} color={chalk} tagColor={pink} tagTextColor={coal} />
```

`lab/KineticDemos.tsx` holds one demo per piece and `lab/KineticLab.tsx` stacks them against one synthetic cue sheet, with `lab/motion-check.allow.json` for its intended exceptions. The numbers in the defaults were measured from the reference films; the notes are in each `design-reference/techniques/` card.

