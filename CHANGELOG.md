# Changelog

## 0.1.0

### Breaking changes

- Prepare and approve Genjutsu source segments, pinned references and marker prompts in three distinct modes; retain dated motion candidates, source-use rights and exact-result reviews through durable generation and delivery.

  Migration: Fresh Genjutsu motion-transfer, object-swap and restyle operations need an approved `model:prepare` request with `context.modelPreparation`. Existing durable jobs without that field retain their original resume contract. Record non-replica source-use rights with `film:rights --preparation`; use a new preparation ID for changed inputs or permissions.

- Remove legacy duplicate modules and dead code: scripts/generate-meme.ts (pnpm generate:meme already runs generate-image.ts --model gpt-image-2), the unused src/lib/apis barrel and Pollinations client, dead fal helpers and the unused @fal-ai/client dependency, generateSoundEffect and transcribeAndSave; src/lib/elevenlabs.ts moves to src/lib/elevenlabs/tts.ts.

  Migration: Replace pnpm exec tsx scripts/generate-meme.ts with pnpm generate:meme --prompt TEXT --output public/projects/ID/assets/memes/NAME.png --project ID --quality high. Import voiceover and forced-alignment helpers from src/lib/elevenlabs/tts.ts instead of src/lib/elevenlabs.ts.

- Remove the frozen 16-stage template-mode pipeline: `pipeline:init`, `pipeline:stage` and their MCP tools (`pipeline_init`, `pipeline_stage`), the stage state machine (`src/lib/pipeline/state.ts`), the `template` route of `pnpm next`, and the stage-only agents `character-bible`, `storyboarder`, `rhythm-editor`, `audio-mixer` and `composer` with the template-mode references. Every project.json project now goes to the timeline route (render, editorial QA, delivery), and a leftover `pipeline/pipeline-state.json` is ignored and noted in `detectedBy`; delivery and campaign final outputs always need `manualApproval`, and `qa:editorial` no longer reads stage statuses. `pipeline:check` stays as a stateless findings probe (artefact schemas, file references, charts, creative, film and music-rights findings) with no stage status or capture. `film:init` no longer writes `pipeline-state.json`; an older film's `approve` entries in it still count.

  Migration: an old template project resumes with `pnpm next --project <id>` and is delivered with `approvalMode: "manual"` and the user's `manualApproval`; its stage approvals in `pipeline-state.json` no longer count. Replace `pipeline:init` with `pnpm project:new` or `pnpm video:recipe --action materialize`, and drop `pipeline:stage` calls. A campaign `child-gates` package no longer offers template stage approvals.

- Raising a project's spend ceiling, or setting a first one above zero, needs the user's own words (`pnpm budget --ceiling-usd N --answer "..."`), recorded with when and why in `operations.json` `policyEvents`; lowering stays free, the MCP `budget` tool cannot raise it, and a null `brief.budgetUsd` no longer installs a $10 ceiling on the first paid command

  Migration: Existing stores keep their ceiling. To raise one, ask the user and pass their words with `--answer`. A project whose brief has no `budgetUsd` now needs `pnpm budget --project ID --ceiling-usd N --answer "<the user's words>"` before its first paid command. Code calling `OperationStore.configure` to raise a ceiling passes a `CeilingGrant` as the second argument.

### Motion library

