---
id: accelerate-into-cut
name: Accelerate into a hard cut
intent: Two shots of one world read as one camera arriving, because the cut lands at the move's peak speed and the next shot carries it.
route: remotion
timing: "old shot pushes on circ.in over 8-12 frames, most travel in the last 4; cut at peak speed; new shot moves on at that speed and halves it each frame (rest about 5 frames after the cut)"
curve: circ.in before the cut, geometric decay 0.5 per frame after it
primitive: easeFamily, familyProgress
demo: src/motion/library/transitions/AccelerateIntoCut.tsx
sources: ["design-reference/library/muse/techniques.json", "design-reference/library/nexaa/techniques.json", "design-reference/library/ace/edit.json", "src/motion/library/transitions/AccelerateIntoCut.tsx"]
status: draft
---

**What it does.** The outgoing shot pushes (or drifts up or left) faster every frame and is hard-cut at its fastest; the incoming shot continues in the same direction at that speed and brakes, its speed halving every frame. Library block: `accelerate-into-cut`.

**When it fits.** Wide to close-up of the same subject, panel to panel on a white interface, any cut where a still cut would read as a jump or a glitch. Lock the cut to a beat (the reference cut sat 34 ms after one).

**When it does not.** When the two shots share a shape: use `match-cut`. When the next shot should land somewhere else in the frame: use `zoom-through`, which flies into a point.

**Timing.** Measured on the reference: outgoing frame differences 10, 11.8, 24 over the last frames, cut 34, then 34, 17, 7.7 (halving). The block reproduces the shape: circ.in to the seam, then `speed × decay^k`; the new shot travels `speed / (1 − decay)` in all. Blur follows speed on both sides, so the cut frame is the blurriest.

**Read.** `src/motion/library/transitions/AccelerateIntoCut.tsx` (`accelerateState`, `accelerateCues`).

**Pitfalls.** The references' near-zero differences one frame before and four after the cut are 24-to-30 fps pulldown repeats, not holds: do not copy them. A drift (not a push) moves the whole new shot, so give it a ground (`ground`) or content wider than the frame.
