# Audio: voice samples, sound and music references

Tiers and dates: [legend](../SKILL.md#references). Profile limits: `pnpm refs:profiles --action show --family F`. Agents cannot hear: report measurements, never that a voice sounds right; the user judges.

## Prepare

- **Voice sample for a video model**: one speaker, clean, low noise, moderate pace, neutral delivery, no music under it, no clipping. Trim to the slot's window with `audio-trim`, level it with `loudness`.
- **Voice for cloning** (outside packs, `voices:manage`): a longer clean, consistent recording; pronunciation aliases for names and terms.
- **On the card**: imported clips as the character's `voice.sampleAssetIds`, aliases in `voice.pronunciation`, and `voice.consent` recorded. A real person's voice needs documented consent; a designed or synthetic voice is `not-applicable`.
- **Sound or music reference**: only on a profile that takes audio, and only when the shot's sound comes from the model (`audioPolicy: "reference-driven"` or `"native"`); otherwise the sound step owns it (`replace-in-edit` or `mute`).

## Specs and limits (model-specific)

- ElevenLabs: instant clone from 1–2 min of clean, consistent speech; professional clone from 30–180 min; MP3 at 192 kbps or more is enough; pronunciation dictionaries support phonemes (model-limited) and aliases, prefer aliases outside English — [O] [ElevenLabs voice cloning](https://elevenlabs.io/docs/product-guides/voices/voice-cloning), checked 2026-11-17.
- Seedance 2.5 reference-to-video: up to 10 audio references of 1.8–30.2 s each and in total — [3P] [fal Seedance 2.5 reference-to-video API](https://fal.ai/models/bytedance/seedance-2.5/reference-to-video/api), checked 2026-11-17. Audio references need at least one image or video reference (profile guidance, [3P]).
- Seedance 2.0: up to 3 audio references — [3P] [fal Seedance 2.0 reference-to-video API](https://fal.ai/models/bytedance/seedance-2.0/fast/reference-to-video/api), checked 2026-11-17. Further length, format and size limits from one wrapper are unverified guidance, not limits.
- Kling 3.0 Omni voice binding from a short, low-noise, moderate-pace, neutral clip ([O], RFC 0003 §3.8, no source link recorded); no Kling profile here has a voice slot yet.
- Wan 2.5 and 2.6: `audio_url` drives sync; without it the model generates sound itself ([O], RFC 0003 §3.8). No Wan profile exists here.
- Gemini Omni takes no audio references, and ignores the audio of reference videos — [O] [AI Studio Omni](https://aistudio.google.com/docs/omni), checked 2026-11-17.

## In our system

| Need | Card field or view | Requirement role | Derivatives |
|---|---|---|---|
| A character's voice | `voice.sampleAssetIds`, `voice-sample` view | `voice` | `audio-trim`, `loudness`, `audio-clean` (fal, paid) |
| A sound to match | imported asset | `sound` | `audio-trim`, `loudness` |
| Music to follow | imported asset | `music` | `audio-trim` |

- `refs:plan` marks a character voice sample as `voice-sample`. A lip-sync or audio-driven slot needs the approved performed line. Add its `lineId`, speaker, language, timing and hashed take receipt through [the speech pack contract](../../../../docs/elevenlabs-speech.md#speech-in-generated-shots).
- Sensors measure clipping, a noise-floor proxy, silent share and length against the slot; `refs:pack` refuses a voice sample whose character has neither documented nor `not-applicable` voice consent.
- Local `audio-clean` is not built yet; it runs as a paid fal step after the user's yes.

## Failure modes

- Music or a second speaker under the sample: the model copies the bed or mixes voices.
- Clipping or heavy noise reduction artefacts: carried into the result.
- Native audio on a shot whose sound the sound step owns: two voices, or a bed that fights the music. Set `audioPolicy` deliberately.
