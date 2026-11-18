# Library implementation reference

Read the relevant section before changing font loaders or provider clients. Source paths without a directory prefix are relative to `src/lib/`.

## Fonts

`fonts.ts` loads Google Fonts on import. Space Grotesk, Bebas Neue and DM Sans have Latin only: Cyrillic text in them falls back to another face. Inter, Playfair Display, Oswald and Montserrat have Cyrillic.

For Cyrillic text, choose by role from `fonts-cyrillic.ts`, which loads only where it is imported:

| Export | Face | `wght` axis | Choose for | Replaces |
|--------|------|-------------|------------|----------|
| `cyrillicCondensedFont` | Sofia Sans Extra Condensed | 1–1000 | Heavy poster titles, long Russian words at large sizes | `condensedFont` |
| `cyrillicWideFont` | Unbounded | 200–900 | Short, expressive display lines; it runs very wide, so keep them short | — |
| `cyrillicGroteskFont` | Golos Text | 400–900 | Headlines and text set for Cyrillic first | `displayFont` |
| `cyrillicRoundedFont` | Rubik | 300–900 | Friendly consumer copy | `roundedFont` |

Subset and axis data come from `getInfo()` in `@remotion/google-fonts`; `tests/fonts-cyrillic.test.ts` checks them. The `cyrillic` subset does not include `cyrillic-ext`: check the glyphs for languages beyond Russian, Ukrainian and Belarusian.

These four load through `loadVariableFont`, so `fontWeight` interpolates continuously within the axis. Weight changes width, so animate it on anchored lines. The older exports use `loadFont`, which registers one face per weight: `fontWeight` snaps between them.

Caption faces (`src/motion/library/captions/faces.ts`) are roles of `fonts.ts` too: `captionHeavyItalicFont` (Montserrat italic), `captionCondensedItalicFont` (Sofia Sans Condensed italic), `captionExtraCondensedFont` (Sofia Sans Extra Condensed), `captionRoundedFont` (Rubik), `captionGroteskFont` (Inter Tight) and `captionMonoFont` (JetBrains Mono), all Latin and Cyrillic. Importing loads nothing; `loadCaptionFace(role)` loads one on first use. Optional roles: under a font context that omits one, the face falls back to the nearest required role (`geometricFont`, `condensedFont`, `roundedFont`, `primaryFont`), so a render never fetches from Google.

`FONT_ROLES` in `font-resources/manifest.ts` lists them as optional roles, so a font context may name them and old contexts stay valid. A font context replaces `lib/fonts.ts` only; a composition importing `lib/fonts-cyrillic.ts` still loads from Google Fonts. `src/lib/pipeline/creative-checks.ts` holds the map from `design.json` tokens to faces and subsets: update it when a loader's subsets change.

## External APIs

Keys in `.env` (template: `.env.example`). Clients in `src/lib/apis/`.

| Service | Env var | Use | Client |
|---------|---------|-----|--------|
| ElevenLabs | `ELEVENLABS_API_KEY` | TTS, music, transcription, **forced alignment** (word-level timestamps); ElevenLabs SFX runs through fal in `sfx:generate` | `elevenlabs/tts.ts` (TTS, alignment), `elevenlabs-music.ts`, `elevenlabs-scribe.ts`, typed studio commands in `elevenlabs/` |
| Unsplash, Pexels, Pixabay | `UNSPLASH_ACCESS_KEY`, `PEXELS_API_KEY`, `PIXABAY_API_KEY` | Stock photos (all three) and video (Pexels, Pixabay) | `resources/stock/` through `ResourceService` |
| Freesound | `FREESOUND_API_KEY` | Sound effects (CC0) | `apis/freesound.ts` |
| fal.ai modern | `FAL_KEY` | Exact operations for any catalogue endpoint ([catalogue](fal-catalogue.md)) | `scripts/generate-model.ts`, `src/lib/providers/fal-operations.ts`, durable `src/lib/jobs/` |
| fal.ai legacy/utilities | `FAL_KEY` | Explicit legacy FLUX and gpt-image-2 helpers (`generateImage`, `generateAndSaveGptImage`, `removeBackground`); CLIs: `rmbg`, `upscale` (free cut-outs: `matte/`) | `apis/fal.ts` |
| fal.ai music | `FAL_KEY` | Music through `generate:music --provider fal --model <endpoint>`: an allowlist of schema-pinned endpoints with list rates in `pricing.ts`; a durable job (`operations.json`, `pipeline/model-requests/`, `cost-ledger.jsonl`) | `providers/fal-music.ts`, `music/fal-generate.ts` |
| LottieFiles | none | Lottie animations | `apis/lottiefiles.ts` |
| Pollinations | none | AI images (prototype only, explicit `--provider pollinations`) | `scripts/generate-ai-image.ts` |
| Pixabay | `PIXABAY_API_KEY` | Stock (fallback) | direct fetch |
| Hugging Face | `HF_TOKEN` | Free read token for gated open models cached in `~/.cache/agentbros/` (pyannote diarisation in `speech:local`; later gated models) | `scripts/workers/speech-local.py` |

**New briefs:**
- Reuse approved immutable project media and pinned cards; import original Codex/Claude harness outputs using `pnpm asset:import` before paid generation. Retain provenance and do not invent subscription billing.
- Stock photo/video → approved local stock → Pexels/Pixabay with licence evidence; online discovery only when authorised.
- AI image/edit/meme → inspect GPT Image 2.5, Nano Banana 2.1 or FLUX.2's exact capabilities; `source: "fal-model"` with `metadata.operationRequest`.
- AI video/native-audio presenter → inspect Seedance 2.5 or Kling 3.0; select exact operation, region, audio/language and reference constraints. Kling O3 editing/voice and FLUX training/gallery are distinct workflows.
- Sound/music → approved local/library resources with rights evidence → authorised ElevenLabs generation where needed; when ElevenLabs Music is unavailable on the account (HTTP 402), the same request through fal (`generate:music --provider fal`). Chart/vector/text effects render locally.
- Run `pnpm fal:find --task TASK --min-tier verified`, inspect exact endpoint metadata, validate `pnpm generate:model --request REQUEST.json --project ID --output PATH --dry-run`, then review quote and durable budget policy.

See [production model routing](production-model-routing.md) and its schema-tested [three asset-plan examples](examples/modern-asset-plan.json). Schema and local-adapter verification is not live provider acceptance.

AI image placement rules for legacy FLUX and gpt-image-2 assets: [legacy routes](legacy-generation.md#legacy-image-alias-gpt-image-2).

**Voices:** named ElevenLabs voices are `VOICES` in `elevenlabs/tts.ts`.
