# AI presenter playbook

Last updated: 2026-11-17

Choose for a digital presenter speaking to camera: avatar, talking photo, mascot or digital twin. Recorded presenter: [footage-edit](../footage-edit/AGENTS.md); recorded dub: [localise](../localise/AGENTS.md); generated scenes without a presenter: [ai-film](../ai-film/AGENTS.md); voice over diagrams: [explainer](../explainer/AGENTS.md).

**Draft**: no lip-sync operation is live-accepted and no project accepted (Done when). Tell the user before spending.

## Start

Ask the intake (`pnpm playbook --id avatar-presenter`) first: the face and the voice decide consent, labels and the model.

```bash
pnpm film:init --project <id> --type talking-head --secondary ai-video --playbook avatar-presenter --product <path>
pnpm film:next --project <id>        # repeat: do what it says
```

`--product`: script or brief, product screenshots, any presenter still. `talking-head` supplies layout/captions; `ai-video` enables generated material. Paid rules: [production model routing](../../docs/production-model-routing.md).

No budget/consent: offer self-recording ([recording-guide](../../.agents/skills/recording-guide/SKILL.md), then footage-edit), voice over diagrams with a still card (explainer), or a library mascot (`mascot`, no video model).

## What good looks like

- **A narrator, not an anchor**: a presenter shot rarely holds more than a few seconds; inserts carry the argument and hide the tells (Melville).
- **Medium close-up, chest up, neutral pose**, consistent across every shot; extreme close-ups expose rendering flaws (vendor rule of thumb).
- **Lips land on the words**, eyes and teeth stay stable, no drift at the end of a clip.
- **The voice sounds like the face**: expression of the still matches the energy of the voice (Creatify guide).
- **Disclosed**: no viewer believes a real person said what they did not.

## Method

