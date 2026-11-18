# lemo-opuscar

- **URL:** https://github.com/lemomo-ai/lemo-opuscar
- **Commit studied:** `9eb7739a0fca4c6990fe966cb8b87b1930f7193a` (shallow clone, 2026-11-11). Read only; none of its scripts were run and none of its dependencies installed.
- **Licence as stated:** code and docs MIT (© 2026 LemoLab); demo films and stills CC BY 4.0; six demo voice tracks excluded (Edge TTS, Doubao TTS); third-party assets in demos keep their own licences.
- **What it is:** 66 film styles made in code for coding agents. Each style is a `STYLE.md` "style prompt" (fixed eleven sections) plus a demo film rendered from a canvas/WebGL page with `render(t)` in headless Chrome, with a Python sampler, procedural foley and ffmpeg mux. `DIRECTOR.md` and `TECHNIQUE.md` hold the directing and build method.

## Taken

| What | Where it lives | Why |
|---|---|---|
| The style-prompt structure (eleven sections) and a one-line index of all 66 styles with their native moves, generated from each `STYLE.md` | `design-reference/film-style-prompts.md`; pointer in `.agents/agents/design-director.md` | We had palettes and type styles, but no way to direct a film in a medium (ink, print, tape, chalk). Native moves are ready-made "one moment only this medium can do" |
| Film-ageing post (`styles/silent-film/demo/engine/film.js`: weave, flicker, scratches, dust, hair, burn, sepia): formulas ported to DOM and SVG, randomness through `random(seed)` | Block `film-damage`, `src/motion/library/effects/FilmDamage.tsx` | No archive or silent-film treatment in the library |
| CRT and videotape post (`core/post/crt.js`: chroma bleed with red shift, scanlines, RGB grille, phosphor glow, corners, power-on, tracking tears): WebGL passes rebuilt as SVG filters and overlays | Block `crt-tape`, `src/motion/library/effects/CrtTape.tsx` | Only a plain scanline overlay existed (`src/templates/overlays/ScanLines.tsx`) |
| One world-to-screen function for followers; on twos with a smooth camera (TECHNIQUE.md §2) | `.agents/skills/motion-and-typography/references/motion-grammar.md` | Two missing build rules |
| "Not the demo again": six axes, at least four differ (DIRECTOR.md §11) | `.agents/skills/reference-to-video/SKILL.md` | Guards against a copy of the reference |
| Low end for small speakers; compress TTS and balance by RMS (TECHNIQUE.md §4–5) | `.agents/skills/sound-design-and-mix/SKILL.md` | Missing mix rules |

Already in the repo from an earlier pass (not re-imported): benchmark, three ideas, native move, sound as half the film, two silences, J/L cuts, review loop, shared timeline (concept-director, script-writer, brief-collector, sound-director examples, motion-director and motion-engineer examples, `docs/production-chain.md`).

## Rejected

- **Its render, TTS, ASR, sampler, plucked-string and SFX stack** (`core/render`, `core/tts`, `core/audio`): duplicates our Remotion renderer, ElevenLabs route and `sfx:synth`; Python and Chrome pipeline outside our conventions.
- **three.js post (`core/three/post.js`, DoF and GTAO)**: the `three` category belongs to other work; noted for later.
- **Reading-time formula** (letters ÷ 15 + 1.5 s, CJK ÷ 4.5 + 1.5 s, `readcheck.mjs`): about 2.5 times stricter than the floor our `plan:check` enforces (a three-word Russian line: about 2.8 s against 1.1 s). Reported for a decision instead of adding a second, contradicting rule.
- **Spelling numbers out in TTS text**: `narrator-director` forbids changing words and checks it.
- **Map rules (DIRECTOR.md §13)**: encode one country's position on borders; source-specific policy, not craft.
- **The 66 demo films, stills, posters, fonts and voices**: content, not method; CC BY and third-party terms; heavy.
- **Plugin, setup and release tooling**, styleboard site, "make it your own" flow: specific to their distribution.
