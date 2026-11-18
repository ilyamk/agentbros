# Local audio mastering and editorial QA

All commands below use local media and FFmpeg/FFprobe. They never load `.env`,
call generation APIs, or spend credits.

```sh
pnpm exec tsx scripts/analyze-audio.ts --input source.mp4
pnpm exec tsx scripts/mix-audio.ts --plan mix-plan.json --output public/projects/demo/music/master.wav --dry-run
pnpm exec tsx scripts/mix-audio.ts --project demo --output public/projects/demo/music/master.wav
pnpm exec tsx scripts/editorial-qa.ts --project demo --timeline --render out/demo/landscape.mp4
pnpm exec tsx scripts/validate-render.ts --project demo --timeline --strict
pnpm exec tsx scripts/repair-render-audio.ts --input original.mp4 --output repaired.mp4
```

`mix-audio --project` reads the initialized edited timeline and the optional
`pipeline/audio-mix.json` volume automation. It uses real source intervals,
playback rates and output offsets. Manual mix plans have `version:1`,
`durationSec`, optional `targetLufs` (default -16), `truePeakDb` (default -1.5),
`duckMusic` (default true), and `tracks`. Each track contains local `source`,
`role` (`speech`, `music`, `sfx`), and optional `startSec`, `sourceStartSec`,
`sourceEndSec`, `rate`, `volume`, `keyframes`, `loop`, `allowSpeechTrim`.
A `--plan` file's track sources resolve against the working directory (or the
MCP launcher's `--scope-root`) and must stay inside it: plain relative paths such
as `public/...`, or absolute paths within it; `..`, protocols (`http:`, `concat:`,
`subfile:`) and symlinks leading out are refused before any probe.

Volume keyframes are global output seconds, strictly increasing. Music is
compressed by the speech sidechain; SFX remain independent. Positive playback
rates use deterministic `atempo` chains. Two-pass loudness normalization publishes
only after the resulting WAV measures within 1 LU of the target and satisfies the
true-peak ceiling within 0.3 dB. Completely silent audio has null LUFS/peak values;
it cannot be marked normalized. Short music loops to the complete output length.
Existing output is preserved unless `--force` explicitly authorizes replacement.

The WAV sidecar `<output>.json` is measured `AudioMasterSchema` metadata. To use it
in rendering, write the WAV inside `public/` and select it through the explicit
renderer audio-master option; original tracks must be suppressed as part of that
selection. A file outside `public/` is still a valid local mix output, but its
sidecar source is not a valid public render path without an explicit import.

Speech stems are not truncated to fit a scene automatically. The project mixer
allows authored presenter-source windows; per-scene voiceover truncation is
blocked unless `clip.payload.allowSpeechTrim:true` records explicit intent.
Retiming suggestions add complete speech plus a pause and transition allowance.
They never rewrite a script, accelerate narration, move another track implicitly,
or apply themselves.

Editorial QA blocks missing planned assets, incomplete asset statuses, absent
speech, missing/invalid caption timing, incorrect caption source, cuts inside
aligned words, missing completed-stage outputs, wrong render duration/resolution/
fps, absent native audio, and excessive true peaks. `--timeline` evaluates the
edited timeline; otherwise QA evaluates canonical scenes. A quality-stage skip
is a warning and never exempts required media or captions from checks.

`validate-render --strict` returns a nonzero exit and `ok:false` for blocking
findings. Its JSON evidence remains at `qa-screenshots/validation-report.json`.
Without `--strict`, the analysis command may succeed while `metadata.qaStatus`
is `failed`; that is not publication approval. Screenshot extraction clamps the
last sample to an actual frame instead of seeking past EOF.

Audio repair is one bounded local attempt. It creates a new MP4, copies the
original video stream, replaces audio with a measured master, and preserves the
original bytes. It does not grant QA approval: rerun complete editorial/render QA
on the new file. Failed or unmeasurable repairs do not publish an output.

Verification: `pnpm exec tsx --test tests/audio-editorial.test.ts` uses real
synthetic WAV/MP3/MP4 fixtures to measure loudness, silence, ducking/normalization,
looping, speech truncation protection, strict failure reports and immutable repair.

To render the measured master: `pnpm render --project ID --timeline --audio-master public/projects/ID/audio/master.wav.json` (omit `--timeline` for canonical scenes). The sidecar pins a SHA-256 and measured duration. Render preflight rejects changed files or a duration differing by more than one frame; the master suppresses all original presenter/TTS/music/SFX audio layers. The actual Chromium MP4 regression identifies 880 Hz master audio and verifies that the original embedded 440 Hz voice is absent.

New masters created with `mix-audio --project` also carry optional versioned
`projectInputs`: effective normalized plan, exact audio source/output/rate clocks
and public-relative original SHA pins determine its input hash. Capture happens
before mixing; the CLI resolves current inputs again before atomic output
publication. Rendering with this sidecar revalidates against the current journal
and automation. Same-duration gain, loop, trim, rate, automation or original-byte
changes reject the stale master with an explicit remix instruction. Undo to
identical audio inputs and moving the complete checkout remain compatible.
Visual/caption-only edits and journal revision changes do not invalidate the mix.

Legacy/manual and `--plan` masters without this binding retain explicit measured
master behavior; they do not establish current project-input consistency. This
is an integrity/consistency receipt, not signed authorship or creative approval.
Do not strip a new binding to bypass a stale-input error: create a new master,
select it explicitly, then measure/listen to the encoded result.

Local audio inputs/metadata use bounded regular-file/no-follow reads and exact
initial-size hashes with one growth probe. FFmpeg/FFprobe use literal argv,
file/pipe protocol allowlists and finite deadlines. Missing/invalid/corrupt inputs
refuse rather than auto-downloading, padding speech or invoking providers.
