---
id: layout-carry
name: Layout carry and takeover
intent: One container carries through layouts, or a button swells and fills the frame until it is the next ground.
route: remotion
timing: Morphs 12 to 20 frames ending on a cue; takeover 15 to 26 frames, 55% swelling up to 16%, then the surge
curve: expoOut for morphs; drift then expoIn for takeovers
primitive: LayoutMorph, GrowToScene, morphRect, growRect
demo: MorphDemoL
sources: ["src/motion/layout-morph.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** `LayoutMorph` tracks a rectangle and radius through keyed layouts, hitting every key exactly; what is inside can change without the box cutting. `GrowToScene` (demo `GrowDemoL`) moves from an element's rectangle to exactly the stage: the label leaves, the gradient flattens into the next ground, and what's behind recedes.

**When it fits.** The thing that survives a boundary, when no object does. Cause and effect in an interface: press, and the next scene is what the press did.

**When it does not.** Crossfading unrelated content inside: swap on the fast frames, or it reads as a slide.

**Timing.** Reference: polymarket 12.8 to 13.2 s (button takes the frame) and 3.4 to 3.9 s (bars as a wipe); ref-service-explainer 20.4 to 23.0 s (the frame around a word); muse 16 to 17 s.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** It morphs layout boxes, not outlines: type inside does not scale with it. Put the next scene on the same flat colour from the frame after a takeover: a one-shade mismatch shows as a flash.
