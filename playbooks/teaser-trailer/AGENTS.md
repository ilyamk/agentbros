# Teaser and trailer playbook

Last updated: 2026-11-17

Choose for a 6–60 s teaser/trailer building anticipation before release (product, event, course, channel or countdown), ending on a title, date and where. Released product: [product-promo](../product-promo/AGENTS.md); animation without an announcement: [motion-design](../motion-design/AGENTS.md); filmed recap: [event-recap](../event-recap/AGENTS.md); montage without reveal: [stock-montage](../stock-montage/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type motion-graphics --playbook teaser-trailer --profile promo --product <path>
pnpm film:next --project <id>     # repeat: do what it says
```

- `--profile promo` for 45 s or less ([promo profile](../../docs/production-chain.md#the-promo-profile-films-of-45-s-or-less)); drop it for 46–60 s.
- Technique by material ([film types](../../docs/film-types.md)): `motion-graphics` by default; `--type footage` when real event, venue or course footage carries the film; `--secondary ai-video` only for an essential mystery shot nothing else can make, within an authorised budget.
- `--product`: the brief, the logo SVG, product files or renders; never the music.
- Ask intake via `pnpm playbook --id teaser-trailer`. Date and where block start: never invent or round them.

## What good looks like

- **Withholding is the craft.** A teaser raises a question and answers only part of it; a trailer answers more but keeps the payoff. Film Editing Pro (rule of thumb): teasers run in two acts, set-up then one set piece, holding back most story; trailers in three, building to the biggest moment ([Film Editing Pro](https://www.filmeditingpro.com/?p=12926)).
- **Withheld means hidden, never faked.** An unreleased product appears as crops, details, a silhouette or under a light sweep of the real thing. An invented interface or object breaks [real-ui](../../docs/real-ui.md).
- **Escalation to the title.** Cold open or hook, build, drop, title, optional button (Lieu's breakdown, via [Elwyn](https://jonnyelwyn.co.uk/film-and-video-editing/how-to-edit-a-movie-trailer/), rule of thumb). Shots shorten into the drop; a rest or silence before the last hit makes it land.
- **A hook, not a logo.** TikTok asks for the hook in the first 3 s and no long logo intro ([TikTok guide](https://ads.tiktok.com/business/en/guides/video-advertising-guide)); Steam warns a viewer may give it under 10 s ([Steamworks trailers](https://partner.steamgames.com/doc/store/trailer?l=english)).
- **Music is the structure.** Editors pick the cue before cutting (Cartlich, via Elwyn); a short cut keeps the cue's opening and climax and edits the middle (Film Editing Pro).
- **The date card works muted.** Steam asks that a trailer be understood without audio. Hierarchy on the end card: name largest, then the action and the date, then platforms (Cauller, [Game Developer](https://gamedeveloper.com/business/salvage-your-game-trailer), rule of thumb). One action and one where, out of the bottom 35% on Reels ([Meta](https://developers.facebook.com/docs/marketing-api/creative/reels-ads)).
- **Final frame:** the date card, complete and unfaded; a button comes before it or returns to it.

## Method

Follow the [production chain](../../docs/production-chain.md); apply these teaser rules.

1. **Intake: the reveal and its limits.** `brief-collector` records the date, time zone and where verbatim, what may be shown and what exists. Unreleased facts enter `product-truth.json` only as claims the user approved.
2. **Strategy: one question the film plants.** `strategist` names it ("what lights up?", "who is speaking?") and the single answer the title card gives. The proposition is the reveal, not a feature list.
3. **Ideas: plan the withholding.** Each idea states what is seen whole, what in part, what never, and in which beat the whole appears (usually only on or after the title). Openers: a real detail in extreme close-up, a word decoding into a name, a sound before a picture (blocks under Tools).
4. **Music first, then the shape.** The user chooses by ear. On a stock route `sound-director` searches for a cue built like a trailer (`pnpm music --action search` with `--drop-at <s> --intro quiet --ending hard`). Map it (`pnpm audio:map --input <cue> --output <map.json> --stems`), draft slots with `pnpm edit:plan --map <map.json> --style punchy` (`flurry` only when the drop is the subject), then `pnpm music:backtime --map <map.json> --film-sec <s> --end-card-frame <f> --fps 30` so the title card lands on the downbeat or the final hit. The planned rest before the drop must sit in a quiet bar of the map, not its loudest.
5. **Script: few words, each a beat.** Teaser copy is three to six cards: the question, one or two escalating lines, the name, the date and where (skill [copywriter](../../.agents/skills/copywriter/SKILL.md); holds from [craft rules](../../design-reference/craft-rules.md)). Course or channel trailer: say who it is for, what they get, how often, then subscribe or enrol (YouTube's channel-trailer advice: show, don't tell).
6. **Material: real only.** `pnpm capture:app` for a product screen, `pnpm asset:import` for renders, logos and footage (with its owner's licence); a shot needing real light: skill [engine-selection](../../.agents/skills/engine-selection/SKILL.md).
7. **Beat sheet: escalate in library blocks** (Tools), every shot in `film-finish`. `motion-director` shortens shots into the drop; `film:targets` sets their variety; carries per [carry and rhythm](../../.agents/skills/motion-and-typography/references/carry-and-rhythm.md). `pnpm library:list --category kinetic|typography|transitions|effects` before new code (skill [motion-library](../../.agents/skills/motion-library/SKILL.md)).
8. **Pilot (promo profile): build the drop into the title,** the 3–6 s that decide the film, not the opening.
9. **Sound: risers end on the hit.** `pnpm sfx:synth --project <id> --kind riser --length-frames <n> --key <key>` sizes the riser so its end lands on the cue frame; `hit` and `sub-drop` in the track's key on the title; block cues via `pnpm sfx:cues`; hits lead by `edit:snap`. Silence before the title is a sound decision (skill [sound-design-and-mix](../../.agents/skills/sound-design-and-mix/SKILL.md)).
10. **Formats and cut-downs:** design vertical first; a 6 s bumper is its own edit (one mystery shot, one hit, title and date), not the first 6 s. Render each with `pnpm render --project <id> --format <f>`, check `pnpm motion:strip --input <mp4> --output <jpg> --phone`, then [delivery](../../docs/delivery.md).

Recast: `models:pick --use-case replace-person`, `model:prepare` ([modes](../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow)), which compiles the markers, approved cards, `film:rights --preparation ID`; sources: `motion:library`; keep material/spend gates.

## Tools

| Beat | Blocks and commands |
|---|---|
| Mystery | `kinetic-decode`, `type-scramble-hero`, `focus-pull`, `light-rays`, `spotlight-studio` |
| Build, drop | `snap-zoom`, `ground-swap-cut`, `speed-ramp-flurry`, `zoom-through`; `light-burn`, `flare-pulse`, `type-impact-slam` |
| Title, date | `type-hero-word`, `type-odometer-stat`, `type-word-pulse`, `scene-end-card` |
| Sound | `music`, `audio:map`, `edit:plan`, `music:backtime`, `sfx:synth`, `sfx:cues`, `sfx:generate`, `edit:snap` |
| Generated shot | `refs:profiles`, `refs:plan`, `refs:derive`, `refs:pack`: inputs planned and packed, markers compiled, before any paid request (`reference-preparation`) |

## Anti-patterns

- A stand-in: an invented device, UI or venue because the real one is secret. Hide the real one instead.
- Everything revealed, then "coming soon".
- Logos first, or a slow fade-in before the hook.
- Flat energy: one shot length throughout, or a drop with nothing after it.
- A date that is vague ("soon", "this autumn") when the user gave one, or one with no time zone for an online launch.
- Three CTAs; the date in the Reels bottom band or fading out.
- A riser missing its hit; a hit on every cut.

## References

- Structure: [Film Editing Pro, trailers, teasers and promos](https://www.filmeditingpro.com/?p=12926) (2017); [Elwyn, how to edit a movie trailer](https://jonnyelwyn.co.uk/film-and-video-editing/how-to-edit-a-movie-trailer/) (2019, quoting Derek Lieu's five parts and Paul Cartlich on music first); [Cauller, Game Developer](https://gamedeveloper.com/business/salvage-your-game-trailer) (2016). Rules of thumb. Shot-by-shot reveal breakdowns: [Derek Lieu's blog](https://www.derek-lieu.com/blog).
- Platforms: [TikTok video ad guide](https://ads.tiktok.com/business/en/guides/video-advertising-guide); [Meta Reels ads](https://developers.facebook.com/docs/marketing-api/creative/reels-ads); [YouTube Shorts length](https://support.google.com/youtube/answer/15424877?hl=en); [Google Ads video formats](https://support.google.com/google-ads/answer/2375464?hl=en) (bumper 5–6 s); [LinkedIn video ad specs](https://www.linkedin.com/help/linkedin/answer/85306); [Steamworks trailers](https://partner.steamgames.com/doc/store/trailer?l=english).
- Channel trailer: [YouTube Help, channel layout](https://support.google.com/youtube/answer/3219384?hl=en) (non-subscribers only, shown once); [YouTube blog, 2013](https://blog.youtube/news-and-events/convert-viewers-into-subscribers-with/) (an ad for the channel; show, don't tell; shorter is better).
- Launch teasing: Nothing's staged pre-launch reveals of design details, months ahead ([Android Authority, 2022](https://www.androidauthority.com/nothing-hype-3186033/)).
- Flashes: [WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html), measured by `src/lib/sensors/flash.ts`.

## Done when

- The date, time zone and where on the title card match the intake answer exactly and read with sound off.
- Every partial shot is of real material; the whole thing appears only where the plan said.
- The title card lands on the downbeat or final hit (`music:backtime`), the rest before it falls in a quiet bar, and each riser ends on its hit frame.
- The motion plan's shots shorten into the drop; `film:measure` reports no `FLASH_RISK` (at most three flashes a second).
- Every format and cut-down (including a 6 s bumper when asked) is rendered and looked at; delivery `--action check` passes.
- The user saw the pilot and the final; you said what you did not check.
