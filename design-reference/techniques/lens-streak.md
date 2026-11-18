---
id: lens-streak
name: Diagonal lens streak that recedes with its subject
intent: A lit object arrives as if it caught the lens, and the light falls away as the object settles back.
route: remotion
timing: streak at full on the arrival frame, about half 6 frames later as the subject recedes (22% to 10% of height, expo.out), gone over the next 14
curve: expo.out
demo: src/motion/library/finish/FlarePulse.tsx
sources: ["design-reference/library/nowakdesign/techniques.json", "src/motion/library/finish/FlarePulse.tsx"]
status: draft
---

**What it does.** Draws an anamorphic streak with a bloomed core across the whole frame at an angle, its level driven per frame by keyframes rather than beats, so the light can peak on a cut and fade as the subject pulls back. Block: `flare-pulse` with `angle`, `thickness` and `intensity` (`lensStreakPreset(at)`).

**When it fits.** A product or graphic that should feel lit and physical at its arrival; a brand world that already has light and lenses (tech hardware, music, sci-fi).

**When it does not.** Paper, print and flat editorial looks; as idle decoration (the block's `sparing` rule); behind small text, which the streak crosses.

**Timing.** nowakdesign glint-square-pull-back 3.93-4.30 s: the square arrives at about 22% of frame height with a full-frame diagonal streak and bloom, recedes to about 10% in about 6 frames (motion.json s010, expo.out, span90 0.203 s), and the streak fades with it. A `motion:strip --vs` against 3.9-4.3 s put our first version's fade too fast and its line too thin; the preset now holds about half at 6 frames, angle -40, thickness 0.07.

**Read.** `src/motion/library/finish/FlarePulse.tsx` (`flareLevel`, `lensStreakPreset`).

**Pitfalls.** The streak is a screen-blended overlay: on a light ground it disappears. Pass the subject's own colour as `colour`, or the streak reads as stock. One streak per film moment; with `hits` and `intensity` both set, `intensity` wins.
