# Reference gap matrix

Why the ten study films in `design-reference/library/inbox/` look expensive, and why `out/library-reel/library-reel-L.mp4` looks like a template. The films are for study only: take the method and never the brand. The breakdowns for palmier, paper-style, polymarket, ref-service-explainer and ugc-app (in `design-reference/library/<id>/`) were translated and condensed here, not redone. Airform, cashfree, context-dev, firecrawl and muse were analysed for this file using 240 px strips, `audio:map`, local whisper.cpp in a scratch library, and ffmpeg scene and silence detection. No reference was listened to: every sound statement below is measured, not heard.

Engine key: **R** = Remotion block, **H** = HTML+GSAP capture, **L** = Lottie, **3D** = Blender/three.js, **AI** = AI-generated video, **SC** = real screen capture, **LF** = live footage.
Library key: **has `id`**, **weak `id`** (exists but wrong look or behaviour), **missing**. "Legacy `X`" means the primitive exists in `src/motion/*.tsx` but is **not** a library block.

## 1. The ten films

### airform (8.7 s, 1920x1080, voiceover)
Dark cinematic sci-fi teaser. It cuts macro footage or CG (an eye, a pen nib on paper, a hand on a keyboard, a light crescent) against tiny centred captions in a neutral grotesque, about 10% of frame width, white on near-black. The captions match the voiceover word for word: about five short lines, two to five words each, arguing that an idea nobody understands is not yet an idea. The palette is teal-black with one ultramarine full frame. HUD annotation (measurement lines, degree readouts) and an ASCII dot ring stand in for "tech". The sound is bass-heavy design with no pulse (163 BPM at confidence 0.35, unusable). Energy surges at 2.18 s and 3.90 s, and integrated loudness is −10.6 LUFS, the loudest of the set. The opening is a flurry of three cuts in 0.47 s; after that the film slows to a single caption held on black.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0.0–0.5 | ASCII dot ring, then a full-frame ultramarine flash with a tiny "It's obvious." | Three cuts in 14 frames on the sound hits. Generative character texture instead of a gradient | R or H (canvas) | missing (no ASCII or dot-matrix block) |
| 0.5–1.1 | Macro eye with HUD callouts tracked over the iris | Real optical detail plus a data layer that knows where the subject is | AI or LF + R overlay | missing (no tracked-annotation block) |
| 1.3–2.4 | Light crescent sweeps a dark sphere (a planet rim) | Physical volumetric light rather than a 2D glow | 3D or AI | weak `light-rays` (static fan) |
| 2.5–3.5 | Pen nib draws lines on paper, shallow depth of field, "Out here." | Tactile macro footage: real focus fall-off, grain and shadow | LF or AI | missing |
| 4.8–5.4 | Hand on keyboard, digits scatter, then a technical drawing with a "172.1°" readout | Blueprint lines drawn on the cut make the idea measurable | R (SVG line draw) | missing |
| 5.6–8.5 | A vertical light line wipes on a five-word caption; black; a four-word answer caption held 1.2 s | Restraint: tiny type, a long hold, nothing else moving | R | weak `type-masked-editorial` (too decorated for a lone caption) |

### cashfree (57.2 s, 1280x720, no voiceover)
An agency case study of a fintech rebrand. The palette runs from lime to forest green, with white. The type is DM Sans (the film names it on screen), a geometric sans in mixed case, with a giant single "a" glyph as a graphic. The material is a deliberate mix: lifestyle photography (hands, tablets, people), 3D renders (a monitor on a green studio sweep, an isometric array of phones, a glossy orb), real website capture, and bento collages of photo, UI and stat chips. Frames are dense, often 4–6 elements. The music runs at 155 BPM on a reliable grid, bass-heavy, with a surge/drop cycle about every 3.1 s (8 beats). Only 29.5% of the 44 detected cuts fall within ±60 ms of a beat, against 31% at random. The cuts follow the music's phrases, not its beats; note that the detector also counts in-shot changes. The film ends in about 1.1 s of silence.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0.0–1.0 | A caret on white types "Wh…", then a cut to an overhead lifestyle photo with the search bar riding on it | The typed query becomes a caption on a real photograph: interface and life in one frame | R + photo | missing (no search-bar block; no photo plate) |
| 2.4–4.0 | A three-word title with a glossy orb set inline as its middle word, on dark green | A 3D object sits inline in the sentence as a word | 3D + R | missing |
| 5.0–7.5 | A monitor rises on a **green** studio sweep showing the site's 3D illustration | Studio lighting in brand colour, not on black | 3D | weak `studio-product-stage` (dark sweep only) |
| 8.0–13.0 | "A Branding / Refresh" chips, "Aa", a "DM Sans" tile, a giant "a" | The brand system shown as sliding bento tiles: the design itself is the content | R | missing (no bento or brand-board block) |
| 15–18 | A bento of photos, UI cards and stat chips ("163+", "99.9%") | Collage density with real photographs and real numbers | R + photos | missing |
| 26–27 | An isometric array of phones, all showing the app | Rendered repetition reads as scale | 3D | missing (`depth-card-flythrough` is cards in fog) |
| 34–35 | A five-word breadth line over a row of icon tiles; one tile grows | A single focal tile out of a system | R | missing |

