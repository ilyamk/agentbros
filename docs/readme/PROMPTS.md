# README visuals: prompts

Last updated: 2026-11-17

Every image on the README landing page, with the prompt that made it. Generated with the Codex built-in `image_gen` tool (Codex CLI, model `gpt-6.1-sol`), one call per asset. Originals land in `docs/readme/src/` (git-ignored); the files the README uses are resized and compressed copies in `docs/readme/` (tracked: [assets](../assets.md), row (c)). To remake one, rerun its prompt with the style bible and the avoid list, then repeat the post-processing step.

These are illustrations of each genre, not frames of films made with the repository. Glow-ups and premieres stay empty until real renders exist.

## Style bible (prefix for every prompt)

> **Agent Bros. Pictures.** A source-available film studio run by two AI agent brothers. Visual language: the glamour of a 1930s golden-age Hollywood studio (art deco geometry, marquee bulbs, searchlights, velvet, brass, film grain, anamorphic flares) colliding with the modern AI terminal (a blinking `>_` prompt caret, a mouse cursor, monospace type, timeline tracks, waveforms). Palette: ink black #0B0B0F, marquee gold #F5C518, warm tungsten amber, electric cyan #22D3EE for anything made by an agent, signal red #EF4444 for REC dots and cuts. Rich, saturated, high contrast, cinematic lighting, crisp detail, premium editorial finish, every frame composed like a movie still.
>
> **The brothers** (recurring mascots, identical in every image they appear in; match `src/brothers-reference.png`): two small, friendly retro-futuristic robots built like vintage film equipment. **Big brother "Claude"**: rounded warm terracotta (#D97757) body like a 1930s cine camera, a single round lens eye that glows soft amber, a black director's beret, a gold megaphone. **Little brother "Codex"**: slimmer teal-green (#10A37F) body like an old editing console, a rectangular CRT face showing a cyan `>_` caret as its eyes, chunky studio headphones, a strip of film over one shoulder like a scarf. Charming, Pixar-level appeal, never creepy.

## Avoid list (append to every prompt)

> No real company logos, trademarks or product names; no Warner Bros. shield, its typeface or "WB" monogram; no real people's faces or celebrity likeness; no watermark or signature; no gibberish text: spell exactly the words given in quotes and nothing else; no extra limbs or melted hands; no cluttered borders.

## Post-processing

| Kind | Generate at | Ship as | Display |
|---|---|---|---|
| Logo, banners, icons (transparent) | 1536×1024 or 1024×1024, transparent background | PNG with alpha, trimmed to the alpha box plus 12 px, long side 1200 px (logos 880, icons 256), quantised to 256 colours with dithering | `<img width>` |
| Cards, hero, story, social preview (opaque) | 1536×1024 (posters 1024×1536) | centre-cropped JPEG quality 82: cards and story 1200×800, hero 1600×900, posters 600×900, social preview 1280×640 | `<img width="100%">` |

## A. Brand

### 0. `src/brothers-reference.png` — character sheet (reference only, not shipped)
1536×1024, light grey seamless studio background. A turnaround character sheet of the two brothers exactly as described in the style bible: each brother shown front, three-quarter and side, standing side by side at the same scale; Claude the taller one (about 1.3× Codex). Clean even lighting, no text except two small labels under them: "CLAUDE" and "CODEX".

### 1. `logo-dark.png` — logo for dark theme
1536×1024, **transparent background**. An original art-deco film-studio emblem: a circular gold medallion with sunburst rays and two crossed searchlight beams behind it; in the centre a clapperboard whose striped clapstick is the hinged top, and on the slate, in cyan monospace, a `>_` caret. Below the medallion a bold condensed wordmark in warm gold with a thin cream inline: "AGENT BROS." and under it, smaller, widely tracked: "PICTURES". Ink and lines are light (gold, cream, cyan) so it reads on a near-black page. Flat-ish vector-like rendering with subtle metallic sheen, crisp edges, no drop shadow onto the background. Not a shield shape.

### 2. `logo-light.png` — logo for light theme
Identical design and layout to `logo-dark.png` (use it as the reference), **transparent background**, but recoloured for a white page: deep ink #0B0B0F lines and lettering, a deep gold #B8860B medallion, the `>_` caret in a darker cyan #0891B2.

### 3. `hero.jpg` — hero banner (ship 1600×900, crop 16:9 from centre)
1536×1024. Night exterior of a grand 1930s Hollywood studio gate, rain-slick street reflecting light; above the gate a huge glowing marquee with bulbs that reads "AGENT BROS. PICTURES" and on its changeable-letter board below: "NOW SHOWING: YOUR IDEA". Searchlights sweep the sky. Under the marquee the two brothers stand like stars at a premiere: Claude holding the gold megaphone up, Codex with a film reel under his arm. Through the open gate, instead of a backlot, a vast glowing terminal window floats in the night with a cyan `>_` caret and timeline tracks streaming out of it like film strips. Wide cinematic composition with breathing room at the top and bottom for cropping, anamorphic lens flares, rich gold and cyan against ink black, film grain.

### 4. `social-preview.jpg` — GitHub social preview (ship 1280×640)
1536×1024, compose for a 2:1 crop (keep everything important in the middle band). Left half: the gold logo medallion and the wordmark "AGENT BROS. PICTURES"; under it in clean cream sans-serif: "Source-available video studio for Claude Code & Codex". Right half: the two brothers on a director's chair and an editing console, a red REC dot glowing. Background: deep ink black with a soft golden searchlight cone and a faint film-strip border along the bottom.

## B. Section banners (transparent, ship trimmed, long side 1200 px, displayed at 720 px)

Each is a wide horizontal title piece; compose it inside the middle third of a 1536×1024 canvas so it can be trimmed to a 3:1 band. Transparent background, no backdrop rectangle.

### 5. `banner-studio.png`
A miniature art-deco studio gatehouse lit in gold, with an arched sign in bulb letters "THE STUDIO". Codex peeks out of the gate window waving; a tiny cyan `>_` neon sign hangs by the door.

### 6. `banner-now-showing.png`
A classic theatre marquee seen straight on: a row of chasing bulbs around a black letter board with red plastic letters reading "NOW SHOWING", two little gold ticket stubs and a popcorn box with cyan-striped bag at the ends. Bright, celebratory, crisp.

### 7. `banner-premieres.png`
A strip of red carpet running left to right with brass stanchions and velvet rope, camera flashes bursting, golden script lettering above it: "PREMIERES". Claude, in his beret, poses on the carpet holding a small gold trophy shaped like a play-button triangle.

### 8. `banner-crew.png`
A row of empty canvas director's chairs, their backs printed with "YOU", "YOUR AGENT", "CLAUDE", "CODEX"; a hand-painted sign on a light stand: "JOIN THE CREW". Warm tungsten light, a coil of cable and a clapperboard on the floor.

### 9. `banner-credits.png`
Elegant old-Hollywood end title lettering in cream and gold: "THE END" in large art-deco serif, with smaller "…or just the beginning" in italic script below; a thin film-strip flourish on each side; the tiny brothers silhouetted walking off into a golden spotlight, holding hands.

## C. Department icons (transparent, 1024×1024, ship 256 px, displayed at 88 px)

One consistent set: chunky 3D clay-and-enamel icons, soft studio lighting from the top left, gentle long shadow inside the object only, gold and cream base with one accent colour each, centred with generous padding, a slightly isometric three-quarter view. Each icon includes a tiny cyan `>_` detail somewhere on it. No text.

10. `icon-writers.png` — a vintage typewriter with a script page curling out, a gold fountain pen across it; accent coral.
11. `icon-art.png` — an artist's palette whose paint blobs are little motion curves and keyframe diamonds, a brush resting on it; accent magenta.
12. `icon-camera.png` — a 1930s cine camera with two film reels on top, a small 3D wireframe cube floating by the lens; accent terracotta.
13. `icon-generation.png` — a crystal ball on a brass stand with a tiny glowing film frame forming inside it, sparkles around; accent violet.
14. `icon-sound.png` — a vintage ribbon microphone with a sound wave and two music notes; accent amber.
15. `icon-editing.png` — a pair of gold editing scissors cutting a film strip, one frame flying off; accent red.
16. `icon-reference.png` — a magnifying glass over a film strip, the lens revealing a measured grid and motion curve; accent cyan.
17. `icon-critics.png` — a director's monocle and a red "TAKE 2" stamp on a clipboard with stars; accent gold.

## D. Genre cards (opaque, 1536×1024, ship 1200×800 JPEG)

Shared card rules: each card looks like a still from a finished, high-end video in that genre, framed as a 3:2 picture. Top-left, a small dark rounded chip with cream text: the number and genre given in quotes (for example "01 · PRODUCT PROMO"). One clear hero subject, strong colour story, cinematic light, sharp detail, readable at 400 px wide. Invented brand names only (use exactly the ones given). Where a brother appears, he is a small cameo, not the subject.

18. `card-product-promo.jpg` — chip "01 · PRODUCT PROMO". A sleek invented smartphone app "Lumen" floats in a dark studio, its screen glowing with a clean dashboard; light ribbons whip around it; a huge bold headline behind in gold: "Shipped.". Dramatic rim light, reflective black floor.
19. `card-teaser-trailer.jpg` — chip "02 · TEASER". Near-black frame, a single silhouetted object under a sheet with a sliver of cyan light escaping; condensed white type: "COMING 08.12". Heavy grain, anamorphic flare, suspense.
20. `card-app-store-preview.jpg` — chip "03 · APP STORE PREVIEW". Three tall phone screens side by side on a gradient of teal to violet, showing an invented habit-tracker app "Streak" with big rings and a tap ripple; small caption chips above each phone: "Track", "Build", "Celebrate".
21. `card-feature-update.jpg` — chip "04 · FEATURE UPDATE". A web app settings screen split diagonally by a glowing wipe: left half dull grey "before", right half vivid "after" with a new toggle highlighted by a gold "NEW" pill and a cursor clicking it.
22. `card-ugc-ad.jpg` — chip "05 · UGC AD". A vertical-video feel inside the 3:2 frame: a cheerful creator (non-identifiable, stylised, three-quarter view) in a sunny kitchen holding an invented water bottle "Glacier"; bold white caption with a yellow keyword: "this kept ice for 24 HOURS".
23. `card-case-study.jpg` — chip "06 · CASE STUDY". Interview setup: a person seen from behind in soft focus, a warm practical lamp, a lower third "Maya Chen · Head of Ops"; a large animated number overlay "+38%" in gold with a small upward chart line.
24. `card-explainer.jpg` — chip "07 · EXPLAINER". A chalk-on-blackboard style diagram coming to life in colour: compound interest as a growing staircase of coins turning into a glowing curve, labelled "year 1", "year 10", "year 30".
25. `card-product-tutorial.jpg` — chip "08 · TUTORIAL". A clean desktop web app, the cursor gliding with a soft motion trail, a pulsing cyan ring on the button being clicked, a step counter chip "2 / 5" and a tooltip "Connect your calendar".
26. `card-avatar-presenter.jpg` — chip "09 · AI PRESENTER". A friendly stylised digital host (clearly illustrated, not photoreal) beside a floating slide; a small label in the corner "AI-generated"; soft blue studio backdrop.
27. `card-localise.jpg` — chip "10 · LOCALISE". The same frame of a travel video stacked three times like cards fanned out, each with subtitles in a different language: "Hello, world" / "Hola, mundo" / "こんにちは、世界".
28. `card-motion-design.jpg` — chip "11 · MOTION DESIGN". Pure kinetic typography: the word "MOTION" exploding into geometric shards that reassemble into a logo ident, orange and magenta on deep purple, motion blur streaks.
29. `card-ai-film.jpg` — chip "12 · AI FILM". A breathtaking cinematic shot: a lone lighthouse keeper's tiny figure on a cliff under an aurora and a giant moon, letterbox bars, a small slate in the corner "SHOT 04 / 12".
30. `card-photo-slideshow.jpg` — chip "13 · PHOTO SLIDESHOW". Holiday photos as glossy prints scattered and flying in a warm sunset light, one in the centre slowly zooming (Ken Burns), a soft music waveform along the bottom.
31. `card-stock-montage.jpg` — chip "14 · STOCK MONTAGE". A bold manifesto frame: city b-roll at blue hour behind huge condensed white type, one word per cut: "BUILD.", with a red cut marker on a thin timeline at the bottom.
32. `card-footage-edit.jpg` — chip "15 · CUT A TALK". A podcaster at a microphone in a cosy studio (stylised, non-identifiable); below, a timeline with red regions struck out; chip top-right "removed 14 slips · 4:12 → 3:20".
33. `card-shorts-from-long.jpg` — chip "16 · SHORTS". One wide 16:9 podcast frame on the left splitting into three vertical 9:16 clips on the right, each with a score chip "hook 9/10", "hook 8/10", "hook 8/10" and bold captions.
34. `card-captions.jpg` — chip "17 · CAPTIONS". A street-food chef tossing noodles in steam, with four caption styles stacked as samples: outline pop, yellow keyword, sliding word box and one-word punch, all saying parts of "Thirty years of the same noodles".
35. `card-multicam-reframe.jpg` — chip "18 · MULTICAM & VERTICAL". Two camera angles of a two-person interview as tiles, waveforms aligned between them with a sync line, and a 9:16 crop box tracking one speaker's face in the wide shot.
36. `card-event-recap.jpg` — chip "19 · EVENT RECAP". A conference aftermovie collage: stage lights, crowd hands, lanyards, confetti, cut on the beat; chip top-right "248 clips → 60 s".
37. `card-your-genre.jpg` — chip "20 · YOUR GENRE". An empty, softly lit sound stage with a single spotlight on a bare director's chair and a dotted outline of a frame in the air with a big "+" in it; Claude and Codex peek from the side, inviting.

### D2. Cards added 2026-11-16 (same card rules)

42. `card-reference-style.jpg` — chip "21 · IN THE STYLE OF". Split frame: on the left, a dimmed film strip of an anonymous reference film overlaid with thin cyan measurement marks (cut ticks on a beat grid, an ease curve, a type-size bracket); on the right, a brand-new vivid frame for an invented sneaker "Kite" built with the same rhythm and layout, a gold arrow between the halves. Label under the left half: "their method", under the right: "your film".
43. `card-video-remix.jpg` — chip "22 · VIDEO REMIX". A dancer clip (stylised, non-identifiable, three-quarter view) shown as three stacked frames of the same pose: the original in plain daylight, then the same motion with the outfit swapped to a glowing jacket, then the same motion restyled as a painted anime look; small cyan labels "original", "swap", "restyle".
44. `card-photoreal-3d.jpg` — chip "23 · 3D PRODUCT SHOT". A photoreal premium studio shot: an invented, unbranded slim smartphone floating at an angle above a polished black floor, soft gradient light, crisp reflections, a glowing app screen; a faint wireframe of the same phone ghosted behind it, as if just rendered. No apple, no logo on the device.
45. `card-longform.jpg` — chip "24 · CHAPTERS". A long YouTube-style 16:9 lecture frame at the top with a progress bar divided into gold chapter segments titled "Intro", "Setup", "Deep dive", "Q&A"; below it, three vertical clips pulled out of the timeline like cards.
46. `card-ad-experiments.jpg` — chip "25 · AD EXPERIMENTS". One vertical ad shown three times side by side, identical except the first second: three different hook captions "Stop scrolling.", "I was wrong about this.", "3 seconds. Watch." with small chips "A", "B", "C" above them and a thin bracket below labelled "same body, same proof".
47. `card-catalogue-videos.jpg` — chip "26 · CATALOGUE". A spreadsheet of products on the left (columns "SKU", "name", "price", rows of invented items: "Lamp", "Mug", "Chair", "Bag") with glowing cyan threads running from each row to a grid of matching small vertical video frames on the right, each showing that product and its price tag.
48. `card-content-series.jpg` — chip "27 · SERIES". A month calendar wall where every day tile is a small video frame with the same friendly illustrated host character (an invented cartoon chef with a mint apron) in a different scene, episode numbers "EP 01" … "EP 12" in the corners, a gold ring around today's tile.
49. `card-localise-campaign.jpg` — chip "28 · CAMPAIGN × LANGUAGES". A grid of the same three ad frames repeated in four rows, each row with a different caption language: "Try it free", "Pruébalo gratis", "Essayez gratuitement", "無料で試す", with small round colour dots (no flags) at the start of each row.
50. `card-reference-family.jpg` — chip "29 · REFERENCE FAMILY". One golden blueprint card in the centre showing a film's structure as slots ("hook", "reveal", "proof", "logo") with timing marks; three different invented products (a watch, a jar of honey, a backpack) each flowing out of the blueprint into its own frame with the same composition.

### D3. Section illustrations added 2026-11-16 (opaque, 1536×1024, ship 1200×800 JPEG, no chip)

These two name real models and platforms on purpose, as plain text labels in one uniform typeface, to identify what the studio works with. The avoid list applies with one exception: the quoted names below may appear as plain text. Still no logos, logo shapes, brand colours used as marks, or any name not quoted.

51. `section-models.jpg` — the studio's "casting office": an enormous art-deco telephone switchboard in brass and black lacquer, lit in warm tungsten with cyan glows, under an engraved header "THE CASTING OFFICE" and a smaller plate "NOW CASTING". No category headers or columns of any kind. In the foreground section, twenty brass jacks in a loose grid, each with a small cream label plate in identical condensed monospace capitals, exactly these twenty in any order: "KLING", "SEEDANCE", "WAN", "HAILUO", "LTX", "HUNYUAN", "PIXVERSE", "VIDU", "GROK IMAGINE", "MAREY", "NANO BANANA", "GPT IMAGE", "FLUX", "SEEDREAM", "IDEOGRAM", "RECRAFT", "ELEVENLABS", "LYRIA", "STABLE AUDIO", "MESHY". The switchboard is the important part of the scale: it continues far to the left, right and up into the distance in deep perspective, hundreds upon hundreds of further jacks with tiny blank label plates and small glowing lamps, receding into haze, so the board reads as a vast catalogue. Codex plugs a glowing cyan patch cable into the jack labelled "SEEDANCE"; Claude stands on a small step with his gold megaphone, pointing up at the board. On the right, a large brass gauge labelled "BUDGET" with its needle in a green zone and a stack of gold coins beside it.
52. `section-sources.jpg` — the studio's "source room": a wall of polished brass pneumatic tubes, each ending in a small enamel plate in identical condensed monospace capitals, exactly these twelve: "YOUTUBE", "TIKTOK", "INSTAGRAM", "VIMEO", "X", "REDDIT", "SOUNDCLOUD", "BANDCAMP", "BILIBILI", "TED", "PINTEREST", "LINKEDIN". Glass capsules shoot out of the tubes, each carrying a glowing cyan card with "https://…", and land in a tray on a long archivist's desk. Codex sits at the desk with a ledger, stamping each card with a red stamp that reads "SOURCE · DATE · RIGHTS" before sliding it into a film can labelled "ORIGINAL". Claude, in his beret, studies a frame strip under a green banker's lamp. Engraved header above the tubes: "THE SOURCE ROOM". Orderly, archival, trustworthy mood.

## E. Premiere posters (opaque, 1024×1536, ship 600×900 JPEG)

Three teaser posters in the style of 1930s art-deco film posters, each with "AGENT BROS. PICTURES PRESENTS" small at the top and "COMING SOON" large at the bottom.

38. `poster-1.jpg` — a launch rocket made of film reels lifting off from a laptop, gold and cyan; title "THE LAUNCH".
39. `poster-2.jpg` — a giant vertical phone as a skyscraper in a neon city, crowds looking up; title "FIFTEEN SECONDS".
40. `poster-3.jpg` — a professor-robot (Claude in a mortarboard) at a blackboard of glowing equations, students' silhouettes; title "THE LESSON".

## F. Story

41. `story.jpg` — 1536×1024. A warm, nostalgic 1990s home-video memory: a child's desk at dusk with a chunky camcorder, a stack of VHS tapes with hand-written labels ("MY FIRST FILM", "THE END?"), a CRT TV glowing with a paused frame, a hand-drawn storyboard pinned to the wall; through the window, faint searchlights over a distant city. On the edge of the desk, tiny and almost hidden, the two brothers as toy figurines. Soft grain, VHS colour bleed, tender light. No people.

## G. Contributing map

42. `contributing-map.jpg` — 1536×1024, ship 1600×900 (crop 16:9 from centre), header of [CONTRIBUTING.md](../../CONTRIBUTING.md). Components, coordinates, facts and the animation plan: [contributing-map.md](contributing-map.md); the original is `src/contributing-map.png`.

> A cinematic infographic map titled by a marquee: how humans and AI agents contribute to a source-available film studio, staged as one night on a 1930s art-deco studio backlot. Read it as a clean, legible infographic first and a scene second: semi-flat vector-like illustration, crisp separate objects with soft gold rim light from the top left, light film grain, a dark low-detail backdrop (faint soundstage silhouettes, a starry ink-black sky). Keep all important content inside the middle 16:9 band (empty margin above and below for cropping). Components never overlap; plain backdrop between them.
>
> **Top centre:** a bulb marquee reading "NOW CASTING", and under it, smaller: "HUMANS + AGENTS". **Top left:** Claude holding his gold megaphone, beside a studio searchlight whose beam crosses down onto the film strip's second frame. **Top right:** Codex at a small editing console whose screen shows a cyan `>_` caret.
>
> **Middle band, full width:** a long 35 mm film strip arcing gently from left to right with eight evenly spaced frames, each with a simple icon and a cream caption below it, in order: "1 FORK" (a film strip splitting in two like a fork), "2 SCOUT" (a searchlight on a board of small film tins), "3 CLAIM" (a ticket stub with a stamp), "4 BUILD" (an editing console with a green tick), "5 ENTRY" (a slate being chalked), "6 CHECK" (a clipboard of green ticks), "7 PR" (a sealed envelope with a gold signature), "8 REVIEW" (a director's chair with a speech bubble). Under frame 3 hang three small slates on strings: "S", "M", "L".
>
> **Lower left:** four backstage passes on lanyards hanging from hooks, rising left to right like stairs, each a little bigger and more golden: "0 NEWCOMER" (plain paper), "1 CONTRIBUTOR" (bronze), "2 TRUSTED" (silver), "3 MAINTAINER" (gold).
>
> **Lower centre:** a thin gold dotted route runs from frame 8 down to a row of six small art-deco arches, the studio gates, labelled on their keystones "G0 CLA" (a hand in a dark sleeve signing with a gold fountain pen), "G1 SHAPE" (a measuring slate), "G2 TESTS" (green ticks), "G3 VALUE" (a gold star), "G4 TRIAGE" (wide open, a tiny critic robot with a monocle beside it), "G5 BENCH" (drawn dimmer, dotted outline, optional). A small glowing cyan film canister waits on the route before G0. After the gates a red carpet with brass stanchions leads to premiere doors with a sign "MERGED". Below the gates, three props in a row: a red clapperboard stamped "CUT", an amber hanging sign "RETAKE", and a single golden ticket "/APPEAL ×1".
>
> **Lower right:** a 2×2 cluster of rewards joined to the premiere by the dotted route: a scrolling film-credits roll "CREDITS", a set of enamel pins "BADGES", a small framed movie poster "SHOWCASE", a name card on a director's chair back "PROFILE".
>
> Labels are condensed art-deco capitals in cream or gold, or cyan monospace, large and readable at 900 px wide. Spell exactly the quoted words and no other text.

## H. Architecture cover

43. `architecture-cover.jpg` — 1536×1024, ship 1600×900 (crop 16:9 from centre), JPEG quality 82, header of [docs/architecture.md](../architecture.md). The original is `src/architecture-cover.png`; use `src/brothers-reference.png` as the character reference. Generated twice; the second generation is shipped.

> OUTPUT CANVAS: exactly 1536 pixels wide by 1024 pixels high, a 3:2 aspect ratio landscape opaque PNG. This is a 3:2 composition, not widescreen. A cinematic architectural infographic staged inside a 1930s art-deco classroom / studio screening room. Read it as a legible diagram first and a scene second. An enormous, genuinely WHITE whiteboard faces the viewer nearly straight on, filling most of the width. The board is white, not cream, not a blackboard. Dark low-detail walnut panelling, restrained brass art-deco pilasters and warm tungsten sconces frame it. Premium semi-flat illustration with tangible enamel-and-brass character detail and gentle film grain. No title or extra writing.
>
> Composition: full canvas is 3:2. Leave generous empty room margins above and below the board. Keep EVERY label and both robot heads inside x=90..1440 and y=115..900. Whiteboard outer rectangle approximately x=100..1436, y=125..855. Empty room margins above and below. No glare over the board.
>
> Match both robots EXACTLY to the supplied brothers-reference.png character sheet: same proportions, silhouettes, palette, materials, equipment and faces. Claude is the larger terracotta cine-camera robot, twin brass film reels, black beret, amber round lens eye, gold megaphone. Codex is the slimmer teal editing-console robot, brass headphones, CRT face with cyan ">_" and film-strip scarf. They stand small in the lower LEFT and lower RIGHT foreground corners respectively, seen from behind in three-quarter profile, looking up at the board, not blocking any label. A sliver of Claude's glowing lens and Codex's CRT face is visible in profile. Claude points inward with the gold megaphone; Codex holds a dry-erase marker. Do not copy character-sheet names onto the illustration.
>
> On the WHITE board, ONE coherent graph in BLACK, BLUE, GREEN and RED dry-erase marker. Handwritten lettering, crisp dark marker strokes, slightly imperfect rectangles, folder-tab outlines and arrows, ample white space. All text large and easily readable; paths in careful print with exact punctuation and case. Around twenty compact label groups, with the grouped instruction and rendering nodes containing three short lines each. No other text.
>
> Precise graph layout:
> TOP ROW, centred, three separate boxes connected LEFT TO RIGHT: "USER REQUEST" → "PLAYBOOKS" → "pnpm next".
> DIRECTLY BELOW "pnpm next", a blue branching comb fans to FIVE separate small route boxes arranged horizontally: "FILM", "FOOTAGE", "TIMELINE", "CAMPAIGN", "WORKFLOW". All five are peers selected by the route, NOT consecutive steps. Under the fan, their shared connector descends to the CLI layer.
> LEFT SIDE, a separate instruction box with three stacked lines: "AGENTS.md", "SKILLS", "AGENTS". A thin black arrow from this box points to the CLI layer.
> MIDDLE COLUMN, below the routes: one wide two-line folder-tab box containing "scripts/ (CLI)" and "src/mcp", then a downward arrow into a folder labelled "src/lib", then a downward arrow labelled by no extra text into a folder labelled "src/types (ZOD)". CLI → domain libraries → schemas, only this direction. The src/types (ZOD) folder is a TERMINAL LEAF: absolutely no outgoing arrow or line from it.
> RENDER BRANCH to the RIGHT: an arrow from "src/lib" to a box labelled "src/Root.tsx", then a downward branching arrow to a wide folder group containing the three clearly separate stacked lines "components", "templates", "motion library". ONLY this rendering branch leads down into the render step; the schema folder has no connection to RENDER.
> BOTTOM ROW across the board, above the characters: a long folder labelled "public/projects/<id>/pipeline" (may wrap after the slash before pipeline without changing its spelling), arrow → a box "RENDER", arrow → a folder "out/<id>", arrow → a box "DELIVERY". The render branch connects INTO this same "RENDER" box. Use green marker for the data-flow arrows and folder outlines.
> LEFT MIDDLE free space, a small red oval enclosing "USER APPROVES"; a red line from the oval touches the lower delivery flow, indicating the user approval gate.
> A fine blue loop arrow returns from "DELIVERY" around the right perimeter of the diagram back towards "pnpm next", labelled ONCE "MEMORY".
> Keep every arrow distinct, clean, readable and out of the text. Labels are written exactly as quoted, including slash, dot, parentheses, angle brackets and lower-case paths. Every node fits on the board.
