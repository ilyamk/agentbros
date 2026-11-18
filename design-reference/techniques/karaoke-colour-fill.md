---
id: karaoke-colour-fill
name: Karaoke colour fill, a word a frame
intent: "Function emphasis: a narrated line on screen in full, each word switching to the accent as it is spoken and staying, so reading and listening lock without any motion."
route: remotion
timing: "each word to the accent in 1 frame at its spoken time (steps(1)); 4-5 words a line; the next clause replaces the line and fills the same way"
curve: steps(1)
demo: src/motion/library/captions/style.ts
sources: ["design-reference/library/abdulah/techniques.json", "src/motion/library/captions/plan.ts", "src/motion/library/captions/style.ts"]
status: draft
---

**What it does.** `active.fill: "switch"` on the caption presets (`cleanSentenceSwitchPreset` for `caption-clean-sentence`): the page shows all its words in white at full opacity; on the frame a word's spoken time starts it takes the accent, and every spoken word keeps it until the page ends. No scale, no box, no brighten.

**When it fits.** A manifesto or voice-over line set small over a plate (a time-lapse, archive), where the words are part of the picture and the voice is slow enough to follow.

**When it does not.** Fast talking heads: the switch every few frames reads as flicker; use `outline-pop` or `word-box`. Lines with no word timing: the fill needs a transcript or alignment.

**Timing.** abdulah 34.0-36.5 s (30 fps): a centred line of 4-5 small serif words with even gaps starts #FAFBFF; each turns #C54A76 in one frame as spoken (F1021-F1024); at F1058 the next clause replaces the line and fills the same way. Ours: the switch lands on the first frame whose time is at or after the word's start (tested).

**Read.** `src/motion/library/captions/plan.ts` (`planCaptionFrame`), `src/motion/library/captions/style.ts` (`cleanSentenceSwitchPreset`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** The accent is part of the contrast check (`contrastPairs` adds it for `switch`): a dark accent over a dark plate fails legibility before render, as it should. The preset keeps clean-sentence's sans; the reference's serif is a face choice, not part of the technique.
