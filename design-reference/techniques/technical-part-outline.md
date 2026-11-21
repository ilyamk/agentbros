---
id: technical-part-outline
name: Direct attention to a specific model part
intent: Let the viewer find the part being explained on the real geometry.
route: remotion
timing: Highlight cues at frames 15, 87 and 115 in the demo.
demo: DreiAirPathL
sources: ["docs/drei-techniques.md", "src/motion/library/three/ModelShot.tsx"]
status: demonstrated
---

**What it does.** Draw the visible geometry silhouette of the named node and keep the outline aligned with its transform.

**When it fits.** A technical process has named parts that can be shown one at a time.

**When it does not.** A thin text outline or an occluded part is the subject. Reframe to show the material, or qualify a different treatment.

**Timing.** Keep each highlighted range half-open. Show its label while the part is visible and give it a reading hold.

**Read.** Use `technical-part-outline`; node names can be the exact GLB names.

**Pitfalls.** Duplicate names are ambiguous. Keep the highlight concise and check thin geometry at playback size.

[Source study](https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples/edgesgeometry)
