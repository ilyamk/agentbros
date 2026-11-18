# reference-analyst: worked examples

## Fails and passes

| Fails | Passes |
|---|---|
| "Dynamic editing with bold typography" | "Each stat holds 0.9 s, then hard-cuts on the next beat; the numeral fills 70% of frame width, left-aligned to a fixed margin, so the eye never moves across the cut" |
| "Smooth transition" | "Whip left, 5 frames (F212–F216): outgoing frame streaks by F213, peak blur F214, incoming settles by F216 with about 8% overshoot" |
| "Engaging hook" | "0.0–1.2 s: the outcome is shown before the product is named, so the first question is how, and the name arrives as the answer at 1.2 s" |

## Detector faults seen on real films

- A dim background hides cuts: `ugc-app` held a line of text over seven or more background cuts; `match` fired only because the bright text stayed put.
- Pages aligned on one highlight count as one shot, although there are several.
- Moves across one continuous sheet read as `whip` between scenes. When outgoing and incoming panels share the screen and the gutter passes between them, ask whether the whole film is one stage: that changes the route.
- A long ease reads as `whip`, a thrown object as `continuous`, with times off by up to 0.4 s.

## Sound without hearing

- `polymarket`: 19 of 21 cuts landed on onsets in the loud section against 70% by chance, 1 of 8 in the quiet one — recompute per section with corrected cut times.
- `ugc-app`: swell detection (50 ms RMS, local maximum over 0.3 s each side, above 1.35× median) showed an uneven figure repeating about every 3.7 s that onsets hid; most main picture changes landed on it.
- `paper-style`: tempo confidence 0.11, voice-led; the clock is the words, so compare moves with word times.

## First-pass errors caught on re-check

A shot table one row out from `shots.json` for eight shots; a camera direction reversed; "first object lands on the first word" disproved by word times; a line called fixed that recentred as each word arrived; sizes estimated by eye instead of measured from the tile.
