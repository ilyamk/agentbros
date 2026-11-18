# Edit my recording playbook

Last updated: 2026-11-16

Cut, caption or reframe the user's recording: presenter, podcast, interview, lecture, vlog or multicam. Shorts: [shorts-from-long](../shorts-from-long/AGENTS.md); screencasts: [product-tutorial](../product-tutorial/AGENTS.md); translation: [localise](../localise/AGENTS.md); creator ads: [ugc-ad](../ugc-ad/AGENTS.md); events: [event-recap](../event-recap/AGENTS.md).

## Start

```bash
pnpm project:new --project <id>          # the source project; the recording goes in public/projects/<id>/assets/footage/
pnpm footage:next --project <id> --playbook footage-edit --source <file> --goal recut,captions
pnpm footage:next --project <id>         # repeat, doing what it returns
```

Ask the `intake` questions in `playbook.json` in one message first. Add `vertical` or `multicam` (with `--cameras <files>`) to `--goal` when asked, with `--formats`, `--caption-style` and `--language` if known. Order, flags and approval points: [footage editing](../../docs/footage-editing.md); the [footage-editor](../../.agents/agents/footage-editor.md) agent runs the loop. This file is the editing judgement inside it.

**Variants** (from the intake answer; `variants` in `playbook.json`):

| Variant | Pace flags | Cover and extras |
|---|---|---|
| talking head (base) | defaults | jump cuts left or covered (step 4) |
| `podcast` (also interview) | `--sentence-pause-ms 400`, `--speakers N` | angles per speaker, chapters, speaker-map crop, `type-lower-third` overlays |
| `lecture` | defaults | synced slide recording, chapters, no punch-ins |
| `vlog` | `--mid-pause-ms 250 --sentence-pause-ms 300` | `--punch-in 1.1`, own clips as B-roll |

## What good looks like

- **Meaning intact.** Every negation, caveat and attribution survives with its claim; nothing is reordered or spliced. `recut-plan.md` lists no cut the user had to reject twice.
- **Pauses sound like thinking, not like gaps.** Inside a sentence 250 ms, between sentences and at a speaker change 400 ms, the `recut:plan` defaults. Turn gaps run near 0–200 ms in every language studied (Stivers et al. 2009); over about half a second reads as dead air (1of10).
- **Cut density fits the destination.** YouTube talking heads commonly land a cut every 3–8 s (1of10); a lecture can be slower. The cut count results from removing waste; it is not a target.
- **Joins are inaudible.** Equal-power crossfade at the quietest point; room tone under joins in a noisy room.
- **Captions** pass [caption styles](../../docs/captions-styles.md): `captions:place` reports no `CAPTION_OVER_FACE`, `CAPTION_IN_UI_ZONE` or `TEXT_TOO_SMALL` the user has not accepted.
- **Vertical crops** keep the speaking face in frame through the whole cut and enlarge the source less than 2x.
- **Platform facts met**: formats, length, captions and loudness from `profiles` in `playbook.json`.

## Method

1. **Goals and transcriber in one message** (the intake). Filler removal needs `transcribe` (Scribe, paid); what `speech:local` misses is in [footage editing](../../docs/footage-editing.md) step 1. Offer Scribe with the cost `footage:next` prints and wait for the go-ahead.
2. **Set the pace by variant and destination before planning** (table above) on `footage:next`, which saves it and repeats it in every `recut:plan`. Vertical-first or energetic delivery takes the vlog flags. Pauses stay within 250–400 ms, mid not above sentence. Pads and `--room-tone` are `recut:plan` flags only: repeat them on reruns.
3. **Read `recut-plan.md` as an editor before showing it.** Mark any cut that removes: the beat after a punchline or a claim; a deliberate repetition ("sometimes more often, sometimes harder"); a hesitation that shows doubt the speaker meant; the last breath before a new thought. Propose those as `--reject C3,C7 --force`; the user decides. Murch's rule of six: emotion and story above rhythm.
4. **Cover jump cuts only where they distract.** On a single-camera recut picture and speech cut together; only the audio join moves, by up to `--snap-search-ms`. Covers:
   - Several cameras: `multicam:sync` and `multicam:angles`; a cut to the listener while the speaker talks on is the interview L-cut. A lecture's slide recording is synced the same way, but `multicam:angles` picks by speaker: the cut to the slide is chosen by hand. Slide images alone have no insert command.
   - B-roll over the join with `media:broll` ([analysis and B-roll](../../.agents/skills/recording-recut/references/analysis-and-broll.md)), starting on the word it illustrates.
   - Punch-in: `footage:next --punch-in 1.1` scales every second clip (110–120% practice). Not on top of a vertical crop near 2x.
   - Otherwise leave the jump cut: on YouTube and in vlogs it reads as honest tightening.
