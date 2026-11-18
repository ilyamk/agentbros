---
id: frame-to-object
name: The frame shrinks into an object
intent: What the viewer was reading turns out to be the product or the call to action, without a cut.
route: remotion
timing: "border appears, frame shrinks at its own aspect ratio to 0.4 in about 19 frames (power2.inOut; 0.6 eleven frames in); monitor variant power3.out to 0.47, 90% in 14 frames"
curve: power2.inOut (slab), power3.out (monitor)
primitive: easeFamily, familyProgress, useFittedFontSize
demo: src/motion/library/transitions/FrameToObject.tsx
sources: ["design-reference/library/flex/techniques.json", "design-reference/library/flex/edit.json", "design-reference/library/cashfree/edit.json", "design-reference/library/motionfly/techniques.json", "src/motion/library/transitions/FrameToObject.tsx"]
status: draft
---

**What it does.** The whole frame gains a thin border and shrinks into a slab (or a monitor's screen) inside a new scene on a warm ground; a diagonal sheen crosses it and its content fades. Optionally the slab narrows into a button, a plus turns in, the label types, and the button turns edge-on and opens as the product object. Library block: `frame-to-object`; its `matte` mode (`<MatteCollapse>`, `matteCollapsePreset`) is a dark matte over the incoming plate that collapses into one of its elements and becomes it.

**When it fits.** A statement or a page read at full size that is the product: the thesis becomes the card, the page becomes the screen on a device, the slogan becomes the button.

**When it does not.** When the full-frame content has not been read yet: shrink only after it has had its reading hold. Not as a generic scene change.

**Timing.** Measured on the reference: border at F163, 60% of the width at F174, 40% at F182 (19 frames, slow at both ends). The cut cue sits where the frame detaches (`seamFrame`), the land cue when it settles. The second reference pulls back onto a monitor at about 0.47 scale, 90% of the travel in 0.46 s. A third reference runs it the other way round (matte mode): on a hard cut a soft-edged black card about 92% x 85% covers the new plate and shrinks over 12 frames toward (0.45, 0.43), frame differences 41, 33, 24, 16, 11, 6, 3, 1.7 (power3.out), flattening into the white underline of a floating dock whose icons fade in around it.

**Read.** `src/motion/library/transitions/FrameToObject.tsx` (`shrinkRect`, `objectPhases`, `frameToObjectCues`, `matteRect`, `MatteCollapse`).

**Pitfalls.** The edge-on turn is a `scaleY` to 0 and back, not `rotateX`: a 3D transform keeps a stale raster and fails motion:check as non-deterministic. Keep the label short; it is fitted to the settled button once.
