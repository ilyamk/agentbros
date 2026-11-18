---
id: aligned-burst
name: Aligned burst across hard cuts
intent: "Function proof: many sources say the same thing; locking one feature (a highlighted phrase, an eye) to one point and size makes a run of cuts read as one continuous thing seen many times."
route: remotion
timing: "ugc-app (30 fps): pages 2-4 frames each, each scaled so the highlighted phrase hits one target box (changes at F63, F67, F69, F72, F75, F78, F82, F84); palmier (25 fps): 33 stills held 2 frames each (three held 3), the eye at frame centre closing in steadily to a pupil about 30% of the width"
curve: none (hard cuts); size grows geometrically by plate
demo: src/motion/library/scenes/CaptionFlashMontage.tsx
sources: ["design-reference/library/ugc-app/techniques.json", "design-reference/library/palmier/techniques.json", "src/motion/library/scenes/CaptionFlashMontage.tsx"]
status: draft
---

**What it does.** A burst of plates cut every few frames, each placed so that its own feature box lands on the same frame point at the same size: the highlighted phrase of each article, the eye of each portrait. Optionally the size grows steadily across the run, so the burst also closes in. Library block `caption-over-flash-montage`: a plate's `focus` box plus the montage's `focusAt`, `focusSize` and `focusGrow`; maths in `focusTransform` and `focusSizeAt` (`src/motion/library/scenes/scene-plan.ts`).

**When it fits.** Press quotes, reviews or search results that all say one thing (ugc-app); a run of images that rhyme on one feature (palmier's eyes ending on a crater); any proof by quantity where the viewer's eye must not travel.

**When it does not.** Plates without a clear shared feature, or whose feature box is not known: guessing the box breaks the lock. Pages with invented text: page copy must be true or visibly illustrative.

**Timing.** ugc-app 2.10-2.90 s: eight page changes 2-4 frames apart, the highlight's OCR box 0.096 of the height. palmier 33.88-36.64 s at 25 fps: 2-frame holds (0.08 s, 2.4 frames at 30 fps), the caption fixed at the centre, size 0.062 of the height. Ours: the plate is scaled about its corner and translated so the box's centre is on `focusAt` and its width `focusSize` of the frame on the first plate, growing by a constant ratio per plate to `focusSize * focusGrow` on the last. Growth is by plate index, not by frame, so the montage's `flashSafe` (on by default) can lengthen holds to six cuts a second without bending the growth; with it off the measured 2-frame holds play exactly (then check FLASH_RISK).

Not compared with `motion:strip --vs`: the block has no plates with known feature boxes to set beside the references; the alignment is proven by `focusLanding` in the tests and a still of drawn plates.

**Read.** `src/motion/library/scenes/CaptionFlashMontage.tsx`, `src/motion/library/scenes/scene-plan.ts`, `tests/motion-blocks-gap-scenes.test.ts`.

**Pitfalls.** A plate scaled below cover shows the black ground at its edges: give plates margin around the feature or a size large enough. `flashSafe` lengthens the shortest holds; the burst reads slower than the references, by design.
