---
id: typed-selection
name: Typing in a selection box
intent: Text is typed in bursts inside a box with handles and guides, then a highlight sweeps a finished word on its cue.
route: remotion
timing: Mean 1.6 frames per character with seeded pauses; highlight 6 frames, slant 5
curve: inOut on the sweep
primitive: TypedLine, typingSchedule, typedCount
demo: TypingDemoL
sources: ["src/motion/kinetic-type.tsx", "src/motion/kinetic-math.ts", "src/motion/lab/KineticDemos.tsx"]
status: demonstrated
---

**What it does.** Keeps a seeded schedule of when each character appears. The box grows in steps with the text, caret solid while typing, blinking when idle; guides extend across the frame.

**When it fits.** Showing an act of making: a prompt, a brief, a title being set. The highlight marks the one word that matters.

**When it does not.** Long paragraphs. Typing is slow: fit the time to the words first.

**Timing.** Reference: cashfree 7.8 to 8.0 s and 19.0 to 20.0 s; palmier and muse for the bursts.

**Read.** `src/motion/lab/KineticDemos.tsx`

**Pitfalls.** Highlights find the text by first occurrence, so don't repeat the word. No real italic in Golos: the slant is a skew, for short words only.
