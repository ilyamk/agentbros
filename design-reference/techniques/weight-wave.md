---
id: weight-wave
name: Weight wave
intent: "Variable font weight is the motion itself: a front passes through the word and leaves it heavy."
route: remotion
timing: Front crosses the word over frames 6 to 44; settles from wght 90 to 900, peak 1000, spread 1.8
curve: drift
primitive: Glyphs, glyphWeight, useFittedFontSize
demo: WeightWaveL
sources: ["src/motion/lab/WeightWave.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Moves a wave across the glyphs of one word. Each glyph peaks as the front passes, then settles at a heavier weight.

**When it fits.** A word about weight, pressure or growth, in a face from `lib/fonts-cyrillic.ts`.

**When it does not.** Static faces from `lib/fonts.ts`: those use `loadFont`, so the weight snaps between faces.

**Timing.** 38 frames for seven glyphs. The word is fitted at peak weight, so the wave cannot overflow the frame.

**Read.** `src/motion/lab/WeightWave.tsx`

**Pitfalls.** Weight changes width: anchor the word or give it a line of its own, or neighbours reflow.
