# Audio and resource integrations

## Openverse

`resources` and music discovery share a bounded metadata client. Search supports
Openverse image/audio categories, source/excluded source, licences, image size and
aspect ratio, and audio length. Commercial and modification filters intersect;
they do not verify source rights.

```sh
pnpm resources --action search --provider openverse --kind audio --query "wood hit" --category sound_effect --length shortest --licences cc0,by --commercial
pnpm resources --action search --provider openverse --kind image --query "mountain" --aspect-ratio wide --size large --commercial
```

Optional environment credentials: `OPENVERSE_ACCESS_TOKEN`, or both
`OPENVERSE_CLIENT_ID` and `OPENVERSE_CLIENT_SECRET`. Incorrect credentials never
fall back to anonymous access. Tokens stay in memory; metadata is cached outside
the repository for 15 minutes (500 entries / 32 MiB). Source inspection and final
licence checks bypass that cache. A 429 preserves `retryAfterMs`; retry once after
that delay. Other client errors do not retry; transient failures retry once.

Candidates retain the upstream source and distinguish thumbnail from audio
preview. Openverse Freesound originals use the native API and OAuth; Jamendo
music uses the music workflow and its existing commercial policy. Unknown
originals require manual acquisition. Old candidates are re-inspected before
remote acquisition; confirming a licence cannot turn a preview into an original.
Use `--mode preview` explicitly for previews and retain the acquisition receipt.