- The library reel can show a captured product interaction: real before/after plates, camera stops and an optional carried control in landscape and portrait (CaptureProof), and it performs the matched ground-swap and caused-morph transitions (TransitionCut, TurnedRing) on one frame plan that also schedules the local sound accents ([#24](https://github.com/ilyamk/agentbros/pull/24))

### Task playbooks

- Playbook matching reads Chinese: every playbook has `zh` triggers, matched as character runs, and the reference, replica, remix and project modifiers understand Chinese. One extra word may stand inside a phrase; `triggers.generic` marks broad triggers that score half and never bind on their own; a trigger shared with a variant names the variant. `pnpm playbook --eval` scores matching on a labelled corpus of 221 English, Russian and Chinese requests, and the tests hold its floors (no wrong clear match)

### Providers and pricing

- Propose task-slot successors and freshness flags in daily model refresh, record local verdict acceptance evidence, and admit only verified model-refresh bot PRs for human review

- Unsplash and Pixabay join Pexels as stock adapters behind one interface (`src/lib/resources/stock/`): `pnpm resources --action search --provider auto` searches every source with a key and ranks the results for the frame (`--format`, `--zoom`), aspect, words and colour; acquisition downloads the size the frame needs, refuses a too-small file, reports Unsplash downloads and writes the usual receipt. Pixabay searches are cached 24 hours, rate-limit headers are remembered between runs, and creators reach release credits only on request (`--credit`, `--action credits`). The legacy `fetch:stock` and `fetch:pixabay` fetchers, which kept no licence record, are removed; asset-plan stock items now acquire through the same service. Set `UNSPLASH_ACCESS_KEY` (Access Key only) in `.env`.

### CLI commands

- The studio console's "Open in Remotion Studio" now starts Studio for the project in its current state on the user's click and opens it in a new tab: a bespoke film's build.json composition, or a project's format composition with exactly the render's props, updated live when opened again. New `studio:open` (`--status`, `--stop`) and console routes `GET`/`POST /api/projects/<id>/studio` and `…/studio/stop`. Studio runs under a loopback preload (127.0.0.1 only, non-loopback Host and cross-site writes refused), one per target, and stops with the console.

- pnpm harness:setup wires Codex, Cursor, Copilot, Antigravity, OpenCode, Devin, Cline, Amp, Kilo and Goose to the skills, agents and agentbros MCP server; MCP toolsets, avc_call and avc_guide

- Resolve public page/file links, import checked originals and bind exact Higgsfield URL fields without reuploading. Genjutsu can retain an entire conforming remote source through preparation, approval and result review; fresh operations recheck bytes while queued resumes keep their original URL identity and lineage. Historical requests and jobs need no new fields.

- Reference packs (RFC 0003) prepare the images, videos and audio a generation model receives instead of leaving them to hand-written prompts. `pnpm refs:plan` drafts each generated shot's reference inputs from approved entity cards and the target model's reference profile (`pnpm refs:profiles`), and checks them against that model's slots, limits and real-face policy; `pnpm entity:card --action coverage` reports which views a card still lacks. When an input is outside a model's limits, the plan proposes a reproducible derivative (trim, crop, scale, snap, frame extraction, flatten, audio trim and more) that `pnpm refs:derive` makes with a receipt, locally or through a durable paid job. `pnpm refs:pack` compiles an immutable pack with the model's own markers, a board for review, the user's rights and approval, and the exact request; `generate:model` verifies a bound pack and warns when reference fields are sent without one (`AGENTBROS_REFERENCE_PACKS=enforce` refuses them). The film chain's material step now requires planned references before approval and approved packs after it, and three new instruction benchmark tasks check that agents plan references, prefer derivatives and never type markers by hand.

- Add the studio console (RFC 0004, docs/console.md): a local page on 127.0.0.1 that shows every project live and takes the user's decisions. `pnpm next`, `film:next`, `footage:next` and `film:init` start it and add `console` and `hooks` blocks to their answers (`AGENTBROS_CONSOLE=off` starts nothing); `pnpm console [--open|--stop|--port]` starts it by hand. Pages: home, a project canvas with film, footage, replica, recipe and campaign panels, history from the new event journal (`pipeline/events.jsonl`, `AGENTBROS_EVENTS=off`), a timeline review, metrics, the motion library and settings, in English, Russian and Chinese, dark and light. Decisions (gates, choices, quotes, autonomy, budget, the final verdict, ratings with `ref:rate`, frame comments with `feedback --frame`, the recut plan's edit hash) are applied by running the owning CLI with the user's words, bound to the hashes the user saw (`--expect`), recorded in `pipeline/inbox/` and signed with a short-lived console grant. `console:control` pauses, resumes or stops a project: other commands then fail with the new error code `PAUSED`, and `job:cancel` cancels one paid job where the provider can. Agents post cards with `console:card` (MCP `avc_console_card`, read-only `avc_console_url` and `avc_console_view`) and wait with `console:wait`. Opt-in harness hooks for Claude Code and Codex (`harness:setup --hooks`: observe, guard, orient, relay, surface, wake), opt-in macOS notifications (`AGENTBROS_NOTIFY=off` holds them off), `console:snapshot` (read-only HTML, never published by the command) and an optional Claude Code status line (`harness:setup --statusline`). `pnpm review:ui` now opens the console's Timeline page; the old HTML-string review client is removed and the review services are unchanged. The session is hardened: the cookie holds a derived media-only value, no route returns the token, and agent-visible output (next-step answers, a non-terminal `pnpm console` or `review:ui`) carries a one-use pairing link instead of the token; console attribution needs a verified grant. The top bar changes autonomy and the budget ceiling (a raise shown with its command and amounts first), Stop cancels in-flight paid jobs one at a time, Settings shows and installs the hooks, History compares two versions, and metrics show wasted spend (unknown never as $0). Codex hooks match `spawn_agent` and guard `apply_patch`. Existing hook installs show as stale: re-run `pnpm harness:setup --hooks --apply`.

### Audio analysis and mixing

- Earshot now works inside the film chain instead of beside it. sfx:audition chooses each hero cue's sound from measured candidates (Earshot takes, the measured library, the synth pack) by fit and Earshot's model-free audit, writes sfx-selection.json, and sfx:cues --selection places the choices; the sound step's done check hero-sounds-selected (advisory in promo) holds the placed sound to the selection. film:measure's cut-sound-coverage measures each cue's lead from the placed sounds instead of fixed constants, and a new advisory sfx-evidence leg and critic:pack's audio-reviews.json carry saved audits of the exact bytes. sfx:map records a reference's candidate sound events by family, which the critic sees beside the placed density, and recut:plan --room-tone-span takes a chosen, checked room-tone span. Every Earshot reading stays advisory, and every step works when Earshot is not prepared.

### Agent instructions

- Agent instructions agree with their agents and tests: model-specific prompt markers live in the Higgsfield prompting guide, agent models are valid in both harnesses with a README consistency test, one AGENTS.md size rule with headroom, clearer playbook matching for typical EN/RU requests, and a one-page how-it-works guide

- Step-scoped reading: the production chain and film types split into an index plus per-step and per-type pages, playbooks gain stepRead, and playbook --id names each field once (--full for the rest), so a product promo's first step reads about half as much

### Harness and MCP integration

- Fast first-run setup for agents: SETUP.md, `./setup.sh` / `./setup.ps1` plan prerequisites by consent scope (repo, user, system) and install the approved ones, `pnpm bootstrap` applies repository steps with an optional one-second test render and writes out/setup/REPORT.md (machine limits, what works with no keys, keys by goal), and `pnpm keys` reports which service keys are set, never their values; one key registry now feeds doctor, keys and bootstrap, kept equal to .env.example by a test

- Film briefs go by reference: `film:brief` writes the brief and returns its path, a summary and a one-line `metadata.dispatch` that the orchestrator gives the subagent instead of the brief's text (`--print` still returns it), cutting the simulated product-promo run from 140k to 107k orchestrator tokens. Briefs quote the needed section of the creative teams, methods and rubric references instead of sending every agent to the whole file, and the new read-only `film:show` (also an MCP tool) prints a bounded digest of a step's inputs and outputs or one artefact, so agents no longer write scripts to look inside pipeline JSON.

- Coordinate video campaigns through five playbooks, explicit variant/catalogue plans, immutable budget allocations, shared material ownership, durable resource queues and input-bound agent decisions. Exact review packages retain child approval and strict delivery gates; local review drafts and supplied outcome metrics remain separate from approvals. No-spend campaigns forbid inherited submissions; explicit archive releases retention without deleting media.

- Make campaign orchestration distinguish waiting, bounded failures and completed work. Preserve compare-and-swap agent decision history, scoped presentation repair journals, strict scenario checks and exact pilot approvals. Add five local public-CLI flows through critique, repair and strict delivery; exclude delivery snapshots from authored shared-media discovery.

- Console project header: an Editing table button opens the timeline in a signed-in new tab, Edit myself pauses the agent with a hand-back banner, and Open in Remotion Studio starts Studio for the project instead of only copying the command

- Studio console: a banner at the top of every page asks the user to connect the agent hooks while Claude Code's or Codex's are missing or out of date; its dialog explains why the hooks matter for the console, shows each harness's status, checks again and installs or updates them (`harness:setup --hooks --apply`) on the user's click, and the banner can be hidden for good in this browser; Settings and the banner share one hooks status.

- context:budget --simulate estimates a whole run offline: the orchestrator's one conversation step by step in chain order (real next answers and film briefs rendered on a scratch project, estimated reports, user gates and command results, expected or worst rounds), where it crosses 100k and 200k tokens, its biggest contributors, and the fresh context of every subagent dispatch

- Contribution follow-ups: failing-on-base proof and novelty gates, release-PR intake route, showcase media and benchmark-bundle intake, playbook benchmark ids, deduplicated local gates that name failing tests

- Creative pools reopen: an upstream change or the user's feedback that reaches the concept teams or script writers starts a new blind round (every lane dispatched, briefs carry the user's quotes and the previous winner), a new review and a new pick, instead of leaving the chain stuck; `pnpm feedback` now routes concept to `ideas` and hook-line, words and ending-cta to `script-variants`, and asks the user after two feedback-driven reopens of one pool

