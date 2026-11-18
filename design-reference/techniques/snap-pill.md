---
id: snap-pill
name: Snap pill highlight
intent: "Function proof or emphasis: one highlight pill moves between the words that matter by jumping on a frame, so emphasis shifts like a cut instead of a sweep."
route: remotion
timing: "the pill opens empty over 5 frames (power2.out), its words type in a word every 2 frames, then it jumps to the next group in 1 frame (steps(1))"
curve: power2.out to open, steps(1) to jump
primitive: markedGroups, pillState, wrapCentred
demo: src/motion/library/typography/MarkerHighlight.tsx
sources: ["design-reference/library/ugc-app/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/MarkerHighlight.tsx"]
status: draft
---

**What it does.** `mode: "pill"` on block `type-marker-highlight` (`markerHighlightPillPreset`). Consecutive marked words (`*Most* *people*`) form a group. At `markAt` a pill opens empty under the first group, its words type in, and every `markStep` frames the pill jumps to the next group on one frame. The words inside take `markedColor`. The sentence is laid out once and centred, so nothing reflows.

**When it fits.** A stat line where the figure is the payoff after the subject; a sentence with two key phrases read in turn.

**When it does not.** One key word: the marker sweep reads better. Groups that break across lines: the pill covers only the group's first line.

**Timing.** ugc-app 6.9-13.1 s (30 fps): the pill opens empty, fills with its words, then jumps to the figure between F308 and F309 (difference 7.99), with no frame between. Ours: open in 5 frames, jump in one (tested).

**Read.** `src/motion/library/typography/MarkerHighlight.tsx`, `src/motion/text-modes.ts` (`pillState`, `markedGroups`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** Mark each word of a group separately; `*4 hours*` across a space is not parsed as one mark. The pill opening empty is the beat: if the first group's words arrive before `markAt`, they wait for the pill.
