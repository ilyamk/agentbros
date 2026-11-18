---
id: light-path
name: Light path and slice
intent: A glowing head draws a thin line that leads the eye, stays as a curve, or cuts a word in two on a hit.
route: remotion
timing: 14 to 30 frames to draw; slice 8 frames
curve: inOut on the draw, expoOut on the slice
primitive: LightPath, SliceWord
demo: LightPathDemoL
sources: ["src/motion/backgrounds.tsx", "src/motion/kinetic-type.tsx", "src/motion/lab/KineticDemos.tsx", "src/motion/lab/KineticLab.tsx"]
status: demonstrated
---

**What it does.** Draws an SVG path by dash offset with a head at the true point on the path. `SliceWord` clips a word along a line and slides the pieces apart.

**When it fits.** A carry between two shots: the line leaves one word and arrives at the next. A negation: a cross or slice through a word.

**When it does not.** As a decoration with no start and end points in the composition.

**Timing.** Reference: ref-service-explainer 3.8 s (lasers and slice at about 3.9 s), 6.4 to 7.5 s and 39.2 s (comet).

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** `SliceWord` cuts in its own box and `LightPath` draws in stage pixels, so aligning them is by hand. Check the cut crossing at the hit frame.
