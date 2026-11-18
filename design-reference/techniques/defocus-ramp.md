---
id: defocus-ramp
name: Footage defocuses under a sharp end card
intent: "Function cta: the live picture steps back out of focus so the mark and the offer can take the frame without a cut."
route: remotion
timing: "gojiberry (60 fps): from about 48.3 s the whole plate defocuses over about 0.75 s, evenly, while the mark pops in (48.93 s) and the wordmark types on sharp over the blur; the card holds to the last frame, no fade"
curve: sine.inOut
demo: src/motion/library/camera/FocusPull.tsx
sources: ["design-reference/library/gojiberry/techniques.json", "src/motion/library/camera/FocusPull.tsx"]
status: draft
---

**What it does.** One footage layer blurs on an even ramp while everything above it stays sharp, so the end card sits over a soft, still-living picture instead of a flat ground. Library block `focus-pull` with `mode: "ramp"`; use `<DefocusRamp at frames blur overlay={card}>{footage}</DefocusRamp>` from `src/motion/library/camera/FocusPull.tsx`; the blur per frame is `defocusRamp` in `src/motion/library/camera/camera-plan.ts`.

**When it fits.** An end card or offer over the film's last live shot; a title over footage that must stay present but not compete.

**When it does not.** A rack between two planes inside the shot (use focus-pull's default rack); footage with text of its own that the viewer must still read.

**Timing.** gojiberry 47.20-56.53 s at 60 fps: the subject walks out, the plate defocuses from about 48.3 s, the mark pops at F2936 (48.93 s), the wordmark types on at about 3 frames a letter (F2954-F2975), a pill at 50.4 s; motion.json fits the small push after the type-on as circ.out. Ours: blur 0 before `at`, rising on sine.inOut over 22 frames (about 0.75 s) to `blur` px at 1080, then held; the footage is overscanned a little with the blur so its edges never show. Side by side with gojiberry 48.20-49.80 s (`motion:strip --vs`) the plate softens from about 48.4 s to 49.1 s at an even rate; a first circ.out ramp (the motion.json fit of the later push) was soft within a third of a second, too early, and was replaced.

**Read.** `src/motion/library/camera/FocusPull.tsx`, `src/motion/library/camera/camera-plan.ts`, `tests/motion-blocks-gap-scenes.test.ts`.

**Pitfalls.** Rests on one reference; the ease is read off the strip, not fitted. A CSS blur over video costs render time on every frame it is above zero. Start the overlay as the blur passes about half, or the card lands on a still-sharp picture.
