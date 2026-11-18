---
id: orbit-ring
name: Orbit ring around a subject
intent: A world of things circles one line or product, then flies past the camera and leaves the subject alone for the headline.
route: remotion
timing: entry by contraction about 16 frames (expo out); constant spin; fly-past 12 frames (power2.in), subject alone 1 frame, then the headline
curve: expoOut entry, quadIn fly-past
demo: src/motion/library/effects/OrbitRing.tsx
sources: ["design-reference/library/motionfly/techniques.json", "design-reference/library/airform/techniques.json", "design-reference/library/muse/techniques.json"]
status: draft
---

**What it does.** Places cells (seeded dot-matrix glyphs drawn as paths, dots, or rounded thumbnail cards) on concentric rings tipped back with perspective, turning at a constant speed; the back half passes behind the subject and the front half in front. The ring can arrive contracting from beyond the frame and leave by expanding off every edge. Block: `orbit-ring`.

**When it fits.** "Every kind of X" said over a centred line; a product among its many uses; a hook where a dot-matrix ring strobes under a steady caption (airform).

**When it does not.** Small screens with a long line in the middle (the back half crosses it); as decoration with no claim of many things.

**Timing.** motionfly t14: the ring expands past all four edges in 12 frames (F621-F633), accelerating, the line alone for one frame, the headline at F634. The preview renders the same 12 + 1 frames (strip against motionfly 20.67-21.17 s).

**Read.** `src/motion/library/effects/OrbitRing.tsx`; `orbitPoints` in `src/motion/library/effects/flash-plan.ts`.

**Pitfalls.** Text glyphs would be caught by text sensors and depend on fonts; glyphs are drawn as 3x5 bitmaps instead. A one-frame strobe of the ring against black (airform) is a flash: keep it to three alternations a second or check `FLASH_RISK`.
