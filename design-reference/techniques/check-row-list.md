---
id: check-row-list
name: Rows ticked one after another
intent: A list of benefits or steps is proved done, one row at a time, with a mark the eye can count.
route: remotion
timing: "nexaa at 24 fps: card settles 6 f; each circle fills with a clock wipe in 3-4 f, rows 9 then 7 f apart (11 and 9 at 30 fps), linear; motionfly: rows append, a spinner turns to a tick"
curve: linear
primitive: progress, stagger
demo: src/motion/library/ui/UiCheckList.tsx
sources: ["design-reference/library/nexaa/techniques.json", "design-reference/library/motionfly/techniques.json", "src/motion/library/ui/UiCheckList.tsx"]
status: draft
---

**What it does.** A card of rows (title and grey subline) settles; each row's empty circle fills with a radial clock wipe and draws a white tick, on a staggered schedule. Variant: rows append, each with a spinner that turns into a tick, and the list scrolls so the newest row stays in view, the last rows left open. Library block: `ui-check-list`.

**When it fits.** Benefits, onboarding steps, an agent's work done; a beat that should feel like proof accumulating.

**When it does not.** More than about six rows on screen (the eye stops counting); claims that are not steps or benefits.

**Timing.** nexaa: a white card rises and settles in 6 frames; circles fill black with a clock wipe in 3-4 frames and show a white tick: F435-F438, F444-F447, F451-F454 at 24 fps, 9 then 7 frames apart, linear; the first fill lands on a tracked beat. motionfly (t11): a spinner status line appears, rows append at about F424, F436, F453, F459, each spinner turns to a tick, the list scrolls up slightly; the last two rows stay grey at the cut.

**Read.** `src/motion/library/ui/UiCheckList.tsx`, `checkSchedule` and `clockSweep` in `src/motion/library/ui/ui-plan.ts`.

**Pitfalls.** A tick on every beat turns into a metronome; let the gaps tighten (9, then 7). Row text is the real copy of the product or claim, short enough for one line at 34 px.
