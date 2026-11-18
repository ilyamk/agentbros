# Local macOS tools

Last updated: 2026-11-15

Optional Apple backends are discovered per task, language, operation and installed resource. They run through trusted local CLIs, never during a Remotion render. No Apple cloud model, screen recorder, administrator operation or system-setting change is part of this integration.

## Discover and prepare

`pnpm preflight` reports ready native tasks after installation. Ordinary `pnpm commands` hides unprepared Apple-only commands; `pnpm commands --all` and this guide retain the full catalogue. Existing multi-engine commands stay available. A next-step answer adds only relevant ready tools and at most one preparation/action hint.

```bash
pnpm local:capabilities --task speech.transcribe --language en
pnpm local:capabilities --task text.translate --source-language ru --target-language en
pnpm local:capabilities --all --refresh
pnpm media:prepare --engines apple-text,apple-speech --language en --dry-run
pnpm media:prepare --engines apple-text,apple-speech --language en
pnpm media:prepare --engines visual,category
```

Preparation domains: existing `asr` (whisper.cpp), `ocr`, `matte`; `visual`, `category`; and `apple-speech`, `apple-text`, `apple-translation`, `apple-tts`, `apple-audio`, `apple-vision`, `apple-foundation`. The default remains `asr,ocr`; a task prepares only its dependencies. A custom `--output-dir` places Apple state in its `apple/` subdirectory. The normal shared cache override is `AGENTBROS_MODEL_CACHE`.

The static registry is the source for help/docs/MCP exclusions; runtime filtering does not rewrite package aliases or instructions. A probe does not compile, generate, download or prompt. Successful diagnostics (`ok:true`) can contain unavailable capabilities. Supported request revisions are not inference or creative-quality acceptance.

| State | Orchestrator action |
|---|---|
| `ready` | Use the matching task; validate its result |
| `needs_prepare` | Run the supplied literal argv for the trusted preparation command |
| `needs_download` | Prepare only if download policy allows |
| `needs_user_action` | Ask for the named setting/permission/choice, or select an allowed alternative |
| `unsupported` | Exclude this backend for this task/language |
| `temporarily_unavailable` | Retry boundedly after refreshing, or use an alternative |
| `unknown` | Do not advertise a runnable variant; inspect the reason |

Status caches expire after five minutes for successful probes and one minute for unavailable native probes. Execution rechecks the runtime regardless of the catalogue cache. Worker source/binary, host and effective voice/operations contribute to identity. System-managed model weights are not individually hash-pinned.

## Policy and user actions

```bash
pnpm local:policy --mode interactive --downloads task
pnpm local:policy --mode autonomous --downloads never
```

Defaults are `interactive` and task-scoped downloads. `ask` requires an explicit user decision before missing resources can be downloaded; `never` uses installed resources only. The orchestrator, not the CLI, asks the question. `AGENTBROS_INTERACTION_MODE` and `AGENTBROS_LOCAL_DOWNLOADS` are explicit launch overrides; a TTY is not an interaction policy. After explicit user consent, `media:prepare --allow-download` authorises only that preparation; it does not change the saved policy. The policy also applies to uv/Parakeet/Silero/pyannote in the reused speech pipeline: non-task mode passes offline flags to uv and Hugging Face.

Autonomous agents may compile repository workers and prepare authorised free task resources. They never accept legal terms, run sudo, install system software, enable Apple Intelligence or approve a creative result. When a human action is necessary, autonomous execution uses an allowed ready alternative or returns a blocker without waiting for stdin. An explicit backend or voice is never silently replaced. No automatic paid fallback exists.

Apple Speech model installation uses the public `AssetInventory` API. Headless Translation only uses installed language pairs; a missing pair requires System Settings > General > Language & Region > Translation Languages. A missing system voice requires a user-selected download in Accessibility > Spoken Content. Foundation Models uses the Swift `SystemLanguageModel` API; CLI `fm` licence state is separate and no `fm license` command is run.

## Task commands

```bash
pnpm speech:local --engine apple --language en --input recording.mp4 --output out/transcript.json
pnpm text:analyse --input script.txt --language ru --output out/text-analysis.json
pnpm text:translate --input translation-request.json --output out/translated.json
pnpm voiceover:local --input voice-request.json --voice com.apple.voice.compact.en-US.Samantha --output out/voice.json
pnpm voiceover:local --project example --language en --dry-run
pnpm audio:events --input recording.mp4 --output out/events.json
pnpm media:vision --input recording.mp4 --features faces,people,pose,saliency,quality,tracking --output out/vision.json
pnpm photo:focus --input photos --output out/focus.json --detector vision
pnpm reframe:track --input recording.mp4 --output out/crop.json --detector vision
pnpm text:assist --input notes-request.json --language en --assist-task shot-notes --output out/notes.json
pnpm image:describe --input frame.png --language en --output out/description.json
```

Apple Speech requires macOS 26 and a supported locale. It produces the existing TranscriptSchema and retains the Silero/pyannote layers when requested. Native word timing is claimed only when each word has its own attributed audio range; phrase-distributed times are `estimated`. Verbatim fidelity is not established, so removing every filler must retain the existing suitable transcriber route. The `auto` speech engine prefers Apple only with fresh production qualification for that task/language; otherwise it retains Parakeet/whisper.cpp.

