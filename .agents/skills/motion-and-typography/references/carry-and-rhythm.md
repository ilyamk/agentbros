# Carry and rhythm: why a film reads as slides

Measured lessons from onetake's accepted and rejected films (feitangyuan/onetake; see `design-reference/sources/onetake.md`). "It looks like a slideshow" has two independent causes. Check both; passing one does not excuse the other.

## Rhythm: the metronome

- Shot lengths must vary: coefficient of variation ≥ 0.25 (our `film:targets` p90/p10 well above 1). Two cuts of the same nine pages, each 1.55 s or 0.74 s, were rejected; the accepted cut ran 0.22–2.2 s.
- Rests are real: the accepted references were dead still for a quarter to a third of their frames, with at least one still stretch of ≥ 1 s. A slow push or a floating camera in a hold counts as motion. Plan a rest as `camera: "locked: rest"` and let nothing move; it is what makes the burst land. (A hold that must deliver information is a different shot and still needs a moving layer.)
- A burst is ≥ 3 big changes inside 1.5 s, not at a uniform interval. Match the reference's bursts; a concept with none (one element transforming, one continuous take) is not wrong.
- Never end two shots in a row the same way (spring-out, blur-out, hard cut: alternate).
- Small elements, big ground: the genre's frame is about 70 % empty. A whole page shrunk to a thumbnail shows none of its motion: show it full frame with the cause visible, or show one live component of it in a card.

## Carry: beats that replace each other

A film with perfect rhythm was still rejected because every beat was its own scene (`display:none` swaps). It was accepted once each beat grew out of the last.

- At each boundary something survives and visibly moves ≥ 2 % of the frame diagonal or scales ≥ 10 % (carried). A large unchanged survivor is half a carry (anchored). Nothing surviving is bare. Score = (carried + anchored / 2) / boundaries; rejected cuts scored 0.00 and 0.40, accepted ones 0.56–0.75.
- Bare cuts belong only in a burst of hard-cut hits and into the end card. Write the reason in `carry` as `"hard-cut: <why>"`.
- Build a carry from **one element changing**, not two crossfading: a card fading out while a page fades in at its size reads as a replacement.
- Page after page is a slideshow even when each page moves.
- A fade or slide between unrelated scenes is not a carry.

| Boundary | Carry | Library block |
|---|---|---|
| The thing pressed becomes the result | container morph | `shared-element-carry`, `caused-morph` |
| One card among many is the next scene | push until it fills the frame | `zoom-through`, `snap-zoom` |
| The subject opens its own world | a circle opens from it | `colour-flood` (origin on the subject) |
| A flood must end on a new scene | rings drain from one point | `ripple-drain` |
| The subject arrives on the title | lands, glyphs split and rejoin | `impact-split` |
| Many things become the brand | fanned arcs into a turning seal | `gather-seal` |
| The hand caused it | keep the cursor across the cut | `ui-cursor-click` |

## Cause and meaning

- The cause must be visible: a cursor clicking real element centres (press and release about 75 ms apart), or the concept's own subject (a dot that splits, a ball that lands). A page reacting to nothing reads as a screensaver.
- Build the idea into the artwork, not into labels. A film whose meaning was unclear got worse with labelled cursors; it read once the idea (an "&" hidden in two plates) appeared in the picture at the moment it meant something.
- No particles, confetti or sparkles that are not the product's own behaviour. If a beat needs a flourish, let the type land with squash and wobble.
- Never carry the last film's look into the next one: palette, stage, camera grammar and transitions are chosen per concept.

## Camera

- Chase, don't trail: key the landing point before the subject arrives (`expoInOut`) to read as an operator snapping to it; trail by about 0.1 s on `sineInOut` to read as following. Hand float is zero in the rests.
- On the beat, a camera that reframes every beat becomes the metronome, and alternating sides flips the screen direction each time (the eye re-finds the picture). Accepted instead: one direction for the stretch, motivated movement (bank with the subject's turn, roll ≈ −0.5 × its turn rate, clamped to ±0.22 rad), then a stepped pull-back of one 0.24 s `cubicOut` step per beat, starting 40 ms early, landing exactly on the next section's set-up. The subject can carry the beat too: let it surge into the hit.
- Deep zoom (past about 20×): key the anchor's screen position and log zoom, then derive the camera; world-space keys swing the subject a frame width per pixel of error. Draw nested levels in their own units so type stays sharp.
- A move on an empty ground does not read: put a faint far layer (grid, dots) behind it.
- Shake at 30 fps with motion blur doubles text. Narrated UI films get no shake.

## Product UI on screen

- Legibility is arithmetic: on-screen text = font px × UI scale × camera zoom. Anything the voice names needs ≥ 26 px at 1080p; a window that must be read fills 70–80 % of the frame width. Fitting cards, window and result into one wide shot made the UI unreadable.
- One close-up per operation; the camera follows the cursor between them. The wide shot is for when the relation is the point.
- Highlight with a glowing rounded rectangle sized to the content, drawn on and off; for a menu row ring the icon and name, not the whole row.
- Showing the result early and cutting back is two cuts. Show the future in a lens or window over the base shot instead.
- A rebuilt UI (strings in a table, each state a pure function) beats a recording: any zoom stays sharp, every language is data, nothing leaks. Check it side by side with the real product, and keep its content real.
