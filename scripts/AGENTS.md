# Scripts — Agent Rules

Last updated: 2026-11-20

Motion renders resolve the composition’s shared assets using its input props.

Production CLIs: [JSON contract](../AGENTS.md). Search: `pnpm commands --query <word>`; flags: `pnpm <alias> --help`.

First-run setup (2026-11-16): `setup.sh` / `setup.ps1` install prerequisites by scope (user-scope with `--apply`, system with `--system`) and hand over to `bootstrap` (plan by default; `--apply` runs repo steps only; writes `out/setup/REPORT.md`). `keys` reports set/unset by goal, never values ([SETUP.md](../SETUP.md)).

Harnesses (2026-11-18): the `present` hook hands project command results to the desktop browser through the main agent; `harness:setup` plans, then `--apply` links, converted agents and project MCP configs for the detected coding agents (git-ignored, absolute paths); `--global` adds user-scope configs with a backup; `bootstrap` runs it as its `harness` step; `--hooks` plans the console's harness hooks, `--hooks --apply` installs and `--hooks --remove` removes only ours, after the user's yes (RFC 0004 §7.1, 2026-11-17) ([harnesses](../docs/harnesses.md#hooks)).

Remotion Studio (2026-11-18): `pnpm studio` (`scripts/studio/studio.cjs`) runs Studio for development under the same loopback preload, never bare `remotion studio`, which listens on every interface. `studio:open --project <id> [--format F] [--status|--stop]` opens a film's build.json composition (with its `props`) or a project's format composition with the render's props (re-run: live update), one Studio per project and target, detached under `scripts/studio/loopback.cjs` (127.0.0.1 only); the console runs it for the user ([guide](../docs/console.md#remotion-studio)).

Console control (2026-11-17): `console:control` pauses, resumes or stops a project on the user's words (other commands then fail with `PAUSED`; `--operation-id` may finish a submitted job); `job:cancel` cancels one paid job where the provider can (RFC 0004 D12).

Run simulation (2026-11-16): `context:budget --simulate [--playbook <id>] [--rounds expected|worst]` estimates one orchestrator conversation and every dispatch offline ([budgets](../docs/context-budget.md#whole-run-simulation)); not with `--base`.
Template pipeline removed (2026-11-17): `next` sends every project.json project to the timeline route (render, `qa:editorial`, `delivery`) and ignores a leftover pipeline-state.json; `pipeline:init` and `pipeline:stage` are gone, `pipeline:check` is a stateless findings probe; `edit:captions`, `measure:durations` and `slice:talking-head` stay in the legacy section.

Higgsfield scenarios (2026-11-16): `hf:pricing --sync --scenarios` adds exact sample estimates, dated resume checkpoints and optional `--check-usage` analytics ([prices](../docs/higgsfield.md#prices-and-spend)).

## Adding or changing a script

- Build on `runScript`, `parseArgs` and the helpers in `src/lib/cli/`: one JSON line on stdout, progress on stderr, a non-zero exit on failure, and typed `ERROR_CODES`.
- Add the alias to `package.json` and its entry to the command registry, `src/lib/cli/commands.ts`: section, spend (`none`, `may-spend`, `paid`), MCP tool name or the reason it is excluded, a one-line purpose that says what the command produces, and `keywords` for the words a user would search with that the purpose lacks. Then `pnpm commands --write-doc` regenerates [the catalogue](../docs/commands.md). `tests/commands-registry.test.ts` checks that they all agree.
- Detail (flags, defaults, formats) belongs in `--help`, not here.
- `deps:licences --write` collects package notices and renders the exact-version review; CI uses `--check --strict --scope repository-source`. Default `package-policy` remains separate; binary/bundle distributions need a fresh review. It runs last in `regen` ([guide](../docs/dependency-licences.md)).
- MCP exposure is explicit: a tool in `src/mcp/catalog.ts` named by its registry entry ([src/mcp/AGENTS.md](../src/mcp/AGENTS.md)).
- Paid operations plan offline by default, resolve V2/legacy identity before estimates or uploads, reserve budget before submit and resume by operation ID; never repeat a submit blindly.
- Spawn children with literal argument arrays.
- Keep `.agents/` flag examples aligned with `--help` (checked by `tests/portable-craft-skills.test.ts`).

## Rules by area

- Project experiments (2026-11-20): `experiment` selects project-local methods and prepares a blind review pair from full render receipts. [Guide](../docs/experiments.md).

- **Approvals are the user's.** `film:approve` and `film:rights` record only the user's own words; `--proxy benchmark` never counts as the user's, is refused on `human` and never authorises spending on `material`. `recut:plan` and `shorts:rank` write unapproved drafts with the hash a person approves; `shorts:request --approved-by` takes only the user's decision, verbatim; `footage:next` writes no approval; `footage:policy-apply` writes only what the user's autonomous policy pre-answered, logged and revocable (2026-11-17). None of these approvals is an MCP tool.
- **Film chain:** `film:next` says what to do now, `film:brief` writes the subagent's prompt and returns its path and dispatch line, `film:show` digests a step's artefacts ([production chain](../docs/production-chain.md)). A route change: `film:route --write-doc`.
- **A user's own recording:** start with `footage:next` ([footage editing](../docs/footage-editing.md)). Transcribe only with `transcribe` (paid; `--from-raw` rebuilds a transcript with no API call; keyterms and extra channels add billable minutes) or `speech:local` (free, [speech](../docs/speech.md)). `align:captions` and `edit:captions` are template-mode voiceover only.
- **Footage discovery:** pass the complete next-step answer to optional local hints, retaining resolved source identity and effective `--no-save` goals.
- **Render and delivery:** `render` retries a stalled render once, verifies eligible picture patches and archives previous masters. `--full` forces a fresh render. Excerpts remain partial. Production-ready requires `delivery --action check` after `--action snapshot` ([delivery](../docs/delivery.md)).
- **Local narration:** `voiceover:local --engine portable --prepare` prepares weights explicitly. Synthesis runs offline, caches takes and emits estimated timing only after matching readback ([speech](../docs/speech.md#portable-narration)).
- **Sound:** no SFX audio in git, only manifests, the index and CLAP vectors; `sfx:find` and `sfx:cues` fetch missing kinds, `assets:sync` shared media ([assets](../docs/assets.md)). ElevenLabs SFX stay `needs-generation` (paid, with consent). In `music` the user decides the route; acquiring stays on the CLI.
- **Motion library:** run `library:catalogue` after changing a block.
- **Discovery (2026-11-15):** `fal:find` returns match provenance; no signal returns an empty successful answer with suggestions and an optional memory gap command.
- **Generation:** new production uses `generate:model`; `generate:image` and `generate:video` are legacy routes. `generate:music --provider fal` is a durable job: `--dry-run` quotes, the same arguments resume it. Spend: `budget`, `cost:report`; `budget --ceiling-usd` raising the ceiling (or a first one above zero) needs `--answer "<the user's words>"`, never the agent's (2026-11-16). A published `generate:model` video gets `metadata.motion` (local, free); with `context.expect: { motion: "animated"|"still" }` also `metadata.acceptance` and, on a miss, `nextAction: "review-motion"` while `ok` stays true; `film:measure --expect-motion` judges a render the same way (2026-11-17). A `context.referencePack` request must be an approved pack's `<pack>/request.json`; reference inputs on a profiled endpoint without one warn, or refuse with `AGENTBROS_REFERENCE_PACKS=enforce` (`off` silences; RFC 0003 D8, 2026-11-17).
- **Trusted CLI only:** `speech:local`, `media:prepare` and other local-engine commands, `blender:run` (any Python) and `hyperframes:render` are not MCP tools; `blender:live` (typed ops) is.
- **Legacy and helpers:** unaliased legacy generators (`generate-ai-image.ts` for the explicit Pollinations prototype, `generate-lipsync.ts` for verified `--endpoint` lipsync) serve old projects only; the meme script was removed on 2026-11-16 (`generate:meme` runs `generate-image.ts --model gpt-image-2`). `scripts/workers/` (native helpers) and `scripts/blender/` (Blender kit) are not public CLIs.

Python quality: `pnpm python:check` / `pnpm python:audit`. Worker dependencies and launches: [central uv runtime](../docs/python-runtime.md); pin 3.13.18 (offset alone: 3.12.16), no caller-local package lists. Public export refuses leaks before copying, publishes scanned bytes with their permissions and rejects symlink ancestors in source and output boundaries (2026-11-18).

## Catalogue

`film:init` and `project:new` take an optional `--title` for the name shown in Studio Console. Keep it short and specific to the video.

`repo:hygiene --check` rejects machine paths, maintenance outputs, a `.claude/` link that is not a link to `.agents/` and tracked harness-generated files in the source tree (also in CI). `--clean [--yes]` reuses guarded QA cleanup. `docs:audit --write` adds Markdown roles/references; both save reports only under ignored `out/qa/` ([cleanup](../docs/cleanup.md)).

Read the generated [command catalogue](../docs/commands.md), or query it with `pnpm commands --query <word>`.

`viz:*` commands operate on declarative visualisation requests and pinned local revisions; see [visualisations](../docs/visualisations.md).
Local macOS tasks (2026-11-15): `local:capabilities`, `local:policy`, `local:verify`; task CLIs share `local-task.ts`. `commands --all` and `--write-doc` remain host-independent. `media:prepare` also prepares visual/category and individual apple-* domains; local execution remains CLI-only ([guide](../docs/local-macos.md)).

Vork (2026-11-15): `vork:*` commands are trusted local CLI only; scene shaders and Python are executable code. Installation is explicit, rendering retains completion metadata and receipts. [Guide](../docs/vork.md).

`resources` accepts typed Openverse source/licence/category/size/length filters; `--modified` also filters discovery. Stock (`--provider auto|unsplash|pexels|pixabay`, 2026-11-17) adds shared filters, ranking for `--format`/`--zoom`, `--index`, `--credit` and `--action credits`. Credentials stay in environment and preview acquisition remains explicit.

Audio integrations: `elevenlabs:capabilities`, `voices`, `voices:manage`, `generate:dialogue`, `audio:transform`, `dubbing`, `dubbing:conform`, `sfx:find-segment`, `audio:review`; [contracts and execution defaults](../docs/audio-integrations.md). Typed paid commands default to plans; the existing scene voiceover workflow retains its defaults. Earshot installation is explicit through media:prepare.

Speech (2026-11-18): `speech:replace` plans from an exact journal revision, prepares an immutable take and applies the reviewed replacement and captions together. Its apply path and `voices:manage --action approve` are CLI-only.

Task slots (2026-11-16): `models:pick`, `models:slots`, `models:slot`, `models:verdict` and `models:stats` provide offline selection, curation and outcomes; the [catalogue](../docs/commands.md) lists them as one family; purposes: `pnpm commands --query slots` ([guide](../docs/model-slots-guide.md)).

Use cases (2026-11-15): `models:pick --use-case ID` selects a production task; `--task` matches its ru/en phrasings before concepts.

Slot price flags (2026-11-15): `models:pick --chars --audio-seconds --images --megapixels` override slot references; unknown-price results include scaffold/dry-run commands.

Capabilities (2026-11-17): `models:capabilities` lists the vocabulary (`--list`), profiles an endpoint (`--endpoint`) or searches; `fal:find` and `models:pick` share `--capability` (all), `--any-capability`, `--field REGEX`, `--input-audio-sec`, `--input-video-sec`; a miss rejects with `missing capability: <id>` ([guide](../docs/fal-catalogue.md#capabilities)).

Matrix refresh (2026-11-15): `fal:pricing --historical [--slots|--all] [--endpoints a,b] --resume` reads free per-call estimates with dated checkpoints; `models:refresh` runs it after list pricing. `models:slots --write-doc`/`--check-doc` write/check both the comparison JSON and table.

Genjutsu preparation (2026-11-15): `model:prepare` prepares immutable source segments and ordered references, checks/records input review and exact-result QA; approvals are CLI-only. `film:rights --preparation ID` records exact source-use permissions for any project while its no-preparation replica contract is unchanged. `motion:library` keeps dated local candidates; `hf:media` resolves public links, imports checked originals and binds exact schema URL fields without reuploading. [Recipe](../docs/higgsfield-prompting.md#prepared-genjutsu-workflow).

Entity coverage (2026-11-17): `entity:card --action coverage --kind K --id ID [--revision N]` reports advisory view coverage (RFC 0003 §6.1, policy `src/lib/references/coverage.json`); no spend; MCP `entity_card`. [Guide](../docs/entity-workflow.md#coverage-and-view-roles).

Vision review (2026-11-15): `vision:pack` creates immutable paginated evidence; `vision:inspect` verifies and reads bounded metadata. `vision:evaluate` is trusted local harness execution, CLI-only. Existing vision producers retain legacy outputs and add source-bound review packages.

Runtime (2026-11-16): `runtime:check` verifies the exact primary/reserve Node and child processes; `runScript` also accepts a later minor or patch of either major with a stderr warning and rejects the rest ([policy](../docs/node-runtime.md)). `AGENTBROS_NO_DOTENV=1` stops it loading `.env`.

Workflow evaluation (2026-11-16): `bench:workflow` lists/runs pinned outcome contracts and checks private evidence. Suite v4 enforces no-spend; quality scoring launches no models. `film:brief --local-evidence` consumes source-bound advisory data. [Guide](../docs/agent-workflow-e2e.md).

Campaign production (2026-11-16): `campaign:production`, `campaign:next` and `campaign:brief` plan/advance local work, check scenario contracts and apply scoped repairs; next distinguishes waiting from completion. `campaign:approve` is user-only; `campaign:execute` requires explicit paid authority, fitting dry-run bounds and existing admission. [Guide](../docs/campaign-production.md).

Hardening (2026-11-16): legacy `generate-ai-image.ts` defaults to fal and uses Pollinations only with explicit `--provider pollinations` (unclear licence, 60 s timeout, 32 MiB cap); `--output` must stay inside the working directory. `mix-audio` and `backend` accept the MCP `--scope-root`; `review:ui` validates the project ID first; `ref:add --url` refuses non-public destinations by DNS.

Lint (2026-11-16): `lint --project <id>` now fails on render-rule findings in `src/projects/<id>` (slop stays advisory); `repo:hygiene --check` fails on media binaries outside docs/assets.md row (c).
Step lease (2026-11-17): `next` (film, footage), `film:next`, `film:brief` and `footage:next` write `pipeline/session/lease.json`; `film:done` removes its step's; every `runScript` CLI checks it (warn when interactive; enforce, refusing with VALIDATION, under an autonomous policy or in a benchmark run; `AGENTBROS_STEP_GUARD` overrides). `step:unlock --reason [--minutes]` is the recorded escape hatch, CLI only; `step:violations [--project] [--since]` sums the out-of-step runs with `clean`; `film:status` reports uncovered ones. Hooks: `scripts/hooks/agentbros-hook.mjs <claude|codex> <role>` (plain Node; its `guard` role mirrors runScript's lease and pause verdicts and journals a refusal as runScript does, `cli.start` plus `cli.end` `PAUSED`/`VALIDATION`, so console notifications see it, 2026-11-17; `lib/commands.json` is generated from the registry, refreshed by `AGENTBROS_WRITE_HOOK_TABLE=1` on `tests/console-hooks-guard.test.ts`); `claude-step-guard.mjs` is a shim for one release ([step lease](../docs/step-lease.md#harness-hooks)).
Reference derivatives (2026-11-17): `refs:derive --action plan|run|show` makes immutable derivatives in `pipeline/reference-derivatives/<id>/`, imported with origin `derivative` (`src/lib/references/derive/`): ffmpeg ops, matte cut-out, a leading `blender-pass` (`blender/kit/passes.py`: 16-bit `sequence/`, preview, camera JSON) or a leading paid fal step (durable job; `--confirm-spend` only after the user's yes, `--max-cost-usd` for unknown prices; `<derivative>/pending.json` until published); `run` is CLI-only ([RFC 0003](../docs/rfcs/0003-reference-packs.md)).
Reference packs (2026-11-17): `refs:pack --action prepare|check|board|list|rights|approve|request|result-board|review-result` writes immutable packs in `pipeline/reference-packs/<id>/` (`src/lib/references/packs/`); `rights`, `approve` and `review-result` record the user's or reviewer's words and are CLI-only; `model:prepare --action as-pack --id PREP` writes a prepared Genjutsu input as pack `genjutsu-PREP` for review ([RFC 0003](../docs/rfcs/0003-reference-packs.md)).
Reference requirements (2026-11-17): `refs:plan --action draft|check|status|board` writes and checks `pipeline/references.json` (board `--save` CLI-only) (`src/lib/references/plan.ts`); no spend; MCP `avc_refs_plan` ([RFC 0003](../docs/rfcs/0003-reference-packs.md)).
Reference profiles (2026-11-17): `refs:profiles --action list|show|for|check` (offline, MCP `avc_refs_profiles`); `check` fails with `VALIDATION` and `details.findings` ([RFC 0003](../docs/rfcs/0003-reference-packs.md)).
Studio console (2026-11-17, RFC 0004 WP0): the console commands are implemented ([guide](../docs/console.md)); `console:test` (Vitest) runs in `check`, `console:e2e` (Playwright, axe) only with `RUN_CONSOLE_E2E=1`. `console`, `console:wait`, `console:control` are always admitted by the step lease, `console:card` is a control alias ([RFC 0004](../docs/rfcs/0004-studio-console.md)). WP4 (2026-11-17): a build that is not exactly `index.html`, `app.js`, `style.css`, or has inline script/style or a `data:` URL, is refused (`VALIDATION`, `details.findings`). WP2 (2026-11-17): `console` starts or reuses the detached server (lock `out/console/server.json`, log `out/console/server.log`) and prints the token URL, `--stop` stops it; `console:build` builds the bundle. WP7 (2026-11-17): `next`, `film:next`, `footage:next`, `film:init` add `console` (base URL or `error`, `pending`, `appliedSince` by `out/console/next-cursor/`, `truncated`, `lastEventId`) and `hooks`, never stopping a live server (busy or other version: `error`; one 4 s deadline); `console:wait` tails the journal from `--since`, else the newest next-step answer (timeout `ok`). WP9 (2026-11-17): `ref:rate` appends to `pipeline/ratings.json` under a lock (a `--note` also becomes a memory preference); `feedback --frame N [--region x,y,w,h] --answer` pins the words to a render frame for the build and the fixer. WP15 (2026-11-17): `console:snapshot --project` writes the read-only `out/<id>/console-snapshot.html` (bundle inlined, view scrubbed, no token, media by relative path, 8 MiB cap → `VALIDATION`), never publishes; `harness:setup --statusline [--apply|--remove]` manages the optional Claude Code status line (`scripts/hooks/console-statusline.mjs`).
Journal (2026-11-17, RFC 0004 WP1): every `runScript` CLI appends `cli.start`/`cli.end` (and throttled `cli.progress`) to an existing project `pipeline/` (`pipeline/events.jsonl`, never creating folders) (`src/lib/console/journal.ts`; off with `AGENTBROS_EVENTS=off`); a CLI that exits without `emitResult` leaves an unpaired `cli.start`. `film:brief` also writes `agent.dispatch`; `step:violations` without `--project` lists only projects with a lease or a violation log.
Cards (2026-11-17, RFC 0004 WP11): `console:card --project --kind --data [--expires-in]` validates a card (media inside the project or `out/<id>/`, no HTML), writes `pipeline/cards/<id>.json` and journals `card.posted`; the console server records the answer there (`src/lib/console/cards.ts`).
Decisions (2026-11-17, RFC 0004 WP5): `film:approve --answer --expect`, `feedback --step S --answer` (revise owner), `channel: "console"` on records when the console spawns.
Review UI (2026-11-17, RFC 0004 WP13f): `review:ui` is the console alias: it starts or reuses the console and prints its Timeline URL (campaign view for a campaign container), then returns; token URL only to a TTY or with `--print-token` (else a one-use `#pair=` link; `pnpm console` alike); `--open`. No legacy mode.
