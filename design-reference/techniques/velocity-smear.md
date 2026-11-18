---
id: velocity-smear
name: Velocity smear
intent: "Speed is drawn: above a threshold a word stops being letters and becomes streaks along its travel."
route: remotion
timing: Exit over 5 to 6 frames with cubic acceleration; peak sigma about 6% of width; nothing below 1 px per frame
curve: t cubed on the travel
primitive: Smear, ZoomSmear, smearAt, wordSpeed
demo: SmearDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Stretches an element along its move, shifts each row by its own seeded amount, blurs along the move and splits colour, all from one speed value in pixels per frame. `ZoomSmear` is the radial case, built from scaled copies.

**When it fits.** Any fast exit, whip or slam. Use it on a word's way out, then cut hard on the streak: the eye reads speed and never misses the fade.

**When it does not.** Long reading holds, or small nudges: under 40 px per frame it only looks soft. Do not stack it on a `Shutter`.

**Timing.** Reference: ref-service-explainer 0.93 to 1.10 s and 1.53 to 1.65 s. Five frames, letters gone by the third.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** The filter sits inside any transform, so its blur is scaled too: divide speed by the parent's scale, as `Slam` does. Filters clip at the region, set to four times the box. Hold `seed` through a move or the rows flicker.
