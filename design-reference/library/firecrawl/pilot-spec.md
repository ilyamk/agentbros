# Firecrawl 0.0–14.5 s: pilot parity spec

Study-only reference. This spec is the benchmark for a pilot film: copy the method, timing and proportions, and never the brand, copy, icons, interface or music.

- **Source:** 1280×720, 60 fps, 22.9 s. **Every frame number here is at 30 fps** (source frame ÷ 2). Strip labels in `visuals/a1/*.jpg` are source frames at 60 fps.
- **Sizes:** `%W` = share of frame width, `%H` = share of frame height. These were measured on 1280×720 and hold for 1920×1080. Cap height was measured on a flat letter ("I"). Block sizes are ink bounding boxes.
- **Colours:** the mode of saturated interior pixels, not a blended median.
- **Stills:** `pilot-stills/pN-Fxxx.jpg`, 480 px wide, frame xxx at 30 fps. They are frames of the film, so they stay local and git-ignored; make one from the media with `ffmpeg -ss <xxx/30> -i media/source.mp4 -frames:v 1 -vf scale=480:-2 pilot-stills/pN-Fxxx.jpg`.
- **Claims:** "measured" means computed from pixels or audio, "observed" means seen frame by frame in a strip, and "inferred" means a guess. I cannot hear, so every audio statement is a measurement.

## 1. The music grid (lock everything to this)

| Quantity | Value |
|---|---|
| Tempo | 140.0 BPM (audiomap 139.98, grid reliable, confidence 0.72) |
| Beat | 0.428571 s = **12.857 frames** (not an integer: use the frame table below, never "every 13 frames") |
| Eighth / sixteenth | 6.43 / 3.21 frames |
| Bar (4 beats) | 51.43 frames |
| Anchor (drop, beat 0) | **4.000 s = F120** |
| Section | quiet intro 0–4.0 s (energy 0.08–0.13); full, bass-heavy groove from 4.0 s |

**Why the anchor is 4.000 s.** The six intro hits are full-band swells at least 1.35× the local median. They fall at 0.140, 0.893, 1.532, 1.856, 2.499 and 3.572 s. Those times are exactly 36, 29, 23, 20, 14 and 4 sixteenths before 4.000 s, each within 5 ms. The detectors put the drop's onset at 4.006 s (full band), 4.021 s (low band) and 4.051 s (the audiomap "surge"). Those are envelope lags. The audiomap's own beat list (3.828, 4.255, …) sits on the off-beats, 0.19 s early, so **do not use `audiomap.beatsSec` for this film**. `audio.json`'s 93.27 BPM is a 2:3 artefact.

**Two timelines (note, 2026-11-11).** `firecrawl.mp4`'s AAC track has no edit list, so ffmpeg and players present the encoder priming (2112 samples at 48 kHz = 44 ms) as sound. On that presented timeline, which every repo tool and every viewer hears, each hit is 44 ms later than this spec states: intro hits 0.184 and 3.616 s, the drop and beat 0 at **4.044 s** (drum-stem grid: 4.045). The times here are the encoder's timeline (4.000 s); `pnpm audio:map --stems --aac-priming-correct` reproduces it (beat 0 at 4.001). So the reference's cut at F120 (4.000 s picture) leads the presented drop by about 1.3 frames, which matches our rule that a cut lands one frame before its beat. Keep the frame table below for picture; for sound sync, use the presented times.

Beat frames (beat k = 120 + 12.857·k, rounded):

| k | −8 | −4 | −1 | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 12 | 14 | 16 | 20 | 21 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| frame | 17 | 69 | 107 | 120 | 133 | 146 | 159 | 171 | 184 | 197 | 210 | 223 | 274 | 300 | 326 | 377 | 390 | 429 |
| s | 0.57 | 2.29 | 3.57 | 4.00 | 4.43 | 4.86 | 5.29 | 5.71 | 6.14 | 6.57 | 7.00 | 7.43 | 9.14 | 10.00 | 10.86 | 12.57 | 13.00 | 14.29 |

Downbeats are k = 0, 4, 8, 12, 16, 20, 24. Intro hits (sixteenths before the drop): F4 (−36), F27 (−29), F46 (−23), **F56 (−20)**, F75 (−14), **F107 (−4 = beat −1)**.

**Sync result.** All six structural changes land within 24 ms of a beat on this grid:

