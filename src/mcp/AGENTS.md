# MCP bridge — Agent Rules

Last updated: 2026-11-18

Server identity: `agentbros`, version `0.1.0`; existing tool names keep the `avc_` prefix.

A trusted local MCP server that runs whitelisted CLIs from `scripts/` with literal argv and returns their one-line JSON envelope. User guide, launch config and safety model: [docs/mcp.md](../../docs/mcp.md).

`project_create` and `film_init` accept a short display `title` alongside the stable project ID.

## Map

| File | Role |
|---|---|
| `catalog.ts` | `COMMANDS`: one `define()` per tool: name, description, strict zod schema, path fields, spend policy, readOnly |
| `bridge.ts` | `prepareCommand` (schema parse, project scope, path scoping, spend policy, argv) and `invokeCommand` (spawn, timeout, one-envelope check) |
| `server.ts` | Registers `avc_<name>` for every listed tool whose script exists, plus `avc_capabilities`, `avc_models`, `avc_help`, `avc_guide` and, when some are unlisted, `avc_call`; sends `SERVER_INSTRUCTIONS` |
| `toolsets.ts` | `--toolsets`: `all`, `core` (`CORE_TOOLS`) or registry sections; unlisted tools stay reachable through `avc_call` |
| `guides.ts` | Read-only `.agents/` skills and agent definitions for `avc_guide`, contained, text only |
| `stdio.ts` | Entry point: `--root` (default `AGENTBROS_ROOT`, else the checkout), `--project`, `--toolsets`, `--allow-paid`, `--timeout-ms`; stdout belongs to JSON-RPC |

## Adding a tool

1. The command needs a registry entry in `src/lib/cli/commands.ts`; set its `mcp` to the tool name (replacing `excluded`). `define()` takes the script from that entry and throws at load if none names the tool.
2. `define(name, description, fields, paths, spend, readOnly)` in `catalog.ts`:
   - `fields`: only the flags an agent may pass, typed (`project`, `file()`, `text()`, `number()`, `boolean()`, enums). The schema is strict; leave out flags that write repository files or record approvals.
   - `paths`: every field holding a filesystem path. Each is resolved against the root and refused if its canonical path escapes it. An array field is joined with commas, so a listed path cannot contain one.
   - `spend`: `local` (no provider spend; registry `paid: "none"`), `dry-run` (forced `dry-run=true` unless the launcher passed `--allow-paid`), or `blocked` (refused unless `--allow-paid`). Registry spend must agree: `local` with `none`, the others with `paid` or `may-spend`.
   - `readOnly: true` only when the script writes nothing.
3. A request, plan, manifest, patch, spec or command file whose nested paths the script checks needs the bridge's trusted `scope-root`: wrap the entry as `withScopeRoot(define(...))` and declare `scope-root` in the script. A tool that needs none (nested paths contained against cwd, or none) gets a reason in `SCOPE_ROOT_EXEMPT`; `tests/mcp-scope-root.test.ts` checks both directions.
4. Run `pnpm commands --write-doc` and add a case to `tests/mcp.test.ts` that scopes each path field.

`generate_model` scopes nested local references for both providers before reading bytes. `model_result` reads project analysis manifests locally without writes or downloads.

`refs_derive` takes only `plan` and `show` (RFC 0003 D12), in forced dry-run because the command may spend; `run` stays CLI-only (2026-11-17). `refs_pack` takes `prepare`, `check`, `board`, `request` and `result-board`; `rights`, `approve` and `review-result` stay CLI-only.

`sfx_generate` scopes video/output paths and uses dry-run spend mode. `fal_batch` uses dry-run spend mode and scopes nested batch output paths; `fal_quote` is local and read-only. `hf_quote` reads Higgsfield prices offline. Provider pricing estimates remain CLI only.

## What stays out, and why

Listening approval for a calibrated clone and apply for a speech replacement are CLI-only (2026-11-18). The existing typed synthesis and conversion tools retain their paid execution guards.

