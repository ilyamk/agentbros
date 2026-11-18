---
id: curve-character
name: Curve as character
intent: "The same move reads differently by curve: choose it by what the object is."
route: remotion
timing: 40-frame move from frame 16 for each of four curves
curve: expoOut, inOut, overshoot, anticipation
primitive: curves, progress
demo: CurveBookL
sources: ["src/motion/lab/CurveBook.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Prints four curves as a specimen, with a block moving on each while its graph draws.

**When it fits.** Choosing a curve: `expoOut` for headlines, `inOut` for whips and short camera moves, `overshoot` for objects with weight, `anticipation` for leaving.

**When it does not.** As a film technique in itself: it is a reference for choosing, unless the film is about motion.

**Timing.** All four run for the same 40 frames, so the difference is only the curve. `curves` in `src/motion/timing.ts` holds the exact values, plus `expoIn` and `drift`.

**Read.** `src/motion/lab/CurveBook.tsx`

**Pitfalls.** `overshoot` and `anticipation` pass outside 0 to 1. Clamp anything that cannot go out of range, such as opacity.
