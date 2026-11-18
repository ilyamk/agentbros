# Stock montage playbook

Last updated: 2026-11-17

**Draft.** Choose it for a film cut to music from licensed stock or supplied b-roll, with type over picture: a mood film, a manifesto, a brand montage, a sizzle reel. A recap of the user's own event (conference, wedding, concert) is [event-recap](../event-recap/AGENTS.md); a teaser building to a reveal or a date is [teaser-trailer](../teaser-trailer/AGENTS.md); the user's own recording of their speech is [footage-edit](../footage-edit/AGENTS.md); a film that sells a product around its real screens or object is [product-promo](../product-promo/AGENTS.md); generated shots are [ai-film](../ai-film/AGENTS.md); type and shapes with no footage are [motion-design](../motion-design/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type footage --playbook stock-montage --product <path>
pnpm film:next --project <id>          # repeat: do what it says
```

`--product` takes the supplied clips and the copy; omit it when everything comes from stock. Supplied media makes film:init point at the own-footage route: keep this project when the film is designed and cut to music, not a recording kept for its speech.

## What good looks like

- The film has one idea a viewer could say back, and the clips are chosen for it, not found by keyword.
- Cuts sit on the music's grid (sync map with no `miss`); shot lengths vary (`film:targets`), montage shots inside the ranges in [craft rules](../../design-reference/craft-rules.md).
- Clips look shot by one crew: one grade, one light direction, compatible lenses and frame rates.
- Type is bimodal: a hero word between shots or a small caption over picture, never a mid-size slide.
- Every clip has provenance and a licence that covers this use.

Variant `manifesto` ([playbook.json](playbook.json)): copy-led, the voiceover or type lines set the cuts and the script comes before the shot list. Platforms and length bands: `profiles`; the intake asks the idea, the sources and ad or organic use first.

## Method

1. **Write the shot list before searching.** Per beat of the music: the action, framing and a motif that carries across the cut (colour, direction of movement, shape). The cinematography skill sets framing and light; the editorial-storytelling skill sets cuts and holds.
2. **Search for shots, not subjects.** `pnpm resources --action search --provider auto --kind video --query "<action, framing, light>" --format vertical --output <json>` searches every source with a key (Pexels, Pixabay; stills also Unsplash) and ranks for the frame, push-in (`--zoom`), aspect and words; `--color`, `--orientation`, `--same-author-as <candidate.json>` (a series with one look) narrow it. Take several candidates per slot; a `blocked: resolution` result is too small for the frame. Acquire one with `--action acquire --candidate <json> --index <n> --project <id> --format vertical`, which fetches the size the frame needs. Reject the first-page cliché (handshake, typing hands, drone over a city) unless the idea is that cliché. For public post links supplied with reuse rights, acquire originals with `pnpm media:fetch --url "<url>" --project <id>` after checking the [acquisition guide](../../docs/media-fetch.md) and authorised budget; a public link grants no reuse licence.
3. **Licence on intake.** The resource-discovery skill records rights; `asset:import` registers every original. [Pexels](https://www.pexels.com/license/), [Unsplash](https://unsplash.com/license) and [Pixabay](https://pixabay.com/service/license-summary/) allow editing without attribution (credit on request: `--credit`, then `--action credits`) but forbid implying that the people or brands shown endorse anything and showing identifiable people in a bad light: check every face and logo against the copy laid over it.
4. **Conform.** Stock arrives at 24, 25, 30 and 60 fps; the film is 30. Check each clip's motion in `pnpm motion:strip --input <mp4> --output <jpg>` before it goes in; prefer native 30 or 60 fps sources for fast movement. Supplied b-roll with cuts inside it: `pnpm footage:shots --input <clip> --output-dir <dir> --strips` gives its shots. A clip of the other orientation: search that orientation first; else crop it with `pnpm reframe:track --input <clip> --format vertical --output <json>`, or play it whole in `clip-fill` when a crop would cut the subject.
5. **Cut to the map.** Music first, as in every film: `audio:map`, `edit:plan`, `edit:snap`, and `music:backtime` for the end. Cut on movement and match its direction across the cut.
6. **Grade last and once** across all clips, then type: `type-hero-word` between shots, a caption over picture, everything inside `film-finish`.

## Tools

- `resources`, `resource-discovery`: ranked, licensed sourcing with rights recorded.
- `asset:import`, `harness-asset-import`: originals registered once.
- `footage:shots`, `motion:strip`: what is inside a clip and how it moves.
- `reframe:track`, block `clip-fill`: a clip of the other orientation, cropped or whole over a blurred fill.
- `audio:map`, `edit:plan`, `edit:snap`, `music:backtime`: the grid.
- `cinematography`, `editorial-storytelling`: framing, grade, motivated cuts.

## Anti-patterns

- A keyword slideshow: each clip illustrates one word of the copy.
- Mismatched grades and frame rates reading as a compilation.
- A face or logo under copy it never agreed to.
- Crossfades between unrelated clips in place of a cut on movement.

## References

- [Pexels licence](https://www.pexels.com/license/), [Unsplash licence](https://unsplash.com/license), [Pixabay licence](https://pixabay.com/service/license-summary/).
- Platforms (profiles): [YouTube encoding, 16:9 and native frame rate](https://support.google.com/youtube/answer/1722171); [Instagram Reels](https://about.instagram.com/features/reels); [TikTok in-feed specs and safe-zone files](https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads); [LinkedIn video specs](https://www.linkedin.com/help/linkedin/answer/a548372). Length bands within those limits are house rules, starting points.
- Not yet: a measured reference montage in the reference library and benchmark projects.

## Done when

- Every clip has licence evidence and an import record; the sync map has no `miss`.
- A frame strip across each cut shows matched direction and no judder.
- The user approved the music and the film; the [strict delivery](../../docs/delivery.md) check succeeds.
- Still missing for `ready`: a reference montage measured with `ref:analyze` and tagged for this playbook (`ref:add --id ID --playbooks stock-montage`, so `ref:corpus --playbook stock-montage` and `film:targets --corpus --playbook stock-montage` read it), a benchmark project, and a check of other providers' licence terms (Openverse and Wikimedia licences vary per file).
