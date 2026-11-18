# Offline native estimated word proposals

Explicitly opt into `"wordTimingMethod":"native-word-segments-v1"` in an existing trusted local whisper.cpp worker configuration. This adds `-ml 1 -sow` to the fixed `-oj` CPU invocation. Model/runtime/worker/language/thread/method pins form a distinct cache identity. Unconfigured requests retain the historical identity formula and segment-only output; changing the actual worker file naturally changes its existing workerHash pin, never reuses a different worker's cached result.

Run the existing local ASR command with that configuration:

```sh
pnpm exec tsx scripts/media-local.ts --config LOCAL_CONFIG.json --action asr --project PROJECT --source ORIGINAL
pnpm media:words --project PROJECT --index INDEX.json --output public/projects/PROJECT/pipeline/words-proposal.json
```

ASR metadata `wordAlignment.status` explicitly says available/unavailable. Segment text remains available for a valid native result whose word rows collapse or contain multiple words; its original rows/text/offsets remain pinned, and the word exporter refuses. Missing word CLI flags use ordinary segment ASR once and return unavailable alignment; there is no second inference, download, provider fallback or fabricated timing. Invalid/nonmonotonic/out-of-source evidence fails validation. Empty engine rows are retained as nonlexical evidence and never captioned.

The separate proposal contains native seconds, stable IDs/raw-row references and source/index/transcript/model/runtime/cache hashes. It is always `estimated:true`, `reviewRequired:true`, `approved:false`. It performs no edits or approvals. Semantic sentence groups and embedding indexes remain separate from word evidence. Existing indexes without the optional method remain readable but cannot claim aligned word availability.

Optional `--frames` uses the original video's exact CFR source rate and independently rechecks actual local decoded timestamps/rates. Audio-only, VFR/nonzero-origin or mismatched metadata refuses; this option is not a generic 30fps export. Collapsed/overlapping intervals refuse without stretching words. Use seconds plus a separately reviewed explicit normalization workflow when appropriate.

Whisper.cpp's token timestamp algorithm uses probability/energy/voice-length heuristics, including proportional filling of missing anchors. These are native estimated boundaries, not forced alignment or measured human accuracy. No confidence/loss is invented; DTW point timestamps are unused. Listen and review phrasing, negations, accents, silence and boundaries before using the proposal. Clean synthetic English/Russian feasibility does not establish natural/noisy speech quality.

Only explicitly supplied already installed local engines/models run; no API or automatic installation. CLI worker config remains trusted local configuration, never an MCP executable field. Process arguments are literal/fixed, media protocols file/pipe, IO and owned worker deadlines bounded. Originals/model/runtime are rechecked; cache corruption refuses. Export refuses overwriting an existing proposal.

The word proposal route caps source-index, transcript and asset-registry JSON at 16 MiB each before hashing, reading or allocating their contents. It uses captured-size regular-file reads with a growth probe and descriptor/path identity checks throughout canonical evidence validation. Oversized or changed evidence refuses without publishing a proposal; existing default source-index readers and cache identities retain their historical behavior.
