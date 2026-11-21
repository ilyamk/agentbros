---
id: product-model-stage
name: Fit a project model to a studio stage
intent: Keep the product and its important details inside the frame through a turntable.
route: remotion
timing: 150 frames in the demo; cut after the last readable angle.
demo: DreiProjectorL
sources: ["docs/drei-techniques.md", "src/motion/library/three/ModelShot.tsx"]
status: demonstrated
---

**What it does.** A local GLB is centred and measured once. The camera fits the rotated bounds to the canvas with a chosen subject fill.

**When it fits.** A product reveal that needs a quick camera or aspect-ratio revision.

**When it does not.** A material proof that needs ray-traced light, fine lens detail or motion blur. Use a Blender plate.

**Timing.** Set the duration before choosing the sweep. Use a shallower sweep when the next shot relies on the front face.

**Read.** Use `studio-product-stage` with `model.src` for a turntable, or `product-model-stage` for the project model controls.

**Pitfalls.** Approve the real model, its orientation, and its finish first. Use a self-contained local GLB.

[Source study](https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples/bounds-and-makedefault)
