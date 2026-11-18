---
id: dolly-through-type
name: Dolly through type
intent: The camera flies through a stack of words, the next word already small inside the one in front.
route: remotion
timing: 11 frames between words, ending on the cue; ratio 4.5 between neighbours; slow creep on the hold
curve: inOut on the camera, exponential in scale
primitive: DollyStack, dollyPosition, dollyWord
demo: DollyDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Places words at depths along the lens and moves one camera position through them. Scale, focus blur and passing-the-lens fade all derive from that position, so there is no cut and nothing to overlap by hand.

**When it fits.** A short phrase said one word at a time, as a change from slams. For a single word thrown past the lens use `Slam` with `exit: "through"`; for words landing from the lens use `enter: "lens"`.

**When it does not.** Words that must be read at length: each rests for only part of its cue. Long words on small formats.

**Timing.** Reference: ref-service-explainer 20.4 to 21.9 s (stack), 3.0 to 3.1 s (through), muse 29.9 to 30.5 s (from the lens).

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** The word that passes is drawn on top of its successor by reverse order; do not reorder them. CSS scale of huge type rasterises soft: large font sizes hold better than large scales.
