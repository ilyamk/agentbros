---
id: word-split-insert
name: Word split open around an insert
intent: "Function reveal or transition: a verb or an instruction literally opens to show what answers it; the gap is where the eye already rests in a centred line, so the insert needs no travel."
route: remotion
timing: "Gap opens 0.08 of the width in 5 frames (power2.in); the insert grows from a dot or rises tilted and settles in 5 frames (power3.out); fling: a 3-frame pop, then the halves jump 65% of the way off the edges and drift out over 13 frames (power2.out)"
curve: power2.in to open, power3.out to settle, jump plus power2.out to fling
primitive: splitState, flingProgress, splitCurves
demo: src/motion/library/typography/WordSplitInsert.tsx
sources: ["design-reference/library/foren/techniques.json", "design-reference/library/muse/techniques.json", "src/motion/type-track.ts", "src/motion/library/typography/WordSplitInsert.tsx"]
status: draft
---

**What it does.** A word ("Move", split at a glyph) or a short line ("Just ask", split at the space) holds; the halves part with an accelerating gap; an insert (disc, card, pill, image or any children) grows from a dot or rises from below with a depth tilt that is gone once it settles. In `part` mode the halves make room and frame the insert; in `fling` mode they scale up and are thrown off both edges the frame the insert is full, leaving it alone at the centre. Library block `word-split-insert` (`wordSplitInsertFlingPreset` for the fling).

**When it fits.** The product or person that does what the verb says: "Move [card] ve", "Just [portrait] ask". A connector between two shots: cut on the open gap and land the next element there.

**When it does not.** Long lines (the halves no longer read as one word). A generic stand-in for a product screen: pass the real capture as `src` or children.

**Timing.** foren 32.5-32.7 s (30 fps): the gap opens over F976-F980, frame differences 1.73, 2.31, 3.31, 4.77, 7.7 (accelerating); ours 1.42, 2.97, 5.30, 7.52, 7.84 over the same 5 frames. foren 31.0 s: the card settles flat in 5 frames; ours settles in 5 (differences 13.7, 14.6, 9.9, 4.8, 1.3). muse 7.43-7.97 s (30 fps): dot at F223, disc full at F226, then 17.5, 7.0, 3.9, 2.7, 2.0, 1.3, 1.1, 1.0, 0.6; ours from the full disc 17.8, 5.7, 4.3, 3.5, 2.1, 1.6, 0.9, 0.4, the cropped letters lingering at the edges about 9 frames against muse's 12.

**Read.** `src/motion/library/typography/WordSplitInsert.tsx`, `src/motion/type-track.ts` (`splitState`).

**Pitfalls.** A plain expo.out throw clears the frame in 2 frames; the reference jumps most of the way and then drifts, so the halves stay readable as cropped letters. The fling distance is from each half's inner edge to its frame edge, less the room already made, or the halves vanish at once. The card's 3D tilt is dropped (2D transform) once it settles, or motion:check reports `NON_DETERMINISTIC`. In `fling`, motion:check reports `TEXT_OFF_STAGE` for the thrown halves; that is the technique.
