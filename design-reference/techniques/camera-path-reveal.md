---
id: camera-path-reveal
name: Reveal a detail with a camera path
intent: Move attention from the full object to a detail and hold while it is explained.
route: remotion
timing: Block default camera move at frames 22–104 of 150. The exhibition cut starts on frame 17 and holds after 104.
demo: DreiConnectorL
sources: ["docs/drei-techniques.md", "src/motion/library/three/ModelShot.tsx"]
status: demonstrated
---

**What it does.** A perspective camera moves along an authored curve in a fitted model scene and shifts its look target.

**When it fits.** A connector, joint or other detail has to be found in context before it is named.

**When it does not.** The viewer already knows the detail or the camera move would hide the action. Use a cut or a locked shot.

**Timing.** Use the last moving frame as the start of a reading hold; the stop cue uses the same frame as the camera.

**Read.** Use `camera-path-reveal`. Positions are multiples of the fitted distance, targets are normalised scene coordinates.

**Pitfalls.** Watch travel through the model, clipping at the near plane, and caption overlap in portrait.

[Source study](https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples/motionpathcontrols)
