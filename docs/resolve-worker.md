# Local Resolve clone worker

The optional worker uses `DaVinciResolveScript.scriptapp("Resolve")` from an installed
SDK. It does not download Resolve, generate media, call services or carry API keys
into the subprocess. The fixed repository Python entrypoint accepts only five
protocol actions; a handoff cannot name executable Python/JavaScript code.

Prepare a checksum-bound handoff with the existing backend exporter, open its
**owned** original project in Resolve, and use its unique timeline ID:

```bash
pnpm exec tsx scripts/resolve-handoff.ts --directory /absolute/handoff --action probe
pnpm exec tsx scripts/resolve-handoff.ts --directory /absolute/handoff --action execute
pnpm exec tsx --test tests/resolve-worker.test.ts
```

The CLI defaults to probe. It reports unavailable when the installed SDK or local
scripting connection is absent. Resolve 20.2+ within the 20.x series is the targeted
method subset; connection is not a claim of live compatibility. External scripting
availability depends on the installed edition/settings and remains operator-owned.

Execution duplicates the original timeline and verifies the returned unique ID and
project binding. It imports media and appends exact native clip specifications only
on that clone; it restores the previous selected timeline afterward. This adapter
uses checksum-bound OTIO/manifest intervals to build native items instead of
assuming that `ImportIntoTimeline()` supports FCPXML (that API documents AAF).
The supplied FCPXML path must still match the verified exported file.

Supported geometry: baked video/audio, independent visual/presenter/dialogue/music/
SFX tracks, gaps, integer output/source FPS that match, integral frame boundaries,
cut-only edits, positive source trims and rate 1. Local ffprobe validates actual
video FPS/constant-rate metadata, audio/video presence and trim bounds before any
Resolve mutation. Audio-only media without an FPS property uses the timeline frame
basis. Append API source end frames are
inclusive; canonical IR ends are exclusive. Native item IDs bind clips to tracks;
actual source paths, source-start/end getters, timeline starts/ends and source FPS
supply normalized readback. It rejects missing/extra/replaced/moved items, changed
native properties, Fusion effects and detected retiming. Duration comes from actual
exclusive native item ends. Native subtitle/karaoke conversion, nonunit playback
rates, differing/rational FPS, procedural payloads, transitions and OTIO effects
are rejected before creating a clone. Bake unsupported media operations first.
Exact JSON/SRT caption sidecars remain available from export, but are not claimed
as native subtitle readback. Grade, track-mixer and final visual fidelity require
manual finishing/QA; clip geometry verification does not certify those workflows.

Original fingerprinting exports a real DRT and hashes canonical ZIP entry names and
uncompressed contents (or raw bytes for non-ZIP exports), avoiding ZIP timestamps.
This detects changes beyond clip geometry. An unstable native DRT export fails
closed; it is not weakened to a superficial success check. Media originals and
handoff exports are rehashed by the existing protocol and worker.

Clone/import dispatch intentions and immutable receipts are preserved. A timeout,
crash or lost acknowledgement can leave a real clone or partial import. Resume
never blindly duplicates or appends again: reconcile the preserved clone/readback
manually; do not delete dispatch files to force a retry. Native import receipts are
published atomically without overwriting a prior acknowledgement. The existing
operation lease prevents concurrent handoff executors.

The local test SDK is explicitly synthetic Python code with persistent project
state, exercising the actual subprocess and native method arguments. Tests cover
clone/import/readback, source intervals, original DRT invariance, source replacement,
caption/FPS rejection and both clone/import acknowledgement loss. Resolve and its
SDK are absent on the implementation host: **no installed-app handoff has been
verified**. No live compatibility, rendering or paid-operation claim follows from
these fixtures.

API investigation used the packaged-SDK method reference as reproduced in this
[20.2 reference copy](https://gist.github.com/myamaazimi/4c83026bf4dc49779a2967670d8a246e),
plus Blackmagic's official [20.2 feature guide](https://documents.blackmagicdesign.com/SupportNotes/DaVinci_Resolve_20.2_New_Features_Guide.pdf).
The installed `Developer/Scripting/README.txt` remains the operational authority;
the reference copy is not itself a Blackmagic release artifact.
