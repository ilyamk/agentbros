# UGC ad or testimonial playbook

Last updated: 2026-11-17

Choose it when a person on camera (the user, a hired creator or a real customer) talks about a product in a native, creator-style vertical video meant to sell it, organic or paid. A recording cut with nothing to sell is [footage-edit](../footage-edit/AGENTS.md); a promo with no person, built in motion design, is [product-promo](../product-promo/AGENTS.md); clips out of a long talk are [shorts-from-long](../shorts-from-long/AGENTS.md). A customer interview built into a story is [case-study](../case-study/AGENTS.md).

## Start

```bash
pnpm project:new --project <id>      # the recording goes in public/projects/<id>/assets/footage/
pnpm footage:next --project <id> --playbook ugc-ad --source <file> --goal recut,captions,vertical
pnpm footage:next --project <id>     # repeat, doing what it returns
```

The cut itself is the [footage-edit](../footage-edit/AGENTS.md) method and [footage editing](../../docs/footage-editing.md); this file adds the ad structure, the inserts and the disclosure. Ask the `intake` questions of `playbook.json` in one message first.

**No footage yet:** the deliverable is a brief for the creator, not a film (variant `creator-brief`, Method step 1). **No person:** a generated presenter is [avatar-presenter](../avatar-presenter/AGENTS.md) (draft), never a testimonial: one by a person who does not exist is unlawful in the US (FTC rule 16 CFR 465). Say so.

## What good looks like

- **Native, not produced.** One person, a phone-camera look, eye contact, a real room; TikTok asks for a "DIY or not overly polished look" with creators, employees or customers on camera. Creator-partnered ads had 83% higher engagement in TikTok's 2022 EU study.
- **Hook, problem, product in use, proof, CTA**, in the speaker's own words (15/30/60 s skeletons in the [ugc-content-creator](../../.agents/skills/ugc-content-creator/SKILL.md) skill, reference only). The hook lands in the first 3 s and the proposition is named or shown there too (TikTok); no logo intro.
- **The product is seen working**, in hand or on its real screens.
- **Honest.** Every claim is the speaker's experience; nothing is spliced to say what they did not say; a material connection is disclosed from the first second.
- **Readable muted**; one CTA, said and shown.

## Method

1. **Footage or brief.** If no takes exist, write the creator brief into `public/projects/<id>/pipeline/` and stop there: 3-5 hooks and a 15, 30 or 60 s script with the `copywriter` and `ugc-content-creator` skills; a shot list, room tone and recording spec in `pipeline/craft/recording-guide.json` with `recording-guide` (vertical, eye-level, the product action wide and close, one full take per hook); delivery notes with `directing-and-performance`; usage rights; the disclosure said to camera in the first seconds when there is a material connection. A customer gets questions, never lines.
2. **Pace for the feed.** `footage:next --mid-pause-ms 250 --sentence-pause-ms 300`, footage-edit's vertical pace. `--punch-in 1.1` only if the source is not already enlarged near 2x by the vertical crop.
3. **Cut to the structure, never rewrite it.** Read `recut-plan.md` against the five beats: the opening must reach the hook within 3 s, so a slow first sentence goes with `recut:plan` cuts, not by moving a later sentence forward (the workflow does not reorder). If the take has no hook in its first seconds, ask for a pickup take rather than splicing one on. Keep the beat after the proof, the CTA and a spoken disclosure whole: flag any cut touching them and propose `--reject`.
4. **Hook variants** (variant `hook-variants`): one source project per full take (`project:new --project <id>-hook-b`, then `footage:next --project <id>-hook-b --playbook ugc-ad --source <take>`), the same pace flags, one render each.
5. **Inserts over the speech.** Real product screens: `capture:app` ([real-ui](../../docs/real-ui.md)), registered with `asset:import --metadata` whose rights say `commercialAllowed: true` with licence and `checkedAsOf`, then `media:ingest` with tags and `media:broll` with `"usage": "advertising"`, which refuses anything else ([analysis and B-roll](../../.agents/skills/recording-recut/references/analysis-and-broll.md)). Start it on the word it illustrates; the face returns for proof and CTA.
6. **Captions.** `outline-pop` or `italic-shadow` (profiles in `playbook.json`; [caption styles](../../.agents/skills/captions-and-localization/references/caption-styles.md)), `keyword-colour` to land the product name. `captions:place --format vertical` after the reframe, applied with `timeline:edit`. For a paid ad (intake 3), `footage:next --placement ad` (`--platform` for one) makes `captions:place` clear the ad interface.
7. **On-screen text hook and end card.** `timeline:edit` `add-overlay`, dry run first ([overlays](../../docs/timeline-edit.md)): a typography block such as `type-hero-word`, ground `transparent`, from 0 to about 3 s, `above-captions`. A headline on every beat, a sourced proof claim and an end card: the `product-ad` workflow alternative in `playbook.json` ([product-ad](../../docs/workflows/product-ad.md)).
8. **Disclosure.** From intake question 2: a material connection gets "Ad" or "Paid partnership" upfront in the video, seen and heard (FTC): the speaker says it in the first seconds and the burned captions show it; if the take lacks it, ask for a pickup or add it as an overlay (step 7). Plus the platform label (TikTok commercial content disclosure, Instagram Paid partnership, YouTube paid promotion). ASA/CAP wants it at the start; "#sp", "gifted" or "collab" alone fail. The user turns the labels on.
9. **Sound.** Speech first; ad music only from TikTok's Commercial Music Library or with licence evidence. Agents cannot hear: the user listens to a `render --frames` excerpt of the opening 5 s and the CTA.
10. **Render and hand over.** `render --timeline` per variant, `captions:export` when the platform's own captions are used instead, then `delivery` snapshot and check ([delivery](../../docs/delivery.md)).

