# Long-form chapters and approved shorts

All operations are local. Existing projects keep their current renderer unless a
TimelineIR journal was explicitly created with the timeline editor. These commands
read `pipeline/timeline-edit.json`; they do not rewrite `project.json` or regenerate
media.

## Chapter manifest

`ChapterManifestSchema` in `src/types/longform.ts` validates version 1. Intervals are
exact **output frames in the TimelineIR timebase**, not source seconds. Each chapter
has its own revision; changing the manifest revision alone does not invalidate all
chapters.

```json
{
  "version": 1,
  "revision": 1,
  "chapters": [
    { "id": "intro", "title": "Introduction", "revision": 1,
      "start": { "num": 0, "den": 1 },
      "end": { "num": 2700, "den": 1 } },
    { "id": "lesson", "title": "Lesson", "revision": 1,
      "start": { "num": 2700, "den": 1 },
      "end": { "num": 5400, "den": 1 } }
  ],
  "protectedSpans": []
}
```

At 30fps these are two 90-second chapters. Different source frame rates and playback
rates map exactly through `outputToSource`. Captions stay in their original source
coordinates. Boundaries inside a caption word are rejected. Uncovered trailing gaps
are rejected rather than silently reducing duration. Leading/interior track gaps
keep their output timing. Outgoing fades that lack an adjacent chapter clip become
cuts; independent tracks keep their original timing inside the selected interval.

Preview the plan, then render explicitly:

```bash
pnpm exec tsx scripts/longform.ts --project demo --chapters chapters.json --format landscape
pnpm exec tsx scripts/longform.ts --project demo --chapters chapters.json --format landscape --apply
```

The first command is a dry run. `--apply` uses the registered generic Remotion
composition with a frozen chapter timeline and canonical project settings. No
provider or generation API is called. Output files are named by chapter and
fingerprint under `out/demo/chapters/landscape/`. FFprobe checks each temporary
render's video stream and duration before publishing its file and atomically
updating `cache.json`.

Fingerprints contain only the chapter slice, its own revision, used media checksums,
render configuration and renderer source checksum. Nested scene media paths count
as dependencies. Unknown or remote media checksums disable reuse. Cache hits require
an existing output with its recorded SHA-256, checked again during execution. A
change inside chapter one leaves chapter two reusable when its dependencies are
unchanged. Global renderer/style changes deliberately invalidate all affected
renders. Run one chapter-render command per project's cache at a time.

Whole-project `--audio-master` is rejected: playing its beginning for a later chapter
would misalign speech. Mix a master from the chapter's sliced TimelineIR instead;
independent voiceover/music/SFX tracks render directly with their correct source
trims. Cache completion is not QA approval or permission to publish.

## Protected context and shorts

The caller supplies protected spans; the system does not infer sentiment,
importance, causality, or which claims can safely lose their context. A protected
span has `id`, `start`, `end`, `reason` (`negation`, `caveat`, `claim-context`,
`user-keep`), `note`, and `requires` IDs. Any selected overlapping span must remain
whole. Required context spans must also be wholly selected.

A `ShortSelectionSchema` v1 document supplies `id`, `purpose`, ordered non-overlapping
`ranges`, and `approval: { approvedBy, approvedAt, selectionHash }`. Generate the
hash with exported `selectionHash(ranges)` before approval. It binds approval to
those exact intervals; a later interval edit requires renewed approval. This is
local attribution metadata, not an authentication or electronic-signature system.

```bash
pnpm exec tsx scripts/longform.ts --project demo --chapters chapters.json --short approved-short.json
```

This writes a new `pipeline/<short-id>.short.json` proposal containing the exact
concatenated TimelineIR, compiled snapshot, source intervals, retained caption
words, approval and protected-context evidence. Existing proposals are never
silently overwritten. It does not render or publish automatically. Review and
explicitly import its timeline using the normal timeline workflow. Source-index
transcripts can guide the human/agent selection, but their source seconds must be
mapped through the appropriate clip before becoming output-frame spans.

## Local verification

```bash
pnpm typecheck
pnpm exec tsx --test tests/longform.test.ts
```

Tests include a real synthetic three-minute local video, two FFmpeg chapter renders,
90-second duration checks, red/blue source-pixel checks, cache reuse, independent
chapter invalidation, nested media dependency invalidation, source-rate mapping,
caption-word protection and retained caveats. This fixture exercises the chapter
runner with an FFmpeg backend; the production backend renders the same sliced
TimelineIR through Remotion. No paid API or model request is used.
