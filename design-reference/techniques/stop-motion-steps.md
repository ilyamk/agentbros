---
id: stop-motion-steps
name: Objects on twos and threes, a puppet limb
intent: Hand-made paper animation: the object moves pose to pose like stop motion while the camera stays smooth, and a cut-out comes alive through one limb.
route: remotion
timing: an object changes only every 2nd or 3rd frame; a limb swings about its pivot on threes
curve: steps(3)
primitive: onSteps
demo: src/motion/library/effects/PaperCollage.tsx
sources: ["design-reference/library/paper-style/techniques.json", "src/motion/timing.ts", "src/motion/library/effects/PaperCollage.tsx"]
status: draft
---

**What it does.** `onSteps(frame, 2)` holds a value's frame for two frames (or three), so one element moves on stop-motion steps under a camera that still moves every frame. `paper-collage-assemble` uses it for a piece's `limb`: once the piece lands, it swings about its pivot (`pivotX`, `pivotY` as shares of its box) by `swing` degrees over `period` frames, holding each pose `step` frames (`limbAngle`).

**When it fits.** Paper, collage and cut-out films; an engraving-style figure that waves, points or nods with one limb; a machine that arrives in jumps.

**When it does not.** Smooth, glossy product films; a whole frame on steps (that is a frame rate, not a style); a limb that is not cut as its own piece (the rotation shows the seam).

**Timing.** paper-style stepped-object-motion 37.2-37.45 s: the machine's entrance changes only on F1117, F1119, F1122, F1125 and F1127 (twos and threes, near-zero differences between), then the frame settles smoothly. sticker-cutouts: puppet motion on a single limb. `paperCollageLimbPreset` swings the minute hand 14 degrees over 36 frames on threes.

**Read.** `onSteps` in `src/motion/timing.ts`; `limbAngle` in `src/motion/library/effects/effects-plan.ts`; `limb` in `src/motion/library/effects/PaperCollage.tsx`.

**Pitfalls.** Feed `onSteps` to the element's own frame only; stepping the camera too reads as dropped frames. Cut the limb as its own piece with its pivot at the joint, or the swing tears the figure.
