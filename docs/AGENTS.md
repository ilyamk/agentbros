# Docs — Agent Rules

Last updated: 2026-11-20

[README.md](../README.md) links the guides.

| Kind | Where | Treat as |
|------|-------|----------|
| Guides | `docs/*.md` without a `-plan` suffix, `workflows/` (listed below) | Current behaviour |
| Plans | `*-plan.md`, `workflows/recording-edit.md` | Active product scope or a maintained workflow contract. Each plan opens with a `Status:` line; completed plans are removed once current guidance covers them |
| RFCs | `rfcs/NNNN-<slug>.md` | Public proposals; each opens with a `Status:` line. [0001](rfcs/0001-contribution-system.md): open contribution system; [0002](rfcs/0002-value-first-contribution.md): value-first contribution, delivery and quality loop (draft); [0003](rfcs/0003-reference-packs.md): reference packs, model reference inputs prepared, bound and checked (implemented; guide below); [0004](rfcs/0004-studio-console.md): studio console, a live local workspace for decisions, control and progress (implemented; guide below) |
| Run evidence | Ignored `out/qa/`; legacy `verification/` is also ignored | Local diagnostics, never tracked product inputs |
| Examples | `examples/` | Schema-tested requests; keep them valid |
| Vendored references | [reference/](reference/elevenlabs/README.md) | Upstream API facts and licences, not skills |
| README visuals | `readme/` | Illustrations and prompts (`readme/PROMPTS.md`); not renders |
| Generated | `dependency-licence-review.md`, `library/` (catalogue and previews), `film-types.md` and `film-types/`, `commands.md` | Rebuilt by `pnpm library:catalogue`, `pnpm library:preview`, `pnpm film:route --write-doc` and `pnpm commands --write-doc`; never edit by hand |

## Rules

- Never track machine paths, run logs or replay snapshots. Diagnostics go in ignored `out/qa/`; tracked docs describe current contracts, provenance and active scope.
- Fixtures establish neither live-provider nor human creative acceptance.
- Prefer existing guides. Index new guides in the README and below. Start plans with a `Status:` line.
- [Console](console.md): strategy editing, approvals, project settings and API keys.
- Before cleanup: `pnpm repo:hygiene --check` and `pnpm docs:audit --write` ([policy](cleanup.md)). Logs remain diagnostics.

## Guides

Setup:

- [how it works](how-it-works.md): one-page overview for people: the three commands, modes, where things live
- [architecture](architecture.md): layers, directory map, request flow, sources of truth, invariants and how to extend; updated with every structural change
- [cleanup](cleanup.md): project footprints, removal scopes and safeguards
- [context loading](context-loading.md): canary probe method and dated harness observations
- [commands](commands.md): generated command catalogue
- [library reference](library-reference.md): font loaders, provider clients and route decisions
- [design tokens](design-tokens.md): typography, timing and safe-zone defaults
- [motion examples](motion-examples.md): worked primitive calls
- [install](install.md): dependencies, checks and updates
- [Python](python-runtime.md): Python 3.13 host, isolated profiles, offset's 3.12 exception and uv gates (2026-11-18)

Bespoke film:

- [production chain](production-chain.md): index of the film steps; `production-chain/`: sections read per step
- [film types](film-types.md): generated index; `film-types/<type>.md` each
- [step lease](step-lease.md): per-step allow lists checked by every CLI, the MCP bridge and an optional hook; `step:unlock` (2026-11-17)
- [Creative A/B](creative-benchmark.md), [project experiments](experiments.md)
- [craft evaluation](craft-evaluation.md): offline craft evaluation
- [reference analysis](reference-analysis.md): measured and judged layers of a reference film
- [contributing references](contributing-references.md): the local analysis workflow, what may be contributed, `ref:contribute`, private references
- [agent vision](agent-vision.md): frames and sheets. [Render iteration](render-iteration.md): patches and readability
- [motion library](motion-library.md): library blocks and catalogue
- [prepared visualisations](visualisations.md): pinned diagrams, mounting and validation
- [chart evidence](chart-evidence.md): checking a chart's numbers and sources
- [photoreal 3D](photoreal-3d.md): Blender plates; [Vork](vork.md): experimental GPU scenes; visual qualification deferred
- [Blender arsenal](blender-arsenal/README.md): built-in recipes and proof workflow
- [Blender MCP evaluation](blender-mcp-evaluation.md): third-party Blender MCP servers reviewed, and why `blender:live` is our own

