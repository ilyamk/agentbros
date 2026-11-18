# Caption styles for a user's footage

Burned captions over recorded speech. Pick the style from what the film needs the viewer to do, then set it once for the whole timeline.

## Choosing a style

| Profile | Looks like | Use for | Avoid when |
|---|---|---|---|
| `karaoke` (default) | Bold italic words, active word yellow, three words in view | Existing renders and talking-head split screens | You want pages that hold still while read |
| `outline-pop` | White heavy caps, thick round outline with a hard drop, spoken word green and popping | Loud talking heads, hooks, sales; reads on any footage | Calm or long explanations; caps slow reading |
| `italic-shadow` | Condensed italic caps in yellow on a hard black shadow, words pop in as spoken | Business and podcast clips | Very busy footage; over bright or yellow footage `captions:place` swaps the shadow for an outline |
| `keyword-colour` | White heavy italic caps on a hard shadow, one key word per page yellow and larger; emoji over listed keywords | Education, one point per sentence | Bright footage; pages with no clear key word look plain |
| `word-box` | Sentence-case heavy sans, thin outline, an accent box gliding behind the spoken word | Explainers, product shorts, busy footage | Two-person dialogue, where the box implies a speaker |
| `line-box` | Dark text on a solid white rounded box per line, like the platforms' own labels | Calm, clean pieces; reads over anything | Loud short-form, where it looks quiet |
| `chunky-stack` | Chunky rounded pink caps, one word per line, centred, bouncing in | Lifestyle and creator reels | Fast speech; over light footage `captions:place` adds a plum outline |
| `editorial-mix` | Mixed scale: tiny connective words, a huge key word in mint, a serif italic word in yellow, blur-in | Premium explainers, founder talks, calm hooks | Bright footage behind the caption; fast speech |
| `clean-sentence` | Quiet sentence case, thin outline, up to 6 words brightening as spoken | Interviews, tutorials, long talk | Hooks and fast edits; it will look timid |
| `single-punch` | One huge condensed word at a time, slammed in, key words yellow | Hooks, the first seconds, fast cuts | More than a minute of talk: tiring to read |
| `typewriter` | Mono words typed on with a yellow cursor, on a black box growing with each line | Tech, coding, story beats | Fast speech: typing lags behind the voice |
| `word-highlight`, `bold-upper`, `boxed-word`, `keyword-emphasis` | Saved before the presets; drawn as `clean-sentence` (active word coloured), `outline-pop`, `word-box` and `keyword-colour` (marked keywords only) | Existing timelines | New work: use the preset names |
| `phrase` | Whole phrase held for reading, no highlight | Documentary, calm education | Speech-tracking short-form |
| `keyword` | Phrase with marked words coloured and underlined | Phrase reading with one term | Short-form pages |
| `bilingual` | Original and supplied translation together | Supplied translations only; never invent them | No `translation` on every caption |

The presets are library blocks `caption-<id>` (`--category captions`, preview sheets in `docs/library/previews/caption-*.jpg`); open the sheet before choosing. Recipes, numbers and sources: [caption styles research](../../../../docs/captions-styles.md).

## Readability rules (checked in code)

