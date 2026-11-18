---
id: doubling-counter-montage
name: Accelerating subject swap under a doubling counter
intent: Scale that grows faster than the eye can follow: each new subject doubles a count while the cuts speed up.
route: remotion
timing: holds 44, 46, 26, 19, 14, 13, 14, 8, 5, 4 ... frames (1.47 s down to 1 frame); the subject cuts 2 frames before a 4-frame odometer roll
curve: linear (reel roll), steps(1) cuts
demo: src/motion/library/scenes/DoublingCounterMontage.tsx
sources: ["design-reference/library/gojiberry/techniques.json", "design-reference/library/abdulah/techniques.json", "src/lib/sensors/flash.ts"]
status: draft
---

**What it does.** Keeps one layout fixed (a query line on top, the counter left of the subject at eye height, a plural label right of it, a name card below) while subjects cut in; every cut doubles the counter, whose digit reels each turn forward to the new digit, so the numbers in between are never shown. Block: `doubling-counter-montage`.

**When it fits.** Users, teams, files or matches that multiply; the turn of a film from one example to "and all of these".

**When it does not.** Counts that do not double (use `type-odometer-stat`); subjects that cannot be framed the same way each time (the layout's stillness carries it).

**Timing.** gojiberry 6.73-14.07 s: twenty holds of 1.47, 1.53, 0.88, 0.62, 0.45 ... 0.03 s; the face cut 1-3 frames before a 4-5-frame roll. The default reproduces the first twelve holds exactly and the roll 2 frames after the cut over 4 frames (strip against gojiberry 9.60-10.07 s: reference roll about 3-4 frames, 1-2 after the cut).

**Read.** `src/motion/library/scenes/DoublingCounterMontage.tsx`; `doublingReels`, `accelerandoHolds`, `safeHolds` in `src/motion/library/effects/flash-plan.ts`.

**Pitfalls.** The reference ends at up to 30 cuts a second; `flashSafe` (on) stops the accelerando at six cuts a second, about 4-5 frames a hold. Off plays the measured holds down to 1 frame: keep the subjects on one ground in one tone and check the render with motion:check `FLASH_RISK`.
