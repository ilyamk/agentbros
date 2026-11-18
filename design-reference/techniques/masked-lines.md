---
id: masked-lines
name: Masked line reveal
intent: A composed line feels placed rather than typed, with the emphasis arriving after it lands.
route: remotion
timing: 24 frames per line, 6-frame stagger; underline draws for 20 frames from frame 34
curve: expoOut
primitive: MaskedLines
demo: EditorialMaskL
sources: ["src/motion/lab/EditorialMask.tsx", ".agents/skills/motion-and-typography/references/motion-grammar.md", "src/motion/AGENTS.md"]
status: demonstrated
---

**What it does.** Each line rises from behind its own mask. An emphasis stroke draws once the lines have landed.

**When it fits.** Editorial lowercase statements, read as a unit, including tight line-heights with descenders.

**When it does not.** Copy that changes with props and has no hand-set breaks: automatic wrapping can differ between formats.

**Timing.** Lines start at frame 2 with a 6-frame step and take 24 frames at line-height 0.98. The underline uses `inOut`.

**Read.** `src/motion/lab/EditorialMask.tsx` (also `EditorialMaskV`)

**Pitfalls.** This is the sanctioned exception to the rule against translating text in, because the motion is hidden. The bleed zone shows while a line travels, so check the frames with Й, Ё, у, р, щ and д.
