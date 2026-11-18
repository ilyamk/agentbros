# Local recording ingest and evidence selects

```sh
pnpm tsx scripts/media-ingest.ts --project example --source recording.mp4 --transcript words.json --options analysis.json
pnpm tsx scripts/media-selects.ts --project example --query "battery performance" --context 1.5
pnpm tsx scripts/media-selects.ts --project example --apply reviewed-proposal.json --index index.json --track presenter --clip take --revision 3 --dry-run
```

Original recordings are imported once through the immutable asset registry. The analysis cache is `public/projects/<id>/pipeline/source-index/<key>/index.json`; its key includes original checksum, normalized analysis options and supplied transcript checksum. Originals, proxies, thumbnails and transcript snapshots are checked before reuse. Changed input/options creates a distinct cache; corrupted evidence rejects rather than silently overwrites. Ingest `--dry-run` only validates and calculates the cache identity.

Options include `proxyWidth`, `thumbnailEverySec`, `sceneThreshold`, `ocr`, `ocrLanguage`, `tags`, and `protectedSpans: [{startSec,endSec,reason}]`. Video proxy preserves source frame cadence; sampled thumbnails carry decoded frame numbers and actual source PTS. Audio receives a low-bandwidth MP3 proxy. Decoded frame PTS are normalized to the first video frame; `source.originSec` records its original timestamp. Supplied transcript intervals must be expressed relative to that same recording origin. A variable-frame-rate recording is searchable but cannot receive a constant-frame trim until explicitly normalized. Analysis rejects missing/nonmonotonic frame PTS, more than 200,000 frames, and requests for more than 500 thumbnail samples. Scene-change boundaries describe visual discontinuities, not narrative events.

Transcript input accepts `segments`, `words`, or a JSON array using `text,start,end` or `text,startSec,endSec`. Word-only exports group at punctuation or gaps, retaining the original checksum as evidence. This imports existing Scribe/word outputs without ASR or a paid request. OCR uses installed `tesseract` only when requested. Availability, version, execution and unavailable warnings are reported; absent OCR produces no invented results. OCR text describes a sampled frame and does not prove visibility throughout the suggested interval.

Search is **lexical transcript/tag matching**, with transparent coverage and exact-phrase score parts. It does not claim neural semantic retrieval, face/object/action recognition, verified factual claims, or statistical take-quality rankings. Manual tags provide visual labels until a separately benchmarked recognition adapter is introduced.

Each select is an explicit proposal with timecodes, source checksum, index identity, evidence and minimum surrounding context. Boundaries expand to preserve intersecting supplied transcript spans and protected spans. Review the complete statement and qualifiers: punctuation and word timings alone cannot establish meaning. The application API reproduces the proposal, verifies the target clip/source/timebase, and refuses trims that discard a protected span. It uses the shared TimelineEditStore, revision checks, dry-run and undo/redo; unrelated tracks never ripple automatically. The target TimelineIR clip must already reference the immutable imported asset. There is no automatic deletion or silent placement into a different clip.

Module APIs: `ingestMedia`, `readSourceIndex`, `listSourceIndexes`, `importTranscript`, `probeOcr`; `searchSourceIndexes`, `proposeSelect`, `applySelect`. No network or paid API acceptance was performed.

## Prepared offline frame OCR

The optional `media:ocr` route uses a separately prepared local Apple Vision revision3 executable on macOS. Production neither compiles nor downloads a runtime. A trusted configuration supplies absolute executable/Swift-source paths with SHA256 checksums, `engine:"apple-vision"`, `revision:3`, explicit supported `languages` (for example `en-US`/`ru-RU`), `maxFrames` from1 to32 and `timeoutMs` up to120000.  The legacy installed-Tesseract option above remains unchanged; it is not retroactively certified by these receipts.

```sh
pnpm media:ocr --action probe --config OCR_CONFIG.json
pnpm media:ocr --action ingest --project example --index BASE_INDEX.json --config OCR_CONFIG.json
```

Choose an existing non-OCR video source index inside the selected project, with1..`maxFrames` sampled thumbnails and an exact next decoded PTS for every sample. A terminal sample without that timestamp is rejected before recognition; container duration, including a longer audio tail, does not prove the frame extent. Legacy unpinned OCR cannot be mixed into a new certified index. Originals, base index and transcript evidence remain unchanged.

Parse the single JSON envelope. A successful `probe` with `metadata.available=false` means the installed engine is unavailable. Valid `ingest` returns a new derived index in `metadata.file`, a raw receipt in `metadata.receiptFile`, and both files in `outputs`. Receipts pin source/frame hashes, source PTS, prepared runtime/source hashes, installed OS/revision/languages, raw text/confidence/boxes and the recognition settings. Canonical reading and B-roll reconstruct the observations from this evidence; modified text, negation, timing or files are refused. Rerunning unchanged inputs reuses that receipt. A crash residue without its checksum marker is rejected for explicit inspection.

