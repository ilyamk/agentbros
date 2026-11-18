# onetake

- URL: https://github.com/feitangyuan/onetake
- Commit studied: `abb6d17279cdc749e27e99aa534a062d8fd01ced` (shallow clone, 2026-11-11)
- Licence as stated: PolyForm Noncommercial 1.0.0 (`LICENSE`, README badge and the SKILL.md front matter); bundled fonts are OFL (`looks/fonts/LICENSES.txt`). The owner has accepted the licence position for this personal open-source repository; no source file was copied.
- Author: Patrick (github.com/feitangyuan)

## What it is

A Claude/Codex skill for 10–60 s product motion films built as one HTML composition where every value is a function of time, seeked frame by frame by Playwright with real shutter blur. A move library (`lib/motion.js`: springs, entrances, carries, contact, camera, fluid), Python tools (reference analysis, footage recording, render, a probe that scores each section boundary, an acceptance oracle, a synthesised SFX palette, Kokoro/whisper narration), and eleven case write-ups with the user's verdicts on each cut. Its strength is the measured lessons from rejected and accepted cuts.

## Triage

| Area | Verdict |
|---|---|
| Rhythm and carry lessons (`references/rhythm.md`, SKILL hard rules, case READMEs) | Better than ours: two independent causes of "slideshow", with numbers and thresholds. Imported |
| Carry and contact moves (`ripple`, `impactSplit`/`hop`/`impact`, `gather`/`seal`) | Missing from our library. Ported as blocks |
| `iris`, `morphRect`, `zoomThrough`, `whip`, `flyThrough`, `typeOn`, `wordRise`, `maskRise`, `staccato` | Already have equivalents (`colour-flood`, `shared-element-carry`, `caused-morph`, `zoom-through`, `whip-pan`, `depth-card-flythrough`, `ui-code-editor`, `type-*`, `type-word-pulse`) |
| Camera (`camera` keys, operator hand, `shake`, `view`, `lattice`) | Mostly covered by `src/motion/camera*.ts` and motion-grammar; the chase/trail, camera-on-the-beat and deep-zoom lessons imported as text |
| Sound (`references/sound.md`) | Our `sfx:synth`, `sfx:cues` and `audio:mix` cover the tooling; the measured failure lessons imported as text |
| Product demo: rebuilt UI, legibility arithmetic, glow-ring highlight, time warp for languages | Lessons imported as text; our UI kit already rebuilds UI as code |
| Reference analysis (`analyze_ref.py`), oracle (`verify_promo.py`), probe (`probe.py`) | We have `ref:analyze`, `film:targets`, `plan:check`, `motion:check` and the critic; the carry score definition is now in our reference text. A frame-level carry probe could follow later |
| HTML render pipeline, Playwright footage, Kokoro TTS, looks/fonts, gallery | Rejected: parallel to our Remotion and HTML-capture routes, Python dependencies, nothing better than ours |
| `silk`, `lightField`, `carouselLoop`, `ribbon`, sims | Rejected for now: film-specific grounds and sims; our backgrounds category covers the role. `ribbon` is a candidate for a later block |
| Case films (mp4, gif), logos | Rejected: their films and brand, not material for ours |

## What we took and where

| Taken | Where | Why |
|---|---|---|
| Rhythm and carry diagnosis, carry score, rest/burst numbers, cause and meaning, camera lessons, product-UI legibility | `.agents/skills/motion-and-typography/references/carry-and-rhythm.md`; linked from that skill, `motion-director` and `creative-critic` | Gives directors and critics a measured test for "it looks like slides" |
| Sound failure lessons (one room, SFX vs music by window and band, mud per window, loudness by beat, lockstep contacts, stock ending) | `.agents/skills/sound-design-and-mix/SKILL.md` | Concrete checks for mixes that measure fine but sound wrong |
| Time warp for another language's narration | `.agents/skills/captions-and-localization/SKILL.md` | One composition per film across languages |
| `ripple` drain | `src/motion/library/effects/RippleDrain.tsx` (`ripple-drain`) | A flood that ends on the next scene without a wipe |
| `impactSplit`, `hop`, `impact` | `src/motion/library/effects/ImpactSplit.tsx` (`impact-split`) | Contact as the event: the subject lands on the title |
| `gather`, `seal` | `src/motion/library/effects/GatherSeal.tsx` (`gather-seal`) | A many-to-one carry into the lockup |
| The move maths, rewritten | `src/motion/library/effects/contact-math.ts` | Pure functions of seconds for scenes that need their own lander |

## Not taken, and why

- The single-HTML-file composition and its renderer: our Remotion route and `docs/html-capture.md` already do this deterministically.
- Its hard rule "no particles": we keep `particle-assemble` as a library block but the reference text repeats the warning.
- The always-still rests rule as a sensor: our `plan:check` flags long still holds; the text now separates a planned rest (dead still) from an information hold, without changing the sensor.