- Curated contribution tasks carry task-contract fields (priority, value, requires, read, verify) and outrank scouted rows; every scout row states its source, `pnpm contrib:scout --can <caps>` drops tasks whose requirements the contributor cannot meet, the needs board features rows by source, and library rows ask for a renderable preview instead of a contributed image

- Autonomy as a project policy and a global guard for the film chain: `pnpm film:policy` grants, in the user's own words, an autonomous policy (`pipeline/policy.json`: budget bound to OperationStore, pre-answers, auto-pass steps, limits) under which film:next passes only the gates it names, each decision recorded in `pipeline/decisions.jsonl` and revocable with `pnpm film:revert`; every project, interactive too, now stops at its round, re-entry, active-hour and spend limits (`pipeline/guard.jsonl`) and presents the best kept version, raised only on the user's words

  Migration: Interactive projects answer exactly as before until a limit is reached (defaults: 30 rounds, 6 per step, 2 re-entries per step, 4 active hours); raise one with `pnpm film:policy --project ID --raise <limit>=<n> --answer "<the user's words>"`. A policy with a budget refuses OperationStore ceilings above its cap and providers outside its list.

- `pnpm feedback` turns the user's verdict on a watched film into a structured step input: each quoted item is routed by code to the step that owns its aspect, and on `--confirm` the step's open-feedback file reopens it and everything downstream through the receipt hashes; resealing with changed outputs marks the items addressed, the same objection twice asks the user

