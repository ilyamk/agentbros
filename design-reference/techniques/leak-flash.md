---
id: leak-flash
name: Overexposure hides the change
intent: A change of plate or of ground disappears inside a moment of too much light, so the eye takes the new picture as the same exposure settling.
route: remotion
timing: "leak: 1-3 stepped frames, the new plate on the frame after the brightest, steps(1); edge bloom: edges to centre in 10 frames, power2.out, on the beat"
curve: steps(1) (leak), power2.out (edge bloom)
primitive: cutTiming
demo: src/motion/library/transitions/LightBurn.tsx
sources: ["design-reference/library/abdulah/techniques.json", "design-reference/library/flex/techniques.json", "src/motion/library/transitions/LightBurn.tsx"]
status: draft
---

**What it does.** Two forms of one idea. Leak: one to three frames of overexposure with a coloured radial leak replace the old plate, each brighter than the last, and the new plate starts on the next frame. Edge bloom: the frame brightens from its edges inward like an overexposed vignette while the next, light ground arrives under it, the centre last. Library block: `light-burn` with `shape: "leak"` (`leakFlashPreset`) or `shape: "edges"` (`edgeBloomPreset`).

**When it fits.** Leak: a manifesto or archive edit whose plates carry different grades, where a hard cut would show the grade jump. Edge bloom: a move from a dark brand ground to a light one, with the next element (a device) rising into the centre that clears last.

**When it does not.** Between interface shots of one product, where the light has no source; more often than the plate changes; the sweep shape (a stock film burn) when nothing in the film burns.

**Timing.** abdulah (seven occurrences, 6.83-45.40 s): an overexposed warm frame then a green-white leak (F363-F364), a green grade and white flare (F493-F496), cyan then bleached white (F668-F670); the new plate starts on the frame after the brightest; no tween between flash frames. flex: dark green brightens from the edges F842-F851 (10 frames), frame differences 4.3, 34.5-44.3, 37.2, 28.1, 20.9, 14.8, 11.4, 6.5: a fast front and a decaying tail (power2.out), 0.064 s after a beat.

**Read.** `src/motion/library/transitions/LightBurn.tsx`: `leakStep`, `edgeBloomRadius`, `lightBurnPeak`, `leakFlashPreset`, `edgeBloomPreset`.

**Pitfalls.** The leak is stepped: never interpolate between its frames, and never hold it longer than three. Over a light plate a screen-blended leak only washes out; it reads as colour over mid or dark plates. The bloom's stops are shares of the farthest-corner ray, so it stays an ellipse of the frame's own aspect in every format.
