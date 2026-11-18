---
id: caption-flash-montage
name: Flash montage under one fixed caption
intent: A list said in one line, shown as a run of plates too fast to read one by one, while the caption anchors the eye.
route: remotion
timing: lead plate 9-18f, then flashes of 4/4/4/3/4 frames (flex) or ten of 4 (airform), landing plate 6-37f
curve: steps(1)
demo: src/motion/library/scenes/CaptionFlashMontage.tsx
sources: ["design-reference/library/flex/techniques.json", "design-reference/library/airform/techniques.json", "design-reference/library/nowakdesign/techniques.json", "design-reference/library/cashfree/techniques.json", "src/lib/sensors/flash.ts"]
status: draft
---

**What it does.** Holds one caption at a fixed place while plates hard-cut under it on a frame cadence, each plate with its own grade. One word of the caption can swap per plate (the place name), its last words reveal across the cuts and complete on the landing plate; the caption can also leave mid-run and the next one land a frame before the final plate. Block: `caption-over-flash-montage`.

**When it fits.** Places, uses, customers or proofs named in one spoken line; the burst between two long holds.

**When it does not.** When each plate must be read; more than once or twice a film; a caption over busy, bright plates without a shadow or a quieter grade.

**Timing.** flex t11: five plates of 4/4/4/3/4 frames then a sixth held 37; airform: a 9-frame lead, ten plates of exactly 4, a 6-frame plate; nowakdesign: 3, 3, 5, 6, 4, 4, 4, 4, 20. The default renders flex's 4/4/4/3/4 + 37 exactly (strip against flex 23.77-24.67 s). Cadences ship as `FLEX_MONTAGE_HOLDS`, `AIRFORM_MONTAGE_HOLDS`, `NOWAK_STUTTER_HOLDS`.

**Read.** `src/motion/library/scenes/CaptionFlashMontage.tsx`; `safeHolds`, `montageHolds`, `cadenceStarts` in `src/motion/library/effects/flash-plan.ts`.

**Pitfalls.** Seven or more cuts in a second between plates of different tone is a photosensitivity flash. `flashSafe` (on by default) lengthens the fewest holds so no second holds more than six cuts, which leaves flex's cadence untouched and stretches airform's ten 4-frame plates; turn it off only for plates close in tone, then check the render with motion:check `FLASH_RISK`.
