---
id: word-slam
name: Word slam
intent: "A word lands as a hit on the whole frame: fast scale from far or past the lens, flash, camera kick, then it creeps."
route: remotion
timing: settle k 0.4 per frame from scale 0.36 (reverse landing from 1.14 at k 0.7); flash 6 frames; kick 8 frames; creep 4% per second
curve: 1 - exp(-k t)
primitive: Slam, wordPose, hitDecay, hitsDecay, hitShake
demo: SlamDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Gives a word a whole life from one `WordMotion`: a landing, a hold that never stops creeping, and an exit with its speed drawn. `hitDecay` and `hitShake` drive the ground and camera on the same frame. `pulse` takes `audioPulse`.

**When it fits.** The words that carry a sentence, on a real hit in the music. Vary `fromScale` between far and past the lens so that two slams in a row differ.

**When it does not.** Every word in a line. It relies on rarity for weight, and on a ground that can flash.

**Timing.** Reference: ref-service-explainer 0.34 to 0.70 s (grows from 0.36, 0.82 by frame 3, 0.92 by frame 5) and 1.26 to 1.37 s (from 1.12, in 3 frames).

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** The curve and the flash make the landing; a big shake only makes it messy. Above 14 px of kick the word stops being legible on its landing frames.
