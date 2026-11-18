---
id: glass-dome-world
name: Glass dome world with a plush character
intent: A product's small world under glass: a soft character at a desk inside a thin-film glass dome on a floating island, seen side-on with a push-in or straight down with a slow pull-out.
route: blender
timing: "side: push 1.45x over 64 f, power2.in (most of it late, into the cut); overhead: pull out 1.3x over 36 f, power1.out"
curve: power2.in push, power1.out pull-out
primitive: scripts/blender/glass_dome.py
demo: scripts/blender/plush_character.py
sources: ["design-reference/library/muse/techniques.json", ".agents/skills/blender-3d/SKILL.md"]
status: draft
---

**What it does.** `glass_dome.py` builds a saucer island, a hemispherical glass shell (Solidify, so it refracts as a shell) whose Principled thin film wanders between 150 and 620 nm on a 1.9-IOR film, a desk with a laptop of two slabs, six glassy tiles orbiting inside the glass, and a procedural sky. The character is `toy_kit.plush`: metaballs fused into a round-eared pear with a felt shader (sheen, subsurface, noise and Voronoi fibre bump) and a volume-preserving breath computed from the frame. `plush_character.py` shows the same character alone on a sweep. Both play through `blender-plate` (`pnpm assets:sync --id plates:glass-dome`, `plates:glass-dome-overhead`, `plates:plush-character`).

**When it fits.** An establishing shot of a product's world, a breath between proofs (muse t03, t16); a mascot that must look the same in every 3D shot.

**When it does not.** A flat or graphic film: `shaded-orb` (iridescent) and `orbit-ring` give the same idea in the browser. Anything that must follow a late script change: a plate has to be rendered again.

**Timing.** muse t03: dome shot F78-F144, push z +0.645 mostly in the last 1.2 s, then an accelerating cut (t04, circ.in). muse t16: overhead 28.72-29.93 s, pull-out z -0.232 over 1.21 s, power1.out, only water moving. Proofs: side 64 f at 480x270 and 16 samples in 72 s on an M-series GPU; production 1920x1080 at 128 samples.

**Read.** `scripts/blender/glass_dome.py`, `scripts/blender/plush_character.py`, `toy_kit.plush`, `toy_kit.fabric`, `toy_kit.sky_world` in `scripts/blender/toy_kit.py`.

**Pitfalls.** Without caustics a glass shell blocks the sun and the sky, and everything inside goes dark: the dome and tiles are hidden from shadow rays. A thin film with an IOR near the glass's (1.33 on 1.52) is almost invisible; it needs a film far from the substrate. Metaball surfaces sit at about 0.685 of the element radius at threshold 0.3, so features are placed on the measured head sphere, not on the element radius. The character is our own design: never model one after a reference's mascot.
