# Library — Agent Rules

Last updated: 2026-11-18

[CLIs](../../scripts/AGENTS.md).

## Boundaries that matter

- **API keys:** `setup/credential-store.ts` limits local overrides to the provider registry. CLIs load current values (2026-11-18).
- **Paid operations:** [root rules](../../AGENTS.md#paid-operations-and-budget), [Higgsfield cache and estimates](../../docs/higgsfield.md). `jobs/identity.ts` resolves V2 and legacy IDs before estimates or uploads. On resume keep hashes and quotes, and refuse unverifiable attempts. Reserve with the frozen `quotedRequestBody`, validate preparation and submit those bytes.
- **Originals are immutable:** ingest, audio repair and asset imports publish new outputs atomically and retain provenance.
- **Project footprint:** `pipeline/paths.ts` defines project ownership. `workspace/cleanup.ts` checks open jobs and pending billing before removal.
- **Project display title:** `project-display.ts` reads and writes the project's display metadata. The console projects the title before legacy name fields. Confirmed removal runs `project:remove` as the user.
- **Pipeline state:** only `pipeline/state.ts` `transition()` changes stage status.
- **Schemas:** live in `src/types/`. Change the schema, the code that uses it and any agent or skill that documents it together.
- **Path boundaries:** `cli/assertPathWithin` checks lexical and canonical containment, including new paths; dangling or cyclic symlinks are refused. Pipeline directories and artefact destinations use the same guard. Footage source redirects validate project IDs and containment before saving goals or bindings.
- **Dependency licences:** `contrib/licences.ts` collects notices and renders the review; `contrib/licence-review.ts` validates protected exact-version evidence. `contrib/dependencies.ts` applies the SPDX policy or a matching source-only review, preserving conditions and original declarations. `contrib/regen.ts` collects last. Binary/bundle scope is excluded ([guide](../../docs/dependency-licences.md)).

## Areas

| Path | Role | Guide |
|------|------|-------|
| `cli/` | `parseArgs`, `runScript`, `ERROR_CODES`; generated catalogue ≤24 KiB | `cli/example-usage.md` |
| `context/` | Offline budgets, scratch-project simulation with real next answers and briefs, instruction lint and security, advisory Markdown audit and seeded loading probes | [budgets](../../docs/context-budget.md), [loading](../../docs/context-loading.md), [cleanup](../../docs/cleanup.md) |
| `contrib/` | Offline intake, scouting, gates, failing-on-base and novelty checks, PR evidence, regeneration, comment commands and trust history | [contribution gates](../../docs/contributing-gates.md), [protocol](../../contrib/AGENTS.md) |
| `metrics/`, `api-surface/` | Deterministic inventory, README metrics and exported API snapshots | [metrics](../../docs/metrics.md) |
| `triage/` | Advisory judging by two model families (Anthropic, OpenAI or OpenRouter slots), instruction audits, settled spend reservations; `local.ts` runs one judge on the maintainer's own Codex or Claude Code without API spend | [triage](../../docs/triage.md) |
| `release/` | Change entries, release planning/apply and generated credits | [releases](../../docs/releases.md) |
| `showcase/`, `community/` | Showcase validation, media plans, gallery and contributor statistics | [showcases](../../docs/showcases.md) |
| `bench/` | Isolated harness runs, signed bundles, workflow outcome observers, deterministic verification and calibrated picture judging | [benchmark](../../docs/benchmark.md) |
| `python.ts` | Locked Python/uv launch, isolated profiles and quality gates | [Python](../../docs/python-runtime.md) |
| `cache-dir.ts` | Shared `~/.cache/agentbros` root, `AGENTBROS_MODEL_CACHE` override (deprecated `AI_VIDEO_CREATOR_MODEL_CACHE` still read when it is unset) and one-time legacy cache migration | [library reference](../../docs/library-reference.md) |
| `leak-scan.ts` | Shared scanner and `loadLeakPatterns`: optional local-pattern merging, required for local maintainer checks, disabled in CI | [publishing](../../docs/publishing.md) |
| `doctor/` | Environment checks behind `pnpm preflight` and `pnpm bootstrap` (`doctor/collect.ts`, probes only) | root `AGENTS.md` |
| `setup/`, `harness/` | First-run setup: key registry (`setup/keys.ts`, matched to `.env.example`), plan scopes and user report (`setup/plan.ts`); harness wiring (`harness/`; hooks installer, `hooksStatus` in `harness/hooks.ts`, 2026-11-17) | [SETUP.md](../../SETUP.md), [harnesses](../../docs/harnesses.md) |
| `pipeline/` | Paths and footprint, creative checks and timeline render, QA and delivery. `route.ts` detects routes and supplies ordered playbook reads, suggestions for unbound projects and fresh memory | [delivery](../../docs/delivery.md) |
| `workspace/` | Guarded cleanup plans (`cleanup.ts`) and source portability/output checks (`workspace/hygiene.ts`) | [cleanup](../../docs/cleanup.md) |
| `playbooks/` | Task playbooks: load, bind a project (`project.ts`), match a request, resolve, validate, tagged lessons, index table | [playbooks](../../playbooks/AGENTS.md) |
| `memory/` | The user's local memory: store, index, query, consolidate | [memory](../../memory/AGENTS.md), [code](memory/AGENTS.md) |
| `film/` | Bespoke film chain: steps and rules (`chain.ts`), film-type routes (`routes.ts`), briefs, critic pack, plan check, rubric | [production chain](../../docs/production-chain.md), [film types](../../docs/film-types.md) |
| `feedback/` | The user's feedback on a watched film, recording or campaign variant: film table `feedback/route.ts`, records `feedback/store.ts`, film `feedback/apply.ts`, footage steps with baselines `feedback/footage.ts`, campaign fix drafts `feedback/campaign.ts`. `cli/user-words.ts` refuses placeholder `--answer`/quotes | [production chain](../../docs/production-chain/feedback.md) |
| `step-lease/` | Step lease (2026-11-17): issue a step's allow list from the next-step answers (`step-lease/issue.ts`), the shared admission predicate, chain hash, unlocks and violations (`step-lease/lease.ts`, no chain or registry imports), registry mapping for `runScript` and the MCP bridge (`step-lease/guard.ts`) | [step lease](../../docs/step-lease.md) |
| `reference/` | Reference films: add, measure, compare, replica checks (`analyse.ts`, `replica.ts`); `corpus.ts`; calibration (`degrade.ts`); `speech-text.ts` (words local, structure tracked), `contribute.ts` | [reference analysis](../../docs/reference-analysis.md) |
| `library/` | Catalogue (`catalogue.ts`, `library:list`); each film's blocks (`usage.ts`) | [motion library](../../docs/motion-library.md) |
| `vision/` | Contact sheets, stills and frame reviews (`sheets.ts`, `composition.ts`) | [agent vision](../../docs/agent-vision.md) |
| `sensors/` | Measured checks of renders and pages: motion, pixels, text (`motion-check.ts`), WCAG 2.3.1 flashes (`flash.ts`, also read by `film:measure`), slop (`slop-signatures.ts`), generated-clip motion (`motion-expect.ts`) | [real UI](../../docs/real-ui.md) |
| `capture-app/` | Frame-by-frame capture of a real web app over CDP (`index.ts`) | [app capture](../../docs/capture-app.md) |
| `hyperframes/` | Hyperframes HTML render (`render.ts`) | [HTML capture](../../docs/html-capture.md) |
| `apis/` | SFX (`freesound.ts`), Lottie (`lottiefiles.ts`) and the trimmed legacy fal client (`fal.ts`); import each file directly | [legacy routes](../../docs/legacy-generation.md) |
| `providers/`, `models/` | fal/Higgsfield operations, guards `fal-guards/`, stream/realtime; `fal-plan-execution.ts`: role overrides; endpoints, pricing evidence; catalogues `models/{fal,hf}-catalog/`, prices `{fal,hf}-pricing.ts` | [routing](../../docs/production-model-routing.md), [fal](../../docs/fal-catalogue.md), [Higgsfield](../../docs/higgsfield.md) |
| `jobs/`, `budget/` | Durable jobs (`runner.ts`), batches (`batch.ts`), trainers (Soul ID), submission authority rechecks (2026-11-18). `OperationStore.configure` refuses a raised or first non-zero ceiling without a grant (the user's words, or a recorded brief/campaign/bench/operation-bounds authority) and appends `policyEvents`; `initial-policy.ts` installs a paid command's first ceiling only from a numeric `brief.budgetUsd` (2026-11-16) | [paid execution](../../docs/paid-execution.md) |
| `realtime/` | Bounded realtime sessions and editor | [realtime](../../docs/realtime-sessions.md), [editor](../../docs/realtime-editor.md) |
| `assets/`, `resources/`, `font-resources/` | Imports (`asset:import` converts HEIC to JPEG: `heic.ts`), stock and rights (`resources/stock/`), local fonts | [harness assets](../../docs/harness-assets.md), [fonts](../../docs/local-fonts-icons.md) |
| `shared-assets/` | Manifests and `assets:sync` for git-ignored shared media (`index.ts`) | [assets](../../docs/assets.md) |
| `entities/` | Versioned entity cards | [entities](../../docs/entity-workflow.md) |
| `references/` | Reference packs (RFC 0003): `profiles.ts`, `coverage.ts`, `compile.ts`, `dialects.ts`, `derive/`, `packs/`, `plan.ts`, `pack-status.ts`, `sensors.ts`, `review.ts` | [RFC](../../docs/rfcs/0003-reference-packs.md) |
| `timeline-ir/`, `editorial/` | Canonical timeline and editorial checks | [timeline](../../docs/timeline-edit.md) |
| `templates/` | Template registry and recipes | [recipes](../../docs/template-recipes.md) |
| `workflows/` | product-ad, education, recording-edit and shorts-series scenarios | [workflows](../../docs/workflows.md) |
| `longform/` | Chapters and shorts | [long form](../../docs/longform.md) |
| `ingest/` | Recording ingest, indexes and selects | [ingest](../../docs/media-ingest.md) |
| `footage/` | A user's recording: next step (`next.ts`, `footage:next`) and shot detection (`shots.ts`) | [footage editing](../../docs/footage-editing.md), [shots](../../docs/footage-shots.md) |
| `shorts/` | Shorts from a long recording: prepare, rank, calibrate, request (`rank.ts`) | [footage editing](../../docs/footage-editing.md) |
| `multicam/` | Multicam sync (offsets, drift), angle proposals and their timeline track, reframe crop paths | [multicam and reframing](../../docs/multicam-reframe.md) |
| `photo/` | Photo moves: crops, geometric zoom, minimum speed, blur fill (`crop.ts`, shared with `photo-move`); `photo:focus` (`focus.ts`) | [photo-slideshow](../../playbooks/photo-slideshow/AGENTS.md) |
| `matte/` | Local cut-outs for `matte`: engine choice (`engine.ts`), Vision and ONNX runs, ffmpeg I/O, temporal EMA and flicker (`temporal.ts`) | [matte](../../docs/matte.md) |
| `speech/` | Transcript builder (fillers, sentences, Scribe/fal mapping) and the local speech pipeline (Silero VAD, Parakeet, pyannote) | [speech](../../docs/speech.md) |
| `local-engines/` | Local engine preparation for `media:prepare` (`prepare.ts`) and local speech text | [speech](../../docs/speech.md) |
| `local-capabilities/suggestions.ts` | Optional task hints; consume resolved footage answer state and unsaved goals, tolerate non-object optional metadata, and skip unrelated stages | [workflow evaluation](../../docs/agent-workflow-e2e.md) |
| `audio/` | Analysis, mixing, repair, captions, SFX and rhythm evidence | [audio QA](../../docs/local-audio-qa.md), [editorial audio](../../docs/editorial-audio.md) |
| `audio-map/` | Music map, stems, edit plan, cue snap and leads (`analyse.ts`) for `audio:map`, `edit:plan`, `edit:snap` | [editorial audio](../../docs/editorial-audio.md) |
| `audio-curves/` | Per-frame audio curves for `audio:curves` (`compute.ts`) | [editorial audio](../../docs/editorial-audio.md) |
| `blender-arsenal/` | Extensions, generators, assets, recipes, live ops; `city.ts`, `overview.ts`, `generators.ts`, `eval*.ts`, `improvements.ts` (A/B), PDB | [arsenal](../../docs/blender-arsenal/README.md) |
| `music/` | Music search, shortlist, licence and fit for `pnpm music`; fal music runs (`shortlist.ts`) | [editorial audio](../../docs/editorial-audio.md) |
| `captions/` | Caption delivery; burned caption pages (`pages.ts`: `createTikTokStyleCaptions` grouping, 1–6 words, two lines, `strictWords` for stacked pages), key-word heuristic (`emphasis.ts`), readability, per-treatment contrast (outline, shadow, box) and platform safe zones, organic and ad (`readability.ts`), profile selection for timeline renders (`profiles.ts`); presets in `src/motion/library/captions/` | [captions](../../docs/caption-delivery.md), [styles](../../docs/captions-styles.md) |
| `delivery/` | Release checks and platform audio handoff | [delivery](../../docs/delivery.md) |
| `store/` | App Store and Google Play preview specs, probe checks and the conform plan for `store:conform` (`preview.ts`) | [app-store-preview](../../playbooks/app-store-preview/AGENTS.md) |
| `qa-evidence/`, `evaluation/` | Measured render evidence, craft evaluation | [QA evidence](../../docs/qa-evidence.md), [craft](../../docs/craft-evaluation.md) |
| `review-ui/`, `local-server/`, `console/` | Review services; loopback security; console server (2026-11-17) | [review UI](../../docs/local-review-ui.md), [console](../../docs/console.md) |
| `backends/` | Blender, Resolve, HTML/Hyperframes and native capture | [backends](../../docs/optional-backends.md), [HTML](../../docs/html-capture.md) |
| `campaigns/` | Campaign worlds and localisation | [campaigns](../../docs/campaigns-localization.md) |
| `verification/` | Lint (`lint.ts`): render rules (determinism, media, `STATIC_PATH`, `CSS_BG_IMAGE`) with `formatFinding` fixes; `--project` lints git-ignored `src/projects/<id>` (findings fail, slop warns) | [verification](../../docs/local-verification.md) |

Task discovery (2026-11-15): `models/fal-task-map.ts` defines ru/en concepts; `findFalEndpointResult` adds honest match metadata, lexical fallback and suggested memory gaps. Specialists suppress generic video/music generation; medium-specific utilities require matching media, and input-driven durations warn instead of filtering. The array API retains no-task browsing. [Guide](../../docs/fal-catalogue.md).

Console media references follow the media server’s file-type allowlist. Approval hashes retain all bound artefacts (2026-11-18).
The console document API also previews the pending strategy JSON. Strategy saves use the same project queue as decisions and reseal the strategy through the film engine (2026-11-18).
Console lifecycle checks distinguish inaccessible process metadata from a stale lock. Authenticated reuse works without boot time, and denied inspection leaves the running server and its lock in place (2026-11-18).

## Sound and sync

Mixer, drum grid, stems, music structure, edit plan, cue leads, audio curves, SFX, masking and sync maps: [src/lib/audio/AGENTS.md](audio/AGENTS.md).

- **ElevenLabs v3/v4** use audio tags and punctuation for delivery. Keep exact silence on the timeline.

Modules: `design-tokens.ts`, `fonts.ts`, `animations.ts`, `project.ts`, `project-props.ts`, `timeline.ts`, `render-plan.ts`, `asset-dispatcher.ts`, `pricing.ts`, `elevenlabs*.ts` and `chart-*.ts`.

## Fonts

Read [font loading, subsets and roles](../../docs/library-reference.md#fonts) before changing faces: Cyrillic coverage, variable axes, caption fallbacks and font-context boundaries are mandatory checks.

## Legacy generation

Kling 2.5, Seedance 2.0 and Hailuo 02 through `generate:video`, the gpt-image-2 alias and the old source aliases: [docs/legacy-generation.md](../../docs/legacy-generation.md). Do not migrate an approved legacy route silently.

---

## Design tokens and typography

Read [design tokens and typography](../../docs/design-tokens.md) before changing defaults or composing type: spring presets, timing, sizes, faces and safe zones. Check departures in frames at playback size.

## External APIs

Triage uses exported `TRIAGE_ANTHROPIC_API_KEY`, `TRIAGE_OPENAI_API_KEY` or `TRIAGE_OPENROUTER_API_KEY`, only those its judge slots need, and is off until `contrib/triage.json` sets `enabled`; its CLIs deliberately do not load `.env`. Configuration and refusal rules: [triage](../../docs/triage.md#configuration-and-costs).

Before changing a provider or selecting a generation route, read the [client map and decision tree](../../docs/library-reference.md#external-apis), including credentials, exact endpoint validation, provenance and budget rules.

- `media-fetch/`: public acquisition, budgets and resumable jobs ([guide](../../docs/media-fetch.md)); media inspection forbids network protocols.

Icon resources (2026-11-15): `icon-resources/` owns source adapters, profiles and exports; [guide](../../docs/icon-resources.md).

`viz/` prepares D3/ELK visualisation revisions, validates their inputs and exposes command orchestration.
`local-capabilities/` resolves task/language/operation readiness and policy; `apple/` runs prepared Swift adapters, validates artefacts and retains qualification/provenance. See [local macOS](../../docs/local-macos.md). Local results never execute during rendering.

Vork (2026-11-16): `vork/` owns pinned local preparation, shot tasks, rounded manufactured profiles, seeded instance finishes, bounded finite haze, render/export, VFX and import provenance. [Guide](../../docs/vork.md). No cloud or arbitrary MCP execution.

Openverse discovery: `resources/openverse.ts` shares bounded OAuth/cache metadata between resources and music. Aggregator audio is preview-only until its native original resolver and source rights succeed. Filters and provenance: [audio integrations](../../docs/audio-integrations.md).

`elevenlabs/` owns speech profiles, timed takes, voice selection, dubbing and reversible phrase edits. Jobs use `.cache/paid-responses` outside `public/` and reject unsafe cache paths before submit. Reference packs pin performed lines. Human listening approval is a separate receipt. [Audio integrations](../../docs/audio-integrations.md)

Task slots (2026-11-16): `models/model-slots.ts` resolves classes, constraints, project preferences and planning prices offline; maintenance and read-only outcome joins stay separate ([guide](../../docs/model-slots-guide.md)). Exact instruction exceptions bind complete current lines, including provider-specific resume facts and slot-selection guidance; stale wording fails the documentation guard.

Use-case routing (2026-11-15): `models/model-use-cases.json` maps production tasks and every provider category; `AGENTBROS_MODEL_USE_CASES` isolates the loader. Resolve use cases before task concepts.

Slot pricing (2026-11-15): per-slot references supply planning quantities; video-token, character, audio and image-area conversions stay in discovery. Unknowns return quote commands; generation admission is unchanged.

Price comparison (2026-11-15): `models/price-scenarios.json` names per-slot standard quantities; `price-matrix.ts` builds deterministic comparisons and safe linear fallbacks. `fal-historical-pricing.ts` syncs free one-endpoint historical averages, checkpointed at concurrency two; `AGENTBROS_FAL_HISTORICAL_PRICES` isolates reads/writes. Historical typicals only price one-call scenarios, never scaled seconds/characters. Single-model slots may explicitly share a class with `alsoClasses`.

Genjutsu preparation (2026-11-15): `model-preparation/` owns three-mode recipes, immutable derivatives, version-pinned refs, marker prompts, review/rights receipts, admission and lineage. New jobs validate approval before upload or reservation; legacy jobs resume unchanged. Delivery follows transitive provenance and exact input coverage; entity JSON/HTML is snapshot-bound evidence. Dated motion candidates never imply rights. [Recipe](../../docs/higgsfield-prompting.md#prepared-genjutsu-workflow).


Vision review packs reuse extraction/measurement owners; `vision/review-pack.ts` binds source/frame/crop/page hashes, `vision/review-view.ts` lays out paginated HTML/PNG, and `vision/review-adapters.ts` supplies existing-tool integration. `vision:evaluate` runs local isolated image-reading acceptance; no provider billing is inferred.

`runtime.ts` reads exact primary/reserve pins from package metadata; shared CLI runners enforce them before task execution ([policy](../../docs/node-runtime.md)).

Workflow observers (2026-11-16): `bench/workflow-*` bind source, command authority, actor traces and actual consumed hashes; fixture/native/agent/quality layers remain distinct; v4 refuses harness spend and tests actual consumers. Editorial QA accepts source/edit/clock-bound caption tracks. [Contracts](../../docs/agent-workflow-e2e.md).

Harness limits (2026-11-16): benchmark validation includes complete final JSON without a newline; corrupt events stay invalid. CLI retry delays must be finite and nonnegative; long waits are split within the Node timer limit.

fal unit semantics (2026-11-16): `fal:pricing --docs` checkpoints public Pricing sections; matched evidence resolves API units, derived frames/MP stay approximate and page/API drift plans at the higher rate, 2026-11-17 ([guide](../../docs/model-slots-guide.md#unit-semantics-from-fal-model-pages)).

Campaign production (2026-11-16): `campaigns/production/` coordinates immutable variant plans, shared-owner allocations, bounded retries, scenario assurance, pilot gates, repair journals and exact review packages over existing child routes. Paid identity remains in jobs; no-spend campaign bindings also block new reservations. [Guide](../../docs/campaign-production.md).

Remote originals (2026-11-16): `assets/remote-media.ts` owns checked public-link receipts; `remote-request.ts` binds schema URL fields. Fresh Higgsfield operations recheck bytes; queued resumes retain identity. [Remote sources](../../docs/higgsfield.md#public-content-links-and-checked-remote-originals).

Hardening (2026-11-16): `audio/local-mix.ts` `scopeMixPlanSources` contains a plan file's track sources (relative or absolute inside the root; no `..` or protocols); project mixes keep timeline assets under `public/`. `asset-dispatcher` routes `sfx`+`elevenlabs-sfx` through `providers/fal-sfx.ts` `runSfxGeneration` (`elevenlabs/sound-effects/v3`, durable job and budget admission); `metadata.dryRun` or `AGENTBROS_NO_SPEND=1` plans offline and leaves the asset pending. `media-fetch/http.ts` `assertPublicDestination` pre-flights `ref:add` links (DNS only, not yt-dlp redirects). `verification/lint.ts` rejects `Math.random`, `Date.now`, `performance.now`, argument-less `new Date()` and Tailwind `animate-*`/`transition*`/`duration-*` classes in rendered code (components, templates, motion, compositions, `src/Root.tsx`, `src/index.ts`); `src/types` gets the CLI rules only.

Legacy cleanup (2026-11-16): ElevenLabs voiceover and forced alignment live in `elevenlabs/tts.ts`; `elevenlabs-scribe.ts` and `elevenlabs-music.ts` stay at their protected paths.

Environment prefix (2026-11-16): every repository environment variable uses `AGENTBROS_` (the old `AVC_` prefix is gone, e.g. `AGENTBROS_MEMORY_ROOT`, `AGENTBROS_NO_SPEND`, `AGENTBROS_FAL_PRICES`); new variables must use it too.
Rules as code (2026-11-16): `lintProjectCode` runs the render rules over `src/projects/<id>`; `workspace/hygiene.ts` owns `MEDIA_BINARY`/`TRACKED_MEDIA_FOLDERS` for `repo:hygiene --check`.
Autonomy policy (2026-11-17): `autonomy/policy.ts` reads and appends `pipeline/policy.json`; `jobs/store.ts` binds to its budget (ceiling, per-job, providers, user-bound quotes) ([autonomy](../../docs/production-chain/autonomy.md)). Pre-answers (2026-11-17): `autonomy/pre-answers.ts` checks each key against the project and its options; `autonomy/project.ts` opens a film or a recording's source project; `footage/policy.ts` (read) and `footage/policy-apply.ts` (write, ledger) answer the caption style and shorts approval.
Step guard (2026-11-17): `runScript` loads `step-lease/guard.ts` only when `--project` names a project with `pipeline/session/lease.json`; `AGENTBROS_STEP_GUARD=warn|enforce|off`, unset: `effectiveGuardMode` (enforce for an autonomous policy or benchmark run, else warn); `AGENTBROS_STEP_ADMITTED` admits an admitted command's children ([step lease](../../docs/step-lease.md)).
Paid path (2026-11-17): `BUDGET_EXCEEDED` carries amounts; `cost:report` lists unreconciled jobs; fal inlines local `_url`; `models/capabilities.ts` is the vocabulary ([guide](../../docs/fal-catalogue.md#capabilities)).
Console (2026-11-17, RFC 0004): `console/` journal (`cli.*` into an existing `pipeline/`; id `console` reserved), server, bundle, Studio, `view/`, `notify*.ts`; a live older server can still yield a pairing link (2026-11-18).
