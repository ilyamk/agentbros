# cashfree: method breakdown

57.2 s, 1280×720, 30 fps, no voice. An agency case study: the rebrand and website of a fintech company. For study only: do not copy the graphics, music, brand or text. The crop (`crop`) in source.json is `null`, so all sizes are measured on the full frame.

## Idea

The work is not described but shown in progress. In front of the viewer a brand system assembles; on a design editor's canvas a headline is typed, deleted and retyped, and a page is built from it. Then the finished page appears on a monitor, a tablet, phones, a stage and a billboard. At the end the viewer is asked whether they need something like this.

## Hook (0.00–4.27 s)

On a white ground a caret types a huge word, about 55% of the frame width, at 2–3 frames per letter. A cut carries the question into a search bar over a photo of hands with a laptop, then into chips around a phone. The question is never finished. An object finishes it: the ball on the phone screen, through a match cut (2.333 s), becomes a glossy 3D ball on a dark green ground between two words. At 3.73 s the ball grows past the frame edges in 8 frames (circ.in), its colour becomes the ground, and the mark turns into the logo.

## Structure

The detector found 54 shots (53 cuts); after edits 43 shots and 42 changes remain. Median 1.00 s, p10 0.40 s, p90 2.60 s, 44 changes per minute. Long shots of 2–5 s, inside which everything is built (ball, brand board, bento, canvas, grid), alternate with runs of 0.3–0.6 s. Chapters open with a typed line on a flat ground (0.0; 18.6; 27.0 s, end card 51.8 s). The order is: question → client → site on a monitor → "brand" chapter (chips, palette, 3D fan, giant letter, bento) → the brand in the world → "site" chapter (canvas, devices) → "built properly" → grid of many pages → big number → row of icons → features in split frames → the brand on people → results triad → call to action and the agency's end card.

## Sound and edit (I cannot hear the film)

Everything below comes from audio.json, sync.json and RMS analysis.
- Tempo 103.9 BPM, confidence 0.58, downbeat confidence 0.09. An older measurement gave 155 BPM, which is ≈1.5×, so even the beat level is unclear. A grid must not be built on this tempo.
- Over the detector's cuts, 0.34 on beats against a chance level of 0.266 (lift 1.28). Over the corrected ones, 11 of 42 (26%) against 27% by chance; within a frame of a downbeat, 1 of 42 against 2.8%; signed median +0.001 s. There is no link to the beat.
- 4.5 onsets per second, too dense: the share of cuts on onsets means nothing. There are 63 loudness peaks, mostly 0.58 s apart, and 8 of 42 cuts land on them against 22% by chance.
- The only coincidence: the cut at 42.033 s falls 0.028 s after a section change (42.005 s), where separate hits give way to a continuous bed. This is one case, not a rule.
- The end card holds over 1.07 s of silence (56.12–57.19 s).

## Signature moves

1. **element-grows-to-ground, 2.20–4.27 s.** A match cut on the ball (F69→F70); the ball sits in the line like a word, then grows from 10% of the width past the frame edges in 8 frames (motion.json: circ.in). The mark slides left, and the logo word wipes out from under it in 4 frames. The eye holds on one object for two seconds.
2. **canvas-type-becomes-live-page, 18.63–23.43 s.** On a white canvas a three-word line types word by word, one every 5 frames, holds for 40 frames, deletes character by character (19 characters in 9 frames, about 2.1 per frame), 6 frames empty, then the real headline types word by word, one every 3.4 frames. Over 8 frames the camera punches in so that the headline runs past both edges (OCR 0.875 of the width), and navigation, a tilted button and 3D icons drop in around it. A hard cut to a wide shot of the finished page in a browser. The result is a "before and after" inside one shot.
3. **frame-shrinks-to-product-object, 4.93–6.17 s.** Three overexposed mint-white frames, then the live page full frame, resolving from pixels in 0.33 s. At 5.66 s the frame pulls back onto a monitor screen on a green studio ground: scale ≈0.47 over 0.46 s, power3.out (0.46; 0.76; 0.16; 0.83). The viewer reads the page first and only then sees the device.
4. **bento-assemble-around-hero, 16.10–18.63 s.** A photo shrinks in one frame into a card ≈63% wide in the centre. Around it tiles appear within 1–2 frames with no animation, and counters rise every frame (149+ → 175+ in 12 frames). The centre is still; density grows around it.
5. **caption-anchor-over-footage-stutter, 44.03–46.47 s.** A caption stays in one place (x 0.47, y 0.46, ≈10% of the width) over three photos of 0.3–0.5 s each. Before it, the same photo goes from a card 45% wide on white to full frame. The still caption gives the eye an anchor, and the short shots read as one statement.

Two more moves are recorded only in techniques.json. **ground-swap-mid-typing** (27.03–28.03 s): a line types without stopping while the ground changes on the cuts from near-black → lime → near-white, and on white the line is 3 times smaller. **stepped-grid-pullback** (29.6–31.57 s): a grid of cards pulls back in one-frame jerks, 1→2→4→6→9→12.

## Detector corrections

14 boundaries rejected: typing (s002), a change within the frame (s005), the ball growing (s007), collage assembly (s010, s012, s013, s016, s032, s041), an element being deleted on the canvas (s018) and the stepped pull-back as one shot (s026–s029). Boundary s013 moved from 11.80 to 13.567 s through reject + split. Missed cuts added at 48.55 s (an insert change, by the same rule as s050) and 54.733 s (the end card). s006 reclassified as `match`.

## What we can reproduce and what we cannot

- **Remotion:** typing and deleting (`type-caret-track` with `retypeLine`, `caretTrackRetypeCharPreset`; technique `delete-and-retype-line`), growing into the ground (caused-morph, GrowToScene), ground changes (ground-swap-cut), bento (scene-bento-collage, but with tiles appearing on a cut, no animation), the number race (type-number-race), the stepped grid (CollageGrid + track), the CTA pill (morphRect, TypedLine), the icon mark (extruded-mark).
- **To add:** a design-editor canvas with named cursors (`multiplayer-canvas`), a ball character in the line (`glossy-sphere-character`), a marquee row with an enlarged centre tile (`focal-marquee`), resolving from pixels (`pixel-resolve`), the hero snapping into a card (`hero-snap-to-card`).
- **Blender:** a monitor on a coloured studio ground (our studio-product-stage only does dark), an isometric array of phones.
- **Shoot, stock or generation:** lifestyle photos with hands and people, a tablet in hand. Pages and interfaces only from real capture (capture:app), no placeholders.
- **Cannot reproduce from the files:** the sound. I cannot hear it; the music and our own soundscape must be chosen afresh.
