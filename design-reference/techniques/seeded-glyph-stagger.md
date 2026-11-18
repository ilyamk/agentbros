---
id: seeded-glyph-stagger
name: Glyph stagger with seed
intent: "One word becomes an event: each glyph lands on its own, and the disorder repeats exactly on every render."
route: remotion
timing: 16 frames per glyph, seeded stagger step 2.5 with jitter 1
curve: overshoot
primitive: stagger, splitGraphemes, useFittedFontSize
demo: GlyphSeedL
sources: ["src/motion/lab/GlyphSeed.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Splits a word into graphemes. Each takes a seeded delay, vertical side and rotation, then settles with overshoot.

**When it fits.** A short word or title that is the event of the shot.

**When it does not.** A line of about 25 glyphs: it stops being readable, so stagger by word. Copy that must be read at once.

**Timing.** Delay comes from `stagger(n, { kind: "seeded", step: 2.5, jitter: 1 })`. Motion takes 16 frames, opacity the first 3. Rotation starts within 35 degrees either way.

**Read.** `src/motion/lab/GlyphSeed.tsx` (also `GlyphSeedV`)

**Pitfalls.** Randomness only through `random(seed)`. Per-glyph columns lose kerning, so do not add negative tracking on wide faces such as Unbounded, where neighbours collide.