Natural Language outputs exact UTF-16 spans and language hypotheses, without rewriting source word IDs/times. Available entity and lemma schemes are checked separately per language. Operations can be restricted with `--operations language,sentences,tokens`.

Translation, TTS and text assistance take versioned text units:

```json
{"version":1,"kind":"captions","sourceLanguage":"ru","targetLanguage":"en","protectedTerms":["Remotion"],"units":[{"id":"cue-1","text":"Мы используем Remotion для 3 сцен.","startMs":0,"endMs":3000}]}
```

Kinds are `text`, `scenes` or `captions`; unit IDs must be unique. TTS/assistance use `sourceLanguage`; translation also needs `targetLanguage`. Caption translation writes SRT/VTT alongside the JSON, preserving source cue intervals, not source word times. New speech needs new alignment. Scene translations are candidates to supply to the existing campaign/localisation request: retain scene IDs, populate all translated fields and keep `localize-review`, audio-staleness and alignment checks. Translation does not approve or apply a campaign.

TTS defaults to draft output beside the result JSON, separate from canonical `voiceover/<scene>.mp3`. The result can be deliberately referenced for a preview; delivery refuses referenced draft assets. For bespoke films, declare every referenced native asset path, including imported copies, in `build.json` under `localAssets` (`[]` when retained drafts are unused); delivery snapshots bind their source inputs and receipts. The user judges the voice/performance. Explicit `--purpose production` requires task/language/voice qualification and still does not approve the film. No paid voiceover or alignment is invoked.

Sound Analysis emits native classification windows with taxonomy and scores; it does not approve SFX or music. `audio:describe` remains the CLAP similarity/mood alternative. Vision's general command analyses up to 32 one-second samples; these are advisory, not exact edit boundaries. `reframe:track --detector vision` uses decoded frame indices and refuses VFR sources requiring normalisation. Photo/reframe defaults remain OpenCV. Flow output is separate float32 little-endian XY data with dimensions, current-to-previous direction and frame-pair identity. New saliency/aesthetics scores are advisory, never uncalibrated blocking sensors.

Foundation Models has no tool execution. It produces structured, source-ID-bound candidates for summaries, tags, chapters, shot notes and supported image descriptions. It rejects unsupported languages and oversized source units rather than truncating them. Split long text into bounded source units before calling it. The current agent is an alternative when a local language/modality is unavailable. Image capability is checked independently of text capability.

## Evidence and qualification

Results retain source hashes, effective parameters, worker/runtime identity, output hashes, draft/production purpose and validation warnings. Inputs are immutable; output collisions are refused even with `--force`. Normal asset import and cross-project reimport preserve native draft/production provenance in the asset record. Binary outputs and receipts use immutable per-generation directories; a failed forced rerun cannot remove an earlier valid take. No binaries/models are committed.

```bash
pnpm local:verify --task speech.transcribe --language en --suite smoke --input recording.wav
pnpm local:verify --task speech.transcribe --language en --suite quality --benchmark benchmark.json
RUN_APPLE_TESTS=1 pnpm test:apple
```

A smoke run checks actual execution and structural validation; it cannot qualify production. A quality benchmark contains `version:1`, `task`, `language`, optional exact `voice` (required for TTS quality), a `licence` declaration and at least three `cases`. Each case pins `input`, `reference` and `baseline` with absolute `file` and `sha256` fields. Reference annotations and baselines must be independently reviewed. No model self-rating or supplied `passed` flag is accepted.

Speech references and baselines are TranscriptSchema files with ground-truth words/onsets. Candidate WER and matched-word onset p95 must be no worse than baseline, and timing must be native. Other task references must pass complete task-specific result schemas with substantive observations; empty objects or metadata-only references are rejected. Exact reference conformance and non-regression against baseline are required. This is corpus conformance, not proof of general creative quality. Keep existing audio/translation/final approvals. Qualification expires after seven days and is invalidated by observable runtime/voice/operation changes.

Ordinary tests use fake probes, pinned data and temporary workspaces. Actual tests are gated, do not use user projects or provider keys, and never download missing language models. Missing hardware/resources are reported as skips. For permission/download failure paths, use the deterministic contract tests; do not remove a user's installed system models just to exercise an error.

## Platform references

- [SpeechTranscriber](https://developer.apple.com/documentation/speech/speechtranscriber) and [AssetInventory](https://developer.apple.com/documentation/speech/assetinventory).
- [Translation download restrictions](https://developer.apple.com/documentation/translation/translationsession/canrequestdownloads).
- [Natural Language](https://developer.apple.com/documentation/NaturalLanguage), [Sound Analysis](https://developer.apple.com/documentation/soundanalysis) and [Vision](https://developer.apple.com/documentation/Vision).
- [Foundation Models language support](https://developer.apple.com/documentation/foundationmodels/supporting-languages-and-locales-with-foundation-models).

Agent selection and full producer-to-consumer behaviour need separate evaluation: the existing native smoke tests do not establish that coverage.
