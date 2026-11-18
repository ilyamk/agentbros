# flame: method breakdown

22.6 s, 1280×720, 23.976 fps. A subscription promo for solo editors (project files and lessons). For study only: do not copy the graphics, music, brand or text.

## Idea

The film does not tell the story of a sketch turning into finished work; it shows it. Each scene is made from the central object of the previous one: the guide frame becomes a metal tile, the tile collapses to a point and bursts into spheres, the capsule behind the logo grows into the ground, the tile turns into a finished page, a phrase shrinks into a button, and the button becomes the end card.

## Hook (0.00–1.75 s)

A white ground, a crosshair of hairlines with four node dots. The first three words of the voiceover appear between the lines one at a time, every 4 frames. Each word is highlighted green for 2–3 frames, then turns black. From 1.54 s the guide frame leaves past the edges of the frame over 12 frames, and the dot in the centre grows into a metal tile 20% of the frame wide. In the first two seconds the viewer sees the whole film in miniature: a sketch turns into an object.

## Structure

After corrections there are 12 scenes; the detector found 6. Scene lengths: 1.75 · 1.71 · 1.46 · 1.73 · 1.40 · 1.79 · 1.67 · 2.00 · 1.75 · 0.96 · 1.92 · 4.46 s, median 1.74 s. One scene corresponds to one voiceover sentence. Order: premise → raw material → problem (first colour, spheres) → brand as the answer → product (a gradient card, interface windows fly into it) → quality bar (a dotted globe, two words at the edges of the frame) → the tile again → finished page (payoff) → what the subscription includes (two buttons) → phrase about ownership → call-to-action button → end card with the address and 2.3 s of silence.

## Sound and edit

I cannot hear the film. Everything below comes from audio.json, speech-text.json and the contact sheets.
- In sync.json, across the detector's 5 cuts, the share of cuts on beats is 0.60 against 0.26 for random (lift 2.29). Across the 11 corrected cuts the share on beats is 36% against 31% for random, on onsets 64% against 74%, within a frame of a downbeat 0 of 11 against 4%. There are no more matches than chance. Tempo confidence is 0.12, so 116 BPM is most likely an artefact, and no grid can be built on it.
- There are 5.3 onsets per second, too dense to prove anything. Loudness peaks (RMS 50 ms) coincide with cuts in 27% of cases against 33% for random.
- The voice sets the film's clock. 6 of the 11 scene changes fall within a 0.25 s window around the start of a sentence against 20% for random, and in 5 of those 6 the picture leads the word by 0.04–0.22 s. I chose the windows after looking at the frames, so this points to the method rather than proving it.
- Words on screen lead the voice by 0.18 s on average (median over 9 pairs, timings from the contact sheets; range −0.81 to +0.04 s).
- The voice ends at 18.9 s; the last section is quiet (energy 0.13 against 0.44). I cannot say whether there is music under the ending.

## Signature moves

1. **element-grows-to-ground, 17.10–18.35 s.** The call-to-action button grows with acceleration (sine.in from motion.json): 48% of frame width → 59% → 88% → full frame by F436 (18.18 s). The highlight on its top edge becomes the dark border of the end card. The same move at 6.54–6.84 s: the capsule behind the logo becomes the ground in 4 frames. The eye is already on the button, so the end card arrives without a cut.
2. **sentence-collapses-to-button, 16.10–17.18 s.** The phrase fades out from the first word, and a capsule 12% wide appears in its place. For half a second the capsule pales to a ghost, then in a single frame (F411→F412) becomes a saturated blue button four times larger in area. The accent comes from contrast, not a flash or a cut.
3. **collapse-to-point-burst, 3.25–3.75 s.** The tile rounds into a disc and shrinks to a point over 6 frames. A ring of dots spreads around it, iridescent spheres fly in from the edges over 5 frames, and this is the first colour in the film. The centre stays empty, and the next phrase appears exactly where the point drew the eye.
4. **material-becomes-interface, 11.26–11.88 s.** The grey tile widens from 20% to 33% over 6 frames and turns blue, then becomes a dark page. The horizon line in its gradient turns into the page's arc of light. This is the payoff of the promise.
5. **guide-frame-opens-to-object, 1.54–2.04 s.** The guide frame leaves past the edges of the frame (power1.in), the words slide apart. Only the dot in the centre stays still, and it grows into the tile.

## Detector corrections

The detector found 6 scenes; after corrections there are 12. Scene s001 is split into 1.75 and 3.46 s: these are morphs, not one scene. The s003 boundary at 7.38 s is rejected because it falls in the middle of the windows flying out. In its place, a cut at 6.65 s (the card becomes the ground) and a missed hard cut at 8.05 s are added. A missed cut at 9.84 s is added: on the white ground the diff is only 2.9. The morphs at 11.51 s (tile → page) and 16.22 s (phrase → button) are split out as separate scenes. Of the 11 changes, 4 are hard cuts and 7 are morphs.

## What we can and cannot repeat

- **Can do (Remotion):** all the transitions: GrowToScene / caused-morph, morphRect, growRect, spring() with fitted constants (stiffness 13.8, damping 2.33), letter-by-letter typing through typingSchedule, word-by-word phrase build (type-sentence-build), the end card (scene-end-card).
- **Needs building:** the iridescent sphere (`missing:iridescentSphere`), the ground with white relief (`missing:embossedGround`), the dotted globe (`missing:dotGlobe`), the brushed-metal texture (`missing:brushedMetalFill`).
- **Real material only:** the interface windows and the page must be real product captures (capture:app), not placeholders.
- **Least sure about:** the curve names read from the contact sheet (power2.in/out), the link between cuts and sentence starts (fitted after viewing), and whether there are sound accents on the button click and the sphere burst. I cannot hear them.
