# nowakdesign: method breakdown

10.27 s, 1280×720, 30 fps. Rights: for study only.

## Idea
This is a 10-second film for a design studio. First, one tiny sentence about the studio giving things shape. After that nothing is explained: in every shot a raw element (a capsule, a letter, a square, a slider) turns into a finished interface before your eyes. Then comes a burst of archive and scientific footage under one still caption, and at the end only the mark remains on black. The film itself serves as the portfolio.

## Hook (0–1.87 s)
- **0–0.30 s.** Three empty full-frame flashes of 3 frames each: dark blue `#021563`, black, white.
- **From 0.37 s.** A white sentence about 25% of the frame width sits exactly in the centre of a black field. Cap height is about 3% of the frame height.
- **Inversion.** Every 7 frames the frame inverts: F16 turns white, at F23 black returns, and F24–F25 give an RGB split.
- **Pause and exit.** Then 21 frames of complete stillness. Exit: the text flashes with a green glow for 2 frames (F47–F48), disappears at F49, then 7 frames of black.

The flashes grab attention, the small type drives the eye to the centre, and the silence after the strobe gives the statement weight.

## Structure and rhythm
The detector found 23 shots (median 0.467 s). After corrections **19 shots and 18 cuts** remain: median 0.30 s, 105 cuts per minute. The film has three speeds:
1. **1.87–5.77 s, proofs.** 6 shots of 0.2–1.13 s. Each shot is one object in the centre that changes state within the shot.
2. **5.77–8.00 s, argument.** A huge outline word (70% of the width). Then 9 shots of archive footage of 3–6 frames under one caption that does not move.
3. **8.00–10.27 s.** The only long shot, 2.27 s: the mark in the centre, the background pulls back and fades to black.

On top of the cuts runs the film's own "clock": **10 background blinks to blue `#021563`** of 3 frames each at F0, 62, 110, 129, 150, 157, 220, 267, 286 and 307. Intervals 62, 48, 19, 21 | 7 | 63, 47, 19, 21 frames, that is, one 150-frame (5 s) figure repeated twice.

## Sound (not heard)
I cannot hear. There is nothing to listen to here anyway: in `audio.json` the whole file is silence from 0–10.325 s, there are no onsets, the loudness range is 0 LU. So there is no tempo, and neither `cutsOnBeat` against chance, nor `cutsOnOnset`, nor the v2 metrics can be calculated. Sync between picture and music is not confirmed by anything. The word "you" recognised by Whisper is a hallucination on silence. The repeating blink figure suggests that the source was edited to a musical phrase that is not in this file. This is an inference, confidence 0.4.

## Signature moves
- **polarity-strobe-title** (0–1.63 s): see the hook.
- **icon-swell-to-ground** (1.87–2.53 s). A capsule about 68% wide shrinks and blinks blue. An icon 4% wide remains. From it a violet disc grows over 7 frames (F68–F75) and becomes the background. Curve expo.in, bezier (0.562, 0.338, 0.88, −0.462). The next scene grows out of the previous one without a cut.
- **word-becomes-shape + angle-match-cut** (3.00–3.97 s). A small gradient word holds for 5 frames. Then the letters fly apart and the first letter turns into a stroke: the stroke rotates ~35° and stretches to 46% of the height (F95–F113, power2.out). A hard cut at F118 gives a square with a highlight at the same angle at the same point, and the eye travels diagonally through the cut.
- **ground-blink-punctuation** (whole film). The background turns blue for 3 frames, the object stays in place and is redrawn with a halftone screen. The blinks sit on the last frames before a change of state and hide the seam.
- **caption-anchor-over-footage-stutter** (6.23–8.00 s). A caption 25% wide stays in one place over 9 shots of 3, 3, 5, 6, 4, 4, 4, 4 and 20 frames. Each shot has its own colour grade, tracking boxes and coordinate labels. The eye reads the caption, the images flicker at the edge of the field of view, and 9 images in 1.77 s are perceived as one thought.

There are also micro-labels "x: NNN y: NNN" on every object: they create the feel of a design tool and analysis.

## What can and cannot be reproduced
- **Possible (Remotion):**
  - the strobe with inversion;
  - the disc growing into the background (`GrowToScene`, block `caused-morph`);
  - rings (`ShockRing`);
  - the outline word (block `type-hero-word`, `scrambleChroma`);
  - halftone (block `texture-overlay`);
  - the angle match cut (`MatchCut`);
  - a pull-back with back.out.
- **Needs writing:**
  - `missing:ground-blink`: a background blink from a list of frames;
  - `missing:glyph-to-stroke`: a letter into a stroke;
  - `missing:hud-tag-overlay`: boxes and coordinates;
  - `missing:lens-streak`: a diagonal highlight;
  - `missing:polarity-strobe`: a strobe from a list of frames.
- **Footage only:** archive portraits, old computers, medical scans, macro shots of a keyboard. Licensed or our own material is needed; do not use recognisable people without permission.
- **The interface** (slider, reactions, message) must be the real interface of the new product.
- **Do not copy:** the mark, the sentences, the graphics, the archive footage, or the colour `#021563` as a brand colour. We take the method: everything in the centre, proof by transformation, one accent blink on a repeating figure, three speeds, an ending on the mark with no fade.
