# Recording edit implementation plan

Status: implementation plan and contract of `recut:plan` and `video:workflow --scenario recording-edit`, kept current with the code (last changed 2026-11-13). The route for a user's recording, in order: [footage editing](../footage-editing.md).

Goal: turn supplied recordings and frame-aligned transcripts into reproducible, reviewed recuts without regeneration or destructive changes.
Assumptions: version 1 accepts 30fps constant-frame-rate video with one synchronized audio stream. Version 2 accepts rational and variable frame rates through explicit reviewed local normalization; no silent conversion. A recording-only profile explicitly retains authentic speech and needs no synthetic voice/music.
Success: pure planning, immutable source/hash and context-bound review, atomic new-project publication, exact synchronized video/audio/caption spans, reversible timeline commands, local tests and actual ProductionRoot render evidence.
Steps: validate source and transcript/semantics; produce review identity and source mappings; stage immutable full video and PCM audio plus canonical project/timeline; commit new project under exclusive lock; verify negatives, undo, browser render and original preservation. Human meaning/rights/pacing/crop review remains required.

## Contract and use

`runRecordingEditWorkflow(request, {action: 'plan' | 'create', rootDir?, scopeRoot?})` is local only. Trusted MCP callers pass `scopeRoot`; every original is resolved through realpath and must remain inside that scope. Normal CLI callers can explicitly supply original files outside the repository. Root orchestration exposes this module through `video:workflow`, whose stdout line replaces the per-frame source boundaries and per-span word lists with `boundaryCount` and `wordCount` (the full metadata is in `pipeline/recording-edit.json` after create); direct use does not require that integration:

```ts
const planned = await runRecordingEditWorkflow(request, {action: 'plan'});
// A human watches the complete source, verifies transcript, context, cuts and rights.
// Only that person supplies review {reviewer, reviewedAt, meaningPreserved:true,
// approvedEditHash:planned.metadata.editHash} in the request.
const created = await runRecordingEditWorkflow(reviewedRequest, {action: 'create'});
```

`examples/workflows/recording-edit/prepare-local-example.ts` produces a 3-second **synthetic test chart and tone**, an unapproved request and review hash. Run `pnpm tsx examples/workflows/recording-edit/prepare-local-example.ts .cache/recording-demo` once in a fresh directory. It refuses overwriting its recording. The fixture's Russian word timings are test declarations, not an ASR transcript or evidence of actual speech. Replace them with supplied reviewed transcript timings for actual recordings. No review declaration is auto-filled.

Request fields: `version:1`, `workflow:'recording-edit'`, new `projectId`, `name`, `profile:'recording-only'`, requested `formats`; `source:{file,sha256,version,fps:{num:30,den:1},rights?}`; `transcript:{version,language,words:[{id,text,startFrame,endFrame}]}`; chronological `keepSpans:[{id,startFrame,endFrame,reason}]`; `cuts:[{startFrame,endFrame,reason}]` covering **exactly** their complement; `protectedSpans:[{startFrame,endFrame,kind,reason}]`; `revision:1`; optional human `review`. All intervals are half-open source **integer frames**, never approximate seconds. Calculate originals' SHA256 with `shasum -a 256 recording.mp4`. Version 1 JSON rejects unknown fields, fractional frames and non-30fps input. Its parsing, edit identity and materialization remain compatible.

## Explicit rational/VFR normalization (version 2)

Use `version:2` and the following source fields for actual 30000/1001 or VFR recordings:

```json
{
  "fps": { "num": 30000, "den": 1001 },
  "normalization": {
    "targetFps": { "num": 30, "den": 1 },
    "video": "timestamp-near",
    "boundaryRounding": "nearest",
    "keepRounding": "outward",
    "audio": "preserve-clock"
  }
}
```