Execution has OS deny-network isolation and a bounded batch deadline; executable configs remain trusted CLI-only, outside MCP/browser inputs. Images are limited to4MP/16MiB, outputs to256KiB, and observations to100 per frame. Empty observations are legitimate. Recognition failure does not trigger paid fallback or automatic retry. OCR candidates cover exactly one sampled decoded frame, require review and never establish text persistence across a clip, spoken word alignment or broad OCR accuracy. Existing lexical selects can search them; recreate embedding packs for the derived index rather than reusing base-corpus pins. Speech edits continue to require their own supplied alignment and contextual review.

## Free local speech and screen text

Reference decomposition gets word-level speech and on-screen text at $0, with no provider and no network at analysis time. Paid Scribe is never a fallback. Setup is one explicit operator command:

```sh
pnpm media:prepare --dry-run                     # state and plan only: no write, build or download
pnpm media:prepare --engines asr,ocr             # prepare both; rerun to repair
pnpm media:prepare --engines asr --model medium  # base, small (default) or medium
```

Needs `uv`, `curl`, Xcode Command Line Tools and FFmpeg. The engine directory defaults to `~/.cache/agentbros/local-engines` and must be outside the repository (`--output-dir`). A prepared `small` setup holds about 535 MB:

| Path | Contents |
|------|----------|
| `asr/bin/whisper-cli` | whisper.cpp 1.9.5, static CPU build from a SHA256-pinned tarball, using cmake from `uvx` |
| `asr/models/ggml-small.bin` | 487.6 MB multilingual model, pinned by Hugging Face revision and SHA256 |
| `python/` | uv-managed Python 3.12.16 for the standard-library worker |
| `ocr/bin/frame-ocr` | Apple Vision worker compiled from `scripts/workers/frame-ocr.swift` |
| `asr/config.json`, `ocr/config.json` | Exactly what `media:local --config` and `media:ocr --config` accept |
| `manifest.json` | Provenance and the speech engine's hash pins |
| `cache/` | Recognition results keyed by engine identity and input hash; safe to delete |

whisper.cpp is used rather than mlx-whisper because `media:local` already supports it, including the validated `native-word-segments-v1` word rows, and one static binary is fully covered by its `engineHash`. The engines and their checks are unchanged. Executable-bearing configs stay trusted and CLI-only, outside MCP and browser tools. Rerunning the command reuses files whose hashes still match.

Parse the JSON envelope. A requested engine that cannot be prepared still gives `ok:true`, with `metadata.engines.<engine>` set to `{available:false, reason, fix}`, where `fix` says what to run or install.

Code calls `analyseSpeechAndText({mediaFile, engineDir?, language?})` from `src/lib/local-engines/speech-text.ts`. It returns `speech` and `screenText` in the shape of `ReferenceSpeechTextSchema`, reported independently. An unavailable layer has `available:false`, `unavailableReason` and, when a command can repair it, `fix`. `asrStatus()` and `ocrStatus()` in `prepare.ts` check readiness without running recognition, and refuse files that differ from their pins.

- **Speech.** Audio is first rendered to one 16 kHz mono WAV with gaps filled, because `media:local` fails closed on the offset or discontinuous clocks that real downloads often have. Times stay on the file's clock. Language is auto-detected from the opening audio unless `language` is passed. The engine's JSON gives no word confidence, so none is reported. Sound labels such as `(upbeat music)` are removed, and music-only audio gives an empty `words` list.
- **Word times are native estimates, not forced alignment.** On isolated synthetic words, starts were within about 0.1 s (median) and 0.3 s (worst). Ends absorb following silence by up to about 0.7 s, so do not read a word's end as the moment its sound stops.
- **Screen text.** One decoded frame is sampled from the middle of each 0.5 s interval, away from whole-second edits where text is often mid-fade and Vision misses it. Frames above about 3.7 MP are scaled down. Identical text in consecutive samples merges into one span, ignoring case, spacing and Latin/Cyrillic lookalike letters. A span runs 0.25 s either side of the samples showing the text, so its times are estimates, and text on screen for under 0.5 s can be missed. Boxes are normalised with a top-left origin. Vision's confidence is coarse (0.3, 0.5 or 1 in practice) and items at 0.3 are often noise, so review them. Boxes that Vision places slightly outside the image are clipped on this route; the `media:ocr` receipt route still refuses them.

Limits: one speech run has the worker's 600 s deadline, which limits long files, and OCR samples at most 7200 frames. There is no speaker labelling. A timeout or engine failure returns `available:false` with no automatic retry. Quality measured on synthetic speech and rendered graphics does not establish quality on natural, noisy or stylised footage.

## Prepared offline reference-image search

