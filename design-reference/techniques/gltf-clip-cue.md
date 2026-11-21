---
id: gltf-clip-cue
name: Sample a GLB animation on a cue
intent: Show a specific mechanical action in sync with an explanation.
route: remotion
timing: Frames 28–83 for the action; hold the last key to frame 119.
demo: DreiLatchL
sources: ["docs/drei-techniques.md", "src/motion/library/three/ModelShot.tsx"]
status: demonstrated
---

**What it does.** One named GLB animation samples an absolute pose per frame including the last key.

**When it fits.** An approved asset already contains the intended movement, such as opening a compartment.

**When it does not.** A shot needs a physically accurate latch whose motion is absent from the GLB. Prepare the action first.

**Timing.** Specify start and end relative to the shot, then match the sound or narration cue to the authored motion.

**Read.** Use `gltf-clip-cue`; pass an exact clip name and the shot's inclusive end sample.

**Pitfalls.** Check the clip name, units, rest pose and final pose. Fades and overlapping clips need another authored sample plan.

[Source study](https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples/gltf-animations-re-used)
