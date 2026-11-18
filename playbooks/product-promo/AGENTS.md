# Product promo playbook

Last updated: 2026-11-17

For a 15–60 s launch or ad built around the real product. Teaching: [product-tutorial](../product-tutorial/AGENTS.md); news: [feature-update](../feature-update/AGENTS.md); a store page video, [app-store-preview](../app-store-preview/AGENTS.md); a teaser before the launch, [teaser-trailer](../teaser-trailer/AGENTS.md); a presenter ad, [ugc-ad](../ugc-ad/AGENTS.md); animation with nothing to sell, [motion-design](../motion-design/AGENTS.md); AI shots as the point, [ai-film](../ai-film/AGENTS.md); a montage from footage, [stock-montage](../stock-montage/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type motion-graphics --playbook product-promo --product <path>
pnpm film:next --project <id>     # repeat: do what it says
```

- Ask `intake` from `playbook.json` together; the real product source blocks start. `profiles` supplies placements, formats, lengths and captions; `starter` supplies blocks/style.
- 45 s or less: add `--profile promo` (pilot shot instead of an animatic: [promo profile](../../docs/production-chain.md#the-promo-profile-films-of-45-s-or-less)).
- Technique: `motion-graphics` by default; `--type ui-demo` when real screens carry most of the film, `--secondary ui-demo` when screens are one proof moment. `ai-video` only as the `ai-ad` variant. Types: [film types](../../docs/film-types.md).
- Footage, script, timings and proof supplied, only to assemble: the [product-ad workflow](../../docs/workflows/product-ad.md).

### Variants

| Variant | When | What changes |
|---|---|---|
| `ai-ad` | "AI ad", "ИИ реклама": generation is the technique | `--secondary ai-video` within an authorised `--max-cost-usd`; generated shots carry world, people or mood, the product stays captured; key frames and `refs:plan`/`refs:derive`/`refs:pack` inputs approved before video spend ([model-and-asset-production](../../.agents/skills/model-and-asset-production/SKILL.md)); TikTok's AI disclaimer recorded in the brief |
| `b2b-launch` | LinkedIn, B2B, SaaS for decision makers | `linkedin` profile first: square, 15–30 s, sound off with burned captions and an SRT; proofs are sourced numbers, named integrations and permitted logos; CTA a demo or trial |

## What good looks like

- **0–3 s:** the product, or its effect, is on screen by frame 90 and the proposition reads with sound off; no long intro or logo animation ([TikTok creative best practices](https://ads.tiktok.com/help/article/creative-best-practices)).
- **One proposition**, one sentence, true of this product only; every shot serves it or is cut.
- **The mechanism is the picture:** input becomes output, a state changes, a number moves, in the real interface or object, not a symbol.
- **At least one proof moment** a competitor could not film the same way, shown, not claimed.
- **Brand early and throughout,** not held back to the end ([Google ABCDs](https://business.google.com/en-all/resources/articles/abcds-of-effective-video-ads/): a modelled, correlational 30% lift in short-term sales likelihood).
- **Built for sound on,** cut to the track: [a film built on effects, without sound, is not a film](../../design-reference/creative-lessons.md).
- **Length by placement** (`profiles`). A 15 s cut-down tells the same proposition, not the first 15 s of the long one.
- **End card:** product name, one action and where, landing on a downbeat and held at least 2 s ([craft rules](../../design-reference/craft-rules.md)); no fade unless the script intends it.

## Method

Follow the [production chain](../../docs/production-chain.md); apply these promo rules.

1. **Intake and truth: get the mechanism.** `brief-collector` asks for the real product source up front; [real-ui](../../docs/real-ui.md) decides the route. No real material: ask, never draw a stand-in.
2. **Strategy: name the swap and the proofs.** `strategist` fills `strongestAlternative` and `productOnlyProofs`; each proof is a working claim that *looks like* something on screen ("the export finishes and the file opens"). Third-party platform behaviour an idea leans on is a claim too: verify or drop.
3. **Ideas: the first 2 s are a picture of the mechanism or its result,** not a question on a flat ground: the end state first, then rewind; the pain one beat before it resolves; a number changing (`before-after-split`, `type-number-race`).
4. **Music before words.** The user picks the track. `pnpm music:backtime --map <map.json> --film-sec <s> --end-card-frame <f> --fps 30` ranks start offsets so the end card lands on a downbeat; a planned silence must fall in a quiet bar.
5. **Script: one claim per beat, under reading time** ([craft rules](../../design-reference/craft-rules.md)). The CTA is a verb plus where. Skill [copywriter](../../.agents/skills/copywriter/SKILL.md); its formulas yield to the blacklist in [creative standards](../../design-reference/creative-standards.md).
6. **Material: capture first.** `pnpm capture:app` for web, computer use or the simulator for native, `pnpm asset:import` for supplied media; device shots through `ui-phone-hero`, `studio-product-stage` or `blender-plate` (skill [engine-selection](../../.agents/skills/engine-selection/SKILL.md)).
7. **Look and beat sheet: the product fills the frame in proof beats.** `ui-camera-read` at reading scale; `shared-element-carry` or `caused-morph` so a screen element becomes the next shot. Search `pnpm library:list --category ui` and `--category scenes` before new code (skill [motion-library](../../.agents/skills/motion-library/SKILL.md)).
8. **Pilot (promo profile): `motion-engineer` builds the proof moment,** not the logo. If it does not sell the mechanism in 3–6 s, the film will not.
9. **Sound: hit the product's actions.** A tap, a send, a lock, a counter each get a sound of their material (`pnpm sfx:cues`); the proof moment gets the cleanest sync point (skill [sound-design-and-mix](../../.agents/skills/sound-design-and-mix/SKILL.md)).
10. **Formats and cut-downs:** vertical first, text and CTA inside each profile's safe zone, `pnpm render --project <id> --format <f>` per format, frames looked at, then [delivery](../../docs/delivery.md) (skill [qa-and-delivery](../../.agents/skills/qa-and-delivery/SKILL.md)).

Ad stills: Marketing Studio and Ads Studio at Higgsfield (`fal:find --provider any --task "ad creative"`); price them against fal with `models:compare`. Third-party footage needs `film:rights`.

## Tools

`blender:assets`: 3D picks.

| Tool | Why in a promo |
|---|---|
| `ui-camera-read`, `ui-phone-hero`, `studio-product-stage`, `scene-product-reveal` | Proof beats at reading scale |
| `shared-element-carry`, `caused-morph` | Product carries the cut |
| `before-after-split`, `type-number-race`, `type-hero-word` | A result as a change; the proposition as type |
| `scene-end-card`, `music:backtime`, `sfx:cues`, `sfx:generate` | A restrained close on a downbeat; the product's actions sounded |

## Anti-patterns

- A generic UI kit or abstract shapes standing in for the product.
- A logo sting before anything happens; the product first seen at 10 s.
- Features one per card, claimed, none shown working.
- A proposition that survives swapping in the strongest alternative's name.
- UI small in a floating window on an empty ground.
- The end card fading out, off the beat, or with three CTAs.

## References

- Platform rules behind `profiles` (opened 2026-11-13): TikTok [video ad guide](https://ads.tiktok.com/business/en/guides/video-advertising-guide) (21–34 s best, hook in 3 s), [ad specs](https://ads.tiktok.com/help/article/video-ads-specifications) (safe-zone files), [ad disclaimers](https://ads.tiktok.com/help/article/about-ad-disclaimers-in-tiktok-ads-manager?lang=en) (AI-generated media mandatory); Meta [Reels ads guide](https://www.facebook.com/business/ads-guide/update/video/instagram-reels) (14% top, 35% bottom, 6% sides; no licensed music) and [Reels ads API](https://developers.facebook.com/docs/marketing-api/creative/reels-ads); Google [Shorts ads](https://support.google.com/google-ads/answer/16041697?hl=en) (10–30 s action ads, sound +20% conversions) and [video ad formats](https://support.google.com/google-ads/answer/2375464) (skip at 5 s, under 3 min); [LinkedIn video ad specs](https://www.linkedin.com/help/lms/answer/a424737) (15–30 s, loops under 30 s, SRT); [X Ads API creatives](https://docs.x.com/x-ads-api/creatives) (16:9 and 1:1 cards, 10 min); [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay) (muted autoplay only); [Wistia, State of Video 2024](https://wistia.com/learn/marketing/insights-state-of-video-report).
- Study for method (titles only, no frames): Apple product films; Linear release films; Arc launch films ([Off-Menu](https://offmenu.substack.com/p/three-reasons-arcs-launch-video-went)).
- Hook and hold rates are agency benchmarks, not platform figures: about 23% hook in Meta feed, 30% in Reels ([Jetfuel, 2026](https://jetfuel.agency/creative-performance-metrics-for-dtc-video-ads-hold-rate-thumbstop-and-thruplay-benchmarks-2026/)); they judge the published ad.
- **Benchmark observations** (four proxy runs of one brief, stopped at the script; not confirmed lessons): naming the strongest alternative and product-only proofs raised distinctiveness 0.7–0.9 for all judges and swap passes from 1/15 to 8/14; a category scan showed no gain; plain chat UI on flat grounds did not arrest at feed size; no 30 s cue ended on a downbeat until backtimed.

## Done when

- By frame 90, with sound off, the product or its effect and the proposition are on screen.
- Every claim on screen traces to a `working` claim in `product-truth.json` and is shown in the real product.
- Every product screen passes the [real-ui](../../docs/real-ui.md) side-by-side check.
- The end card lands on a downbeat, holds 2 s or more, names one action and where, inside each profile's safe zone.
- Every format and cut-down is rendered and looked at; delivery `--action check` passes; an `ai-ad` carries its AI disclosure.
- User saw pilot/final; report unchecked parts.

Product brand assets: [guide](../../docs/icon-resources.md).

Blender: [arsenal](../../blender-arsenal/AGENTS.md).

Vork: `vork-3d-vfx`, `render-plate`.
