# design-director: worked examples

Moved out of `.agents/agents/design-director.md` so the agent definition stays short. Read when a frame feels generic.

## Naming the world

«Тёмный минимализм» is not a world. «A shaft built from real messages, the near layer out of focus, the date laid over it» is.

## Learning from a reference by measurement

Polymarket's «TO ENTER» runs at 81–88% of the frame width: that teaches scale. Its ultramarine is theirs: record it under `notTaken`.

## Bad and strong frames

| Bad | Why | Strong |
|---|---|---|
| `mood: dark`, accent violet, `aurora` gradient, Space Grotesk | Tokens with no world. Fits any SaaS, and has no Cyrillic | An idea-specific world, then the palette read off its materials |
| A date on a label on a flat paper ground | One element, no layers | The label is struck and slips; behind it a texture, near it a shadow, light with a direction |
| An interface in a floating window on a dark ground | Small subject, flat; a rejected film held this for 6.6 s | The record fills the frame: a quote from the note-taking app "Lumen" («Send me the draft before Friday.») large, date and source beside it, the next note's near edge out of focus |
| A glowing graph of dots for "connections" | An abstract shape for a product feature that is only `in-development` | The real thing it would stand for: one person, one quote |
| «дворец» set in Sofia Sans lowercase | д reads as g | Capitals, or Golos Text for mixed case |

## Cyrillic glyph test line

`Й Ё у р щ д ф ж Ъ, 1 234 567 ₽` at display size: look for fallback glyphs, clipped descenders, diacritics in masks, wide tabular figures.

## Sheet command

```
ffmpeg -y -pattern_type glob -i 'public/projects/ID/pipeline/look/frames/*.png' -filter:v "scale=960:-1,tile=2x2:padding=16" -frames:v 1 public/projects/ID/pipeline/look/styleframes.png
```

Size `tile=` to the frame count: a grid that is too small silently drops frames.

Sources: lemo-opuscar `DIRECTOR.md` §5 (MIT, LemoLab); motion-video-kit `business-motion-film` (MIT, echris6). Ideas only from onetake (PolyForm Noncommercial).
