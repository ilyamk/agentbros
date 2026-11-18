---
id: shape-wipe
name: Shape wipe from the focus point
intent: The next scene opens from the exact shape and place the eye is already on.
route: remotion
timing: 46-frame hold, 16-frame wipe, 40 frames after
curve: drift
primitive: shapeWipe, cutTiming
demo: PlayWipeL
sources: ["src/motion/lab/PlayWipe.tsx", "design-reference/library/motionfly/techniques.json", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** A mask grows from an on-screen icon, here a play button, at its exact position and size, until it covers the frame.

**When it fits.** The shape means something: the button that was pressed, the logo that opens.

**When it does not.** A decorative shape in the middle of the frame, with nothing there to look at first.

**Timing.** The press scales the button to 0.93 and back over the last 10 frames of the hold, then the wipe starts. Pass `originX`, `originY` and `fromSize` from the icon's own constants. motionfly (t05, 5.53-5.87 s): a soft-edged dark disc enters from the lower-left corner and grows past the whole frame in 10 frames, slow-fast-slow (frame differences 13.8, 15.1, 20.7, 26.3, 30.0, 22.6, 22.8, 20.5, 14.6, 5.9; sine.inOut), with the mark drawn above it: `feather` (about 3% of the width) and `above`.

**Read.** `src/motion/lab/PlayWipe.tsx`, with durations in `src/motion/lab/reel-layout.ts`

**Pitfalls.** Give it `cutTiming`, never an eased timing. The incoming scene is running during the wipe, so start its text 10 frames before the wipe ends. A feathered wipe is an SVG mask with a blurred shape, not a clip-path, and grows past the frame by its own width (`shapeWipeEndScale`), so the last frame carries no soft pixel. `above` lasts only for the seam: draw the mark in both scenes at the same place too.
