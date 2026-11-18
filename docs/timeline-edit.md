# TimelineIR v1 and transactional editing

The edit journal lives at `public/projects/<id>/pipeline/timeline-edit.json`.
It contains an exact `TimelineIR`, a monotonically increasing journal revision,
and complete before/after snapshots for undo and redo. Existing `project.json`
files are imported without changes; unknown project and scene fields survive in
`legacyProject` and each visual clip's `payload.scene`.

## Time and track semantics

`{num, den}` represents an exact rational **frame count**. A `timebase` is frames
per second, also rational (for example `{num:30000,den:1001}`). `clip.start` uses
the output timebase; `clip.source.start/end` use the source timebase. Source end
is exclusive. Positive rational `rate` controls playback speed.

Clips on one track have serial, non-overlapping owned intervals. Visual fade
padding is an effect at a boundary, not extra narration time. Fade transitions
require a contiguous next visual clip and must fit both adjacent intervals.
Speech is never crossfaded implicitly. Cross-track gaps and independent lengths
are intentional; edits never move another track unless the command names it.
Caption intervals use **source frames** and compile to output frames after
trimming and playback-rate conversion. A source word crossing a split is clipped
into the two owned output intervals.

`compileTimelineIR()` returns a deeply frozen snapshot with exact rational
intervals and `durationInFrames` rounded up only for the final render boundary.
A renderer must preserve these source mappings rather than rounding each edit.

## CLI

No API key is needed. All commands emit one JSON envelope on stdout.

```sh
pnpm exec tsx scripts/timeline-edit.ts --project demo --init
pnpm exec tsx scripts/timeline-edit.ts --project demo --revision 0 \
  --command '{"type":"rate","trackId":"visual","clipId":"hook","rate":{"num":2,"den":1}}' --dry-run
pnpm exec tsx scripts/timeline-edit.ts --project demo --revision 0 --command-file edits.json
pnpm exec tsx scripts/timeline-edit.ts --project demo --revision 1 --undo
pnpm exec tsx scripts/timeline-edit.ts --project demo --revision 2 --redo
```

Commands: `add-track`, `trim`, `split`, `reframe-visual`, `remove-visual`, `move`, `transfer`, `ripple`, `replace`, `transition`, `rate`, `authored-copy`, `audio-gain`, `audio-loop`,
`captions`, `caption-style`, `add-overlay`, `update-overlay`, `remove-overlay` (see Overlays below), and transactional `batch`. `caption-style` sets the timeline's burned caption profile
(`{"type":"caption-style","style":{"profile":"outline-pop","options":{"accent":"#3DFF6E"}}}`; `style:null` returns to karaoke;
see [caption delivery](caption-delivery.md)). A split requires a unique `newClipId` and
an output-frame `at`. Trim uses source-frame `start/end` and cannot extend beyond
the existing source interval. Replace supplies a new asset ID and full source
interval; existing captions are cleared because they belong to the old source.
Changing duration or position does not ripple implicitly. Use a batch for edits
that temporarily violate adjacency; the final batch result is validated once.

`authored-copy` changes authored on-screen headline/subtext in a supported visual
scene. Save the following JSON as `copy-edit.json`, substitute the actual track
and clip IDs, and use `--command-file copy-edit.json --dry-run` at the current
revision before applying the same file explicitly:

```json
{"type":"authored-copy","trackId":"visual","clipId":"hook","target":"legacy","headline":"Your next idea","subtext":"Make it visible"}
```

`target:"legacy"` supports plain title/feature/product/CTA scenes without a
template; `target:"scene.hook"` supports the exact version1 title template and
updates its effective template props. Omit a field to keep it; `subtext:null`
removes subtext. Choose at least one field. A headline must be nonblank, at most
80 UTF-16 code units and3 LF-separated lines; subtext allows160 code units and4
lines. Unsupported control/bidirectional characters refuse. These are drafting
bounds, not text-fit or safe-zone guarantees; existing CSS determines wrapping.

Speech text, timed captions, source spans, colours and animation are independent.
Media/proof/presenter scenes and declared factual, educational, recipe or
source-owned workflow projects refuse. Do not remove evidence or workflow
bindings to bypass this protection. Prepare/dry-run writes nothing; explicit
Apply uses journal revision CAS and one Undo. Original `project.json` and old
exports stay unchanged: render with `--timeline` and review the complete copy in
every requested format. See [review controls](local-review-ui.md) and
eighteen-frame technical acceptance and limitations.

`remove-visual` removes one plain visual clip reference and leaves a gap:
`{"type":"remove-visual","trackId":"cutaways","clipId":"cutaway"}`.
It preserves other clips and original files. Caption-bearing clips, authored
scene/payload animation, attached fades and known talking-head layouts refuse.
Only inert original-hash metadata is supported. The exact final rational timeline
duration must remain unchanged, including nested batches containing removal;
removing the sole final-duration owner therefore refuses. Batches still validate
only their final state, so an explicit delete/reinsert batch can remain valid.
Other commands retain their existing duration-changing behavior. The typed UI
resolves registered static PNG/JPEG or supported plain muted CFR H264 video before
preparation; generic Apply is journal CAS, not an original-file transaction.


