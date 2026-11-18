# Speech: transcripts and speech masks

Last updated: 2026-11-13

For a user's footage, start from [footage editing](footage-editing.md); never call a speech API directly. Two commands turn a recording into the engine-neutral transcript (`TranscriptSchema`, `src/types/transcript.ts`) that `recut:plan`, `shorts:prepare`, captions and multicam read. Pick one:

| Command | Cost | Engine | Fillers | Speakers |
|---|---|---|---|---|
| `pnpm transcribe` | Paid (ElevenLabs Scribe, budget-tracked) | `scribe_v3` default; `scribe_v2`, `scribe_v1` | Verbatim by default: fillers marked `kind: "filler"` | `--diarize`, `--speakers N`, `--multichannel` |
| `pnpm speech:local` | Free, offline after the first download | Parakeet TDT 0.6B v3 through MLX (Apple Silicon), whisper.cpp fallback; Silero VAD | Not verbatim: clear fillers ("um", "эээ", "ну-у") marked, context-dependent ones not | pyannote Community-1 only when `HF_TOKEN` is set |

Both write `pipeline/transcript.json` (or `--output`). `speech:local` also writes the speech mask.

## The transcript

- `words[]`: `id` (`w1`…), `text`, `kind` (`word` | `filler` | `event`), `startSec`, `endSec`, `speaker` (null without diarisation), `channel` (Scribe multichannel only, else null), `confidence` (0–1 or null). Sorted by `startSec`.
- `kind: "filler"`: a conservative lexicon of disfluencies, marked by both commands. Sounds that are never words count in any transcript: `um`, `uh`, `uhm`, `erm`, `hmm`, `mm`, `э`/`ээ`/`эээ` (also `э-э-э`), `эм`, `ммм`, `хм`, and lengthened `ну-у`. Language-specific ones count only in their language: `er` in English (it is a word in German), single `м` in Russian (not after a number, where it means metres). Plain `ну` counts only in verbatim transcripts and only when standalone (a pause of 0.3 s, punctuation, a speaker change or the transcript's edge on both sides: "Ну, давайте" yes, "ну да" no). Words like "like", "actually", "well", "так", "вот", "а" are never fillers. `engine.verbatim` stays false for `speech:local`: Parakeet drops many fillers, so their absence there proves nothing.
- `kind: "event"`: Scribe audio events such as `[laughs]`, and listener backchannels ("Mm-hmm", "uh-huh", "mhm", "угу", "мгм") from either command. Backchannels are events, not fillers: they are usually another speaker talking over the main one, so recut must not cut them and captions skip them. Events sit in `words` but not in sentence text, so a backchannel does not break the speaker's sentence. Punctuation-only tokens (Scribe's `...` at an interruption, zero length) are dropped, so no sentence is made of punctuation alone.
- `sentences[]`: split at `.`, `!`, `?`, `…`, at a gap of 0.7 s or more, at a speaker change, and at 30 s at the latest. `firstWordId`/`lastWordId` point into `words` and a sentence is a contiguous run of them. With multichannel crosstalk, a word from another channel ("yeah") inside someone's sentence splits it, because words are ordered by time across channels.
- `language`: ISO-639-1 where one exists (`eng` → `en`, `rus` → `ru`); `und` when unknown. Parakeet does not report a language, so `speech:local` writes `--language`; without it, text that is over 80% Cyrillic (at least 20 letters, no Ukrainian or Belarusian letters) is written as `ru` with a note, and anything else as `und` (Latin text is not guessed). The language decides the language-specific fillers (`м` in Russian), so give `--language` when you know it.
- `speakers[]`: ids in order of first appearance. Scribe: `speaker_0`…; multichannel: `ch0`, `ch1`, or `ch0-speaker_1` when diarisation also split a channel. pyannote: `SPEAKER_00`….
- `notes[]` (optional): plain-language caveats, for example why diarisation did not run or that untimed words were left out.
- `engine.timing` is `native` for both commands.

## The speech mask (`speech:local`)

`SpeechMaskSchema` in `src/types/speech-mask.ts`, written to `speech-mask.json` beside the transcript (`pipeline/speech-mask.json` with `--project`) or to `--vad-output`:

