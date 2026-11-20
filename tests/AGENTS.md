# Tests — Agent Rules

Last updated: 2026-11-20

`node:test`/`tsx`; synthetic fixtures, no paid APIs. Check both experiment arms.

2026-11-18: fixtures cover authority, campaign bounds, export scope, v4 speech and reversible phrase edits.

```bash
pnpm test                 # default suite; heavy suites skip themselves
pnpm check                # repo:hygiene --check, python:check, format:check, lint, typecheck, test
pnpm test:fast            # quick unit subset (~2.5 min); CI runs it
pnpm test:browser         # browser, review UI, QA evidence, long-form render
pnpm test:render          # synthetic local render
pnpm test:integrations    # HTTP stream, realtime, Resolve, HTML capture
pnpm test:workflows       # workflow renders
```

Aliases: `package.json`; prerequisites: [install](../docs/install.md#1-prerequisites), including Chromium (`pnpm exec remotion browser ensure`).

## Rules

- Never read or write this checkout's `public/projects/`, because projects there are git-ignored and removable. Use `tests/fixtures/legacy/` or a temporary workspace.
- Use the minimal child environment and `memory-root.ts` (`AGENTBROS_NO_DOTENV=1`). Child deadlines use `helpers/timeouts.ts` (30 s, `AGENTBROS_TEST_SPAWN_TIMEOUT_MS`). Use the `tsx` CLI with static imports for inline TypeScript probes.
- Gate slow or machine-specific suites with `RUN_*` and report skips. `RUN_HARNESS_LIVE_TESTS=1` checks installed harnesses via `mcp list`. Only `RUN_STOCK_LIVE_TESTS=1` reads `.env` keys and calls providers. Stock fixtures live in `helpers/stock-fixtures.ts`.
- Avoid tight CLI deadlines and checkout-specific paths.

## Layout

- `*.test.ts`: suites; `*.fixture.ts` and `*-fixtures.ts`: shared scenario data.
- `fixtures/`: legacy project configs, provider contracts, fake workers and engines.
- `helpers/`: portable fixtures/utilities. Private launchers, inode snapshots and replay pins are ignored output.
- `agents-md.test.ts` checks instruction indexes and budgets. `agents-readme.test.ts` checks agent front matter against the index. The portable craft suites verify links, aliases and CLI flags. The reference preparation suite checks model sources, tiers and dates. `docs-commands.test.ts` checks Markdown command aliases outside verification, archive and RFC records.
- Tests isolate `AGENTBROS_MEMORY_ROOT` and fail on checkout memory writes. Single file: `pnpm exec tsx --import ./tests/helpers/memory-root.ts --test <file>`.
- Console projector and media tests check that links follow the server's allowlist and approvals still bind the structured JSON (2026-11-18).
- `console-project-settings.test.ts` checks title persistence, confirmed removal and footprint guards through the live HTTP server and real cleanup CLI (2026-11-18).
- `console-credentials.test.ts` covers key access and overrides (2026-11-18).
- `console-documents.test.ts` checks session and origin controls, conflicting saves, validation and the renewed strategy review (2026-11-18).
- `console-hooks-present.test.ts` checks project browser handoff, repeat suppression and resume in both harnesses (2026-11-18).
- `console-{restricted-process,reconnect}.test.ts` cover restricted process checks and same-tab stream recovery (2026-11-18).
- `blender-ext.test.ts` checks ZIPs, schemas, downloads and isolation. `RUN_BLENDER_TESTS=1` adds install and pixel/timing trials. `blender-ext-adoption.test.ts` needs `RUN_BLENDER_EXTENSION_TRIALS=1` and consented local archives. Evidence logs Blender versions and operator failures.
- `scripts/test-fast.ts` lists SLOW files by measured time; deadline-sensitive `bench.test.ts` stays there because its child-process timeout fixtures are unreliable under full parallel load. Split a file rather than keep a fast check out of CI.
- Contribution suites cover PRs, categories, changes, intake/claims/checks, evidence, regeneration, trust, failing-on-base proof and novelty (`contrib-*.test.ts`); `automation-fetch.test.ts` covers offline showcase/benchmark downloads. `contrib-docs.test.ts` guards budgets, gates, commands, links, PR templates and issue forms.
- `context-budget.test.ts`, `context-budget-simulate.test.ts` (whole-run ceilings, 2026-11-16), `context-probe.test.ts`, `instructions-lint.test.ts` and `instructions-security.test.ts` guard offline context measurement, harness probes and instruction checks; `metrics.test.ts` and `api-surface.test.ts` guard inventories and API snapshots.
- `docs-audit.test.ts`: Markdown roles, references, folder totals and safe report-only CLI.
- `repository-hygiene.test.ts`: cross-format path/output rejection, ignored data and safe QA cleanup.
- `cache-dir.test.ts`: cache migration and `AGENTBROS_MODEL_CACHE`; `mcp.test.ts`: server identity. `triage.test.ts`, `triage-local.test.ts` (fake harnesses), `instructions-audit.test.ts`, `release.test.ts` and `credits.test.ts`: judging, audits, releases and attribution; `showcase.test.ts`, `showcase-site.test.ts` and `bench.test.ts`: gallery and benchmark contracts.
- `reference-e2e.test.ts` (slow): the RFC 0003 dry run through the CLIs, plus the reference instruction tasks built by `fixtures/bench/reference-project.ts`; `reference-examples.test.ts` validates `examples/references/`.
- `dependency-licences.test.ts` covers inventory collection; `licence-review.test.ts` checks exact-version invalidation, archived metadata, platform portability and source-only scope. `leak-check.test.ts` keeps notice exceptions narrow; `deps-check.test.ts` covers SPDX policy and new-package admission.

- [GitHub CI](../docs/github.md) runs lint, types, console tests, fast tests, four full-suite shards, browser/render and Python checks on Linux. Swift, Apple-native and MLX checks are local and gated.
- Native profile-routing CPU cases always run; integrations opt in through `RUN_NATIVE_PROFILE_TESTS=1` and three `AGENTBROS_NATIVE_*_RUNTIME` inputs ([cleanup](../docs/cleanup.md)).

Python: `pnpm python:check`; launcher contracts: `python-runtime.test.ts`; public model acceptance: `pnpm python:check --mode models`. Native contracts: `pnpm python:check --mode native` (Blender required). CPU pixels must match exactly; Metal has a measured rounding tolerance.

Task discovery (2026-11-15), offline: `fal-task-coverage` gates categories/roles; `fal-task-golden` ru/en rankings; `fal-task-regressions` medium/specialism and duration warnings; `fal-find-match` no-match and CLI. Slots: `model-slots*`, `model-use-cases`, `price-matrix*` (`memory-root.ts` isolates their data).

## AGENTS.md size budgets

Run agents from the root: Codex loads ancestor `AGENTS.md` files up to 32 KiB ([guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md), checked 2026-11-13), so only the root file auto-loads; Claude Code imports it through `CLAUDE.md`.

KiB (1024 bytes), checked by `agents-md.test.ts`:

| File | Budget |
|---|---|
| Root `AGENTS.md` | 15 KiB (15,360 bytes); keep it near 14.5 KiB so a contribution has room. Codex auto-loads up to 32 KiB |
| Area: `scripts/`, `src/lib/`, `src/motion/`, `src/templates/` | 24 KiB |
| Any other `AGENTS.md`: sub-areas and playbooks (`playbooks.test.ts`) | 12 KiB |

Over budget: trim or move detail into a guide; do not raise a cap for one file. `SHRINKING` (files held at their size while they shrink) is empty. The test also caps descriptions of first-party skills and agents at 600 UTF-8 bytes; vendored skills listed in `.agents/skills/THIRD_PARTY.md` are exempt.

`blender-assets.test.ts` tests local arsenal schemas, fake downloads/adapters, extraction, roles, catalogue stability, consent and credits; times 200 synthetic assets. Its Blender render/Essentials test needs `RUN_BLENDER_TESTS=1`. Pure helpers: `python3 tests/blender-assets-helpers.test.py`.

Blender library tests also cover ambientCG v3, redirect hosts, secret-free pins, CDN metadata hashes/compatibility/licensed views, manual import, per-file hash reacquisition and CC0/SPDX filters.
- `media-fetch.test.ts`: acquisition routing, provider contracts, quotas, SSRF bounds and segmented manifests, offline.

`blender-live-arsenal.test.ts`: strict live/MCP contracts, extension approval/isolation and pinned replay. `RUN_BLENDER_TESTS=1` generates tiny maps and a harmless extension in a temporary workspace, measures ops, checks bake reuse and compares live/fresh-session/exported-script pixels. No downloads.
`blender-arsenal.test.ts`: offline repository/fixture audit, status, candidates, malformed META and tracked local payloads. `blender-arsenal-eval.test.ts`: historical scoring and fake Codex/Claude samples; `blender-arsenal-executable.test.ts`: checkout contracts, wrong flags/ids/params, inert Python analysis and immutable offline rescores; no live agent/network. Real planning evaluation is an explicit `blender:arsenal --action eval` operation.

Icon verification (2026-11-15): icon-resources.test.ts uses fake raster/HTTP fixtures; icon-resources-browser.test.ts exercises actual artwork and strict delivery. [Guide](../docs/icon-resources.md).

Visualisation test suites and opt-ins: [guide](../docs/visualisations.md).

`local-capabilities.test.ts` covers platform/language/operation/policy/qualification/provenance and immutable I/O; `apple-actual.test.ts` is gated by `RUN_APPLE_TESTS=1` and runs isolated native tasks with installed resources only (`pnpm test:apple`). Swift domain workers typecheck with `apple/Support.swift`.

`blender-nature.test.ts`: generator pin strictness, capability discovery and optional extensions; `RUN_BLENDER_TESTS=1` renders all four nature wrappers and a Sapling tree serially, checks exact CPU frame-alone pixels, motion and cache reuse.
`blender-city.test.ts`/`.py`: native layout clearance, OSM units/concave outlines, cross-runtime coordinate keys, incomplete-source recovery, licence/credits, generator capability verdicts and pure window frame functions. `RUN_BLENDER_TESTS=1` adds three wrapper applications, .blend reuse and exact CPU alone/range pixels with synthetic OSM; no network.
`blender-fx.test.ts`: capability/generator contracts, attributed PDB acquisition/cache/symlink refusal and pure freeze/cache maths. `RUN_BLENDER_TESTS=1` adds serial native liquid, smoke/grid, Tissue and Molecular Nodes frame-order/cache proofs. Retain results with `BLENDER_FX_TEST_OUTPUT`.

Vork units/seeds: `RUN_VORK_TESTS` GPU, `RUN_VORK_VFX_TESTS` solve, `RUN_VORK_HYBRID_TESTS` Cycles.

`vision-review.test.ts`: extraction, CFR, pages, tampering, scope and evidence honesty. `vision:evaluate` runs local harness acceptance outside ordinary tests.

`runtime.test.ts`: Node pins, CI matrices and child propagation; each runtime has CI checks.

[Audio suites and opt-ins](../docs/audio-integrations.md).

`genjutsu-*`/`hf-remote-*` test preparation, URL schemas, source pins, resume, rights and QA.

Workflow: `agent-workflow*.test.ts` tests no-spend, evidence, quality and handoffs; `editorial-timeline-captions` tests owners ([guide](../docs/agent-workflow-e2e.md)).

Harness regressions (2026-11-16): CLI/MCP/state/footage tests cover paths and cleanup; bench/retry tests cover final events and timers; jobs-identity covers V2/legacy, locale migration and frozen bytes. Memory uses temporary checkouts.

2026-11-16: catalogue price tests are offline.

Campaigns: `campaign-reliability*` tests bounded recovery. Opt-ins: `RUN_CAMPAIGN_RENDER_TESTS`, `RUN_CAMPAIGN_FLOW_TESTS` ([guide](../docs/campaign-production.md)).

Legacy fixtures (2026-11-16): `tests/fixtures/legacy/` uses fictional products only (`plant-care`, `daily-practice` replace the old real-style ads); `legacy-projects.json` mirrors them.

CLI contract (2026-11-16): `cli-json-contract.test.ts` runs every registry script with `--help` from a temporary cwd without credentials, in parallel batches (about 30 s), expecting one JSON line and exit 0; exemptions carry a reason in the test. `mcp-scope-root.test.ts` keeps `scopeRoot` flags, script declarations and `SCOPE_ROOT_EXEMPT` exact.
- Console (2026-11-17, RFC 0004): `console-*.test.ts`; fixtures `fixtures/console/`, `fixtures/hooks/` (synthetic). `memory-root.ts` sets `AGENTBROS_CONSOLE`, `_EVENTS`, `_HOOKS` to `off`; a minimal child env must pass `AGENTBROS_EVENTS: "off"` or "wrote nothing" snapshots see `pipeline/events.jsonl`. UI units: `pnpm console:test`.
