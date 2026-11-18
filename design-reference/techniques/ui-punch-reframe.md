---
id: ui-punch-reframe
name: Hard reframes on one interface
intent: Interface text is read at legible size, one field at a time, with sharp text on every frame.
route: remotion
timing: "holds of about 1-1.5 s; wide, 2x on the field as typing starts, wide when the line outgrows the frame, 7x on the action; optional settle of 16 frames on expo.out, 2-4% travel"
curve: none at the cut; expo.out settle
primitive: easeFamily, RegionCamera
demo: src/motion/library/camera/UiPunchReframe.tsx
sources: ["design-reference/library/nexaa/techniques.json", "design-reference/library/context-dev/techniques.json", "design-reference/library/ace/techniques.json", "src/motion/library/camera/UiPunchReframe.tsx"]
status: draft
---

**What it does.** One capture of the real interface is shown at a list of scales and anchors with hard cuts between them instead of a zoom; each cut lands while something moves (a glyph typing, a click), and the new framing settles briefly in the direction of the cut. Library block: `ui-punch-reframe`.

**When it fits.** Product demos and record walkthroughs where the real screen is too small to read at full frame, especially white interfaces where a zoom would blur text.

**When it does not.** When the viewer needs the spatial relation between two places on the screen: a camera move (`ui-camera-read`) shows the path; a cut hides it.

**Timing.** Measured: holds 1.50, 1.58, 1.46 s; the cut-in arrives with the first letter, the cut-out as the line outgrows the frame, the macro at about 7x. After a cut the differences decay 35, 5.1, 3.6, 2.6 ... and end in 16 frames. Scale is never interpolated between shots. nexaa 6.45-7.15 s against ours (`motion:strip --vs` on the full frame, the re-crop; out/qa/wsg-finish/punch-nexaa-vs.jpg): the cut lands on the first glyph at 6.583 s, as ours does, but what settles is position, not scale: the title-to-field distance stays constant within 1% while the framing slides right by about 0.125 of the width, 45% of it after 0.04 s, 75% after 0.12 s, 88% after 0.21 s, 95% after 0.29 s. Ours settled 3% in scale and drifted the other way. `settlePan` with `uiPunchReframeNexaaSettle` (settleFrames 16, settleShare 0, settlePan 0.125, drift 0) follows it at 42%, 79%, 92%, 98%; the pull-back and macro cuts were not measured.

**Read.** `src/motion/library/camera/UiPunchReframe.tsx` (`reframePose`, `reframeCues`).

**Pitfalls.** A 7x macro needs a capture at 2x or more ([real-ui](../../docs/real-ui.md)); a generic mock-up never stands in for a named product. Alternate the side the framing favours so each cut gives the eye a new entry point.
