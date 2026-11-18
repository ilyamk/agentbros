---
id: print-type
name: Print type (scan, stamp, scrap, ink-in)
intent: "Function emphasis, hook or reveal: type that is made on the paper instead of set on a screen, so a period or print look carries the word without decorating it."
route: remotion
timing: "scan: complete in 32 frames, a new drawing every 2 (steps(16)); stamp: 2x at 30% to 1x solid in 4 frames (power2.in), jolt about 4 frames; scrap: a letter every 2-3 frames, settled by about 20; ink: faint (about 15%) to full in one frame, then a 12-frame whole-frame flicker"
curve: steps on twos (scan); power2.in (stamp); steps (scrap, ink)
primitive: scanReveal, stampPose, joltOffset, scrapPlan, inkIn
demo: src/motion/library/typography/PrintType.tsx
sources: ["design-reference/library/paper-style/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/PrintType.tsx"]
status: draft
---

**What it does.** Four print gestures for one word on a paper ground, all in block `print-type`. `scan`: a thin coloured line rises through the word at an even rate, drawn on twos, and leaves the printed letters behind it with two offset colour plates (misregistration). `stamp`: the word drops from twice its size and faint to solid and multiplies into the paper, rotated, with no bounce; the whole frame jolts for a few frames on contact. `scrap`: each glyph lands on its own torn scrap of paper with its own face, fill and tilt, a few frames apart, like pasted ransom letters. `ink`: the title sits faint across a camera move, then snaps to full ink in one frame while the whole frame flickers and settles.

**When it fits.** A film whose form is a printed sheet, a zine, a poster or an archive; a single word that must feel made (a stamp of approval, a date, a title card); a hook built from pasted letters.

**When it does not.** A clean product film on flat grounds: use `type-hero-word`. Long copy: scraps and stamps are for a word or two. A stamp slam repeated on every beat reads as a template.

**Timing.** paper-style is 30 fps. Scan, 46.6-47.9 s (F1404-F1436): the line rises from low in the word, frame difference alternating about 1.0 and 0.3, so a new drawing every second frame at an even rate, complete in about 32 frames. Stamp, 33.83-33.97 s (F1015-F1019): faint and large to small and solid in 4 frames; the curve could not be fitted on so few frames (power2.in, inferred, confidence 0.4); the frame shifts on every edge for F1019-F1022 (difference 15-19). Scrap, 2.03-2.63 s (F61-F79): difference 8-10 a frame while scraps land, decaying below 1 by F82; letters 2-3 frames apart. Ink-in, 55.93 s (F1678): about 15% contrast to full black in one frame, then a 12-frame whole-frame flicker settling by F1690. Ours: scan 32 frames on twos (16 drawings, tested), stamp 4 frames from 2x and 0.3, jolt 4 frames, scraps 2.5 frames apart, ink snap with a decaying 12-frame flicker.

**Read.** `src/motion/library/typography/PrintType.tsx`, `src/motion/text-modes.ts` (`scanReveal`, `stampPose`, `joltOffset`, `scrapPlan`, `inkIn`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** Multiply needs a light ground: on a dark ground set the ink to a light colour and expect the blend to do little. The jolt moves the whole stage, ground included, so the frame edge shows the parent for a few pixels: put the block on a ground the parent shares, or keep `jolt` small. Scraps mix faces of different widths, so the line is fitted at 0.8 of `width`; check long words in the condensed and wide faces. The flicker is a whole-frame brightness change: keep it under strobe limits (12 frames, decaying).
