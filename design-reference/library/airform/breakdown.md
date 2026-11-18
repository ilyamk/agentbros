# airform: method breakdown

8.67 s, 1920×1080, 30 fps. Rights: for study only. I cannot hear the sound: everything about sound below is measured from the file (loudness, onsets) or inferred, not heard.

## Idea

A teaser with no product. A short phrase runs as small white captions in the centre of the frame (cap height 33 px, 3% of frame height) over macro shots that are constantly being measured (HUD frames, degrees) and recoloured. The phrase's point: an idea nobody understands is not yet an idea. The edit shows this too: the picture gradually empties down to a caret on black.

## Hook (0–1.13 s)

- F0–F8: a ring of dot-glyphs flickers against black frame by frame (ring, black, ring, black with a blue bar…), the last two frames on ultramarine #062477.
- The caption appears on F4 (0.133 s) and does not flicker: the eye has something to hold on to.
- F9: a white frame. It is an overexposed macro shot, on which measurement frames with dimension labels draw in over 4 frames (F10–F13). Then within 1–2 frames the shot passes magenta → turquoise.

## Structure

| Time | What | Length |
|---|---|---|
| 0–0.30 | ring strobe | 9 frames |
| 0.30–1.13 | macro shot under HUD | 25 |
| 1.13–2.60 | hold: a crescent of light, 7.2% linear push-in, caption only from frame 28 | 44 |
| 2.60–3.53 | hold: an instrument draws a line, 2.8° roll (power2.in) | 28 |
| 3.53–5.37 | burst: lead shot 9 frames, ten shots of exactly 4 frames, last shot 6 frames; caption over the lead shot and the next five | 55 |
| 5.37–5.67 | ground change under a still caption: ultramarine → dark blue | 9 |
| 5.67–7.33 | black, blinking caret, the line is deleted whole | 50 |
| 7.33–8.67 | the last line alone, 34 frames, then 6 black frames | 40 |

The detector found 11 shots; after corrections there are 19 (18 cuts). Median shot 0.134 s, but the shape is what matters: hook, two long holds, one burst, an emptying ending.

## Sound and cuts (not heard)

- There is no rhythm grid: tempo confidence 0.164 (127.6 BPM), audiomap gives 163 BPM. There are 4.27 onsets per second, so shares on onsets mean nothing.
- Over the 18 corrected cuts:
  - 7/18 (0.39) land on a beat against a chance level of 0.314;
  - 10/18 (0.56) on onsets against 0.631;
  - 1/18 on a downbeat ±1 frame against 0.039.

  All of this is chance level.
- 50 ms loudness shows bursts and dips to about −30 dB: 1.2–2.1, 2.8–3.55 and 4.4–4.9 s. The burst edges coincide with the captions: a caption comes on at 0.133, 2.067 and 3.533, and the sound rises at 0.35, 2.15 and 3.60; a caption goes off at 1.133, 2.700 and 4.467, and the sound drops at 1.15, 2.75 and 4.40. Most likely the bursts are the voiceover, and the caption leads the line by about 2 frames (once by 6). The long holds fall in the gaps between lines. This is an inference made from the curve, not heard (confidence ≤ 0.6).
- From 4.95 s the sound rises to −5 dB by 7.9 s, while the picture empties. The film ends on black under loud sound, not in silence.

## Signature moves

1. **flash-montage-under-continuous-caption** (3.53–5.37). Cuts on F115, F119 … F155, every 4 frames: ten shots of 4 frames and the last of 6. The caption holds over the lead shot and the next five, then five shots run without a caption. One shot repeats a frame from the hook. The next caption appears on F154 and holds over the last shot.
2. **grade-step-on-held-plate** (2.37–2.63). The frame holds while the colour jumps in whole frames: monochrome (3 frames), negative (2), cream duotone with an RGB fringe (2). The next shot enters on a single negative frame. The same move at 0.30, 3.33, 4.33 and 5.50 s.
3. **blinking-caret-line-swap** (5.67–7.33). The caret blinks with a period of 19 frames. The line disappears whole on F208, the caret on F216, then 4 empty frames, and the new line appears on F220.
4. **frame-strobe-graphic-open** (0–0.30). Frame-by-frame flickering of graphics under a still caption.
5. **slow-push-macro-hold** (1.13–3.53). Two long, almost still holds in the quietest parts of the sound.

## What we can and cannot do

- **Possible in Remotion:**
  - the ring strobe (needs `missing:dot-matrix-ring`);
  - colour steps through per-frame filters (`missing:duotone-flash`, `chroma-edge`);
  - HUD frames and a drawing with a counter (`kinetic-line-draw`, `NumberRace`);
  - the ground change (`ground-swap-cut`);
  - the caret (`missing:caret-blink`);
  - the 4-frame grid (`speed-ramp-flurry`, `layoutSeries`).
- **Needs a shoot, a licence or budgeted generation:** the macro shots (organic matter, objects, hands, liquid). An abstract shape cannot replace them.
- **Cannot honestly reproduce:** real HUD tracking on a moving shot. The nearest substitute: the shot is almost still (a 3% pull-out), so the frames are placed by hand.
- **Sound and music** are chosen and judged by the user.
