# ElevenLabs speech

Use these workflows with the [audio integrations](audio-integrations.md#elevenlabs)
request and budget contract.

## Model and voice settings

v4 TTS uses `stability`, `similarity_boost` and optional PVC `clone_strength`.
v4 Dialogue uses `settings.similarity` for the same control. v3/v4 use bracketed
audio tags and natural punctuation for delivery. v4 Turbo is listed as a
single-voice realtime Dialogue WebSocket capability. Batch film tools use HTTP.
Typed speech supports `textNormalization`, up to three versioned
`dictionaries`, seed, effects, and MP3 or `wav_44100`. The latter and
192 kbps MP3 depend on account entitlement. Match the output file extension.
v4 supports inline IPA and dictionary phonemes and aliases. On a directed
line, `pronunciations: [{start, end, ipa}]` replaces an approved word in
the synthesis input and retains its spelling in the original alignment. Record an
`expectedSpokenText` separately when normalisation changes the surface form.
Use fresh same-model history IDs for stitching. Provider history must be on.
Dialogue uses v4 or v3 with up to ten voices and 2,000 characters per reviewed
batch. Each turn supplies `text`, a `voiceId` or `voiceRef`, `speaker` and
`sceneId`. For video-bound turns also supply `lineId` and `approvedText`. Dialogue timing is
matched using provider character indices and turn ownership; ambiguity leaves
alignment pending.

## Voice clone acceptance

Use `adopt` for a PVC the actor created, verified and shared privately from
their account. Pass its ID, model, language and consent. Sample plans report
format, duration, peak and silence; listen for other speakers, room noise
and consistent delivery. For calibration, create four immutable takes
for the exact model, voice and language. Cover neutral delivery, a
characteristic emotion, a short line and a pronunciation case. Run
`voices:manage --action approve --request FILE --project ID --answer WORDS`
with the user's decision and the four receipt pins (`use`, `receipt`,
`sha256`). Carry the returned file and digest in the `VoiceRef` as
`selection` and `selectionSha256`. The voice's readiness manifest remains
separate. Use the chosen clone only for covered purposes.

## Speech in generated shots

Add a stable `lineId` to each approved `script.json` dialogue line, with
`speakerId`, `sceneId`, `language`, `text` and the selected `voiceRef` when
synthesis will supply the voice. Approve the words before directing them.
Use one v4 dialogue take for exchanges that need continuous timing, or a
single-line TTS take for an isolated action. Carry its stable line and speaker
IDs into the take, and keep the character-alignment sidecar.

Use a pack attachment's optional `speech` field for a `voice-sample` or
`environment` reference. For actual dialogue attach the take's registered
asset with the following proof and shot-relative placement.

```json
{
  "kind": "performed-lines",
  "use": "reference",
  "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "receipt": "public/projects/demo/voiceover/scene.mp3.take.json",
  "receiptSha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "lines": [{
    "lineId": "radio-1", "speakerId": "host", "language": "ru",
    "text": "Ты меня слышишь?", "startSec": 2, "endSec": 4
  }]
}
```

- **Reference guidance.** Seedance binds `use: "reference"` to the ordered
  `audio_urls` slot. The compiler writes the actual marker such as
  `@Audio2` next to the line, speaker and window. Review what the model said.
- **Speech-driven picture.** Bind `use: "drive"` on OmniHuman 1.5
  (`image_url` and `audio_url`) or Sync 3 (`video_url` and `audio_url`).
  The audio carries the words. The visual prompt gives movement and camera
  direction on an endpoint that accepts a prompt. Sync 3 keeps the text for
  review in the pack and receives the audio and video URLs. On a fresh checkout,
  cache the exact endpoint schema with `pnpm fal:sync --schemas ENDPOINT` before
  planning.
- **Native speech.** Put the same line objects in `nativeSpeech` and set
  `audioPolicy: "native"`. Listen for exact words and speaker and inspect
  the result against the requested interval.

Use `audioPolicy: "replace-in-edit"` when mounting the approved take as the
audible source. Mute or remove embedded speech during that edit. Use
`reference-driven` when the generated result owns the sound. Keep the policy
explicit in campaign material as well. Use the pack's prepared request and
record each result review's `speech` entries for words, speaker and sync.

## Replace a line in an edit

Use a project with an initialised `timeline:edit` journal. The source
transcript must pin the source bytes and contain native word times. Check
local speech transcripts by ear for fillers and short words. Select by
`range: {firstWordId, lastWordId}` or output `range: {startFrame, endFrame}`.
Frame bounds are half-open. Set `revision`, `trackId`, `clipId`,
`sourceSha256`, `sourceTranscript: {file, sha256}`, approved new text and
language. Declare whether original audio is isolated dialogue or room tone
that the reviewed cut may replace.

| Case | Request fields |
|---|---|
| Keep what was said and its delivery | `method: "voice-change"`, multilingual STS `voiceRef` |
| Speak a changed line | `method: "tts"`, v4 `voiceRef`, optional `directedText` |
| Use an already-recorded line | `method: "existing"`, `performance: {file, sha256}` |
| Convert the speaker of a separately recorded line | `method: "voice-change"` with a pin to the new `performance` |

Set `picture.mode` to `offscreen` for voiceover, or `unchanged-lips` for
the same words within one frame of their original boundaries. With a visible
mouth and changed words, supply a separately reviewed `cutaway` or
`lip-sync` picture with its imported `assetId`. If another caption track
owns the old words, supply `captionTrackId`.

1. Run `pnpm speech:replace --project ID --request FILE --action plan`.
2. After permission, use `--action prepare --dry-run=false` and the authorised
   `maxCostUsd`. For an existing performance, go directly to status.
3. Run `--action status --preview`, passing `--alignment FILE` for a native word-time
   transcript of the new take when it lacks usable timing. Preview the join,
   picture and captions. Pass the returned `--review-sha256` and
   `--answer WORDS` to `--action apply` after the user approves.
   If a take overruns the window or the user rejects it, increment `take`
   and re-authorise any paid preparation. The rejected take stays available.
4. Use the journal revision for rendering and rebuild any project audio
   master. Use `timeline:edit` for undo. The original remains in the registry.

## Separate integration work

- Evaluate Music v2.5 through the existing durable route with a structured
  composition plan. Pin any uploaded reference and verify section timing,
  cue boundaries and licence before changing production defaults.
- Add SFX prompt influence and loop controls to the promoted SFX v3 route
  after confirming its wrapper schema and testing exported loops.
- Add Voice Remixing as a preview-and-select operation with separate
  provenance. Add language and accent filters to voice discovery.
- Evaluate the direct ElevenLabs Video provider by comparing the same
  approved speech asset on its audio-driven endpoint and the existing fal route.

## Live acceptance

Use a separate project with the user's budget and approved voices.
Prepare a Russian and English monologue, a two-character exchange using
distinct voices, an instant clone and a verified PVC. Include a shot with
an audible scripted phrase and a one-line edit in a recording. Preserve
the approved text, take receipts, word clocks, pack output and timeline
revision. Listen to both word accuracy and delivery. Watch the visible
mouth at normal speed and across the seams of the edit. Verify undo
restores the original. Record per-route first-take acceptance, rejection
reasons and reconciled costs with the review. The offline contracts prove
request and editing behaviour independently of the listening pilot.
