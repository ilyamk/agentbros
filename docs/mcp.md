# Trusted local MCP CLI bridge

The server uses the [official TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) (`McpServer.registerTool` and `serveStdio`). Launch with the project-pinned Node runtime and repository dependencies installed:

```json
{
  "mcpServers": {
    "agentbros": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/repository/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/repository/src/mcp/stdio.ts",
        "--root",
        "/absolute/path/to/project-workspace"
      ]
    }
  }
}
```

You rarely write this by hand: the tracked `.mcp.json` launches the server for Claude Code (and the Copilot CLI) from the repository root, and `pnpm harness:setup --apply` writes the entry, with absolute paths and the pinned Node, for Codex, Cursor, VS Code, OpenCode, Amp and the others ([harnesses](harnesses.md)).

**Toolsets (2026-11-17).** `--toolsets all` (the launcher default, also `AGENTBROS_MCP_TOOLSETS`) lists every tool; `core` lists about twenty for the shared loop (next step, playbook, film and footage steps, render, QA, delivery, budget); registry sections can be added (`core,footage`). Unlisted tools stay callable through `avc_call { tool, arguments }` with the same checks, and `avc_capabilities` marks each tool `listed`. `avc_guide` lists and reads `.agents/` skills (with their reference files) and agent definitions, read-only and contained. The initialize result carries instructions: start with `avc_next` or `avc_playbook`.

The root is the workspace containing `public/projects`, `out`, recording inputs and request files; without `--root` it is `AGENTBROS_ROOT`, else the checkout itself, never the harness's working directory. Server code and CLI implementations always come from the fixed checkout containing `src/mcp/stdio.ts`; tool requests cannot choose executable paths, shell commands or arbitrary flags. Paths passed directly in tool arguments are resolved against the configured root and checked using canonical filesystem paths, including symlink ancestors. `--project SLUG` optionally restricts direct project arguments; manifest-driven recipe/campaign creation is blocked in this mode. The server belongs to a **trusted local harness with project CLI write authority**, not a remote multi-tenant service or an OS sandbox. Request JSON and existing project artifacts remain trusted local application inputs; the underlying CLIs enforce their own deeper references and invariants.

`avc_capabilities`, `avc_models` and `avc_help` report the currently installed whitelist and canonical CLI help. The model catalog preserves distinct discovery/schema/local-adapter/live verification and dated prices. It does not infer live API acceptance from schema validation. Tool names use `avc_` plus the existing command's logical name. Tools for absent scripts are omitted rather than falsely advertised as functional.

**No-spend default:** image/video/modern-model/background-removal/upscale tools force `dry-run=true` even if a caller supplies false. ASR, alignment, voiceover, music and asset-dispatch tools lack safe CLI planning modes and are rejected before spawning. Help for these tools is still safe. To explicitly enable paid-capable execution, the human launcher must add `--allow-paid`; generation tools still default to dry-run, requiring the caller to explicitly supply `dry-run=false`. Existing durable operation IDs, unknown-price user bounds, project ceilings, reservations and reconciliation remain enforced by the CLIs. Enabling this server option does not remove those checks or cap provider billing.

Local imports, card/timeline edits, recipe/long-form/campaign workflows, local rendering, ingest, caption editing and QA may write project files without paid enablement. Use each tool's dry-run where applicable. Human creative/card approval requirements remain the underlying workflow's responsibility; a local MCP bridge cannot authenticate human approval merely from an agent-provided string.

`avc_video_workflow` exposes complete local product-ad, education, recording-edit and shorts-series creation from supplied originals. It defaults to read-only plan; `action=create` writes new projects, while `dry-run=true` forces plan. The bridge supplies the trusted workspace boundary for nested original paths. Manifest-driven workflow creation is blocked under single-project scope, like recipe/campaign creation. Returned projects still need explicit render, QA and delivery reviews; this tool never enables generation or fabricates approvals.

Each child runs with literal argv and `shell:false`. Human progress forwards to stderr; stdout is parsed as exactly one validated CLI JSON envelope, with exit status checked. MCP stdout belongs solely to SDK JSON-RPC, so this entry point intentionally lives outside `scripts/` and its one-envelope contract. Calls return structured content plus JSON text, and failed envelopes become MCP tool errors.

