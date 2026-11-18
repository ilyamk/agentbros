# Reviewed source → independent shorts series

The workflow turns multiple **supplied, reviewed selections** from an existing TimelineIR project into separate vertical projects, optionally square. It never generates speech/images, guesses a viral hook, translates a script, contacts an API, or grants approval. Originals, playback rates, source offsets, caption words, voice settings and canonical design are reused. Russian negation and caveat spans remain protected by the source chapter manifest.

## Prepare and review

To find the ranges in a long recording, `shorts:prepare` and `shorts:rank` turn a transcript and an agent's evidence-quoted candidates into scored proposals with unapproved selection drafts ([shorts selection](../../.agents/skills/recording-recut/references/shorts-selection.md)); a human still supplies every approval. `shorts:request` turns approved proposals into this request (chapters, source pin, plan check) without TypeScript.

The source needs `project.json`, `pipeline/timeline-edit.json`, and a versioned ChapterManifest (default `pipeline/chapters.json`). Originals must be local and readable. Approved entity bindings are resolved before deriving; brand/world/design/campaign context is frozen as evidence, not converted into new campaign budget authority. Source asset provenance and rights are copied when available. Legacy originals get unknown rights/billing; copying grants neither a licence nor a paid-generation receipt.

```ts
import { inspectShortsSeriesSource, runShortsSeriesWorkflow } from './src/lib/workflows/shorts-series';
import { selectionHash } from './src/lib/longform/plans';
const reviewed = inspectShortsSeriesSource('recording', 'pipeline/chapters.json', { rootDir: process.cwd() });
// A human reviews these exact ranges against these exact source hashes.
// Supply approvedBy/approvedAt yourself after actual review.
const request = {
  version: 1, seriesId: 'recording-shorts', source: reviewed.source,
  episodes: approvedSelections.map(selection => ({
    selection, // ShortSelection, approval.selectionHash === selectionHash(selection.ranges)
    approvedSourceHash: reviewed.approvalSourceHash,
    formats: ['vertical', 'square'],
  })),
};
const plan = runShortsSeriesWorkflow(request, { action: 'plan' });
const created = runShortsSeriesWorkflow(request, { action: 'create' });
```

There must be 2–30 selections. Ranges use the source TimelineIR rational timebase, not assumed milliseconds. Each selection needs an exact approval hash and the full inspected source approval hash. Cuts through caption words, omitted protected context/dependencies, overlapping/out-of-bounds ranges, source changes, unknown media and unrepresentable sub-frame clips fail before publication. Multiple ordered disjoint ranges retain separate source intervals while their output starts and captions are rebased.

`plan` performs read-only probing/hashing, with no writes. `scopeRoot` additionally confines all source originals and outputs to a trusted root for MCP use. ID/path ownership and symlinks are checked. A plan does not approve content, licence or delivery.

## Create and render

Each `<seriesId>-<selection.id>` contains its own canonical config, zero-revision timeline edit journal, hashed copied originals and asset registry. `pipeline/shorts-evidence.json` records source identity, selection approval, protected context, compiled timeline and source mappings. `pipeline/shorts-source-context.json` preserves resolved entity pins and source brand/world/campaign snapshots. `pipeline/workflow-render.json` requires explicit timeline rendering.

A cooperative publication lock serializes workflow writers. All artifacts stage first; exclusive directory creation refuses existing destinations, including racing empty directories. Episode bindings publish before canonical configs, and `public/projects/<seriesId>/series-commit.json` publishes last. Caught failures roll back this transaction's new directories. A process crash can leave orphan directories; it cannot establish a committed series without the marker. **This is not an atomic rename of multiple directories.** Do not manually delete an orphan if its ownership is unclear: inspect/reconcile it, then choose a new series ID or explicitly remove only confirmed workflow residue.

`assertShortsSeriesReady(projectDirectory, {rootDir, timeline:true})` checks binding ownership, committed series identity and all frozen episode artifact hashes. Shared render planning must call this guard. Exact replay returns committed outputs; changed request/source requires a newly reviewed series ID. Editing a frozen episode journal makes the guard fail: rederive/reapprove a new series rather than silently rewriting the approved selection. Render/QA output files added later are not part of the immutable input list.

```sh
pnpm render -- --project recording-shorts-hook --format vertical --timeline
pnpm render -- --project recording-shorts-caveat --format square --timeline
pnpm qa:screenshots -- --project recording-shorts-caveat
```

Mandatory education/product factual evidence is inherited for selected whole owning visual scenes. Partial selection of a claim scene fails: supply its entire clip and protected contextual dependencies. Each derivative gets only its selected claims in `pipeline/workflow-claims.json`, with mapped derived scene IDs and checksum-verified text originals copied into `pipeline/evidence/`. These become immutable inputs and remain mandatory for shared claim QA/review; source evidence and claim-map changes invalidate the source approval pin. A claim that cannot bind to a source visual scene fails instead of being guessed.

Render each episode separately. Use project QA and delivery commands documented by `pnpm qa:editorial --help` and `pnpm delivery --help`; capture actual media/audio/font/rights evidence, then record explicit human creative and delivery approvals. Do not copy the source QA approval, use the whole-source audio master, or reuse source localization timestamps for changed language. Check safe crop, whole words, context, readable captions, audio tails and rights in each requested format. The workflow's commit receipt is an integrity receipt, not creative/delivery approval.

## Local verification

```sh
node node_modules/tsx/dist/cli.mjs --test tests/workflow-shorts-series.test.ts
RUN_WORKFLOW_RENDER_TESTS=1 WORKFLOW_ARTIFACTS_DIR=/absolute/proof \
  node node_modules/tsx/dist/cli.mjs --test tests/workflow-shorts-series.browser.test.ts
```

The browser fixture renders the actual ProductionRoot, three H.264 vertical MP4s and square stills. Source media are synthetic colour blocks and distinct audio tones; Cyrillic strings are explicitly supplied test labels, **not a claimed transcription or creator recording**. Test approval declarations are labelled synthetic and grant no production consent. Exact source tone frequencies, durations, audio stream presence and mounted Russian negation are asserted. Saved MP4s, caption/start/tail/condition PNGs, source-mapping evidence and ffprobe reports remain for human inspection only when the artifact environment variable is set. MP4 fixtures render at 0.2 scale for local speed; composition layout remains 1080×1920, square stills remain 1080×1080. Arial is an offline test-only alias, not a branding or licence change.