For VFR, `source.fps` declares the probed `r_frame_rate` nominal rate, **not** an invented constant clock or `avg_frame_rate`. All request intervals still index half-open decoded-original frames. The time of frame `i` is its decoded PTS times the exact stream timebase; the terminal boundary is checked against the measured stream duration and final decoded frame duration. Frame indices divided by 30 or by nominal fps are never used for VFR timing.

Plan reads actual picture and authentic audio sample clocks but performs no conversion and creates no directories. It returns original PTS boundaries, mapped selections and a source/policy/PTS/FFmpeg-version-bound `editHash`. To create, supply a new review against this hash. Modifying the normalization, source bytes, transcript or edits requires a new review.

Create imports the immutable original, then makes a separately registered 30fps H264 picture derivative and 48kHz PCM authentic audio. FFmpeg's `fps` filter rounds **timestamps** with `round=near`; this does not promise optical nearest-frame selection or interpolated motion. Dropped and repeated decoded frame ownership is retained in the report. Speech uses its original continuous sample clock, rate 1 and one owner; no time-stretching, synthesized voice or gain adjustment occurs.

Kept audio/picture intervals round outward: start=floor(original PTS×30), end=ceil(original end PTS×30). This fully covers surviving supplied words and protected groups. Caption boundaries round to the nearest 30fps frame with a maximum half-frame timing quantization. Outward keeps may add less than one frame at each boundary; they must not overlap another keep or include an excluded supplied word/protected group. Unsafe boundaries fail with a request to move the cut into silence or merge adjacent keeps. Word intervals that collapse under caption quantization fail instead of dropping words. Source video/audio endpoint disagreement is bounded to one frame, and the ceil extension adds less than one frame. Every retained supplied word must end within both the declared audio duration and actual decoded audio sample clock (only sample/timestamp precision is tolerated). Missing tail speech is rejected; terminal silence cannot stand in for a retained word. The report records the original endpoint gap and master extension separately. The full master ends at ceil(measured original duration×30), with an explicit terminal pad/trim bound of two frames (66.7ms) for audio and a final-frame picture hold; speech playback speed remains unchanged.

`recording-edit.json` version 2 retains the original `sourceAssetId`, separate `normalizedVideoAssetId`/hash, audio asset/hash, source-to-master and keep-to-output mappings, exact original times, policy, tool version, PTS hash, per-master-frame decoded source ownership, repeat/drop counts and terminal adjustments. The uncut timeline explicitly labels its coordinates as `normalized-30fps-master`; decoded-original indices stay in the request and mapping report. Undo and synchronized timeline edits use master coordinates. To restore the complete original selection, create a newly reviewed request `[0, sourceTiming.decodedFrameCount)`, rather than interpreting the derivative frame count as original input.

Normalization accepts one video and one authentic audio stream, zero start offsets, monotonic finite decoded picture PTS and continuous decoded audio sample PTS. Nominal rates are bounded to 1–120fps, decoded frames to 216000, duration to 30 minutes, dimensions to a 4K frame and normalized output to 54000 frames. Ambiguous final durations, audio gaps/offsets, insufficient audio, unsafe quantization, multi-stream inputs and unbounded media fail closed. Originals are preserved even if conversion fails.

Plan performs checksum, source-stream/frame-timestamp and context checks but creates no files, even when approval is absent. It returns mapped words, output offsets, exact duration and `editHash`. Hash binds source/version, full transcript including removed context, rights, all selections/reasons/protections, project identity and revision. Any altered decision invalidates approval. A declared review means only that a named human made the supplied declaration; the program cannot independently verify human identity or semantic quality.

Protected semantic groups are indivisible: if any part survives, the complete group must fit one kept span. A wholly irrelevant group can be removed by an explicitly reasoned cut covering the complete group and bound to the same human review hash. Negations and common caveat markers in Russian/English require declared protection; heuristic detection is an additional guard, **not** a complete language/meaning classifier. Explicitly include whole statements, attribution and surrounding context in groups. Statements with no recognized marker still require human semantic review. Reordering, speech speed changes, generated replacement words and automatic silence deletion are deliberately absent.