- The film guard's defaults now follow the mode: interactive projects stop at 60 rounds and 12 active hours, autonomous ones keep 30 and 4 (limits the user set still win); `film:revert` counts as a re-entry. `pnpm film:policy --spend-usd N` (on the user's words) lets an autonomous policy approve paid material: pending generated items with their bound, while every autonomously approved item's bound sums within N and the plan fits the durable budget; each approval is a `spend` decision with `amountUsd` in `pipeline/decisions.jsonl`, revocable with `film:revert`

  Migration: Policies written before this change stored every default limit, so an interactive project with such a policy keeps 30 rounds and 4 hours until its limits are revised; raise them with `pnpm film:policy --project ID --raise maxTotalRounds=60 --raise maxActiveHours=12 --answer "<the user's words>"`.

- Film chain narration step: explainer, ui-demo and ai-video films (and hybrids with them) direct the narrator after the script (`narrator-director`, `pipeline/narrator-direction.json`), get the user's yes to the voice and its spend bound before paid takes (the lease allows `generate:voiceover` spending only then, never at sound), and `pnpm narration:check` measures the takes, checks receipts and word timings and writes caption words and `pipeline/narration.json` for the beat sheet, build and sound; skippable when the script has no voice

- Every film render is kept as `out/<id>/versions/<sha256 prefix>.mp4` with an index of its steps and measure verdict, so a later render no longer loses an earlier one; `listFilmVersions` and `bestFilmVersion` rank them by measure pass, then critic total

