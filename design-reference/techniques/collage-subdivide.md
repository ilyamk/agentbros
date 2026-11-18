---
id: collage-subdivide
name: Collage that subdivides
intent: A grid divides on cues, gutters slide as a cell eats its neighbours, then one cell takes the frame.
route: remotion
timing: 12 to 14 frame moves on cues; 2.5% push per second
curve: expoOut
primitive: CollageGrid, collageCells
demo: CollageDemoL
sources: ["src/motion/layout-morph.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx", "src/motion/lab/KineticLab.tsx"]
status: demonstrated
---

**What it does.** A binary split tree whose ratios animate, so that at any frame cells tile the stage exactly. New cells grow out of the gutter; a slide moves the gutter of an existing split, and ratio 1 or 0 hands a whole area over.

**When it fits.** Many proofs at once: pictures, numbers, words, each with its own life. The best use is with real images.

**When it does not.** Plain colour cells on their own: they read as a template. It needs material.

**Timing.** Reference: cashfree 12.0 to 15.4 s; context-dev 11.4 to 12.9 s and ugc-app 4 to 6 s for density by zoom, which this does not do.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** Contents must lay out at any cell size, including very small: centre them and let them clip. A cell's content is drawn at the size it has, so type inside reflows.