### context-dev (19.9 s, 1280x720, no voiceover)
White and light grey grounds with cobalt blue as the only accent. A neutral grotesque, grey and black, in mixed case. The signature texture is a 1-bit halftone/dither applied to portraits, which turns stock faces into a brand surface. Product cards sit at very large scale with soft shadows. The whole film is one continuous transformation, with no hard cuts that matter: a crowd of faces, then one face, then a profile card, then many cards, then glyphs, then dots, then a stream between two phrases. The music is 95 BPM on a reliable grid that only starts at 5.7 s. Energy surges at 6.31 s, as the profile fields begin to fill, and the film ends on a drop at 19.6 s. Integrated loudness is −16.3 LUFS, the quietest of the set.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0.5–2.5 | A wall of blue dithered portraits; a search bar types a people-search query over it | A shader gives a coherent house texture to arbitrary imagery | R (WebGL) or H | missing (no dither/halftone) |
| 3.0–4.0 | One tile lifts out and grows; the dither resolves | Continuity from crowd to one person in a single move | R | weak `shared-element-carry` |
| 4.5–9.0 | "Summary" types at hero size; the camera tracks across the profile card as fields fill (LinkedIn, X, email) | Real UI shown so large that each field is the subject; the camera reads it to you | R | missing from library (legacy `RegionCamera` in `src/motion/camera.tsx`) |
| 9.5–11.0 | Pull back to the whole card on white with a soft shadow | The payoff of scale after the detail | R | weak `ui-dashboard-assemble` (push-in only, placeholder UI) |
| 11.5–15.5 | A grid of cards shrinks to a grid of letters, then to dots; the dots break formation | Matter morph: the same marks change state, with no cut | R (canvas) or 3D | weak `particle-assemble` (dark glowing galaxy, the opposite look) |
| 16.0–19.5 | "Describe who you need" and "Get the people", joined by a stream of particles; small product lock-up | One line explains the product, with the particles as connective tissue | R | missing |

### firecrawl (23.0 s, 1280x720 at 60 fps, no voiceover)
White ground with black, mixed-case neutral grotesque (Inter/SF class) and one orange accent, used for numbers and once as a full-frame ground. Brand icons sit inline in the sentence. The real product UI (chat and results table) appears at legible scale, and fast moves carry heavy motion blur. The music is 140 BPM on a reliable grid. The intro is quiet up to 4.05 s, then the music **surges at 4.051 s and the hard cut to orange lands at 4.00 s**, 51 ms ahead of it. The film ends with a hard stop to silence at 22.42 s. The density is one sentence or one UI at a time on a big white frame.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0.5–2.0 | A five-word launch sentence with six logo icons inline builds word by word | Inline logos pop into the line as words; the sentence re-centres | R | weak `type-word-rotate` (no inline icons) |
| 2.5–3.9 | A six-word scale line with two figures, numbers in orange | The accent is meaning (the numbers), not decoration | R | weak `type-marker-highlight` |
| 4.00–7.5 | Hard cut to a full orange frame: "80%" at about 60% of frame width; blurs out at 4.5; "cheaper than Clay", then "at scale" | Ground swap on the musical drop; a hero number with no effects at all | R | weak `type-impact-slam` (adds a flash, shock ring and echoes); `colour-flood` floods instead of cutting |
| 7.5–10.0 | A prompt bar types an eight-word lead-search request | The real product input, typed with human rhythm | R or SC | missing (no prompt-bar block) |
| 10.5–14.5 | The chat answers, the table fills, then scrolls with heavy vertical blur at 13.0–13.6 | Real UI that can be read, and speed that feels physical | SC or H + R blur | weak `ui-chat-thread` + `motion-blur` |
| 16.5–20.5 | A five-word line on the number of sources, then a wall of source chips (Glassdoor, SEC EDGAR, …) pulls out and one is picked | Scale shown as a set of real names | R | weak `network-light-up` |
| 21.5–22.4 | A flat logo on white with corner crop marks; sound stops dead | Quiet confidence: no 3D, no sting | R | weak `scene-end-card` (chrome extrusion) |