## Proposed recut from a transcript (`recut:plan`)

`pnpm recut:plan --transcript pipeline/transcript.json --project-id <new-id> [--speech-mask pipeline/speech-mask.json]` reads a `TranscriptSchema` file (from `transcribe` or `speech:local`) and the source video it names (checked by SHA256), and writes `recut-request.json` (a version 3 request with no review) and `recut-plan.md` next to it. It never approves anything: a person watches the whole source, reads the plan and adds `review.approvedEditHash` (the plan prints the hash). For a transcript that is not verbatim (`speech:local`), the plan also lists likely fillers the engine did not mark: standalone "ну", "э", "эм", "вот", "um", "uh", "er", "erm", "hmm" with 150 ms of pause or punctuation on both sides. The list is for the reviewer only; it changes no cut, request or edit hash.

The speech mask is optional evidence from a voice activity detector: the `pipeline/speech-mask.json` that `speech:local` writes (`SpeechMaskSchema` in `src/types/speech-mask.ts`: unpadded `{startSec, endSec}` spans). Its source SHA256 must equal the transcript's, or the command refuses it. The mask is used raw: cut points must be at least 10 ms clear of a detected span, and recut:plan adds its own phrase padding. The command also measures the source audio level.

What it proposes, each cut with its reason, evidence and the words around it:

