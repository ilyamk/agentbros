# AI film playbook

Last updated: 2026-11-17

Generated stories/music films within budget. Products: [product-promo](../product-promo/AGENTS.md), `ai-video` secondary shots; animation: [motion-design](../motion-design/AGENTS.md); supplied b-roll: [stock-montage](../stock-montage/AGENTS.md).

## Start

```bash
pnpm film:init --project <id> --type ai-video --playbook ai-film --product <path>
pnpm film:next --project <id>        # repeat: do what it says
```

`--product` is optional/repeatable: script, treatment, brand/product stills and approved character/location images. Video or audio there triggers a footage suggestion. No product: the brief's `productName` is `none`, so `truth` needs no source ([brief-collector](../../.agents/agents/brief-collector.md)); a branded piece passes its copy or brand guide as `.md`. A reference film goes in with `pnpm ref:add`, then `pnpm film:targets`. Paid rules: [production model routing](../../docs/production-model-routing.md).

## What good looks like

- **Directed, not sampled**: every shot has a size, a move and a reason in the beat sheet; the same faces, wardrobe and props throughout.
- **Shot lengths match the reference's measured median** (`film:targets`, then `film:measure`), not the model's clip length; Air Head kept about 1/300 of what was generated.
- **The cut hides seams**: cuts on action and on sound, no frame held past the point where hands, text or edges start to drift.
- **Sound carries continuity** that the pictures cannot: one music bed and room tone across cuts.
- **Spend is planned per shot with spares** (step 7), never one take per shot.

| Variant ([playbook.json](playbook.json)) | What changes |
|---|---|
| `music-video` | The track's sections are the beat sheet; cuts on downbeats; no generated lip sync unless the user accepts its look |
| `mood-film` | No story or recurring character; text-to-video for more shots; 15–60 s |

`profiles`: platforms, lengths and labels. Intake asks the ceiling first.

## Method