```json
{
  "version": 1,
  "source": { "file": "…", "sha256": "…", "durationSec": 14.986 },
  "engine": { "provider": "silero-vad", "version": "6.2.3", "sampleRate": 16000, "threshold": 0.5, "minSpeechMs": 250, "minSilenceMs": 100, "padMs": 0 },
  "speech": [{ "startSec": 0, "endSec": 2.528 }, { "startSec": 2.72, "endSec": 5.888 }],
  "speechSec": 11.616
}
```

Spans are raw detector output: sorted, non-overlapping, and **not padded** (`padMs: 0`). Consumers add their own padding. Silences are the gaps between spans and the file's edges.

## `pnpm transcribe` (Scribe)

```bash
pnpm transcribe --project ID --input recording.mp4 --output public/projects/ID/pipeline/transcript.json \
  --diarize --speakers 2 --keyterms "Remotion,Parakeet" --language en
```

| Flag | API parameter | Notes |
|---|---|---|
| `--model scribe_v3` (default) | `model_id` | `scribe_v2`, `scribe_v1` (v1 is deprecated and has no verified price) |
| `--no-verbatim` | `no_verbatim=true` | Removes fillers and false starts (v2, v3). Default is verbatim, which recut needs |
| `--diarize` | `diarize` | |
| `--speakers N` | `num_speakers` | 1–32; implies `--diarize` |
| `--keyterms a,b` / `--keyterms-file F` | `keyterms` (repeated form field) | ≤ 1000 terms, each ≤ 50 characters and ≤ 5 words, none of `<>{}[]\`; checked before any request. Surcharge |
| `--multichannel` | `use_multi_channel` | One speaker per channel, ≤ 5 channels; each channel billed at full duration |
| `--secondary-languages ru,de` | `secondary_language_codes` | `scribe_v3` only |
| `--language` | `language_code` | |
| `--tag-events` | `tag_audio_events=true` | |

`--output` is the transcript; the raw Scribe response is kept beside it as `<name>.scribe.json`, so a paid result is never thrown away. Both refuse to overwrite without `--force`.

**Never pay twice.** To rebuild a transcript from a response you already have (after a builder fix, or to try other flags), pass the raw file. No API key, no network, no budget entry; `--output` alone is written and the raw file is never touched:

```bash
pnpm transcribe --input recording.mp4 --from-raw pipeline/transcript.scribe.json --output pipeline/transcript.json --force
```

`--input` must be the same recording (its hash goes into `source.sha256`). `--model`, `--no-verbatim`, `--language` and `--diarize` describe how the response was made, since the raw file does not record them; a multichannel response and more than one speaker id are detected from the file.

**Budget.** Every request goes through the ElevenLabs paid boundary (`src/lib/jobs/elevenlabs-boundary.ts`): reserved before the POST, journalled per operation, resumable. The operation identity includes model, keyterms, speakers, multichannel, verbatim and languages, so changing any of them is a new operation. Billable minutes = duration × channels × 1.25 when keyterms are present, with a 20 s minimum over 100 keyterms. `scribe_v1` has no verified price and needs an explicit `--max-cost-usd`. The MCP `transcribe` tool stays blocked unless the launcher has `--allow-paid`.

### What was verified (2026-11-13)

- [API reference](https://elevenlabs.io/docs/api-reference/speech-to-text/convert): `model_id` names `scribe_v2`, `scribe_v2_medical` and `scribe_v3`; parameters `no_verbatim` (v2, v2 medical, v3), `diarize`, `num_speakers` (≤ 32), `diarization_threshold`, `keyterms` (≤ 1000, +20% surcharge, 20 s minimum over 100), `timestamps_granularity` (`word`, `character`), `use_multi_channel` (≤ 5 channels, each billed at full duration, response `transcripts[]`), `secondary_language_codes` and `numbers_format` (v3), `tag_audio_events`, `temperature`, `seed`, entity detection and redaction, `transcript_edit` (+30%). Word fields: `text`, `type` (`word`, `spacing`, `audio_event`), `logprob`, `start`, `end`, `speaker_id`, `characters`, `channel_index`.
- [Models](https://elevenlabs.io/docs/overview/models): `scribe_v3` is "our most accurate speech recognition model for recorded audio, successor to `scribe_v2`", 90+ languages, diarisation up to 32 speakers, keyterms up to 1,000, no-verbatim mode. `scribe_v1` is deprecated.
- [Pricing](https://elevenlabs.io/pricing/api): Scribe v3, v2 and v2 Medical $0.20/hour, keyterm prompting $0.050/hour, transcript editing $0.070/hour. The page states no multichannel price; the API reference's per-channel billing is used. The keyterm surcharge differs between the two pages (+20% versus +25%); the budget uses the higher. The repository's older `scribe-v2` entry ($0.22/hour, 2026-10-11) has not been changed.
- List parameters are sent as repeated form fields, as the official JS SDK does (`elevenlabs-js`, `speechToText/client/Client.ts`).

Not used yet: `diarization_threshold`, `numbers_format`, `entity_detection`, `transcript_edit`, `detect_speaker_roles`, `webhook`.

### Running the live test

Tests use mocked HTTP only (`tests/scribe-transcribe.test.ts`). To check against the real API, with a project that has a budget and `ELEVENLABS_API_KEY` in `.env`, on a short clip (a 30 s clip costs about $0.002 at list price):

```bash
pnpm exec tsx --env-file=.env scripts/transcribe.ts --project ID \
  --input public/projects/ID/assets/clip.mp4 --output public/projects/ID/pipeline/transcript.json \
  --speakers 2 --keyterms "your product name"