Product interfaces:

- [real interfaces](real-ui.md): routes and checks for showing a real product
- [app capture](capture-app.md): `capture:app`, a real web app frame by frame
- [HTML capture](html-capture.md): seekable HTML and Hyperframes
- [UI sources](ui-sources.md): pulling real components into the library

Templates, recipes and workflows:

- [template recipes](template-recipes.md): templates, recipes and animatics
- [workflows](workflows.md): the four local workflows behind `video:workflow`
- [product ad](workflows/product-ad.md): product advertising from original media
- [education](workflows/education.md): source-backed education
- [shorts series](workflows/shorts-series.md): reviewed source to a shorts series
- [entity cards](entity-workflow.md): entity cards and harness images
- [campaigns and localisation](campaigns-localization.md): campaigns, pinned worlds, translations

Choosing the kind of video:

- [playbooks](playbooks.md): playbook fields, maturity, matching, coverage and adding one

A user's own footage:

- [footage editing](footage-editing.md): start here: the order of commands
- [footage shots](footage-shots.md): shot transitions in natural footage
- [multicam and reframing](multicam-reframe.md): several cameras and vertical crops
- [speech](speech.md): transcripts and speech masks
- [offline word timing](offline-word-timing.md): native estimated word proposals
- [media ingest](media-ingest.md): local ingest and evidence selects
- [timeline](timeline-edit.md): TimelineIR and transactional edits
- [long form](longform.md): chapters and approved shorts
- [long-form integrity](longform-integrity.md): chapter render integrity
- [review UI](local-review-ui.md): `review:ui`, the console's timeline review
- [studio console](console.md): live projects, decisions, pause, cards, hooks, security (RFC 0004, 2026-11-17)

Sound and captions:

- [editorial audio](editorial-audio.md): offline rhythm, SFX and cost to finish
- [audio QA](local-audio-qa.md): local mastering and editorial audio QA
- [captions](caption-delivery.md): subtitle files and clean deliverables
- [caption styles](captions-styles.md): caption presets: research and recipes

Models and paid work:

- [model routing](production-model-routing.md): models for new briefs
- [legacy generation](legacy-generation.md): old generation routes, history only
- [fal catalogue](fal-catalogue.md): task concepts, specialist/medium selection, duration warnings, no-match/lexical shortlist, request scaffold and dry-run
- [fal integration](fal-integration.md): maintainer architecture, promotion and sync runbook
- [Higgsfield](higgsfield.md): cross-provider choice, comparison, refresh, requests, quotes and usage
- [Higgsfield prompting](higgsfield-prompting.md): prepared local/remote sources, @Video1/@Image1, rights and QA
- [reference packs](reference-packs.md): model reference inputs planned, derived, packed with compiled markers, approved and reviewed (`refs:*`)
- [exact model discovery](exact-model-discovery.md): offline endpoint discovery
- [paid execution](paid-execution.md): V2 and legacy paid jobs
- [HTTP streams](http-stream.md): durable HTTP image streaming
- [realtime sessions](realtime-sessions.md): bounded fal realtime capture
- [realtime editor](realtime-editor.md): offline realtime editor drafts
- [nonmedia model workflows](model-nonmedia-workflows.md): voice IDs, training artefacts, drafts
- [harness assets](harness-assets.md): importing agent-harness outputs

Assets:

- [shared media](assets.md): manifests and `assets:sync`
- [fonts and icons](local-fonts-icons.md): exact local fonts and icons
- [colour grading](colour-grading.md): scopes, ΔE, match, grades, LUTs, windows

