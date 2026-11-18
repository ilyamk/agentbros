# Shorts from a long recording playbook

Last updated: 2026-11-15

Choose it when the user wants shorts, reels or clips cut out of their own long recording (talk, podcast, interview, lesson, stream). Editing the whole recording as one film is [footage-edit](../footage-edit/AGENTS.md).

## Start

```bash
pnpm project:new --project <id>          # the source project; the recording goes in public/projects/<id>/assets/footage/
pnpm footage:next --project <id> --playbook shorts-from-long --source <file> --goal recut,captions,vertical,shorts --formats <from profiles> --shorts-brief "<who the shorts are for>"
pnpm footage:next --project <id>         # repeat, doing what it returns
```

`footage:next` builds the recut first, places captions and crops on it, then goes straight to the shorts; the whole recut's render is only offered at the end, for a user who also wants it. Steps, flags and approvals: [footage editing](../../docs/footage-editing.md); choosing clips: [shorts selection](../../.agents/skills/recording-recut/references/shorts-selection.md); the series: [shorts series](../../docs/workflows/shorts-series.md). Ask the `intake` questions in `playbook.json` in one message; per-platform facts are its `profiles`.

| Variant (`variants`) | What changes |
|---|---|
| `webinar` (webinar, stream) | Step 2 also cuts setup and Q&A waits; screen-led clips go square or keep a static crop; step 9 adds chapters and a summary clip |
| `podcast-clips` | `--speakers N`; a clip holds the question and the whole answer; the crop follows the speaker map or angles |

## What good looks like

- **Hook inside 3 s.** The clip's own first sentence stops the scroll: a question, a number, a contrarian claim, a conflict. `shorts:rank` enforces that the hook sentence starts within 3 s. TikTok ad data: 63% of top click-through videos state the key message in 3 s (ads, a correlation).
- **Stands alone.** A stranger understands it with no episode context: no "he", "that", "as I said" pointing outside the range.
- **Ends on the payoff.** The last sentence is the answer, the punchline or the turn, not the explanation after it.
- **Length set by the destination** (`profiles`), through `shorts:prepare --min-sec/--max-sec/--hard-max-sec` (default 20/60/90):
  - YouTube Shorts: vertical or square up to 3 min since 15 October 2024; a Short over 1 min with any copyright claim is blocked worldwide, so keep clips with third-party music at 60 s or less.
  - Instagram Reels: up to 3 min since January 2025.
  - TikTok: Creator Rewards pays only for videos over 1 min. Buffer (1.1 million TikToks): median watch 6.9 s at 30–60 s, 11.3 s at 1–10 min; length only when the story needs it.
- **Loops cleanly.** The last word is followed by 150–300 ms (house rule) and a hard end, no fade: since 31 March 2025 every replay counts as a Shorts view.
- **Captions** pass the checks in [caption styles](../../docs/captions-styles.md) in every short, not only on the recut.

## Method

1. **Brief in one message.** Who the shorts are for, which platforms, how many, whether any will be monetised on TikTok (then over 60 s), and whether the recording carries third-party music (then 60 s or less for YouTube). The answers become `--shorts-brief` and the length flags; with `shorts:prepare` add `--count` for more than five.
2. **Recut first, with short-form pace.** Shorts may cross the recut's pause, filler and retake cuts, so tighten once for all of them: give `footage:next` `--mid-pause-ms 250 --sentence-pause-ms 300` (saved, and repeated in every `recut:plan` it prints). Without the `recut` goal every pause stays, which drags in a short. Rules for that review: [footage-edit](../footage-edit/AGENTS.md).
3. **Captions and crop on the recut.** Episodes are sliced from the recut's timeline and keep its caption style, crop path and the placement `captions:place` measured, moved to each short's clock; a short's first page may regroup, so check it in each short (step 7). For shorts choose a style that reads in motion: `outline-pop`, `italic-shadow`, `keyword-colour` or `single-punch` for the hook-heavy kind ([choice table](../../.agents/skills/captions-and-localization/references/caption-styles.md)).
4. **Write candidates as an editor** (the `agent-task` that `footage:next` returns). Read every chunk, then write two to three times as many candidates as the shorts wanted, so ranking has a choice. Look for:
   - a story with an ending; a claim against common sense followed by its reason; a question answered in full; a number with its meaning; a disagreement between two speakers; a strong reaction;
   - a range whose first sentence works as a hook on its own. If the best line sits mid-answer, start there only when what follows stands alone. Never splice it in front: one contiguous range of whole sentences, in order;
   - an ending that returns to the opening question, so the loop reads as a restart rather than a jump.
   Score the six axes honestly with verbatim quotes, and use the vetoes (`needsSetup`, `endsBeforePayoff`, `claimOutOfContext`) rather than a low score.
