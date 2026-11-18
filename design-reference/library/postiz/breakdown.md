# postiz: method breakdown

40 s, 1280×720, 30 fps, for study only. I cannot hear the sound: everything said about the sound comes from `audio.json` and `sync.json` and from a loudness curve computed from the file.

## Idea
Posting to six social networks stops being six separate tasks: a person writes one sentence to an AI assistant in a chat, waits one bar and sees the finished work. Audience: people who already use a chat assistant and run a small business's social accounts (in the example a bakery announces a new item).

## Hook (0–3.7 s)
The problem is shown without words. On an almost black background a 3×2 grid of dark cards appears in 9 frames. A cursor visits them in turn, and roughly every half second a red or yellow error badge appears under each one; underneath runs a slow camera push-in of about 14%. By F105 every card is outlined in red or yellow, then a hard cut to a light cream frame. The viewer recognises their own routine before anything is promised to them.

## Structure
A three-step loop repeats twice, the third time in shortened form.
1. **Request** on a cream title card #F8F4EC: a line in a book serif face in the centre, a bubble with the request in the top right corner, a bubble with the reply in the bottom left.
2. **Wait**: a dark loader #1A191E exactly 4 beats long. A two-disc mark assembles in 8 frames, with a caption under it about what the assistant is doing now.
3. **Result** on a light interface.

The evidence builds: one post becomes six, then the whole week fills, then a post is published at once, without the loader. After that comes the summary line, in which the verb changes, and the ending.

Cuts by the detector: 11 shots and 10 cuts. After my corrections: 10 shots and 9 cuts, median 3.70 s, 13.5 cuts per minute. The corrections are:
- the "whip" at 25.1 s is in fact a camera pull-back within one shot (s007+s008 merged);
- the last 0.1 s of black (s011) is the tail of the ending's fade-out;
- at 36.933 s a missed scene change on the same cream background is added: s010 is split into the summary line and the ending.

## Sound and cuts (not heard, measurements only)
- Tempo 129.3 BPM, confidence 0.74, regularity 0.97.
- Almost every shot lasts 55, 111 or 166 frames, that is 4, 8 or 12 beats. The verb swaps in the summary line also come every 55 frames.
- According to `sync.json`, cuts land on a beat in 10% of cases against a chance level of 33%, on a downbeat ±1 frame in 0% against 3.5%. This is an artefact. Between 5.6 and 8.1 s the beat tracker drifts by about 0.2 s, while the loudness peaks (RMS over 50 ms) keep an even step of 0.46 s.
- By these peaks, 8 of 9 cuts sit 2–3 frames before the hit, and from 9.23 s every cut sits 1–2 frames before the onset.
- There are 4.65 onsets per second, so the share of cuts on onsets (0.80 against 0.68) proves nothing by itself. Downbeat confidence is 0.058, so there are no conclusions about bars, only about groups of 4 beats.
- Rule to carry over: shot length is a multiple of 4 beats, the cut comes 1–2 frames before the hit. That it is a kick drum hit is only an inference.

## Signature moves
- **one-to-many-card-fanout**, 12.80–13.50 s (F384–F404). The caption fades in 3 frames, the source card dissolves, and from its place, roughly every 4 frames (F389, F397, F401, F403), cards for each network spring out with an overshoot. motion.json gives back.out, 0.26 s, overshoot 0.27. The eye travels outwards from one point and sees the transformation itself.
- **select-retype-word-swap**, 32.93–35.40 s. The verb sits in a pale blue selection #CADDF1 with an orange cursor flag. At F998 and F1053 it is erased, and the new word is typed one letter per frame, with the line re-centred every frame. The gaze stays in one place; only the meaning changes.
- **populate-then-pull-out-reveal**, 22.17–25.43 s. The week fills with events every 4–6 frames under a linear camera drift. Then over 15 frames (F748–F763) there is a pull-back from about 1.2× to 1.0× with expo.out, and the whole week is visible.
- **dark-loader-interstitial**, 9.23–11.07 and 20.30–22.17 s. A dark pause of exactly 4 beats; the change from a light to a dark background separates the request from the result.
- **cut-ahead-of-kick-on-4-beat-grid**: nine hard cuts without transitions, each 2–3 frames ahead of the hit.

## What can and cannot be reproduced
Can be done in Remotion:
- title cards with an empty first frame and the phrase appearing in place over 3 frames (needs `missing:sentence-build-final-layout`);
- chat bubbles (`ui-chat-thread`, `typingSchedule`), the loader (`DrawSVGPlugin`), a toast (`ui-toast-stack`);
- the pull-back across the board (`RegionCamera`);
- the word swap (`type-word-rotate` plus `missing:selection-retype-slot`);
- the card fan-out (`missing:fan-out-from-origin`);
- the cut grid (`beatGridFromMap`, `snap`).

The interfaces in the film (composer, network cards, calendar, chat) are product screens. For our film they must be captured from the real product (`capture:app`) or rebuilt pixel-faithfully from a fresh screenshot. A generic block in place of the product will not do.

Must be changed: the marks and logo typeface, the brands' accent colours, the music, all text, the example customer and the set of networks. There are no unavailable moves.

Least certain points:
- the scale of the pull-back (about 1.2×, by eye);
- the rhythm of the badges appearing in the hook (OCR gives a 0.5 s step, which matches the sampling rate);
- typefaces that were not identified.
