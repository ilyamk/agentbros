---
id: selection-retype-slot
name: Select and retype a word in a held line
intent: "Function emphasis: a key word in a held claim is edited live (selected, deleted, retyped) so the change reads as a decision, with a named caret as a person making it."
route: remotion
timing: "selection held about 0.5 s (15 frames); cleared on the beat; the replacement types a letter a frame (7-8 frames for 7-8 letters) while the line recentres; swaps 55 frames apart"
curve: none (one letter a frame)
primitive: retypeSlotState
demo: src/motion/library/typography/WordRotate.tsx
sources: ["design-reference/library/postiz/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/WordRotate.tsx"]
status: draft
---

**What it does.** `swap: "retype"` on block `type-word-rotate` (`wordRotateRetypePreset`). The slot word sits in a pale selection box with a caret and a name flag above it for `selectFrames` before its swap; on the swap frame it is gone and the next word types a letter a frame; the whole line (prefix, slot, `suffix`) recentres every frame as the slot grows.

**When it fits.** A claim line that applies to several verbs or audiences (one object, several verbs swapped in front of it); a collaborative product where an edit by a named person is the story.

**When it does not.** A product's real editor: show the real one (`capture:app`). Long replacements: a letter a frame makes 20 letters take most of a second.

**Timing.** postiz 32.93-35.33 s (30 fps): the first word in a pale blue selection with a named caret flag for about half a second; on the beat the selection is deleted and the replacement types at a letter a frame (F998-F1004); swaps 55 frames apart, 0.04-0.06 s before measured loudness swells. Ours: 15 frames of selection, one letter a frame, `hold` 55 in the preset (tested).

**Read.** `src/motion/library/typography/WordRotate.tsx`, `src/motion/text-modes.ts` (`retypeSlotState`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** The block's fit allows for the longest slot word, so the line never outgrows the frame mid-type. The flag name is a fictional collaborator: never a real person's name without consent.