5. **Rank and repair.** `shorts:rank` with the speech mask. For each rejection ("starts in running speech", a cut removes a quoted word, a protected span split) choose another first or last sentence; do not argue with the check.
6. **The user chooses.** Show `proposals.md`; the user watches each range. Their approval goes through `shorts:request --approved-by` in their own words, at least two clips. Never pick for them.
7. **Create, render, check each short.** `video:workflow --scenario shorts-series` (plan, then create), then a vertical `render --timeline` per episode. Look at stills of each short's first second, a page change and last frame: the first page starts on the clip's first word, captions clear the face, the last frame is the thumbnail. If a page is still off, do not edit the episode (an edited episode journal fails the series render guard): show the user the still.
8. **Learn the user's taste.** After the user has rated ten clips 1–5, `shorts:calibrate` sets the project's threshold.
9. **Webinar extras.** Chapters for the full replay: export the recut's SRT with `captions:export --timeline` and pick topic starts from its times (at least three, first at 00:00, each 10 s or longer, YouTube help); no command writes them. A summary clip of several moments is a hand-written `recording-edit` request whose `keepSpans` stay chronological (no reordering exists), planned with `video:workflow --scenario recording-edit --action plan` and approved by edit hash like any recut.

## Tools

| Tool | Why here |
|---|---|
| `shorts:prepare`, `shorts:rank` | Reviewed candidates, protected spans and scores; [local analysis](../../docs/local-macos.md) |
| `shorts:request`, `video:workflow --scenario shorts-series`, `shorts:calibrate` | The user's approval and series request; one project per short; threshold from ratings |
| `recut:plan`, `captions:place`, `reframe:track`, `timeline:edit` | The tightened, captioned, vertical recut the shorts are cut from |
| Library `captions` | Burned caption presets |
| Skills `recording-recut`, `captions-and-localization`, `ugc-content-creator` | Selection and truth rules, caption choice, hook and platform craft |

## Anti-patterns

- Clips that open on context ("So, as I was saying") and reach the point at 15 s.
- Splicing a strong line from later in front of the clip, or cutting a caveat to make a claim punchier: it puts words in the speaker's mouth, and `shorts:rank` rejects it.
- Ending on the explanation after the punchline, or on a fade.
- Every short the same length.
- Ranking against the uncut project when shorts come from the recut.
- Filling `--approved-by` or `--ids` yourself, or calling a clip engaging: the user judges.
- Re-uploading one platform's export to another with its watermark: Instagram does not recommend Reels with other apps' logos.

## References

- YouTube Help, three-minute Shorts and the claim rule: [support page](https://support.google.com/youtube/answer/15424877?hl=en)
- YouTube Shorts view counting from 31 March 2025 (plays and replays; engaged views kept): [Tubefilter](https://www.tubefilter.com/2025/03/26/youtube-shorts-views-counting-stats/)
- Instagram three-minute Reels, January 2025: [Lindsey Gamble](https://lindseygamble.com/blog/instagram-three-minute-reels); other apps' logos not recommended: [Social Media Today](https://www.socialmediatoday.com/news/instagram-clarifies-including-your-own-logo-on-a-reel-is-ok/730852)
- TikTok Creator Rewards, videos over one minute: [Engadget](https://www.engadget.com/tiktok-to-creators-make-longer-videos-get-paid-055013923.html)
- Buffer, 1.1 million TikToks by length, March 2025: [article](https://buffer.com/resources/longer-tiktoks-get-more-views-data/)
- TikTok Auction Ads Creative Tips, key message in the first 3 s: [PDF](https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf)
- Podcast clip selection, rules of thumb from a practitioner blog (standalone test, enough setup for the payoff, 30–75 s start range): [Bytecap](https://www.bytecap.io/blog/how-to-turn-podcast-into-shorts-reels-tiktoks-2026)
- Platform specs: [TikTok ads video specs](https://ads.tiktok.com/help/article/video-ads-specifications) (9:16, to 10 min), [LinkedIn video](https://www.linkedin.com/help/linkedin/answer/a548372) (3 s–15 min, 1:2.4–2.4:1), [YouTube chapters](https://support.google.com/youtube/answer/9884579)

## Done when

- The user approved the recut's edit hash and each short by id, in their own words.
- Every short has its hook sentence within 3 s, ends on its payoff and is inside the length band of each platform it is meant for.
- Stills of every short's first second, a page change and the last frame show captions clear of the face and the platform interface.
- The user listened to each short's first and last second and accepted the edges; you did not judge them.
- Each episode was rendered with `--timeline` from its own project; the series commit marker exists.
- For a webinar: chapters and the summary clip, when asked, were approved by the user.
