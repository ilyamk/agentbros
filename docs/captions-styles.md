# Caption styles: research and recipes

Last updated: 2026-11-13

How short-form captions are made by the tools and creators people copy, and how the presets in
`src/motion/library/captions/style.ts` turn that into numbers. Choosing a preset for a film: the
[caption styles reference](../.agents/skills/captions-and-localization/references/caption-styles.md).

## What the field does

Sources were read as text only (no code or assets taken); they are listed at the end.

- **Legibility comes from one of three treatments, never a blurred scrim.** Tools expose exactly these controls: stroke
  thickness, drop shadow, and a solid background with padding and corner radius (Captions.ai style panel; OpenClip
  styling guide). The scrim we used (a blurred dark rectangle) reads as a smudge over the picture.
- **Outline.** The heavy-caps look (Hormozi, MrBeast, TikTok auto-captions) is white uppercase in a black-weight
  geometric sans with a thick black stroke. Remotion's own TikTok template draws a 20 px stroke behind a 120 px fill
  (`paint-order: stroke`), so 10 px, about 0.08 em, shows outside each letter. Premiere recipes give stroke 8–15 at size
  80–100 (0.1–0.15 em). Reference screenshots show the outline with round corners and often a short hard drop under it.
- **Shadow.** Business-podcast captions use condensed italic caps in yellow or white with a hard black shadow offset
  down and right, little or no blur (Premiere recipe: opacity 85%, distance 5, low softness). Thumbnail and caption
  guides describe the same "hard shadow": opacity 80–100%, distance 2–4 px at thumbnail scale, blur 0–2 px.
