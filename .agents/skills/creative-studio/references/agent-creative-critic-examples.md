# creative-critic: worked examples and full method notes

Moved out of `.agents/agents/creative-critic.md` to keep the definition short. Adapted from motion-video-kit critic-prompts.md, gauntlet.md and quality-bar.md (MIT, © 2026 echris6), and video-use SKILL.md step 7 (MIT, © 2026 Browser Use).

## Actions: soft versus usable

Too soft, and useless: "Good typography and clear hierarchy. Pacing could be a little tighter. Consider adding sound."

Usable, ranked, max 7:

```
[1] frames 210–315 (07.00–10.50): price label alone on a grey fill, frozen 08.10–10.20, level flat -> fix: src/projects/<id>/scenes/Price.tsx — cut the hold to 40 frames; bring the second line in at frame 234 with the library block from `pnpm library:list --query "kinetic word entrance"` (spring, damping 14) instead of the 24-frame slide
[2] frames 429–441 (14.30–14.70): wipe splices two titles, text over text on 4 frames -> fix: Transition at 14.30 — swap for a hard cut on the downbeat at frame 432, or the library block `pnpm library:list --query "match cut"`
[3] frames 0–60 (00.00–02.00): frame 0 is an empty gradient -> fix: Hook.tsx — start on the finished composition; animate only the product, not the entrance of the background
Previous 2: STILL PRESENT at 19.40–21.00, 1.4 s frozen (was 1.6 s).
Previous 3: FIXED. The wipe at 14.30 no longer splices the titles.
```

## Axis notes: soft versus usable

"`typography` 2. Floor: most text one entrance. 7 of 9 lines rise and hold (sheet-02 F310, F402, F566). Words are read, not performed; the reference's words land as events at 0:04 and 0:09. `rhythm` 2. Floor: median shot 2.9 s against 1.2 s. Measured -15 LUFS, range 2.1 LU, no silence in the table; clip at 12.40 shows the hit lands 5 frames after the cut."

## Per-scene analysis fields (one framesReviewed entry per scene)

time range; what is on screen, literally; % of frame empty (a number); seconds it could lose and why; what moved and what caused it (from the clip or diff strip); what is heard, measured, or `nothing`; ranked problems with timecodes.

## Idea test

1. Say the idea in a sentence about what we see. If it comes from the on-screen words, the picture does not carry it.
2. Swap the product name. Does anything break?
3. Name the one moment a viewer would describe afterwards, as a frame range.

## Look rounds (styleframe sheet)

Per frame: what is on screen, % empty, countable layers, what is real material and what is a rectangle pretending, could it belong to another product. Of the set: one world or five posters? What would move first? Does any frame stop you at phone size?
