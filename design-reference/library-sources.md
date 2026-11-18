# Library sources

Research for the motion library (`src/motion/library/`) and for the agents' craft rules. Checked 11 November 2026 on shallow clones; their code was read, never run. The short rules for agents are in [craft-rules.md](craft-rules.md); the film-level bar stays in [creative-standards.md](creative-standards.md).

Hyperframes and Claude Motion have moved since the earlier audit in [agent-video-systems.md](agent-video-systems.md) (`9e9b613`, `e627941`). The SHAs below are the ones read for this file.

## Sources

Citations below use `<key> path:line`; the key expands to the pinned tree URL.

| Key | Repository and pinned commit | Licence | What we took |
|---|---|---|---|
| HF | [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes/tree/f36463e292f4487daef522ec9b19c2dacceb6adb) `f36463e2` | Apache-2.0 | Measured motion numbers from their launch films, the transition list, the spec template, banned defaults, the review pass, the registry shape (about 210 blocks and 239 components) and placeholder material. Ideas and numbers; any ported code keeps the notice. |
| CM | [whaleyxbt/claude-motion](https://github.com/whaleyxbt/claude-motion/tree/6f80380b91858dad66524a5b34e027dad656d538) `6f80380b` | MIT | Bezier set, spring table, staggers, reading holds, frame-seeded grain, vignette, review loop. |
| RS | [remotion-dev/skills](https://github.com/remotion-dev/skills/tree/1fc074b74b95cfecf7b1e419132f2cfe23dafebe) `1fc074b7` | No root LICENSE found: unverified, ideas only | API facts: `HtmlInCanvasMotionBlur`, `lightLeak()`, one rule file per topic. |
| PM | [remotion-dev/template-prompt-to-motion-graphics-saas](https://github.com/remotion-dev/template-prompt-to-motion-graphics-saas/tree/2051f5c0517cfd84b7b95ccef5efee39edc61c1a) `2051f5c0` | No root LICENSE found: unverified, ideas only | Skill routing by a classifier, skipping skills already loaded in the conversation. |
| LF | [lottiefiles/motion-design-skill](https://github.com/lottiefiles/motion-design-skill/tree/f9a8a041b85185ee4881b3471d3415e939aac772) `f9a8a041` | MIT | Material and overshoot tables, distance-to-duration scaling. Not its UI timings. |
| OM | [calesthio/OpenMontage](https://github.com/calesthio/OpenMontage/tree/fecb9a1e3cc23ef84de30b272059457a427f16f8) `fecb9a1e` | **AGPL-3.0** | Idea only: a style is a YAML playbook of numbers. Copy no code and no YAML verbatim. |

Also found but not cloned: `kylezantos/design-motion-principles` (web UI motion), `mblode` `ui-animation` (fits springs from a recording's contact sheet), and many Remotion skill copies on skill aggregators. All of them target UI micro-interaction or Remotion API knowledge, not film craft.

## What each system gives its agent

| | Hyperframes | Claude Motion | Remotion Skills / prompt template | LottieFiles skill | OpenMontage |
|---|---|---|---|---|---|
| Blocks | About 450 registry items: blocks are whole scenes, components are snippets. Installed as editable source. | Six primitives (`Mask`, `Roll`, `Grain`, `Background`, `WobbleFilter`, `Spark`) and one finished film to read | None. The template adds 9 working examples. | None | About 17 Remotion components (stat card, hero title, terminal…) |
| Style | No house style. Thirteen deck presets, which are never a film's fallback. The look is a SPEC line in numbers, taken from the brand, a reference or the medium. | One narrow, tuned house look: serif display, Inter, mono labels, one coral accent | None | Personality tables (playful, premium, corporate, energetic) | Five YAML style playbooks (palette, type, pacing, audio, image prompt prefix) |
| How the agent picks | `catalog --query "<what the beat does>" --json`, then `add`. A miss is reported before hand-building. `CATALOG.md` is a "shelf of 21" heroes with `use_when` and `avoid_when`. | Reads the skill, then reuses the components | A classifier picks guidance and example skills per prompt | Decision framework docs | The pipeline picks a playbook |
| Token economy | The skill is a 79-line router to topic files read on demand. The catalog is searched locally as JSON, with no listing in context. | 93-line taste file, 50-line review file | One rule file per topic. Skills already sent in the conversation are skipped (PM `src/app/api/generate/route.ts:356-383`). | Router SKILL plus pattern files | `skills/INDEX.md` router |
| Quality loop | `check` (lint plus craft warnings: `line_unread`, `dead_stretch`, `text_below_floor`, `first_frame_empty`), `snapshot --review` (scene start and mid, cut strips −0.2/+0.2 s, a 360 px phone sheet), `*.motion.json` assertions, P0/P1/P2 notes, a fresh sub-agent with only the storyboard and sheets | Half-resolution draft, a sheet 0.3 s after each timeline beat, a checklist, a waveform and LUFS check | Compile and auto-correct loop | Quality checklist | Review guide |

## Why their output looks pro

1. **Numbers measured from shipped films, not adjectives.** Hyperframes' motion file is frame-measured from their own launch films (HF `skills/hyperframes/references/motion.md:5`). Every adjective in a brief becomes a number: "premium" becomes 2% grain and a 0.55 contact shadow; "cinematic" becomes a key light upper left, a rim from behind and a 6% vignette (HF `references/spec.md:32-39`).
2. **Ease by role, never one curve.** "The same `power2.out` at 0.5 s on everything is the flat default that makes a film feel generated" (HF `motion.md:10`). This is our showcase's main tell.
3. **Motion blur on every fast move**, peaking at the fastest frame: 6–12 px on text-sized elements, 15–20 px full frame (HF `motion.md:7`). We have `@remotion/motion-blur` 4.0.539 installed and do not use it.
4. **Landed things are dead still.** The motion moves on to the next element, the camera or the world (HF `motion.md:15`, `:26`). Breathing and floating loops are named as generated tells.
5. **Transitions are caused by an object.** Zoom through a button, object becomes the world, morph, carry across, colour flood, whip, iris from the click, dip cut, blur swap. Use 3–5 kinds in a film; at most a third of the seams are hard cuts (HF `motion.md:30-42`).
6. **Defaults banned by name**: a dark void, glow and orbs, purple or blue mesh and glass, cream paper with serif and mono caps labels, everything centred, three cards in a row, a docked logo (HF `spec.md:50-62`). After the first render, every default that appears is added to the film's BANNED line.
7. **Real UI at 1.6–2× scale**, never a small window in an empty canvas and never UI tilted in 3D. Text stays ≥26 px after any push (HF `references/types/launch.md:20`).
8. **Worlds, not one canvas.** Several worlds, each with its own ground, light and scale, entered through an object on screen (HF `references/story.md:81`).
9. **Placeholder material carries no hue**: four alpha steps of the ink (72/45/18/8%) plus a hairline. The accent marks one element (HF `skills/hyperframes-registry/references/placeholder-material.md:24-30`). This is why their blocks never look like a template's colour.
10. **Claude Motion is one narrow style, done carefully.** Its fonts, italic accent word and mono caps labels are exactly what Hyperframes lists as the generated default (HF `spec.md:57`). Its polish comes from consistency, a timeline JSON and sound locked to it, not from the look. Do not copy the look as our default.
11. **Story beats are tied to shares of the film** and the payoff is spent once, 60–80% in (HF `story.md:67-75`).

## Craft rules with sources

Where sources disagree, the value chosen is in bold and the reason follows.

| Topic | Rule | Source |
|---|---|---|
| Fast move | 0.3–0.6 s, motion blur on its own ease | HF `motion.md:7` |
| Arrival ease | long tail: CM `bezier(0.16, 1, 0.3, 1)`, GSAP `expo.out`/`power4.out` | CM `.claude/skills/motion-design/SKILL.md:21`, HF `motion.md:10` |
| Exit ease | `bezier(0.6, 0, 0.9, 0.35)` / `power3.in` | CM `SKILL.md:22`, HF `motion.md:10` |
| Move between states, camera, colour flood | `bezier(0.65, 0, 0.35, 1)` / `power2.inOut` | CM `SKILL.md:23`, HF `motion.md:10` |
| Value that lands | overshoot `bezier(0.55, 0, 0.2, 1.12)` | CM `SKILL.md:24` |
| Exit length | **50–60% of the entrance**. HF says 40–50% shorter, CM about half, LF 65–75% (a UI value). | HF `motion.md:12`, CM `SKILL.md:46`, LF `reference/timing-easing-tables.md:21` |
| Overlap | the next element starts when the previous one is 30–50% done | HF `motion.md:12` |
| Stagger | letters 1 frame, words 60–120 ms (CM 90 ms), list items 40–80 ms (CM uses 200–250 ms for chips) | HF `motion.md:12`, CM `SKILL.md:44` |
| Springs | damping ratio 0.7–0.85 premium, 0.4–0.6 playful, below 0.3 cartoon. Position and size may bounce; opacity and colour never do. | HF `motion.md:11` |
| Remotion spring configs | settle 14/140/0.8, heavy 15–20/140–240, pop 9–11/200–230/0.7, elastic 8/200 once per film | CM `SKILL.md:32-38` |
| Overshoot by material | rigid 0%, glass 0%, paper 3–5%, fluid 5%, rubber 15–25%; premium 0% | LF `timing-easing-tables.md:64-71`, `:100-106` |
| Distance scaling | 100 px = 1.0×, 300 px = 1.5×, full screen = 1.8–2.0× | LF `timing-easing-tables.md:18` |
| Secondary moves | 50–70% of the hero's travel, start 100–200 ms later, everything else still | HF `spec.md:44` |
| Title entrances | per-word blur 6 → 0 px in 0.13 s, 0.067 s apart; grey-to-ink per word; line blur 8 → 0; per letter 0.1 s; behind the subject; slot roll at about 0.1 s | HF `motion.md:15-21` |
| Reading hold | **0.5 s + 0.3 s a word; the last line ≥ 2 s** (CM's ≥ 1 s + 0.25 s a word beyond three is looser) | HF `motion.md:22`, CM `SKILL.md:49` |
| Title size | 4–9% of frame height; quiet lines 2.5–4%; hero words 60–90% of the width; display tracking −0.02em, line height 1 | HF `motion.md:23`, CM `SKILL.md:54` |
| Text floor | ≥ 28 px at 1080 (2.6% of the short side); cut words, never shrink | HF `spec.md:48` |
| Words per line | ≤ 6 for titles; kinetic type 3–7 words per scene | HF `story.md:85`, `film.md:45` |
| Hero size | ≥ 40% of the frame's height or width | HF `spec.md:43` |
| Novelty | something new every 2–4 s; with music, a new layout every bar | HF `spec.md:47` |
| Shot lengths | montage 0.13–0.8 s; demo hold 7–10 s; average 1.8–3 s; 0.3–0.75 s hold before the payoff | HF `motion.md:24` |
| Music hits | a move starts 40–190 ms before the hit; a reaction 0–45 ms after; the hit itself is not eased; one treatment goes stale after about 6 s | HF `film.md:34-35` |
| Cuts | at the fastest frame, with matching direction and speed; mirror eases across the seam | HF `motion.md:14`, `:93` |
| Grain | 0.09 opacity, overlay blend, reseeded on twos; feTurbulence 0.85 | CM `src/components/primitives.tsx:115-126` |
| Vignette | `radial-gradient(ellipse 85% 85%, transparent 55%, rgba(0,0,0,.55))`; "cinematic" 6% | CM `src/components/Background.tsx:46`, HF `spec.md:39` |
| Gradients | full-frame linear gradients on dark grounds band in H.264: use radial or solid plus local glow; atmosphere accents at 15–25% opacity, never 5% | HF `references/look.md:51-52` |
| 3D light | warm key, cool rim, dark environment with 2–3 soft strips; turn the environment, not the object; contact shadow | HF `references/types/3d.md:19` |
| Cursor | 4–7% of the frame, enters from off-screen, its click causes the next thing on the same frame | HF `types/launch.md:29` |
| End card | lockup 15–30% of the width in the last 5–10%, performed, not faded; CTA held 1.5–3 s | HF `types/launch.md:37` |
| Captions over footage | backing brightness < 60 `screen`, 60–180 `overlay`, > 180 `normal`; scrim 30–40% sized to the text | HF `references/captions.md:38` |
| Busy film | remove a third of the motion; keep the moves that lead the eye | HF `references/review.md:38` |

**Unsourced** (no source gave numbers; proposed, to be tested): 3–4 depth planes per feature frame (ground, world detail, subject, foreground occluder); parallax ratios of about 0.3× ground, 0.6× world and 1.0× subject, with foreground at 1.3–1.5×.

## Film structure

Measured on a launch film of about 35 s (HF `story.md:67-75`): hook 8%, tension 12%, reveal 8% (20–30% in), proof 40% (3–6 verbs, one per beat), payoff 20% (60–80% in, once), claim 8%, end card 8%. Scaled to 15 s and 60 s in [craft-rules.md](craft-rules.md); that scaling is our extrapolation.

## Gap list, ranked by impact

Gaps are against the categories in `src/motion/library/types.ts`.

1. **finish/motion-blur-wrap**: a wrapper around `@remotion/motion-blur` (`HtmlInCanvasMotionBlur`, shutter 180, 8 samples; installed at 4.0.539) for any move over about 30 px/frame. It is the cheapest pro signal and we have none.
2. **finish/film-stack**: frame-seeded grain (0.06–0.09 overlay), a vignette, an optional light leak and a halation tint as one item with style-driven strength. Port the grain the way CM seeds it; HF `grain-overlay` uses CSS `steps(1) infinite`, which is not deterministic.
3. **transitions** for the caused set: `zoom-through-object`, `object-becomes-world`, `container-morph`, `carry-across`, `colour-flood`, `whip-blur`, `iris-from-point`, `dip-cut`, `blur-swap`. Each takes a source rect and HF's timings.
4. **typography entrances** to replace fade-and-rise: `word-blur-in`, `grey-to-ink`, `line-blur-in`, `letter-name`, `slot-roll`, `behind-subject`, and an exit for each (blur-out 0.13–0.25 s).
5. **camera/rig**: a 2.5D camera over 3–4 depth planes with parallax, a punch-in with blur, a tracking move onto a target rect, and a stage orbit at 3–5° a second.
6. **ui/real-screen-stage**: a captured screenshot or recording at 1.6–2× crop, a cursor at 4–7% that causes the next state, a click ripple that is not a ring, and a press-to-scene match cut. Placeholders use the 72/45/18/8% alpha ramp.
7. **backgrounds/worlds**: grounds made from a medium (paper with fibre noise, risograph with off-register plates, a studio sweep with a contact shadow, a lit desk), not gradients. Radial plus a local glow on dark grounds.
8. **three/product-lighting**: a key, rim and strip environment preset with a contact shadow, rotating the environment for sweeping highlights.
9. **styles** as number playbooks (OM idea, HF LOOK line): ground, ink, one accent with where it may appear, display face and size and tracking, eases by role, grain and vignette percentages, and a BANNED line. Revisit `finish.glow` in `LibraryStyle`, because HF bans glow by default.
10. **scenes/end-card-performed** and **data/count-up-landing**: count-up 1.2–1.6 s landing on a downbeat; a mark carried in at 15–30% of the width.
11. **finish/light-sweep** across type or product (HF `light-sweep-pass` idea: band at 115°, glow ≤ 0.32).
12. **Checks**, not items: `motion.json`-style assertions (`appearsBy`, `staysInFrame`, `keepsMoving`), plus `dead_stretch` (> 3 s unchanged) and `line_unread` sensors in `motion:check`.

Light leaks: RS documents `lightLeak()` from `@remotion/effects`, which is not in our `package.json`; we have `@remotion/light-leaks` 4.0.539. Verify before building on either.

## Token-efficiency patterns worth copying

- **A router skill under 80 lines** that points to topic files read only when needed (HF `SKILL.md` "What to read" table). Craft rules are one ≤ 120-line file.
- **Search, don't list.** The agent queries the catalog (`catalog --query … --json`) and gets a few rows back; the library index never enters context whole. Our registry should expose `library:find "<what the beat does>"` that returns id, one-line description, props schema summary and preview path.
- **A short hero shelf** (HF `registry/components/CATALOG.md:1-10`): about 20 items with `use_when` and `avoid_when`, read first. `avoid_when` lines come from real QA misuse.
- **Defaults make a good preview with no input; extra duration becomes hold**, never stretched animation (HF `CATALOG.md`, rule 8). Only changed props are passed.
- **Skip skills already sent** in the conversation (PM `route.ts:373-383`).
- **One timeline JSON** that picture, sound and sheets read, so a retime is one edit (CM `SKILL.md:12-14`).
- **Review by sheets and numbers, not video**: a sheet per beat, cut strips, a phone sheet; notes as one line each (`t · where · problem → change · what stays`), P0/P1/P2, no score out of 10 (HF `review.md:32-38`).
