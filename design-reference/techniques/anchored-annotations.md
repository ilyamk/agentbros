---
id: anchored-annotations
name: Annotations pinned to the picture
intent: Measured, tracked or selected things are pointed at, so a picture reads as inspected, designed or analysed.
route: remotion
timing: "airform: boxes and NNNxNNN labels build whole over 4 f in reading order, steps(1); nowakdesign: x/y tags about 3% of frame height, connector lines with dots; cashfree: named cursor tags on paths, outline chips beside an object"
curve: steps(1)
primitive: trackPoint, track
demo: src/motion/library/ui/UiAnnotate.tsx
sources: ["design-reference/library/airform/techniques.json", "design-reference/library/nowakdesign/techniques.json", "design-reference/library/cashfree/techniques.json", "src/motion/library/ui/UiAnnotate.tsx"]
status: draft
---

**What it does.** A HUD layer over any plate, capture or footage: thin boxes with dimension labels, coordinate tags joined by connector lines with dots, design-tool selection handles with a name badge, named cursor tags moving on paths and outline word chips beside an object. Each item is pinned to keyframed points; items arrive whole in reading order. Library block: `ui-annotate` (`Annotations` for use over any layer).

**When it fits.** Proof beats that say "measured", "tracked", "designed" or "collaborative"; macro product plates; a design canvas.

**When it does not.** Over busy footage where thin lines vanish; as decoration with nothing being measured or pointed at.

**Timing.** airform: rectangles with tiny 'NNNxNNN' labels build on over 4 frames (F10-F13), a few more per frame, no fade (steps(1)), then sit fixed while the plate grades in; they take the plate's grade (pink on magenta, teal on teal), and a few shift slightly frame to frame. nowakdesign: 'x: NNN y: NNN' tags about 3% of frame height above each object, thin white boxes joined by connector lines with dots, values changing per shot. cashfree: selection boxes with handles and named cursor tags moving on paths over a design canvas; an outline word chip beside a photographed phone.

**Read.** `src/motion/library/ui/UiAnnotate.tsx`, `buildFrames` and `readingRank` in `src/motion/library/ui/ui-plan.ts`.

**Pitfalls.** True tracking needs a tracked plate; hand-keyed points work when the plate barely moves. Cursor names and chip words are the film's own, never a real person's name without consent. Match the HUD colour to the plate or use `blend` so it sits in the picture.
