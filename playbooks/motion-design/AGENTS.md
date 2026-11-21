# Motion design film playbook

Last updated: 2026-11-20

Idents, lyrics, abstract/collage. Ads: [product-promo](../product-promo/AGENTS.md); teach: [explainer](../explainer/AGENTS.md); AI: [ai-film](../ai-film/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type motion-graphics --playbook motion-design --product <path>
pnpm film:next --project <id>          # repeat: do what it says
```

`--product` is optional: the film's material (the mark as SVG, lyrics or copy as `.md`, a brand guide); omit it for an abstract piece (`productName` is then `none`: [brief-collector](../../.agents/agents/brief-collector.md)). Never the music (a media file makes film:init suggest a footage route); the track enters at the music step. Mixed media: `--type collage`, same flags.

## What good looks like

Variants ([playbook.json](playbook.json) `variants` says what each changes; ask when unclear):

| Variant | Length | The bar |
|---|---|---|
| `logo-ident` | 3–5 s; 1–2 s social sting | The mark arrives through one idea and ends complete, still, on the final downbeat |
| `kinetic-type` | the quote or voiceover | Each word lands on its beat or syllable, readable; treatment changes with meaning |
| `lyric-video` | the track | One sung line at a time, each word on its syllable from the user's timed lyric sheet |
| `title-sequence` | 30–90 s | Names read at speed in one consistent world, each held for its reading time |
| abstract, music-driven (no variant) | the track | Structure follows the map's sections; one motif varied |

Platforms: `profiles` in playbook.json. No burned captions: the type is the picture.

Across all kinds:
- The sync map shows no `miss`; shot lengths vary (`film:targets`) with at least one planned rest.
- Moving text keeps ≥ 4.5:1 contrast with its ground ([WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)); the 3:1 large-text allowance is not used, because blur and compression soften edges.
- At most 3 flashes in any second over 11% of the frame ([WCAG 2.3.1](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html)): `pnpm flash:check --render <mp4>` and `film:measure` report each `FLASH_RISK` range.
- The last frame is complete, readable and unfaded; a loop piece's last frame matches its first.

## Method

1. **One idea, as a verb.** The mark *assembles*, the line *breaks*, the field *gives way*. Fixed at the ideas step ([motion decisions](../../.agents/skills/motion-and-typography/references/motion-decisions.md)). A mark is the user's own vector, never redrawn (intake).
2. **Music first.** The user chooses the track by ear. Map it (`pnpm audio:map --input <track> --output <map.json> --stems`), read its grid trust, draft slots with `pnpm edit:plan --map <map.json> --style calm|punchy|flurry`: calm for luxury and contemplative pieces, punchy by default, flurry only when the drops are the subject. Fit the end with `music:backtime`.
3. **One look.** Choose `pnpm library:list --styles`; hold the starter's restraint or maximalism across shots. Data uses `viz-scene`: `pnpm viz:list`, `viz:prepare` source-backed JSON, `viz:preview` every format, revision-checked `viz:mount`, then `viz:check`. Events set holds. Three and Blender share [one plan](../../docs/visualisations.md).
4. **The principles, applied to type and shapes.** Numbers are in [craft rules](../../design-reference/craft-rules.md); this is when each principle applies.

| Principle | On type and shapes | Carried by |
|---|---|---|
| Timing and spacing | Frames bunched at the end land, at the start launch | `motion:strip --diff` |
| Slow in, slow out | Always; linear only for drift, rotation, progress | `track` curves |
| Anticipation | 2–4 f (house rule) against the move before a slam or a launch | `type-impact-slam`, `track` |
| Squash and stretch | Only for rubber, paper, liquid; never a premium or editorial face | `type-glyph-spring` |
| Follow-through, overlap | Letters and words settle after the line; nothing stops all at once | `stagger`, `kinetic-headline-build` |
| Arcs | Shapes and marks travel on arcs; type travels straight, or reads badly | `kinetic-path-travel` |
| Staging | The eye knows where to look before anything moves | `camera` blocks, `focus-pull` |
| Exaggeration | Once per film, on the biggest hit | `type-hero-word` scale keys |
| Solid drawing | One consistent depth and light across shots | `parallax-rig`, `three`, engine-selection |
| Pose to pose, straight ahead | Keyframed builds (GSAP seeked to the frame); procedural motion from `random(seed)`, `@remotion/noise` | `kinetic`, `particle-assemble` |

5. **Easing by feeling.** Per element, not one curve per film. Material 3 times interface moves at 50–1000 ms: read type sits at its long end and beyond, interface-like changes at 250–400 ms.

| Feeling (house rules) | Arrival | Duration (30 fps) | Overshoot |
|---|---|---|---|
| Calm, luxury | sine or expo in-out | 24–36 f | none |
| Confident, editorial | expo out, hard stop | 12–18 f | none |
| Playful | spring `pop` (craft rules) | to settle | 5–15% |
| Aggressive | snap with blur, anticipation | 4–8 f | 3–8% |
| Mechanical, digital | linear or stepped on twos, on sixteenths | per step | none |

6. **Holds are planned.** A landing holds for its reading time, then leaves faster than it came; the long rest sits on the map's break.
7. **Rhythm.** Structural cuts on downbeats and section starts, hits leading a frame (`edit:snap`), bursts on fills, one stop on the final downbeat. Audio-reactive motion (`audio:curves`) only where the music is the subject, one element per shot.
8. **Type at phone size.** Sizes and the floor: craft rules. At hero size a vertical line holds one to three words: break lines by hand per format, cut words rather than shrink. Check every format with `pnpm motion:strip --input <mp4> --output <jpg> --phone`.
9. **Colour and flashes.** Ground swaps on hits (`ground-swap-cut`, `colour-flood`) are flashes, counted by the flash sensor: keep hits at least 1/3 s apart. Avoid a large field pulsing slowly near 0.2 Hz, a 5 s cycle ([Apple HIG](https://developer.apple.com/design/human-interface-guidelines/motion)).
10. **Caused transitions, sound from the same frames.** Carries per [carry and rhythm](../../.agents/skills/motion-and-typography/references/carry-and-rhythm.md); sounds from the blocks' cues (`sfx:cues`, `sfx:generate`) and a pack in the track's key (`sfx:synth --key <key>`).

## Tools

- **By variant**: the blocks named in `variants` and `starter` (playbook.json). Abstract: `mesh-gradient`, `grain-gradient`, `particle-assemble`, `light-rays`. Collage: `paper-collage-assemble`, `effects`. Title behind a subject: `subject-occlusion`. Every shot in `film-finish`.
- `pnpm library:list --category <c>` before any new code (motion-library skill).
- Light and materials via `engine-selection`, `blender-3d`, `blender:recipe`, `blender:assets`, `blender:city`, `blender:ext` and `blender:arsenal` ([arsenal](../../blender-arsenal/AGENTS.md)). See the [3D pilot](../../docs/drei-techniques.md).
- `plan:check`, `motion:still`, `motion:strip`, `motion:check`, `film:targets`: proof before the user sees it; `shot:tournament` per hero shot.

## Anti-patterns

- An effects reel, no idea.
- Tween soup: every element easing in and out over the same 15 frames.
- Pumping on every beat; a title that breathes or floats.
- Mid-size type; a lyric paragraph on screen at once.
- A mark that ends mid-move or fades.
- A cut moved off a downbeat to suit the animation; a `weak` grid trusted.

## References

- Thomas and Johnston, *The Illusion of Life* (1981): the twelve principles. Willenskomer on motion design's own principles: [Adobe, 2016](https://blog.adobe.com/en/publish/2016/11/08/redesigning-the-12-principles-of-animation-for-motion-design).
- [Material 3 motion tokens](https://raw.githubusercontent.com/material-components/material-web/main/tokens/versions/v0_192/_md-sys-motion.scss); [Apple HIG, Motion](https://developer.apple.com/design/human-interface-guidelines/motion).
- [WCAG 2.3.1 flashes](https://www.w3.org/WAI/WCAG22/Understanding/three-flashes-or-below-threshold.html), [WCAG 1.4.3 contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [Ofcom Broadcasting Code, rule 2.12](https://www.ofcom.org.uk/__data/assets/pdf_file/0020/132077/Broadcast-Code-Section-2.pdf).
- Ident length: 1–2 s stings to 3–5 s idents, a rule of thumb from practitioner blogs ([autoae](https://autoae.online/blog/logo-sting), [Renderforest](https://www.renderforest.com/blog/intro-video-length-by-platform)).
- Platforms (profiles): [YouTube Shorts up to 3 min](https://support.google.com/youtube/answer/15424877); [YouTube encoding, 16:9 and native frame rate](https://support.google.com/youtube/answer/1722171); [Instagram Reels, over 3 min not recommended to new audiences](https://about.instagram.com/features/reels); [TikTok in-feed specs, 9:16 and safe-zone files](https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads); [Meta, Instagram feed video](https://www.facebook.com/business/ads-guide/update/video/instagram-feed). Length bands within them are house rules.
- Title sequences to study by title only: Saul Bass, *Anatomy of a Murder*; Kyle Cooper, *Se7en*; [Art of the Title](https://www.artofthetitle.com).
- Reference library: `firecrawl`, `polymarket` (launch films whose hero-word cuts are this craft), `paper-style` (a paper world).

## Done when

- `plan:check` and `motion:check` pass; the sync map has no `miss`; `film:targets` is met or each gap has a written reason.
- Phone strips show words readable for their reading time in every format.
- No `FLASH_RISK` from `flash:check` or `film:measure`; type contrast holds at 4.5:1 through its moves.
- The last frame (and, for a loop, the first) is complete in every format; the end lands on the music.
- Approved music and film; [strict delivery](../../docs/delivery.md) passes.

[Icons](../../docs/icon-resources.md).

Vork: `vork-3d-vfx`.

[Audio contracts](../../docs/audio-integrations.md).
