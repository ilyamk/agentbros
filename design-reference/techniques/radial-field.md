---
id: radial-field
name: Radial field and shock ring
intent: A live field of thin lines leaves a point, sparse at low energy and full on a hit, with a ring thrown out by each hit.
route: remotion
timing: Lines decay over 15 to 34 frames; ring 14 frames
curve: exponential ring
primitive: RadialField, ShockRing, radialLines, shockRingAt
demo: RadialDemoL
sources: ["src/motion/backgrounds.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx", "src/motion/lab/KineticLab.tsx"]
status: demonstrated
---

**What it does.** Seeded angle, speed, phase and length per line; `energy` from `energyAt` or a hit decides how many show and how long. `clear` keeps a pocket free for the type.

**When it fits.** A ground under type that must feel charged; an anticipation before the first hit, with nothing else on screen.

**When it does not.** As constant wallpaper at high energy: its force comes from the change. As a stand-in for AI.

**Timing.** Reference: ref-service-explainer 0.0 to 0.70 s, 7.9 to 8.2 s on white; polymarket 13.2 to 14.2 s as a gauge.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** Thin lines shimmer under H.264 at low bitrates. Line count above about 250 costs render time for no gain.
