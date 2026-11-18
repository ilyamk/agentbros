---
id: brand-sweep
name: Brand-colour studio sweep with a pull-back
intent: The product stands in a studio lit in the brand's own colour, and the shot pulls back from the screen onto the device.
route: remotion
timing: pull-back from filling the frame to 47% in 14 f (0.46 s), power3.out
curve: power3.out
demo: src/motion/library/backgrounds/SpotlightStudio.tsx
sources: ["design-reference/library/cashfree/techniques.json"]
status: draft
---

**What it does.** `spotlight-studio` with `tint`: the seamless sweep runs from a pale tint of the brand colour at the top through the wall to a deep shade on the floor, with the key light, pool and reflection kept, and a lighter vignette. `pullBack` scales the product layer from 1/0.47 (the screen filling the frame) to rest. Mode of the block `spotlight-studio`.

**When it fits.** A device or object on its own after a full-frame UI shot (cashfree); a brand whose colour is light and owned, where a black studio would be generic.

**When it does not.** A dark premium brand: keep the default. The UI on the device must still be a real capture (real-UI rule); this mode only lights the room.

**Timing.** cashfree screen-pulls-back-to-device: the real page full frame for about 0.4 s, then the frame pulls back onto the monitor, z -0.76, to about 47% in 0.46 s, power3.out (motion.json s008); sweep #A7E4C0 at the top to #053618 on the floor.

**Read.** `src/motion/library/backgrounds/SpotlightStudio.tsx`; `tintedSweep`, `pullBackScale` in `src/motion/library/backgrounds/background-plan.ts`.

**Pitfalls.** A hard step where wall meets floor breaks the cyclorama; the wall and floor colours are blended across the floor line. For a real monitor with a screen texture, `blender-plate` or `studio-product-stage` give true reflections; this mode is the 2D stage.
