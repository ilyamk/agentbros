---
id: number-race
name: Number race
intent: "An odometer: reels in clipped columns, smudged by their own speed, stopping one by one from the left."
route: remotion
timing: 30 to 90 frames; last 10 frames readable
curve: expoOut on the value
primitive: NumberRace, odometerReels, raceValue
demo: RaceDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Rolls each column with true carries, so that a whole value rests on whole digits. Each column gets y blur from its own speed, so the right-hand digits are smudges while the left ones are legible.

**When it fits.** A number that is the claim. Also carries well: the same value shows up afterwards in a table.

**When it does not.** Non-monotonic data, or a value that must be readable throughout: then use plain digits.

**Timing.** Reference: ref-service-explainer 32.8 to 35.8 s; polymarket 16.4 to 17.1 s for linear digits; cashfree 13.6 to 14.5 s as a tertiary detail.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** Tabular figures are needed, and columns have a set width: wide faces need a wider column. Leading zeros are kept in layout, hidden, so that the number never shifts.