Default child timeout is 60 seconds; set trusted launcher `--timeout-ms N` (1,000–7,200,000) for lengthy local ingest/renders. The opt-in two-hour ceiling accommodates full-resolution longform pipelines; it does not change the default, provider timeouts or spending authority. Stdout collection is bounded at 64 MiB. On POSIX, timeout/cancellation terminates the process group, including local ffmpeg/render children; on Windows termination covers the immediate child and is not an OS job-object sandbox. An interrupted paid operation can remain uncertain: resume/reconcile its original operation ID rather than submitting a replacement. Large inline media is replaced **only in the MCP response** by MIME, byte count and SHA-256 summaries; the actual CLI request is unchanged. Responses exceeding 2 MiB return an explicit artifact summary instead of silently clipping data. Read the listed local artifact or query a narrower result.

Local verification uses a real SDK client for initialize/list/call, temporary projects, removed API keys, fixed offline dry runs, strict-schema/path tests and mocked subprocess contract/size/timeout failures. No paid API acceptance or live generation was performed.

`avc_generate_stream` and `avc_generate_realtime` force offline planning by default even with `execute:true`; future paid use needs launcher `--allow-paid`, explicit `dry-run:false` and `execute:true`, plus underlying budget admission. Realtime validates the request's nested projectId against the scoped project argument. `avc_generate_model` routes stream requests but directs realtime to its separate session request contract. `avc_capture_html` and `avc_resolve_handoff` execute the bounded local adapters; the bridge supplies its trusted filesystem boundary to validate nested asset/original paths. HTML project-scoped publication must stay in that project; Resolve checks the handoff's expected project. Resolve defaults to probe, while explicit execute uses clone-only writes and actual readback requirements. These are trusted local tools, not a hostile HTML sandbox or proof of installed-editor compatibility.