The registry records a reason for each command that is not a tool; `avc_capabilities` lists them under `cliOnly`. Never expose:

- the user's approvals: `film:approve` and `film:rights` (approval is the user's, CLI only); `shorts_request` takes no selections or approver, so it writes chapters only;
- trusted arbitrary code or local engines: `blender:run`, `hyperframes:render`, `speech:local`, `media:prepare` and the other local-engine commands. `blender_live` is a tool although it drives a local Blender, because it takes no code (typed ops including local arsenal append/recipe/extension enable, read-only inventory, kit scripts from `scripts/blender/` only, names instead of output paths, token on 127.0.0.1; [live session](../../.agents/skills/blender-3d/references/live-session.md)). Never add a code, expression or shell action to it, or a flag that names an executable;
- recording a user's choice or replacing one: `playbook --by user` and `--force` (MCP binds a playbook as the agent's choice, never over another binding); `playbook --id --full` (triggers and per-step tools; MCP returns the compact answer, 2026-11-16);
- authorising spend: `budget` has no `answer` field, so a raised or first non-zero ceiling is refused through MCP; only the user's words on the CLI (`pnpm budget --ceiling-usd N --answer "..."`) raise it, and lowering stays a tool action (2026-11-16);
- deleting files (`project:remove`, `workspace:clean`), servers (`studio`, `review:ui`) and test, lint and build tools.

## Rules

- Toolsets (2026-11-17): a tool's listing never changes its checks; `avc_call` runs the same `prepareCommand`. A tool every route needs joins `CORE_TOOLS` (keep `core` under 40 listed tools; `tests/mcp-toolsets.test.ts`). Harness configs come from `pnpm harness:setup` ([harnesses](../../docs/harnesses.md)).

- Keep every safety rule: path scoping, project scope (a scoped server requires and checks `project`; manifest-driven creation is refused), no-spend default, literal argv with `shell:false`, one validated envelope with a matching exit code.
- Reject dangling output symlinks before canonicalising paths. On POSIX, reap the owned process group when the CLI leader exits, including success, timeout and cancellation.
- A tool's cwd is the workspace root, not the checkout: a script that reads repository files relative to cwd (`library:list`) does not work as a tool.

Reference profiles (2026-11-17): read-only local `avc_refs_profiles` (list, show, for, check); no file override through MCP.

`avc_refs_plan` (2026-11-17): draft (`write` merges into `pipeline/references.json`), check, status, board (HTML in metadata; `--save` stays CLI-only); writes only `pipeline/references.json`.

Local cross-provider discovery: `avc_models_compare` compares local prices; read-only `avc_models_capabilities` lists, profiles and searches capabilities (2026-11-17); `avc_fal_find` and `avc_fal_scaffold` accept `provider`. Finder metadata includes match provenance, suggestions and optional memory gap commands; no signal returns no candidates (2026-11-15). `models:refresh` remains CLI-only network maintenance.

Local fal discovery: `avc_fal_find`, `avc_fal_scaffold`, read-only `avc_fal_doctor` and capped `avc_models` filters ([guide](../../docs/fal-catalogue.md)). Doctor uses the tracked catalogue and checks project JSON realpaths against the launcher boundary; path overrides stay CLI-only. Scaffold scopes `out`; overwriting stays CLI-only.

## Checks

`tests/mcp.test.ts` (real SDK client, path and spend cases; slow suite, run it by hand) and `tests/commands-registry.test.ts` (every command a tool or excluded, spend agreement).

- `media_fetch` scopes input/output paths and nested request options; dry-run spend mode preserves no-spend defaults.

`blender_live` validates arsenal `params` JSON against strict per-action schemas before spawning. `--extensions` takes approved installed ids or `approved`, never a profile path. The mixed tool remains `readOnly: false`; its `arsenal` action writes no scene, journal, usage or preferences. `export-recipe` writes a pinned helper-based shot; overwrite stays CLI-only.

