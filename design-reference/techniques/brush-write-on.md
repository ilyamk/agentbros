---
id: brush-write-on
name: Brush and pen write-on
intent: A mark or a line of script is written in front of the viewer, so it reads as made by a hand rather than placed.
route: remotion
timing: "brush: each stroke 13 frames on kinetic.inOut, strokes 0.22 s apart, the drawing settling from 3x on expo.out over about 1.5 s (muse, `brush.settle`), blur gone in 5 frames; pen: strokes 0.34 s, 0.32 s apart, the pen lifting 0.25 s after the last"
curve: kinetic.inOut (stroke), expo.out (brush entry scale)
demo: src/motion/library/kinetic/LineDraw.tsx
sources: ["design-reference/library/muse/techniques.json", "design-reference/library/paper-style/techniques.json", "src/motion/library/kinetic/LineDraw.tsx"]
status: draft
---

**What it does.** Two hands on one stroke reveal. Brush: each stroke is a filled, variable-width outline (a 30% touch-down, a quick swell, a taper towards the end) revealed by a DrawSVG mask along its centre line; the whole drawing enters large and blurred and settles to size while it writes. Pen: even strokes draw in writing order and a pen rides the tip of the stroke being drawn, held at the end of a finished stroke until the next starts, then lifts off. Library block: `kinetic-line-draw` with `brush` (`brushMonogramPreset`) or `follower` (`penWritePreset`).

**When it fits.** Brush: a closing monogram or signature over a plain ground, held without a fade as the last frame. Pen: a handwritten hook line or annotation, a circle drawn round the word that matters, in step with the voice.

**When it does not.** A font-set headline (a font does not reveal in stroke order: draw prepared paths); a strokes count above six or so, where the reveal becomes a wait; the brush's entry scale on a mark that must stay legible from its first frame.

**Timing.** muse t18 (31.73-32.37 s): a fat accent-blue stroke appears at about 0.35 of the frame height, motion-blurred, and writes the rest of the monogram while shrinking to about 0.14 H by F971, frame differences 10.0, 8.2, 5.5, 3.8, 2.6, 1.8, 1.4: a fast start and a long tail (expo.out); then it holds about 2.4 s with no fade. Its height over its rest height, measured frame by frame (blue extent, F958-F1010): 3.3, 2.65 after 3 frames, 1.95 after 6, 1.62 after 9, 1.41 after 12, 1.18 after 21, 1.07 after 31: the excess decays by about e^(-0.14 f), so the brush stays large well past the 13 frames the preset first used; expo.out over about 1.5 s matches (`brush.settle`, `BRUSH_SETTLE_MUSE`, on in `brushMonogramPreset` with `entryScale` 3; absent, the settle is one draw as before). Side by side (out/qa/wsg-finish/brush-vs.jpg) our drawing rests larger in the frame than muse's 0.17 H, so pass a smaller `viewBox` scale for the same read. paper-style pen-writing (2.8-4.0 s): a pen follows the script along its path, then a red circle is drawn round it.

**Read.** `src/motion/library/kinetic/line-draw-math.ts`: `brushWidth`, `brushOutline`, `penTip`, `strokeEase`, `brushMonogramPreset`, `penWritePreset`; `LineDraw.tsx` for the masks and the timeline.

**Pitfalls.** The pen follows `strokeEase`, the same curve as the timeline's `kinetic.inOut`; a different ease puts the pen off the line. GSAP scales the wrapping `div[data-art]`, never the `<svg>`, whose transform GSAP writes in viewBox units. The mask's centre line must be wider than the brush (1.6x) or the outline's edges show unrevealed. muse's entry holds large longer than expo.out over 13 frames; lengthen `draw` for a slower settle.
