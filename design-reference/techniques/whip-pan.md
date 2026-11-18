---
id: whip-pan
name: Whip pan with computed blur
intent: A change of place with energy, where the blur on each frame matches the real speed.
route: remotion
timing: 9-frame whip between holds of 26 frames or more
curve: inOut
primitive: whipPan, cutTiming, layoutSeries
demo: WhipSentenceL
sources: ["src/motion/lab/WhipSentence.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Moves both scenes together and derives directional blur from the curve speed, so it peaks mid-move.

**When it fits.** A sequence of examples, or one sentence carried across several scenes.

**When it does not.** More than two or three in a row: it tires. Calm films, where it reads as a stock transition.

**Timing.** The demo runs three words with holds of 26, 28 and 46 frames around two 9-frame whips. Default shutter 0.15, about a 180 degree shutter, with a maximum blur of 140.

**Read.** `src/motion/lab/WhipSentence.tsx`, with durations in `src/motion/lab/reel-layout.ts`

**Pitfalls.** Give it `cutTiming`, never an eased timing, or the blur no longer matches the speed. Take the composition duration from `layoutSeries`.
