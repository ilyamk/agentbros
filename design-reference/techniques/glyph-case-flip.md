---
id: glyph-case-flip
name: Glyph case flip, letter by letter
intent: "Function emphasis: a word changes register (soft to firm, lower to capitals) a letter at a time in reading order, a correction the eye can follow, with no random glyphs."
route: remotion
timing: "a letter about every frame at 30 fps (2-3 frames at the reference's 60), the six-letter word in about 0.15 s; steps, no tween"
curve: steps
primitive: caseFlipCount, otherCase
demo: src/motion/library/typography/ScrambleHero.tsx
sources: ["design-reference/library/gojiberry/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/ScrambleHero.tsx"]
status: draft
---

**What it does.** `flip: "case"` on block `type-scramble-hero` (`scrambleHeroCaseFlipPreset`): from `flipAt` each glyph swaps to its other case and from slanted to upright on its own frame, one every `flipStep` frames, left to right. The word is set as written; no glyph pool, no fringe.

**When it fits.** An answer word that "straightens up" after a question; a brand word moving from casual to confident; any word whose change of register is the point.

**When it does not.** Words with few cased letters (numbers, symbols). When the change should feel like corruption, use the scramble itself.

**Timing.** gojiberry 14.07-16.93 s is 60 fps: the letters flip to upright capitals one at a time every 2-3 frames over F915-F924 (0.15 s), then hold 1.2 s before a separate corruption to black. At 30 fps that is about a frame a letter, the word in 4-5 frames; the default `flipStep` is 1.

**Read.** `src/motion/library/typography/ScrambleHero.tsx`, `src/motion/text-modes.ts` (`caseFlipCount`, `otherCase`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** The reference's frame numbers are at 60 fps: converting them as 30 fps frames doubles the flip time. The fit is the wider of the word and its flipped form, so a lower-case word sits smaller than the capitals would alone. The slant is a skew, not an italic face.
