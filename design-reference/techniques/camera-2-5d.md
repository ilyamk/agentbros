---
id: camera-2-5d
name: 2.5D camera over layers
intent: "A flat layout feels like a place: one pose gives every layer its parallax and focus."
route: remotion
timing: Dolly 0 to 330 over 92 frames; rack focus over frames 10 to 46; shake amplitude 5, frequency 0.045
curve: drift
primitive: Camera, DepthLayer, shake, FilmGrain
demo: ShotListCameraL
sources: ["src/motion/lab/ShotListCamera.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Pushes, pans and racks focus from a back sheet to the table across stacked paper, with handheld drift throughout.

**When it fits.** A shot list, a desk, documents or anything flat that needs depth without real 3D.

**When it does not.** Believable shadow or material as the point of the shot: that is Blender. Data-driven 3D objects: that is three.js.

**Timing.** Pan x from -170 to 90 and y from 30 to -44 over the same 92 frames. Focus racks on `inOut` from depth 700 to 0, aperture 0.024. Roll amplitude 0.12.

**Read.** `src/motion/lab/ShotListCamera.tsx`

**Pitfalls.** Far layers need overscan (400 in the demo) or their edges enter the frame. Blur is expensive, so keep few layers deep.
