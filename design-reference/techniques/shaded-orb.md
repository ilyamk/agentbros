---
id: shaded-orb
name: Shaded orb, glossy or iridescent
intent: A drawn sphere becomes a character, a word in a sentence, or a burst of colour around a clear centre, with no 3D render.
route: remotion
timing: glossy grows 11 f (0.37 s), shifts 4 f, eyes 3 f, flood 3 f bottom-up; iridescent field enters from the edges in 5 f (expo.out) and implodes to a ring in 5 f (circ.out)
curve: sine.out growth, expo.out entry, circ.out collapse
demo: src/motion/library/three/ShadedOrb.tsx
sources: ["design-reference/library/ace/techniques.json", "design-reference/library/cashfree/techniques.json", "design-reference/library/flame/techniques.json", "design-reference/library/muse/techniques.json"]
status: draft
---

**What it does.** `glossy`: a radial-gradient sphere with a specular highlight grows from a point, shifts colour, opens two eyes and is flooded from the bottom by a second colour, or sits at type height between two words and carries a mark. `iridescent`: a seeded field of spheres banded with far-apart hues, shaded and blurred by depth, comes in from every edge and leaves the centre clear for a line; it can pull into a ring and implode into a chromatic blur. Block: `shaded-orb` (exports `GlossyOrb`, `IridescentSphere` for inline use).

**When it fits.** A friendly product character (ace); an object that is part of the sentence and then grows into the ground (cashfree); a problem line framed by colour (flame).

**When it does not.** When the material must convince as glass or metal on screen for long: render it in Blender. The glossy character has its own shot, `scripts/blender/glossy_orb.py` (same `at`, `size`, colours and `timing` keys, so the cues still land), played by this block's `plate` prop (`pnpm assets:sync --id plates:glossy-orb`); the muse dome is `glass-dome-world`. Never as decoration with no role in the line.

**Timing.** ace t05 (60 fps): blob to 40% of the cell F158-F180 (0.37 s, near-even steps), cyan shift F180-F188, eyes F190-F196, mint flood F198-F203. cashfree orb-match-cut: hard cut at 2.333 s onto the orb at the same place and size, words type in either side from F72. flame collapse-to-point-burst: spheres 5-30% of the width enter from all edges over F86-F90; implode-and-blur: ring in 5 frames (F118-F122), cluster shrinks and fades F122-F130, circ.out.

**Read.** `src/motion/library/three/ShadedOrb.tsx`; `orbState`, `sphereField`, `spherePose` in `src/motion/library/three/three-plan.ts`; the Blender route `scripts/blender/glossy_orb.py` (60 f at 480x270 and 16 samples in about 46 s; production 1920x1080 at 64).

**Pitfalls.** A conic gradient centred on the sphere reads as a pinwheel; its centre sits outside the disc so the bands curve. Spheres blurred by depth cost little, but a blur on every sphere every frame of a long hold adds up: keep the field under a dozen.