- Template mode is frozen: `pnpm next` sends a project.json without pipeline state (recipe drafts, campaign children, project:new) to a new timeline route (render, editorial QA, delivery), while projects with pipeline-state.json keep the legacy template route, marked legacy; pipeline:init, pipeline:stage and the template-only commands move to the legacy section, and the explainer, motion-design and product-tutorial playbooks drop their template alternatives

- Add project icon and logo discovery, style profiles and verified local exports

- Bespoke film code is now linted: the animatic and build steps fail through a new `project-lint-clean` done check when `src/projects/<id>/` breaks a render rule (unseeded randomness, wall clock, CSS or library animation, native media tags), each finding a `file:line CODE: message. Fix: …` line, and `pnpm lint --project <id>` fails on the same findings. Two new render rules: `STATIC_PATH` (a bare `projects/…`, `shared/…` or `public/…` media `src` without `staticFile()`) and `CSS_BG_IMAGE` (a CSS background with `url()`). `repo:hygiene --check` now fails on media binaries outside the documented exceptions, and a test keeps every leaf agent's tools free of Task, Agent and wildcards; the root rules and motion-engineer's law are shorter now that code enforces them.

- Scout groups mechanical findings into contribution-sized rows, adds draft technique, slop threshold and curated sources, and reports per-category counts on the needs board

- ElevenLabs API references move from skills to docs/reference/elevenlabs, and overlapping skill descriptions are narrowed so agents pick one skill per request

- Step guard: with `AGENTBROS_STEP_GUARD` unset, a project with an autonomous policy or a benchmark run (a `--proxy benchmark` approval, or `AGENTBROS_INTERACTION_MODE=autonomous`) is enforced, interactive work still warns; `pnpm step:violations` (MCP `step_violations`) reports out-of-step runs by step, command and code with `clean`; `film:policy` and `film:revert` are always admitted

- Step lease: `next`, `film:next`, `film:brief` and `footage:next` write the current step's allow list and spend authority to `pipeline/session/lease.json`; every CLI and the MCP bridge check it (warn by default, `AGENTBROS_STEP_GUARD=enforce` refuses), `pnpm step:unlock --reason` is the recorded escape hatch, `film:status` reports out-of-step runs, and an optional Claude Code PreToolUse hook gives early feedback

- Triage: OpenRouter judge slots across two model families, off by default; settled budget, intake and trust gating, owner quotas; triage:local on the maintainer's Codex or Claude Code

- Add local Vork scene, render, recipe, Blender interchange, footage VFX and evaluation commands with source-bound receipts and agent guidance

- Separate complete-clip Vork qualification from short proofs, add explicit physical Cycles inserts and returned-geometry receipts, and improve bounded simulation authoring. Refine manufactured edges, seeded instance finishes and UV-bound textile shading; retain visual qualification as a separate gate.

  The full nine-case visual qualification and matched Blender comparison remain deferred; existing rendered examples carry no creative approval.

### Tests and continuous integration

- Opportunity issues from the community open with `needs-triage` and reach the public needs board only after a maintainer applies `agent-ready`; the showcases guide gains a table of who fills each page of the site

- Make releases retryable and idempotent: dispatch retry, one release at a time, tag-exists skip, metrics.json asset, open-PR-only release PR edits, showcase-media never Latest, and release notes without bots, unknown authors or empty sections

- OpenSSF Scorecard workflow and badge, CodeQL badge, signed build-provenance attestations on release source archives, and a repository security setup checklist with Best Practices evidence

- The Pages needs board drops claimed work and work in open PRs, and the site rebuilds nightly so the board and metrics stay current without a push

- Release gates are green on a fresh clone: CLIs accept later Node 26.13+/24.22+ patches with a warning, AGENTBROS_NO_DOTENV=1 keeps .env keys out of tests, spawned-process deadlines share a 30 s helper, the rhythm metadata helper tolerates a builtin _ctypes, the licence inventory and command catalogue are regenerated, and install docs add Chromium setup and HIGGSFIELD_API_KEY.

### Bug fixes

