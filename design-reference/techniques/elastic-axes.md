---
id: elastic-axes
name: Elastic axes
intent: A word stretches on real variable axes, landing past each target and ringing back, driven by cues.
route: remotion
timing: Lands in about 8 frames, overshoots once or twice; weight on later cues
curve: 1 - exp(-0.34 t) cos(0.55 t)
primitive: ElasticWord, elasticAxes, elasticEase
demo: ElasticDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/fonts-flex.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Sets `wdth` and `wght` per frame, with an x blur on the fast frames. Keys that omit an axis hold its value.

**When it fits.** A word about tension, size or change; a mid-scene life for a word that otherwise just sits.

**When it does not.** Faces without a width axis: only Roboto Flex here has one (`fonts-flex.ts`). Others hold still; use `scaleX` knowingly, as it distorts strokes.

**Timing.** Reference: ref-service-explainer 18.2 to 19.4 s.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** `flexFont` is imported on its own so that other films don't load it. Size the word at `wdth` 151 plus overshoot, or it leaves the frame.