| Change | Frame | Time | Grid | Error |
|---|---|---|---|---|
| Cut | F69 | 2.300 s | beat −4 | +14 ms |
| Cut | F120 | 4.000 s | beat 0 | 0 |
| Text swap | F159 | 5.300 s | beat 3 | +14 ms |
| Text swap | F185 | 6.167 s | beat 5 | +24 ms |
| Cut | F223 | 7.433 s | beat 8 | +4 ms |
| Cut | source frame 601 | 10.017 s | beat 14 | +17 ms |

The motion starts are locked too: the hero-number shrink starts at beat 1 and the scroll at beat 21, and the scroll lands on beat 24. Word reveals inside a sentence are **not** on the grid: they come every 4 frames (0.133 s). Chance of a ±30 ms hit is 14% per change, so this is deliberate.

## 2. Global look

| Role | Value |
|---|---|
| Ground A (sentence 1, prompt bar) | `#FFFFFF` |
| Ground B (sentence 2) | `#FCFEFB` (a barely green white; the change at F69 is a real cut) |
| Ground C (drop) | `#E94D1C`, sampled modes #E84C1C to #EA4C1C |
| Ground D (chat) | `#F6F9F6` page, `#FCFEFB` window card |
| Ink on white | `#262626` (modes #242424 to #282828; not pure black) |
| Accent numbers on white | `#EA4C1C`, the same orange as ground C |
| Type on orange | `#FAFAF6` (warm off-white) |
| Subline on orange | off-white at about 55% opacity, which reads as `#F2B082` |
| UI send button | `#3066EE`. Cursor arrow `#FA5C16`. User bubble `#E6ECF8`. UI body text dark grey and light grey, about #6B6E6B |

**Typeface.** A neutral grotesque with tight tracking and medium weight (SF Pro Display or Suisse class; inferred). The closest free equivalent is **Inter Display Medium (500)** at −2.5% letter-spacing, with the hero numbers in **Inter Display SemiBold (600)** at −4%. Geist is the second choice. Mixed case everywhere; no all-caps, no serif, no kicker.

There are no effects anywhere: no glow, shadow on type, grain, gradient, flash or ring. Motion blur appears only when something moves fast.

## 3. Shot by shot

### P1: Sentence one, F0–F68 (0.000–2.267 s); hard cut out at F69

Stills (local): `pilot-stills/p1-F017.jpg`, `p1-F040.jpg`, `p1-F066.jpg`. Strips: `visuals/a1/hook-words.jpg`, `visuals/a1/exit-cut-2.30.jpg`.

- **F0–F3:** empty `#FFFFFF`.
- **Layout.** Two lines laid out in their final positions from the start, and nothing reflows.
  - Line 1, left-aligned at x = 11.5%W, settled ink band y 37.4–48.9%H: "word word Name".
  - Line 2 starts at 15.3%W, ends at 84.6%W, band y 53.2–64.9%H: "for [6 inline icons] word".
  - Block width 76.3%W (11.6–87.9%W): visually centred, but anchored left.
- **Type.**
  - Cap height **9.2%H** (I = 66 px at 720), so the font size is about **12.6%H = 7.1%W** (Inter cap height 0.727 em).
  - Line pitch 15.8%H (line-height about 1.25). Ink `#262626`.
- **Word reveals.**
  - Hard on, one frame, no fade: F4, F8, F12, F17, then the icons F21–F30, and the last word at F31.
  - So the cadence is every 4 frames, slowing to 5 frames for line 2.
  - The first reveal (F4) coincides with the first hit (0.140 s).
- **Icons.**
  - Six brand-style roundels at about cap height, 1.6% to 2.0%W apart.
  - Each fades from 0 and scales from about 80% to 100% over about 3 frames, staggered by about 2 frames (F21–F30).
- **Block entry.**
  - The whole block rises from y 46.7% to 38.8% (top edge) between F4 and F12, 8 frames with a strong ease-out (cubic-out). It reaches 38.2% at F16.
  - From there it creeps up another 0.7%H until F56: a slow linear drift so the frame is never dead.
- **Exit.**
  - F57–F68, 12 frames ≈ one beat. It starts on intro hit F56 (−20 sixteenths).
  - Ease-in (quad-in) upward travel: top edge 37.4% → 30.4%H, a 7%H displacement, with per-frame speed rising 0.3 → 1.1%H.
  - No fade. Hard cut at **F69 = beat −4 (2.286 s, +14 ms)**.

### P2: Sentence two (stat), F69–F119 (2.300–3.967 s); hard cut to orange at F120

Stills: `p2-F073.jpg`, `p2-F100.jpg`, `p2-F117.jpg`. Strips: `visuals/a1/stat-words.jpg`, `visuals/a1/drop-cut-4.00.jpg`.

- **F69:** blank `#FCFEFB` (one frame).
- **Layout.** Two lines, the same grid as P1: left edge 11.2%W, block 11.4–88.5%W (77.1%W), settled y 36.9–64.4%H. The type size is the same as P1.
  - Line 1: "Verb NUMBER+ noun".
  - Line 2: "and NUMBER+ noun".
- **Accent.** The numbers are `#EA4C1C`. Everything else is `#262626`.
- **Word reveals:** F70, F73 (number), F78, F82, F85 (number), F89. These are 3–5 frame gaps.
- **Entry:** the same as P1. The block rises from y 45.6% to 38.3%H over F70–F77 with ease-out, then creeps up 0.4%H until F107.
- **Exit.**
  - F108–F119: 12 frames, starting on hit F107 (beat −1, the snare at 3.572 s).
  - Ease-in rise: top edge 36.7 → 28.9%H (7.8%H). Per-frame difference 0.6 → 13.1 (`measure.txt`), clearly accelerating.
  - Hard cut at **F120 = beat 0, the drop**.

### P3: Hero number on orange, F120–F158 (4.000–5.267 s)

Stills: `p3-F121.jpg`, `p3-F136.jpg`, `p3-F152.jpg`. Strips: `visuals/a1/drop-cut-4.00.jpg`, `visuals/a1/hero-shrink.jpg`.

- **F120.** The ground cuts to `#E94D1C` on the same frame as the drop. The number "NN%" is in `#FAFAF6`, semibold, centred.
  - Ink block 89.5%W (5.4–94.8%W). Figure height **54.6%H** (digits only), so the font size is about 75%H.
  - It enters already at full size: no scale-in.
- **F120–F132: carry-over drift.** The block keeps moving up: top edge 31.1 → 23.6%H (7.5%H) with an ease-out over 12 frames. It continues the direction and speed of P2's exit across the cut.
- **F133–F140: shrink on beat 1** (4.433 s, beat 1 at 4.429 s).
  - Width 89.5 → 43.8%W in 8 frames: 89.5, 85.5, 79.3, 71.4, 61.4, 54.0, 49.1, 46.0, 43.8.
  - That is an ease-in-out with its fastest frame at F135–F136 (−10%W per frame).
  - **Heavy motion blur** while it moves (radial or zoom blur, about 2–3% of the glyph size at peak; observed F266–F275 at 60 fps).
- **F141–F152: settle.** Ease-out tail to **34.8%W, figure height 21.4%H** (y 39.4–60.7%H).
- **F153–F158: re-grow.** 34.8 → 42.9%W over 6 frames (half a beat) with ease-in. Pressure into the swap.
- **Swap at F159 = beat 3.**

### P4: Comparison line on orange, F159–F184 (5.300–6.133 s)

Stills: `p4-F161.jpg`, `p4-F180.jpg`. Strip: `visuals/a1/swap-5.30.jpg`.

- **F159:** hard text swap; the ground is unchanged. One line "word word Name", medium weight, `#FAFAF6`, centred.
- **Push-in.** It enters at 67.3%W (y 44.4–57.9%H) and eases out to 80.9%W by about F182. Widths: 67.3, 69.5, 71.2, 72.7, 74.0, 75.1, 76.0 (F165), 78.0 (F168), 79.5 (F172), 80.5 (F178). This is an exponential ease-out, about 85% complete in 10 frames.
- **Type.** Cap height **10.3%H** (C with overshoot 10.6%H), so the font size is about 14%H = 7.9%W.
- **Swap at F185 = beat 5** (+24 ms).

### P5: Qualifier and subline on orange, F185–F222 (6.167–7.400 s)

Stills: `p5-F187.jpg`, `p5-F205.jpg`, `p5-F220.jpg`. Strips: `visuals/a1/swap-6.17.jpg`, `visuals/a1/exit-cut-7.43.jpg`.

- **F185:** a two-word line in `#FAFAF6`, bolder visual weight (semibold). It is shorter and bigger than P4.
- **Push-in.** It enters at 47.9%W and eases out to 60.5%W by F199 (14 frames). Widths: 47.9, 50.6, 52.7, 54.5, 55.8, 56.9, 57.8, 58.4, 59.1, 59.5, 59.8, 60.0, 60.3.
- **Type.** Ascender height 24.2%H, so the cap height is about 23.5%H and the font size about 32%H.
- **Subline.**
  - Appears at F189, 4 frames later: "per noun noun", off-white at about 55% opacity.
  - Ink band 63.3–71.9%H, width 40.5%W (29.7–70.2%W). Font size about 6.5%H.
  - It rides the same scale as the main line.
- **Hold:** F199–F212, almost still (0.1–0.4 difference per frame).
- **Exit.**
  - F213–F222, 10 frames. Width 59.4 → 77.5%W, ease-in (exponential): 59.5, 59.7, 60.0, 60.3, 60.8, 61.3, 62.2, 63.4, 65.7, 71.1, 77.5.
  - Motion blur on the last 3 frames.
- **Hard cut at F223 = beat 8**, the second downbeat after the drop (7.429 s, +4 ms). The orange lasts exactly two bars.

### P6: Prompt bar on white, F223–F300 (7.433–10.000 s); hard cut at source frame 601 (10.017 s)

Stills: `p6-F225.jpg`, `p6-F262.jpg`, `p6-F295.jpg`. Strips: `visuals/a1/exit-cut-7.43.jpg`, `visuals/a1/bar-entry.jpg`, `visuals/a1/send-cut-10.03.jpg`.

- **Ground and bar.**
  - Ground `#FFFFFF`. A single pill-shaped prompt bar, centred horizontally.
  - Bar 69.3%W (15.3–84.6%W), about 7%H tall plus a soft shadow (9%H with shadow).
  - Light grey border, white fill.
- **Contents.**
  - Left to right: "+", placeholder text, a model picker in grey, a mic glyph, and a round blue send button `#3066EE`.
  - Text ink band 3.75%H, so the cap height is about 1.9%H. Inter Regular 400, about 2.6%H font size.
  - This is the only small type in the pilot. Scale contrast against P5 is about 12×.
- **Entry.** The bar rises from y 66.8% to 45.4%H (top edge) over F223–F244, 21 frames with ease-out. It is already near rest by F236.
- **Typing.**
  - A text caret blinks in the placeholder. The placeholder is replaced by the typed request starting about F245.
  - About 47 characters by F288, roughly 1.1 characters per frame. The rhythm is uneven, like human typing (inferred from the sampled frames).
- **Cursor.**
  - An orange arrow `#FA5C16` enters from below at F262 (y 75%H). It travels to the send button by about F282 with ease-out, and clicks at about F290.
  - It is visible over the button as it fills.
- **Freeze.** F290–F300 (about 0.35 s): frame difference exactly 0.
- **Cut** at source frame 601 = **10.017 s = beat 14** (+17 ms). It lands on the first 30 fps frame after it, F301.

### P7: Chat answer and table, F301–F435 (10.033–14.500 s) and beyond

Stills: `p7-F305.jpg`, `p7-F340.jpg`, `p7-F375.jpg`, `p7-F385.jpg`, `p7-F410.jpg`, `p7-F435.jpg`. Strips: `visuals/a1/send-cut-10.03.jpg`, `visuals/a1/chat-answer.jpg`, `visuals/a1/table-fill.jpg`, `visuals/a1/pan-12.4.jpg`, `visuals/a1/scroll-blur.jpg`, `visuals/a1/scroll-settle.jpg`.

- **Window and entry.**
  - Page `#F6F9F6`. A desktop chat window: card `#FCFEFB`, with traffic-light dots, a "Chat | Work" segmented control and a faint shadow.
  - It spans 7.3–90.9%W (83.6%W) from top 10%H and bleeds off the bottom.
  - It rises from top 20.7% to 10.1%H over F301–F318 (ease-out, about 17 frames). The user's message bubble `#E6ECF8` is right-aligned at top, and a blue "thinking" dot sits at left.
- **Answer.**
  - F312: a grey "Thinking" label and one status line.
  - F326–F340: "Worked for Ns" and a bold one-sentence summary with an inline brand mark and link.
  - The text streams in by lines: a fade in about 4 frames, with a light shimmer on the status line.
  - UI text cap height is about 1.5%H (Inter 400/600), the real interface at 1:1.
- **Table.**
  - F345–F375: header row of four contact-field column labels, then rows added downward, about one row per 4–5 frames.
  - The email column is link blue.
- **Camera.**
  - F369–F390, beats 19.6–21: the window drifts up and slightly right and grows (the ground changes to `#FCFEFB` at F376 as the window fills the frame).
  - The speed rises frame by frame; per-frame difference 1.9 → 8.8 over source frames 738–779.
- **Scroll.**
  - F390–F430, **beat 21 to beat 24 = 13.0–14.29 s**.
  - A fast vertical scroll through about 25 rows with heavy vertical motion blur: rows smear into grey bars, and blur length reaches about 15%H at peak.
  - Ease-in-out, fastest around F405–F420.
- **Landing.** The last rows land sharp at about F430–F432 on **downbeat 24 (14.286 s)**. By F435 they show seven readable rows, a "count of results" line and the prompt bar at the bottom.
- **After the pilot** (not part of the benchmark): the table holds until about 15.9 s, then a dissolve.

## 4. Sync points to hit (checklist)

| Frame | Event | Locks to |
|---|---|---|
| F4 | first word | first intro hit, 0.140 s |
| F56–F57 | sentence 1 exit starts | intro hit −20 sixteenths, 1.856 s |
| F69 | cut to sentence 2 | beat −4 |
| F107–F108 | sentence 2 exit starts | snare, beat −1 (3.572 s) |
| **F120** | **cut to orange, hero number** | **drop, beat 0**; music goes from energy 0.13 to 1.0 |
| F133 | hero shrink starts | beat 1 |
| F153 | re-grow starts | half a beat before beat 3 |
| F159 | text swap | beat 3 |
| F185 | text swap | beat 5 |
| F213 | exit grow starts | 10 frames before beat 8 |
| **F223** | **cut to white prompt bar** | **beat 8 (downbeat, bar 3)** |
| F290 | click, then freeze | about 1 beat before beat 14 |
| **F301 (10.017 s)** | **cut to chat** | **beat 14** |
| F390 | scroll starts | beat 21 |
| **F429–F431** | **scroll lands** | **downbeat 24** |

## 5. Motion rules to copy

1. **Accelerate into every exit, decelerate out of every entry.** Exits are one beat of ease-in travel (7–8%H) or growth (+30% scale), ending on a hard cut on the beat. Entries carry the same direction across the cut and ease out over 8–14 frames.
2. **No fades between states before 14.5 s.** Every change is a hard cut or a hard text swap.
3. **Scale is the hierarchy.**
   - Body sentences use a 12.6%H font.
   - The hero number enters at a 75%H font and settles at a 29%H font.
   - The second-line qualifier is about 32%H.
   - UI text is under 3%H.
   - Nothing in between.
4. **Motion blur only when speed is real**: the hero shrink, the exit grow, the scroll.
5. **Freeze before cause and effect:** about 10 frames of absolute stillness after the click.

## 6. Build notes (routes)

| Shot | Route and blocks | Gap |
|---|---|---|
| P1–P2 | Remotion. `SentenceBuild` (`type-sentence-build`) is the starting point | It must lay the block out before the reveal (left-anchored), reveal words on single frames, apply a block-level rise with ease-out, an accent colour per token, inline icons and a one-beat ease-in exit |
| P3–P5 | Remotion. `HeroWord` and `GroundSwap`, plus `MotionBlur` for the shrink and the exit | Needs a scale keyframe track (shrink, settle, re-grow) and carry-over drift across the cut |
| P6 | Remotion | `missing:prompt-bar`: pill bar with typed text, caret and send; `CursorClick` for the arrow |
| P7 | Hyperframes or HTML capture of a real interface, plus a Remotion camera; or `ChatThread` restyled light | `missing:ui-camera-scroll`: a camera over a tall real UI with velocity-scaled vertical blur |

Music must be a different track at 140 BPM with a quiet, sparse intro of exactly 9⅓ beats (4.0 s) before a full drop. Alternatively, retime everything to the new track's drop and beat period: all frames above are beat-relative.
