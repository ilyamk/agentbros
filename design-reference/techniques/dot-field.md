---
id: dot-field
name: Things become dots
intent: Many concrete things (words, cards, sources) are reduced to one kind of signal, then gathered and sent on.
route: remotion
timing: words to dots every 2-3 frames; grid to dots on a ring over 23 frames (power1.in); converge 11 frames (power2.in); band streams off in about 24-30 frames while a line appears in its wake
curve: power1.in, power2.in
demo: src/motion/library/effects/DotField.tsx
sources: ["design-reference/library/context-dev/techniques.json", "design-reference/library/ace/techniques.json", "src/motion/library/effects/DotField.tsx"]
status: draft
---

**What it does.** Each item fades as a flat disc pops in at its centre, in reading order or on a ring widening from the centre (`stagger` radial, ties together). Then the discs hold, converge to a point, merge into one blob, or flatten into a band that streams off the frame, a line of type showing only where the band has passed. Block: `dot-field` (`source` words or grid; `to` hold, converge, stream, merge).

**When it fits.** An abstraction beat: many tools, sources or people becoming data; a hook line that dissolves into a mark; a transition from a busy grid to one claim.

**When it does not.** When the items themselves must be read (they are gone within a second); warm, human stories; under about five items in grid mode.

**Timing.** context-dev t11 14.13-14.90 s: cards become cobalt dots of three or four sizes with a small jitter, the ring of change widening faster as it grows, every card a dot by F447 (23 frames). t12 15.0-16.93 s: the field converges to a point at frame right, accelerating (F450-F461, power2.in), flattens into a band at mid-height that streams right and off (F462-F485), and the line types in at x 0.14 at the band's trailing edge (4.7% of frame height). ace t05: each word of a short line fades as a dot pops in its place every 2-3 frames (F3-F17); later the dots converge accelerating and merge into one blob (F148-F158). A `motion:strip --vs` against context-dev 14.13-16.23 s matched the swap and band timing after the grid went to 16 x 8 small discs; the reference's converge reads as a slower funnel than a point, so read the strip before matching it exactly.

**Read.** `src/motion/library/effects/DotField.tsx`; `dotSwapDelays`, `dotFieldStates`, `dotStreamEdge`, `dotBlobRadius`, `gridDotSources` in `src/motion/library/effects/effects-plan.ts`.

**Pitfalls.** Words mode measures the words after the font loads; pass the text as displayed. The swap of the farthest ring and the converge can overlap; keep `toAt` after `swapAt + swapStep + swapFrames` if every disc should settle first. The type in the band's wake is a reveal, not a typewriter: for a caret, put `TypedLine` there and start it on the band's frame.
