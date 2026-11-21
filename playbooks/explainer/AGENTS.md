# Explainer playbook

Last updated: 2026-11-21

Explain an idea, process or data set: usually voiced, 30 s to several minutes. How to use a specific product, or how the user's own app works, is [product-tutorial](../product-tutorial/AGENTS.md); an animated film that teaches nothing is [motion-design](../motion-design/AGENTS.md); a lesson the user recorded is [footage-edit](../footage-edit/AGENTS.md); a generated presenter explaining to camera is [avatar-presenter](../avatar-presenter/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type explainer --playbook explainer --product <source> [--product <source> ...]
pnpm film:next --project <id>        # do what it says, repeat
```

`--product` takes the topic's **sources**, not media: `.md`/`.txt` notes and articles, `.json`/`.csv` data. They land in `pipeline/product-sources.json`; `truth` gives every claim a status, or stops and names what it needs. The education-workflow pointer `film:init` prints is a reminder, not an error. The brief sets `bespoke.voiceNeeded` unless the film is silent.

Supplied lesson material and chapters: the [education workflow](../../docs/workflows/education.md) (`pnpm video:workflow --scenario education --action plan --request <file>`).

Ask the `intake` questions in `playbook.json` in one message (the question and its sources block the start); `profiles` set length, captions and ending per placement; `starter` names the blocks and style to begin from.

| Variant | When | What changes |
|---|---|---|
| `data-report` | A report, survey results, a year in numbers | A data file is a required `--product` source; every number shows subject, period, basis and a source line; one chart carried through states; ends on the one number to remember (`hero-stat-odometer`) |
| `course-lesson` | A designed lesson in an online course | Learning objective in the first 10 s; 3–6 min per lesson; each ends on a retrieval question; captions plus SRT; one look and recap pattern across the series. A filmed lesson is footage-edit |

## What good looks like

- **One question per segment**, answered by the end of it, **under 6 minutes**: the median edX watch was at most 6 minutes whatever the length (Guo et al. 2014).
- **Worked example before the rule.** The viewer sees one concrete case with real numbers before the general statement.
- **Every claim and number traces to a source** in `product-truth.json`; illustrative data is labelled as such on screen.
- **Narration pace** measured, not assumed: English near 156 wpm (Guo et al. 2014); Russian about 23 words per 10 s for a calm beat ([script-and-education](../../.agents/skills/script-and-education/SKILL.md)).
- **Ends on retrieval**: a question or prediction the viewer answers, then the answer, then a still final frame.

## Method

1. **Strategy: the question.** The proposition is the question the film answers, phrased the way the audience would ask it ("why does ice float?"), and the hook mechanic shows the puzzle, not the answer. Owner: `strategist` at the strategy step.
2. **Truth: sources first.** Every number, date and causal claim gets a status in `truth`; unsourced ones are cut or spoken as a hedge. For a chart in a workflow or template project, bind the number to its record and check it with `pnpm chart:inspect --project <id>` ([chart evidence](../../docs/chart-evidence.md)). Never draw a chart from invented data.
3. **Script: concrete, then abstract.** The `script-writer` orders beats as puzzle, one worked example with named values, the general rule, a counterexample or limit, the application. Prerequisite terms are named and shown before they are used (pre-training, Mayer). Record it in the [script-and-education](../../.agents/skills/script-and-education/SKILL.md) `script-claim-map`. Conversational second person, not lecture voice.
4. **Segment.** Each idea is one beat, one diagram state. In the beat sheet the `motion-director` puts a visible boundary between segments (a held state, a section title, a ground change) and gives every state its narration plus reading time; `pnpm plan:check` enforces the reading floor. Longer than 6 minutes: plan chapters here, each a self-contained question with its own recap.
5. **Look: one visual metaphor.** One world; the same object always stands for the same thing (drawn media: [film style prompts](../../design-reference/film-style-prompts.md)). The `design-director` proves it on the hardest diagram first.
6. **Build diagrams that change state.** Use `viz-scene`: `viz:list`, `viz:prepare` with source-backed JSON, `viz:preview` per format, then `viz:mount` with the pinned revision and edit/plan hash. Cue reveals, highlights and holds. Three makes spatial animatics, Blender the material pass. `viz:check` verifies the [contracts](../../docs/visualisations.md). See [layout carry](../../design-reference/techniques/layout-carry.md) and the [3D pilot](../../docs/drei-techniques.md).
7. **Signal.** Highlight the part being spoken about (colour, scale, dim the rest); label it beside that part with `kinetic` labels, never a distant legend. A running key sentence can use the [building caption](../../design-reference/techniques/building-caption.md).
8. **Voice, then sync.** The voice is paid: `pnpm generate:voiceover` only with the user's approval and budget. Measure it free with `pnpm speech:local --input <voice> --project <id>`: words over speech time is the real pace, and the word timings place each state change on the word that names it (temporal contiguity). Too fast for the picture: cut words, never speed the voice up.
9. **Sound.** Music drops out under dense sentences; SFX only on state changes (`pnpm sfx:cues` or authorised `sfx:generate`); the `sound-director` owns the mix.
10. **Captions.** Subtitles serve muted autoplay and accessibility; place them with `pnpm captions:place` clear of the diagram. They are the only place the narration is written out in full.
11. **Retrieval and close.** The last segment asks the viewer to predict or answer (testing beats re-reading at a delay: Roediger and Karpicke 2006), holds 2-3 s (house rule), shows the answer, then a three-point recap on the final diagram state. Long lessons built through the education workflow assemble chapters with `pnpm video:longform --project <id> --chapters <file> --assemble`.

## Tools

- Use `playbook.json` and [local alternatives](../../docs/local-macos.md) at the named Method step. Category `data` for diagrams, `kinetic` for labels that build.

## Anti-patterns

- **Wall of narration printed on screen.** Duplicating speech as body text hurts learning (redundancy: median d = 0.86 in 16 of 16 tests, Mayer 2019); two or three key words beside the graphic help (Mayer and Johnson 2008).
- **Decoration.** Background particles, stock b-roll that shows nothing, a music swell under a definition: extraneous material costs comprehension (coherence: d = 0.86, 23 of 23 tests).
- **Abstract first**: the definition or formula opens, an example trails as an afterthought.
- **Cut to a new chart** for every number, so the viewer re-reads axes instead of watching one diagram change.
- **Invented or rounded-up statistics**; a percentage without subject, period and basis.
- **Speeding the voice up** to fit a music section instead of cutting words or extending the hold.
- **Legend far from the data** (spatial contiguity d = 1.10); a part named a beat before or after it moves (temporal contiguity d = 1.22).
- **Recap without retrieval**, or a final frame that fades out.

## References

- Mayer's principles, median effect sizes (2019): [Chartered College](https://my.chartered.college/?p=6958). Signalling d = 0.41, segmenting 0.77, pre-training 0.75, modality 0.76, personalisation 0.79.
- Mayer and Johnson (2008), short on-screen key phrases next to the graphic, discussed in [Yue, Bjork and Bjork 2013](https://sites.lifesci.ucla.edu/psych-bjorklab/wp-content/uploads/sites/13/2016/07/YueBjorkBjork2013_redundancy.pdf).
- Guo, Kim and Rubin (2014), edX: chunks under 6 minutes, pre-production matters most, 48-254 wpm (mean 156, sd 31), faster speakers held attention longer when slides carried the content; correlational. [Paper](https://up.csail.mit.edu/other-pubs/las2014-pguo-engagement.pdf).
- [Wistia, State of Video 2024](https://wistia.com/blog/insights-state-of-video-report): engagement holds 1-5 min, falls after.
- Roediger and Karpicke (2006), test-enhanced learning: [paper](https://psychology.ecu.edu/wp-content/pv-uploads/sites/216/2019/03/Roediger-Karpicke-2006.pdf).
- [Kurzgesagt, our video process](https://kurzgesagt.org/youtube/): primary sources, a published source sheet, the voice sets the timing.
- Grant Sanderson (3Blue1Brown), visuals first, then the meaning: [Stanford Daily, 2020](https://www.stanforddaily.com/2020/01/24/3blue1brown-creator-grant-sanderson-15-talks-engaging-with-math-using-stories-and-visuals). Study by title: "But what is a neural network?".
- Profiles (opened 2026-11-13): [YouTube chapters](https://support.google.com/youtube/answer/9884579) (0:00, three or more, 10 s each); [LinkedIn video ad specs](https://www.linkedin.com/help/lms/answer/a424737) (15-30 s feed, 90 s in-stream, SRT, under 30 fps); [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay) (embeds start muted). Presentation band: house rule.

## Done when

- `film:next` is complete; film-type and playbook `qa` checked on frames.
- Every on-screen number and spoken claim maps to a sourced claim in `product-truth.json`; illustrative data is labelled.
- Measured pace from `speech:local` recorded in the project, with no state shorter than its sentence plus reading time.
- A segment over 6 minutes is split; a long film has chapter titles (and YouTube timestamps when it goes there).
- The final segment asks, waits, answers; the last frame holds.
- [Strict delivery](../../docs/delivery.md) check passes; the user, not an agent, judges the voice and music.

[Icons/logos](../../docs/icon-resources.md).

[Optional audio contracts](../../docs/audio-integrations.md).