### muse (34.8 s, 976x640, no voiceover)
Sky and cloud pastels in light blue, with a rounded friendly sans (SF Pro Rounded class) and blue accent words. A Pixar-grade 3D plush mascot lives in a glass dome on a floating island, with app icons orbiting. The chat UI is frosted and soft. Glossy spheres carry the transitions. The music is 112 BPM on a reliable grid, at constant high energy, with a drop at 29.07 s and a hard stop at 34.33 s. The film relies on camera continuity: pushes through clouds and shape morphs rather than cuts.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0.0–2.0 | A three-line, seven-word product line builds on a cloud sky, accent words in blue | The type lives in a world, not on a void | R over a plate | weak `type-glyph-spring` (ground) |
| 2.2–4.9 | The camera pushes through clouds to a floating island: glass dome, mascot at a desk, orbiting app icons | A designed 3D world with refraction and a character | 3D or AI | missing |
| 8–14 | The mascot avatar, then chat bubbles stack with typing dots; a frosted checklist card | The UI wears the brand's softness | R | weak `ui-chat-thread` (dark, neutral) |
| 15.3–19.4 | A caret, a text field, a six-word request typed while the camera tracks along the field with blur; mic, send | The UI is cropped to hero scale and the camera reads it | R | missing (no prompt-bar block; `ui-cursor-click` is a modal) |
| 19.8–23.4 | The send button becomes a white circle, then the mascot inside it, with "Leave it / to Muse" parting around it; the circle becomes a glossy blue sphere | One shape carries three meanings across three shots | R + 3D sphere | weak `shared-element-carry` |
| 28.6–30.0 | Overhead ocean, the mascot in a floating bubble; a giant blue letter wipes through | A spectacle shot on the music's drop | AI or 3D | missing |
| 31.5–34.3 | "Make life simple", then a blue brush "m" logo draws on | The logo is drawn, not dropped | L or R (SVG stroke) | missing (`extruded-mark` only) |

### palmier (39.1 s, 1280x720, voiceover unknown: no words were recognised)
Live-action handheld footage (a person at a desk, faces) cut against the real editor software. White lowercase centred captions. A dark grade. The idea is self-reference: the tool's output is the film's own opening. There is no tempo grid. Nine cuts between 14.16 s and 21.40 s land 10–60 ms before loudness peaks (a hint, not proof, per the breakdown). The median shot is 1.08 s until a 2.76 s finale that holds 34 cuts.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0–3 | A two-part statement split by a measured silence (1.17–1.75 s) | Silence as punctuation | R + LF | missing (no silence-aware cue) |
| 4.6–5.1 | The camera pushes into a real monitor; reverses at 23.2 | The UI gets a physical place, so you believe it | LF + SC | missing |
| 21.4–23.2 | Recognition: the tool's result is this film's opening | The proof is the film itself | SC | missing |
| 32.9–33.9 | The result grows out of its own preview thumbnail | The UI leaves without a cut | R | weak `shared-element-carry` |
| 33.9–36.6 | A burst of 2-frame cuts on eyes aligned to frame centre; the caption holds still | Abundance at a speed you can't read, with one fixed anchor | R + LF set | missing (no flurry sequencer) |
| 36.6–37.6 | Black; the sound cuts out 0.39 s after the picture; the name alone | A hard stop | R | weak `scene-end-card` |

