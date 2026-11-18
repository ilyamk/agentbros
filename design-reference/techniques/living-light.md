---
id: living-light
name: Living light
intent: "A ground that is never a flat fill: soft lights wander on seeded noise, corners fall away, hits open it up."
route: remotion
timing: Continuous; flash 3 to 7 frames on hits
curve: noise
primitive: LivingLight, lightBlobs
demo: LightDemoL
sources: ["src/motion/backgrounds.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx", "src/motion/lab/KineticLab.tsx"]
status: demonstrated
---

**What it does.** Layers radial gradients at noise-driven centres and a vignette. `energy` makes the lights larger and stronger; `flash` pushes the frame to a colour.

**When it fits.** Under any type or interface that would otherwise sit on a flat colour.

**When it does not.** As the subject. A soft gradient on its own is on the creative standards' blacklist.

**Timing.** Reference: ref-service-explainer corners and blotches throughout; cashfree mesh cards 13.6 to 15.4 s; airform vignette.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** Dark ramps band: add `FilmGrain` above it. Gradients take `color-mix`, so colours can be any CSS colour.
