# nexaa: method breakdown

31.5 s, 1280×720, 24 fps. Rights: for study only. There is no voice: Whisper found not a single word; everything rests on the on-screen text and the music. **I cannot hear the sound.** Everything said below about the sound comes from `audio.json`, `sync.json` and the RMS that I recalculated from the source.

## Idea

A silent launch of an AI assistant inside a work web portal. First, kinetic typography on two backgrounds names what it is and who it is for. Then, in the real interface, two real questions are typed and answered. At the end come a list of three benefits and a short slogan. The proof here is that the interface answers, not the claims.

## Hook (0–1.6 s)

- **F0–F14.** The first word stands in the frame at about 2.5× and spills over both edges. It pulls back to 43% of the frame width on `expo.out`: 90% of the travel takes 0.43 s (`motion.json` s001).
- **F17.** A hard cut to the product name. A blurred blue patch of light slides right and over 9 frames reveals the word, coloured in the brand colour.

## Structure

| Time, s | What happens |
|---|---|
| 0–1.6 | Introduction: the word and the name |
| 1.6–5.6 | Definition. White text on saturated blue, then dark blue on white. Each line is 10–30% smaller than the previous one (glyph height 16 → 14 → 12 → 10 → 6.7% of the frame), so the last one matches the interface text in size. It dissolves into that text from left to right, F127–F142 |
| 5.6–15.3 | First demonstration. A punch-in of about ×1.8 on the input field, back to the wide shot, a ×7 macro of the button, a "working" status for 2.5 s, then a shimmering placeholder grows into a comparison table |
| 15.3–19.25 | Turn. A new pale blue background, a sentence is typed large, at F399 the frame jumps sideways in one step to the send button, click. Three ticks fill in turn: F435, F444, F451 |
| 19.25–25.6 | The second question is typed large, the camera follows the caret. The answer appears line by line |
| 25.6–31.5 | A sentence about the relieved pain, the wordmark, the call to action and the final line. The last frame holds with no fade |

**Cuts.** The detector found 10 shots (9 cuts). After corrections there are 20, with 19 shot changes:

- 9 hard cuts;
- 4 reframes on the same interface: punch-in, pull-back, macro and the sideways jump at 16.625 s;
- 4 text changes on an unchanged background;
- 2 dissolves.

The median shot lasts 1.26 s, 36 changes per minute. Before 15.3 s the median is 1.17 s, after it 1.46 s. The longest shots (4.2 s and 4.0 s) fall on the moments when answers are being generated.

## Sound and cuts (not heard, figures only)

- **Tempo.** 123 BPM at a confidence of 0.55; downbeat confidence 0.17. A bar grid cannot be built on this.
- **Cuts and beats.** All 19 changes: 9 of 19 within 80 ms of a beat against 33% by chance (lift ×1.4). The quiet half is at chance level (3/10). The loud half is 6/9 against 33%: lift ×2.0, but the sample is 9 and weak; the sideways jump at 16.625 s sits 163 ms before a beat. Only 1 of 19 is within a frame of a downbeat; signed median +0.024 s. For the detector's cuts, `sync.json` gives 0.556 against 0.33 (lift 1.68), onsets 0.333 against 0.727, downbeats 0 against 0.044, signed median −0.025 s.
- **Onsets and loudness peaks.** Onsets are dense (3.8 and 7.0 per second), so their shares mean nothing (10 of 19 against 73% by chance). Loudness peaks (RMS 50 ms) coincide with cuts at chance level: 4/10 against 37% and 1/9 against 22%.
- **Firmly measured.** Once the table has assembled, the music drops almost to silence from about 14.5 s (RMS about 50 against a median of 1322) and starts to rise at about 15.18 s. The cut to the new background is at 15.292 s, and full loudness arrives at about 15.55 s, that is, 6 frames after the cut. What exactly plays there ("riser", "drop") is only my guess.

## Signature moves

1. **giant-word-pull-out, 0–0.71 s.** The word pulls back from 2.5× to 43% of the width over 14 frames (`expo.out`). The eye gets one shape and one direction before reading.
2. **ui-punch-in-reframe, 6.58 / 8.08 / 9.67 / 16.625 s.** Cuts instead of a zoom: about ×1.8 on the first letter (line height by OCR 0.037 → 0.065 of the frame), a pull-back to the wide shot when the line no longer fits, then a ×7 macro of the button. Later the same move sideways: at F399 the frame jumps at the same scale to the end of the field with the button. The text is sharp in every frame.
3. **accelerate-into-cut, 11.1 / 15.3 / 17.8 / 19.25 / 21.7 s.** The outgoing shot accelerates up to the cut (the table leaves to the left into the cut at 15.292: `motion.json` s007 `circ.in`, 0.4 s), and the incoming one continues the motion in the same direction and settles over 4–6 frames. White on white reads as one camera.
4. **skeleton-shimmer-to-content, 13.67–14.58 s.** A violet-lilac placeholder grows from a dot by the answer line to the size of the table over 12 frames, then the text develops through it over 6 frames. The detector took this for a "whip".
5. **silence-gap-before-drop, 14.5–15.55 s.** About 0.7 s of near silence under the proof, the cut 3 frames after the rise begins, full loudness 6 frames after the cut.

## What can and cannot be repeated

- **Possible in Remotion.** All the typography, the light and the patch, punch-ins on an interface capture (`RegionCamera`, `ScreenPlayback`, `TypedLine`, `Cursor`), acceleration into a cut, the ticks, the shimmering placeholder, the dissolve into the UI, the final text changes.
- **A real capture of the new product is needed.** The interface cannot be drawn to look "similar". The capture is made at high resolution, otherwise the ×7 macro will not hold up.
- **Not in the library.** A placeholder with running stripes (`missing:shimmer-placeholder`) and a card with ticks (`missing:check-row-list`). Both are built from `growRect`, `track` and conic gradients.
- **Do not take.** The brand, the wordmark, the brand colours, the music, the text of the questions and answers, the interface screens. The music is replaced with a licensed track, and only the "stop → rise → return" structure is repeated.

## Tool errors

Previously the static-bar detector wrongly cropped the analysis copy by width (x 308–1278). Now `crop` in `source.json` is null, and all measured layers (shots, OCR, contact sheets, `motion.json`, `sync.json`) have been recalculated on the full 1280×720 frame. The OCR boxes with x=0 at 16.5–17 and 20–21.5 s are real: the large field runs off the left edge while the camera follows the caret.

On the full frame the detector places two cuts earlier than they are: 9.625 instead of F232 (9.667) and 10.958 instead of F267 (11.125). Both are corrected via `move` and `retype` in `cut`. It no longer finds the cut at 19.25 (added as `split`), and it now finds the cut at 27.375 but calls it `continuous` (corrected via `retype`). I saw the sideways jump at F399 (16.625) when rechecking on the full frame, confidence 0.75.
