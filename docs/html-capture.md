# Offline seekable HTML / Hyperframes bridge

This opt-in backend executes a self-contained composition inside local Chromium and publishes real, immutable PNG frames. It can encode an MP4 suitable for `asset:import`, silent by default or with explicitly planned local audio. It does not change the default Remotion animation rules or install the Hyperframes engine.

## Contracts

Choose `protocol: "avc-frame"` (default):

```html
<canvas id="scene" width="1080" height="1920"></canvas>
<script>
  window.AGENTBROS_CAPTURE = {
    version: 1,
    ready: Promise.resolve(),
    seek(frame, { fps, width, height, timeSec }) {
      const context = scene.getContext("2d");
      context.fillStyle = frame < fps ? "#fff" : "#6C5CE7";
      context.fillRect(0, 0, width, height);
    },
  };
</script>
```

Or explicitly choose `protocol: "hyperframes-seek"` for a standalone HTML composition exporting `window.__hf = { duration: 10, seek(timeSeconds) { ... } }`. Duration must be finite and positive; frames outside it fail. This is the documented minimal [HeyGen seek contract](https://www.heygen.com/research/html-to-video), not the complete current Hyperframes engine. [Official current runtime globals](https://github.com/heygen-com/hyperframes/blob/main/packages/core/src/inline-scripts/runtimeContract.ts) and [frame adapters](https://github.com/heygen-com/hyperframes/blob/main/packages/core/src/adapters/types.ts) have broader capabilities. Native bootstrap, GSAP integration, arbitrary nested document runtimes and variable runtime loaders are not implemented by this adapter. The separate optional AVC timing graph below supports declarative nested media and local audio.

Both seek functions must return synchronously. DOM, canvas, SVG, static local images and allowlisted fonts are supported. CSS/WAAPI running animations, animation clocks, external assets, browser network calls, popups, embedded documents and audio elements fail capture. Unsupported DOM elements are checked again after seek and resource readiness; seek cannot add autonomous SVG SMIL or audio afterward. Allowlisted local CSS loads through the same intercepted snapshot origin. The document is recreated for each requested frame, receives a seeded random source and fixed `Date.now()`/`performance.now()`, then seeks directly. Compose visuals from absolute frame/time formulas; do not depend on wall-clock Date constructors, locale or previous calls. Each frame waits for actual image decode and fonts.ready before screenshot. Hash invariance is tested on the installed Chromium/OS/fonts; cross-machine GPU/font equivalence is not promised.

## Request and output

```json
{
  "protocol": "hyperframes-seek",
  "htmlFile": "/absolute/project/index.html",
  "assetRoot": "/absolute/project",
  "assets": ["images/proof.png", "video/take.webm"],
  "width": 1080,
  "height": 1920,
  "fps": 30,
  "frames": [0, 1, 2],
  "encode": "mp4",
  "timeoutMs": 30000
}
```

`assets` is an explicit relative allowlist, not a directory scan. No symlink components (except exact macOS `/var`→`/private/var` and `/tmp`→`/private/tmp` OS aliases), dot paths or traversal; supported image/video/font/CSS types only. References are rooted at this virtual document's root (`images/proof.png`); use assetRoot as the composition asset base. Regular-file sizes are checked before snapshot reads: HTML <=1MiB, assets <=32MiB each /64MiB total, <=128 entries, <=100 sampled frames, <=1920 per dimension, <=60fps, <=120s wall time. PNG is default; MP4 requires complete ordered frame indices `0..N-1` and even dimensions. Three standard dimensions are supported:1080×1920,1080×1080,1920×1080.

```bash
pnpm tsx scripts/capture-html.ts --request /absolute/request.json --output /absolute/captures
```

The CLI emits one JSON envelope. The output is a hash-addressed immutable directory containing `capture.json`, captured `frame-N.png` and optional `video.mp4`. The manifest records HTML SHA256, allowlisted asset SHA256, frame SHA256, exact viewport/fps, media source times, and optional silent MP4 SHA256/duration. Existing results must match hashes; changes create a new identity. Publication occurs only after all frames and the optional video validate. Cancellation/timeout kills the worker process group and publishes no success receipt.

## Media and isolation

Local `<video src="video/take.webm" data-avc-start-frame="0" data-avc-source-start-sec="0.5" data-avc-rate="2">` uses source time `sourceStartSec + max(0,(frame-startFrame)/fps)*rate`. Before its start it is hidden. FFmpeg decodes the first source frame at or after that exact time into a PNG; the browser displays an image with the video's computed layout. Missing/out-of-range media fails, audio is never mixed or silently declared delivered. Source rates and constant-rate trims are supported; native Hyperframes data-* timing, variable-rate ramps and video scripts are not translated.

The trusted worker receives a minimal environment without provider keys; user HTML never executes as Node code. CDP interception supplies only snapshotted allowlisted bytes. CSP disables connections, frames, workers, forms, popups and external resources. Browser clocks/network constructors are guarded; missing contracts and violations fail. Timeout, asset/frame/output bounds and a256MiB Node worker heap cap limit ordinary jobs. Chromium is an isolated process, not an OS security boundary: browser vulnerabilities and malicious memory exhaustion require an additional OS/container sandbox. Do not advertise this as safe execution of arbitrary hostile HTML. Chromium should already be installed locally; no service calls, paid APIs or dynamic dependency installation are part of capture.

Verification:

```bash
RUN_HTML_CAPTURE_TESTS=1 pnpm tsx --test tests/html-capture.test.ts
```

Tests compare real repeated/random frame PNG hashes, actual pixels from local video source seeks, all three dimensions, both seek protocols, actual encoded silent MP4 and probe metadata, bad contracts, network/clock/WebSocket rejection, unsafe/symlink assets and cancellation.

## Explicit AVC timing graph v1 (optional)

`timing: {version: 1, nodes: [...]}` is an AVC contract, **not** a native Hyperframes runtime. Each node has unique `id`, optional `parent`, `startFrame`, `durationFrames`, `rate` (default 1), optional simple `#id` selector, and optional `audioAsset`/`sourceStartSec`/`volume`. Node start and duration are expressed in its parent's local frame clock. A parent's cumulative rate converts these into absolute seconds. A node's own rate affects descendants and source playback, while its declared duration stays in the parent clock. Children must fit their parent, depth is at most 8, cumulative rate 0.125–8, and IDs/selectors must be unique. Groups are declarative DOM containers; external iframe documents and arbitrary nested script runtimes remain rejected.

For example a parent starting at frame 10 with rate 2 makes child frame 2 occur at absolute frame 11. Visibility is gated to `start,end)`; source video time is `sourceStartSec + (absoluteTime-start)*cumulativeRate`. Unsupported native `data-start`/`data-duration` semantics still fail explicitly. Fresh documents make random/sequential seeks independent of prior state.

Audio nodes require complete MP4 frame batches and an explicit allowlisted `.wav`, `.mp3` or `.m4a` original. Exactly one audio stream with contiguous zero-origin packet timestamps is required; offsets/gaps/codec priming that violate this contract fail and require reviewed normalization first. The browser never executes audio. Fixed FFmpeg filters trim source ranges, apply constant `atempo`, resample to 48k stereo, apply leaf volume, delay by rounded sample positions, mix and limit. Source range and timeline coverage are checked. The manifest pins every original hash, exact timing/rate/volume, measured PCM sample count/peak and measured AAC decode coverage. AAC padding is reported separately and is not claimed to have identical PCM sample count. Group volume automation, variable-rate ramps and arbitrary upstream mixer effects are unsupported.

The graph is part of the immutable capture identity. Audio originals share existing 32MiB/file and 64MiB snapshot limits. Complete batches remain at most 100 frames, so this is an asset capture bridge, not an unbounded full-video renderer. The resulting actual MP4 can be imported using `pnpm asset:import --project ID --input /absolute/capture/video.mp4 --origin manual --metadata SIDECAR.json`; supply source/timing/licence evidence in the supported sidecar. Import preserves the original SHA256 and creates a **candidate**, not approval. The actual integration test verifies this handoff.

## Explicit upstream FrameAdapter lifecycle (opt-in)

Choose `protocol: "hyperframes-frame-adapter"` for a **standalone paused adapter**, exported as `window.AGENTBROS_FRAME_ADAPTER`. This bridge matches pinned Hyperframes `FrameAdapter` methods: optional `init({compositionId,fps,width,height,rootElement})`, synchronous `getDurationFrames()`, asynchronous-or-synchronous `seekFrame(frame)`, optional asynchronous `destroy()`. `init`, `seekFrame` and `destroy` are awaited. Duration must be an integer1–36001 and must stay stable after seek. Every frame gets a fresh document; each document goes through the complete lifecycle. Missing hooks, rejection, invalid/out-of-range duration, pending promises past the whole-job timeout or cleanup failures prevent publication. The context composition ID is `avc-capture`; authored adapters must use the request fps consistently.

In this protocol only, explicit allowlisted `.js` files can load from the intercepted local snapshot origin. SHA256 of each script is included in capture provenance. `requestAnimationFrame` registrations remain dormant and never call callbacks (maximum1024 per fresh document); timer/network/WebAudio/iframe/CSS animation restrictions remain. A real GSAP ticker is put to sleep after init, seek and cleanup. Build paused timelines and drive them solely through absolute adapter seeks. This mode permits external asset generation. GSAP inside a Remotion composition is a separate, first-class route (`src/motion/gsap.ts`); use this one only for third-party HTML and shaders. Timelines which require wall-clock callbacks, timers or asynchronous asset downloads are unsupported.

The repository retains the exact small Apache-2.0 upstream `createGSAPFrameAdapter` and interface in `vendor/hyperframes/`, with source revision/checksums and licence. Supply your own correctly licensed local GSAP script and compile the adapter for the browser when preparing HTML. A simple non-GSAP authored adapter can also use the same lifecycle. There is no dependency installation, runtime download or automatic full engine bootstrap.

This is **not** the full Hyperframes `__player/__playerReady/__renderReady/__timelines/__clipManifest` engine. An installed `__player` fails this explicit adapter protocol. Native full-engine media attributes/loaders, nested documents, WAAPI/WebAudio and runtime bootstrap are not translated or silently accepted. Use the separate AVC graph for supported nested local video trim/rate and measured local audio mix. Full runtime work and genuine hostile-code OS isolation remain open; supplied code must be trusted.

Actual acceptance with the retained local GSAP3.15.0 source (tests verify its exact hash; no download):

```bash
RUN_HTML_CAPTURE_TESTS=1 \
HYPERFRAMES_GSAP_FILE=/absolute/local/gsap-3.15.0.js \
pnpm exec tsx --test --test-concurrency=1 tests/html-frame-adapter.test.ts tests/html-capture.test.ts tests/html-timing.test.ts
```

Without the opt-in variables, browser/runtime acceptance is explicitly skipped. Contract-only authored fixtures test async lifecycle, not full upstream runtime compatibility; the separate real upstream GSAP-adapter test exercises actual GSAP, random/sequential pixels, MP4 and nested local video/audio/rate capture.

### Owned browser cleanup and implementation generations

The trusted worker launches directly through the installed tsx loader and records detached browser children during Remotion launch. Browser ownership is communicated over private IPC with a fresh parent-issued token, exact worker PID and child PID; project HTML cannot supply ownership declarations. Ownership is recorded before browser readiness, with early signal/disconnect cleanup. Timeout/cancellation/error kills only these owned Chrome groups, requests worker termination, and forces worker-group cleanup after a bounded1s grace. Remaining helpers are reaped before ownership release. No browser-name scan or generic Chrome cleanup occurs. Actual macOS tests leave an unrelated browser usable while pending init/seek/destroy and immediate/delayed cancellation reap the captured groups. Windows uses fixed bounded taskkill argv for owned browser trees; Windows behavior is not locally accepted by these macOS tests.

`provenance.implementation` version2 pins bounded SHA256 reads of capture service, schema/types, worker, timing and audio implementation source. These pins participate in immutable generation identity and are rechecked after rendering; an implementation change during a job fails publication. A fixed backend produces a new generation, while old originals/receipts remain unchanged. These source pins are not a claim of cross-version Chromium/FFmpeg/GPU equivalence or full transitive dependency hashing. Decoded source frames use a reserved `/.avc-generated/` origin route, which cannot be allowlisted as a project asset; an asset named like an older generated PNG cannot replace captured media.

### Pinned full-player supported subset (explicit opt-in)

`hyperframes-player` executes the actual pinned Hyperframes core player with a source-exact private-clock/publication patch. Supply the offline prepared artifact and original GSAP bytes as explicit immutable allowlisted assets; no runtime is downloaded or installed automatically. Preparation/source/dependency/licence receipts and exact commands are in [engine verification.

```json
{
 "protocol":"hyperframes-player",
 "htmlFile":"/absolute/project/index.html",
 "assetRoot":"/absolute/project",
 "assets":["runtime.js","gsap.js","child.html"],
 "playerRuntime":{"runtimeAsset":"runtime.js","gsapAsset":"gsap.js"},
 "width":64,"height":64,"fps":10,"frames":[0,2,5,8]
}
```

The worker injects both verified runtimes before authored scripts. Authored HTML registers paused `window.__timelines` entries and should **not include script tags loading runtime.js/gsap.js again**. Root and child compositions declare `data-composition-id`, duration and dimensions. Actual native bootstrap/pause/absolute seek/registered async completion/teardown are used, with source-native manifest/fps/duration checks and a required timeline for every mounted host. One-level local external children and mounted inline compositions are supported; incomplete child timelines fail.

Generic authored RAF, timers, fetch, GSAP ticker callbacks and native lifecycle shadowing stay forbidden. Only pinned engine/GSAP receive private dormant clock registration; the host flushes at most64 zero-delay bootstrap callbacks. No RAF or nonzero timer callbacks execute; actual engine's readonly-publication observer interval remains dormant. Limits:1024 clock registrations,32 composition hosts,depth8,64 native manifest clips,16 child loads,128KiB UTF-8 per child and2MiB total fetched child HTML. Exact known artifact hashes, implementation/source pins and originals remain in immutable capture provenance.

The base visual profile rejects recursive external hosts/cycles, timeline-free compositions, native audio/video, canvas/GPU/VFX, CSS/WAAPI/SMIL and native position-edit overrides. Native audio/video requires the explicit media profile below. AVC `timing` cannot mix with native player semantics. The manifest reports `fullPlayerSubset:true` and `hyperframesEngine:false`: this is a genuine supported player subset, not an assertion that every upstream engine mode is compatible. Existing trusted-code, resource/network/path/process guards and exact-owned Chrome cleanup apply. It is not an OS sandbox for hostile JavaScript.

### Native local media profile (opt-in pinned player subset)

The separate `playerRuntime.mediaProfile: "native-local-media-v1"` request accepts only its separately prepared, checksum-verified media runtime. Keep `protocol: "hyperframes-player"`, explicit `runtimeAsset`/`gsapAsset`, and the existing local asset allowlist. Omitting this field keeps the original visual runtime contract; a media bundle cannot silently replace that bundle.

Native `<video>`/`<audio>` clips require unique IDs, explicit local `src` and native `data-start`, `data-duration`, `data-media-start`, `data-playback-rate`, `data-volume` attributes where needed. Genuine pinned upstream media-cache traversal supplies absolute nested origin, host cuts and source-time mapping; the AVC timing graph is not reconstructed. Video frames use the actual upstream injected-render-frame contract with bounded FFmpeg decoding. Device playback stays muted; a measured FFmpeg mix honors initial authored effective `.muted` and zero gain independently of browser transport mute. A bootstrap `.muted=false` overrides HTML/defaultMuted defaults. Detectable post-initialization property/default/attribute changes fail; dynamic mute automation is unsupported.

This profile supports at most eight clips, isolated zero-origin continuous CFR silent video (1–60 fps, including fractional rates), and separate 48kHz mono/stereo PCM audio, each at most60 seconds. Source dimensions are at most1920 per axis. Constant rates0.125–8 and constant gain0–1 must remain within the immutable original duration. Existing capture frame, byte, local loading, depth, process and deadline bounds still apply. Embedded audio in video, AAC originals, VFR, autoplay/loop, envelopes, audio FX/groups, volume/property animation, arbitrary frame callbacks and unsupported native renderer paths fail explicitly. Convert originals through an independently reviewed import workflow before capture where necessary; capture does not silently normalize them.

The original Apache-2.0 source closure, GSAP licence and private toolchain hashes remain retained. The media receipt records the original input separately from the exact two additional source adaptations.  This is a supported native player subset for trusted offline code, not full Hyperframes compatibility or a hostile-code sandbox.

### Explicit AAC / embedded audio / VFR preparation

On macOS, add the separate normalization choice to the same verified native media runtime:

```json
"playerRuntime": {
  "runtimeAsset": "runtime-media.js",
  "gsapAsset": "gsap.js",
  "mediaProfile": "native-local-media-v1",
  "normalization": "decoded-source-proxy-v1"
}
```

Omitting `normalization` preserves the CFR/PCM restrictions above. Other profiles and unsupported operating systems reject this choice. Installed FFmpeg and ffprobe are required; nothing is downloaded. The genuine native player/GSAP artifacts keep their existing checksum requirements.

Preparation validates continuous zero-origin decoded clocks and saves each original picture in a silent FFV1 ordinal proxy. Its artificial 30fps clock serves only as a picture index: native source time selects the original rational `PTS,nextPTS)` interval, including its verified final extent. VFR and 30000/1001 source clocks retain their original timing. Original snapshots remain separate and unchanged.

Standalone AAC and audio embedded in a native video clip are decoded to 48kHz float PCM. Supported source audio is 44100/48000Hz mono/stereo with an exactly representable output extent; documented codec padding is trimmed. Offsets, gaps, overlaps, contradictory tails and mismatched embedded audio/video extents fail. No missing speech is filled or shifted. Embedded audio follows the video's genuine native trim/rate/constant gain/initial mute/nested origin and has one mixer owner. Explicit authored audio clips remain independent tracks.

Bounds: at most eight media sources, 60s each, 1920px per axis, nominal video rate 1–60fps, 3600 decoded pictures, 32MiB per original and 64MiB total originals plus derivatives. A finite 30s preparation budget and bounded outputs can reject material before these maxima. Receipts pin originals, rational clocks, proxy/PCM bytes, sample counts and installed tool binaries. All are verified before publication and existing-result replay; preparation currently runs per capture rather than using a persistent proxy cache.

The separate preparation children use literal file/pipe-only commands, sanitized environment, one codec thread and macOS deny-network. Trusted process registration and ACK precede tool activation; cancellation waits for owned-root/descendant cleanup, including delayed registration. This OS policy covers the new preparation step; existing fixed capture extraction/encode/mix and Chromium retain their documented guards. General hostile-code isolation, dynamic automation and GPU/VFX remain open. Static external children require the distinct profile below.

 Short synthetic acceptance demonstrates original-picture selection, nested timing, embedded audio, mute and rate controls; it does not establish long/native creative acceptance or rights to supplied media.

### Static local composition tree

For trusted offline code, explicitly add `compositionProfile: "static-local-tree-v1"` alongside `mediaProfile: "native-local-media-v1"`. Use the separately prepared tree runtime with SHA256 `88f3e5288737e752468d1bb11ca9afe43a31404fefe5f827b5cac37866e585eb` and the pinned GSAP artifact. Earlier visual/media artifacts remain valid for their own omitted-tree profiles; they cannot substitute for this artifact.

Declare the authored root with literal `data-start="0"` and a positive `data-duration`. Every child needs a unique composition ID, an explicit duration and an exact allowlisted root-relative `.html` source. Plain child bodies and matching child roots are supported. The genuine loader supplies origins, in-points and timelines; media must fit every ancestor window. Cycles, repeated source instances, missing/duplicate IDs, spoofed private timing attributes and post-bootstrap source/timing/timeline mutations fail before publication. A private per-host transition tracks the original duration sanitizer as asynchronous children load.

Bounds: three external levels, 16 unique child documents, 32 hosts, eight media clips, 128KiB per child, 1MiB root and 2MiB aggregate HTML. Existing media/capture/deadline bounds also apply. Unsupported dynamic insertion, timeline-free children, external/module scripts, GPU/VFX and arbitrary source reuse remain separate work. This profile is not an OS sandbox for hostile authored JavaScript.

Independent actual acceptance covers a genuine three-level tree, sequential/random/repeated frames, trim/rate source selection, ancestor-bounded measured PCM, mutation/graph refusals, timeout/cancellation cleanup and old profiles. The short output was fully decoded; PCM replay does not establish AAC bitidentity or human creative quality. Commands, source adaptations and unsuccessful earlier cycles remain in [the retained verification report.