1. **Bible first.** One card per character, object, location and style before any shot, with `pnpm entity:card --project <id> --action create --input <card.json>` ([entity workflow](../../docs/entity-workflow.md), `world-and-entity-bible` skill). Write its invariants (face, build, wardrobe, colours, silhouette) as the card's `fixedSentence`; every pack repeats it verbatim. Check views with `--action coverage`. Approving a card records the user's own yes (`--action approve`, full form in the entity workflow).
2. **Key frames before motion.** For every shot, a still of its first frame (and its last, when the move must land somewhere): with `pnpm generate:image` or `pnpm generate:model` (`--project`, the user's bound), or free from the harness's image tool, registered with `pnpm asset:import --project <id> --input <file> --origin agent-harness`. Character angle sheets keep identity stable (Wistia).
3. **Two material approvals.** `material.json` first holds only the key frames and entity references, with each shot's reference requirements (`refs:plan --action board`); the user approves it (`film:approve --step material`). Between the two yeses run `refs:derive` and `refs:pack` (a later edit to the file refuses them under an enforcing guard). Then add the video items, each with its `maxCostUsd` and `referencePack`; the changed file closes the gate and needs the user's second yes.
4. **Image-to-video by default.** The key frame fixes subject, composition, palette and light; the prompt describes only what moves. Text-to-video only for shots with no continuity to keep. Name both channels, subject motion and camera, and say what stays still; a prompt that departs from the image can trigger a cut or transition inside the clip.
5. **Moves the models hold.** One camera move per shot, named in plain grammar: static, slow push-in, pan, tilt, truck, crane. Get the locked-off version right first, then add the move. Avoid moves needing off-frame anatomy, orbits revealing unseen sides, and generated text (titles are type over picture). Record each shot's spec in the beat sheet (`cinematography` skill).
6. **Find the model.** `pnpm fal:find --task "<shot>" --duration <s> --aspect <r>`, then `fal:scaffold --endpoint <id>` and `generate:model --request <file> --output <path> --project <id> --dry-run` ([fal catalogue](../../docs/fal-catalogue.md), `model-and-asset-production`). Ask for the shortest accepted duration covering the beat plus handles; price several takes with `fal:batch` (dry-run). Inputs before the request: `refs:profiles`, `refs:plan`, `refs:derive`, then a `refs:pack` the user approves; markers are compiled by `refs:pack`, never typed (`reference-preparation`).
7. **Coverage and spares.** Per beat plan the shot, a cutaway (hands, object, environment) and one alternative angle. Each take is its own material item and asset id (`<shot>-t1`, `-t2`): the budget allows 2 paid attempts per asset unless the user sets `pnpm budget --project <id> --ceiling-usd <bound> --answer "<the user's words>" --attempts <n>`. Keep the repair reserve (`--repair-fraction`, 0.15 by default) for reshoots after the critic.
8. **Check consistency before cutting.** Lay the takes beside the approved key frames on `asset:board`: face, wardrobe, prop colour, screen direction and eye-line. A shot that drifts is reshot from its key frame or replaced by a cutaway; never fix identity with a new seed on an approved card.
9. **Cut on action, early.** Take each clip's cleanest window, usually from its start, nearest the key frame; end it on a gesture, a turn, a contact, or a sound cue. Joins and the shared grain: `starter` (`editorial-storytelling`).
10. **Sound carries the film.** Music is chosen before the script (`pnpm music`, sound-director). Set each request's native audio deliberately: off when the sound step owns the bed (it also changes the quote), on only when the shot owns its dialogue or sync sound, and never with a second voice over it (`directing-and-performance`). Foley for generated action from `pnpm sfx:library`; ambience and music run under cuts as J- and L-cuts (`sound-design-and-mix`).
11. **Rights and disclosure.** No real person's likeness without their recorded consent (card `likenessConsent`), no living artist, film or brand named in a prompt; a real product appears from the user's own photos as references, never invented. Every generated item records model, operation id and cost in `material.json`; `pnpm cost:report --project <id>` at delivery.

Hero into a shot: `models:pick --use-case replace-person`; Genjutsu uses `model:prepare`, which compiles its markers ([three modes](../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow)), and `film:rights --preparation ID`; sources: `motion:library`. Keep consented, approved cards and material/spend gates.

For exact character dialogue, pin the approved words and speaker in the script, choose the take before requesting an audio-driven shot, and review line by line at result. [Speech in generated shots](../../docs/elevenlabs-speech.md#speech-in-generated-shots)

## Tools

- `generate:image`, `generate:model`, `fal:models`, `fal:find`, `fal:scaffold`, `fal:quote`, `fal:batch`: shots, schemas, pricing. `generate:video` is [legacy](../../docs/legacy-generation.md).
- `budget`, `cost:report`: ceiling, attempts, repair reserve, spend. `film:approve`: the two material approvals, in the user's words.
- `entity:card`, `asset:board`, `asset:import` (`harness-asset-import`): bible, side-by-side checks, harness originals.
- `refs:profiles`, `refs:plan`, `refs:derive`, `refs:pack`: what each model accepts, each shot's inputs, trims and passes, the approved pack behind every request.
- `music`, `sfx:library`, `sfx:cues`, `sfx:generate`: bed, foley, cues. `film:targets`, `film:measure`: shot lengths and cuts.
- Library: the `starter` blocks (playbook.json) and `typography` for titles.

## Anti-patterns

- Rewriting an entity's description per prompt.
- Holding a clip to its end, where drift and morphs grow.
- Two camera moves plus complex action in one shot; "cinematic" instead of a named move.
- Generated speech layered on a voiceover; music cut per shot.
- A new seed or operation id to "retry" an ambiguous paid job (`model-and-asset-production`).
- Naming a model the registry lacks; quoting prices instead of the dry-run quote.

## References

- Prompting: [Veo prompt guide](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/video/video-gen-prompt-guide) (shot and camera vocabulary, audio in its own sentences); [Gen-4.5 directing motion](https://runware.ai/docs/models/runway-gen-4-5/guides/directing-motion.md) (image fixes appearance, prompt what moves, state what holds); [Kling image-to-video guide](https://kling.ai/quickstart/image-to-video-guide) (subject + movement, locked-off first).
- Practice: [Wistia, animated AI short](https://wistia.com/blog/animated-ai-short) (stills first, character sheet, start and end frames); Air Head by shy kids, 300:1 ratio and unwanted slow motion ([TechCrunch](https://techcrunch.com/2024/04/27/creators-of-sora-powered-short-explain-ai-generated-videos-strengths-and-limitations)); Kalshi's NBA Finals ad: 300–400 generations for 15 clips, as reported ([CO/AI](https://getcoai.com/news/kalshis-nba-finals-ad-costs-just-2k-using-googles-ai-video-tool/)).
- Platforms: [YouTube Shorts up to 3 min](https://support.google.com/youtube/answer/15424877); [Instagram Reels](https://about.instagram.com/features/reels); [TikTok in-feed specs](https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads). Length bands are house rules, starting points.
- Labelling: [YouTube altered or synthetic content](https://support.google.com/youtube/answer/14328491) (realistic content: "AI use" at upload; animated exempt); [TikTok integrity guidelines](https://www.tiktok.com/community-guidelines/en/integrity-authenticity) (realistic AI scenes or people; unlabelled may be removed); [Meta labelling](https://about.fb.com/news/2024/02/labeling-ai-generated-images-on-facebook-instagram-and-threads/) (photorealistic video or realistic audio); EU AI Act Article 50, from 2 August 2026; evidently artistic or fictional work discloses in a way that does not hamper it ([guide](https://artificialintelligenceact.eu/transparency-rules-article-50/)).

## Done when

- Every entity card is user-approved at the revision used.
- `material.json` shows two user approvals (key frames, then video), every generated item acquired with model, operation id and `costUsd`, and `cost:report` within the bounds.
- `film:measure` passes shot length and cut legs; the critic found no artefact frame on screen.
- The user has the label list for each target platform: YouTube "AI use" for realistic content, TikTok AI-generated label, Meta AI disclosure, an end-credit line for EU audiences. Rendering may drop the generators' Content Credentials, so the label is set by hand at upload.
- The [delivery](../../docs/delivery.md) check passes and the user approves the film.

[Optional audio contracts](../../docs/audio-integrations.md).
