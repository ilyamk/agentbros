# gojiberry: method breakdown

56.5 s, 1280×720, 60 fps. Rights: for study only.

**Idea.** Finding customers is shown as a search that cannot stop counting. In 7.3 s the list doubles from 1 to 524,288 people, and the picture breaks. Then the product turns one described wish into one person with a full-match badge. The value is presented as subtraction: out of the avalanche, one remains.

**Hook (0–6.7 s).** A long, very specific query types into a field at about 2 frames per character. The frame follows the caret, so the start of the line goes off the left edge. Then the query shrinks into a plate above a seated person (2.8 s of near stillness). A hard cut to black: 7 empty frames, then a question line types in. The word just typed glows in the accent red for 6–7 frames. At 5.50 s there is a 4-frame inversion of the ground with a scale jump of roughly 1.7–2 times.

**Structure.** query → person → question on black → accelerating avalanche (6.7–14.1 s) → a one-word demand that breaks (14.1–16.9) → 0.57 s of black in silence → 3D mark and pixel ring → real interface: each phrase typed changes the counter (22.1–35.0) → a press, pink fill, short list → camera tilt to one person with a badge → defocus and an end card with no fade to black.

**Edit.** The detector found 29 shots and 28 cuts. After checking frame by frame there are 36 and 35, median 0.73 s. The detector missed 13 face changes in the montage and one cut in the interface (24.6 s). Another 7 detections are false: flashes, glitches, caret tracking, defocus. Two cuts are shifted to the frame of the face change (11.233 and 13.167 s). Total 28 − 7 + 14 = 35. The film runs at two tempos. Outside the montage the median shot is 2.4 s. Inside the montage there are 20 shots, and their durations fall almost monotonically: 1.47 → 1.53 → 0.88 → 0.62 → 0.45 → 0.45 → 0.47 → 0.25 → 0.17 → 0.15 → 0.12 → … → 2 frames.

**Sound: I cannot hear it.** Tempo 141 BPM, but confidence is 0.15, so I do not build a grid on it. On the corrected cuts: 9 of 35 land on a beat (0.26) against a random level of 0.36. 0.69 land on an onset against 0.51 for random, but there are 3.8 onsets per second, so that figure means nothing. On loudness peaks, 5 of 35 against 18% for random. Conclusion: no evidence that the cuts follow the music. Only one thing is measured: silence coincides with black (silence 16.98–17.45 s with a black frame 16.93–17.5 s; about −69 dB RMS at 16.0–16.5 s). Speech recognition found no speech. What exactly is playing has not been established.

**Signature moves.**
- *doubling-counter-accelerando* (6.73–14.07 s). The layout is still: the number on the left, a face in the centre, a caption and a card on the right. Each cut changes the person and doubles the counter. The face appears 1–3 frames before the digits start rolling (F584→F585, F701→F704, F728→F730); the roll itself lasts 4–5 frames. The eye does not need to move, so even a 2-frame shot reads.
- *caret-tracking-typewriter* (0–1.93 s; 4.7–6.5; 22.1–24.6; 28.1–35.0). The frame holds the caret at x 0.30–0.40, and the new word stays red for 6–7 frames.
- *polarity-slice-glitch-cut* (6.53–6.93 s, 24 frames). Single-frame inversions of the ground and horizontal shifts of bands. Short forms: 1, 4 and 7 frames.
- *black-silence-reset* (16.93–17.5 s). A black frame on silence before the brand.
- *defocus-to-end-card* (48.3–50.5 s). No cut: the person leaves the frame, the shot blurs, the mark and name type over it (about 3 frames per letter). The last frame is the card itself.

**What can be reproduced.** In Remotion: all the typing, caret tracking (`RegionCamera`), the counter roll (`type-odometer-stat`), inversions and slices (`SliceWord` and a new band transition), case changes and letter corruption (`ScrambleWord`), the pixel ring, the fill after the press, the badge and the card. The 3D mark with the `extruded-mark` block. The interface is taken only as a real capture of the product (`capture:app`).

**What cannot be done without a shoot.** Twenty different people in one chair with one framing, a hand gesture, standing up and leaving. It needs a shoot on a locked-off camera or a licensed matched set. Generation does not fit: the faces must look real, otherwise the avalanche does not convince. Missing in code: a camera following the caret, an accent on the last word, a "bands + inversion" transition, frame-swap flashes, character-by-character case change, the pixel ring, a growing badge, a defocus ramp and a generator for an accelerating list of cuts.

**Least certain points.** The exact frames of the face changes at 13.8–13.97 s (confidence 0.7). Everything to do with sound. The typeface is guessed by eye.