5. **Sound.** `--room-tone` when the room has audible hiss or hum. Agents cannot hear: before the full render give the user a `render --frames` excerpt around the densest run of cuts to judge joins and pace.
6. **Captions.** Choose by what the viewer does ([caption styles](../../.agents/skills/captions-and-localization/references/caption-styles.md)): `clean-sentence` or `line-box` for podcasts, lectures and long talk; `outline-pop` or `italic-shadow` for loud talking heads; never `word-box` for two people. Run `captions:place` after any reframe and apply it with `timeline:edit`. For landscape YouTube offer a clean render (`--captions off`) with an SRT from `captions:export`.
7. **Chapters** (podcast, lecture, long YouTube): export the recut's SRT with `captions:export --timeline`, pick topic starts from its output times and write the list for the description: at least three, the first at 00:00, each at least 10 s (YouTube help). No command writes them; the user approves the titles.
8. **Vertical.** `reframe:track` follows the face per shot; with two speakers in one wide frame the speaker map follows whoever speaks. Look at stills at speaker changes and the widest gesture before rendering.
9. **Render and hand over.** Render each format with `--timeline`; copy a render before rendering another caption style (it is overwritten). Final delivery is `delivery` snapshot then check ([delivery](../../docs/delivery.md)); set the request's loudness from the profile.

## Tools

| Tool | Why here |
|---|---|
| `speech:local`, `transcribe` | Bound transcript; [local tools](../../docs/local-macos.md), or paid verbatim Scribe |
| `recut:plan`, `timeline:edit` | Proposed cuts with evidence and pace flags; caption, placement, crop, angle and overlay commands |
| `captions:place`, `captions:export` | Positions on the real picture; SRT or VTT sidecars, the source of chapter times |
| `footage:shots`, `reframe:track`, `multicam:sync`, `multicam:angles` | Shots, crop paths, cameras on one clock |
| `media:broll` | Reviewed cutaways over speech |
| `matte` | Free person cut-outs for `subject-occlusion` (`--engine onnx`: steadier) |
| Library `captions`, skills `recording-recut`, `captions-and-localization`, `editorial-storytelling`, `sound-design-and-mix` | Caption presets; cut rules, caption choice, motivated holds, dialogue-first sound |

## Anti-patterns

- Cutting every pause to the minimum: breathless delivery that tires within a minute. Lower a loud breath rather than delete it.
- Accepting a "retake" that is really a parallel structure, or a cut that drops a caveat because a pause sat beside it.
- Promising filler removal from a `speech:local` transcript, or running `transcribe` without the user's go-ahead.
- Punch-ins on every cut, on a lecture, or on top of a vertical crop that already enlarges the source.
- Heavy uppercase captions on a long lecture; captions over the mouth or the platform's buttons.
- Reordering sentences: the workflow forbids it.
- Writing `review`, `approvedEditHash` or any approval; saying the cut sounds good.

## References

- Walter Murch, *In the Blink of an Eye*, 2nd ed. (2001), the rule of six: [summary](https://nofilmschool.com/2016/11/6-rules-good-cutting-according-oscar-winning-editor-walter-murch)
- Stivers et al. 2009, turn-taking in conversation, PNAS 106(26): [PubMed](https://pubmed.ncbi.nlm.nih.gov/19553212/)
- 1of10, jump cuts (practitioner blog; rules of thumb: a cut every 3–8 s, punch-in 110–120%): [article](https://1of10.com/blog/what-is-a-jump-cut/); hiding jump cuts: [No Film School](https://nofilmschool.com/easy-ways-to-hide-jump-cuts-your-next-video)
- Breath editing: [Podcast Engineering School](https://podcastengineeringschool.com/the-debate-over-editing-out-breaths-vs-leaving-breaths-in)
- Sound-off viewing, Verizon Media and Publicis 2019: [3Play summary](https://www.3playmedia.com/blog/verizon-media-and-publicis-media-find-viewers-want-captions/)
- Platforms: [YouTube chapters](https://support.google.com/youtube/answer/9884579), [YouTube Shorts length and claims](https://support.google.com/youtube/answer/15424877), [TikTok ads video specs](https://ads.tiktok.com/help/article/video-ads-specifications), [Reels to 3 minutes](https://www.socialmediatoday.com/news/instagram-officially-expands-reels-length-3-minutes/737766/), [LinkedIn video specs](https://www.linkedin.com/help/linkedin/answer/a548372)
- YouTube loudness reference -14 LUFS, measured, not stated by YouTube (practitioner): [Meterplugs](https://www.meterplugs.com/blog/2019/09/18/youtube-changes-loudness-reference-to-14-lufs.html); quiet videos are not turned up: [Production Advice](https://productionadvice.co.uk/stats-for-nerds/)

## Done when

- The user approved the edit hash themselves, and every cut you flagged in step 3 was put to them.
- The user listened to an excerpt around the joins and accepted pace and sound; you did not judge it.
- `captions:place` was applied after the last reframe with no open finding the user has not accepted.
- Stills at speaker changes in every vertical or square format show the speaking face.
- Each requested format is rendered fresh and meets its profile; chapters, when asked, were approved; for delivery, `delivery --action check` passed.

Vork: `vork-3d-vfx`, `render-plate`.

[Optional audio contracts](../../docs/audio-integrations.md).