pnpm budget --project ID
```

Check: `ok: true`; `transcript.json` parses with `TranscriptSchema`; fillers you said appear as `kind: "filler"`; two speakers are labelled; `transcript.scribe.json` holds the raw response; the budget shows one settled operation. Running the same command with `--force` resumes the same operation instead of paying again.

## `pnpm speech:local`

```bash
pnpm speech:local --input recording.mp4 --output out/transcript.json --language en
pnpm speech:local --project ID --input recording.mp4        # pipeline/transcript.json and pipeline/speech-mask.json
```

Steps, each in its own pinned uv environment (`scripts/workers/speech-local.py`, run by `src/lib/speech/local.ts`):

1. ffmpeg renders a 16 kHz mono WAV on the source clock.
2. **Silero VAD** (`silero-vad==6.2.3`, MIT, torch 2.11.0) writes the speech mask. `--no-vad` skips it.
3. **Parakeet TDT 0.6B v3** (`parakeet-mlx==0.7.0`, Apache-2.0; weights `mlx-community/parakeet-tdt-0.6b-v3` at revision `ed2b7e8c`, CC-BY-4.0, 25 European languages including English and Russian) recognises each speech region: VAD spans with gaps under 1 s merge into windows of at most 30 s, padded by up to 0.2 s without overlapping. One pass over a whole mixed-language file dropped whole sentences after a language switch; per-region recognition did not. Recogniser artefacts are cleaned before the transcript is built: a `<unk>` token glued between words ("конференции<unk>Другая") splits them, a bare `<unk>` is dropped, and letters glued to numbers ("of40.3", "Radio4", "in2021.") split; the parts share the word's original span in proportion to their length. All-caps codes ("MP3", "4K") stay whole. Russian words glued without a space ("плохимжурналистам") are not split: that needs a dictionary. Word times come from the model's token times; a phrase's last word can end well into the following silence (0.8 s in the dialogue test), so take silence edges from the speech mask, not from word ends. Confidence is the lowest token confidence in the word. Without VAD the whole file is recognised in 120 s chunks.
4. If Parakeet cannot run (not Apple Silicon, or the environment fails), `--engine auto` falls back to the prepared whisper.cpp engine (`media:prepare --engines asr`), with a note. `--engine parakeet` fails instead; `--engine whisper` skips Parakeet. whisper.cpp recognises the whole file and, on mixed-language audio, may keep only one language.
5. **pyannote Community-1** (`pyannote.audio==4.0.7`, MIT; weights `pyannote/speaker-diarization-community-1` at revision `3533c8cf`, CC-BY-4.0) runs only when `HF_TOKEN` is set and the token's account has accepted the model's conditions on Hugging Face. Without a token, `engine.diarized` is false, speakers are null and `notes` says why; this is not an error. A refused gated download or any other failure is also a note. It runs on the Apple GPU (MPS) when available, else the CPU. `--speakers N` fixes the count; `--no-diarize` skips it.

   Words get speakers from the exclusive diarisation (no overlapping turns, built for transcripts). Parakeet stretches a turn's last word across the following silence ("…a little of it." running into the next speaker's turn), so each word is first clipped to the VAD span it starts in (or the nearest span to its start), then takes the turn it overlaps most with 0.1 s tolerance, else the nearest turn within 0.5 s. Inside a punctuated sentence, a run of at most two words labelled differently from the sentence's majority, or not labelled at all, takes the majority speaker unless a pause of 0.3 s separates it and, if labelled, its turn covers most of it. A short reply after a real pause keeps its own speaker; a stray edge word does not split a sentence.

Weights are cached under `~/.cache/agentbros/speech/hf` (override with `SPEECH_LOCAL_CACHE`). The first run downloads about 2.3 GB of weights for Parakeet and a torch environment for VAD; later runs are offline. `speech:local` is a trusted CLI, not an MCP tool.

### Measured (2026-11-13, Apple Silicon)

Synthetic clip: macOS `say` voices Samantha (English), Milena (Russian) and Daniel (English) one after another with 1.2 s gaps, 15 s in all (`RUN_SPEECH_LOCAL_TESTS=1 pnpm exec tsx --test tests/speech-local-actual.test.ts`).

- Word error rate: English 0.00, Russian 0.00 (punctuation aside). Five speech spans, four sentences.
- Warm run: 5.5–6.1 s wall for the 15 s clip (VAD 1.5–3.2 s including environment start, Parakeet load 0.4 s, inference 1.6–2.8 s).
- Cold run: the Parakeet weight download took 319 s on this network; the Parakeet uv environment took about 15 s; the torch environment's install time was not recorded.
- whisper.cpp fallback on the same clip, without VAD: only the Russian sentences survived.
- Diarisation, five alternating turns of Daniel and Samantha with 0.8 s gaps (25 s, `RUN_SPEECH_LOCAL_TESTS=1` with `HF_TOKEN`): 2 speakers, every turn labelled correctly. Warm, the diarisation step takes 6–7 s on MPS (including the uv start and model load); on the CPU the same clip took 61 s of inference. The first run also downloads the pipeline, and a first MPS run took about 18 s. Before the edge rule, the last word of turn 4 went to the next speaker; that case is a regression fixture (`tests/fixtures/speech/dialogue-diarisation.json`).
- Synthetic voices are clean studio speech; real recordings with noise, overlap and accents will do worse.

## Comparing the two on real footage (2026-11-13)

An end-to-end run on Creative Commons interviews (English two-speaker, Russian one-speaker) compared Scribe v3 with `speech:local`:

- Scribe is not deterministic: the same English audio transcribed twice gave 2095 and 2081 words and 42 and 50 fillers. Keep the `.scribe.json` of the run you edit from; do not expect a rerun to reproduce word ids.
- Scribe word starts fit speech onsets far better: 99.9% of Scribe word starts fall inside VAD speech against 96.4% for Parakeet, and the energy rise at word onsets is +3.6 dB for Scribe against −0.1 dB for Parakeet. Cut on Scribe times; with Parakeet, take edges from the speech mask.
- Parakeet in Russian agreed with Scribe on only 77.9% of words and once emitted English inside Russian speech. Parakeet is fine for a rough local pass and silence work; use Scribe for Russian captions or word-exact cuts.

## Media ingest

`media:ingest --transcript` accepts a Scribe JSON, a `TranscriptSchema` file or plain segments. Speakers survive as `segments[].speaker` (from `speaker` or `speaker_id`), grouping never joins two speakers, and spacing rows and events are dropped.
