---
id: rising-sheet
name: A sheet of the next ground rises with a long tail
intent: The new ground arrives as one physical sheet, fast and then settling, so the next element can start drawing on it before the old plate is gone.
route: remotion
timing: "6% to 55% of the height in 4 frames, 72% at 7, 86% at 12, full at about 22 (power3.out); the next element starts before it is full"
curve: power3.out
primitive: cutTiming, easeFamily
demo: src/motion/library/transitions/SlicePanels.tsx
sources: ["design-reference/library/flex/techniques.json", "src/motion/library/transitions/SlicePanels.tsx"]
status: draft
---

**What it does.** A flat sheet of the next scene's ground rises from the bottom edge over a still plate, covering half the frame in about four frames and then easing into a long tail; a sliver of the old plate stays at the top until the end. Library block: `slice-panels` with `sheetCoverPreset` (`count: 1`, `motion: "clip"`, `curve: "power3.out"`, `reach`).

**When it fits.** A change of ground between sections (photograph to brand colour, brand colour to off-white) where the next element, a ring or an interface panel, should start drawing on the new ground at once.

**When it does not.** Between two busy scenes: the clipped edge reads as a curtain. When the new scene's content needs to move in with it, use the panels' `slide` motion instead.

**Timing.** flex (seen twice, 1.67-2.50 s and 14.80-16.23 s): front at about 6% F52, 34% F54, 55% F56, 72% F59, 86% F64, about 100% F74 (30 fps). The next scene's first element (a stroke ring, then interface panels) starts drawing on the sheet before F74. The cut is perceived where the sheet crosses half the frame (`sheetPeak`), four frames in.

**Read.** `src/motion/library/transitions/SlicePanels.tsx`: `sliceCover`, `sheetPeak`, `slicePanelsPeak`, `sheetCoverPreset`.

**Pitfalls.** Give it `cutTiming`; an eased timing doubles the ease. `reach` below 1 jumps to full on the seam's last frame, which is the cut: use it only when that frame lands on a hit. The old plate must hold still under the sheet (`sink: 0`, `shade: 0`), or the move reads as two motions.