- category-gates no longer fails every Dependabot, release and models-refresh PR: without a change entry the catch-all fix and security categories (paths "**") matched every file, so a dependency bump needed a failing-on-base test. Catch-all categories now apply only when a change entry declares them. ([#22](https://github.com/ilyamk/agentbros/pull/22))

- Split autoclose closures into closed:slop and closed:process, count slop over 90 days, and limit appeals to bot closures and the appealed rule

- Collect dependency licence notices and validate inventory freshness in CI and public exports

  Collect every locked package identity, deduplicated licence texts and declared
  integration evidence in a committed JSON/Markdown inventory. Validate freshness in
  CI and regenerate after the credit ledger; strict checks retain unresolved reviews.

  Evaluate permitted SPDX AND/OR combinations without granting exceptions for ELK,
  Remotion or GSAP. Preserve public copyright attribution through exact leak-scan
  exceptions while continuing to block new addresses and credentials.

  Use the tsx CLI for inline memory and rhythm test probes so named imports work
  with the configured Node 22 runtime.

- Studio Console: accessible names include visible text on the GitHub button and version link, a long clip ID no longer widens the Timeline at 390 px, anchors and focus clear the sticky app bar, and collapsible blocks share one Disclosure component.

- Studio Console checkboxes, sliders and the document editor use the shared shadcn components, so they follow the theme in light and dark.

- Studio Console dropdowns all use the themed shadcn Select: no OS-drawn option lists, consistent width, alignment and truncation at 390 px, and no 'null' in the current-revision label.

- All repository environment variables now use the `AGENTBROS_` prefix; the old `AVC_` names (for example `AVC_MEMORY_ROOT`, `AVC_NO_SPEND`, `AVC_FAL_PRICES`) are renamed with the same suffix. No release has shipped the old names.

- preflight reports stale harness wiring, repo:hygiene checks harness links, and the playbook evaluator is a protected automation module

- Intake counts docs/api/surface.json as a generated file, like the library catalogue: a library PR that changes block props must carry the regenerated surface for CI, and intake no longer refuses it as outside the library category ([#26](https://github.com/ilyamk/agentbros/pull/26))

- PR intake accepts a rebuilt patch of a large text file when GitHub's counts come from its heuristic diff: GitHub counted uv.lock at +428/-289 where the minimal diff is +424/-285, so every PR touching uv.lock stayed uncertain. The rebuilt diff must have the same net change and no more lines than GitHub's counts

- The test suite and CI pass on Linux (Ubuntu 26.04, FFmpeg 8). Fixed for Linux users: studio:open's per-project lock no longer removes another opener's lock when the file system reuses an inode; fal:quote and fal batches hand the request to generate:model on descriptor 0 instead of opening /dev/stdin, which Linux refuses for a socket; recording checks ignore AAC end padding that FFmpeg 8 decodes past the declared duration and report the WebM remux hint before an Opus start offset; motion:check counts Chromium's console echo of an uncaught exception once. Render, native-preparation and Vork process cleanup identify a process by pid and start time, not its name: Linux renames a starting Node process ("MainThread"), which let detached children escape cleanup. The stems and diarize profiles take torchaudio and torchcodec from the PyTorch CPU index, since their PyPI Linux x64 wheels are CUDA builds. CI installs the pinned Python before python:check, and category-gates installs FFmpeg and Chromium for the failing-on-base proof, which now names the head tests that fail and why; a failing category gate reports its JSON verdict. PR intake rebuilds the patch GitHub omits for a large text file such as uv.lock from the merge base and head (blobs over 1 MB), accepts it only when its line counts equal GitHub's and leak-scans it, instead of always deferring such a PR. Rhythm tests that need macOS's sandbox-exec skip elsewhere. ([#12](https://github.com/ilyamk/agentbros/pull/12))

- motion:render prepares a composition's shared assets from its input props: a flat screen product reveal with its own screen image and a library reel built from a capture no longer fetch the studio phone model and HDRIs they never show. A reproducible capture-based library proof is in examples/workflows/product-ad/library-proof ([#23](https://github.com/ilyamk/agentbros/pull/23))

- ElevenLabs music generation works end to end: every composition-plan section is sent with lines (the API refused plans without them), the request waits up to its own 10-minute limit instead of being cut by fetch's 300 s header wait, and the film chain's music step may run generate:music once the project budget ceiling was raised in the user's words ([#13](https://github.com/ilyamk/agentbros/pull/13))

- Any Node 26.x or 24.x now runs the CLIs, MCP and contribution tools (with a warning off the CI-tested 26.13.1/24.22.3 pins); `engines` is `^26.0.0 || ^24.0.0`. The pre-push hook switches to `.nvmrc` through nvm when the shell default is another major, and prints the leak check's reason when it blocks a push.

- CLIs no longer hang after printing their result: on Node 24 and 26 (V8 13.6 and 14.6) process.exit could deadlock when platform shutdown joined a background Sparkplug or Maglev compile waiting for a garbage collection only the exiting main thread could run. The CLI helper turns off concurrent Sparkplug and Maglev before other modules load and runs one collection right before exit, which releases a compile started earlier; TurboFan stays. ([#16](https://github.com/ilyamk/agentbros/pull/16))

- Public export keeps the .claude skill and agent symlinks, passes its leak scan and treats the non-redistributable Remotion skill as an optional install

- Public release readiness: pnpm studio runs Remotion Studio under the loopback preload (127.0.0.1 only); CI installs Remotion's Chromium before the fast and full test suites; the console's review security tests ship in the public export; Blender examples carry their GPL-3.0-or-later headers; the triage judge no longer receives GitHub credentials; the licence documents clarify redistribution, Remotion thresholds, Python dependencies, the Vork bridge's licence evidence and the CC BY phone-model renders

- Release notes no longer fail on two pending change entries filed under an unknown feature category; a test now renders every pending entry, so an unknown category fails CI before it reaches main ([#14](https://github.com/ilyamk/agentbros/pull/14))

- Scope MCP plan and request files through a scopeRoot flag (audio_mix track sources, backend export assets, viz), dispatch elevenlabs-sfx assets through budgeted SFX generation, require explicit --provider pollinations with bounded downloads, refuse non-public ref:add links, add render-determinism lint rules and a CLI JSON contract test, and rename the cache override to AGENTBROS_MODEL_CACHE (AI_VIDEO_CREATOR_MODEL_CACHE still read)

- Review all 205 dependency licence findings with integrity-pinned source-distribution decisions

  Verify all 205 exact npm archives against locked SRI and retain manifests,
  licence notices, upstream evidence, conditions and source-only decisions in a
  protected ledger. Preserve original missing/UNLICENSED declarations and require
  fresh review for changed artefacts or versions.

  CI enforces the explicit repository-source scope. Binary/native/WASM and browser
  bundle redistribution remains excluded, including Remotion FFmpeg and Mediabunny
  codec obligations; operator entitlements and GSAP permitted-use terms still apply.

- Stabilise contributor checks: trust-root discovery follows only code and JSON modules, so ignored `out/qa` reports no longer fail the workflow test; the FIFO refusal test allows a cold tsx start; `contrib/AGENTS.md` regains byte headroom

- WebVTT cue identifiers no longer contain the --> timing arrow

- WebVTT cue identifiers stay free of --> for overlapping arrows and ids that start with ->

### Guides and documentation

- Agent Bros. Pictures (agentbros) replaces the old product name everywhere it is still used, including the CLA, NOTICE and commercial licence; the licensing contact moves to the hello address; the CLA lets the Licensor transfer it to a successor or a company the Licensor controls

- Add docs/architecture.md: layers, directory map, request flow, single sources of truth, invariants and extension paths for agents changing the harness; dated, linked from the root, kept current with every structural change and guarded by tests/agents-md.test.ts; a whiteboard cover of the two brothers drawing the system as a graph (prompt in docs/readme/PROMPTS.md, section H)

- Agent Bros. Pictures is source-available under the Business Source License 1.1 (BUSL-1.1) instead of AGPL-3.0-or-later with a commercial licence. The Additional Use Grant allows free production use by individuals (including films and media for their clients), organisations with no more than three Personnel together with their Affiliates, and non-profits and accredited educational or research institutions for non-commercial activities, provided the software is not offered to third parties as a hosted, managed or embedded service, API or platform, or distributed, sold or bundled in a product or service; delivering films made with it is not distribution. Everyone may use it for evaluation, testing, development and study. Other production use needs a commercial licence (COMMERCIAL-LICENSE.md). Each version converts to AGPL-3.0-or-later on the fourth anniversary of its first public release under the BSL. Python that runs inside Blender is GPL-3.0-or-later (LICENSE-GPL-3.0) and carries an SPDX header. The CLA moves to version 2.0, effective 17 November 2026, and TRADEMARKS.md sets the policy for the Agent Bros. Pictures and agentbros names and logos.

- docs/github.md records the settings applied to the public repository on 2026-11-18: no merge queue for a personal account, data-branch rules that keep GITHUB_TOKEN writes working, the allowed-actions list, the completed App split, and why GITHUB_TOKEN may not open pull requests ([#6](https://github.com/ilyamk/agentbros/pull/6))

- Translate the 19 reference breakdowns, the agent video systems survey and the chart evidence guide into English; the film's own copy stays described, not quoted

- Mark LLM triage as inactive and describe likely-slop accurately, and fix benchmark, pnpm check and macOS CI documentation drift

- The CLA and commercial licence are final, with one CLA for individuals and organisations (signed by an authorised person) and third-party work excluded from the commercial licence where its licence requires; NOTICE adds the GPL Vork Blender integration and bridge, the seven ElevenLabs skills and exact Remotion terms; the README adds a trademark and non-affiliation notice; GSAP is recorded as cleared; two images showing third-party branding are removed and legacy test fixtures use fictional products

### Showcase entries

- The Pages site is redesigned as the studio's art-deco lot: a landing page, genre pages, the motion library with rendered strips, the crew and a filterable needs board with pre-filled opportunity issues, all without external requests

### Security fixes

- github.com joins the instruction URL allowlist, so protected scripts and workers may name GitHub release downloads (the portable sherpa-onnx voice and speech models) without failing the instruction security scan

- CLA.md now documents the short-form signing statement the bot accepts, and coding-agent co-author trailers (Claude Code, Codex, Copilot, Cursor) listed in contrib/agent-coauthors.json count as the submitting human's Contribution.

- CodeQL's init, analyze and upload-sarif actions move to v4.39.3 together (pinned to commit 33d7b85), and Dependabot now groups them, since a split bump leaves CodeQL on mismatched majors. ([#19](https://github.com/ilyamk/agentbros/pull/19))

- Launch-ready contribution automation: a tier-3 override for the maintainer (no protected-path block, never autoclosed, can `/unclaim`), a Dependabot intake route, CLA signatures by the `CLA.md` statement bound to the current `CLA.md` blob with refusals answered on the PR, releases triggered by the push to `main`, separate reviewer-gated `release` and unattended `automation` environments, a seven-day reminder before closing unapproved protected-path changes, early comment filters and per-source concurrency keys, job timeouts, read-only job tokens for App-token pushes, rebase-and-retry for bot pushes to `main` and a nightly whole-tree leak scan.

- The motion library reel's new scene modules (CaptureProof, TransitionCut, TurnedRing, transition-cut-plan) are protected paths with a code owner before they land, since privileged automation imports them through the library

- Unattended bot workflows mint their token from a separate automation App (falling back to the release App until it is configured) and commit as the minting App, so the release key can live only in the reviewer-gated `release` environment; contributors set up with `pnpm bootstrap --apply`, which installs the Chromium the vision tests need

### Contributors

- Motion library: [@ilyamk](https://github.com/ilyamk)
- Task playbooks: [@ilyamk](https://github.com/ilyamk)
- Providers and pricing: [@ilyamk](https://github.com/ilyamk)
- CLI commands: [@ilyamk](https://github.com/ilyamk)
- Audio analysis and mixing: [@ilyamk](https://github.com/ilyamk)
- Agent instructions: [@ilyamk](https://github.com/ilyamk)
- Harness and MCP integration: [@ilyamk](https://github.com/ilyamk)
- Tests and continuous integration: [@ilyamk](https://github.com/ilyamk)
- Bug fixes: [@ilyamk](https://github.com/ilyamk)
- Guides and documentation: [@ilyamk](https://github.com/ilyamk)
- Showcase entries: [@ilyamk](https://github.com/ilyamk)
- Security fixes: [@ilyamk](https://github.com/ilyamk)