### paper-style (60.1 s, 1280x720, voiceover throughout)
A history of print told as a single printed sheet. Engraved figures, warm paper (#EEE9DD), ink black, red stamps. The type changes with each era: blackletter, newspaper Didone, condensed slab, then a wide sans with misregistration. Only the small chapter label stays constant. The voiceover is the clock: each slide lands in a gap between phrases, and the first word of the new chapter falls 0.06–0.12 s before the camera stops. In effect the film is one continuous shot.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0–2.1 | A cut-out figure writes by hand; large text drops on "every book" at 2.13 | The film starts inside the world, with no title | R + illustration | weak `paper-fibre` (ground only) |
| 2.13–5.2 | Words do what they mean: letters pasted on, a quill writes, a line typed on a strip | The type's entrance illustrates the sentence | R | weak `type-masked-editorial` |
| 5.66 (×6) | Slide to an **empty** panel (10–11 frames); it stays empty at least 5 frames | The emptiness is a breath, and objects arrive on the voice | R | missing from library (legacy `RegionCamera`) |
| 32.5–33.2 | A thrown newspaper spins and lands | Breaks the rhythm at the midpoint | R | missing |
| 46.8–47.9 | A rising line prints "3D" with colour misregistration | The effect is the subject (layered printing) | R | missing |
| 51.6–54.4 | Pull back to the whole sheet with about 5° tilt | Eight chapters become one object | R | weak `parallax-rig` |

### polymarket (36.1 s, 1920x1080, no voiceover)
Ultramarine (#3356F8), paper white and black grounds swapped on cuts. Heavy condensed grotesque capitals (Druk/Tungsten class) at 56–88% of frame width; money set in an Inter-like semibold, with green for profit. 130 BPM at confidence 0.71. 19 of 21 cuts land on audio peaks (70% at random). Median shot 0.95 s. Every claim is a number growing on screen.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0–2.9 | A logo, single small words on paper, then a hard cut to blue at 2.10: "IS LIVE" with ripples | Empty frame plus one word makes each word an event; the ground change is the first hit | R | weak `type-glyph-spring` |
| 3.43–3.87 | Five bars grow, **hold 6 frames** to read as a chart, then flood the frame in 3 frames | The data becomes the next ground; the hold separates it from a wipe | R | weak `colour-flood` (no chart source, no hold) |
| 12.7–13.2 | The order button lightens, grows and eats the UI; the cut comes *before* it fills | No dead solid-colour frame | R | weak `ui-cursor-click` (iris) |
| 13.2–14.37 | Gauge race $2K to $100K, most of it in the first 6 frames, then 0.5 s of rest | Front-loaded curve plus a stop reads as arrival | R | weak `type-odometer-stat` (even roll); legacy `NumberRace` |
| 16.37–19.37 | Profit runs, then a blurred leaderboard with a pinned "(You)" row carrying the same number | The viewer is made the winner before the prize is named | R | weak `ranked-bars-spring` |
| 27–30.1 | All motion freezes while cuts continue; a seven-word all-caps dare | Stillness as the loudest beat | R | missing (no global freeze control) |

### ref-service-explainer (51.9 s, 1280x720 at 60 fps, no voiceover)
Signal red (#EF4A2D), near-black and white grounds swapped almost every cut. A heavy wide grotesque in capitals at 73–96% of frame width, allowed to overflow. HUD frame corners. 43 cuts, median 0.95 s, one 6.61 s hold. Cuts lock to a 0.345 s pulse, within 9 ms in the fast passage. The film proves it is made of code and ends by rewinding itself.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0–2.93 | One word per pulse, each on a new ground; "CODE." red at 81% width; the letters scramble at 2.40 | Size plus ground swaps on the pulse; the awaited word lands last | R | missing from library (legacy `Slam`, `ScrambleWord`) |
| 17.25–17.96 | A pressed key grows from 13% width to full frame in 19 frames, in the next ground's colour | Caused transition with no colour re-adaptation for the eye | R | weak `colour-flood` |
| 20.73–22.85 | Fly through words: the next word is visible inside the current letters | The eye gets its next target before the old one leaves | R | weak `zoom-through` |
| 24.53–26.60 | The same word in five states at 0.34, 0.35, 0.35, then 0.16–0.09 s intervals | Acceleration by repetition: nothing new to read | R | missing |
| 30.56–30.85 | The camera arrives at a note card; a star bursts | Answer and question in one beat | R | missing |
| 43.15–45.93 | The film rewinds itself to its first word | Proof only video can give | R | missing |

### ugc-app (17.0 s, 1920x1080, no voiceover)
White, then near-black, with a yellow highlight (#FFD60A) and a blue glow at the end. A neutral grotesque; the pages are real web layouts. 128 BPM at confidence 0.46. Four of five major changes land within 0.1 s of a loudness burst (a hint only). The rhythm is speed contrast: a slow type-on, a flurry, a continuous move, a calm read.

| t (s) | What happens | Why it reads expensive | Engine | Library |
|---|---|---|---|---|
| 0–2.1 | A search bar grows on white; the query types slowly | A slow start sets up the break in speed | R | missing (no search-bar block) |
| 2.1–2.9 | Eight pages in 0.8 s (2–4 frames each), the same phrase highlighted yellow at the **same frame point** | The world changes while the eye stays still | R + page captures | missing (no highlight-locked flurry) |
| 2.9–6.9 | A crop on lips opens to a person, then a column, then a wall of 6–16 columns of clips | One person physically becomes a statistic | R + LF clips | missing |
| 6.9–13.1 | A centred phrase over dim footage: each new word yellow, cooling to white in 9 frames; the source types underneath | The picture lives while the reading stays calm | R + LF | weak `type-marker-highlight` |
| 13.1–17 | Huge words drift through frame, in focus only near the centre; a tiny "there was a"; then "better" with a blue glow | Scale and focus as emphasis; the smallest words get the longest wait | R | missing |

## 2. Our reel against the references

Sheets (red border = ours; columns left to right):
- `…/ref-gaps/compare-1-hook-stat.jpg`. Hook row: ours 1.0 s, firecrawl 1.6, ref-service-explainer 2.0, polymarket 2.5. Stat row: ours 16.0, firecrawl 4.2, polymarket 13.8, cashfree 32.0.
- `…/ref-gaps/compare-2-product-ui.jpg`. Product row: ours 4.0, muse 4.0, cashfree 6.5, palmier 4.9. UI row: ours 8.5, firecrawl 12.4, context-dev 9.6, muse 12.7.
- `…/ref-gaps/compare-3-end-transition.jpg`. End row: ours 20.5, muse 33.0, firecrawl 22.2, ref-service-explainer 49.5. Transition row: ours 12.5, polymarket 3.6, ref-service-explainer 17.6, context-dev 14.6.
- All three stacked: `…/ref-gaps/compare-all.jpg`. Strips of every film: `…/ref-gaps/<id>.jpg`, `closeups.jpg`, `reel.jpg`.

What makes ours a template:
1. **It is silent.** `library-reel-L.mp4` has no audio stream. Its `beats` prop is a synthetic grid with no track behind it. Every reference has a mastered bed (−10.6 to −16.3 LUFS) and lands its structural moments on musical events. Without sound, nothing in the edit can feel caused.
2. **The type is small and has no idea behind it.** Inter everywhere, sentence-case headlines at about 25–35% of frame width, because the `keynote-dark` preset hard-codes a title cap height of 6% of the frame. When type is the picture, the references set hero words at 56–96% of width (polymarket, ref-service-explainer, firecrawl's "80%"). When footage or UI is the picture, they set it small. We sit in the middle every time: a kicker/headline/subline stack, which is the most recognisable template layout there is.
3. **One ground for 21 s.** The same vignetted near-black with the same #2997FF accent in every shot. Seven of ten references are mostly light (firecrawl, context-dev, muse, cashfree, polymarket, ugc-app, paper-style), and the rest swap grounds on cuts (ref-service-explainer: black, red, white). For them the ground swap *is* the cut device; for us it never happens.
4. **The material is stock After Effects.** God rays (`light-rays`), a phone on a spotlit pedestal, a chrome extruded logo with a blurred wordmark, odometer digits: the four most common marketplace-template tropes, all in one film. No reference uses chrome, god rays or flares. Their material is a real product, a designed world (muse's dome, cashfree's green sweep), photography, or flat graphic confidence.
5. **The UI is fake and too small.** `ui-dashboard-assemble` is "monochrome placeholders" at about 1.2% text height. It reads as a mock, because it is one. The references show one real screen at reading scale: firecrawl's table, context-dev's card filling the frame, muse's prompt field cropped to hero size.
6. **The motion curves are all the same.** Every element springs in softly, settles and holds. There is no speed contrast, while the references build rhythm from it: ugc's 2–4-frame flurry, palmier's 2-frame burst, ref-service-explainer's accelerating intervals, polymarket's front-loaded race and then rest. Shot lengths: ours are 5 shots averaging about 4.2 s, against a measured median of 0.95–1.08 s.
7. **Dead transition frames.** 12.2–13.9 s is nearly solid blue with low-contrast "Published." text: exactly the dead frame polymarket avoids by cutting before the flood fills. At 14.0 s the light burn leaves a half-white disc. At 1.5 s the hook exits through a frame of blurred mush. The references' transitions are hard cuts or caused morphs that are always legible.
8. **No device.** Each reference has one idea that only video can carry: palmier's self-reference, ref-service-explainer's self-rewind, ugc's highlight lock, context-dev's crowd-to-dots, polymarket's "(You)" row. Ours is a slot sequence (hook, product, demo, stat, end) with meta-copy (a line about the product being lit like a launch). It looks like what it is: a demonstration of blocks.

## 3. Recurring patterns in the references

- **Grounds.** Seven of ten are mostly light. Dark films (airform, palmier, ref-service-explainer) earn the dark with footage or with constant colour swaps. No reference uses a radial-vignette black with a blue accent for its whole length.
- **Type.** Neutral grotesques (Inter/SF class) in firecrawl, context-dev, palmier, ugc-app and airform. Geometric DM Sans in cashfree; rounded sans in muse; heavy condensed capitals in polymarket; heavy wide grotesque in ref-service-explainer; period faces in paper-style. The scale is bimodal: huge (more than 50% of width) when type is the shot, tiny (under 12%) as a caption over picture. Nobody uses a serif-italic accent line, a kicker stack or a letter-spaced uppercase label.
- **Accent as meaning.** A single accent colour marks numbers or the key word (firecrawl orange, context-dev cobalt, ugc yellow, muse blue), and once per film it becomes the whole ground.
- **UI.** Six films show the product's real interface (firecrawl, context-dev, palmier, polymarket, muse, cashfree), always cropped so the shown part is readable, often with the camera moving across it. None uses a generic dashboard.
- **3D** appears in four films (muse, cashfree, polymarket, airform), always as a world or a hero object in brand colour on a light or brand ground. Never as a logo sting.
- **Photography or live footage** in four (palmier, cashfree, ugc-app, airform). AI or 3D world shots in one (muse).
- **Voiceover is the exception.** Only airform and paper-style have voice; seven films returned no words and palmier is unknown. These are feed films made to work muted: the text on screen carries the meaning, and the music carries the energy.
- **Music.** Reliable grids at 95–155 BPM (context-dev 95, muse 112, polymarket 130, firecrawl 140, cashfree 155), bass-heavy electronic, little dynamic range (2–5.4 LU). Sync is structural, not every cut: firecrawl's ground swap 51 ms before the surge; polymarket 19/21 cuts on peaks; ref-service-explainer locked within 9 ms in the fast passage; palmier 10–60 ms early. Cashfree's cuts sit on beats only at chance (29.5% against 31%). **Endings stop dead into silence** (firecrawl 22.42, muse 34.33, cashfree 56.0, palmier).
- **Shot length.** Median about 1 s in cut-based films, with flurries of 2–4 frames (ugc-app, palmier, airform) and single long holds for contrast (ref-service-explainer 6.61 s). Continuous films (context-dev, firecrawl, muse, paper-style) change state inside one camera move instead of cutting. The scene detector undercounts these films on flat grounds: scenes 0.25 found only 2 cuts each in context-dev, firecrawl and muse.
- **Transitions.** Hard cuts and ground swaps dominate. Caused morphs come next (bars flood the frame, a key becomes the ground, a button becomes a circle and then a sphere, a crowd becomes dots), then motion-blurred camera moves. **No light burns, slice panels, flares or light leaks in any of the ten.**

## 4. Ranked gaps (top 15)

| # | Build or acquire | Engine | Effort | Unlocks |
|---|---|---|---|---|
| 1 | Music bed for every film, plus a cue sheet from `audio:map` that snaps ground swaps and hard cuts to surges and downbeats (cut 1–3 frames early), and a hard-stop ending | Licensed or ElevenLabs Music + R | M | firecrawl 4.00, polymarket all, ref-service-explainer 0–2.9 and 24.5, muse 34.3, palmier 36.6 |
| 2 | Rewrite the style presets: drop the 6% cap-height rule; add light-ground presets; give each film 2–3 grounds to swap on cuts; demote kicker/headline/subline | R (styles) | S | every film |
| 3 | Hero-word block: a word at 50–95% width on a hard cut and ground swap with no flash, ring or echo; plus a "word per pulse" sequencer | R | S | firecrawl 4.0–7.5, ref-service-explainer 0–2.9, polymarket 14.4, ugc 13.1 |
| 4 | Sentence build with inline logos or objects and accent-coloured numbers, re-centring as it grows | R | S | firecrawl 0.5–3.9, cashfree 2.4, muse 0–2, ugc 6.9 |
| 5 | Real-UI route: capture real product screens (Playwright/HTML+GSAP or screen recording) and let a camera read across them at 2–3x, with blurred scroll | H or SC + R | M | firecrawl 10.5–14.5, context-dev 4.5–11, muse 15–19, palmier |
| 6 | Prompt/search-bar block: the bar grows, the caret types with human rhythm, send; light and dark | R | S | firecrawl 7.5, ugc 0–2.1, muse 15–19.4, context-dev 0.5, cashfree 0 |
| 7 | Promote the legacy primitives (`RegionCamera`, `NumberRace` with a front-loaded curve and rest, `ScrambleWord`, `Slam`, `GrowToScene`) to library ids | R | S | context-dev 4.5, polymarket 13.2, ref-service-explainer 0–2.9, paper-style slides |
| 8 | Caused morph transitions that never show a dead frame: chart to flood (6-frame hold), button or key to ground, button to circle to sphere; cut before the fill | R | M | polymarket 3.4 and 12.7, ref-service-explainer 17.25, muse 19.8 |
| 9 | Matter morph on a light ground: cards to glyphs to dots to a stream | R (canvas) or 3D | M | context-dev 11.5–17, ugc wall |
| 10 | Dither/halftone/ASCII shader for photos and footage | R (WebGL) | S–M | context-dev 0.5–4, airform 0–0.5 |
| 11 | Speed-ramp editing: 2–4-frame flurries locked on one anchor (highlight, eyes), accelerating repeats, a global freeze | R | M | ugc 2.1–2.9, palmier 33.9, ref-service-explainer 24.5, polymarket 27 |
| 12 | Bento/brand-board collage: photo, UI and stat chips with tile choreography | R + photos | M | cashfree 8–18 and 33–35 |
| 13 | 3D world or hero-object route on light or brand-colour grounds: stylised scenes, a character, products on coloured sweeps; extend `studio-product-stage` beyond dark | 3D (Blender) or AI | L | muse 2.2–6 and 28.6, cashfree 5 and 26, polymarket cheque |
| 14 | Footage layer: licensed or AI plates with caption-on-footage grammar (small centred caption, tracked HUD annotations) | AI or LF + R | L | airform, palmier, ugc 6.9–13, cashfree photos |
| 15 | A restrained end card: a flat logo on the film's ground, or a stroke-drawn logo, ending on a sound hard stop. Take `extruded-mark`, `light-rays` and `flare-pulse` out of the defaults | L or R | S | firecrawl 21.5, muse 31.5, ref-service-explainer 49.5, palmier 36.6 |

## 5. Pilot pick

**firecrawl 0.0–14.5 s.**
- **Coverage.** It holds four of our five beat types in one continuous piece: the hook (a sentence with inline logos), the stat (accent numbers, then the "80%" hero on orange), the UI demo (prompt bar, chat answer, table with blurred scroll) and a measurable sound lock (the ground swap at 4.00 s, 51 ms before the 4.051 s surge, on a reliable 140 BPM grid).
- **No unavailable dependencies.** It needs no footage, no 3D and no AI video, so any gap left in the result is our craft, not missing assets.
- **It tests most of the top gaps directly**: gaps 1, 2, 3, 4, 5 and 6. And it is the cleanest counter-example to our reel: light ground, big type, real UI, no effects.
- **Cost.** Firecrawl is not in the analysed library, so `ref:compare --id firecrawl` needs `ref:add` and `ref:analyze` first. That writes `design-reference/library/firecrawl/`, so it needs the lead's approval.

**Runner-up: ref-service-explainer 17.2–27.0 s.** It is already analysed, so `ref:compare` works today. It is pure Remotion and pulse-locked within 9 ms. It covers transitions and typography but no UI, product or stat beat.
