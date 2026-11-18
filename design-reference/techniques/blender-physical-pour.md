---
id: blender-physical-pour
name: Physical pour in Blender
intent: "Objects must physically interact and be believed: a rigid-body flow with real light."
route: blender
timing: 90 frames at 1920x1080, 24 samples with OIDN, about 12 s a frame
primitive: scripts/blender-run.ts
demo: .agents/skills/blender-3d/references/examples/coffee_pour.py
sources: [".agents/skills/blender-3d/SKILL.md", ".agents/skills/blender-3d/references/rendering-craft.md"]
status: draft
---

**What it does.** Coffee beans pour from an off-frame hopper into a bowl: a baked rigid-body simulation with Cycles light and depth of field.

**When it fits.** Pours, falls and many colliding parts, where the physics is the shot.

**When it does not.** Simple shapes or light 3D type: stay in Remotion with three.js. A brief that did not ask for 3D, without a clear yes from the user.

**Timing.** Figures are from the worked pour: 1320 instanced beans, 90 frames in 18.5 minutes on a shared machine. It is a worked script, not a Motion Lab piece, so the card stays `draft`.

**Read.** `.agents/skills/blender-3d/references/examples/coffee_pour.py`, and `.agents/skills/blender-3d/SKILL.md`

**Pitfalls.** Bake once, then do look passes with `--blend`, or an arbitrary frame shows the initial state. Bullet is unstable with tiny objects, so the scene is built at ten times real size, and blur scales with it. Ask before installing or downloading anything.
