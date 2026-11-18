# abdulah: method breakdown

69.83 s, 1280×720, 30 fps, for study only. A promo for a recurring tech conference, made as a manifesto. I cannot hear the sound: everything said about sound comes from `audio.json`, `sync.json` and loudness measurements, not from listening.

## Idea

The voice claims that the future is made, not waited for. The picture moves from archival heritage, through what machines can do today, to the questions the viewer brings with them. Only after that are the event's real people and its name shown. Small serif type on a black or paper ground is cut straight against tinted archive and stock.

## Hook (0.00–5.43 s)

On a black ground a small line (x 0.18; line height 0.061 of the frame) types out letter by letter from frame F4, with no caret, animated "on twos". Beside it, until 1.26 s, archival portraits flicker past, one every 5–6 frames. After a 16-frame hold the last word turns grey for one step, and the line deletes backwards in five chunks of one or two words, a chunk every 2 frames (F114–F122, 7 words in 10 frames). The first word holds for 4 frames, slides off to the right with acceleration and on F130 is hard-swapped for a new one (no scramble), and the counter-thesis builds up one word at a time. The first full-frame image appears only at 5.43 s. The viewer watches a claim being written and withdrawn, and waits for the correction.

## Structure

Hook → heritage (5.4–16.6: card on paper, archival "ladder", hero shot) → turn to the present (16.6–21.3: pages with typing, chips, collage, glitch) → list of capabilities (21.3–31.0: one word, one shot) → the real question (31.0–42.8: moon with word fills, questions over landscapes) → direct address in handwriting (42.8–47.1) → refusal (47.1–50.4: a hold and an image flurry at 12/s) → proof (50.4–56.3: the real event) → closing line with portraits (56.3–61.9) → name on the same location and a black ending (61.9–69.8).

## Edit and sound (not heard)

The detector found 58 shots. After corrections there are 67, that is 66 cuts: 56.7 per minute, median 0.83 s. Without the image flurry the median is 1.40 s (p10 0.16, p90 2.68). Corrections:
- 11 missed cuts found in the flurry and 2 in the archival ladder;
- 6 text changes on a flat ground and 2 real cuts added (26.73 and 30.97);
- 12 false boundaries rejected: flare, cards over the layout, card growth, grade changes, moon phases, stepped push-in;
- 3 transitions reclassified (match, wipe).

There is no sync with the music. Tempo confidence 0.04. On the beat: 0.197 of cuts against a chance level of 0.272. On onsets: 0.545 against 0.630, but there are 4.5 onsets per second, so this figure proves nothing. Within a frame of a downbeat: 0.015 against 0.032. On loudness bursts: 0.114 against 0.20. By section the picture is the same. The edit follows words and pictures: each word in the list gets its own shot on the same frame (23.30; 24.30). Whisper timings are rounded to whole seconds, so this is an order, not an exact time. Measured: during the flurry the loudness is ~2 dB above neighbouring stretches, the ending is quieter than the middle of the film, and the close drops to −30 dB RMS.

## Signature moves

1. **Archival ladder into a match cut (6.87–7.40).** Four pictures of the same building, 4 frames each, in one composition, each entering through a 1–2 frame flash. Then a match cut to the same building in colour, and the shot holds for 4.77 s.
2. **Image flurry at 12 per second (48.53–50.40).** 23 images in 1.87 s with a 3-2-3-2 frame rhythm, which looks like (but is not proven to be) a 24 fps edit with each image held for 2 frames. Before it, a still shot of 1.43 s; after it, a still shot of 1.67 s.
3. **Type and delete (0.13–5.43).** Described in the "Hook" section.
4. **Cut through a flare (12.10–12.17 and 6 more places).** Each shot change is hidden behind 1–3 frames of overexposure or a colour flash; the new shot starts on the frame after the brightest one.
5. **Card grows into the scene (30.07–30.37).** Card width over 9 frames: 0.11 → 0.18 → 0.47 → 0.88 → 1.0 of the frame.

Also: a picture chip rides behind the typing caret (17.1–19.4). Word fills in #C54A76 over a moon timelapse (34.0–36.5). Portraits appear around the closing line exactly every 4 frames (59.6–61.9).

## What can and cannot be reproduced

Possible in Remotion: typing and deleting (`type-caret-track` with `retypeLine`, `caretTrackRetypeWordPreset`; technique `delete-and-retype-line`), the chip behind the caret, scattered words, word fills, card growth (`caused-morph`), cuts through a flare (`light-burn`), the image flurry (`speed-ramp-flurry`), the portrait field, the ending.

Still to build:
- halftone treatment of a shot (`missing:halftone-treatment`);
- wave distortion (`missing:wave-displace-glitch`, or a hyperframes shader);
- duotone flash;
- scattered-word layout.

Cannot be generated: the archive, the stock and above all the real footage of the event. The proof must be real footage. Do not copy the music, graphics, brand, text or photos: all of these change in the adaptation (`blueprint.json`, `transferRules.mustChange`).
