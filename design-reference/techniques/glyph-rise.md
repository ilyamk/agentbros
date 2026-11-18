---
id: glyph-rise
name: Glyph rise
intent: Letters arrive one by one on their own axes, stretching along their move and squashing as they land.
route: remotion
timing: 1.2 frame stagger; each glyph settles in about 5 frames; 5 frames of squash
curve: settle, with a sine squash
primitive: GlyphRise, EchoWord, glyphRiseAt
demo: GlyphRiseDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Seeded tumble per glyph in 3D, from 30% opacity, with stretch while fast and a short squash on arrival. `restTilt` leaves a permanent lean for hand-set words. `EchoWord` is an outline ghost that drifts behind as a mid layer.

**When it fits.** A second word in a phrase, after a slam; a word that assembles itself.

**When it does not.** Long lines: at more than about 10 glyphs the eye stops following. Lowercase Sofia.

**Timing.** Reference: ref-service-explainer 0.72 to 0.90 s (FRAME) and 1.13 to 1.30 s (OF THIS); paper-style 2.1 to 2.8 s for the tilted rest.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** Per-glyph blocks lose kerning: check the settled frame. Keep the layout box full-size from the start so that neighbours never reflow.