`media:visual` uses separately prepared Apple Vision feature-print revision2,
CPU-only scaleFill on macOS, with pinned executable/Swift source/OS and
`orientationPolicy: validated-jpeg-png-exif-1-through-8-v1`. Production never
compiles/downloads it. This compares an imported original image with sampled
video frames; its native distance is not semantic confidence or persistence.

```sh
pnpm media:visual --action probe --config VISUAL_CONFIG.json
pnpm media:visual --action search --project example --index BASE_INDEX.json --query-asset sha256:HASH --config VISUAL_CONFIG.json
```

Register the reference image with `asset:import` first. Query originals and
sampled frames must be single-frame JPEG/PNG within4MP/16MiB/4096px; all8
EXIF orientations are honored, invalid/duplicate/malformed declarations refuse.
The video index must have exact nextPTS for every sampled frame; up to32 samples
and120s whole-batch deadline. Executable configuration stays trusted CLI-only,
outside MCP/HTTP. Missing engine reports unavailable, with no cloud fallback.
OCR can be added first, then visual analysis; do not apply OCR to an already
visual-derived index. Keep the original base index and regenerate embedding
packs for derived indexes. Existing absent-visual cache keys remain compatible.

Search returns `metadata.file`, `metadata.receiptFile` and ranked `metadata.hits`
with raw distance ascending, query/frame hashes, exact sampled-frame intervals
and reviewRequired. The immutable receipt pins query original+registry metadata,
base/source/frames/runtime/raw scores. Reads and B-roll application reconstruct
and verify the evidence; changed files, metadata or scores refuse. No rank is
an automatic selection. Inspect candidates and surrounding footage before
proposing a cutaway. Use `retrieval:{"method":"native-image-distance"}` with
that derived `indexFile` in the existing reviewed B-roll request. Rights, context,
exact output placement, dry-run/Apply/CAS and independent muted tracks still apply.


Synthetic graphic rankings and3s quarter-scale render are bounded technical
acceptance; natural footage, text-to-visual semantic retrieval, object persistence
and human creative review remain open.

## Prepared offline native category search

`pnpm media:category` exposes `probe --config`, `classify --project --index --query --config` and executor-free `search --project --index --query`. The trusted prepared config pins the local Swift source and binary; stored evidence cannot select an executable. Missing runtimes fail without compiling, downloading a model or using cloud inference. Under an outer deny-network policy use the reviewed Node `--import tsx` launcher, because the tsx CLI's Unix IPC listener is also denied.

The macOS Vision revision2 classifier declares full-image ROI and the framework-default preprocessing policy; no CoreML crop/scale option is invented. Runtime identity includes OS/build, source/binary, revision, request policy and the full sorted taxonomy. Individual OS model weights are not separately hashed. The accepted local probe returned1303 category IDs; changed runtime/taxonomy pins invalidate the generation rather than being silently accepted.

Queries are strict `native-image-category` records with the exact supported identifier and taxonomy hash. Native scores are observations rather than calibrated confidence. The complete returned rows, including low/zero scores, are retained; a missing label is not zero-filled. Bounds include32 sampled frames,16MiB per image,4MP decoded pixels,8MiB per receipt and120s per worker operation. Explicit EXIF orientations1–8 are supported; unknown orientations refuse. Finite FD/path/ancestor consistency checks reject known aliases without claiming race-free traversal against arbitrary ABA swaps.

Derived indexes retain the original base/source/frame/runtime/raw-row pins and lower OCR/reference evidence. Frame spans use `[sourcePTS,nextPTS)`; ambiguous terminal extent refuses. Changed raw rows, query, source or lower evidence reject before applying B-roll. `search` performs no inference. Select and review the returned exact segment, use `retrieval:{method:'native-image-category',queryFile:'pipeline/category-query.json'}` relative to the project, then dry-run/explicit Apply/CAS/Undo with independent muted visuals.

Independent actual acceptance classified22 frames in three batches under OS deny-network, retained all1303 rows per frame, checked six refusals, cache/immutable reconstruction/exact PTS and synthetic B-roll/Undo. Diagnostic scores and all8 orientation deltas are not human accuracy, object persistence, rights, audio/render or creative acceptance.

## Supplied semantic embeddings

`media:selects --project ID --embeddings corpus.json --vector-query query.json` performs actual cosine retrieval over supplied vectors. Both files identify the same model, revision, dimensions and text/image/multimodal space. Corpus items pin source hash, index cache key, segment ID and `segmentEmbeddingHash`; changed transcripts invalidate embeddings. Query includes its text and vector. Provenance labels the generating system; this tool does not invent vectors or run an unconfigured paid embedding model. Numeric fixture tests verify search mathematics, not semantic model quality. Hits reuse the same context/protected-span proposal and explicit review/apply workflow. Lexical search remains an independent transparent fallback.