Contribution and maintenance:

- [dependency licences](dependency-licences.md): package notices, integration evidence, policy, source-only review, ELK review
- [contribution gates](contributing-gates.md): intake, categories, evidence and deterministic checks
- [context budgets](context-budget.md): offline measurement and instruction hygiene
- [metrics and API surface](metrics.md): generated inventories and exported contracts
- [triage](triage.md): PR judging (currently inactive), instruction audits and spend reservations
- [releases](releases.md): change entries, release plans and generated credits
- [GitHub automation](github.md): workflow trust boundaries, CLA, claims, CI, repository security settings, Scorecard and release provenance
- [showcases](showcases.md): who fills each page, gallery manifests, media, contributor profiles and the Pages site (landing, genres, library, crew, needs board)
- [benchmark](benchmark.md): harness runs, signed results and calibrated picture comparisons

QA and delivery:

- [delivery](delivery.md): strict local delivery
- [QA evidence](qa-evidence.md): event frames, browser measurements, repairs
- [local verification](local-verification.md): lint and source verification
- [publishing](publishing.md): publishing a public copy

Integrations:

- [MCP](mcp.md): the local MCP CLI bridge
- [harnesses](harnesses.md): wiring coding agents, hooks and the dashboard (`harness:setup`)
- [optional backends](optional-backends.md): finishing handoffs and optional engines
- [Resolve worker](resolve-worker.md): the repo-root `workers/` Resolve clone
- [OpenCut boundary](opencut-integration-boundary.md): checked limits of an OpenCut integration

- [Media acquisition](media-fetch.md): public video/audio/image fetching, provider setup, durable results and budget bounds.

## Keeping AGENTS.md files current

- Changed commands, paths, schemas, defaults, rules or roles update the nearest `AGENTS.md` in the same commit. Set `Last updated` to that day; date only changed files.
- New areas get an `AGENTS.md` and root index row. Remove obsolete descriptions.
- A structural change (a top-level folder or `src/` area added, moved or removed; a route or the chain's shape; a moved source of truth; an invariant; an extension path) updates [architecture](architecture.md) and its `Last updated` in the same commit.
- If code and an `AGENTS.md` disagree, establish which is intended and fix the other.
- A new command, block, template or style is named in the playbooks it serves, same commit (`pnpm playbook --uses`).
- Add outside repositories, films and asset sources as `credits/<id>.json` and run `pnpm credits:write-doc` to rebuild [CREDITS.md](../CREDITS.md). Retain a library block's `inspiredBy`; reference-film credits update `analysedFor` ([releases](releases.md#credits-as-source-files)).
- Size budgets, one rule: root `AGENTS.md` 15 KiB (keep near 14.5 KiB), the four areas 24 KiB, every other `AGENTS.md` (sub-areas, playbooks) 12 KiB ([table](../tests/AGENTS.md#agentsmd-size-budgets)). Over budget: move detail a level down, never raise one file's cap. `tests/agents-md.test.ts` checks sizes, the index, dates and `CLAUDE.md`; `tests/agents-readme.test.ts` keeps `.agents/agents/README.md` in step with agent front matter.

- [Project icons and logos](icon-resources.md): six free sources, profiles, local SVG/PNG/WebP exports and delivery evidence (2026-11-15).

- Runtime: [Node](node-runtime.md), [macOS](local-macos.md), [workflow E2E](agent-workflow-e2e.md).
- [Audio integrations](audio-integrations.md): Openverse, ElevenLabs and Earshot contracts. [ElevenLabs speech](elevenlabs-speech.md): v4, clones, generated dialogue and phrase edits.
- [Earshot in the production flow](earshot-flow.md): hero sounds from measured candidates, measured cue leads, saved audits as evidence, reference sound maps, a chosen room-tone span.

- [Campaign production](campaign-production.md): agent batches, budgets, queues and reviews.
