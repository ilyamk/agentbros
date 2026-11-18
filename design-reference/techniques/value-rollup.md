---
id: value-rollup
name: Value roll-up on a chosen curve, and the counting badge
intent: "Function proof: a figure is the film's verb, rolling in whole units every frame on a curve that says what it is (a target front-loads, a running total ticks linearly); a badge that grows from a dot and counts makes a match or score land."
route: remotion
timing: "polymarket: target figures 61% of the way by the 5th of 20 frames (power3.out) or nearly even then slowing (power1.out); running counts linear; gojiberry: a pill grows from a dot and counts to a full match in about 8 frames at 30 fps"
curve: power3.out, power1.out, linear; power2.out for the pill
primitive: rollupValue, pillGrow, typeProgress
demo: src/motion/library/typography/NumberRace.tsx
sources: ["design-reference/library/polymarket/techniques.json", "design-reference/library/gojiberry/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/NumberRace.tsx"]
status: draft
---

**What it does.** Props of block `type-number-race`: `curve` (`front` as before, `power3.out`, `power1.out`, `linear`) with `decimals` sets the value as a pure function of the frame in whole units, a new value every frame and no tween between digits; `locale` formats grouped digits; `digits: "proportional"` lets the figure's width follow its digits as the references do; `container: "pill"` puts the figure in a pill that grows from a dot (4 frames) and stretches while it counts (`numberRaceBadgePreset`). Presets: `numberRaceGaugePreset`, `numberRaceRunningPreset`.

**When it fits.** Money, counts, scores and percentages that are the claim; a running total under a montage (linear); a match or confidence badge that lands on a face or a card.

**When it does not.** A value that must be read throughout: hold it still. Odometer reels with carries: that is the `number-race` technique (`type-odometer-stat`).

**Timing.** polymarket (30 fps), seven spans 2.9-27.7 s: gauge $2K to $100K at 13.2 s, 61% of the way by the 5th of 20 frames (power3.out); threshold 10 to 50 nearly even, slowing in its last 4 frames (power1.out); running figures linear, about 1062 a frame. gojiberry 44.2 s is 60 fps: the green pill grows from a dot at F2653 and counts to a full match by F2669, 16 frames, so about 8 at 30. Ours: the gauge preset is 20 frames on power3.out (tested: 55-75% of the way by frame 4), the badge 8 frames.

**Read.** `src/motion/library/typography/NumberRace.tsx`, `src/motion/text-modes.ts` (`rollupValue`, `pillGrow`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** Proportional digits make the figure's width change every frame; centre it (the block does) or the eye tracks a jittering edge. gojiberry's frame numbers are at 60 fps: the triage note "16 f" is 8 frames at 30. The default (`front`, tabular digits) is unchanged.
