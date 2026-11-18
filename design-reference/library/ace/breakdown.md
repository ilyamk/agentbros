# ace: method breakdown

**What it is.** 11.6 s, 1280×720, 60 fps. The frame is split into a 2×2 grid: four cells of 640×360 with no gaps or borders. Each runs its own promo for a separate AI/SaaS product. There is no voice, and no logo or call to action at the end. Most likely this is a motion studio's portfolio teaser (an inference, not a fact).

**Idea.** Show range within the time of a single film: four films at once. No cell has to tell the whole story; the message is that the studio will present any product this way.

**Hook (0–1.0 s).** All four cells are moving from the first frame:
- TL: the words of a phrase turn into dots one by one (F3–F17);
- TR: a collage assembles in jerks, on twos (F2–F53);
- BL: a punch-in to the cursor (F49);
- BR: a large word slides under a light stroke.

The eye has nothing to catch on in any single cell, so it travels round all four.

**Structure.** Each cell goes through one arc: an abstract opening, then a character or a problem, then the real interface.
- 0–2.9 s: set-ups, the sound almost silent.
- 2.9–5.0: the pulse comes in: dots become a character, the collage gives way to photos of tired people, a question is sent.
- 5.0–7.6: the first wave of products.
- 7.6–9.7: the products "answer".
- 9.7–11.6: all four cells end on dense interface.

**Edit.**
- The detector found 6 shots and 5 boundaries. After corrections there are 20 shots across the cells and 16 boundaries: 14 cuts, 1 dissolve, 1 smoke wipe.
- Median shot 1.58 s; median interval between boundaries across the whole frame 0.52 s.
- There are never more than two changes within 0.1 s, and coinciding changes sit on the diagonal: TR+BL at 7.633/7.650 and 10.067/10.083, one frame apart.
- The bottom row is cut; the top row changes through morphs and wipes.
- Animation on twos: 30 drawings per second in a 60-frame file. motion.json says "on ones" because it samples every 4th frame.

**Sound: not heard.** I cannot hear the film; everything below is from the numbers.
- Until 2.9 s the loudness is roughly 6.5 times lower, then peaks come every 0.50–0.55 s (about 115 BPM).
- The tracker gives 114.7 BPM with confidence 0.255, and its beats are offset by half a beat from the loudness peaks. Do not build a grid on it.
- Detector metrics: cuts on beats 0 against a chance level of 0.289, on onsets 0 against 0.411.
- Over the 16 corrected boundaries: beats 0.06 against 0.29, onsets 0.25 against 0.41, below chance.
- Over loudness peaks: 6 of 13 within 80 ms (chance 0.31), 4 of 13 within 25 ms (chance about 0.10). This is a weak sign that the strongest change of each wave is placed on a peak.

**Signature moves.**
1. `quad-grid-diagonal-stagger`, 0–11.6 s. Staggered changes, in diagonal pairs. Three cells stay as anchors while the fourth changes, and the frame never "resets" as a whole.
2. `punch-in-cut-settle`. A hard cut to a detail (caret, button, sidebar) and a decaying settle over 16 frames: at 9.183 s the frame difference runs 35 → 5.1 → 3.6 → 2.6 → 1.8, roughly expo.out. Repeated at 0.817, 2.317, 4.117 and 6.083 s.
3. `tilt-fly-match-cut`, 4.45–5.02 s. A click with a ring (8 frames), then a tilt and a 0.4 s accelerating flight into the lens (power2.in). A cut to white: a round avatar sits where the round button was. The cut lands 8 ms before a loudness peak.
4. `dots-to-character-morph`, 2.45–3.40 s. The dots converge and merge, the drop swells into a glossy sphere in 0.37 s, eyes appear, and mint colour fills it from below in 5 frames. The object never leaves the centre of the cell.
5. `accelerating-card-cascade`, 10.48–11.6 s. The headline flows into the first card, then cards fly in more and more often (intervals from 10 down to 2 frames), and the film cuts off mid-acceleration.

**What is reproducible.** Almost everything in Remotion:
- a grid of four `<Sequence>`s;
- `RegionCamera` + `settle`;
- `MatchCut`, `Cursor`, `shockRingAt`;
- `TypedLine`;
- the blocks `ui-toast-stack`, `paper-collage-assemble`, `light-burn`, `caused-morph`.

Missing:
- `quad-split-stage`, a scene with four timelines and a stagger check;
- `words-to-dots`;
- `glossy-sphere-character`;
- `caret-anchored-scroll`;
- `placeholder-resolve`;
- `noise-matte-wipe` for the smoke.

Product screens only from real captures (`capture:app`); collage photos only licensed.

**What must not be taken.** Brands, interfaces, text, the mascot, photos and music. The material is for study only.

**Least certain conclusions.** The audience and the "studio portfolio" are a guess. The tie to loudness peaks is weak (n = 13). The card cascade intervals and the size of the punch-in settle are estimated by eye.