Footage editing tools (`avc_footage_shots`, `avc_recut_plan`, `avc_shorts_prepare`, `avc_shorts_rank`, `avc_shorts_calibrate`, `avc_shorts_request`, `avc_multicam_sync`, `avc_multicam_angles`, `avc_reframe_track`) are local and write only the files they are given (`avc_shorts_request` writes chapters only: approving clips stays the user's, on the CLI); order and approvals: [footage editing](footage-editing.md). `recut_plan` and `shorts_rank` write unapproved drafts; the person's edit-hash or selection approval stays outside the bridge. `multicam_sync` takes `inputs` as a list: each path is scoped like any other and passed as one comma list, so a listed path cannot contain a comma. `recut_plan` requires `source`, so the path recorded inside a transcript is never read over MCP (the CLI keeps its fallback); `reframe_track` scopes `timeline` and `recording-edit`, which `clip-id: "all"` needs. `shorts_rank` `chapters` is project-relative and refuses absolute paths and `..`. `speech:local` is deliberately not a tool: it stays a trusted CLI, as the [speech](speech.md) guide specifies; paid `avc_transcribe` stays blocked without `--allow-paid`.

## Coverage: which commands are tools

Every command is either a tool or excluded with a reason, and the [command registry](../src/lib/cli/commands.ts) is the one list: each entry names its tool (`mcp`) or carries `excluded: <reason>`, and the catalogue takes each tool's script from it. `pnpm commands --query <word>` (or `avc_commands`) shows a command's tool or exclusion; `avc_capabilities` lists the excluded ones under `cliOnly`. Reasons used: the user's approval; deleting files; interactive servers; development tools; trusted arbitrary code (`blender:run`, `hyperframes:render`); local engines and weights (`speech:local`, `media:prepare`, `media:local`, `media:ocr`, `media:visual`, `media:category`, `audio:stems`); repository files read relative to the working directory (`library:*`); legacy fetchers superseded by `avc_resources`; and "not yet exposed" for local commands nobody has wrapped yet. `tests/commands-registry.test.ts` fails when a command has neither.

## Studio console

Three tools serve the [studio console](rfcs/0004-studio-console.md) (D17). `avc_console_url` returns the running server's address (`http://127.0.0.1:<port>/#/projects/<id>`) from `out/console/server.json`, never the session token, and starts nothing. `avc_console_view` returns the project's read model trimmed for an agent: control, steps, decisions waiting for the user, agent cards with their answers, money totals, the latest render and QA counts. `avc_console_card` runs `console:card`: `data` is a scoped JSON file (`CardInputSchema`); the card's media are project-relative and confined to `public/projects/<id>/` or `out/<id>/`. Applying a decision, answering a card and pause, resume or stop are the user's, in the console or on the CLI, and are not tools. Every CLI the bridge runs carries `AGENTBROS_CHANNEL=mcp`, so the journal shows what came through MCP.

## Playbooks

`avc_playbook` lists the task playbooks, shows one resolved, ranks candidates for a request (`match`, with strength, modifiers and a named existing project) and binds a project (`use` with `project`), recorded as the agent's choice; it refuses a project bound to another playbook or on a route the playbook lacks. Rebinding (`--force`), recording that the user chose (`--by user`), regenerating the index (`--write-doc`) and `--check` stay on the CLI. Playbooks are read from the checkout that holds the code, so the tool sees the same set from any workspace root.

## Film chain

An MCP client can drive a bespoke film from `avc_film_init` to `avc_film_render`, except where the user decides:

- Exposed: `film_route` (read-only; `--write-doc` stays on the CLI), `film_init` (one `product` path; several on the CLI), `film_status`, `step_violations` (read-only [step lease](step-lease.md) report), `film_next`, `film_brief`, `film_done` (records a finished step or skips a skippable one; it cannot pass a user gate, because a gate stays open until an approval matches the artefact's hash), `creative_stimuli`, `creative_pool`, `creative_rank`, `creative_pick`, `creative_bench`, `concept_boards`, `film_targets`, `plan_check`, `film_stills`, `film_render`, `film_measure`, `critic_pack`. All are local, write only inside the root and are scoped to `--project` when the server is.
- Excluded: `film:approve` and `film:rights`, because approval is the user's, CLI only. When `avc_film_next` returns an ask, the client puts the question to the user, and the user's own words are recorded with `pnpm film:approve` (or `film:rights`) on the CLI. A bridge cannot tell an agent's string from the user's words.
- `film_render` and `film_stills` render with Chromium: launch the server with `--timeout-ms` long enough for a full render, since the 60-second default suits only short work.

## Blender live session

`avc_blender_live` drives `pnpm blender:live`: a background Blender holding one scene. The actions are `start`, `inspect`, the typed edits `add`, `delete`, `material` and `set`, `run-kit` (a shot from `scripts/blender/`), `still` and `strip` (PNG paths to open), `save`, `export` (a recipe and the `blender:run` command that replays it) and `stop`. Arsenal actions are `append-asset` (`id`, optional `kind`, `name`, model `scale`/`location`, `material_scale`, mesh `target`), `apply-recipe` (`id`, `params`), `enable-extension` (`id`) and read-only `arsenal` (`kind`, `filter`, `limit` up to 100). Unknown keys fail. `start` accepts `extensions` as approved installed ids or `approved`; no profile path or download is accepted. `export-recipe` emits a shot script plus the pinned journal. The tool includes edits, so its MCP read-only hint remains false. Agent guide: [live session](../.agents/skills/blender-3d/references/live-session.md). Why we built it instead of adopting a Blender MCP server: [evaluation](blender-mcp-evaluation.md).

It is a tool while `blender:run` is not, because it takes no code. There is no Python or expression action, `run-kit` accepts only tracked kit scripts, and `set` refuses drivers, scripts, file paths and private names. Blender listens on `127.0.0.1` with a 256-bit token kept in a mode-0600 file under `.cache/blender-live/`. It starts with `--factory-startup --disable-autoexec --offline-mode` and fetches nothing. Outputs are names, contained under `out/` and the project's `assets/blender/`. `blend` is the one path field, scoped like any other. `--overwrite`, `--ui` and `--executable` stay on the CLI.

A still at full size can outlast the 60-second default. Add `--timeout-ms` to the server's launch arguments in your MCP client configuration (outside this repository; the user edits it), and pass a matching `timeout` in seconds to the tool:

```json
{
  "mcpServers": {
    "agentbros": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/repository/node_modules/tsx/dist/cli.mjs",
        "/absolute/path/to/repository/src/mcp/stdio.ts",
        "--root",
        "/absolute/path/to/project-workspace",
        "--timeout-ms",
        "900000"
      ]
    }
  }
}
```

This server needs no extra registration. A third-party Blender MCP server (Blender Lab, or the community MCP for Blender) changes your harness configuration and runs arbitrary Python. The user installs one only by choice, pinned, from the snippets in [MCP routes](../.agents/skills/blender-3d/references/mcp-routes.md). We never add it to a configuration ourselves.

The stdio entry point refuses unsupported or inconsistent project Node policy before advertising tools; diagnostics stay on stderr. Select the exact [project runtime](node-runtime.md) in the editor/server launch environment.
