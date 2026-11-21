---
id: instanced-assembly
name: Build a readable group of repeated parts
intent: Show how a precise number of parts forms a modular system.
route: remotion
timing: Three groups land at frames 61, 85 and 109 in the demo.
demo: DreiCellsL
sources: ["docs/drei-techniques.md", "src/motion/library/three/InstancedAssembly.tsx"]
status: demonstrated
---

**What it does.** Identical geometry travels from seeded positions into an exact count of labelled groups.

**When it fits.** The spatial grouping explains what goes together, such as cells in battery modules.

**When it does not.** The viewer primarily compares numeric magnitudes. A labelled 2D chart will be easier to read.

**Timing.** Land each group in order. Set cue and counter updates from the same plan, then hold all groups together.

**Read.** Use `instanced-assembly`; give it an integer group count, integer units per group and a seed.

**Pitfalls.** Watch for occluded units and uneven perspective. Use a new camera angle or fewer simultaneous groups when they compete.

[Source study](https://github.com/pmndrs/examples/tree/541599ac5ad913de85796403c1c6927ada3b303c/examples/hi-key-bubbles)
