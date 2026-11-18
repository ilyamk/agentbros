---
id: word-backdrop
name: One faint layer behind a held word
intent: A one-word frame stays alive for its hold without anything competing with the word.
route: remotion
timing: rings one period per 120 f; tiles hold 8 f each at seeded offsets; ghost drifts; countdown steps on frames 0, 2, 4, 7, 11, glows over 3 f and holds 13 f
curve: constant rings and drift; countdown decelerating steps (2, 2, 3, 4 frames)
demo: src/motion/library/backgrounds/WordBackdrop.tsx
sources: ["design-reference/library/polymarket/techniques.json", "design-reference/library/foren/techniques.json"]
status: draft
---

**What it does.** Holds a fitted word at the centre over one layer at 6-12% contrast: `rings` expanding without end from the centre, `tiles` (a rounded grid where a seeded fifth of tiles is lit, each on its own clock), `ghost` (the word itself at about twice the size, cropped by the frame and drifting), or `countdown` (a numeral about 0.6 of the frame height, blurred, stepping to zero on slowing cue frames, then glowing). `ground: "transparent"` lays it over footage. Block: `word-backdrop`.

**When it fits.** A claim word held for a second or more (polymarket uses one layer per word, never two); a deadline or launch beat where time running out is the point (foren).

**When it does not.** Under a sentence: the layer competes with reading. Two layers at once. A countdown longer than a second with nothing counted.

**Timing.** polymarket field-backdrops: spans 2.10-2.90, 19.37-20.83, 20.83-22.00, 25.40-27.00, 30.10-31.73 s; 6-12% contrast, always moving a little. foren countdown-behind-word: after one empty frame the numeral steps on frames 0, 2, 4, 7, 11 to zero (F1011-F1022), glows and holds 13 frames before a hard cut to white.

**Read.** `src/motion/library/backgrounds/WordBackdrop.tsx`; `ringField`, `tileFlicker`, `countdownAt`, `countdownValues` in `src/motion/library/backgrounds/background-plan.ts`.

**Pitfalls.** All tiles changing on the same frame reads as a flash; offsets are seeded per tile. The ghost word crosses the frame by design and declares `intendedOverflow`. A countdown numeral without blur fights the word for focus.
