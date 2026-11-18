---
id: dot-to-wordmark
name: Dot travels into the wordmark's full stop
intent: The brand mark and the brand name are shown to be one thing: the disc that carried the mark becomes the punctuation of the name.
route: remotion
timing: "disc grows 18 frames to 0.266 W (power2.out) while the mark slices in from frame 6 over 12 (left to right, colour-glitched), hold 6, disc travels 7 with the word wiping in behind it, then 10 frames resolving into the full stop (power3.out)"
curve: power2.out (disc), power3.out (travel, resolve), steps(1) (slices)
demo: src/motion/library/kinetic/MorphMark.tsx
sources: ["design-reference/library/foren/techniques.json", "src/motion/library/kinetic/MorphMark.tsx"]
status: draft
---

**What it does.** On an empty dark ground a dot grows into a pale disc; the mark wipes in inside it, cut out of the disc, in stepped slices, and holds. On one frame the mark goes, the disc travels right and the letters wipe in from the word's left edge behind it, never ahead of it; then the disc shrinks and drops onto the baseline as the word's full stop. Library block: `kinetic-morph-mark` with `wordmarkReveal: "travel"` (`travelWordmarkPreset`); the last of `shapes` is the mark. `travelGlitch` (on in the preset, `TRAVEL_GLITCH_FOREN`) reveals the slices left to right with seeded colour copies of the mark trailing to its right that close in as the clean mark lands; `discShare` sets the disc's diameter (0.266 of the width by default).

**When it fits.** A closing logo reveal for a brand whose name can carry a full stop or a dot, after a busy film, on a ground the film has already cut to black.

**When it does not.** A name whose last character already ends in a dot or punctuation; a mark that is not legible as a cut-out at disc size; a light, busy plate, where the disc stops reading as a single object.

**Timing.** foren (4.40-5.86 s, visuals/a1 logo-reveal and logo-reveal-b, F133-F176). Disc diameter measured frame by frame (1280 px wide, threshold on the pale disc): 0.053 W at F134, 0.135 at F137, 0.177 at F139, 0.220 at F142, 0.246 at F145, 0.266 at F151, held to about F155, then 0.249 at F160 as it starts to travel. It grows over about 18 frames on about power2.out, under the slices, not in 6 frames; the 13% first noted is the F137 frame of that growth and the 0.22 the block first used is its middle. The mark builds left to right in colour copies (green, then lime, pink and the dark mark, each trailing further right the earlier it came, about a quarter of the mark's width at F146) F139-F150 and holds to F158, vanishes at F159; the disc travels right about 0.2 of the frame width F159-F165 with letters appearing behind it, and resolves into the last letters and the stop F166-F175; the sub-line fades in during the last 3 frames. Side by side (`motion:strip --vs`, out/qa/wsg-finish/travel-vs.jpg) the disc's size and growth match; our clean mark reads about 2 frames before foren's, and our four stepped slices are coarser than foren's continuous wipe.

**Read.** `src/motion/library/kinetic/morph-mark-math.ts`: `travelPlan`, `travelLayout`, `travelState`, `travelGlitchState`, `TRAVEL_FRAMES`, `TRAVEL_DISC_GROW`, `TRAVEL_DISC_SHARE`; `MorphMark.tsx` (`TravelMark`) for the render, which measures the word with `useTextWidths` to place the stop. Tests: `tests/motion-blocks-gap-transitions.test.ts`.

**Pitfalls.** The mode is drawn from the frame (no GSAP timeline), so `morph`, `hold` and `turns` do not apply. The stop's height comes from the font's proportions (0.36 of the size below the centre line), so a display face with a short x-height can float the stop; check a still. A growing disc is easy to mis-measure: take its size from every frame of a strip, not one. The glitch copies are drawn behind the clean mark and clipped to the reveal, so on a mark with little width they hide; raise `offset`.
