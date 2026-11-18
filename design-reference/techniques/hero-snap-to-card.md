---
id: hero-snap-to-card
name: Full-bleed hero snaps to a card, the board fills around it
intent: "Function proof: the picture the viewer was inside becomes one piece of a bigger board in a single frame, so the board reads as the product's whole world."
route: remotion
timing: "cashfree (30 fps): a full-frame photo snaps in one frame to a centred card about 63% of the width on black; tiles land around it every 1-2 frames with no tween; tall panels from both edges last; 6-8 elements by 17.2 s, held to 18.63 s"
curve: none (cuts on frames)
demo: src/motion/library/scenes/SceneBentoCollage.tsx
sources: ["design-reference/library/cashfree/techniques.json", "src/motion/library/scenes/SceneBentoCollage.tsx"]
status: draft
---

**What it does.** A hero picture fills the frame, then on one frame it is a centred card on a dark ground; around it the board's other tiles cut on one after another, one or two frames apart, with no slide or fade. Library block `scene-bento-collage` with `heroSnap` (and `heroShare`, `snapSteps`); the layout is `heroSnapRects` in `src/motion/library/scenes/scene-plan.ts`.

**When it fits.** A brand board or "what it is" summary that starts from one strong photo; a transition from a full-bleed shot into an overview.

**When it does not.** A gentle film: the snap and the 1-2-frame tile cuts are percussive. Fewer than four other things to show: the board looks empty.

**Timing.** cashfree 16.10-18.63 s at 30 fps: the snap in one frame (visuals/a1/s015-pull.jpg F496-F506), tiles appear complete in one frame each, every 1-2 frames (F509-F510), tall panels from both edges last. Ours: the hero is full bleed before `heroSnap` and the card from that frame, `heroShare` 0.63 of the width at the frame's aspect, the six other tiles on frames `heroSnap + 1` then 2, 1, 2, 1, 2 apart, the two side panels last; on a vertical frame the card takes the width and the tiles stack above and below it. Side by side with cashfree 16.30-16.97 s (`motion:strip --vs`) the one-frame snap to a card about 0.65 of the width and the tiles cutting on whole match; cashfree's tiles are smaller and set irregularly over a mostly black ground, ours fill the frame as a tidy board.

**Read.** `src/motion/library/scenes/SceneBentoCollage.tsx`, `src/motion/library/scenes/scene-plan.ts`, `tests/motion-blocks-gap-scenes.test.ts`.

**Pitfalls.** Rests on one reference. The hero's own content is laid out for its rect, so type set for the full-bleed frame jumps in size at the snap: put a photo, not type, in the hero. `pushAt` still pushes into the hero's card.
