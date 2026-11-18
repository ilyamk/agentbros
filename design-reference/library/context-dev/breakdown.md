# context-dev: method breakdown

19.77 s, 1280×720, 30 fps, no voice. Rights: for study only. I have not heard the sound: everything said below about sound comes from `audio.json`, `sync.json` and a loudness measurement over 50 ms windows.

## Idea
A typed query pulls one person out of a faceless crowd, shows everything known about them, and then shows that every face in the crowd is just as complete. One object passes through every state: a tile in the crowd → a person → a card → a tile in the crowd again → a dot → a letter.

## Hook (0–2.93 s)
F0 is a white frame. F1–F5: a grid of roughly 14×10 portraits in blue halftone grows in 4 frames from 18% of the frame width to past the edges, then the push-in decays (expo.out, about 0.77 s). In the centre a frosted search bar opens out of a dot (F10–F19), and from F22 the query types at roughly one character per frame. On F48 (1.600 s) comes a second, smaller push-in step. The bar does not scale with it: it sits on its own layer. The crowd sets the problem, and the precise query is the question.

## Structure
| Time, s | What happens |
|---|---|
| 0–2.93 | Crowd, two push-in steps, the query types |
| 2.93–4.37 | Sharp transition to a single tile on white (24% of the width); a name types; at 4.0–4.17 the halftone turns into a photo |
| 4.37–8.43 | The card is read in close-ups: a section heading large (57% of the width), then a column of labels and a column of values in turn |
| 8.43–11.07 | Pull-out of about 3.5× to the whole card on white, hold of 1.47 s |
| 11.07–14.13 | Cut to a grid of identical cards in halftone, pull-out in two steps, hold of 0.47 s |
| 14.13–17.93 | Cards turn into dots from the centre outwards, the dots converge into a stream, the stream "writes" a two-part phrase |
| 17.93–19.77 | Five white frames, the product caption and the mark on the same baseline; at the end a blur to white |

## Sound and cuts (not heard, numbers only)
- The detector found 6 shots and 5 cuts; after corrections, 8 shots and 7 cuts, median 1.88 s. The cuts at 0.4 and 1.733 s are push-in steps, not cuts. Missed: cuts at 5.267, 7.2 and 8.433 and the transition through white at 17.933.
- Tempo 126.9 BPM at confidence 0.39. Loudness bursts after 6.3 s come every 0.60–0.65 s (about 95 BPM), so 127 is probably a 4:3 artefact. I did not build a grid.
- From `sync.json`: cuts on the beat 0.20 against a chance level of 0.34, on an onset 0.40 against a chance level of 0.78. So there is no evidence of cutting to the sound. The downbeat hit with a lift of 5.71 rests on one cut and a beat grid with confidence 0.019: it is not proof.
- Over the corrected cuts: on the beat 1 of 7, on a burst 2 of 7 (2.933 and 11.067) against a chance level of about 0.2. There are two measured anchor points: the cut at 11.067 (onset 9 ms later) and 2.933 (burst 8 ms before it). In the intro, where onsets are sparse, the second push-in step (1.600 s) comes 21 ms after the onset at 1.579.
- Loudness is low until 5 s, with a dip at 5–6 s. From about 6.1 s it rises as the card's rows fill. In the last second it falls together with the blur of the picture.

## Signature moves
1. **stepped-push-into-crowd** (0.03–2.13 s): two push-in steps into the halftone crowd, with the search bar still. The first step is a 4-frame acceleration and a 0.6 s tail, the second is F48–F64.
2. **crowd-to-one-cut** (2.87–4.17 s): the bar flashes for 2 frames (F86–F87), F88 is the cut to a single tile on white. The tile grows from 9% to 24% of the width in 2 frames. The halftone turns into a photo over 6 frames (F120–F125).
3. **ui-punch-in-reframe** (4.37–8.43 s): four hard reframes of one card instead of a zoom. Each cut lands on movement: a letter types, a pan or a tilt is running. The side of the card alternates: margin on the right, shadow on the left, shadow on the right. On F131 a word is cut into a close-up mid-typing and carries on typing.
4. **one-becomes-crowd-pull-out** (11.07–13.67 s): a mirror of the hook. The card becomes one of many in the same blue halftone, then two pull-out steps (the second circ.out, 1.28 s) to a grid of about 150 small cards.
5. **particles-write-the-line** (14.13–16.93 s): the cards turn in a wave from the centre into cobalt dots (#2B5EE5). The cloud converges into a cone and stretches into a band at height 0.50. The first half of the phrase types in the tail of the stream (x 0.14), the second inside the stream as it leaves to the right (x 0.67).

## What can be reproduced and what cannot
- **Remotion, ready:** reframes and pull-outs (`RegionCamera`, block `ui-camera-read`; pull-out cubic-bezier(0.65, 0.083, 0.046, 1.151)), per-character typing with blur (`Glyphs`, `typingSchedule`), grids (`CollageGrid`), the push-in step (block `snap-zoom`), holds and the transition through white.
- **Missing:** `missing:halftone-treatment` (halftone with flickering dots; this is already the second reference that needs it, after abdulah), `missing:grid-to-particle-field` (a wave replacing tiles with dots), `missing:particle-stream-to-text` (a stream of dots that reveals text behind it). The `particle-assemble` block is a poor fit: it has a glowing galaxy on a dark ground, and the opposite is needed.
- **Must not be taken:** the mark, the name, the accent colour as a brand colour, the music, the portraits, real people's data, the query text and the phrases. The interface must be our product's real interface (the product UI rule), not a placeholder.
- **Least reliable:** the nature of the sound at the cuts (numbers only), the typeface (only the class identified), the curve of the first pull-out step (taken from the strip), the `motion.json` fits: for s002 and s003 they run past the shot boundaries, for s004 the "roll" on a still tile is noise, and at 15.4 s it is the dots that converge, not the camera. All of them are discarded. The tilt in s005 is fitted across the missed cut at 7.2, and I recalculated the pull-out scale (z −1.38, that is about 4×) from the line width: about 3.5×.
