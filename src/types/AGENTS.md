# Types — Agent Rules

Last updated: 2026-11-20

Zod. Workflow v3 reads v2. Proof is opt-in. Corpora grant no approval.

`console-credentials.ts` validates key names, values and save revisions.

`console-document.ts` validates document locations, revision hashes and the scope of strategy saves.

Pins: `src/lib/blender-arsenal/generators.ts`; `blender-extensions.ts` also accepts capability tags. City recipe dependency META is in `src/lib/blender-arsenal/recipe-schema.ts`.

## Start here

```bash
pnpm typecheck
pnpm exec tsx --test tests/film-schemas.test.ts tests/creative-schemas.test.ts
```

## Map

`project-display.ts` defines the local project title and the Studio Console rename and deletion requests.

Artefacts: `public/projects/{id}/` unless stated.

| Schema file | Artefact | Written by |
|---|---|---|
| `dependency-licences.ts` | protected `contrib/licence-reviews.json`: exact-version source-only decisions, evidence hashes and conditions | user-requested technical review; `deps:licences` validates and renders |
| `pipeline.ts`, `studio.ts`, `creative.ts`, `film.ts`, `reference-replica.ts` | bespoke chain files in `pipeline/` | the step owner; schema per path: `ARTEFACT_SCHEMAS` in [chain.ts](../lib/film/chain.ts) |
| `pipeline.ts` | Brief, script, design, storyboard and plans; `PipelineStateSchema` only to read an old film's legacy approvals | `film:*`, `pipeline:check`, voiceover agents |
| `video.ts` | `project.json` | `project:new`, `composer` |
| `transcript.ts`, `speech-mask.ts` | `transcript.json`, `speech-mask.json` | `transcribe` (Scribe/fal), `speech:local` |
| `footage-goals.ts`, `footage-shots.ts`, `multicam.ts`, `shorts.ts` | `pipeline/footage-goals.json`, shots, sync and angles, shorts | `footage:next`, `footage:shots`, `multicam:*`, `reframe:track`, `shorts:*` |
| `timeline.ts`, `authored-copy.ts`, `caption-style.ts` | `pipeline/timeline-edit.json` (TimelineIR, its `overlays` of library blocks) and its commands | `timeline:edit`, `video:workflow`, review UI |
| `feedback.ts` | `pipeline/feedback/fb-NNN.json` (the user's quoted items on a watched render, routed by code) and `pipeline/feedback/open/<step>.json` (a step's open items, its tracked input) | `pnpm feedback`; film:done settles items |
| `policy.ts` | `pipeline/policy.json` (autonomy policy, revisions appended), `pipeline/decisions.jsonl` (decision ledger), `pipeline/guard.jsonl` (guard log) | `film:policy`, `film:approve --policy`, `film:revert`; film:brief, film:done, film:approve, feedback |
| `tournament.ts` | `pipeline/tournament/<shot>.json` (a hero shot's variants, packets, decision), the critic's results, and `memory/usage/<project>.json` (blocks a film used) | `shot:tournament`, `library:usage`, film:done on build |
| `playbook.ts` | `playbooks/<id>/playbook.json` (`stepRead` 2026-11-16) and a project's `pipeline/playbook.json` | content authors; `playbook --use`, `film:init --playbook`, `footage:next --playbook` |
| `reference.ts` | reference library files (`source`, `shots`, `speech-text`, `audio`, `motion`, `edit`, `techniques`, `blueprint`) and `design-reference/library/_corpus.json` | `ref:add`, `ref:analyze`, `reference-analyst`, `ref:corpus` |
| `calibration.ts` | `out/qa/calibration/`: per-segment `manifest.json`, critic `pairs.json` and `critic-key.json`, `report.json` | `ref:degrade`, `judge:calibrate` |
| `workflow-*.ts`, `recipes.ts`, `templates.ts`, `longform.ts` | workflow requests (`recut:plan` drafts a recording edit), recipes, templates, `pipeline/chapters.json` | `video:workflow`, `recut:plan`, `video:recipe`, `video:longform` |
| `delivery.ts`, `platform-audio*.ts`, `audio-master.ts`, `rhythm-evidence.ts` | delivery snapshots and receipts, audio master, rhythm evidence | `delivery`, `audio:mix` |
| `assets.ts`, `harness-assets.ts`, `resources.ts`, `font-resources.ts`, `entities.ts`, `campaigns.ts` | `pipeline/asset-registry.json` (kinds `image`, `video`, `audio`, plus `model3d`, `text`, `json` from provider results: no dimensions or duration), imports, licences, entity cards, campaigns; provenance origin `derivative` requires the `derivative` link to its refs:derive receipt (2026-11-17) | `asset:import`, `resources`, `resources:font`, `entity:card`, `campaign` |
| `references.ts`, `reference-profiles.ts`, `reference-view.ts`, `reference-pack-binding.ts` | [RFC 0003](../../docs/rfcs/0003-reference-packs.md): reference plans, derivative receipts and packs. Profile `marker: "none"` is positional. `markerGroup` shares an index. Derivative pins allow audio without dimensions and `DerivativeSpec.role` runs sensors. | `refs:*` |
| `higgsfield.ts` | Higgsfield schema docs, list floors, conditional tiers and request estimates | `hf:pricing` |
| `../lib/blender-arsenal/{libraries/schemas,recipe-schema,generators,eval-schema}.ts` | Library manifests, recipe META/proofs, benchmark tasks/plans/reports (v1 history, v2 executable; strict) | Arsenal CLIs |
| `blender-extensions.ts` | Arsenal pins (platforms, usage, optional capabilities), inspection and receipts | `blender:ext` |
| `fal-catalog.ts` | Provider catalogue, prices, pins, drift, discovery price/equivalents, match results/suggestions, curation and batch specs | `fal:find`, `fal:scaffold`, catalogue tools |
| `generation.ts`, `models.ts`, `pricing-evidence.ts` | provider requests (measured media MIME, optional schema validation), model registry, sealed pricing (large Higgsfield inputs retain their hash) | `generate:*` via `src/lib/providers` |
| `source-index.ts`, `ocr.ts`, `visual-search.ts`, `category-search.ts`, `native-word-timing.ts` | local ingest indexes and receipts | `media:*` |
| `matte.ts` | `matte.json` / `<stem>.matte.json` receipts beside a cut-out | `matte` |
| `contrib.ts` | Contribution blocks, categories, tiers, intake facts/verdicts and `.changes/` entries with their `novelty:` justification; release-PR route (`contrib/release.json`) | contributor; `change:add`, `contrib:intake` |
| `contrib-tools.ts` | Scout opportunities and curated opportunities (`contrib/opportunities.json`) with task-contract v1 fields (`source`, `priority`, `value`, `requires` with `paid: false`, `read`, `verify`; RFC 0002 §3.4), gate evidence and trust overrides | `contrib:scout`, `contrib:check`; maintainer |
| `leak-scan.ts` | Optional git-ignored leak-patterns.local.json pattern config at the repository root | local maintainer |
| `triage.ts` | Triage/audit configuration v2 (judge slots, two-family rule, caps, quotas), judgements, reports, spend ledger and durable remote reservation records | `triage:pr`, `triage:local`, `instructions:audit` |
| `credits.ts` | `credits/<id>.json` (tracked sources for generated `CREDITS.md`) | contributor; `credits:write-doc` generates the document |
| `showcase.ts`, `contributor.ts` | `showcases/<id>/showcase.json`, `community/contributors/<handle>.json` | `showcase:add`; contributor profiles are authored by contributors |
| `workflow-evaluation.ts` | Scenario pins, observations and reports | `bench:workflow` |
| `bench.ts` | Pinned suites/tasks, run bundles, judging packets/results and ratings | `bench:run`, `bench:sign`, `bench:verify`, `bench:judge`, `bench:rate` |
| `context-probe.ts` | Dated harness-loading probe records | `context:probe` |
| `chart-quantity.ts`, `craft-evaluation.ts` | chart bindings, craft evaluation | their `src/lib` service |

## Rules

- A schema is the only definition of its file. Do not redeclare its shape in a script, agent or skill; import it or link it.
- Most schemas are `.strict()`: an unknown field is an error, so a new field lands in the schema before anything writes it.
- Versions are literals (`schemaVersion: z.literal(1)` or `version: z.literal(1)`). A breaking change adds a new literal and keeps the old shape readable as a `z.discriminatedUnion` branch, as `RecordingEditRequestSchema` does for versions 1–3. Old files must keep parsing: prefer a new union branch; `migrateTimeline` (`src/lib/timeline-ir/legacy.ts`) is the explicit converter for timelines.
- Motion plan shots (`creative.ts`) may carry `function` (the corpus's `TechniqueFunctionSchema`) and `weight` (`hero`, `support`), and the plan a `signature`; all optional, so old plans parse.
- Cue sheet cues (`film.ts`) carry the sound decision: `sfx` or `silent: {reason}`, `layers` on a hero, `weight`. Optional in the schema so old sheets parse; `cueDecision()` in `src/lib/audio/cut-decisions.ts` is the one rule for which cues must decide.
- `reference.ts` layers are tracked for every analysed reference and are not `.strict()`: a new field is optional and an enum only grows, so every existing reference keeps validating. `ShotCorrectionSchema` normalises a `move`'s `shotId` to `shotIds`; read corrections through `correctedShots()` (`src/lib/reference/corrected.ts`), and a technique's `typography`, one object or one per role, through `typographyEntries()`. `ReferenceSpeechTextSchema` serves both forms: the tracked `speech-text.json` is structure only (no `text`), the git-ignored `media/speech-text.full.json` holds the words; write it through `writeLayer` or `writeSpeechText` (`src/lib/reference/speech-text.ts`), which split them.
- Paid jobs: optional V2 `canonicalInput`, raw-body SHA and `quotedRequestBody`; old jobs keep legacy identity. New Higgsfield pricing proofs pin `canonicalLocale`.
- Approvals, receipts and delivery identity hash exact bytes: change a hashed field only together with its reader.
- An additive field on a hashed artefact stays optional and absent when empty, never `.default([])`, so old files keep their bytes and hashes without a new version: TimelineIR `overlays` is the model ([timeline edit](../../docs/timeline-edit.md)).

## Change checklist

Commit the schema, readers/writers (`rg "types/<file>"`), documented examples, fixtures and changed table rows together. Run `pnpm typecheck` and the domain suites.

## See also

[Film engine](../lib/film/AGENTS.md), [src/lib](../lib/AGENTS.md), [tests](../../tests/AGENTS.md), [production chain](../../docs/production-chain.md).

- `media-fetch.ts`: strict acquisition options, jobs, individual results and issues; `media:fetch` writes project `pipeline/media-fetch/` state.

Icon contracts: `icon-resources.ts` defines candidates, acquisitions, derivatives, styles and placement bindings; [guide](../../docs/icon-resources.md).

`viz.ts` defines strict prepared visualisation requests, plans and immutable revision bundles.

Timeline replacement accepts optional `vizBinding`/format variants; ordinary replacement clears old bindings. Missing fields keep legacy serialisation.
`local-capabilities.ts` defines local policies, task states, text-unit requests, qualifications and receipts; `apple-results.ts` validates native domain observations. New artefacts stay separate from transcript/timeline/campaign contracts.

`vork.ts`: tasks/VFX, native v1/Cycles v2 receipts, hash-bound `vorkResult`.

Slots: [contracts](../../docs/model-slots-guide.md#contracts).

`resources.ts`: optional thumbnail/upstream roles; inspect original sources afresh before acquisition.

`elevenlabs*.ts`: speech profiles and timings. `speech-replacement.ts`: edit pins. `earshot.ts`, `sfx-selection.ts` and `sfx-map.ts`: local sound evidence. [Audio](../../docs/audio-integrations.md)

`model-preparation.ts`/`model-preparation-binding.ts`: Genjutsu receipts and approval pins. `remote-media.ts`: checked original receipts and optional remote bindings; absent on historical requests/jobs.

`vision-review.ts`: versioned declarative review requests and pinned page manifests. Missing measurements and caller numbers remain unverified.

`campaign-production.ts`: campaigns, pilots and repairs ([guide](../../docs/campaign-production.md)).

`step-lease.ts` (2026-11-17): the step lease, unlock and violation records under `pipeline/session/` ([step lease](../../docs/step-lease.md)).

`console.ts` (2026-11-17, RFC 0004; amend only via its §17): journal, view, decisions, cards, control, server files, ratings, HTTP/SSE bodies; zod-only (UI bundles it); fixtures `tests/fixtures/console/`. Amended: optional view `film`, `footage`, `replica`, `recipe`, `campaign`; `MediaRef.composition`; statuses `partial`, `unknown`. Hook cursors can hold a dashboard target hash (2026-11-18).
