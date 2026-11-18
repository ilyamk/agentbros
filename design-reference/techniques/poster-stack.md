---
id: poster-stack
name: Poster stack
intent: "Type fills the frame like a printed poster: each line justified to the column by size alone."
route: remotion
timing: 22 frames per line, 5-frame stagger, line-height 0.84, at 30 fps
curve: expoOut
primitive: FittedLine, MaskedLine, linesFor
demo: PosterStackL
sources: ["src/motion/lab/PosterStack.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Sets each line to the size that fills the column, then reveals it from behind a mask. Line breaks are written by hand per format.

**When it fits.** A hook or statement of two to four short lines, where the words are the picture.

**When it does not.** Long sentences: the lines end up at very different sizes. Mixed-case Russian in Sofia Sans Extra Condensed, where д looks like g.

**Timing.** Line `i` starts at frame `2 + i * 5` and takes 22 frames. In the demo, the supporting rule draws over 30 frames from frame 18, once the lines are nearly in.

**Read.** `src/motion/lab/PosterStack.tsx` (also `PosterStackV`)

**Pitfalls.** Pass the text as displayed, cased: `textTransform` is not measured. Keep rows further apart than the mask bleed.