The review UI offers visual multi-selection for 2–24 existing clips and a signed
exact output-frame delta. Its authenticated readonly group proposal resolves IDs
from the current journal into an existing `batch` of `move` commands. This lets
adjacent clips move together even when the first individual move would collide.
It preserves spacing, source/rate/payload/captions and all unselected tracks;
negative starts, overflow beyond the current duration, final overlap and broken
fade ownership refuse before writing. Prepare, explicit Apply/CAS and one Undo
remain separate actions; there is no new group command in TimelineIR. See the
[group controls](local-review-ui.md) and measured acceptance.

`reframe-visual` sets the cover alignment of a plain visual clip, or of a recording-edit picture clip (its `volume`, `sourceHash`, `editHash` and punch-in `transform` are kept; the punch-in scales the cropped frame), for one format:
`{"type":"reframe-visual","trackId":"visual","clipId":"c1","format":"vertical","position":{"x":0.3,"y":0.5}}`.
`position` may instead be a crop path, `{"keyframes":[{"frame":0,"x":0.2,"y":0.5},...]}`
(at most 20 000 keyframes with increasing integer **source frames** in the clip's
source timebase), read at the clip's current source frame, linear between
keyframes and held outside them. `reframe:track` writes such paths; see
[several cameras and reframing](multicam-reframe.md). `null` restores the centre.

`transfer` moves a visual clip into another existing visual track while preserving
its source range, rate, captions and payload. For example,
`{"type":"transfer","trackId":"visual","clipId":"hook","targetTrackId":"overlay","start":{"num":9003,"den":100}}`
uses an exact output-frame start. The target must have room for the complete clip
and no colliding clip ID. Nonvisual transfers and clips attached to an incoming
or outgoing fade are refused; edit transition ownership explicitly first.
Existing speech/audio/caption/presenter tracks remain unchanged. The review UI
offers an exact form and cross-track drag proposal; release only dry-runs, then
explicit Apply checks the revision. Cancellation, undo/redo and source integrity
use the same journal.

`audio-gain` and `audio-loop` target music/SFX clips only. For example,
`{"type":"audio-gain","trackId":"music","clipId":"bg","gain":0}` mutes a clip;
`gain:0.25` multiplies its existing base volume and every absolute mix keyframe.
`gain:null` removes the override, preserving original volume/automation. Speech,
caption and presenter tracks cannot be targeted. These commands preserve source
ranges and playback rate; undo restores the recorded values.

`{"type":"audio-loop","trackId":"music","clipId":"bg","loop":true}` enables
repetition; `loop:false` disables it and `loop:null` removes the override (off).
New looping edits require a zero source origin. Project CLI/HTTP dry-run, Apply
and relevant undo/redo validate the imported immutable original with local
ffprobe before journal publication. The physical audio stream duration must
agree with the registry within1ms. Originals must be regular nonsymlink
project-local files within128MiB; missing ffprobe returns `FFMPEG_MISSING` in
CLI. The probe has a5s timeout and64KiB output bound. Missing/ambiguous
stream duration and changed/corrupt originals refuse edits; editable registry
metadata alone never establishes duration. Loop-off beyond the physical end
requires explicit `trim` plus `audio-loop` in one atomic batch; no source is
trimmed automatically. Standalone in-process stores need the trusted project
validator to enforce this media contract.

Music/SFX move and trim commands also run these physical checks on the final
candidate, including an atomic batch and relevant undo/redo. New edits cannot
create a nonzero source origin on a looping clip; unrelated legacy reads and
renders remain compatible. The review UI prepares exact rational positions and
inward trims using the existing dialect. A start trim uses trim+move to preserve
the previous output end at the unchanged playback rate; an end trim preserves
the output start. No implicit ripple, loop toggle or speech/caption edit occurs.


The review form prepares a command; explicit Apply checks CAS. Original asset
previews and old exports remain unchanged. Direct timeline playback respects
clip attenuation/loop but does not apply mixer bus automation or ducking.
An explicitly mounted measured master replaces track audio: remix with
`pnpm audio:mix --project ID --output public/projects/ID/music/master.wav`
after audio edits, then mount the new verified master for render and measure
encoded output.


`dryRun()` reads and validates without changing bytes. `apply/undo/redo` require
the exact current journal revision. Undo restores identical IR content while
incrementing the journal revision. A new applied command clears redo history.
Writes use an exclusive lock plus a synced temporary file and atomic rename.
A leftover `.lock` after an interrupted process is deliberately not stolen:
inspect active editors before removing it manually.

## Overlays: library blocks over the picture

