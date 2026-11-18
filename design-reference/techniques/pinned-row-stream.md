---
id: pinned-row-stream
name: A ranking streams under one pinned row
intent: Scale and position at once: a long table rushes past while the row that matters stays put.
route: remotion
timing: "stream and settle about 0.9 s, power2.out, blurred while fast; a soft band moves along one row"
curve: power2.out
primitive: progress, velocity
demo: src/motion/library/ui/DataTable.tsx
sources: ["design-reference/library/polymarket/techniques.json", "src/motion/library/ui/DataTable.tsx"]
status: draft
---

**What it does.** A long table scrolls under vertical motion blur and settles, while one wider, raised row stays still in its slot; a soft light band then moves along that row. Library block: `ui-data-table` with `pinnedRow`, `rowSheen` and `scrollEase: "power2Out"`.

**When it fits.** Rankings, leaderboards, search results: one item picked out of thousands.

**When it does not.** When the viewer must read the rows that pass.

**Timing.** polymarket: stream and settle about 0.9 s, power2.out (diffs 4-8, peak 10.5-11.3, then 9.0 down to 2.5), blurred while fast; a slow drift follows, then a punch-in by hard cut; a soft sheen on the top row.

**Read.** `src/motion/library/ui/DataTable.tsx` (`PinnedRow`, `Sheen`), `sheenAt` in `src/motion/library/ui/ui-plan.ts`.

**Pitfalls.** The rows are real data or a capture; a sheen on a white row needs the accent tint to read. One reference so far: draft.