## Tools

| Tool | Why here |
|---|---|
| `footage:next`, `recut:plan`, `reframe:track`, `captions:place`, `timeline:edit` | The cut, crop and creator captions, as in footage-edit |
| `capture:app`, `asset:import`, `media:ingest`, `media:broll` | Real product screens as inserts with advertising rights |
| Skills `ugc-content-creator`, `copywriter`, `recording-guide`, `directing-and-performance` | Hooks, script, shot list and delivery before the shoot |
| `refs:profiles`, `refs:plan`, `refs:derive`, `refs:pack` | Only a generated insert with no person in it (a product or place shot): its inputs packed and approved before spend (`reference-preparation`) |

## Anti-patterns

- Polishing it into a commercial: logo sting, studio grade, motion titles.
- Splicing one take's hook onto another's body; a cut that makes a claim stronger.
- A testimonial read from a script, or a result shown as typical without evidence.
- Disclosure only in the description, the bio or the last frame; relying on "#sp", "gifted" or a platform label alone.
- In a paid ad, a sound outside the Commercial Music Library or without licence evidence; captions or CTA under the ad's bottom interface.
- A generic mock-up for the real app; B-roll without commercial rights.
- Generating a person to fill in for missing footage.

## References

- TikTok Ads, Creative best practices (hook in 6 s, proposition in 3 s, DIY look, 3-5 creatives per ad group): [help](https://ads.tiktok.com/help/article/creative-best-practices)
- TikTok for Business, Video advertising guide (21-34 s for most ads, hook in the first 3 s, Commercial Music Library): [guide](https://ads.tiktok.com/business/en/guides/video-advertising-guide)
- TikTok, Video ads specifications (in-feed up to 10 min, Spark Ads, safe-zone templates): [help](https://ads.tiktok.com/help/article/video-ads-specifications); commercial content disclosure: [help](https://ads.tiktok.com/help/article/about-the-content-disclosure-setting-for-creators)
- TikTok, creator collaborations study, 2022 (2,800 ads, 5 EU markets): [blog](https://ads.tiktok.com/business/en-US/blog/brand-collaborations-tiktok-creators-drive-big-results)
- Meta, Reels Ads Guide, 2025, via a secondary [summary](https://www.websitebuilderexpert.com/news/meta-updates-reels-ads-guide/); [partnership ads](https://creators.instagram.com/blog/introducing-partnership-ads)
- YouTube Help, Paid product placements and endorsements: [help](https://support.google.com/youtube/answer/154235); Shorts up to 3 min: [help](https://support.google.com/youtube/answer/15424877)
- FTC Endorsement Guides (revised 2023; visual and audible disclosure for video): [FTC](https://www.ftc.gov/business-guidance/resources/ftcs-endorsement-guides); Disclosures 101 for influencers: [FTC](https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers)
- FTC rule on consumer reviews and testimonials, 16 CFR 465, effective 21 October 2024 (bans testimonials by people who do not exist, AI-generated, or without real experience): [press release](https://www.ftc.gov/news-events/news/press-releases/2024/08/federal-trade-commission-announces-final-rule-banning-fake-reviews-testimonials)
- ASA/CAP, Recognising ads: social media and influencer marketing (updated 2026): [AdviceOnline](https://www.asa.org.uk/advice-online/recognising-ads-social-media.html); Influencers' guide 2023: [PDF](https://www.asa.org.uk/static/790d2e01-e3f8-4fea-b3c99ef91a9f04dc/Influencerguidance2023v4-FINAL.pdf)
- 15-60 s band and pace flags: house rule, starting point

## Done when

- The intake was answered; a material connection has its disclosure in the video and the user confirmed the platform label.
- The user approved the edit hash; the hook lands in the first 3 s without splicing; every claim is the speaker's own.
- Inserts are the real product with advertising rights recorded; captions clear the placement's interface (`captions:place`, `--placement ad` for ads); an on-screen CTA is checked on the ad's safe-zone template.
- The user listened to the opening and the CTA; each variant is rendered fresh and `delivery --action check` passed.
- Not yet covered: TikTok's anchor (product link) ad template; overlays are not checked against ad bands. No benchmark project exists yet.
