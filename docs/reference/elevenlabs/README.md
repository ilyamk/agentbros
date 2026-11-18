# ElevenLabs API references

Vendored API reference material from [elevenlabs/skills](https://github.com/elevenlabs/skills), MIT licensed (each folder's `LICENSE`, Copyright (c) 2024 ElevenLabs). They were agent skills under `.agents/skills/` until 2026-11-16 and are now plain documentation, so they no longer appear in every session's skill list. They describe the ElevenLabs HTTP APIs; they do not execute production work.

Production goes through the repository commands and the budget layer ([audio integrations](../../audio-integrations.md)): a user's recording is transcribed with `pnpm transcribe` or `pnpm speech:local` ([footage editing](../../footage-editing.md)); voiceover, music, sound effects, voice transforms and dubbing use their own budgeted commands.

| Folder | Upstream skill | Local entry point | Upstream install hash (`computedHash`) |
|---|---|---|---|
| [dubbing](dubbing/README.md) | `dubbing` | `pnpm dubbing` | `08b2f1a890aa09241bbf57d0eb02de857488d3b04a4841f1454b856f96bb65e6` |
| [music](music/README.md) | `music` | `pnpm music`, `pnpm generate:music` | `f5307770bacfea37e8fb49aa1d5588d6af15dfdcec8a23d4bac781a0c26685de` |
| [sound-effects](sound-effects/README.md) | `sound-effects` | `pnpm sfx:find`, `pnpm sfx:generate` | `fa468bb2890e30b6a86c6f8df58eb86f97c273a2e46f3335ab93bd96908806ba` |
| [speech-to-text](speech-to-text/README.md) | `speech-to-text` | `pnpm transcribe`, `pnpm speech:local` | `b80ce83ff5bbccfea698f23ea737b46f7b74dadb25c2d05bf27f6bab32b3f5a4` |
| [text-to-speech](text-to-speech/README.md) | `text-to-speech` | `pnpm generate:voiceover` | `3053c758ca51fbfbaa1b8fd579998156c651bfde47ba80e9350f92123a01a249` |
| [voice-changer](voice-changer/README.md) | `voice-changer` | `pnpm audio:transform` | `ac221cfd29945269bed07cb410673d04b8f6386d37fc7a321c3a551cac93560f` |
| [voice-isolator](voice-isolator/README.md) | `voice-isolator` | `pnpm audio:transform` | `101c969424cbfeedaaef20470f5e679fac016f7b57677fbc3b71f419ac5dd032` |

## Provenance

- Source: commit `1d84076319721b3e0b3c8189c76e91a0d859d9d4`, refreshed 2026-11-15. Each folder's `UPSTREAM.md` (the upstream `SKILL.md`, front-matter included) and `references/` are unmodified; its `LICENSE` is the upstream MIT licence, copied into each folder locally.
- The hash column is the installer v1 folder hash of the upstream files (paths sorted with localeCompare, then path and content bytes), taken before the local entry points and licence copies. The entries were removed from `skills-lock.json` on 2026-11-16 so a skills install does not restore these folders as skills.
- Local changes (MIT): each folder's `README.md` is the former local `SKILL.md` entry point with its front-matter removed; it names the repository command for that API. On 2026-11-16 the folders moved from `.agents/skills/<name>/` to `docs/reference/elevenlabs/<name>/`.
- Credits: [CREDITS.md](../../../CREDITS.md); notices: [NOTICE.md](../../../NOTICE.md).
