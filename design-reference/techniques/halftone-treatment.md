---
id: halftone-treatment
name: Halftone treatment of a picture
intent: A photo or clip reads as print: two inks, dots whose size carries the tone, a screen that can crawl and resolve back to the photo.
route: remotion
timing: held for the shot; dot size settles over about 2 s (expo out); dissolve to the photo in 6 frames (sine in-out); ink cycle every 10 frames (steps(1), 5 at the fastest)
curve: expoOut (dot size), drift (dissolve)
demo: src/motion/library/effects/HalftoneImage.tsx
sources: ["design-reference/library/context-dev/techniques.json", "design-reference/library/abdulah/techniques.json", "design-reference/library/nowakdesign/techniques.json"]
status: draft
---

**What it does.** Rebuilds a picture as a dot screen: the picture, blurred to the cell, is added to a radial ramp per cell and thresholded, so each dot's area follows the darkness, then mapped to an ink and a ground colour. The screen can rotate, crawl, coarsen or refine, cycle its dot and ground colours on a frame cadence (`inks`, `inkEvery`), and dissolve back to the photo on a cue. Block: `halftone-image`; `Halftone` wraps any layer, including a `<Video>`.

**When it fits.** Portraits, crowds and objects in an editorial or print look; a frame that should feel archived or reproduced; a foreground switched to dots during a ground blink (`grade-step-flash` step `ground`).

**When it does not.** Faces that must be recognised at small sizes (dots erase detail); a film whose look is photographic throughout; as a texture over the picture (that is `texture-overlay`).

**Timing.** context-dev holds the blue halftone portrait grid and pushes it in 4 frames with an exponential tail, then cross-fades the halftone to the photo in 6 frames (F120-F125, speeding up at the end). The default preview resolves at frame 108 over 6 frames. abdulah t13 (25.73-26.73 s) re-renders the plate as a coarse screen on black and swaps the dot colour at F772, F782, F792 (yellow, magenta, grey: every 10 frames, steps(1)); `halftoneInkCyclePreset` and `ABDULAH_INKS` hold it. Its exit alternation (dot screen and bright colour every 1-2 frames before the cut) is over the flash budget; build it as `grade-step-flash` `halftone` steps at 3 frames or more.

**Read.** `src/motion/library/effects/HalftoneImage.tsx`; `halftoneScreen`, `halftoneDotRadius`, `halftoneInkAt`, `MIN_INK_HOLD` in `src/motion/library/effects/flash-plan.ts`.

**Pitfalls.** Dot cells under about 6 px alias in a 1080 frame and shimmer when the screen crawls; keep `push` small (under 0.5 px a frame) or 0. Dark subjects on dark grounds need `dotsOn` "light". The threshold relies on CSS `plus-lighter` and `contrast()`: render through Chromium (Remotion), not other engines. An ink cycle faster than one swap per 5 frames could pass six changes a second, so `inkEvery` stops at 5; the abdulah preset passes `flash:check`.
