# Product tutorial playbook

Last updated: 2026-11-16

Choose it when the film teaches one task in a real web or mobile product (tutorial, how-to, walkthrough, onboarding, help-centre video). Otherwise: selling the product is [product-promo](../product-promo/AGENTS.md); what changed in a release, [feature-update](../feature-update/AGENTS.md); a store page video, [app-store-preview](../app-store-preview/AGENTS.md); an idea rather than a product's screens, [explainer](../explainer/AGENTS.md). The user's own screencast stays here through the footage alternative; its cut mechanics are [footage-edit](../footage-edit/AGENTS.md)'s.

## Start

```bash
pnpm film:init --project <id> --type ui-demo --secondary explainer --playbook product-tutorial --product <path>
pnpm film:next --project <id>        # repeat: do what it says
# own screencast instead:
pnpm footage:next --project <id> --playbook product-tutorial --source <file> --goal recut,captions
```

`ui-demo` brings the capture, ui blocks and QA lines; `explainer` adds voice-first sound and one idea per state ([film types](../../docs/film-types.md)). Alternative: supplied captures and timings through `pnpm video:workflow --scenario education`.

Ask the `intake` questions in `playbook.json` in one message (the task and product access block the start); `profiles` set length, chapters and captions per placement; `starter` names the blocks to begin from.

| Variant | When | What changes |
|---|---|---|
| `onboarding` | A clip inside the product: welcome, first run, empty state | Muted autoplay: no voice or music; one-to-three-word labels and the cursor carry 1–3 steps in 15–45 s (house rule); loops (last frame = first); small MP4 and poster frame |
| `help-center` | Help centre, knowledge base, support article | One task per chapter, each opening on its result; chapter titles in the words users search; SRT/VTT and a transcript from `captions:export`; product version in the brief for re-capture |

## What good looks like

- **One task, named in the first 5 s, its result shown before step one** (TechSmith; NN/g).
- **Length follows the task** (`profiles`): a single feature 30–90 s, a workflow 3–6 min (Wistia), over 6 min chaptered, one task each (Guo et al.; NN/g).
- **About 12 actions or fewer per task**: Arcade's top interactive demos cluster at 12 steps (vendor data). More means two tutorials.
- **One action per beat**: the voice names the control, the cursor reaches it, the click lands, the new state holds still.
- **Every UI string the voice refers to is readable** at playback size and held for its reading time.
- **Real product, real-looking data**, in the viewer's language. No spinners, no typing waits, no lorem ipsum.
- **Ends on the next step**: a still frame with what to do or watch next. It is the thumbnail and loop frame; no fade.

## Method