- **Fillers**: only words the transcript marks `kind: "filler"` (a verbatim engine), never a backchannel from another speaker (a filler whose speaker differs from both neighbours). A filler is speech, so the VAD mask does not judge it. Its cut points are the quietest frame boundaries between the neighbouring words, reaching up to 60 ms inside the filler's ASR edges (the removed word's frames are clamped into the cut). Both must be quiet: 18 dB under the median word level, or within 6 dB of the room's floor (20th percentile of the gaps) while at least 10 dB under speech, and never above −30 dBFS. A frame layout must also leave room for the crossfade. Without audio levels the transcript gaps decide (at least 30 ms each side).
- **False starts and retakes**: one rule. An earlier attempt is removed only when it is abandoned: it repeats the restart word for word with a pause of at least 120 ms before the restart, or it is visibly cut off (ends in a dash or ellipsis, or a filler sits in it). An attempt that continues with different words after the shared opening ("sometimes they're more frequent, sometimes they're more intense") is a parallel structure and is kept; it is listed once. A whole sentence can be the attempt when the next sentence restarts it. Retake cut points meet the same level bar as fillers. An attempt containing a negation, caveat or attribution is left for review.
- **Pauses**: gaps over `--long-pause-ms` (600) are shortened, never deleted, to `--mid-pause-ms` (250) inside a sentence or `--sentence-pause-ms` (400) after terminal punctuation or a change of speaker, split between `--post-pad-ms` (200, 150–250) after the phrase and `--pre-pad-ms` (120, 80–150) before the next. A pause in which the VAD hears speech is kept. Leading and trailing silence are trimmed to the pads.
- **Protected spans**: sentences come from the transcript (split on terminal punctuation or a 1 s pause if it has none); every sentence with a negation, caveat or attribution marker (a superset of the workflow's own list) is one protected span, so nothing inside it is cut (fillers in it stay); a restarted sentence is protected from the restart. Words are never moved, so no new sentence is spliced and nothing is reordered.

Word times become decoded source frames (nearest boundary, kept in order); cuts round inward into silence. A 30 fps constant-rate source gets a plain source block; any other rate gets the version 2 normalisation policy. At most 200 kept spans: the smallest pause cuts are deferred first, then the smallest filler cuts; if retakes alone need more, split the recording. To reject cuts, run again with `--reject C3,C7 --force`; ids are stable. The command checks its output through the workflow plan before writing.

## Joins (version 3)

Version 3 is version 1 or version 2 (either source block) plus a required `joins` policy:

```json
"joins": {
  "crossfadeMs": 15,
  "curve": "equal-power",
  "snap": { "energyWindowMs": 10, "searchMs": 30, "zeroCrossingMs": 5 },
  "roomTone": { "startFrame": 83, "endFrame": 91, "gainDb": -6 },
  "punchIn": { "scale": 1.12, "pattern": "alternate" }
}
```

`roomTone` and `punchIn` may be `null`. `crossfadeMs` is 5–50, `searchMs` 0–33, room tone gain −60–0 dB, punch-in scale 1.0–1.2. `recut:plan --room-tone` picks the quietest span between words; `--room-tone-span START:END` uses a chosen one (for example a listened-to `sfx:find-segment --kind texture --query "quiet room tone"` candidate) only when it passes the same tests: inside the recording, at least 300 ms and 3 frames, no detected speech, no transcript word.

Plan decodes the authentic audio exactly as create extracts it (48 kHz stereo PCM in master coordinates) and fixes every join: the crossfade centre moves to the quietest 10 ms window within ±`searchMs` of the picture cut, but only when it is at least 1 dB quieter, then to the nearest zero crossing of the outgoing audio within 5 ms. Handles extend each side's own audio past its keep, never into a word outside the kept span; the fade never overlaps a kept word. If there is under 5 ms of silence for a fade the plan fails and names the join. The join table (offset, fade length, level, zero crossing) is in the plan metadata and its hash is part of the edit hash, so a changed policy or a changed source invalidates the review. Version 1 and 2 hashes are unchanged.

Create recomputes the join plan from the extracted PCM, refuses a different one, and writes `joined-speech.wav`: the kept spans in output order, each join an equal-power (cos/sin) crossfade, with the optional room-tone bed (the reviewed silent span, looped) under each fade with 10 ms raised-cosine edges. It is exactly `durationInFrames × 1600` samples and is imported with tool `recording-join-crossfade`, referencing the authentic audio asset. On the timeline the speech clips play that file in output coordinates (`payload.joinedSpeech: true`); picture and captions keep source coordinates. A later trim on the speech track must translate the range into output coordinates (offsets inside a clip match), and any re-edit near a join leaves half a crossfade behind: change the selection with a new reviewed request instead. Picture and audio stay in sync inside every clip; only the audio join point moves up to `searchMs` from the picture cut. Punch-in sets `payload.transform.scale` on every second picture clip, which `TimelineComposition` applies per frame. The uncut original timeline keeps the authentic audio. `recording-edit.json` version 3 records `joins: {plan, joinPlanHash, joinedAudioAssetId, joinedAudioHash}`; the render guard checks the plan hash against the reviewed identity and the joined file's bytes, provenance and duration.

## Materialized project and reversibility

Version 1 create requires a fresh project ID, stages an entire new project privately, imports the unmodified full recording with content-addressed SHA256 provenance, extracts one full 48kHz stereo PCM audio original from that immutable copy and imports it with a reference to the recording. Extraction does not apply gain, denoise, synthesis or time changes. The original authentic speech plays once on `authentic-speech`; the visual video is muted. No music or artificial voice is added. The explicit `recording-only` profile acknowledges this exception to the usual generated-video asset/audio checklist.

For both versions, picture, audio and captions share identical master source/output intervals, 30fps timebase and rate 1. Each master frame owns exactly 1600 audio samples at 48kHz; caption words stay in master source coordinates and the TimelineIR compiler rebases them onto selected output spans. A transcript word's optional `speaker` (written by `recut:plan` from a diarised transcript, and covered by the edit hash) is copied onto its caption, so caption pages break at every speaker change; requests without it keep their edit hashes. Half-open boundaries prevent duplicate ownership. In versions 1 and 2 joins are hard: abrupt source discontinuities can click or create jump cuts. Version 3 (below) adds reviewed crossfades and punch-ins; nothing is smoothed without that reviewed policy. Formats use existing cover cropping; review actual face/content cropping for every requested format.

Artifacts in `pipeline/`: `timeline-edit.json` (editable revision journal), `recording-edit.json` (request, human review declaration, source/audio IDs, source-to-output mapping and extraction provenance), `recording-edit-transcript.json` (complete supplied transcript), `recording-edit-original-timeline.json` (uncut source mapping). Asset registry and imported originals remain content-addressed. An exclusive project-create lock protects concurrent workflow writers; existing projects are never intentionally replaced. Failed staging is removed; a process killed mid-create can leave an uncommitted private staging directory or lock for inspection, never a partial published project. Do not automatically delete somebody else's lock.

Render through the production renderer with `pnpm render --project <id> --format landscape --timeline`. Rendering without `--timeline` is rejected for this authored workflow to preserve the actual recut. Subsequent reversible edits use `TimelineEditStore.apply(batch, expectedRevision)` across **all three synchronized tracks**, then `undo(expectedRevision)` / `redo(expectedRevision)`. Direct arbitrary timeline edits can change meaning; prior human review no longer covers them, and production delivery remains a separate review. To revise the selection itself, make a new request/project ID, increment `revision`, provide `previousEdit:{projectId,editHash}` from the persisted prior recut, plan and obtain a new hash-bound review. Prior projects remain intact. To restore the entire original, create a newly reviewed request retaining `[0, sourceFrameCount)` with no cuts; never overwrite the original recut.

## Verification and current limits

`pnpm tsx --test tests/workflow-recording-edit.test.ts` checks original preservation, exact trims/captions, Russian protections, whole irrelevant statement deletion, stale reviews/checksums, rational frames/VFR, revision lineage, trusted paths, symlinks, reversible synchronized edits and real competing processes.

`RUN_WORKFLOW_RENDER_TESTS=1 WORKFLOW_ARTIFACTS_DIR=/absolute/evidence pnpm tsx --test tests/workflow-recording-edit-browser.test.ts` bundles **actual ProductionRoot**, renders a local H264 MP4 in Chromium, verifies duration/video/audio and FFmpeg decode, checks retained first/last 440/880Hz audio against the supplied original's RMS to catch doubling/drift, and saves labelled boundary/caption/tail PNGs plus audio/probe report. Synthetic source chart timestamps expose the actual selected source frames. The test uses an explicitly labelled offline font fixture, which proves local timing/layout execution and does **not** certify production font coverage. Without the evidence directory, temporary artifacts are cleaned.

No ASR, external media, model calls, spending, credentials or service network requests are involved. VFR and rational sources require the explicit version 2 policy and source-bound review described above. Multiple audio tracks, nonzero/discontinuous stream offsets and recordings above 30 minutes remain unsupported. No automatic factual/meaning/rights approval, creative QA or production delivery is claimed.

`pnpm tsx --test tests/workflow-recording-joins.test.ts tests/workflow-recording-recut-plan.test.ts` covers join snapping, handles, the exact joined length, a hard-cut click removed by the crossfade, version 3 hashes, create, evidence tampering, a rational source, the planner rules and the CLI end to end on a synthetic tone-burst recording (not real speech). With `RUN_WORKFLOW_RENDER_TESTS=1` it renders a version 3 recut through ProductionRoot and checks an exact frame count and no click at the join (peak second difference against a hard cut of the same audio).

`pnpm tsx --test tests/workflow-recording-normalization.test.ts` creates real local 30000/1001 and VFR fixtures, validates write-free plans, immutable originals, final decoded-frame ownership, normalization provenance and synchronized editable picture/audio/captions. Declared fixture words are synthetic timing cases, not transcripts produced by ASR. Mapping and the declared/decoded audio timing summary are independently hashed into the v2 review identity; shared render guards reject modified evidence, version downgrades, missing provenance and changed imported originals or derivatives. Delivery identity also captures the inactive raw original and registry. Run `pnpm test:recording:timing` for all recording cases including actual Full HD MP4s.