`overlays` lays motion library blocks over a recut or any other timeline: a text
hook in the first seconds, a written ad disclosure, a lower third (typography
category), a number callout. Each item is a block id, props that override the
block's `defaultProps`, an output-frame interval `[start, end)` in the timeline
timebase and a `layer`, `below-captions` (between the picture and the captions)
or `above-captions` (over everything, the presenter included). In a talking-head
layout both layers sit above the whole layout. Only `typography`, `data`, `ui`
and `kinetic` blocks are accepted (`OVERLAY_CATEGORIES` in
`src/lib/timeline-ir/overlays.ts`); captions stay with `caption-style`. Most
blocks paint a ground: set it to `transparent` (`ground` and `groundBefore` of
`type-hero-word`, `ground` of `type-lower-third`, whose default `preview` paints a
stand-in picture; `backdrop: "none"` for `ui-touch-hotspot`) or the block hides
the footage. `timeline:edit` and `render --timeline` refuse an overlay that leaves
any of `ground`, `groundBefore`, `background` or `backdrop` unset (a colour set on
purpose, such as a title card, is accepted). `update-overlay` replaces `props`
whole, so repeat those props in it.

```sh
pnpm timeline:edit --project demo --revision 3 --dry-run --command \
  '{"type":"add-overlay","overlay":{"id":"hook","block":"type-hero-word","props":{"text":"Stop scrolling","ground":"transparent","groundBefore":"transparent","ink":"#FFFFFF"},"start":{"num":0,"den":1},"end":{"num":75,"den":1},"layer":"above-captions"}}'
```

Then apply the same command without `--dry-run`. `update-overlay` changes any of
`block`, `props` (replaced whole), `start`, `end` and `layer` by `overlayId`;
`remove-overlay` removes one. `timeline:edit` checks every overlay a command adds
or changes against `docs/library/catalogue.json`: the block exists, its category
fits, and each prop matches the block's props schema (unknown props refuse); a
render with `--timeline` checks all of them again. An overlay may not end after
the timeline when it is placed; later picture edits never move overlays (like
other tracks, nothing ripples implicitly). Pick blocks and props with
`pnpm library:list` and look at them with `pnpm library:preview --id <id>`.

Chapters and shorts keep overlays on their own clock: each slice keeps the part
of an overlay inside the selected range, and a part cut at its start records the
frames already played in `offset`, so the block continues rather than restarting.
A short made of several ranges prefixes overlay ids like clip ids. A timeline
with no overlays has no `overlays` field (removing the last one deletes it), so
its bytes and every hash over it stay as before. A revised recut is a new project:
add overlays after the recut is approved and keep the commands in a
`--command-file` batch to apply them again.

## Public API

- `adaptLegacyProject(rawProject, projectId)` imports the canonical configuration.
- `migrateTimeline(raw, projectId?)` accepts v1 or an explicit legacy import;
  unknown future versions fail instead of dropping fields.
- `applyEdit(ir, command)` is a pure validated reducer.
- `compileTimelineIR(ir)`, `clipDuration`, `sourceToOutput`, `outputToSource`
  provide exact timing and caption mappings.
- `TimelineEditStore(file)` exposes `initialize`, `read`, `dryRun`, `apply`,
  `undo`, and `redo`.

Asset IDs accept registry IDs such as `sha256:<hash>`. Legacy imports keep media
paths and virtual `scene:<id>` IDs so they do not invent unavailable asset records.
The render/asset layer resolves those bindings; an edit never downloads media.
Render the journal explicitly with `pnpm render -- --project <id> --timeline`.
Without `--timeline`, rendering still uses the approved canonical `project.json`.
Timeline rendering reads one validated journal snapshot and resolves registered
asset IDs or local legacy paths before Chromium starts. Visual, presenter,
voiceover, music, SFX and captions are independent tracks. Media trim and playback
rate follow source timebases; captions follow the compiled output intervals.
Visual transforms support `payload.transform.{x,y,scale,rotation}` and audio clips
support `payload.volume` and `payload.loop`. At initialization, existing word
alignment files are imported once; later caption edits belong to the journal.

All output boundaries use an exact integer ceil of the rational conversion to
30fps; shared boundaries quantize identically. Source trim boundaries round to
the nearest Remotion source frame at the output fps. Fractions smaller than one
output frame may collapse a clip; the planner rejects such clips explicitly.
Outgoing visual dissolves hold their last owned source frame instead of reading
past the source trim. No extra speech is played during a visual dissolve.

The journal remains a separate artifact; rendering never rewrites `project.json`.
Browser verification is opt-in: `RUN_RENDER_TESTS=1 pnpm exec tsx --test
tests/timeline-render-browser.test.ts`. It uses synthetic local assets and an
offline font alias, checks changed pixels after replacement/rate/trim, and exact
pixel restoration after undo.

Verification: `pnpm exec tsx --test tests/edit*.test.ts` and `pnpm typecheck`.
