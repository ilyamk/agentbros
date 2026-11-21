---
id: frosted-product-window
name: Reveal an object through frosted glass
intent: Use a soft silhouette as a clue, then show the object clearly.
route: remotion
timing: Block default glass travel at frames 59–113 of 150. The exhibition cut uses 52–117.
demo: DreiOpticsL
sources: ["docs/drei-techniques.md", "src/motion/lab/DreiOpticalStudy.tsx", "src/motion/library/three/ModelShot.tsx"]
status: demonstrated
---

**What it does.** A matte transmissive slab obscures part of a model, then leaves the frame at a planned cue.

**When it fits.** A material reveal where seeing the outline first creates anticipation.

**When it does not.** Small interface text or safety information needs to be readable throughout. Keep it outside the refracted image.

**Timing.** Give the diffused outline an initial hold and the unobscured object a final hold.

**Read.** Use `frosted-product-window`. Render `DreiOpticsControlL` for the same treatment with simple transparency.

**Pitfalls.** The material sees Three.js geometry. Keep titles in Remotion and budget for one additional render pass.

[Source study](https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples/frosted-glass)

The demonstration is the lab's optical study (`DreiOpticalStudy`, its own glass settings). The library block's glass path in `ModelShot` uses the same material but is not seek-tested yet.
