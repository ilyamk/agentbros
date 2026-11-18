---
id: match-cut
name: Match cut with a carried element
intent: Two ideas are linked by one element that keeps moving across a hard cut.
route: remotion
timing: 0-frame cut at frame 44; the element moves for 30 frames from 13 before the cut
curve: inOut
primitive: MatchCut, FilmGrain
demo: SunriseL
sources: ["src/motion/lab/Sunrise.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** A full stop leaves its sentence, keeps moving through a 0-frame cut and becomes the sun in the next scene.

**When it fits.** Two shots that share a shape, where the link is the point.

**When it does not.** A link only the author can see: without a matching shape it is just a cut.

**Timing.** Both scenes read the same track function, so position, size and speed agree across the cut. Grain starts at the cut to hold the dark ramp together.

**Read.** `src/motion/lab/Sunrise.tsx`

**Pitfalls.** The carried element stays on top of the next scene, so author later foreground so that it never has to pass behind.
