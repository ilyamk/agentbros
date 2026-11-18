---
id: printing-slip
name: Printing slip
intent: A list reads as a physical, earned thing: a paper slip unrolls and prints its rows one by one.
route: remotion
timing: unroll 29 f (0.97 s), power3.out; rows every 1-2 frames at first, then slower; tilt and drift back over the whole shot
curve: power3.out unroll, ease in-out tilt and drift
demo: src/motion/library/three/PrintingSlip.tsx
sources: ["design-reference/library/polymarket/techniques.json"]
status: draft
---

**What it does.** A bent plane in three.js: each frame, every vertex row of the sheet is placed by `curlPoint`, flat down to the unrolled length and wrapped backwards round a roll below it, so the bottom reads as a curl that unrolls. The print is a canvas texture (title, subtitle, label and value rows split to the edges, a torn zigzag edge in alpha) redrawn when a row arrives; the back of the paper is plain. A point light crosses for the sheen while the sheet tilts and drifts back. Block: `printing-slip`.

**When it fits.** A prize table, a receipt, an order or a payout list where the number of rows is the proof (polymarket).

**When it does not.** Long lists (more than about 12 rows lose legibility at playback size); a product's real receipt UI, which must be captured (real-UI rule).

**Timing.** polymarket printing-slip: span 22.00-23.83 s; the diff strip falls 18.0, 10.9, 8.3, 7.0, 5.8 ... 1.0 over F661-F686 (power3.out, 0.967 s); rows arrive about every 2 frames while the bottom unrolls; split-edge rows about 0.045 of the frame height.

**Read.** `src/motion/library/three/PrintingSlip.tsx`; `slipUnroll`, `slipFlat`, `slipRowsShown`, `slipRowFrames`, `curlPoint` in `src/motion/library/three/three-plan.ts`.

**Blender route.** `scripts/blender/printing_slip.py` takes the same title, rows, `at`, `header`, `tilt` and `driftBack` (the block's `frames` is `unrollFrames`), so the row cues land on the plate. The paper is a 2.5 mm solid with a fibre bump and a seeded torn edge, the text is geometry bent by the same curl, and an area light sweeps across for the sheen. Play it with the block's `plate` prop (`pnpm assets:sync --id plates:printing-slip`). Proof: 60 f at 480x270 and 16 samples in about 41 s; production 1920x1080 at 64.

**Pitfalls.** Printing the rows into the texture from the start shows them on the curl; they are drawn only once unrolled. The canvas text needs the font loaded first (`useFontReady`). In Blender the text uses the built-in font, not the film's: for a branded slip, load the brand font in the script first. A plate cannot follow a late copy change; render it again.