1. **Consent before any pixel.** A character card via `pnpm entity:card --project <id> --action create --input <card.json>` ([entity workflow](../../docs/entity-workflow.md), `world-and-entity-bible`). A real face needs `likenessConsent` `documented` with the user's evidence and scope; a cloned voice, `voice.consent` likewise; invented or cartoon presenters are `not-applicable`. Approval (`--action approve ... --confirm-user-approval`) is the user's yes and never implies consent. No public figure, minor or real person without recorded consent.
2. **Script for a face that cannot react.** `script-writer` writes short spoken lines with natural pauses, at about 2.3 words/s in Russian and 2.5 in English ([talking-head essentials](../../src/templates/AGENTS.md#talking-head-essentials)). Presenter on the hook, the turns and the ask; an insert for every claim that can be shown (`directing-and-performance`).
3. **Key frame of the presenter.** Medium close-up, front-lit, mouth closed, expression matched to the voice: `pnpm generate:image`, `pnpm generate:model` (with `--project`), the user's photo, or a harness original via `pnpm asset:import --project <id> --input <file> --origin agent-harness`. It joins the card's references; the user approves it in `material.json` (`film:approve --step material`).
4. **Voice first, then the face.** One audio owner per line ([talking-head essentials](../../src/templates/AGENTS.md#talking-head-essentials)). Default: the voice from `pnpm generate:voiceover --project <id>` (paid, with the user's yes), measured free with `pnpm speech:local --input <voice> --project <id>`. A clone is made by its owner in their own account (ElevenLabs clones only your own voice). Native model speech only in a supported language and never under a voiceover.

   Use a timed v4 take and a [speech reference pack](../../docs/elevenlabs-speech.md#speech-in-generated-shots) when the exact words and visible mouth matter. The take carries the line and speaker IDs. Record the selected voice for the model and language, and confirm lip-sync against the finished shot.
5. **Find the operation, never assume one.** Run `pnpm models:pick --use-case talking-presenter --project ID`, then inspect the exact endpoint with `fal:models --info` and `--schema`. Check reference audio, native speech languages, duration and lip-sync support in that schema and its prompting guidance. Following a supplied voice word for word remains unverified: dry-run (`pnpm generate:model --request <file> --output <path> --project <id> --dry-run`), then one paid test shot the user approves before the rest (`model-and-asset-production`). On a profiled endpoint the key frame and voice sample go in through `refs:plan`, `refs:derive` and a `refs:pack` the user approves; its markers are compiled, never typed (`reference-preparation`).
6. **Segments joined under inserts.** One segment per presenter beat, within the accepted duration plus handles; an insert between any two, so a reset to the key frame is never on screen (talking-head history). Each take is its own material item (`<beat>-t1`, `-t2`); spares and the repair reserve come from `pnpm budget --project <id>`.
7. **Check every take before cutting.** `pnpm asset:board` beside the approved key frame: face, teeth, eyes, wardrobe; scrub the plosives (p, b, m) for lip-sync. A slipping take is cut to its clean window or replaced by an insert; never a new seed on an approved card.
8. **Inserts carry the middle.** Real product screens through `pnpm capture:app` and `ui-camera-read` ([real-ui](../../docs/real-ui.md)); diagrams from the `data` category; one `film-finish` grain over presenter and inserts alike. `TalkingHeadLayout` holds a split (landscape) or stacked (vertical) presenter beside a panel.
9. **Captions from the voice's own timings**: `pnpm align:captions --project <id>` for the voiceover, then a caption block per profile (`caption-clean-sentence` for landscape, `caption-line-box` for vertical), placed off the face (`captions-and-localization`). Music ducks under speech (`sound-design-and-mix`).
10. **Disclose.** The label per platform for the user's upload (References); for EU audiences a line such as "AI-generated presenter" at first exposure. Rendering may drop Content Credentials: labels are set by hand. `pnpm cost:report --project <id>` before delivery.

A persona presenter can start from an `image.character` still (`pnpm models:pick --use-case influencer-photo`, [Higgsfield](../../docs/higgsfield-prompting.md)); a real person's likeness needs `entity:card` consent first.

## Tools

- `entity:card`, `asset:board`, `asset:import`: presenter card with consent, take checks, harness originals.
- `refs:profiles`, `refs:plan`, `refs:derive`, `refs:pack`: what the model accepts, the presenter's inputs, the approved pack.
- `generate:image`, `generate:model`, `fal:models`, `fal:find`, `fal:scaffold`: frames, clips, schemas. `scripts/generate-lipsync.ts --endpoint <id>`: verified lipsync ([guide](../../docs/legacy-generation.md)).
- `generate:voiceover` (paid), `speech:local` (free), `align:captions`: voice and its words.
- `budget`, `cost:report`, `film:approve`: spend and approvals.
- `capture:app`, `music`, `sfx:cues`, `sfx:generate`, `film:measure`.
- Library: `film-finish`, `caption-clean-sentence`, `caption-line-box`, `ui-camera-read`, `slice-panels`; components `TalkingHeadLayout`, `TalkingHeadVideo` in `src/templates/talkinghead`.

## Anti-patterns

- A real person's face or voice "because they agreed in chat" with no consent on the card; a public figure endorsing anything.
- One static presenter shot for the whole film; extreme close-ups.
- Native model speech and an ElevenLabs voice on the same line (double voice).
- Two generated presenter segments cut together face to face: the snap back to the key frame shows.
- A Russian line sent to a model whose native speech is English-only.
- A real person's name in a prompt; a model or price not from the registry.
- Shipping without the platform label.

## References

- Labels: [YouTube altered or synthetic content](https://support.google.com/youtube/answer/14328491) (a real person saying what they did not; animated and own-voice dubs exempt); [TikTok integrity and authenticity](https://www.tiktok.com/community-guidelines/en/integrity-authenticity) (label realistic AI people; unlabelled may be removed); [Meta, labelling AI-generated content](https://about.fb.com/news/2024/02/labeling-ai-generated-images-on-facebook-instagram-and-threads/) (photorealistic video or realistic audio must be disclosed); [EU AI Act Article 50](https://artificialintelligenceact.eu/article/50/) (deep fakes disclosed at first exposure, from 2 August 2026).
- Consent: [ElevenLabs, cloning someone else's voice](https://elevenlabs.io/docs/help-center/product/voices/voice-cloning/can-i-create-a-professional-voice-clone-of-someone-elses-voice.md) (own voice only); [Synthesia, custom avatars](https://help.synthesia.io/en/articles/9486472-what-is-a-custom-avatar) (explicit consent of the person).
- Practice: [Colin Melville, The Drum, via Inizio](https://inizioengage.com/insights/we-need-to-teach-the-machines-to-act/) (cut away; hold a talking head a few seconds); [Creatify, Aurora best practices](https://creatify.ai/blog/aurora-best-practices) (vendor rule of thumb).
- Platforms: [YouTube Shorts length](https://support.google.com/youtube/answer/15424877) (up to 3 min, square or vertical); [LinkedIn video specs](https://www.linkedin.com/help/linkedin/answer/a548372) (3 s to 15 min, 1:2.4 to 2.4:1); Reels up to 3 min ([reported](https://lindseygamble.com/blog/instagram-three-minute-reels)).

## Done when

For a project:

- The presenter's card is user-approved with consent documented or not-applicable, at the revision the shots used.
- `material.json` shows the key frame approved before any video item was funded, each clip with model, operation id and `costUsd`; `cost:report` is within the bounds.
- Every presenter shot passes the lip-sync and drift check on `asset:board`; no two generated presenter segments meet on screen.
- The user has the label list per platform; the [delivery](../../docs/delivery.md) check passes and the user approves the film.

What is missing before this playbook can be `ready`:

- **No live-accepted lip-sync route**: every registered video operation is live `not-run`; whether the chosen endpoint follows a supplied voice word for word, and in which languages, is unverified; the lip-sync script is legacy.
- **No lip-sync sensor**: sync is judged by eye.
- **`talking-head` assumes recorded takes**; a generated presenter rides on the `ai-video` secondary, with no presenter QA line in `src/lib/film/routes.ts`.
- **No accepted project** yet.

[Optional audio contracts](../../docs/audio-integrations.md).
