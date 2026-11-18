# Localise playbook

Last updated: 2026-11-15

**Draft.** Choose it when a finished video should exist in another language: translated subtitles, a new voice (dub) or a localised version with its on-screen text replaced. Subtitles in the language spoken are [footage-edit](../footage-edit/AGENTS.md); a new film made in the target language from the start follows the playbook of its kind, for example [explainer](../explainer/AGENTS.md).

## Start

```bash
pnpm project:new --project <id>          # the source project; the recording goes in public/projects/<id>/assets/footage/
pnpm footage:next --project <id> --playbook localise --source <file> --goal captions --language <code>
pnpm footage:next --project <id>         # repeat, doing what it returns
```

Only a recording binds to this playbook; for a template project or a bespoke film run the table's commands and leave its binding alone. Ask the `intake` questions in `playbook.json` in one message; per-platform facts are its `profiles`. `--language` is the language spoken in the source, for the transcript; `text:translate` can prepare reviewed local translation candidates when available; applying a translated track to a recording remains a separate step. What it supports today, by source:

| Source | Route | Missing |
|---|---|---|
| The user's recording | Transcript and captions in the spoken language, SRT/VTT with `captions:export` ([footage editing](../../docs/footage-editing.md)) | A command that applies a translated caption track to the recording timeline; untested by hand: a `captions` timeline edit (dry run first) replacing a clip's word captions with phrase captions that each carry a supplied `translation`, then `caption-style` `bilingual` with `sourceLanguage` and `translationLanguage` burns both (a caption without one stops the render); automatic placement of dubbed audio onto a recording timeline (versioned dubbing itself is available through `dubbing`) |
| A template-mode project or campaign episode | `pnpm campaign --manifest <translation.json> --action localize-plan`, then `localize-create` and, after the new audio and alignments, `localize-review` ([campaigns and localisation](../../docs/campaigns-localization.md)) | Nothing structural; the translation is supplied |
| A bespoke film | One composition, the new voice mapped onto its beats with time-warp knots ([captions-and-localization](../../.agents/skills/captions-and-localization/SKILL.md)) | No command or library code: it is written per film |

## What good looks like

- **Meaning, names, numbers and units survive** the translation; nothing is softened or added. A person fluent in the target language has read every line before anything is rendered.
- **Captions fit the target language**: text expands or shrinks, so lines are regrouped for reading speed, not squeezed into the source's cues. Sidecars: at most 42 characters a line, two lines; adult reading speed up to 20 characters a second in English and 17 in Russian (Netflix style guides); burned short-form pages follow `checkCaptionPages` (17 a second).
- **A new voice is timed to the picture**, not the picture to the voice: beats keep their meaning on the word that names them.
- **On-screen text is replaced too**, in a font with the target script (Cyrillic, accents) and no overflow.

## Method

1. **Ask in one message:** which languages, subtitles or voice or both, burned or sidecar, who checks the translation, and whether paid voice and alignment are allowed (`generate:voiceover` and `align:captions` are paid; within an approved budget only).
2. **Translation is supplied.** The agent may draft it, but it is recorded as supplied text with its provenance (`TranslationSchema` `source`) and the user or a fluent reviewer approves it. Never call it checked when nobody fluent read it.
3. **Template projects:** write the translation manifest (one supplied translation per scene, spoken `text`, `headline`, literal `labels`), run `localize-plan`, then `localize-create` into a new project id. Generate the new voice and word timings there, then `localize-review` with the reviewer's evidence; renders refuse an unreviewed localisation.
4. **A user's recording:** run the footage route for captions in the spoken language and export the SRT with `pnpm captions:export --project <recut id> --output <file> --timeline`. A translated SRT drafted from it keeps every cue's times; it is a handoff file the repository cannot check or burn in, and delivery's `subtitleTracks` select only existing caption owners. Say both plainly.
5. **Bespoke films:** follow the skill's time-warp method by hand, in the film's own code; its limits and the loudness match are in the skill.
6. **Look at every language:** stills of the longest caption page and every replaced label at phone size (`captions:place` for a recording); the user listens to each new voice. Agents cannot hear.

## Tools

- `dubbing`: budgeted versioned language outputs; source edits stale targets, and Enterprise regeneration requires a reviewed revision. `dubbing:conform` materialises explicit template spans with source receipts; align the actual new audio and pass its binding to localisation review. See [audio integrations](../../docs/audio-integrations.md).

- `footage:next`, `speech:local`, `transcribe`, `captions:place`, `captions:export`, `timeline:edit`: source-language captions and sidecars for a recording ([caption delivery](../../docs/caption-delivery.md)).
- `campaign` (`localize-plan`, `localize-create`, `localize-review`): supplied localisation of template projects.
- `generate:voiceover`, `align:captions`: the new voice and its word timings (paid).
- `delivery` with `subtitleTracks`: separately exported caption owners with declared languages ([delivery](../../docs/delivery.md)).
- Skill `captions-and-localization`: grouping, expansion, the time-warp method.

## Anti-patterns

- Machine translation shipped unread; a translated caption reusing the source's cue breaks so lines overflow or flash.
- Reusing the source voice's word timings or the source's audio under a new language.
- Claiming a sidecar's declared language proves the translation is right.
- A font without the target script's glyphs; labels left in the source language.

## References

- Repository limits: [campaigns and localisation](../../docs/campaigns-localization.md) (the supplied campaign route does not translate automatically; the optional dubbing backend proposes translated speech for fluent review), [caption delivery](../../docs/caption-delivery.md), [delivery](../../docs/delivery.md) (declared language is not validated).
- Netflix Timed Text Style Guides: [general](https://partnerhelp.netflixstudios.com/hc/en-us/articles/215758617-Timed-Text-Style-Guide-General-Requirements), [English (USA)](https://partnerhelp.netflixstudios.com/hc/en-us/articles/217350977-English-USA-Timed-Text-Style-Guide), [Russian](https://partnerhelp.netflixstudios.com/hc/en-us/articles/216014517-Russian-Timed-Text-Style-Guide)
- YouTube Help: [subtitles per language](https://support.google.com/youtube/answer/2734796), [multi-language audio](https://support.google.com/youtube/answer/13338784) (own dub uploaded as an audio-only track, Advanced features); loudness reference about -14 LUFS, measured by practitioners: [Meterplugs](https://www.meterplugs.com/blog/2019/09/18/youtube-changes-loudness-reference-to-14-lufs.html)
- Platform lengths: [TikTok ads video specs](https://ads.tiktok.com/help/article/video-ads-specifications), [Reels to 3 minutes](https://www.socialmediatoday.com/news/instagram-officially-expands-reels-length-3-minutes/737766/)
- Dubbing Projects now have typed, budgeted commands and mocked recovery coverage; live paid-account and human practice acceptance remain unverified. A benchmark project is still missing.

## Done when

- Every language's text was approved by the user or a fluent reviewer named in the project.
- Template localisations passed `localize-review`; every new voice was heard by the user.
- Stills of every language show captions and labels readable, in the right script, clear of faces and interface.
- Still missing for `ready`: a command that writes a translated caption track onto a recording's timeline and exports it per language (the bilingual path above is untested), time-warp as library code for bespoke films, and a benchmark project.

Local Apple task alternatives are discovered for the current step with `pnpm local:capabilities`; read [local macOS](../../docs/local-macos.md) only when selecting one. Unavailable languages/resources are excluded; existing review and paid-budget gates remain.

Optional audio tools and their budget, source-clock, timing and review requirements: [audio integrations](../../docs/audio-integrations.md). Availability does not change this playbook's human gates or benchmark status.
