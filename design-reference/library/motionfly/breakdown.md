# motionfly: method breakdown

30.2 s, 1280×720, 30 frames/s, for study only. A launch film for a service that makes a promo film from a single sentence. There is no voice: the speech layer is empty and all the words are on screen.

## Idea
The film proves the promise by being it. First the promise is typed on screen, then the film shows the very techniques the service promises to produce: typing, irises, a 3D phone, a ring of previews. In the middle comes a real demo: a prompt, a click, a generation checklist.

## Hook (0–2.0 s)
On a white background (#FEFEFE), a single line sits in the centre. Every 10 frames a new whole word appears. It arrives pale lilac (#B873B3), turns raspberry (#B73A69) on the next frame, then teal (#0A7F6F), and black about 5 frames after it appears. The line re-centres after each word. Four dots at the corners spread to the line's new corners over 5–8 frames, like a selection box. At F54–F59 the two halves of the sentence move apart; at F60 there is a hard cut.

## Structure
The detector found 19 shots; after review there are 13: 12 boundaries, of which 10 are cuts and 2 are circular wipes. Median shot 2.0 s, 23.9 boundaries per minute.
- Promise, 0–2.0 s.
- Landscape with a toolbar, 2.0–5.5 s.
- Introduction of the name, 5.5–9.4 s. The shortest shots, 1.07–1.6 s.
- Interface demo, 9.4–16.8 s.
- Phone and ring of previews, 16.8–21.1 s.
- Value statement, 21.1–24.5 s.
- End card, 24.5–30.2 s.

Each section has its own background: white, photo, dark (#0D0D15), white, pastel interface, white. The mark (a square logo) carries across five boundaries and serves as an anchor for the eye.

## Sound and cuts (I cannot hear)
I cannot hear the sound; everything below comes from measurements.
- **Tempo.** 125.8 BPM at a confidence of 0.127, so I do not build a beat grid.
- **Beats.** On the corrected cuts, 5 of 12 land on a beat (±80 ms) against a chance rate of 0.33. Lift 1.27; by section, 2 of 6 and 3 of 6.
- **Downbeats.** No cut lands on a downbeat to the frame (0 of 12).
- **Onsets.** There are 4.9 per second, so the share of cuts on onsets means nothing.
- **Loudness peaks.** They coincide with cuts 2 of 12 times against a chance rate of 0.16.

There is no link between the cuts and the music. The film's clock is set by the animation: a word every 10 frames, a letter every 2–3 frames, a checklist row every 6–17 frames. The last 0.83 s (29.33–30.19 s) is measured silence.

## Signature moves
1. **word-build-tinted-arrival** (0–2.0 s). Words arrive tinted and settle to black, inside a corner frame.
2. **card-collapses-to-underline** (F60–F72, 2.0–2.4 s). A black card covering 92% of the frame shrinks over 12 frames with an ease-out (power3.out) and becomes the underline of the selected icon.
3. **mark-carry-iris-open** (F256–F289, 8.5–9.6 s). The mark detaches from the name and rises to the top. At F283 a circle 45% of the frame wide opens around it and over 6 frames expands into the product screen, where the mark becomes the header.
4. **orbit-ring-flies-past-frame** (F621–F633, 20.7–21.1 s). A ring of ~30 previews flies out past the frame edges over 12 frames while the line in the centre stays still; then a headline replaces it.
5. **roll-exit-to-spinning-mark** (F724–F743, 24.1–24.8 s). The headline block rotates ~12° while accelerating. After the cut, the rotated mark, 27% of the frame height, spins back and shrinks.

## What can and cannot be reproduced
- **Possible in Remotion.**
  - Word and letter typing: `TypedLine`, `type-sentence-build`.
  - Irises: `shapeWipe` with a circle and `fromSize`.
  - Mark carry: `MatchCut`.
  - Lockup and ending: `scene-end-card`.
  - Punch-in: `RegionCamera`.
  - Prompt and checklist: `ui-prompt-bar`, `ui-ai-chat`.
- **Phone.** `blender-plate`, or `studio-product-stage` or `ui-phone-hero`.
- **Missing:**
  - a tint on arrival that settles to black;
  - a corner frame made of dots;
  - a soft edge on `shapeWipe`;
  - a mask that shrinks into an element;
  - text on an arc that straightens;
  - a rotating ring of cards.
- **Do not take:** the brand, the mark, the music, the landscape, others' app icons, the copy.
- **Real only.** The interface must be the real product (capture:app or an exact rebuild). The landscape and previews must be licensed or our own.

Least certain:
- the typeface (guessed from the letterforms);
- the exact angles and scales of the rotations (estimated from frames);
- the audience.
