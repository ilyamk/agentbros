# foren: method breakdown

46.2 s, 1280×720, 30 fps. Rights: for study only (study-only). An advert for a business bank for companies working in several currencies.

## Idea

A business that works across borders should manage its money from one place. The film says this in short lines (2–5 words) on two alternating grounds: cream `#F2F4E9` and a warm near-black `#201A16`. It proves each phrase either with the product's real interface or with literal graphics of the claim: the currency claim is a disc whose symbol keeps changing; the speed claim is a counter running to zero; the growth claim is a rising chart.

## Hook (0.00–2.43 s)

A phrase types in word by word on cream. At 1.17 s, a hard cut to the dark ground: the key word types in yellow `#F6E977`, one letter every 2 frames (F35–F45), and grows by about 15%. On the frame where the word is complete (F45), the ground changes to a photo of a crowd, and the word turns white, staying in the same place and at the same size. At F56, a second photo; at F66, yellow on dark again; at F73, cream. Five picture changes in 1.27 s, and the word never moves once. The eye does not need to search for anything.

## Structure

Claim → address to the viewer (cards with portraits) → brand mark → promise and a kinetic "wall" of words → first product screen → three features. Each feature is first presented as a graphic pun, then confirmed with the real interface. Then the reward (a growth chart) and a signature with the address. 39 shots after corrections, median duration 0.97 s (from 0.23 to 3.07 s), 49 cuts per minute. Lines of text hold for 0.7–1.3 s, interface steps for 1.6–3.1 s, and the motion happens inside the frame. Cuts are hard only: no dissolves, no wipes. 18 of the 38 cuts change the ground type, and this replaces transitions. Four cuts start with a single empty frame of ground (F132, F959, F1010, F1298).

## Sound and cuts (I cannot hear the film)

Tempo not measured (librosa unavailable), so I did not build a beat grid. Detector: cuts on onsets in 27.5% of cases against 21.2% for random. Across the corrected cuts, 12 of 38 (31.6%) against 21.2%, lift 1.49. By section: the opening 4 of 8 against 40% for random, the interface middle 2 of 14 against 18% (at chance level), the finale 6 of 16 against 18% (lift 2.1, weak evidence). Loudness peaks (RMS over 50 ms) come at a step of about 0.40–0.45 s, but with a ±0.3 s window this does not prove a 150 BPM pulse. Peaks coincide with cuts at chance level (11 of 38 against 23%). Loudness is low until 9 s and rises with the first product screen. The conclusion that the "drop" is placed under the dashboard is my assumption. Under the address the track fades out.

## Signature moves

- **type-on-photo-flash** (1.17–2.43 s): a word types in, then two photos flash under it for 10 frames each; the word stays in place.
- **dot-to-wordmark** (4.40–6.77 s): a dot grows over 6 frames into a disc 13% of the frame wide, and the mark assembles inside it over 12 frames. Then the disc slides right, revealing the letters, and becomes the full stop at the end of the name. At F193 the colour changes from yellow to white.
- **mirrored-object-layout-cut** (12.43–14.70 s): a disc with a symbol on a yellow trail. The symbol changes after 17 frames; on the cut the composition mirrors.
- **word-split-insert** (31.00–33.00 s): a verb is split, and an interface card flies into the gap. Then a slit opens in the whole word over 5 frames, and the cut lands exactly in it: a pill with an arrow appears where the slit was.
- **countdown-behind-word** (33.67–34.53 s): behind a still word, a blurred giant counter runs to zero on frames 0, 2, 4, 7, 11 and slows down.

Also in the breakdown: a cut on a click in the interface, a crop insert with a still caption (18.33 s), a wall of words with deceleration (expo.out, about 25 frames), a line change "conveyor-style" upwards, an end card with a single address and no fade.

## What we can and cannot repeat

Can do in Remotion: word-by-word typography every 2 frames, ground swaps, disc to mark, trail with symbol, word split, counter, chart (`line-chart-glow-draw`, `type-number-race`) and inserts (`RegionCamera`, `snap-zoom`). The missing primitives are marked as `missing:` in `techniques.json`: showing a line's words without recentring, a ticker wall, a word split that hands over the slit, a counter behind a word, an orbit of cards in the corners, a symbol change in the disc.

Must be shot or licensed: portraits of people, photos of the crowd and of a shopper. The interface must be the real interface of the new product.

Must not be copied: the mark, the name, the address, the brand colours, the typeface, the music, the text, the flags and the graphics. I have not heard the music: the user judges it.
