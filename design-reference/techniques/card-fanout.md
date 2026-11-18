---
id: card-fanout
name: One card becomes a grid
intent: One input visibly becomes many tailored outputs, or many tasks visibly fail, as a picture rather than a claim.
route: remotion
timing: "fan-out: cards about 4 f apart from about 0.3 scale, back.out, source dissolves; status: cards in within 9 f, a chip about every 0.5 s in cursor order, outlines in the last 5 f, about 14% push"
curve: back.out
primitive: stagger, trackPoint, progress
demo: src/motion/library/ui/UiCardGrid.tsx
sources: ["design-reference/library/postiz/techniques.json", "src/motion/library/ui/UiCardGrid.tsx"]
status: draft
---

**What it does.** `fanout`: a source card dissolves as N cards spring out of its rectangle into the cells of a grid, one after another. `status`: a grid of cards lands, a cursor visits them and a small warning or error chip attaches to each, then every card is outlined at once before the cut. Library block: `ui-card-grid`.

**When it fits.** one input turned into a tailored output per channel; "everything is breaking" problem hooks; any one-to-many mechanism.

**When it does not.** When the cards' contents cannot be read or captured: empty cards read as a wireframe.

**Timing.** postiz fan-out: the caption fades over 3 frames, the source card dissolves and cards spring out about 4 frames apart (F389, F397, F401, F403), each from about a third of its size to its cell of a 3x2 grid about 85% of the frame wide, back.out. postiz opener: six dark cards in a 3x2 grid appear within 9 frames; a cursor visits them and a red or amber chip appears roughly every half second under a slow push of about 14% (power1.out); in the last 5 frames every card is outlined, then a hard cut.

**Read.** `src/motion/library/ui/UiCardGrid.tsx`, `fanoutPose`, `gridCells` and `statusSchedule` in `src/motion/library/ui/ui-plan.ts`.

**Pitfalls.** Each card's content is a capture of the real product's view for that destination (`src` per card); the block's grey cards are placeholders. Seen in one reference so far: keep the card in draft until a second film confirms it.
