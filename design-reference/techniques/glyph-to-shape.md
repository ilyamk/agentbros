---
id: glyph-to-shape
name: A glyph becomes the shape it names
intent: "Function transition: a word breaks and one of its letters turns into the stroke the next shot is built from, so the cut is a match on a shape the viewer just read."
route: remotion
timing: "hold 5 frames, letters scatter 4, others fade 3, the stroke lengthens 6, then turns about 35 degrees and extends to about 0.46 of the height in 6 (power2.out); cut on the frame the shape completes"
curve: power2.out on the scatter, the lengthening and the turn
primitive: glyphShapePhases, scatterOffset
demo: src/motion/library/typography/GlyphToShape.tsx
sources: ["design-reference/library/nowakdesign/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/GlyphToShape.tsx"]
status: draft
---

**What it does.** A small word holds whole, then its letters scatter (mostly vertically) and all but one fade. The kept letter's box is handed to a stroke: the glyph disappears and a rounded bar of its stem's width stands where it stood, lengthens and drifts to the frame centre, then turns and extends across the frame on a decelerating ease. The next shot cuts on the frame the shape completes (`seamFrame`, the `cut` cue). Library block `glyph-to-shape`.

**When it fits.** A word that names a line, a stroke, a cut, a direction or a pointer ("line", "lift", "I"), followed by a shot built on that shape; a typographic title sequence where letters turn into the graphics.

**When it does not.** A word with no upright stem in the kept letter: the hand-over shows. Long words: the scatter becomes noise. Without a following shot that uses the stroke, it is a trick, not a transition.

**Timing.** nowakdesign 3.0-3.9 s (30 fps, F90-F117): word held F90-F94 (5 frames); letters scatter F95-F98 (4); all but the first fade F99-F101 (3); the upright stroke alone lengthens F102-F107 (6); it rotates to about 35 degrees off vertical and extends to about 46% of the frame height F108-F113, rotation steps shrinking frame to frame (power2.out); held F113-F117. Ours uses those frame counts as defaults (tested phase by phase); side by side with the reference (`motion:strip --vs`, 3.0-3.9 s) the hold, scatter, hand-over and turn land within a frame of it.

**Read.** `src/motion/library/typography/GlyphToShape.tsx`, `src/motion/text-modes.ts` (`glyphShapePhases`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** The stem position is estimated from measured advance widths (the glyph's centre), not from its outlines: a letter with an off-centre stem (b, d, h) jumps on the hand-over. In the reference the scatter frames are interleaved with flash frames from a separate grade; those belong to `grade-step-flash`, not here.
