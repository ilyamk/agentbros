---
id: scatter-field
name: Things scattered around a held line
intent: A claim is surrounded by its evidence, people or words, which gather around it without ever covering it.
route: remotion
timing: items cut on one every 4 frames (or on their spoken frames), no motion, the page creeping about 4% over 2 s; corner cards fly in about 6 frames, power3.out, then drift outward
curve: steps(1), power3.out
demo: src/motion/library/effects/ScatterField.tsx
sources: ["design-reference/library/abdulah/techniques.json", "design-reference/library/foren/techniques.json", "src/motion/library/effects/ScatterField.tsx"]
status: draft
---

**What it does.** Places words, pictures or cards at seeded, non-overlapping spots that keep clear of the held line's box (best-candidate sampling, so the field spreads evenly), each cut on at its own frame or one every few frames; the whole page creeps in slowly. `mode: "corners"` flies cards in to the four corners of a box around the line, braking without overshoot, then lets them drift slowly outward. Block: `scatter-field`.

**When it fits.** Social proof around a claim (users, customers, attendees); a spoken sentence assembling as a constellation, one word per spoken word; a line framed by four faces or products.

**When it does not.** When the items must be compared or read in order (use a grid or a list); more than about 25 items on a phone screen.

**Timing.** abdulah t08 (19.40-20.33 s, 36.53-42.80 s): each word cuts on at its own position, no motion and no fade, staying until the shot ends. abdulah t19 (59.57-61.87 s): portraits 0.03-0.06 of width pop on exactly every 4 frames (F1787 ... F1827) around the held line and off the edges, until about 18 surround it; the page creeps in about 4% over 2 s. foren portrait-cards-drift (2.9-4.4 s, 15.9-16.63 s): four cards about 0.10-0.13 of width fly in from the edges to the corners in about 6 frames, power3.out, then drift outward. A `motion:strip --vs` against foren 2.87-3.37 s matched the arrival; its cards are a little larger and closer to the line, so the corners preset uses 0.13-0.16 of width.

**Read.** `src/motion/library/effects/ScatterField.tsx`; `scatterPositions`, `popFrames`, `cornerPose` in `src/motion/library/effects/effects-plan.ts`.

**Pitfalls.** Real people need licensed photographs or the user's own (`src`); the default cards are unbranded placeholders, never stand-ins for a real crowd in a delivered film. Words stay inside the safe zone; pictures may sit past the edges (`bleed`). Give spoken words their own `at` from the transcript (`beatCues`) rather than an even `every`.
