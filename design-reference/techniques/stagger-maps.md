---
id: stagger-maps
name: Stagger maps
intent: The same reveal gets a different character from the order it runs in.
route: remotion
timing: 16-frame reveal; delay steps of 0.4 by index, 0.5 from centre, 0.55 seeded
curve: expoOut
primitive: stagger, MaskedLine
demo: AlphabetStaggerL
sources: ["src/motion/lab/AlphabetStagger.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Runs one reveal over a grid of letters with three delay maps: by index, from the centre, and by seed.

**When it fits.** A grid or set of many small elements arriving together, where order carries the feeling.

**When it does not.** Two or three elements: the map makes no visible difference.

**Timing.** A 33-letter grid in 48-frame periods. Steps are under a frame per item, so the whole grid arrives in roughly 25 to 35 frames.

**Read.** `src/motion/lab/AlphabetStagger.tsx`

**Pitfalls.** Capitals in a dense grid need a tighter mask than the default: this demo uses bleed `top 0.22, bottom 0.16, side 0.05`, so the bleed stays inside the gap between rows.