Icon tools (2026-11-15): read-only discovery is separate from acquisition/export and profile mutation; all require a scoped project. [Guide](../../docs/icon-resources.md).

`viz_prepare` scopes nested input paths through the trusted launcher boundary; visualisation tools accept declarative requests only.
Native task commands remain CLI-only. `avc_capabilities` suppresses unavailable Apple-only CLI suggestions; it does not grant native execution or preparation authority. Use `local:capabilities --all` on the trusted CLI for full diagnostics.

Openverse and stock filters (orientation, colour, format/zoom, author, Unsplash collections/topic, Pixabay types, 2026-11-17) are typed optional fields of `resources`; OAuth credentials and stock keys remain server-side environment only. Original acquisition re-inspects legacy aggregator candidates.

Audio tools expose strict bounded schemas and scope nested request/binding/source paths. Typed paid tools default to dry-run; Earshot production tools never install dependencies. `dubbing_conform` is local and scoped. See [audio integrations](../../docs/audio-integrations.md).

Task slots (2026-11-15): `avc_models_pick` and `avc_models_slots` expose offline read-only selection and list/show; maintenance, verdicts and doc writes stay CLI-only.

Use cases (2026-11-15): `avc_models_pick` also accepts `use-case`; constraints and pins retain the same offline planning checks.

Slot price settings (2026-11-15): `avc_models_pick` accepts `chars`, `audio-seconds`, `images` and `megapixels`; these remain offline planning quantities.

Prepared remix (2026-11-15): `fal_find` and `fal_scaffold` expose mode-specific Genjutsu preparation guidance. `model:prepare` and `film:rights` source-use/input approvals remain CLI-only; `motion:library` is currently a local CLI. `generate_model` retains and checks nested context.modelPreparation through the common admission path; no provider input field is added.

`vision_pack` scopes input/request/output plus nested request paths using the trusted scope root. `vision_inspect` is read-only and verifies source/frame/page/crop hashes before returning bounded evidence. Visual harness evaluation stays CLI-only.

MCP startup checks the exact project runtime policy before serving tools; startup refusals stay on stderr ([Node policy](../../docs/node-runtime.md)).

Catalogue prices (2026-11-16): `avc_models_prices` ranks tracked scenario cells read-only; floors/unknowns never satisfy a maximum price ([guide](../../docs/model-slots-guide.md#catalogue-price-comparison)).

Campaign tools (2026-11-16): `campaign_production`, `campaign_next`, `campaign_brief` require workspace authority, scope nested inputs and cannot approve or submit paid work. Single-project launchers refuse them.

Scope root (2026-11-16): tools carry `scopeRoot` on their `define()` entry instead of a name list in `prepareCommand`; all `viz_*`, `audio_mix` and `backend` now receive it. `audio_mix --plan` resolves track sources against it and refuses `..`, protocols (`concat:`, `subfile:`, `http:`) and escapes before any probe; `backend` export asset paths must lie inside it.

Film briefs (2026-11-16): `film_brief` returns the brief's path and one-line `dispatch` (`print` adds the text); `film_show` is local and read-only, scopes `artefact` and itself refuses paths outside the project and `out/<id>/`.
Step lease (2026-11-17): `prepareCommand` checks the project's step lease before `--allow-paid` (`guardTool`, shared with `runScript`): in enforce mode (`AGENTBROS_STEP_GUARD=enforce`, or unset with an autonomous policy or a benchmark run) an out-of-step tool is refused and an unapproved spend on a dry-run tool is narrowed to `--dry-run=true`; `--allow-paid` only narrows. `step:unlock` stays CLI-only; `step_violations` is the read-only report ([step lease](../../docs/step-lease.md)).

Console (2026-11-17, RFC 0004 D17): read-only `avc_console_url` (never the token) and `avc_console_view` (trimmed; `console-tools.ts`), plus `avc_console_card`; decisions and control stay the user's. CLIs run with `AGENTBROS_CHANNEL=mcp`.