- **Box.** Two families: a box behind the active word only (CapCut and Submagic "highlight" presets; Captions.ai "active
  word background" with its own transition), and a box per line like the platforms' native text labels.
- **Active word.** Colour swap (green #39E508 in Remotion's template, yellow or green in creator presets), a box that
  moves word to word, and a small scale pop. Captions.ai calls the third axis "AI emphasis": underline, colour or
  supersize chosen words.
- **Entries.** Scale pop (OpenClip: 80% → 100%), slide or rise, per-word fade, typewriter, bounce. Rotation and 3D flips
  are discouraged; exits are usually a cut. Remotion's template enters at scale 0.8 and 50 px below.
- **Words per page.** 2–3 words for talking heads is the common default ("the Hormozi-style default"); one word at a
  time for hooks and MrBeast-style pacing; full sentences for calm content. Tools expose words per line and lines per
  page (Captions.ai, Submagic custom templates).
- **Emphasis.** Keep it rare: one key word or phrase, not every second word (OpenClip: at most one emphasised phrase per
  30 s for long pieces; short-form pushes one per page).
- **Fonts commonly used and our open equivalents.** The Bold Font, Montserrat Black, Komika Axis, Bebas Neue, Anton,
  Poppins, Impact. We use OFL faces that also carry Cyrillic: Montserrat Black and Black Italic, Sofia Sans Condensed
  and Extra Condensed Black, Rubik Black (chunky rounded), Inter and Inter Tight, Playfair Display Italic (serif accent),
  JetBrains Mono. Anton, Bebas Neue, Poppins, Archivo Black, Lilita One and Fredoka have no Cyrillic and are not used.
- **Safe zones.** Centre or lower centre of the vertical frame, clear of the bottom caption and button rows and the
  right action column: our `CAPTION_SAFE_ZONE` (vertical: centred 900×1400 core, clear of the bottom 480 px and right
  120 px).

## The presets

All sizes are shares of the frame's shorter side (`size`) or em of the type. Every page fits the safe width and shrinks
to fit; `textScale` multiplies the size.

| Preset | Face, case | Colours | Backing | Active word | Entry | Words a page |
|---|---|---|---|---|---|---|
| `outline-pop` | Montserrat Black, caps | white, active green #5BF06A | outline 0.10 em, hard drop 0.05 em | colour + pop to 1.12 | page pops in, words a frame apart | 3 |
| `italic-shadow` | Sofia Sans Condensed Black Italic, caps | yellow #FFE234 | hard shadow (0.035, 0.07) em; ladder: outline 0.06 em with a 0.07 em drop | pop to 1.08 | each word pops as spoken | 4 |
| `keyword-colour` | Montserrat Black Italic, caps | white, key word yellow and 1.12× | shadow (0.03, 0.06) em, blur 0.06; ladder: outline 0.06 em, drop 0.06 em | — | each word rises as spoken | 4 |
| `word-box` | Montserrat Black, sentence case | white, box violet #7B5CFF | outline 0.06 em | accent box glides word to word (4 frames) | page pops in | 3 |
| `line-box` | Inter Tight ExtraBold, sentence case | #111 on white | box per line, pad 0.3/0.1 em, radius 0.24 em | — | page rises | 5 |
| `chunky-stack` | Rubik Black, caps, one word per line, centred | pale pink #FFD3DF | soft dark-plum shadow 0.05 em, blur 0.16; ladder: plum outline 0.07 em, drop 0.05 em | — | each word bounces in (spring) | 3 |
| `editorial-mix` | Inter Tight + Playfair Italic | white, key word mint 1.9×, serif word yellow 1.25×, connective words 0.62× | soft shadow blur 0.16; ladder: outline 0.06 em | — | each word blurs in | 5 |
| `clean-sentence` | Inter Bold, sentence case | white, upcoming 55% | outline 0.045 em; ladder: 0.07 em | brightens when spoken | page fades | 6 |
| `single-punch` | Sofia Sans Extra Condensed Black, caps, huge, centred | white, key words yellow | outline 0.05 em, drop 0.04 em; ladder: 0.07 em | — | slam from 1.45× | 1 |
| `typewriter` | JetBrains Mono Bold, sentence case | white on black, yellow cursor | box per line that grows with the typing | — | characters type over the spoken word (≤45 ms each) | 4 |

Mechanics worth knowing:

- **Outline** is drawn as SVG text with `stroke-linejoin: round` behind the fill (`paint-order: stroke`); CSS
  `-webkit-text-stroke` mitres corners and spikes on V, W and M at these widths.
- **Animation** is planned by `planCaptionFrame` (`plan.ts`), a pure function of the frame: entries last 4–8 frames at
  30 fps and settle within 12; the active pop overshoots for 6 frames and eases back over 4 when the next word starts;
  `bounce` is a Remotion `spring` (damping 14, stiffness 300, mass 0.5). Words that arrive as spoken keep their place,
  so nothing reflows.
- **Paging** (`buildCaptionPages`): `maxWords` 1–6; 1 is a hard single-word mode; from 3 up a page shorter than
  `minPageSec` may take one extra word, except stacked and mixed pages (`strictWords`). Pages still break at sentence
  ends and speaker changes.
- **Emphasis** (`src/lib/captions/emphasis.ts`): each word scores — marked `emphasis` 100, listed `keywords` 90, a number
  60, an exclamation 45, a content word 10 + its letters, an English or Russian connective word 0. The page's best
  word becomes the key word when it scores 15 or more (a marked or listed word, a number, or a content word of five
  letters or more); ties go to the later word. `emphasis.source: "marked"` uses only marked and listed words. In
  `editorial-mix` the runner-up is the serif word. Timeline captions carry `emphasis` from the transcript edit, so an
  editor can force a key word.
- **Contrast** (`checkCaptionBackground`): every colour a preset draws (`contrastPairs`) is measured against the darkest
  and the brightest 5% of the footage under the caption on a clean still, with the treatment applied: a box by its fill
  (and alpha), an outline of 0.06 em or more by its colour, thinner in part, a hard shadow as 25% cover and a soft one
  as 50%.
- **Legibility ladder** (`fallbacks`, `legibility`): each preset whose treatment can fail carries up to three rungs,
  each changing only the backing or colours (never the page or its geometry). `pnpm captions:place --project <id>`
  renders a clean still of every caption page, picks the mildest rung that passes with `chooseLevel` and writes a
  `caption-style` command whose `options.legibility` lists page ranges in output seconds; apply it with `timeline:edit`,
  so every later render draws the same levels. Shadow presets step to an outline with a hard drop of the same depth:
  the meter cannot credit a heavier shadow (it covers one edge whatever its size), so a shadow rung would never be
  chosen. Pages whose top rung still fails are listed, not passed. Outline presets with 0.06 em or more and box presets
  have no ladder: they hold on any footage by construction. Upcoming-word dimming (`clean-sentence`) is not measured.
- **Minimum size** (`MIN_CAP_HEIGHT`, `checkCaptionSizes`, `captionSizeFindings`): cap height at least 3% of the frame
  height for the words a page is read by (58 px on 1920) and 2% for the small words of a mixed page (38 px), the low
  end of the 3–4.5% measured on the references above. The check runs on the page as laid out, after fitting, and
  reports `TEXT_TOO_SMALL`. In a mixed page a long key word gives up scale (down to 1.3×) before the page shrinks, and a
  run of small words splits over the free lines.

## Placement

### What platforms draw over a vertical video (1080×1920)

No platform publishes an organic-post safe zone; the figures below are the published estimates (third-party
checkers and guides, 2026), and they disagree, so the project takes their union.

| Platform | Top | Bottom (caption, username, music, title) | Right (action buttons) |
|---|---|---|---|
| TikTok | 130–240 px | 320–480 px (in-feed ads 660 px, see vertical ads below; about 67 px more per extra description line) | 120–164 px |
| Instagram Reels | 108–220 px | 310–450 px (220/420 is the common template) | about 120 px |
| YouTube Shorts | 120–288 px | about 270–300 px (some checkers 670 px) | 48–192 px |

### Where captions go

- Short-form tools and guides put burned captions in the **lower-middle of the usable area**: below the face, above
  the platform's bottom band ("lower-middle third", roughly y 1200–1550 on 1920; "avoid the lowest quarter for
  essential text"; "not so high that they cover the subject's eyes"). Centre placement is a style for single words
  and hooks, not the default. CapCut, Submagic and OpusClip all let the editor move captions; none publishes a fixed
  default, and CapCut's own guide calls bottom-centre "only a starting point" and says to move off faces and products.
- Broadcast and streaming (Netflix Timed Text Style Guide; SMPTE ST 2046-1 title-safe area, the central 90%):
  subtitles centred at the bottom, at most two lines, one line when it fits; move them (to the top) to avoid on-screen
  text, and keep them inside title-safe.

### Rules the project applies

- **Vertical**: the caption zone is x 140–940, y 220–1520 (`CAPTION_SAFE_ZONE`), clear of the union of the bands above
  (`PLATFORM_UI_BANDS`: top 220, bottom 400, right 140 px; left 140 for symmetry). A `lower` page's text ends 44 px
  above the zone (y ≈ 1476, 77% of the height): the lowest line that clears every platform's organic band. Before
  this change it ended at y ≈ 1396 (73%) under a 480 px band, which put captions over the chest of a close-up and read
  as too high.
- **Vertical ads** (`captions:place --placement ad [--platform tiktok|reels|shorts]`): paid placements cover more
  (`AD_UI_BANDS`, from each platform's own template: TikTok in-feed top 240, bottom 660, sides 120 and the action
  column x 780–1080 from y 840; Reels ads top 14%, bottom 35%, sides 6%; Google's vertical overlay clear area x 48–888,
  y 288–1248), on top of the organic bands. The caption zone shrinks to `CAPTION_AD_SAFE_ZONE`: TikTok x 300–780,
  y 240–1260 (its action column leaves 480 px at caption height); Reels x 140–940, y 269–1248; Shorts x 192–888,
  y 288–1248; all three (the default) x 300–780, y 288–1248. The zone is recorded in the caption-style options
  (`uiZone`), so the render lays pages out in the box they were measured in and a later run keeps it. TikTok's
  "with Anchor" templates (a product link over the caption) cover more and are not modelled. At 480 px a long word
  (Russian especially) can shrink a page below the 3% cap height: `captions:place` reports it as `TEXT_TOO_SMALL`;
  name the one platform with `--platform` when the ad does not run on TikTok, or lower `maxWords`.
  `footage:next --placement ad|organic [--platform]` records the choice and places the captions again when it changes.
- **Landscape**: bottom-centred in title-safe: x 160–1760, bottom edge 8% from the bottom (y 994 on 1080), clear of
  player controls.
- **Square**: lower third inside title-safe, 10% from each edge (no feed overlay).
- **Per preset**: `single-punch` and `chunky-stack` are designed for the centre (`middle`); the others sit `lower`.
- **Per page, measured** (`pnpm captions:place`): on a clean still of each page, local face detection (YuNet, the
  detector `reframe:track` uses; heads of detected people when no face is found) and an edge-density probe for printed
  text and busy graphics (`detailDensity`, over 0.06 counts as text) score each position: under the platform interface
  1000, covering a face (5% of its area) 100, on text 10, touching the margin round a face 5, one step down the
  preference order 1. The preset's position wins unless something is in the way; the page before is tried first, so a
  shot does not hop. Positions are recorded in the timeline (`options.positions`) next to the legibility levels, so
  renders repeat them; an explicit `position` in the caption-style options always wins and is never moved.
- **Checked**: `checkCaptionPlacement` reports `CAPTION_IN_UI_ZONE` (error, vertical, against the chosen zone's bands) and `CAPTION_OVER_FACE`
  (warning, when no position is free).
- Limits: the text probe is not OCR (a bookshelf scores like print); face detection misses profiles and small faces;
  karaoke, phrase, keyword and bilingual templates keep their own placement.

## Sources

- Remotion, `template-tiktok` `src/CaptionedVideo/Page.tsx` (stroke, highlight colour, entry): https://github.com/remotion-dev/template-tiktok
- Remotion, `createTikTokStyleCaptions`: https://www.remotion.dev/docs/captions/create-tiktok-style-captions
- Submagic, "How to make Alex Hormozi captions": https://www.submagic.co/blog/how-to-make-alex-hormozi-captions
- Vidpros, "How to create Alex Hormozi style video captions": https://vidpros.com/learn-secrets-hormozi-style-video-captions/
- Submagic, "How to make captions like MrBeast": https://www.submagic.co/blog/how-to-make-captions-like-mrbeast
- VideoCaptions.ai, "The MrBeast font": https://www.videocaptions.ai/mrbeast-font
- Captions.ai help, caption styles: https://captions.ai/help/docs/captions/styles
- Submagic help, custom templates: https://care.submagic.co/en/article/how-to-create-custom-template-v6g09s
- OpenClip, caption animation guide: https://openclip.app/guides/caption-animation-guide
- OpenClip, caption styling: https://openclip.app/learn/caption-styling
- Opus Clip blog, caption presets: https://www.opus.pro/blog/best-caption-presets-styles-boost-retention
- The user's three reference images (TikTok, Reels and Shorts posts; a grid of 15 editorial captions; a lifestyle reel), 2026-11-13
- Reap, "YouTube Shorts, Reels and TikTok safe zones: where to put captions, faces and CTAs": https://reap.video/blog/short-form-video-safe-zones
- BlitzCut, "Best caption placement for short-form video": https://blitzcutai.com/blog/best-caption-placement-short-form-video
- Revid, TikTok safe zone checker: https://www.revid.ai/tiktok-safe-zone
- Krumzi, TikTok safe zone checker: https://www.krumzi.com/tools/safe-zone-checker/tiktok
- Upload-Post, TikTok, Reels and Shorts safe zone checker (TikTok in-feed ad file): https://www.upload-post.com/tools/safe-zone-checker/
- Vista Social, Instagram Reels dimensions: https://vistasocial.com/insights/instagram-reels-dimensions
- Revid, YouTube Shorts safe zone checker: https://www.revid.ai/youtube-shorts-safe-zone
- CapCut, "How to add subtitles to vertical video without covering faces": https://www.capcut.com/create/vertical-video-subtitles-placement-tips
- Submagic help, caption position: https://care.submagic.co/en/article/1j14ohm/
- Netflix, Timed Text Style Guide, general requirements: https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements
- ATSC A/343 amendment (IMSC1 and the SMPTE ST 2046-1 title-safe area): https://www.atsc.org/wp-content/uploads/2021/02/A343-2018-Amend-No-1.pdf
