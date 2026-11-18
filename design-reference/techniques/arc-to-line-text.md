---
id: arc-to-line-text
name: Word rises on an arc and straightens
intent: "Function reveal: an announcement word arrives bent and lands straight, so the entrance has a shape without blur or bounce."
route: remotion
timing: "rises from y 0.76 to 0.50 while the bend goes to 0 in 9 frames, power2.out; colour grey to the accent"
curve: power2.out
primitive: arcGlyphs, typeProgress, mixHex
demo: src/motion/library/typography/HeroWord.tsx
sources: ["design-reference/library/motionfly/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/HeroWord.tsx"]
status: draft
---

**What it does.** `entry: "arc"` on block `type-hero-word` (`heroWordArcPreset`). On the cut the word sits on a circular baseline that curves up at both ends, below its place; over the entry it rises to its place while the bend eases to straight and its colour goes from `arcInkFrom` to the ink. Each glyph keeps its arc length from the word's centre, so the word reads the same length bent or straight.

**When it fits.** One announcement word on a flat light ground after a hard cut ("Introducing", a product name); a beat that needs an entrance with character but no motion blur.

**When it does not.** Long phrases: the arc gets deep and the end glyphs tilt hard. Over footage with a busy horizon line: the curve competes with it.

**Timing.** motionfly 6.77-7.07 s (30 fps, F203-F212): hard cut to white, the word on an upward-curving baseline enters from centre y about 0.76 and rises to 0.50 while its curvature flattens in 9 frames; frame difference peaks F206-F207 then decays (power2.out); grey to #884295. Ours: 9 frames on power2.out, from 0.26 of the height below, an arc of 1.2 radians to straight.

**Read.** `src/motion/library/typography/HeroWord.tsx`, `src/motion/text-modes.ts` (`arcGlyphs`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** Glyph widths are measured one glyph at a time, so kerning pairs are lost while the word is bent; it snaps back to the kerned word once straight, one frame after the entry, which is invisible at this speed. The reference's later two-frame snap smaller (F233-F234) is a separate scale key: use `scaleKeys`.
