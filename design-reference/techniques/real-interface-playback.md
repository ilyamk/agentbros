---
id: real-interface-playback
name: Real interface playback
intent: The viewer sees the real product, with the camera taking them to the action.
route: remotion
timing: Zoom over frames 24 to 78; cursor over 20 to 96; click at 104
curve: drift
primitive: WindowFrame, RegionCamera, ScreenPlayback, Cursor
demo: StudioDemoL
sources: ["src/motion/lab/StudioDemo.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Plays a real screen recording in a window frame. A viewport camera zooms to the button and a cursor presses it.

**When it fits.** Any claim about what a product does, and whenever a capture exists. The `PRODUCT_MATERIAL_MISSING` check counts a shot with this technique as real product material.

**When it does not.** A mock-up of an interface: then it is not evidence and must say so on screen.

**Timing.** Recording at playback rate 0.8. The click point comes from the capture's pixel coordinates, times the capture scale.

**Read.** `src/motion/lab/StudioDemo.tsx` (also `StudioScreenshotL` for a still)

**Pitfalls.** Zooms beyond about 1.5x need a capture at higher resolution than the frame; the demo capture is 2x. Cursor and footage must share stage coordinates. Zoom the viewport, not the footage.
