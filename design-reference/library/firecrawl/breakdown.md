# Firecrawl: method breakdown

22.9 s, 1280x720, 60 fps. For study only. No voice. I have not heard the sound: conclusions about it come from measurements (audiomap, envelope by frequency band).

## Idea

A launch announcement in four moves:
1. What it is and what it works with.
2. How big it is.
3. How much cheaper it is than the competitor.
4. The product on screen does the work; thousands of sources stand behind it.

Everything is said through typography and the real interface. No effects.

## Hook (0–4.0 s)

Two dark sentences on white, word by word.
- In the first, icons of tools for agents stand in place of words.
- In the second, two numbers are highlighted in orange.

Under them, a quiet intro with sparse hits. Each sentence leaves upwards with acceleration, and at 4.000 s everything explodes: a cut to solid orange and a huge number.

## Structure

| Time | What happens | Why |
|---|---|---|
| 0–2.3 | Announcement sentence, icons inside the line | What and for whom |
| 2.3–4.0 | Scale, numbers in orange | Size |
| 4.0–5.3 | Orange ground, percentage at 90% width, shrink with blur | Main argument on the drop |
| 5.3–7.43 | Two text changes on the same orange | Finish the argument |
| 7.43–10.02 | Prompt bar: typing, cursor, click, freeze frame | Input |
| 10.02–15.95 | Chat window: answer, table, camera, blurred scroll | Result |
| 15.95–21.5 | Fade to an empty ground, phrase about sources, push-in on a wall of names, one selected | Breadth of data |
| 21.5–22.9 | Fade to an empty ground, flat logo, sound cuts off at 22.36 | Signature |

## Sound and edit

Tempo 140 BPM. audio.json gives 93.27: that is a 2:3 artefact, not the tempo. The audiomap grid is reliable (0.72), but its beats are shifted half a beat early, so its `beatsSec` must not be used for this film.

**The real grid: beat k = 4.000 + 0.42857·k s.** The six hits of the intro land exactly on sixteenths up to 4.000 s, with an error under 5 ms.

On this grid all six changes in 0–14.5 s land on a beat with an error of no more than 17 ms: 2.283; 4.000; 5.283; 6.150; 7.433; 10.017 (frames checked frame by frame). By chance this would happen with a probability of roughly 5·10⁻⁵, so it is deliberate.

The sync.json figures (0 against 0.23 for random) are wrong: they use a 93 BPM grid and only 3 cuts. There are about 5.4 onsets per second, so cuts landing on onsets proves nothing.

The detector found 4 shots (3 cuts); after viewing there are 10 (9 changes), median 1.6 s:
- It missed the cut at 2.28 and the text changes at 5.28 and 6.15.
- It took the number shrink at 4.48 for a separate shot (`edit.json` now has `reject`; before it had `retype`, which did not remove the cut).
- After 14.5 s: at 15.95 and 21.5 it is not a dissolve but a fade to an empty light ground and something new appearing on it; at 17.45 there is a real dissolve (17.25–17.52).

## Signature moves

1. **Accelerating exit on the beat (1.88–2.28; 3.57–4.0; 7.07–7.43 s).** The block starts moving on a hit and accelerates for 0.33–0.4 s (20–24 frames at 60 fps): up by 7–8% of the height or growing by 30%. The cut falls on the next beat, and the next shot carries the motion. The cut feels like a hit in the music.
2. **Ground swap on the drop (4.00 s).** An orange frame and a number at 90% width, with no flash and no rings. On beat 1 the number shrinks to 44% over 8 frames with heavy blur, then grows for half a beat before the text change.
3. **Sentence in a fixed layout.** Lines are centred and stand in their places from the start; words switch on whole every 8–10 frames at 60 fps (0.13–0.17 s); nothing reflows. Icons in the line work as words.
4. **Click, freeze, cut (9.22–10.02 s).** The cursor reaches the button while the last words finish typing, then the frame holds completely still for 0.58 s (35 frames at 60 fps), and the cut on beat 14 delivers the answer as a consequence.
5. **The camera reads the interface and scrolls (12.3–14.75 s).** The camera accelerates, then a fast vertical scroll with blur (13.0–14.0 s); the lines become sharp while still moving and read on the strong beat at 14.286 s, and the scroll brakes and stops by 14.75 s.

## What we can and cannot do

- **Can do in Remotion now:** the whole stretch 0–7.43 s (`SentenceBuild`, `HeroWord`, `GroundSwap`, `MotionBlur`).
- **Now in the library:** layout without reflow (`type-sentence-build`, `sentenceBuildFixedPreset`), number shrink with blur (`type-hero-word`, `heroWordShrinkPreset`), prompt bar with freeze (`ui-prompt-bar`), chat and table with scroll (`ui-ai-chat`, `ui-data-table`).
- **Needs work:**
  - a shared wrapper for the accelerating exit for any element;
  - a wall of labelled chips with a push-in and one selected (`missing:chip-wall`).
- **The interface must be real.** It is the interface of a new product: HTML capture or a screen recording. A fake would ruin the move.
- **The music must be our own:** 140 BPM, a quiet intro of exactly 9⅓ beats before the drop. Otherwise everything has to be recalculated from the new track's drop: all frames in the spec are given relative to beats.

The frame-by-frame spec for 0–14.5 s for the pilot is in `pilot-spec.md`, its frames in `pilot-stills/` (local only: these are frames of someone else's film, they are not in git; the command to get them is in `pilot-spec.md`).

Least reliable:
- the selection of one chip was analysed every other frame (step 2), not frame by frame;
- the typing rhythm;
- the typeface (matched by eye).
