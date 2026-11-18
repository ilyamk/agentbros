---
id: scramble-decode
name: Scramble and decode
intent: A word corrupts from its first letter, holds as noise and resolves at once, with colour split at the peak.
route: remotion
timing: 15 to 18 frames; new glyphs every frame; spreads over 65%, resolves in the last 20%
curve: sine squared on the split
primitive: ScrambleWord, scrambleGlyphs, scrambleChroma
demo: ScrambleDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Replaces glyphs by a seed that changes with the frame, then restores the exact target. Natural glyph widths make the word breathe as it reflows, which is half of the effect.

**When it fits.** A word about code, secrets, translation or a state that changes. A second life for a word already on screen.

**When it does not.** A generic entrance on any word. It reads as a tech cliche unless the meaning needs it.

**Timing.** Reference: ref-service-explainer 2.3 to 2.8 s.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** `pool` must hold glyphs the face has. The default is punctuation any face here covers. Reflow is intended: anchor the word centre or edge on purpose.