1. **Fix the task.** The brief names the one job ("export an invoice as PDF"), its start and finished states and the viewer's level; two jobs make two films or chapters (`brief-collector`).
2. **Write the steps before the words.** List every click, field and choice from start to result on the real product; cut any that are not needed to repeat the task. This list is the beat sheet's spine (`script-and-education` skill; `motion-director` keeps one action per beat).
3. **Result first.** Open on the finished state for 2–4 s (house rule, a starting point), then cut back to the start: one `capture:app` run, two in-points.
4. **Script to the actions.** One sentence per action, the control's on-screen label said exactly as it reads, the why in a clause, not a paragraph. Name the control just before the cursor reaches it; the click never precedes the words. Voiceover is paid: `pnpm generate:voiceover` runs only within an approved budget.
5. **Voice first, then capture to it.** With the voice's word timings, set each `capture:app` step's `at` frame on its word (`--script steps.json`); without a voice yet, capture with generous holds.
6. **Capture a clean, seeded state.** A local build or a test account with seed data ([real-ui](../../docs/real-ui.md)): realistic names, amounts and dates in the film's language; never real people's data. Data that loads during the capture shows spinners; capture a loaded state instead ([capture-app limits](../../docs/capture-app.md#limits)). `capture:html` for a local prototype.
7. **Cut the waits.** Typing: split long text into `type` steps and cut to the filled field after the first few characters, or capture it pre-filled. Loads and saves: cut on the click to the next state. Never speed-ramp the screen.
8. **Draw the cursor.** Headless capture has none. Draw `Cursor` from `src/motion/ui.tsx` as a child of the `ui-camera-read` camera so zooms carry it, keyed from the click and hover events in `capture.json`: CSS pixels times the capture `--scale` (2 by default). Press-scale only, no click ring (transparent `pulseColor`; [craft rules](../../design-reference/craft-rules.md)). A mobile capture gets `ui-touch-hotspot` dots instead (`tapsFromCapture`).
9. **Zoom on the action, not on every click.** `ui-camera-read` pushes to the region the beat uses, holds while the voice explains, and pulls out for bearings (a new screen, a distant menu). Stay in for a run of clicks in one panel.
10. **Hold for reading.** A new screen or dialog holds before the next move for the reading floor the chain's `plan:check` enforces ([script-and-education](../../.agents/skills/script-and-education/SKILL.md)); a field's label and value must both be on screen when named.
11. **Chapters for long ones.** Over 6 min or about 12 actions: one task per chapter, each opening on its result; the chapter list goes in the script (YouTube rules in `profiles`).
12. **Sound.** Voice first, music low or none; UI clicks from `pnpm sfx:synth` or authorised `sfx:generate`, placed with `pnpm sfx:cues` on the capture's click frames. Agents cannot hear: the mix is the user's call.
13. **Localise from one composition.** Re-capture the product in the target language with the same steps; map the new voice onto the beats with the time-warp method in [captions-and-localization](../../.agents/skills/captions-and-localization/SKILL.md). Captions burned in for sound-off viewers; SRT/VTT sidecars with `pnpm captions:export`.

## Tools

- `capture:app` / `capture:html`: real screens frame by frame with a click log; `aiscreen` MCP for native or logged-in apps (real time; treat as footage).
- `ui-camera-read` (category `ui`, `pnpm library:list --category ui`): the reading camera. Other `ui-*` blocks only for interfaces belonging to no named product.
- `Cursor` in `src/motion/ui.tsx`: the pointer; `ui-touch-hotspot`: touches.
- Skills `script-and-education` (steps, labels, reading time), `captions-and-localization`, `recording-guide` (the user records on their device).
- `motion:still`, `review:sheet`: every UI text at playback size; `delivery`: final check.

## Anti-patterns

- A feature catalogue: "and here you can also…". One task; the rest is another video.
- An intro, logo sting or agenda longer than the result shot.
- The cursor wandering, circling or hovering while the voice talks; the click before the words.
- Zoom on every click (seasick), or no zoom at all (14 px text in a 1080 frame).
- Spinners, progress bars and typing in real time left in.
- Lorem ipsum, "Test User", "asdf", empty dashboards, real customers' data.
- A drawn UI kit standing in for the product, or an old version of it.
- Voice describing what is already visible ("now I click the blue button") instead of why.
- Ending on a fade or a logo instead of the next step.
- Re-cutting a translation without re-capturing the localised UI.

## References

- TechSmith, [Video Viewer Study 2024](https://assets.techsmith.com/docs/TechSmith-Video-Viewer-Study-2024.pdf): 54% choose by matching description; about a third prefer 3–6 min, nearly two thirds call 20+ min too long; record the voice before the screen.
- Wistia, [2024 State of Video](https://wistia.com/learn/marketing/insights-state-of-video-report): engagement flat 1–5 min; 3–5 min instructional videos 74% vs 43% for all.
- Nielsen Norman Group, [Instructional video guidelines](https://www.nngroup.com/articles/instructional-video-guidelines/) (2020, foundational): split multistep processes, add chapters, no long intros, captions.
- Guo, Kim, Rubin, [How video production affects student engagement](https://up.csail.mit.edu/other-pubs/las2014-pguo-engagement.pdf) (2014, foundational): engagement falls sharply after 6 min.
- Arcade, [interactive demo benchmarks](https://www.arcade.software/post/interactive-demo-benchmarks) (vendor data): top demos about 12 steps.
- van der Meij and Hopfner, [Eleven guidelines for software training videos](https://www.stc.org/techcomm/?p=53458) (2022): preview the task, keep it short.
- Alpizar, Adesope, Wong (2020), [signaling meta-analysis](https://rex.libraries.wsu.edu/esploro/outputs/journalArticle/A-meta-analysis-of-signaling-principle-in/99900601052901842): cues that direct attention help learning (d = 0.38); the zoom and cursor are the cues.
- Profiles (opened 2026-11-13): YouTube [video chapters](https://support.google.com/youtube/answer/9884579) (00:00, three or more, 10 s minimum); [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay) (muted autoplay only, so embeds are silent or captioned); [LinkedIn video ad specs](https://www.linkedin.com/help/lms/answer/a424737) (15–30 s feed, 90 s in-stream, SRT, under 30 fps).

## Done when

- `film:next` reports the chain complete and `pnpm delivery` passes its check.
- Replay all product steps to reach the shown result.
- Result shot before step one; still next-step frame at the end; one task per film or chapter.
- Every frame shows the real product in the film's language with seeded, realistic data; no spinners or typing waits.
- `motion:still` frames at each action show its label readable and the cursor on it; no click ring.
- User-approved voice and film; record the verdict with `creative-postmortem`.

UI symbols: [guide](../../docs/icon-resources.md).