Discovery uses [Openverse](https://openverse.org), without endorsement. Check the
original source and per-file licence; Openverse metadata is not a rights grant.
The [API implementation](https://github.com/WordPress/openverse) and
[terms](https://docs.openverse.org/terms_of_service.html) are the upstream sources.

## ElevenLabs

`pnpm elevenlabs:capabilities` returns the dated offline capability matrix. An
explicit metadata refresh can inspect models/effects; it cannot select or create
a voice. `pnpm voices --action search --query "documentary narrator"` searches
account voices; `--action shared` searches the shared library; `--action inspect
--voice-id ID` inspects one voice. These reads require a key. Availability in the
catalogue does not establish account entitlement, price or human acceptance.

| Need | Repository command | Result and ownership |
| --- | --- | --- |
| Single narrator | `generate:voiceover` | Existing scene workflow, or typed timestamped TTS request |
| Authored multi-speaker performance | `generate:dialogue` | One immutable take, character-derived word timings, speaker/scene ownership |
| Noise isolation / voice conversion | `audio:transform` | Derived take, parent hash, timing and clock review required |
| Replace one phrase in an existing edit | `speech:replace` | Reviewed take, captions and picture applied to one reversible timeline revision |
| Design / create / IVC / PVC / samples / train / readiness | `voices:manage` | Immutable lifecycle manifests; previews and pending verification are not ready voices |
| Pronunciation dictionary | `voices:manage` | Dictionary ID **and version** pinned in speech requests |
| Translate an existing recording | `dubbing` | Durable project/language binding and immutable selected audio |
| Place a selected dub into template scenes | `dubbing:conform` | Explicit source spans, MP3s and source receipts; no invented word timing |
| Existing speech/music/SFX/alignment | `transcribe`, `generate:music`, `sfx:generate`, `align:captions` | Existing budgeted routes remain authoritative |

The refreshed seven upstream [ElevenLabs references](reference/elevenlabs/README.md) are API
documentation, not skills. Their onboarding and direct SDK examples do not execute production
work. Realtime conversational agents, telephony and account onboarding are outside
this video-production integration.

### Requests and execution

New request files are strict version-1 schemas in `src/types/elevenlabs.ts`.
Outputs belong to an existing project. Inputs must be bounded regular files within
the workspace. No arbitrary API URL, executable or provider override is accepted.
For the typed commands, start with `--action plan --request FILE --project ID`.
Execution needs **both** `--action execute --dry-run=false`. Typed
`generate:voiceover --request FILE` instead needs `--dry-run=false` explicitly.
The existing scene-generation CLI retains its established execution behaviour;
use `--dry-run` when planning it. MCP defaults to plans and checks paid permission.

```json
{
  "version": 1,
  "task": "tts",
  "projectId": "demo",
  "output": "public/projects/demo/voiceover/intro.mp3",
  "voiceRef": {
    "provider": "elevenlabs", "voiceId": "SELECTED_VOICE_ID",
    "model": "eleven_multilingual_v2", "language": "en"
  },
  "model": "eleven_multilingual_v2",
  "language": "en",
  "text": "A reviewed line of narration."
}
```

A VoiceRef can be stored in `pipeline/script.json` and/or
`pipeline/narrator-direction.json`; conflicting references or overrides fail.
A lifecycle voice additionally pins `manifest` and `manifestSha256`. It must be
ready for the exact selected synthesis model. Existing named voices remain
supported. Models are explicit (`eleven_multilingual_v2`, `eleven_v3`,
`eleven_v4`, `eleven_flash_v2_5`); existing directions retain their model.
See [ElevenLabs speech](elevenlabs-speech.md) for v4 directions, clone
acceptance, generated shots and phrase edits.

Character timing becomes the canonical `{words: [{text,start,end}], ...}` sidecar
only when text and duration checks pass. Its receipt records that words were
**derived from provider character alignment**. Missing alignment can be recovered
from the cached take without another paid request. Corrupt immutable sidecars
fail. Do not run paid forced alignment again when valid source-bound timings
already exist; caption editing is still a separate creative step.

Transform requests use `task: "isolate"` and `source`, or `task: "voice-change"`
with `source`, `voiceId` or `voiceRef`, `model` and `language`. The direct
Voice Changer route also takes `removeBackgroundNoise`, `seed` and
`outputFormat`. Preserve the original recording.
Every derived take requires a new alignment/clock review, including equal-duration
outputs. Do not reuse a recording's transcript clocks merely because processing
preserved the apparent length. The optional fal transport uses the existing
promoted adapter/executor and fails closed if unavailable; there is no silent
provider substitution.

`voices:manage` supports `design`, `create-designed`, `clone-instant`,
`clone-professional`, `add-samples`, `train`, `dictionary`, `refresh` and
`adopt`. The provider's
preview ID is not a permanent voice. Cloning/training requires supplied rights and
consent evidence; agents cannot supply or perform the person's verification.
Professional training polls the **requested model**. `refresh` reads current
readiness into a new manifest after external verification, without modifying the
previous manifest. Select a voice only after the user has listened to it.

Every new paid operation reserves through the existing project budget before
submission. Unknown prices require an authorised positive `maxCostUsd`; this is
a planning bound, not a provider billing cap. Requests and raw responses are
journalled outside public media (`.cache/paid-responses/<project>`). Cache paths, including existing symlink ancestors, are checked before reservation/submission. Speech receipts retain the exact provider model, voice/pin and validated request separately from the pricing key. Repeating the same operation replays/resumes;
ambiguous submits stay unknown and are not sent again. Report actual settlement
separately: a published file does not establish the provider's billed cost.

### Dubbing and localisation

Use the Projects API through `pnpm dubbing`, never legacy bare `/v1/dubbing`.
A `create` request supplies `source`, `sourceLanguage`, `targetLanguage`, project,
new WAV output and an authorised bound. Creation pays for its explicitly chosen
first language once. Keep the binding and operation ID for retries; adding a
language and regeneration are distinct operations with separate reservations.
`--action status --operation-id ID` is local; `--action sync --binding FILE
--dry-run=false` explicitly refreshes remote metadata without submitting work.

Enterprise supplied transcripts are canonical TranscriptSchema files, verified
against source hash/duration and converted to the provider's segment contract.
Translations must cover the exact canonical segment IDs. Edits require Enterprise
entitlement and `expectedRevision`; source edits stale every target, translation
edits stale that target, and regeneration uses a reviewed stale target revision.
The selected snapshot pins source, language, source revision, target/output revision
and SHA-256. Stale or changed selections fail localisation readiness.

The provider's lossless download is conformed from FLAC to PCM WAV. Signed URLs
are refreshed after download failure, and their requests never receive API keys.
Provider WebVTT is timed to **source speech**, not dubbed word timing. Align the
actual new performance before captions. Human translation and listening review
remain required.

To use a selected dub in template scenes, supply explicit reviewed spans:

```json
{
  "version": 1, "projectId": "localised",
  "binding": "public/projects/source/ru.wav.dubbing.json",
  "targetLanguage": "ru",
  "clips": [{"sceneId": "intro", "startSec": 0, "endSec": 3,
    "output": "public/projects/localised/voiceover/intro.mp3"}]
}
```

`pnpm dubbing:conform --project localised --request conform.json` plans locally;
`--dry-run=false` materialises new immutable files and `.dubbing-source.json`
receipts. It does not choose edit points. Align those files and supply the binding
as `dubbing: {binding, language}` in `campaign --action localize-review`'s manifest.
Review checks the target language and proves each renderer audio file's relation
to the selected dub (exact hash or the conformance receipt), along with the
existing per-scene audio/word/reviewer checks. Production render rechecks the
observed binding and hashes offline. Refresh remote state before review or delivery;
no offline check can detect a remote edit that has never been synchronised.

## Optional Earshot engine

Pinned Earshot commit: `4ac3d2ac2b151e1c23376f9ce7f3047a17050013` (v0.4.1 Alpha).
The wrapper exposes the shipped 252-sound bank, semantic source-segment search and
advisory artifact checks. Existing library CLAP search, native synthesis, cue
budgets, intentional silences, masking, mixing and final audio QA remain in use.
No arbitrary forge recipes, Python modules or user bank overrides are accepted.

Preparation is explicit and CLI-only; production tools never install packages or
fetch models. Preparation uses Python 3.12.16, exact runtime dependency pins and a
private environment. Semantic search uses only
`laion/larger_clap_general` at safetensors revision
`16c8cc3159a3c8a31e8ff5ef1f66b0d9ab3667db`. AST was not adopted. Models and code
have separate licences; a code licence does not grant rights to source recordings.

```sh
pnpm media:prepare --engines earshot-bank --allow-download
pnpm media:prepare --engines earshot-find --allow-download
pnpm sfx:synth --engine earshot --list
pnpm sfx:synth --engine earshot --project demo --bank-id whoosh_fast/crisp --kind whoosh --duration 0.8 --apex 0.32 --align peak --seed 19 --output public/projects/demo/sfx/whoosh.wav
pnpm sfx:find-segment --input public/projects/demo/recording.wav --query "a short click" --start 4 --end 6 --top 3
pnpm audio:review --input public/projects/demo/sfx/whoosh.wav --project demo --output public/projects/demo/pipeline/whoosh-review.json
```

Search safe-decodes local media to bounded PCM with network protocols forbidden,
preserving the container clock and delayed audio. Only supported self-contained containers are accepted; playlists/external segment references cannot stand in for source bytes. Reports retain the preprocessing version. Returned segments use original
source seconds, including when a subrange is requested, and retain the source
hash, model revision and preprocessing identity. Maximum analysis span is 600
seconds; longer material needs explicit ranges. Model scores propose selects;
they do not approve a cut or prove semantic correctness.

Bank synthesis creates a deterministic immutable take with seed, package pin,
source provenance, independently measured loudness and onset/peak/end. Set `--kind`
to its existing cue family and choose `--align onset|peak|end`. Pass selected take
receipts to `sfx:cues --earshot-takes FILE1,FILE2`; the current planner still owns
placement, layers, limits, silences and gain. Fitted bank sources keep their
licence evidence and require source-rights review; procedural synthesis records
its generator separately. Do not infer rights from the package's MIT licence.

`audio:review` is advisory, especially useful for individual candidate SFX. It
includes independent measurements and retains the exact source hash. It is not a
whole-film aesthetic verdict, a replacement for existing final-mix checks, or a
blocking QA gate. Agents cannot hear and must not claim that its score proves a
sound or film sounds good. Attach relevant saved reports to the sound brief/QA
evidence (`critic:pack --audio-review FILE` includes a report only when its source
hash matches the current render or a selected cue sound); do not run the semantic model by default for every production step.

In the production flow (`sfx:audition`, measured cue leads, saved audits as evidence, `sfx:map`, a chosen room-tone span): [Earshot in the production flow](earshot-flow.md).

Local synthetic validation and mocked provider contracts are recorded in
the final integration report.
Live paid-account acceptance and human creative acceptance remain distinct.


Maintainer validation: `tests/{openverse,elevenlabs-studio,elevenlabs-dubbing,audio-integration-contracts,earshot,earshot-integration,campaigns}.test.ts` runs offline by default. `RUN_EARSHOT_TESTS=1` enables already-prepared local model tests; `RUN_AUDIO_INTEGRATION_RENDER=1` enables `audio-integration-render.test.ts` with synthetic speech, offline fixture fonts and no external API calls.