- Words per page come from the preset (`maxWords` 1–6; 1 is single-word mode); lines are one or two, three for `chunky-stack` and `editorial-mix`.
- A page never holds two speakers or runs across a sentence end: pages break at every speaker change (words carry `speaker` from `wordsFromTranscript`, or a `speaker` field on timeline captions) and short pages never merge across either break.
- There is no blurred scrim. Each preset reads through one treatment in `backing`: `outline` (round-jointed stroke, `width` in em, optional `depth` drop), `shadow` (`x`, `y`, `blur`, `opacity`), or `box` (`fill`, `scope` word/line/page, `padX`, `padY`, `radius`). Override it in `options` when the footage asks for it, e.g. `{"backing":{"kind":"box","fill":"#000000"}}`.
- A page stays on screen at least `minPageSec` (0.8 s for most presets, 0.2 s for `single-punch`); shorter pages merge with a neighbour, from 3 words up by at most one extra word, never on stacked or mixed pages (`buildCaptionPages`).
- Key words (colour, size, the serif word) come from `src/lib/captions/emphasis.ts`: marked `emphasis`, then listed `keywords`, then numbers, then the longest content word; English and Russian connective words never lead. Mark a word `emphasis` to force it.
- Reading speed above about 17 characters per second is a warning: shorten pages or accept it for deliberately fast speech (single-word mode is exempt).
- Platform safe zone: on 1080×1920 x 140–940, y 220–1520, clear of what TikTok, Reels and Shorts draw (top 220, bottom 400, right 140 px), so a lower page ends near y 1476, 77% down; on 1080×1080 title-safe, 10% from each edge; on 1920×1080 bottom-centred in title-safe, 8% from the bottom. `checkCaptionPages` flags a box outside it and `checkCaptionPlacement` text under the platform interface (`CAPTION_IN_UI_ZONE`) or over a face (`CAPTION_OVER_FACE`).
- Placement and contrast over footage: before rendering a timeline, run `pnpm captions:place --project <id>` (`--profile <preset>` to try one before choosing it, `--frames 0-299` for a preview). On a clean still of every page it keeps the preset's position (lower-middle: below the face, above the platform's bottom band; `single-punch` and `chunky-stack` centre) unless a face, printed text or the platform interface is in the way, then measures every colour (3:1, treatment applied) and picks the mildest rung of the preset's ladder that passes. Apply the command file it writes with `timeline:edit` (dry run first); renders repeat the recorded positions and levels. An explicit `position` in the options always wins. For a paid ad add `--placement ad` (`--platform tiktok|reels|shorts` for one; default all): the captions then clear the larger ad interface (TikTok in-feed covers the bottom 660 px). Its report lists pages that still cover a face or fail contrast, and `TEXT_TOO_SMALL`. About one second per page. Rules and sources: [placement](../../../../docs/captions-styles.md#placement).
- Minimum size: cap height 3% of the frame height (2% for the small words of `editorial-mix`), checked on the laid-out page.
- Type is fitted per page to the safe width from measured word widths and never grows past the preset's `size` × `textScale`; scaled and arriving words keep their place, so lines do not reflow.
- `event` words (laughter, music) never become captions; fillers render only if they survived the edit.
- Karaoke keeps its existing position (`spacing.safeBottom`), which sits lower than this safe zone on vertical; prefer a library profile for platform short-form.

## Selecting it in a timeline render

Set the timeline's `captionStyle` with the reversible edit command:

```json
{"type":"caption-style","style":{"profile":"outline-pop","options":{"accent":"#3DFF6E","maxWords":2,"language":"ru","backing":{"width":0.12}}}}
```

`options` are the preset's props (`pnpm library:list --id caption-outline-pop`) merged over it, nested objects (`backing`, `active`, `emphasis`) one level deep; `words`, `startOffsetSec` and `placement` come from the timeline. Set `language` for correct upper-casing. `{"type":"caption-style","style":null}` returns to karaoke. A render option `captionStyle` in the composition props wins over the timeline's; the `render` CLI has no flag for it, so render identity and delivery stay unchanged. Bilingual needs `sourceLanguage`, `translationLanguage` and a supplied `translation` on every caption; the render fails otherwise.

Inside a scene, use the block directly (`<StyledCaptions {...CAPTION_PRESETS[id]} words={...} />`): `wordsFromTranscript(transcript)` (from `pipeline/transcript.json`) or `wordsFromAlignment(words)` (an existing `voiceover/{scene}.words.json`), passed as `words` with `startOffsetSec` set to the transcript second at the scene's first frame.

## Review

Look at stills at a page change, at the active word and at the longest page in every delivered format. Check Cyrillic glyphs, contrast over the brightest shot, and that nothing sits under the platform's buttons. Sound cues: each block's `cues(props)` marks key and listed words for SFX.
