---
id: marquee-rows
name: Marquee rows on one braking track
intent: "Function emphasis or transition: a promise or a list said many times at once; rows that arrive moving and brake to a hold give a beat without a cut, and a focal falloff makes one item the subject."
route: remotion
timing: "foren: rows enter moving and brake to a near hold in about 25 frames (expo.out), held for the rest of a 1.33 s shot; cashfree: a tile row slides 0.43 of the width on circ.out, centre tile 1.3x; ugc-app: words cross at constant speed, sharp only near centre"
curve: expo.out (brake), circ.out (slide), linear (constant marquee)
primitive: marqueeTravel, marqueeCopies, focalAt
demo: src/motion/library/typography/MarqueeRows.tsx
sources: ["design-reference/library/foren/techniques.json", "design-reference/library/cashfree/techniques.json", "design-reference/library/ugc-app/techniques.json", "src/motion/text-modes.ts", "src/motion/library/typography/MarqueeRows.tsx"]
status: draft
---

**What it does.** Full-width rows, each a phrase repeated with a chip between the repeats (or a run of icon tiles), offset from row to row so nothing lines up, all on one horizontal track. The track either enters moving and brakes to a near hold, or slides a set distance, or runs at a constant speed. Every other repeat takes a secondary ink. Optionally each item scales and blurs by its distance from frame centre, so the item passing the centre is the subject. Library block `marquee-rows`.

**When it fits.** A wall of the promise's last words before a cut to the product (foren); a row of supported integrations or currencies under a sentence (cashfree); big words passing a lens while the small words wait (ugc-app, with `focalBlur`).

**When it does not.** A list the viewer must read item by item: rows read as texture, not as copy. A slow film with long holds: the motion is the beat. Brand logos of third parties need their licences, like any logo.

**Timing.** foren 8.10-9.43 s (30 fps): frame difference 34, 41, 42, 42, 41, 36, 33, 32, 25, 24, 22, 17, 16, 15, 12, 11, 10, 7 over F243-F260, an expo.out brake to a near hold over about 25 frames; onset 20 ms before the cut. cashfree 32.97 s: the tile row rises in one frame and slides 0.431 of the width (camera fit circ.out), centre tile about 1.3x. ugc-app 13.07-14.07 s: differences steady at 13-17 a frame, constant speed; focus by distance from centre. Ours: rows 0.28 of the height, 0.45 of the width over 25 frames on expo.out, then a 0.0006-width drift a frame (tested: first-frame speed more than ten times the speed at frame 20); side by side with foren 8.1-8.97 s (`motion:strip --vs`) the rows match in size and both brake to a near hold within about 8 frames.

**Read.** `src/motion/library/typography/MarqueeRows.tsx`, `src/motion/text-modes.ts` (`marqueeTravel`, `marqueeCopies`, `focalAt`), `tests/motion-blocks-gap-typography.test.ts`.

**Pitfalls.** The rows overflow the stage by design and declare it with `intendedOverflow`; do not put a caption in them. Blur is per item and isotropic, not a motion blur: for fast travel wrap the block in `VelocityBlur`. With `distance` and `drift` of opposite signs the track reverses after the brake.
