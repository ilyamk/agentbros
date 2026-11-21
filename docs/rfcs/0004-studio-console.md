# RFC 0004: Studio console, a live local workspace for the user, the agents and the production

Status: implemented (2026-11-17); see the [studio console guide](../console.md) for current behaviour. Decisions D1–D25 stand as amended in §17, where every contract change and deviation is listed. Pending manual acceptance by the maintainer: live Claude Code and Codex hook sessions (wake, relay), the macOS notification display and click, and the milestone acceptance demo on a real film.
Date: 2026-11-17
Owner: the maintainer (`@ilyamk`)
Builds on: [step lease](../step-lease.md), [local review UI](../local-review-ui.md), [coding-agent harnesses](../harnesses.md), [film chain](../../src/lib/film/AGENTS.md), [memory](../../memory/AGENTS.md), [paid execution](../paid-execution.md), [delivery](../delivery.md), [MCP](../mcp.md)

## Summary

A film in Agent Bros. Pictures is made by an orchestrator and a dozen leaf agents across fifteen to twenty chain steps, with user gates, paid quotes, blind tournaments, critic rounds, renders and QA. Today the user follows this only through the harness chat: approvals scroll away, assets sit in folders, money is in a ledger file, and the time each agent spent is not recorded anywhere. The quality of the film depends on the quality of the user's decisions, and the chat is a poor place to make them.

This RFC proposes the **studio console**: a local web application, served on `127.0.0.1` by `pnpm console`, that both Claude Code (desktop preview pane) and Codex (in-app browser) open beside the chat, and any browser can open too. It:

1. **shows** every project live: the chain and its reasons, what the agents are doing and for how long, every asset with provenance and cost, the money, the latest animatic and renders with frame strips, QA evidence and the history;
2. **collects decisions** where they are easiest to make well: gates, choices among pools, paid quotes, reference ratings, frame-anchored feedback, the final verdict, each recorded in the user's own words and applied through the existing CLIs;
3. **gives control**: pause, stop, autonomy level, budget ceiling, skipping a skippable step, one more critic round;
4. **costs the agents nothing**: `pnpm next` starts the server itself; data comes from files the chain already writes, one journal line written by `runScript` for every CLI, and harness hooks; an agent at most opens a URL once and, in Claude Code, waits on `console:wait` instead of ending its turn;
5. **calls the user** with macOS notifications when a decision waits, a command fails or a render is ready;
6. **replaces `review:ui`**: the timeline editor, snapshots and take choice move into the console during M2–M3, on the same server-side edit logic;
7. **feeds quality back**: structured verdicts (score, rubric axes, what worked and what did not, frame comments) and ratings go to memory and the creative postmortem, and the journal measures time-to-decision, rework and wasted spend.

The console has no truth of its own. It is a projection of the project's files plus a journal, and every write goes through a CLI that already validates it.

---

## 1. Current state (2026-11-17, verified in code and docs)

### 1.1 Harness surfaces

| Harness     | Surface                                   | What it does                                                                                                                                                                                                                                                                                          | Evidence                                                                      |
| ----------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Claude Code | **Artifacts**                             | HTML page published to claude.ai, private, versioned; opens in the desktop pane or the web. Optional capabilities: a small shared database (`ArtifactData`), comments routed to the session (`ArtifactComments`, watch), the page asking Claude, files. Cloud-hosted: project data leaves the machine | Tool contracts in the Claude Code session, 2026-11-17                         |
| Claude Code | **Desktop preview / built-in browser**    | Shows a localhost page beside the chat (`preview_start`)                                                                                                                                                                                                                                              | Claude Code session tools, 2026-11-17                                         |
| Claude Code | **Mods / plugins**                        | A panel beside the chat that updates, status line, toasts, slash commands                                                                                                                                                                                                                             | `plugin-authoring` skill description                                          |
| Claude Code | **Hooks**                                 | `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `Notification`, `SessionStart`/`End` and more, run by the harness. We already ship `scripts/hooks/claude-step-guard.mjs`                                                                                                                         | Claude Code settings; repo                                                    |
| Claude Code | **Background commands**                   | A command run in the background re-invokes the agent when it exits                                                                                                                                                                                                                                    | Bash tool contract                                                            |
| Codex       | **In-app browser** (announced 2026-04-16) | Shared view of rendered pages in a thread: localhost routes and file-backed pages; separate profile                                                                                                                                                                                                   | [Codex docs: in-app browser](https://developers.openai.com/codex/app/browser) |
| Codex       | **Annotate**                              | The user clicks an element or drags an area, writes a comment; comments reach the agent with the next chat message                                                                                                                                                                                    | Same page                                                                     |
| Codex       | **Developer mode / Computer Use**         | CDP access to DOM, console and network with per-site approval; the agent can open pages, click, type and screenshot                                                                                                                                                                                   | Same page                                                                     |
| Codex       | **Hooks**                                 | Lifecycle hooks with subagent events, blocking and context injection; repo-local `.codex/hooks.json` in trusted projects; `notify` only at turn end                                                                                                                                                   | [Codex hooks](https://learn.chatgpt.com/docs/hooks), 2026-11-17               |
| Codex       | HTML canvas comparable to Artifacts       | Not found in official sources (2026-11-17)                                                                                                                                                                                                                                                            | —                                                                             |

The common denominator is a **page on localhost**. The Claude Artifact remains an optional, consented export of a static snapshot (D18).

### 1.2 What the repository already has

- **Chain state from files.** `deriveChain()` (`src/lib/film/state.ts`) derives every step's status (`done`, `ready`, `blocked`, `stale`, `skipped`, `invalid`), reasons, inputs, outputs, critic gates and advisories from files and hashes. `film:status` exposes it with step-guard reports and brief dispatch totals (`dispatchTotals`).
- **Footage route state.** `src/lib/footage/next.ts` defines `STEP` (setup → source → transcript → … → render → done) and `decideNext()`.
- **One CLI choke point.** `runScript()` (`src/lib/cli/index.ts`) wraps about 250 production CLIs; `emitResult()` writes one JSON line and calls `process.exit`. `emitProgress()` writes human progress to stderr.
- **Step lease and guard.** `pipeline/session/lease.json`, `violations.jsonl`, `CONTROL_ALIASES`, warn/enforce/off modes, `step:unlock` ([step lease](../step-lease.md)).
- **Approvals in the user's words.** `film:approve --step <id> --answer "<the user's words>"` (or `--proxy`/`--policy`), `film:policy --autonomy … --answer … --ceiling-usd … --final-review-only …`, `film:revert`, `budget --ceiling-usd --answer`.
- **Money.** Durable jobs (`src/lib/jobs/`), `pipeline/operations.json`, `pipeline/cost-ledger.jsonl`, `budget`, `cost:report`.
- **Memory.** `pnpm memory --add` with types (decision, preference, lesson, observation, gap, episode), `--quote`, `--step`, `--playbook`.
- **Local review server.** `review:ui` (`src/lib/review-ui/server.ts`): `127.0.0.1`, random port, 32-byte token in the URL fragment, `x-review-token` header, `HttpOnly SameSite=Strict` cookie for `/file`, timeline edits, snapshots, assets, budget, QA. Its client is about 47 KB of HTML and JS in TypeScript strings (`src/lib/review-ui/client.ts`).
- **Realtime local channel.** `src/lib/realtime/*` (offline editor actions over a local message channel).
- **MCP bridge.** The `agentbros` MCP server over the CLIs; `harness:setup` wires ten harnesses.
- **UI material.** React 19 and Tailwind v4 in `package.json`; `ui-sources/` holds a shadcn scratch setup (`components.json`).

### 1.3 Gaps

1. Decisions live in the chat scrollback: hard to find, easy to make without the material in view (the three ideas, the styleframes, the quote).
2. No single view of a project: chain, agents, assets, money and renders are in five places.
3. No record of agent work over time: which agent ran on which step, how long, how many critic rounds, what each CLI cost.
4. No way for the user to act between agent turns other than typing in chat; in autonomous mode no way to pause.
5. The review UI is hard to extend and inconsistent in look; it does not play compositions.
6. User verdicts and ratings are captured only when an agent remembers to call `memory --add`.
7. No measurement of the interaction itself: time-to-decision, rework after a verdict, spend on work the user later rejected.

---

## 2. Goals, non-goals and principles

### 2.1 Goals

- G1. One place where the user sees the state, the material and the money of every project, live.
- G2. Every decision the user owns can be made in the console with the material beside it, and reaches the agent without retyping.
- G3. The user can steer: pause, stop, autonomy, budget, skip, one more round.
- G4. Zero or one-line effort for agents; works identically under Claude Code, Codex and any harness that can open a URL; degrades to "a browser tab" anywhere.
- G5. Professional look from day one, consistent with the brand tokens.
- G6. The interaction is measured and its lessons flow into memory and the system loop.

### 2.2 Non-goals

- A second source of truth, a database, or state the CLIs do not know about.
- A cloud service, accounts or multi-user collaboration (a static snapshot export is D18).
- Executing paid jobs from the UI. The console approves quotes; the agent's CLI spends under normal admission.
- Live playback of composition code. The console plays rendered files (animatic, scene renders, final renders); live preview stays in Remotion Studio (D21).
- A notification channel that leaves the machine (Telegram, e-mail, phone push); that needs its own RFC.
- Judging music or quality on the user's behalf. The console never shows an agent's claim that a film "sounds good".
- Arbitrary agent-written HTML on the canvas (D14).

### 2.3 Principles

1. **Projection, not storage.** The view is a pure function of project files plus the journal. Delete `out/console/` and nothing is lost.
2. **Every write is a CLI.** The console spawns the same command an agent would, with literal argv, and records its JSON envelope.
3. **The user's own words.** Every decision carries text the user wrote or chose, stored verbatim with `channel: "console"`.
4. **Harness-neutral.** Hooks enrich; their absence never breaks a view.
5. **Local and private.** Loopback only, token-guarded, git-ignored, no network calls from the UI.
6. **Fast to read.** A decision card must be decidable in under thirty seconds when the material is good.
7. **Video rules are untouched.** UI code lives outside the composition tree; determinism law keeps applying to `src/`.

---

## 3. Decisions (proposed)

| #   | Question                         | Proposal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Surface                          | A local HTTP server (`pnpm console`) on `127.0.0.1`. Claude Code opens it in the desktop preview, Codex in the in-app browser, otherwise the default browser. No mod or plugin is required; a Claude Code mod that shows the waiting count in the status line is optional (WP14).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D2  | New server or extend `review:ui` | New module `src/lib/console/` reusing `review:ui`'s security code (token compare, cookie, path confinement), extracted into `src/lib/local-server/` in WP2. **The console replaces `review:ui`** (confirmed 2026-11-17): WP13 ports every review feature to React views on the console server over the unchanged server-side services (`TimelineEditStore`, snapshot, take choice, visual and audio edit preparers, chapters, realtime channel), proves parity with the existing tests, then removes the HTML-string client; `pnpm review:ui` becomes an alias that opens the console's timeline view.                                                                                                                                                                                                                                            |
| D3  | UI stack                         | Vite + React 19 + TypeScript + Tailwind v4 + shadcn/ui (Radix). Server: `node:http` (as `review:ui`), no framework. Data: REST for snapshots, SSE for changes, a small store on `useSyncExternalStore`. Tables: TanStack Table. Charts: shadcn charts (Recharts). Icons: lucide. Video: the native media element over range-served renders with our controls (D21). No Next.js: no SSR, no routing server, one local user. New dependencies, none installed today: `vite`, `@vitejs/plugin-react`, shadcn's Radix packages, `@tanstack/react-table`, `recharts`, `lucide-react`; dev: `vitest`, `@testing-library/react`, `@playwright/test`. Each passes `deps:licences --check` in WP0.                                                                                                                                                         |
| D4  | Where code lives                 | UI: `apps/console/` (own `tsconfig`, Vite config, ESLint profile; not imported by `src/Root.tsx`). Server and domain: `src/lib/console/`. Schemas: `src/types/console.ts`. CLIs: `scripts/console*.ts`. Built bundle: `out/console/dist/` (git-ignored), rebuilt when the source hash changes. Single package, no pnpm workspace.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| D5  | Component sources                | **Confirmed 2026-11-17 after the bake-off (§10.3).** **shadcn/ui is the design system.** Main donor: **affectUI free items (MIT)** for decisions (decision inbox), agent activity (tool-call cards and groups, thinking loader), notifications (notification stack) and rating (stars, thumbs). Second donor: **uiarc free core (MIT)** for money (metric card, usage meter) and the event feed (timeline); its stepper is the step rail reference. **beautifului is not used** (its published foundation CSS does not parse, and it covers the least). **Spectrum UI** stays excluded (no licence). No paid code in tracked files. Every borrowed component is rewritten onto our tokens, its English strings move to the i18n dictionaries, `motion` is used only where a uiarc component needs it, and `credits/<id>.json` records the source. |
| D6  | Transport                        | `GET` JSON endpoints and one SSE stream per page (`/api/stream?project=`). No WebSockets. SSE events carry a revision; the client refetches the view on a gap.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D7  | Event journal                    | `public/projects/<id>/pipeline/events.jsonl` for any CLI run with a valid `--project`; `out/console/events.jsonl` for the rest that matter (`playbook`, `film:init` before a project exists). `runScript` writes a `cli.start` line at entry and a `cli.end` line synchronously before `emitResult` (which exits). Rotation at 10 MB to `events.<n>.jsonl.gz`. Arguments are redacted (§6.1). Writing never fails a command: errors are swallowed and counted. `AGENTBROS_EVENTS=off` disables it.                                                                                                                                                                                                                                                                                                                                                |
| D8  | Agent activity and hooks         | **Decided 2026-11-17 (§7.1, H1–H9).** One harness-neutral hook script with six roles (`observe`, `guard`, `orient`, `relay`, `surface`, `wake`), installed by `harness:setup --hooks` into git-ignored `.claude/settings.local.json` and `.codex/hooks.json` only after the user agrees, fail-open, bounded, scoped to this checkout, coexisting with other tools' hooks. `film:brief` still writes `agent.dispatch` events itself, so the film chain is covered without hooks.                                                                                                                                                                                                                                                                                                                                                                   |
| D9  | How decisions are applied        | The console server applies a decision **immediately** by spawning the owning CLI (for example `film:approve --step script --answer "<words>"`) with `AGENTBROS_ACTOR=user` and `AGENTBROS_CHANNEL=console`. The decision file `pipeline/inbox/<decisionId>.json` records the request, the argv, the CLI envelope and the status (`applied`, `refused`, `superseded`). There is no queue an agent must drain. A refused CLI result is shown to the user verbatim.                                                                                                                                                                                                                                                                                                                                                                                  |
| D10 | The user's words                 | **Confirmed 2026-11-17.** Each decision has a text field prefilled with an editable phrase for the chosen action ("Approve script B."), in the UI language; the user may write more or rewrite it. The stored `answer` is exactly what was submitted, with `channel: "console"`. Submitting the prefilled phrase is the user's own act and counts as the user's words for `film:approve`, `film:policy` and `budget --answer`. Paid quotes and autonomy changes show the comment field open, still prefilled. Proxy and policy approvals stay CLI-only; an agent can never submit a console decision.                                                                                                                                                                                                                                             |
| D11 | Waking the agent                 | `pnpm console:wait --project <id> [--timeout-min 30]` blocks until a decision, a pause, a stop or a card answer for that project, then emits one JSON line with what happened. In Claude Code the orchestrator runs it as a background command at a gate and is re-invoked when it exits. Elsewhere, the next user message wakes the agent and `pnpm next` reports what was decided. `pnpm next`'s answer gains a `console` block: URL, pending decisions, decisions applied since the agent's last call. Where the `wake` hook is installed (Claude Code, §7.1), it resumes the agent instead and the orchestrator skips `console:wait`; in Codex the `relay` hook delivers the decision with the user's next message.                                                                                                                           |
| D12 | Pause and stop                   | **Confirmed 2026-11-17.** `pipeline/session/control.json` (`running` / `paused` / `stopped`, who, when, why). `runScript` refuses every non-control alias of a paused or stopped project with a new error code **`PAUSED`** (halt, tell the user; never retry), added to the CLI JSON contract. **Pause is soft:** paid jobs already submitted run to completion and their results are kept (the money is spent). **Stop asks:** it applies the same refusal and then lists the running paid jobs with their reserved amounts; the user cancels each one separately, only where the provider supports cancellation, through the job store; a job that cannot be cancelled is marked as such. Resume returns to `running`.                                                                                                                         |
| D13 | Autonomy and budget controls     | The console's autonomy selector is a form over `film:policy` (film) and `budget --ceiling-usd` (footage). It can never grant more than the CLI would; raising a ceiling shows the exact command and amount before submission.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D14 | Agent cards                      | `pnpm console:card --project <id> --kind <kind> --data <file.json>` puts a typed card on the canvas: `compare` (A/B media), `grid` (candidates), `rating`, `choice`, `question`, `markdown`, `media`. Kinds are Zod schemas; media paths must be inside the project. No raw HTML or script. A card with a question returns the answer through the inbox and `console:wait`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| D15 | Security                         | Bind `127.0.0.1` only; reject requests whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding); per-machine token in `out/console/session.json` (mode 0600), stable across restarts so the harness browser can reload; token via fragment once, then an `HttpOnly SameSite=Strict` cookie; state-changing requests need the `x-console-token` header (CSRF); every file path resolved and confined to `public/projects/<id>/` or `out/<id>/`; no secrets in any response; the server never calls a provider.                                                                                                                                                                                                                                                                                                                 |
| D16 | Ports and processes              | One server for all projects, default port 4317 (`--port`, falls back to a random free port and says so). A lock file `out/console/server.json` (pid, port, version) lets every caller reuse a running server instead of starting another. **Auto-start (confirmed 2026-11-17):** `pnpm next`, `film:next`, `footage:next` and `film:init` start the server detached when none is running (logs to `out/console/server.log`), restart it when the bundle version changed, and return its URL; `pnpm console` remains for manual start. `AGENTBROS_CONSOLE=off` disables auto-start; tests and benchmark runs set it. A failed start never fails the calling command: its answer carries `console.error` instead of a URL.                                                                                                                          |
| D17 | MCP                              | Read tools on the `agentbros` MCP server: `console_url`, `console_view` (project read model, trimmed), `console_card` (post a card). Applying decisions and changing control are **not** MCP tools: they belong to the user.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| D18 | Sharing                          | Later: `pnpm console:snapshot --project <id>` writes a self-contained static HTML snapshot to `out/<id>/console-snapshot.html`. Publishing it (for example as a Claude Artifact) only on the user's explicit request, because the data leaves the machine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| D19 | Language                         | **Confirmed 2026-11-17:** English, Russian and Chinese (Simplified) at launch, matching the playbooks' three languages. One typed dictionary per language in `apps/console/i18n/`; a test fails on a missing key; language follows the system with a switch in Settings. Prefilled decision phrases are in the UI language. The user's text and agent content are never translated.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D20 | Metrics                          | Interaction metrics (§12) are derived from the journal locally; nothing is sent anywhere.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D21 | Video                            | **Confirmed 2026-11-17: rendered files only.** The console plays the animatic, scene renders and final renders (range-served), with frame strips, frame stepping and frame/region comments. No `@remotion/player` and no composition code in the console bundle; a "Open in Remotion Studio" action covers live preview. **Amended 2026-11-18 (§17):** that action starts Studio on the user's request.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D22 | First release scope              | **Confirmed 2026-11-17:** M2 is the bespoke **film** route with view, decisions, control, agent cards and notifications. The footage route, ratings and frame feedback follow in M3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D23 | Notifications                    | **Confirmed 2026-11-17:** macOS notifications in M2, sent by the local server without network: a decision waiting, an agent card waiting, a failed command at the current step, a render or delivery check finished, a paid job finished. Clicking opens the console at the card. Off until the user enables it at the first-run prompt or in Settings; per-kind toggles; quiet while the console tab is focused. Delivery mechanism (bundled Swift helper in `scripts/workers/` versus `osascript` without click-through) is decided in WP14. Other platforms: in-page toasts and the tab title count only.                                                                                                                                                                                                                                      |
| D24 | Final verdict                    | **Confirmed 2026-11-17:** the verdict card asks for an overall score 1–10 (required), optional scores on the project's frozen rubric axes, "what worked" and "what did not" fields, and optional frame comments. It applies `film:approve --step human --answer "<words>"`, writes `memory --add --type decision` with the user's words and the scores, and offers the `creative-postmortem` hint. Scores feed §12 metrics per playbook.                                                                                                                                                                                                                                                                                                                                                                                                          |
| D25 | Licence                          | **Decided 2026-11-17.** The console (`apps/console/`, `src/lib/console/`, its schemas and CLIs) is part of the Licensed Work under the Business Source License 1.1 like the rest of the repository (`LICENSE`); it has no separate licence. Console dependencies must be permissive, on `contrib/licence-allowlist.json`: no GPL, AGPL, LGPL or other copyleft licence that would bind our code; MPL-2.0 only after a recorded review (Appendix C). Borrowed MIT components (affectUI, uiarc, shadcn/ui; D5) keep their copyright and licence notices in [NOTICE.md](../../NOTICE.md) and `credits/`. The licence's three-Personnel threshold is enforced by the licence, not by code: no licence keys, activation, seat counting or telemetry in the console, consistent with D20.                                                               |

---

## 4. Product requirements

### 4.1 Users and situations

| Persona                      | Situation                                               | What they need from the console                                                                      |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Creator, interactive**     | Makes a promo with the agent, approves each gate        | See the material for the decision, decide fast, know what happens next and what it costs             |
| **Creator, autonomous**      | Granted a policy, checks in now and then                | Status at a glance, money, a pause button, the final verdict, notifications only for what needs them |
| **Editor of own recording**  | Footage route: transcript, recut plan, captions, shorts | Plan review with hashes, approval of the edit, render outputs per format                             |
| **Maintainer / contributor** | Debugs a run, improves the harness                      | The journal: which CLI failed, step-guard violations, time per step, agent dispatches                |

### 4.2 User stories and priority

P0 is needed for the first usable release (M2), P1 for the platform (M3), P2 later.

| ID   | Story                                                                                                                                                | Priority |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| US1  | As a creator I see every project on a home page with its route, step, active agent, waiting decisions and spend                                      | P0       |
| US2  | I see the chain of the current project with each step's status and reason, and the next command                                                      | P0       |
| US3  | I see "Waiting for you" pinned at the top with every pending gate, choice and quote, each with its material                                          | P0       |
| US4  | I approve or reject a gate with my words and the agent continues without me retyping it                                                              | P0       |
| US5  | I see the budget, reservations, actual spend by provider and job status                                                                              | P0       |
| US6  | I watch the latest animatic or render and step through its frames                                                                                    | P0       |
| US7  | I pause or stop the project; agents' commands stop with a clear reason                                                                               | P0       |
| US8  | I see which agent works now, on which step, for how long, and today's runs                                                                           | P1       |
| US9  | I pick among an idea pool or script variants with blind scores and the tournament beside them                                                        | P1       |
| US10 | I rate references and styleframes (1–5 and a note); the ratings feed the look and memory                                                             | P1       |
| US11 | I leave feedback pinned to a frame or a region of a frame; it becomes a `feedback` entry for the fixer                                               | P1       |
| US12 | I browse assets with provenance, licence, cost and where each is used                                                                                | P1       |
| US13 | I see QA findings with frame evidence and the delivery check result per format                                                                       | P1       |
| US14 | I change autonomy and the budget ceiling from the console                                                                                            | P1       |
| US15 | I skip a skippable step or ask for one more critic round                                                                                             | P1       |
| US16 | I give the final verdict (score 1–10, rubric axes, what worked, what did not, frame comments) and it goes to memory, metrics and the postmortem      | P0       |
| US17 | I see the history of the project: decisions, versions, renders, costs, and compare two versions                                                      | P1       |
| US18 | Agents can put a comparison, a grid or a question on my canvas and get my answer                                                                     | P0       |
| US19 | The footage route has its own canvas: transcript, recut plan, captions, shorts, formats                                                              | P1       |
| US20 | I get a macOS notification when a decision or card is waiting, a command fails or a render is done                                                   | P0       |
| US21 | I see cross-project lessons, preferences and references (library)                                                                                    | P2       |
| US22 | I export a static snapshot to share                                                                                                                  | P2       |
| US23 | Campaign and replica routes have their own canvases                                                                                                  | P2       |
| US24 | Everything `review:ui` does (timeline edits, snapshots, take choice, assets and entities, chapters) works inside the console, and the old UI is gone | P1       |
| US25 | The console starts by itself when I start or resume a project; I never run a server by hand                                                          | P0       |
| US26 | The console speaks English, Russian or Chinese                                                                                                       | P0       |

### 4.3 Functional requirements

- FR1. The view of a project updates within 1 s of a file change or a journal line (debounced watch, SSE).
- FR2. Every pending decision is derived from chain or footage state, never only from the journal: a decision cannot be "lost" by a missing event.
- FR3. A decision is applied only if its target is unchanged: the card carries the hash of what the user saw (`expect`), and the CLI refuses a stale one (`film:approve --expect` already exists).
- FR4. Paid quotes show amount, provider, endpoint, `maxAdmissibleUsd`, the budget after, and "unknown price" when unknown; approving binds the quote hash.
- FR5. Every applied decision appears in the history with the user's words, the argv and the envelope.
- FR6. The console works with no hooks installed and with the server restarted at any time.
- FR7. Media streams with HTTP range requests; thumbnails and frame strips are cached under `out/console/cache/` keyed by content hash.
- FR8. The UI renders at 1280×800 and down to 390 px wide (harness side panes are narrow).
- FR9. Keyboard: `j/k` move between cards, `a` approve, `r` reject, `/` search, `space` play.

### 4.4 Non-functional requirements

- Startup under 2 s with a built bundle; view of a 200-step-event project under 300 ms; journal write under 2 ms per command.
- No network access from the UI; fonts bundled.
- Accessibility: WCAG 2.2 AA contrast, focus rings, ARIA on cards and live regions.
- The console must not change any composition, render or CLI result except by the explicit decisions above and the `PAUSED` refusal.

---

## 5. Information architecture and screens

### 5.1 Structure

A fixed shell with a generated canvas.

```
Shell
├─ Sidebar: Home · projects (status dot, waiting count) · Library (P2) · Settings
├─ Top bar (in a project): route · step · ● active agent + elapsed · ⏸ ⏹ · autonomy · $ spent / ceiling
└─ Main
   ├─ Home                 cards of projects, global "Waiting for you", recent deliveries, month spend
   ├─ Project canvas       Waiting (pinned) → step rail → panels chosen for route + step → collapsed done steps
   ├─ Project history      journal timeline, decisions, versions, compare, revert
   └─ Settings             language, theme, port, hooks status per harness, notifications
```

### 5.2 Project canvas: panels

A **panel** is a registered component with:

```ts
type PanelDef = {
  id: string; // "film.ideas-pool"
  routes: Route[]; // film, footage, recipe, campaign, replica
  when: (view: ProjectView) => boolean; // show at all
  weight: (view: ProjectView) => number; // order; the current step's panels weigh most
  collapsedWhen?: (view: ProjectView) => boolean;
  component: React.ComponentType<{ view: ProjectView }>;
};
```

Playbooks may declare extra panel ids in their manifest (`console.panels`); a missing id is a playbook check warning.

Film route (bespoke) panels by step:

| Step(s)               | Panels (expanded when current)                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------- |
| intake, strategy      | Brief summary, strategy one-pager, film type                                                                |
| discovery, truth      | Category scan clichés and white space; claims by status                                                     |
| ideas, idea-review    | Idea pool (anonymised, rubric scores), pairwise results, top three                                          |
| music                 | Route shortlist with players, the decision                                                                  |
| script, script-review | Script variants side by side, blind scores, winner                                                          |
| look                  | Styleframes gallery with ratings, reference board                                                           |
| beats                 | Motion plan shot list, cue sheet over waveform                                                              |
| material              | Material list: shot, source, licence, cost, quote; approve                                                  |
| narration             | Narrator direction, takes, caption words                                                                    |
| animatic, build       | Latest animatic and scene renders, frame strips per scene, motion:check per scene, critic rounds and scores |
| critic, fixer         | Ranked fixes, before/after frames per round                                                                 |
| qa, delivery          | Renders per format, QA findings with frames, delivery check                                                 |
| human                 | Final verdict form                                                                                          |

Always present (collapsed unless relevant): Agents, Money, Assets, Step guard, Advisories.

Footage route: Source, Transcript (speakers, words), Speech mask, Shots, Recut plan (removed spans on a timeline with reasons; approve hash), Captions style preview, Shorts (candidates with scores), Cameras, Reframe paths, Renders per format.

### 5.3 Wireframe: project at the build step

```
┌ promo-acme · bespoke/promo · build ─ ● motion-engineer · scene 3/5 · 6 min ─ ⏸ ⏹ ─ autonomy: ask for money ─ $3.10 / $10 ┐
│ WAITING FOR YOU (1)                                                                                                       │
│ ┌ Narration quote · $1.40 · elevenlabs v3 · budget after $4.50 ───────────────────────────────────────────────┐          │
│ │ 3 takes, 41 s total. Your words: [Approve the narration quote.______________]  [Approve] [Not now] [Change]  │          │
│ └──────────────────────────────────────────────────────────────────────────────────────────────── waiting 4 min ┘          │
├───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ strategy ✓ ideas ✓ music ✓ script ✓ look ✓ beats ✓ material ✓ animatic ✓ ▶ BUILD  critic ○  qa ○  delivery ○  human ○   │
├──────────────────────────────────────────────┬────────────────────────────────────────────────────────────────────────────┤
│ ▶ Animatic v3 (render)  00:18                │ Scenes  1 ✓  2 ✓  3 ◐  4 ○  5 ○                                            │
│ [0s][4s][9s][14s][18s]  frame strip          │ motion:check scene 3: 1 warning (safe zone, frame 212) [show]              │
│ [Comment on this frame]                      │ critic: round 1 7.2 → round 2 8.1                                          │
├──────────────────────────────────────────────┴────────────────────────────────────────────────────────────────────────────┤
│ Card from creative-critic: "Two endings" [A ▶] [B ▶]  Your choice: ( ) A  ( ) B  note [____]  [Send]                      │
├───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┤
│ ▸ Styleframes (3, rated) ▸ Script B ▸ Music: track 2 ▸ Assets (14) ▸ Agents today (9 runs, 41 min) ▸ Money ▸ History     │
└───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 5.4 Decision card anatomy

1. Kind and title ("Approve script", "Narration quote", "Choose an idea").
2. The material, inline: media, text, scores; a link to open it full screen.
3. Context: what the agent recommends and why (from the step's outputs, labelled as the agent's view), what happens next, cost implications.
4. The user's words field, prefilled with an editable phrase.
5. Actions mapped to CLIs (§8); destructive or spending actions show the exact command on hover.
6. Status line: waiting since, the hash the card is bound to, "stale: the file changed, reload" when it changes.

---

## 6. Data contracts (`src/types/console.ts`)

All schemas are Zod, versioned with `v: 1`, with tests that parse fixtures.

### 6.1 Journal event

```ts
ConsoleEvent = {
  v: 1;
  id: string;                 // ulid
  at: string;                 // ISO time
  project?: string;
  kind:
    | "cli.start" | "cli.end" | "cli.progress"
    | "agent.dispatch" | "agent.start" | "agent.end" | "agent.notification"
    | "decision.applied" | "decision.refused"
    | "control.changed" | "card.posted" | "card.answered"
    | "job.state";
  runId?: string;             // pairs cli.start/end; AGENTBROS_RUN_ID propagates to children
  parentRunId?: string;
  alias?: string;             // "film:approve"
  argv?: string[];            // redacted
  ok?: boolean; error?: string; message?: string; elapsedMs?: number;
  outputs?: string[];         // project-relative
  costUsd?: number;           // from metadata when the CLI reports it
  step?: string;              // from the lease when present
  agent?: { name?: string; role?: string; harness?: "claude-code" | "codex" | string; sessionId?: string };
  actor?: "agent" | "user" | "system";
  channel?: "cli" | "console" | "mcp" | "hook";
  data?: Record<string, unknown>; // kind-specific, ≤ 8 KB
};
```

Redaction: values of flags named like `key|token|secret|password|auth` are replaced by `"<redacted>"`; strings longer than 512 characters are truncated with their length and hash; `--answer` text is kept (it is the user's words and stays local).

### 6.2 Project view (read model)

```ts
ProjectView = {
  v: 1; revision: number; project: { id; route; filmType?; playbook?; format?; createdAt };
  control: { state: "running" | "paused" | "stopped"; by?; at?; reason? };
  autonomy: { mode: "interactive" | "autonomous"; ceilingUsd?; finalReviewOnly?; source: "film:policy" | "budget" | "none" };
  steps: { id; title; status; reasons: string[]; owner?; startedAt?; closedAt?; durationMs?; critic?: { round; score? } }[];
  current?: { step; next: { argv: string[]; why: string } };
  waiting: Decision[];        // derived from chain/footage state (FR2)
  agents: { active?: AgentRun; today: AgentRun[] };
  money: { ceilingUsd?; reservedUsd; spentUsd; unknownPriced: number; byProvider: {...}[]; jobs: JobSummary[] };
  media: { latestRender?: MediaRef; animatic?: MediaRef; composition?: { id; entry; durationInFrames; fps; width; height } };
  assets: AssetSummary[];     // provenance, licence, cost, usedIn
  qa: { findings: Finding[]; delivery?: { ok; checkedAt } };
  cards: Card[];
  advisories: string[]; stepGuard?: { violations: number; last? };
};
```

The projector reuses `deriveChain`, `decideNext`, the job store readers, `budget`, the asset registry and the memory reader; it adds nothing those modules do not already compute except durations and agent runs, which come from the journal.

### 6.3 Decision

```ts
Decision = {
  v: 1; id: string; project: string;
  kind: "gate" | "choice" | "quote" | "rating" | "frame-feedback" | "verdict" | "card-answer" | "control";
  step?: string; title: string;
  bindTo: { path: string; sha256: string }[];  // what the user saw
  options?: { id: string; label: string; argv: string[] }[];
  answer?: string;            // the user's words, verbatim
  choice?: string;
  status: "pending" | "applied" | "refused" | "superseded";
  createdAt: string; decidedAt?: string;
  result?: CliEnvelope;       // the spawned CLI's one JSON line
};
```

Pending decisions are computed; only decided ones are written to `pipeline/inbox/<id>.json`.

### 6.4 Card

```ts
Card = {
  v: 1; id: string; project: string; step?: string;
  from: { agent: string; role?: string };
  kind: "compare" | "grid" | "rating" | "choice" | "question" | "markdown" | "media";
  title: string; body?: string;             // markdown, sanitised, no HTML
  media?: MediaRef[];                        // project-relative paths only
  options?: { id: string; label: string }[];
  expectsAnswer: boolean; expiresAt?: string;
  answer?: { choice?: string; text?: string; at: string };
};
```

### 6.5 Control

`pipeline/session/control.json`: `{ v: 1, state, by: "user", channel, at, reason?, history: [...] }`.

---

## 7. Capture: how data arrives without agent effort

| Source               | Mechanism                                                                                                                                                  | Covers                                                                            |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Every CLI            | `runScript` writes `cli.start` and, before `emitResult`, `cli.end` (sync `appendFileSync`); `emitProgress` writes a throttled `cli.progress` (≤ 1 per 2 s) | Commands, timing, failures, outputs, cost, step                                   |
| Film chain dispatch  | `film:brief` writes `agent.dispatch` with role, step, team/variant, brief path                                                                             | Which agent was sent where, in every harness                                      |
| Harness hooks (§7.1) | `agentbros-hook.mjs` roles `observe` (and `surface`) in Claude Code and Codex                                                                              | Agent runs and durations by `agent_id`, failures, interruptions, permission waits |
| Job store            | `jobs/store.ts` writes `job.state` on each transition                                                                                                      | Paid job lifecycle                                                                |
| Files                | `fs.watch` on the project directory (debounced 250 ms, ignored: `downloads/`, caches)                                                                      | Everything the chain derives                                                      |
| Console              | Its own writes (`decision.*`, `control.changed`, `card.*`)                                                                                                 | User actions                                                                      |

The hook script and its installation are specified in §7.1.

Children inherit `AGENTBROS_RUN_ID` as `parentRunId`, so a `pnpm next` that spawns `film:status` nests correctly.

### 7.1 Harness hooks (decided 2026-11-17)

**Evidence (2026-11-17).** Claude Code: [hooks reference](https://code.claude.com/docs/en/hooks). Codex: [hooks](https://learn.chatgpt.com/docs/hooks), [config reference](https://learn.chatgpt.com/docs/config-file/config-reference), [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents). Users may already run global hooks from other tools (the maintainer's machine has an agent orchestrator's hooks on every event in both harnesses and a code-index hook on `UserPromptSubmit`); hooks from every layer run together, so ours must coexist and never assume they are alone.

|                   | Claude Code                                                                                                                                                                          | Codex                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| File we write     | `.claude/settings.local.json` (git-ignored, personal)                                                                                                                                | `.codex/hooks.json` (`.codex/` is git-ignored)                                                                                                   |
| Runs when         | After the workspace trust dialog (headless `-p` treats the folder as trusted)                                                                                                        | Project trusted, and each hook reviewed once in `/hooks` or the app's "Review hooks"; review is bound to the hook entry's hash                   |
| Events we use     | `SessionStart`, `UserPromptSubmit`, `PreToolUse` (`Bash`), `PostToolUse`, `PostToolUseFailure`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `Notification`, `SessionEnd` | `SessionStart`, `UserPromptSubmit`, `PreToolUse` (shell tool), `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `Interrupt`, `SessionEnd` |
| Subagent identity | `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`                                                                                                          | same fields                                                                                                                                      |
| Context injection | `additionalContext` (SessionStart, SubagentStart, UserPromptSubmit)                                                                                                                  | `additionalContext` (same three)                                                                                                                 |
| Background        | `async: true`; `asyncRewake: true` wakes Claude when the hook exits 2                                                                                                                | `async: true` (cannot block)                                                                                                                     |
| `notify`          | —                                                                                                                                                                                    | Not used (turn-complete only, user-level only)                                                                                                   |

#### Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H1  | **One entry point:** `node scripts/hooks/agentbros-hook.mjs <harness> <role>`. Plain Node, no dependencies, ESM, reads one JSON object on stdin, normalises both harnesses' payloads through a versioned adapter (`scripts/hooks/lib/payload.mjs`) with recorded fixtures from each harness; unknown fields are ignored, missing fields degrade the role to a no-op. `claude-step-guard.mjs` becomes a thin shim over the `guard` role for one release, then is removed.                                                                                                                                                                                                                                                                                                    |
| H2  | **Installed by `harness:setup`, never tracked.** `pnpm harness:setup --hooks` prints the exact entries it would add or change in `.claude/settings.local.json` and `.codex/hooks.json`; `--hooks --apply` writes them. Merge is surgical: our entries are recognised by the command containing `scripts/hooks/agentbros-hook.mjs`; every other key and hook (the user's, other tools') is preserved byte-for-byte in meaning; the previous file is kept as `<file>.agentbros-backup`; repeated runs are idempotent. `--hooks --remove` deletes only our entries. Commands are relative (`node scripts/hooks/agentbros-hook.mjs …`; Claude Code uses `"$CLAUDE_PROJECT_DIR"/scripts/…`, Codex runs hooks in the session's working directory), so no machine path is written. |
| H3  | **Agents ask before installing.** Changing harness settings is the user's decision: an agent may run the plan (`--hooks`) and show it, and applies it only after the user's yes, like any overwrite. `pnpm next` reports `hooks: { claude: installed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | missing | stale, codex: … }`once per session and the console's Settings shows the same with an Install button that runs the same command. After install the user is told the one trust step per harness (Claude Code workspace trust; Codex`/hooks` review). Entries never change between releases, so the Codex review is needed once; behaviour changes live in the script. |
| H4  | **Fail open.** Any internal error, timeout risk, missing project or unknown payload exits 0 with no output. Only the `guard` role may deny, and only with an explicit lease or pause verdict and its reason. No role exits 2 or returns `decision: "block"` except `guard` on `PreToolUse`; no role ever blocks `Stop` or `SubagentStop`, so a hook can never trap an agent or a subagent in a loop.                                                                                                                                                                                                                                                                                                                                                                        |
| H5  | **Bounded cost.** Per-entry timeouts: `guard` 5 s, `orient`/`relay` 3 s, everything else `async`. Observe work is a single `appendFileSync` of one line ≤ 8 KB. `PreToolUse` and `PostToolUse` match only the shell tool (`Bash` in Claude Code; the Codex shell tool name is pinned from a fixture in WP-H) and `Agent` for subagent links; file reads, edits and searches never start our hook.                                                                                                                                                                                                                                                                                                                                                                           |
| H6  | **Scope.** A hook acts only when the session's `cwd` is inside this checkout and a project resolves (the `--project` of the command, else the newest lease written in this session, else `AGENTBROS_PROJECT`); otherwise it does nothing. It writes only `public/projects/<id>/pipeline/events.jsonl` and `out/console/hooks/<session>.json` (cursor state). It reads no secrets, opens no network connection and prints no file contents.                                                                                                                                                                                                                                                                                                                                  |
| H7  | **Context hygiene.** Injected text is facts, never instructions, at most 1,200 characters, in English, prefixed `Agent Bros. console:`. `orient` injects only when the facts changed since the session's last injection; `relay` only when there are new console items after the session's cursor. Subagents receive `orient` only when `agent_type` is one of the repository's own agents (`.agents/agents/*.md` names); built-in and third-party agents (`Explore`, `general-purpose`, plugin agents) receive nothing.                                                                                                                                                                                                                                                    |
| H8  | **Kill switches.** `AGENTBROS_HOOKS=off` disables every role; `AGENTBROS_HOOKS=observe` keeps only `observe`; benchmark runs set `observe`. `AGENTBROS_STEP_GUARD` keeps its meaning for `guard`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| H9  | **Console and `console:wait` stay harness-neutral.** Hooks enrich; with no hooks installed every console feature still works through the journal, `pnpm next` and `console:wait`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

#### Roles

| Role      | Events                                                                                                       | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Ships in                                    |
| --------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `observe` | SessionStart/End, SubagentStart/Stop, PostToolUse(`Agent`), PostToolUseFailure, StopFailure, Interrupt, Stop | One journal line each (`agent.start`, `agent.end` with duration, failures, interruptions, session start/end), joined by `agent_id`; the parent `Agent` call links child to parent                                                                                                                                                                                                                                                                                                                                                            | M1                                          |
| `guard`   | PreToolUse (shell)                                                                                           | The step-lease guard for both harnesses (today Claude Code only) plus the `PAUSED` check, so a command in a paused project is refused before it starts; same modes and reasons as `runScript`, which stays the authority                                                                                                                                                                                                                                                                                                                     | M1                                          |
| `orient`  | SessionStart (all sources incl. `compact`, `resume`), SubagentStart (own agents)                             | Fact block: project, route, current step and owner, waiting decisions, pause state, console URL; for an own subagent, its lease (step, allowed commands, paid authority)                                                                                                                                                                                                                                                                                                                                                                     | M1                                          |
| `relay`   | UserPromptSubmit                                                                                             | Console decisions, card answers and control changes since the session's cursor, with the user's words and decision ids; in Codex this is how a console decision reaches the agent on the user's next message                                                                                                                                                                                                                                                                                                                                 | M2                                          |
| `surface` | Notification (`permission_prompt`, `idle_prompt`), PostToolUseFailure, StopFailure, Interrupt                | Console banner and macOS notification (D23): "the agent waits for permission in the terminal", failures, interruptions                                                                                                                                                                                                                                                                                                                                                                                                                       | M2                                          |
| `wake`    | Stop (Claude Code only)                                                                                      | When a decision or card is waiting for the user, an `async` + `asyncRewake` entry runs `agentbros-hook.mjs claude wake`, which waits up to 30 min (configurable) for a console decision on that project and exits 2 with a one-line fact ("User approved script in console: '…'") so Claude resumes; it exits 0 silently on timeout, on `stop_hook_active`, or when the session ended. Complements `console:wait`, which stays the documented, harness-neutral path; the orchestrator does not start `console:wait` when `wake` is installed | M2, enabled by default after the WP-H trial |

#### Tests

Payload fixtures recorded from both harnesses for every event used; adapter tests for each; fail-open tests (malformed JSON, missing fields, unreadable lease, full disk, slow filesystem) asserting exit 0 and empty stdout; guard parity tests against `runScript`'s verdicts; installer tests (merge into files that contain other tools' hooks, idempotence, backup, remove-only-ours, no absolute paths); context-size and dedupe tests; a subagent test that built-in agent types get no injection; `wake` tests for decision, timeout and `stop_hook_active`; a timing benchmark (warn above 150 ms for synchronous roles). Manual acceptance on a real Claude Code and Codex session is recorded in WP-H.

## 8. Decisions and control: flows and CLI mapping

| User action                            | CLI the server spawns                                                                                                                                                     | Notes                                                                                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Approve a film gate                    | `film:approve --project P --step S --answer "<words>" --expect <hash>`                                                                                                    | Lease becomes stale; next `pnpm next` advances                                                                                                                                           |
| Reject / ask for changes               | `feedback --project P --step S …` with the words; then the chain's own revise path                                                                                        | Exact flags fixed in WP5 from `feedback`'s contract                                                                                                                                      |
| Choose idea / script                   | The step's selection command (`creative:rank` record or `film:approve` with the choice), per chain step data                                                              | Mapping table in `src/lib/console/actions.ts`, tested per step                                                                                                                           |
| Approve a paid quote                   | `film:approve` on `material` / `narration` (film); `budget --ceiling-usd --answer` (footage)                                                                              | Shows amount and budget after (FR4)                                                                                                                                                      |
| Rate a reference or styleframe         | `ref:rate` (new, WP9) writing `pipeline/ratings.json`; `memory --add --type preference` when a note is given                                                              | Ratings are inputs to `look`: the look owner's brief lists the latest rating per styleframe, untracked so no step reopens; the critic never sees them, to keep its judgement independent |
| Frame feedback                         | `feedback --project P --frame N [--region x,y,w,h] --answer "<words>"` (frame/region flags added in WP9 if missing)                                                       | Fixer reads it next round                                                                                                                                                                |
| Final verdict                          | `film:approve --step human --answer "<words>"` plus `memory --add --type decision --quote "<words>"` with the score and axis scores; frame comments as `feedback` entries | D24; triggers the postmortem hint                                                                                                                                                        |
| Cancel a running paid job (after Stop) | The job store's cancel path for that provider, one job at a time                                                                                                          | D12; unavailable cancellation shown, never faked                                                                                                                                         |
| Pause / resume / stop                  | `console:control --project P --state paused --answer "<words>"` (new)                                                                                                     | Writes `control.json`; `runScript` refuses with `PAUSED`                                                                                                                                 |
| Autonomy                               | `film:policy --project P --autonomy … --answer "<words>" [--ceiling-usd …]`                                                                                               | Never more than the CLI allows                                                                                                                                                           |
| Skip a skippable step                  | `film:done --project P --step S --skip "<the user's reason>"`                                                                                                             | Only steps marked `skippable`                                                                                                                                                            |
| One more critic round                  | The critic step's re-open path (`film:revert` to the critic step)                                                                                                         | Confirms the cost of a round                                                                                                                                                             |
| Answer an agent card                   | Written to the card file; emits `card.answered`                                                                                                                           | `console:wait` returns it                                                                                                                                                                |

Flow at a gate (Claude Code):

```
orchestrator: pnpm next → gate "script" waiting; answer.console.url
orchestrator: opens URL once; runs `pnpm console:wait --project P` in background; ends turn with one line
user: reads scripts in console, writes "B, but shorter hook", clicks Approve
server: spawns film:approve … --answer "B, but shorter hook" → ok → decision.applied
console:wait: exits {ok, metadata:{event:"decision.applied", step:"script", answer:"B, but shorter hook"}}
harness: re-invokes orchestrator → pnpm next → next step, with the user's words in its context
```

In Codex the same happens without the background wake: the user returns to the chat with any message, or Annotate on the page.

---

## 9. Server and commands

### 9.1 Endpoints

| Method | Path                                         | Purpose                                     |
| ------ | -------------------------------------------- | ------------------------------------------- |
| GET    | `/api/projects`                              | Home: summaries                             |
| GET    | `/api/projects/:id/view`                     | `ProjectView`                               |
| GET    | `/api/projects/:id/events?since=<id>&limit=` | Journal page                                |
| GET    | `/api/stream?project=:id`                    | SSE: `view.changed {revision}`, `event {…}` |
| GET    | `/media/:id/*path`                           | Range-served project media, confined        |
| GET    | `/thumb/:id/*path?t=&w=`                     | Cached frame/thumbnail (ffmpeg)             |
| POST   | `/api/projects/:id/decisions`                | Apply a decision (D9)                       |
| POST   | `/api/projects/:id/control`                  | Pause / resume / stop                       |
| POST   | `/api/projects/:id/cards/:cardId/answer`     | Answer a card                               |

### 9.2 Commands (all follow the CLI JSON contract)

| Command                                                   | What                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm console [--project P] [--port N] [--open] [--stop]` | Start or reuse the server (normally started by `pnpm next`, D16); prints `{ok, metadata:{url, port, reused}}`; `--stop` stops it; the server exits after 12 h without requests |
| `pnpm console:wait --project P [--timeout-min M]`         | Block until a decision, control change or card answer; one JSON line                                                                                                           |
| `pnpm console:card --project P --kind K --data F`         | Post a card                                                                                                                                                                    |
| `pnpm console:control --project P --state paused          | running                                                                                                                                                                        | stopped --answer "<words>"` | Control from CLI too |
| `pnpm console:build`                                      | Build the bundle (also done on demand)                                                                                                                                         |
| `pnpm console:snapshot --project P`                       | Static HTML snapshot (P2)                                                                                                                                                      |

`pnpm next`, `film:next`, `footage:next` and `film:init` start the server when none is running (D16) and add `console: { url?, error?, pending: n, appliedSince: Decision[] }` to their answer; the next-step `read` list never requires the console.

---

## 10. Design system and UI build

### 10.1 Tokens and look

- Colours, type and radii from `src/lib/design-tokens.ts` mapped to shadcn CSS variables (`--background`, `--foreground`, `--primary`, `--muted`, `--accent`, `--destructive`, `--ring`, chart colours). Dark is the default ("studio"), light available.
- Type: the brand display face for headings and numbers, a neutral sans for UI text, a mono for hashes and commands; all bundled locally.
- Density: comfortable on the home, compact on the canvas; 8 px grid; cards with 12–16 px radius.
- Motion: CSS transitions in the UI only (150–250 ms, standard ease); respects `prefers-reduced-motion`. The determinism law does not apply to `apps/console/`, and `apps/console/` is never imported from `src/`.
- Status colours: done, current, blocked, stale, skipped, invalid, paused; each also with an icon (colour is never the only signal).

### 10.2 Component inventory and source

| Component                                                                                                                   | Source                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| App shell, sidebar, top bar, dialog, sheet, tabs, tooltip, dropdown, command palette, toast, table, form controls, skeleton | shadcn/ui                                                                                                    |
| Step rail (horizontal and vertical stepper with statuses)                                                                   | uiarc free stepper as reference, rewritten on shadcn; affectUI progress tracker for the compact project card |
| Metric card, usage meter (budget)                                                                                           | uiarc free, rewritten                                                                                        |
| Charts (spend over time, time per step)                                                                                     | shadcn charts                                                                                                |
| Decision card and "Waiting for you" inbox                                                                                   | affectUI decision inbox, rewritten (user's words field, bound hash, cost line added)                         |
| Agent activity (command cards with status, duration, args and result; grouped per step), "agent is working" indicator       | affectUI tool-call card and group, thinking loader, rewritten                                                |
| Event feed and history timeline                                                                                             | uiarc free timeline, rewritten                                                                               |
| Asset grid, lightbox                                                                                                        | own, on shadcn primitives                                                                                    |
| Video viewer (render playback, frame stepping, frame strip, region comment)                                                 | own, on the native media element                                                                             |
| Waveform, cue markers                                                                                                       | own canvas component (or wavesurfer.js after licence check)                                                  |
| Frame strip with region comment                                                                                             | own                                                                                                          |
| Empty states                                                                                                                | uiarc free pattern                                                                                           |
| Notifications in the page                                                                                                   | affectUI notification stack, rewritten                                                                       |
| Rating (references, styleframes, verdict axes)                                                                              | affectUI rating (stars, thumbs), rewritten                                                                   |

Rules: every borrowed file is copied through the shadcn CLI or by hand into `apps/console/components/`, restyled onto tokens, and credited; `pnpm deps:licences --check` and `credits:write-doc` stay green; no runtime dependency on a collection.

### 10.3 Bake-off (done 2026-11-17)

The same film data was rendered with the free components of uiarc, affectUI and beautifului, unmodified, in dark and light themes (a scratch Vite bench, not tracked). Findings: affectUI is the most coherent and closest to the studio look and covers decisions, agent activity, notifications and rating, with English strings and styles inside each file; uiarc is restrained and covers money and the event feed, its horizontal stepper labels collide in a narrow pane; beautifului's published foundation CSS fails to parse (a lost `@media` header), it needs extra packages and covers least. The maintainer chose shadcn + affectUI + uiarc (D5).

## 11. Harness integration and instructions

- Root `AGENTS.md`: one line under "Start here" step 3: the next-step answer starts the console and carries `console.url`; open it once beside the chat; at a gate in Claude Code, run `console:wait` in the background instead of polling.
- `pnpm next` answers carry the console block (§9.2); the orchestrator skill (`creative-studio`) and `recording-recut` mention it in one sentence each.
- Hooks (§7.1): `harness:setup --hooks` plans and, after the user's yes, `--hooks --apply` installs them for Claude Code and Codex; `pnpm next` and the console Settings report their status per harness.
- Leaf agents do nothing new. Optional: a leaf agent may post a card with `console:card` when its brief asks it to show a comparison; briefs name it only where useful (critic endings, stock candidates, reference picks).
- `.claude/` is unchanged except the hook entry `harness:setup` writes into the user's settings.

---

## 12. Quality impact and metrics

How the console improves the final film:

1. **Better decisions:** material and agent rationale beside every gate; blind pools shown blind; quotes with consequences.
2. **Earlier corrections:** animatic and per-scene frames are visible while the build runs; frame-anchored feedback reaches the fixer precisely.
3. **Preferences captured:** ratings and verdicts land in memory automatically with the user's words, so the next film starts closer.
4. **Less waste:** pause before a bad paid call; spend on rejected work becomes visible.
5. **System learning:** repeated rejections at a step show up in metrics and feed `creative-postmortem`.

Metrics (local, derived from the journal and files; shown in Settings → Metrics and written to `out/console/metrics.json`):

| Metric                 | Definition                                             |
| ---------------------- | ------------------------------------------------------ |
| Time to decision       | Gate became `ready` → `decision.applied` (median, p90) |
| Console decision share | Decisions with `channel: console` / all user decisions |
| Rework rate            | Steps reopened after a user rejection / gates decided  |
| Wasted spend           | Spend on outputs later superseded by a user rejection  |
| Agent time per step    | Sum of agent runs per step (from hooks and dispatches) |
| Verdict capture        | Delivered films with a recorded final verdict          |
| Final score            | The user's 1–10 on the verdict card, per playbook      |

Targets for M3 on the maintainer's own films: time to decision −50 %, verdict capture 100 %, console decision share ≥ 80 % in interactive mode.

---

## 13. Testing strategy

| Layer           | Tests (node:test unless noted)                                                                                                                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Schemas         | Fixtures parse; unknown fields rejected where the schema is strict                                                                                                                                                                           |
| Journal         | `cli.start`/`cli.end` written for success, `CliErrorObject`, unknown error and `BUDGET_EXCEEDED`; written before exit; redaction; rotation; `AGENTBROS_EVENTS=off`; write failure never fails the command; under 2 ms (benchmark, warn only) |
| Hooks           | §7.1 tests: payload fixtures from both harnesses, fail-open, guard parity, installer merge/idempotence/remove, context size and dedupe, subagent scoping, `wake`, timing                                                                     |
| Projector       | Fixture projects for each route and each chain status (reuse `tests/film-chain` fixtures): waiting decisions derived from state; durations from journal; revision increments on change                                                       |
| Actions         | Mapping table: every action yields the exact argv; refused CLI → `decision.refused` with the envelope; `--expect` stale hash refused                                                                                                         |
| Control         | `PAUSED` refusal for non-control aliases; control aliases still run; resume; stop with running jobs asks                                                                                                                                     |
| Server security | Loopback bind; Host check; token and cookie; CSRF header required on POST; path traversal (`..`, symlinks, absolute) refused; no secret strings in any response (grep test over responses with a fake `.env`)                                |
| `console:wait`  | Exits on decision, control and card answer; timeout envelope; two waiters                                                                                                                                                                    |
| UI units        | Vitest + Testing Library for panels with fixture views                                                                                                                                                                                       |
| UI end-to-end   | Playwright (headless Chromium) against a fixture project: approve a gate, answer a card, pause; screenshots at 1280 and 390 px, dark and light, stored in `out/qa/console/` (not tracked)                                                    |
| Accessibility   | axe in the Playwright run; no serious violations                                                                                                                                                                                             |
| Contract        | `pnpm check` green; `repo:hygiene --check`; `deps:licences --check`                                                                                                                                                                          |

---

## 14. Acceptance criteria

### M1: Observe (read-only)

- A1. `pnpm next` on a fixture film starts the server when none runs and returns `console.url`; a second call reuses it; `AGENTBROS_CONSOLE=off` starts nothing; a failed start leaves `pnpm next` successful with `console.error`. The Claude Code desktop preview and the Codex in-app browser open the URL and reload it after a server restart without a new token. **Status:** Verified: `console-next`, `console-server-process`, `console-pairing`, Playwright `session` (a fresh browser reaches the canvas through a one-use pairing link; a reload keeps the session). Pending manual: the Claude Code preview pane and the Codex in-app browser.
- A2. Home lists every project with route, step, waiting count and spend. **Status:** Verified: `console-projector`, Playwright `smoke`.
- A3. A fixture film shows the chain, reasons, money, assets and the latest animatic or render with a frame strip; a file change appears within 1 s. **Status:** Verified: `console-projector`, `console-server-stream` (watch, revisions), Playwright `media`, `film-panels`.
- A4. Every CLI run with `--project` appears in History with timing and result; with hooks installed, subagent runs appear with duration in both Claude Code and Codex. **Status:** Verified: `console-journal`, `console-hooks` (synthetic payloads for both harnesses). Pending manual: subagent runs in live sessions.
- A4b. `harness:setup --hooks` shows the plan; `--apply` merges our entries into files that already hold other tools' hooks without changing them; `--remove` restores them; a malformed payload, a missing project and `AGENTBROS_HOOKS=off` all leave the agent and its subagents unaffected; a paused project refuses a shell command at `PreToolUse` with the reason. **Status:** Verified: `console-hooks-install`, `console-hooks-guard`, `console-hooks`.
- A5. The UI switches between English, Russian and Chinese; the dictionary test finds no missing key. **Status:** Verified: `apps/console/i18n/i18n.test.ts`.

### M2: Film, decide and control (first usable release)

- A6. A fixture film's `script` gate is approved in the console with the prefilled phrase; `film:approve` ran with exactly that text, `channel: console` and `--expect`; `pnpm next` advances; History shows it. **Status:** Verified: `console-actions-e2e`, `console-actions`.
- A7. In Claude Code, an orchestrator waiting with `console:wait` is re-invoked by the approval and continues without a chat message. **Status:** Verified with fixtures: `console-wait`. Pending manual: a live Claude Code re-invocation.
- A8. A narration quote is approved in the console; spend happens only through the agent's CLI under normal admission. **Status:** Verified: `console-actions-quote-e2e` (narration and material quotes approved through the console endpoint; a quote whose files or money changed is refused), `console-actions`.
- A9. Pause makes the next non-control CLI fail with `PAUSED` while a submitted fixture job completes and keeps its result; Stop lists running jobs and cancels one only on the user's per-job confirmation; resume restores work. **Status:** Verified: `console-control`, `console-control-cancel`, `console-guards`, `console-gaps-ui` (cancel reason), Playwright `gaps`, `gaps-server` (stop lists paid jobs, cancels one on its own confirmation).
- A10. Autonomy and budget ceiling change in the console within CLI limits. **Status:** Verified: `console-gaps-ui` (policy decision: dry run, request id, `film:policy` and `budget` end to end), Playwright `gaps`, `gaps-server` (a raise confirmed with the command and amounts).
- A11. Agent cards (`compare`, `grid`, `question`) round-trip through `console:wait`. **Status:** Verified: `console-cards`, `console-cards-cli`, `console-cards-mcp`, `console-wait`.
- A12b. In Codex, a console decision reaches the agent as context on the user's next message (`relay`); in Claude Code, a waiting session resumes after a console decision through `wake` without `console:wait`. **Status:** Verified with fixtures: `console-hooks` (relay), `console-hooks-wake`. Pending manual: live Codex and Claude Code sessions.
- A12. With notifications enabled, a waiting decision, a failed current-step command and a finished render each produce one macOS notification; clicking opens the card; nothing is sent while the console tab is focused. **Status:** Verified with a fake sender: `console-notify`. Pending manual: macOS display and click-through.
- A13. The final verdict (score, axes, texts, a frame comment) is recorded through `film:approve --step human`, memory and feedback, and appears in metrics. **Status:** Verified: `console-actions` (verdict follow-ups, `partial`), `console-metrics`, Playwright `film-panels`.
- A14. Security tests pass; Playwright and axe green; `pnpm check` green. **Status:** Verified: `console-server-security`, `console-server-hardening`, Playwright with axe and the strict-CSP run. Pending: the full `pnpm check` on the integration branch before merge.

### M3: Platform

- A15. The footage route shows transcript, recut plan, shorts and renders, and approves its edit hash. **Status:** Verified: `console-footage` (edit-hash approval with grant and intent), Playwright `footage-panels`.
- A16. Pools (ideas, scripts) and styleframes can be chosen and rated; ratings reach `pipeline/ratings.json` and memory. **Status:** Verified: `ref-rate`, `console-user-actions`, Playwright `ratings`.
- A17. Frame and region feedback reaches the fixer's next round. **Status:** Verified: `feedback`, `console-user-actions`.
- A18. **`review:ui` parity** (a maintainer checklist, not published; [local review](../local-review-ui.md) describes the result, 101 rows in 15 areas, 20 security and session behaviours): every feature on the parity checklist (timeline move/trim/split/ripple/replace/rate/captions/transition/batch, authored copy, visual split/slip/reframe/remove, group move, audio position/trim/gain/loop, snapshots and take choice, assets and entity board, budget, visualisations, QA evidence, chapters, realtime channel) works in the console against the unchanged server services; the existing review-ui service tests pass; the HTML-string client is removed and `pnpm review:ui` opens the console timeline view. **Status:** Verified: WP13f; `review-ui-console`, `review-ui`, `console-review-host*`, `console-review-campaign`, Playwright `timeline-edit`, `timeline-review`, `timeline-realtime`, `campaign`; parity plan complete.
- A19. Metrics page populated from a real film. **Status:** Verified on fixtures: `console-metrics`, `console-metrics-film` (wasted spend), `console-server-metrics`. Pending manual: a real film.

### M4: Extensions (P2)

- A20. Snapshot export; campaign, replica and recipe canvases; library; optional Claude Code status-line mod. **Status:** Verified: `console-snapshot`, `console-route-material`, `console-library`, `console-statusline`, Playwright `routes`.

---

## 15. Development plan

### 15.1 Milestones

| Milestone                   | Work packages                                                 | Outcome                                                                                                         |
| --------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| M0 Foundations              | WP0, WP1                                                      | Contracts frozen, bake-off and hook verification done, journal in place                                         |
| M1 Observe                  | WP2, WP3, WP4, WP6, WP7a, WP-H (observe, guard, orient)       | Auto-started read-only console in three languages: live chain, money, assets, renders                           |
| M2 Film: decide and control | WP5, WP7b, WP8, WP10, WP11, WP14, WP-H (relay, surface, wake) | First usable release on bespoke films: gates, quotes, pause/stop, autonomy, agent cards, notifications, verdict |
| M3 Platform                 | WP9, WP12, WP13                                               | Footage canvas, ratings, frame feedback, `review:ui` replaced, metrics                                          |
| M4 Extensions               | WP15                                                          | Snapshot, more routes, library, status-line mod                                                                 |

### 15.2 Work packages

Each WP owns its files; another WP changes them only through the owner. "Contract" means `src/types/console.ts`, frozen at the end of WP0 and changed only by an RFC amendment line in §17.

| WP       | Title                             | Owns                                                                                                                                                                                                    | Depends on                                             | Deliverables                                                                                                                                                                            | Tests / acceptance                                                         |
| -------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **WP0**  | Contracts, bake-off, verification | `src/types/console.ts`, §17 of this RFC                                                                                                                                                                 | —                                                      | Schemas with fixtures; component bake-off (D5); verified hook events for Claude Code and Codex with evidence; dependency licence check of D3's list; `review:ui` parity checklist (A18) | Schema tests; notes in §17                                                 |
| **WP1**  | Event journal                     | `src/lib/cli/` (journal hook only), `src/lib/console/journal.ts`, `film:brief` dispatch event, `jobs/store.ts` transition event                                                                         | WP0                                                    | `cli.*`, `agent.dispatch`, `job.state` events; redaction; rotation; env switch                                                                                                          | Journal tests (§13)                                                        |
| **WP-H** | Harness hooks                     | `scripts/hooks/agentbros-hook.mjs`, `scripts/hooks/lib/`, hook fixtures, the `--hooks` mode of `harness:setup` (`src/lib/harness/`), hook status in `pnpm next`; `claude-step-guard.mjs` becomes a shim | WP0, WP1 (journal writer), WP8 (`PAUSED`, for `guard`) | §7.1 roles in two stages (M1: observe, guard, orient; M2: relay, surface, wake); installer; docs in `docs/harnesses.md` and `docs/step-lease.md`                                        | §7.1 tests; A4, A4b, A12b                                                  |
| **WP2**  | Local server core                 | `src/lib/local-server/` (extracted from `review:ui`), `src/lib/console/server.ts`, `scripts/console.ts`                                                                                                 | WP0                                                    | Server, lock/reuse, detached start, token/cookie/Host/CSRF, media range, thumbnails, SSE                                                                                                | Security tests; `review:ui` tests still green                              |
| **WP3**  | Projector                         | `src/lib/console/view/`                                                                                                                                                                                 | WP0, WP1                                               | `ProjectView` for film and footage; home summaries; revisions; watch                                                                                                                    | Projector fixture tests                                                    |
| **WP4**  | UI shell, design system, i18n     | `apps/console/` (shell, tokens, components/, i18n/), Vite config, `console:build`                                                                                                                       | WP0                                                    | Shell, home, project canvas frame, panel registry, step rail, decision card, metric cards, dark/light, EN/RU/ZH dictionaries                                                            | Vitest units; dictionary test; Playwright screenshots                      |
| **WP6**  | Media viewer                      | `apps/console/media/`, thumbnail endpoint use                                                                                                                                                           | WP4, WP2                                               | Render playback, frame stepping, frame strip, region selection, "Open in Remotion Studio"                                                                                               | Playwright: plays, seeks, steps                                            |
| **WP7a** | Auto-start and next block         | console block and detached start in `next`/`film:next`/`footage:next`/`film:init`                                                                                                                       | WP2                                                    | D16 behaviour; `console.url`/`console.error`                                                                                                                                            | A1                                                                         |
| **WP5**  | Decisions and actions             | `src/lib/console/actions.ts`, `src/lib/console/inbox.ts`, POST endpoints                                                                                                                                | WP2, WP3                                               | Action mapping for film gates, choices, quotes, verdict; apply via CLI; refusal display; history                                                                                        | Action tests; A6, A8, A13                                                  |
| **WP7b** | Wake                              | `scripts/console-wait.ts`, root `AGENTS.md` line, skill sentences                                                                                                                                       | WP5                                                    | `console:wait`; `appliedSince` in the next block                                                                                                                                        | Wait tests; A7                                                             |
| **WP8**  | Control                           | `scripts/console-control.ts`, `control.json`, `PAUSED` in `src/lib/cli/types.ts` and the root contract, stop's per-job cancel, autonomy/budget forms                                                    | WP5                                                    | D12, D13                                                                                                                                                                                | Control tests; A9, A10                                                     |
| **WP10** | Film panels                       | `apps/console/panels/film/`                                                                                                                                                                             | WP4, WP3, WP6                                          | Panels of §5.2 for every film step, verdict card (D24)                                                                                                                                  | Fixture snapshots per step                                                 |
| **WP11** | Agent cards                       | `scripts/console-card.ts`, card store, card panels, MCP `console_card`                                                                                                                                  | WP4, WP5                                               | Seven card kinds; answers through wait                                                                                                                                                  | A11                                                                        |
| **WP14** | Notifications                     | `src/lib/console/notify.ts`, helper in `scripts/workers/` if chosen, Settings toggles                                                                                                                   | WP2, WP5                                               | D23                                                                                                                                                                                     | Notification tests with a fake sender; manual check on macOS recorded; A12 |
| **WP9**  | Ratings and frame feedback        | `ref:rate` CLI, `feedback` frame/region flags if missing, ratings panel                                                                                                                                 | WP5, WP6                                               | Ratings file and memory entries; frame comments to fixer                                                                                                                                | A16, A17                                                                   |
| **WP12** | Footage panels and metrics        | `apps/console/panels/footage/`, `src/lib/console/metrics.ts`                                                                                                                                            | WP4, WP3                                               | Footage canvas; metrics page                                                                                                                                                            | A15, A19                                                                   |
| **WP13** | Replace `review:ui`               | `apps/console/views/timeline/` and the other review views; `src/lib/review-ui/client*.ts` (removed); `scripts/review-ui.ts` (alias)                                                                     | WP2, WP4, WP6                                          | Parity checklist feature by feature, then removal of the old client; `docs/local-review-ui.md` rewritten                                                                                | Existing review-ui service tests; Playwright per parity item; A18          |
| **WP15** | Snapshot, routes, library         | `console:snapshot`, campaign/replica/recipe canvases, library, status-line mod                                                                                                                          | WP10                                                   | P2 stories                                                                                                                                                                              | A20                                                                        |
| **WP16** | Docs and harness wiring           | `docs/console.md`, `docs/architecture.md`, area `AGENTS.md` files, `harness:setup` hook install, `.changes/` entries                                                                                    | each milestone                                         | Guide per milestone; hook install and status                                                                                                                                            | `pnpm check`; docs links                                                   |

### 15.3 Parallel lanes

```
WP0 ──┬─ WP1 ─── WP3 ─┬─ WP5 ─┬─ WP7b
      │               │       ├─ WP8
      ├─ WP2 ─┬─ WP7a │       ├─ WP11
      │       └───────┤       ├─ WP14
      └─ WP4 ─── WP6 ─┼─ WP10 └─ WP9 (M3)
                      ├─ WP12 (M3)
                      └─ WP13 (M3, may start its views in M2 against fixtures)
WP15 after M3; WP16 at the end of each milestone
```

After WP0, four lanes run at once: journal (WP1), server (WP2), UI shell (WP4), then the projector (WP3) once WP1 lands. The UI lane works against fixture `ProjectView` JSON until WP3 serves real data. WP13 is the largest package; it starts as soon as WP4 and WP6 give it the shell and the media viewer, and it merges feature by feature behind the parity checklist so the old client keeps working until the last item passes.

### 15.4 Process

1. **Branch per WP** (`feat/console-wpN-<slug>`), worktree per parallel agent (`isolation: worktree`), small PRs merged in dependency order.
2. **Brief** each implementing agent with the template below; one WP per agent; leaf agents do not spawn agents.
3. **Review**: the `reviewer` agent on every WP diff; `test-runner` before merge; security-sensitive WPs (WP2, WP5, WP8) get a second independent review.
4. **Definition of done** for every WP: tests from §13 for its scope; `pnpm check` green; area `AGENTS.md` updated with date; `.changes/` entry; credits and licences updated for any borrowed code; this RFC's §17 log line ("WPn landed, deviations: …").
5. **Milestone demo**: each milestone ends with a recorded run on a fixture project and, from M2, on one real film; the maintainer accepts against §14.
6. **Status line**: this RFC's `Status:` is updated at each milestone.

### 15.5 Subagent brief template

```
You implement WP<n> of docs/rfcs/0004-studio-console.md: <title>.
Read: the RFC sections <list>, AGENTS.md of <areas>, src/types/console.ts.
You own: <paths>. Do not edit other paths; if you must, stop and report.
Contract: src/types/console.ts is frozen; propose changes in your report, do not make them.
Deliver: <deliverables>. Tests: <tests from §13>. Run: pnpm test:fast, then pnpm check.
Report: what landed, test output summary, deviations from the RFC, open questions.
```

---

### 15.6 Findings from the `review:ui` inventory (2026-11-17)

- The console server replaces the review server's HTTP shell (`/`, `/app.js`, `/style.css`, strict CSP, exact Content-Type checks); WP13 keeps `ReviewService`, `RealtimeReviewService`, `RealtimeReviewChannels`, the campaign review server and every action module, and carries over all 20 security and session behaviours (loopback, token, `/file`-only cookie, Host and Origin checks, 64 KiB bodies, `/file` allowlist, WebSocket ticket admission).
- Tests that evaluate the `REVIEW_JS` / `CHAPTER_REVIEW_JS` strings run by default and break on any rewrite; WP13 re-points them at the console (the checklist's Appendix A lists the element IDs and texts they rely on). 18 behaviours are untested today, among them the CSP and security headers; WP13 adds tests for them before the swap.
- Existing defects to fix, not port: Ctrl+C closes the HTTP server without closing the realtime channels; the split form defaults its cut to the clip start, which the server always refuses; a hand-edited prepared proposal is applied after only the generic dry-run, skipping the operation's own checks.
- The campaign review server differs (token fragment `#<token>`, no `img-src` in its CSP) and is migrated in the same package.

## 16. Risks and open questions

| Risk / question                                                                | Mitigation                                                                                                                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The console drifts into a second truth                                         | Principle 1; FR2; projector tests compare with `film:status` output                                                                                                              |
| A click is treated as weaker than typed words                                  | D10: editable phrase, verbatim storage, `channel: console`; the maintainer confirms D10 in WP0                                                                                   |
| Journal write slows every CLI or breaks on a full disk                         | Sync append of one short line; errors swallowed; benchmark; env switch                                                                                                           |
| Hooks differ between harness versions or break an agent                        | Versioned payload adapter with fixtures; fail-open (H4); no Stop blocking; scoped to this checkout and own agents (H6, H7); kill switches (H8); hooks only enrich (H9)           |
| Codex cannot be woken by the console                                           | Documented; `pnpm next` shows decisions on the next message; Annotate as a second channel                                                                                        |
| `PAUSED` interacts with the step lease                                         | Control aliases stay admitted; tests for both guards together                                                                                                                    |
| Replacing `review:ui` breaks tested timeline editing                           | WP13 keeps every server-side service unchanged, ports views behind a parity checklist, keeps the old client until the last item passes, and keeps the review-ui service tests    |
| Renders lag behind code, so the console may show an older picture              | Every media item shows its render time and the source hash it was rendered from, with "stale" when the composition changed since; "Open in Remotion Studio" for the live picture |
| Auto-start leaves a server running                                             | Lock file, reuse, `AGENTBROS_CONSOLE=off`, idle shutdown after 12 h without requests, `pnpm console --stop`                                                                      |
| macOS notifications need a signed helper for click-through                     | WP14 chooses between a bundled Swift helper and `osascript` without click-through; notifications stay opt-in                                                                     |
| Three UI languages drift                                                       | Typed dictionaries and a missing-key test; prefilled decision phrases reviewed per language in WP4                                                                               |
| Borrowed components carry licence or style debt                                | D5: MIT only, rewritten onto tokens, credits; bake-off                                                                                                                           |
| Local server exposure                                                          | D15 controls; security tests; loopback only                                                                                                                                      |
| Scope creep before value                                                       | P0 first; M2 is the first release; P2 waits for real use                                                                                                                         |
| Open: Codex hook/notify support                                                | WP0                                                                                                                                                                              |
| Open: whether `feedback` and the chain's skip already take every flag §8 needs | WP5 and WP9 check and add                                                                                                                                                        |
| Open: stable port 4317 conflicts                                               | Fallback and lock file (D16)                                                                                                                                                     |

---

## 17. Log

- 2026-11-17: draft written from the design discussion with the maintainer.
- 2026-11-17: maintainer decisions recorded: D10 prefilled editable phrase counts as the user's words; D22 first release is the film route with view and decisions; D12 soft pause, stop asks per job; D21 rendered files only, no live Player; D19 English, Russian and Chinese; D3/§10 studio dark with light theme; agent cards (WP11) and macOS notifications (D23, WP14) move into M2; D16 auto-start from `pnpm next`; D2 the console replaces `review:ui` in M2–M3 (WP13); D24 verdict with score, rubric axes, texts and frame comments. Milestones, acceptance criteria and work packages re-cut accordingly.
- 2026-11-17: bake-off done; maintainer chose shadcn + affectUI (decisions, agent activity, notifications, rating) + uiarc (money, event feed) (D5). Hooks verified in both harnesses and decided (§7.1, H1–H9; WP-H added to M1 and M2). Dependency licences checked (Appendix C). `review:ui` parity checklist written (a maintainer record, not published).
- 2026-11-17: D25 added: the console is part of the Licensed Work under BUSL-1.1 after the repository's relicensing; permissive dependencies only, borrowed MIT notices kept in NOTICE.md and credits, no licence enforcement in code.
- 2026-11-17: WP0 landed: contract `src/types/console.ts` (frozen; fixtures in `tests/fixtures/console/`, `tests/console-contract.test.ts`), the console dependencies with `deps:licences --check --strict --scope repository-source` green, the `apps/console/` tooling skeleton (`tsc -p apps/console` in `typecheck`, `console:test` in `check`, `console:e2e` with `RUN_CONSOLE_E2E=1`), stub CLIs for `console`, `console:wait`, `console:card`, `console:control`, `console:build`, `console:snapshot` and `ref:rate`, and console switches off in tests. Deviations: `@tailwindcss/vite` 4.3.3, not 4.3.5, to match the repository's `tailwindcss` 4.3.3; added `@testing-library/dom` (peer), `@testing-library/user-event`, `jsdom` and `@axe-core/playwright` (with `axe-core`, MPL-2.0, dev only); `vite` 8 brings `lightningcss` 1.33.0 (MPL-2.0) and `rolldown` bindings, so 36 exact-version records were added to `contrib/licence-reviews.json` (protected: maintainer review); no ESLint profile (the repository has no ESLint; `pnpm lint` does not scan `apps/`); system font stacks, no bundled font (the console page may load no font asset, parity plan RU-H01/H04); contract additions over §6: `MediaRef.root` (`project` or `out`), a separate `CardInput` for `console:card`, per-kind card constraints, `Decision` fields for quotes, verdicts, frame comments, ratings, argv and channel, `ProjectView.generatedAt`, `project.formats`, `media.renders`, step `gate`/`skippable`, statuses `pending`/`running`, route `timeline`; stubs fail with `INTERNAL` and `details.notImplemented` (no new error code before WP8's `PAUSED`); `console`, `console:wait`, `console:control` are always admitted by the step lease and `console:card` is a control alias.
- 2026-11-17: WP1 landed: `cli.start`/`cli.end`/throttled `cli.progress` from `runScript`, `agent.dispatch` from `film:brief`, `job.state` from the job store; redaction, rotation at 10 MB, `AGENTBROS_EVENTS=off`. Deviations: the journal is written only into a project `pipeline/` that existed when the command started (never creating a project folder), else `out/console/events.jsonl`; the project id `console` is reserved; `workspace:clean` keeps `out/console`; route scans skip the console's pipeline entries.
- 2026-11-17: WP-H landed (§7.1, all six roles in one pass, not two stages): `scripts/hooks/agentbros-hook.mjs` with a versioned payload adapter, `harness:setup --hooks [--apply|--remove]`, `hooksStatus`; `claude-step-guard.mjs` is a shim. Follow-up: the guard journals its refusals (`cli.start`/`cli.end` with `PAUSED` or `VALIDATION`) so a pause refusal at `PreToolUse` notifies. Hook payload fixtures are synthetic; live sessions are pending (below).
- 2026-11-17: WP2 landed: `src/lib/local-server/` (now also used by `review:ui`), the console server with lock, reuse, idle shutdown and `ensureConsoleServer`, media `/media/<id>/<path>` (`@out/` prefix for `out/<id>/`; JSON, logs and HTML refused), cached ffmpeg thumbnails, SSE whose first message is the current `view.changed`. Deviations: the cookie is `agentbros_console_<12 hex of sha256(token)>` (one per checkout, since cookies on 127.0.0.1 span ports); `GET /api/session` returns the token to a same-origin page holding the cookie, so a reload needs no new link; `Sec-Fetch-Site` must be same-origin or none.
- 2026-11-17: WP4 landed: shell, tokens, panel registry, decision and agent cards, EN/RU/ZH dictionaries, fixture mode, Playwright with axe and a strict-CSP run, `console:build` verifying the three-file bundle. Deviations: no sonner and no `motion` under the strict CSP; `<style>` only with the page's CSP nonce; zod in jitless mode. affectUI and Arc UI ports credited in `credits/` and `NOTICE.md`.
- 2026-11-17: WP6 landed: media viewer on the native element, frame strips, stepping, frame and region comments as `FrameComment`, waveform with cue markers, image lightbox, A/B compare with wipe. Amendment: optional `MediaRef.composition` (with WP10b).
- 2026-11-17: WP3 landed: the projector (`src/lib/console/view/`) for film, replica, footage, timeline and recipe routes, `deriveWaiting` with deterministic decision ids and exact argv, revisions from a debounced watch. Review fixes: cost-ledger rows naming a store job (`operationId`) are not counted twice; probes and hashes memoised by file identity (`src/lib/file-memo.ts`); every user question is a decision (`clarify`, `raise-<limit>`, `changes`); `film:approve --choice <idea>` records the user's pick, so choosing an idea is `film:approve` (not a `creative:rank` record, §8). Open: the script runner-up selection and a CLI to raise critic or fixer rounds.
- 2026-11-17: WP5 landed: decisions applied by spawning the owning CLI, `pipeline/inbox/<decisionId>.json`, `?dryRun=1`. Amendments: `Decision.expect` (a hash over the bindings and the quote) is required back on gates, quotes and verdicts and `film:approve --expect` re-checks the outputs hash; inbox statuses `partial` and `unknown`; `ALREADY_DECIDED` (409) and a new decision id per round after `changes`. Deviations: the user's words always travel as one `--flag=value` token; "one more critic round" is `feedback --step <critic> --answer` (not `film:revert`, §8); after a render, `changes` runs `feedback --file` written from the words, before a render `memory --add --type decision`; refused retries are capped at 20.
- 2026-11-17: WP8 landed: `console:control`, `PAUSED` in the CLI contract and the root rules, enforced by `runScript`, the guard hook and the job store's reserve, submit and admission; `job:cancel` cancels one job where the provider supports it (Higgsfield), otherwise reports it unavailable. Amendment (grant and intent model, D12/D15): the server signs each command it spawns with `AGENTBROS_CONSOLE_GRANT`, an HMAC with the session token over argv, project and time, valid 60 s, so the user's decisions apply while paused; it never lifts the lease, admission or any gate. `recut:plan --approve` additionally needs a server-written intent (`pipeline/inbox/intent/<decision>.json`); the grant alone approves nothing. Resumes from the CLI are journaled and flagged; only the user resumes.
- 2026-11-17: WP7a/7b landed: next-step answers auto-start the console and carry `console: { url?, error?, pending, appliedSince, truncated?, lastEventId? }` (cursor `out/console/next-cursor/<project>[.<agent>].json`) and `hooks`; `console:wait` defaults to after the newest next-step answer (`--since` takes `lastEventId`); the root rules and the creative-studio and recording-recut skills name it. `console.url` is the base URL without the token. **Deviation from D16:** next-step callers never restart or stop a running console (a busy or other-version server is `console.error`); only `pnpm console` replaces a server. The wake signal is `hooks.claude === "installed"`.
- 2026-11-17: WP10 and WP10b landed: film panels per step group, blind pools, verdict form. Amendment: optional `ProjectView.film` (brief and strategy excerpts, discovery, ideas and scripts pools by anonymous id with per-axis scores, pairwise and the top three, rated styleframes, shot list and cue sheet, narration direction, takes and caption words, critic rounds with ranked fixes and frames, `human.rubric`; excerpts at most 4 KB, lists capped); the verdict decision is kind `verdict` with only a `changes` option and is given only on the verdict form.
- 2026-11-17: WP11 landed: `console:card`, seven kinds, answers stored in `pipeline/cards/<id>.json` with `card.answered` (not in the inbox, D14), MCP `avc_console_url`, `avc_console_view`, `avc_console_card`; CLIs run through MCP are journaled with channel `mcp`.
- 2026-11-17: WP14 landed (D23): notifications from the server process only, off until enabled, per-kind toggles with a sixth `agent` kind, `AGENTBROS_NOTIFY=off`, dedupe with a cursor in `out/console/notify.json`, cooldown, rate limit, fixed templates. Deviation: the Swift helper was rejected (it needs a signed app bundle); macOS delivery uses `terminal-notifier` when on `PATH` (click opens the card) and falls back to `osascript` without click-through.
- 2026-11-17: WP9 landed: `ref:rate` and `feedback --frame N [--region x,y,w,h]`; ratings and frame comments from the console carry `DecisionRequest.requestId` (amendment) and are idempotent. The §8 row on ratings is corrected in place: ratings reach the look owner's brief, never the critic's.
- 2026-11-17: WP12 landed: optional `ProjectView.footage`, footage panels, the edit-hash approval through `recut:plan --approve <hash> --decision=<id>` with grant and intent, `/api/metrics` and `#/metrics` with unknown spend never shown as 0. The guard's matcher now covers Claude Code's file tools (Read, Write, Edit, MultiEdit, NotebookEdit, Grep) and denies reading `out/console/session.json`, naming the grant and writing `pipeline/inbox/`; older installs show as `stale` until `harness:setup --hooks --apply` is run again.
- 2026-11-17: WP13a–e landed: the review host on the console server (every review route under `/api/review/<project>/`, per-project services and channels), the typed review client and the Timeline view with edit forms, review areas, the offline realtime editor and campaign review. Deviation from D6: the realtime local channel keeps its WebSocket (`/api/review/<project>/realtime/channel`, one-use tickets, 64 tickets per 10 minutes per project). Fixed, not ported: channel cleanup on Ctrl+C, the split form's default cut, and Apply of a hand-edited prepared proposal.
- 2026-11-17: WP13f done (A18): `pnpm review:ui` always opens the console's Timeline page (campaign view for campaign containers), with no legacy mode; the HTML-string client and the campaign page are removed; the review services are unchanged and the standalone servers stay as page-less API harnesses for their tests; client-coupled tests (Appendix A) are deleted in favour of the console's Vitest and Playwright suites; RU-H01–07 are marked and the parity plan is complete.
- 2026-11-17: WP15 landed: `console:snapshot` (read-only, scrubbed, at most 8 MiB, never published by the command), optional `ProjectView.replica`, `recipe` and `campaign` canvases, the library page (`GET /api/library`, `/library/preview/<id>`). **Deviation from D1:** the optional status line is a plain Claude Code `statusLine` command (`harness:setup --statusline`, `scripts/hooks/console-statusline.mjs`), not a mod or plugin, and landed in WP15, not WP14.
- 2026-11-17: **Deviation from H5:** Claude Code's `guard` entry matches `Bash|Read|Write|Edit|MultiEdit|NotebookEdit|Grep`, not only the shell tool, so it can deny reading the console token (`out/console/session.json`), naming the grant and writing `pipeline/inbox/`; the shell-only bound still holds for Codex and for every other role.
- 2026-11-17: security hardening (D15 amended): the session cookie holds a derived media-only value (HMAC of the token), never the token, and authenticates only the media, thumbnail, library-preview and review-file GETs; every JSON read, the stream (read with `fetch` and the header) and every POST need `x-console-token`; no route returns the token (`GET /api/session` no longer does); the page keeps the token in its tab's `sessionStorage` for reloads. Agent-visible output never carries the token: `console.url` in next-step answers, a non-terminal `pnpm console` and `review:ui` give a one-use pairing link `#pair=<code>` (10 minutes, at most five outstanding, stored as an HMAC bound to the checkout, redeemed with `POST /api/session/pair`, listed in Settings "Paired browsers" and announced by a toast in open tabs); the token URL goes only to a terminal or with `--print-token`. Residual risk: whoever reads an answer can redeem its code first (same-OS-user boundary, D15). Attribution to the user (`AGENTBROS_ACTOR=user`, `AGENTBROS_CHANNEL=console`) needs a verified grant for the exact argv; env words alone are recorded as claims. The guard also denies setting `AGENTBROS_ACTOR` or `AGENTBROS_CHANNEL`, `--print-token`, and Codex `apply_patch` edits of the token or a project's `pipeline/inbox/`. Streams are capped at 16 per project (429); library previews refuse a symlink anywhere on the path.
- 2026-11-17: acceptance gaps (core): A8 by end-to-end quote approvals; A19 wasted spend (settled spend on outputs a later user rejection superseded, following the chain's dependencies, unknown-priced and unattributed beside the sum, never $0); console "changes" before a render count as decisions and rework. H1 amended for Codex from source (openai/codex@5a4aff8): the subagent hook matches `spawn_agent` (alias `Agent`, namespaced forms) with the PostToolUse matcher `^(Agent|[A-Za-z0-9_]*spawn_agent)$` and reads the child id from its JSON-text response; the Codex guard matcher is `Bash|apply_patch`. Existing installs show `stale`: re-run `pnpm harness:setup --hooks --apply`. Hook fixtures name their provenance (documented, recorded, synthetic). H5 measured: the Read guard runs at p50 40 ms, p95 42 ms, about 10 ms over bare `node`.
- 2026-11-17: acceptance gaps (UI): amendments: a `policy` decision kind with `PolicyChangeSchema` (autonomy and ceiling through `film:policy` or `budget --ceiling-usd` with the user's words, idempotent per request id; a raise or autonomous mode shows the exact command and the amounts before and after, after a dry run; a lowered film ceiling also lowers the job store's) (A10, US14); `JobSummary.cancelReason` (Stop lists every in-flight paid job and cancels one at a time, saying why one cannot be) (A9); `GET /api/hooks` and `POST /api/hooks/install` (Settings shows the real status and installs through `harness:setup --hooks --apply` after a confirm) (H3); History compares two versions the view carries, renders in the A/B compare and documents as a line diff (US17).
- 2026-11-17: verified after the follow-up packages: A8, A9, A10, A19 (fixtures) as in §14; H1 by `console-hooks` (Codex `spawn_agent` fixtures) and `console-hooks-install`; H3 by `console-gaps-ui` and Playwright `gaps`, `gaps-server`; US14 by `console-gaps-ui` and Playwright `gaps`; US17 by Playwright `gaps` (history compare). Proposals not adopted: a `console.paired` event kind; `media.versions` in the view.
- 2026-11-17: WP16 done: [studio console guide](../console.md), architecture, `apps/console/AGENTS.md` and the root index, one consolidated release entry (`.changes/studio-console.md`), acceptance statuses in §14, Status updated.
- 2026-11-17: proposals not adopted (follow-ups): a `console.wake` flag in next-step answers; `ProjectsResponse.monthUnknownPriced`; `ControlChange.actor`; `Binding.root`; `Decision.rubric`; `MaterialItem.provider`; an optional answer for a rating; a `ReviewStatus` notice kind; moving `ConsoleMetricsSchema` into `src/types/console.ts`; an events `before` cursor for the newest page; `AGENTBROS_AGENT` set by every harness. Open chain work: the script runner-up selection; a CLI to raise critic or fixer rounds.
- 2026-11-18: **D21 revised (maintainer decision):** "Open in Remotion Studio" launches Studio for the project in its current state and opens it in a new tab, on the user's request only, instead of copying `pnpm studio`. The console bundle still carries no composition code; the server spawns `studio:open` as the user with the grant (so it works while paused), which opens a film's build.json composition or a project's format composition with exactly the render's props in a watched file (re-opening updates the open Studio live), reuses one Studio per (entry, props file) and stops the ones it started when the console shuts down. Why: the user wanted the live picture one click away, and Remotion Studio binds every interface with unauthenticated file-writing endpoints, so it runs under a loopback preload (`scripts/studio/loopback.cjs`: every listen on 127.0.0.1; a non-loopback `Host`, a foreign `Origin` and cross-site writes refused). Contract: `StudioTargetSchema`, `StudioStatusResponseSchema`, `StudioOpenRequestSchema`, `StudioOpenResponseSchema`; `POST …/studio/stop` answers `StudioStatusResponse` (no new schema). Residual: local processes of the same user can reach Studio (D15 boundary).
- 2026-11-18: Studio hardening after review: one Studio per (project, entry, props file); a film opens with its build.json `props`; the preload refuses every cross-site request but a top-level GET navigation, accepts an `Origin` only on the process's own ports, and sends `frame-ancestors 'self'` (clickjacking).
- 2026-11-20: amendments (console generations, Media tab, frame notes): optional `view.generations`, `view.gallery` and `ProjectSummary.reservedUsd`; a `frame-note` decision kind on every route, run as `frame:note` (the exact frame from the file with the user's marks drawn on it, `pipeline/frame-notes/<id>.png` and `.json`, `FrameNoteSchema`); `FrameComment.marks` (points and boxes with words, at most nine); `DecisionRequest.overlay` (a base64 PNG, `frame-note` and `frame-feedback` only, written as an attached file and never kept in the inbox); `console:wait`, `relay` and `wake` name the note and the still ([guide](../console.md#frame-notes)).
- 2026-11-17: not verified by agents (pending manual acceptance by the maintainer): live Claude Code and Codex hook sessions, including `wake` and `relay`; the macOS notification display and click-through; opening the console in the Claude Code preview pane and the Codex in-app browser; the milestone acceptance demo on a real film (§15.4).

## Appendix A. Harness capability matrix for the console

| Capability                        | Claude Code                                                  | Codex                                               | Any browser          |
| --------------------------------- | ------------------------------------------------------------ | --------------------------------------------------- | -------------------- |
| Open localhost beside the chat    | Desktop preview pane                                         | In-app browser (Cmd+Shift+B)                        | Separate window      |
| Wake the agent on a decision      | Background `console:wait`                                    | Next user message                                   | Next user message    |
| Comment on the page for the agent | Console cards and decisions; Artifact comments for snapshots | Annotate, plus console decisions                    | Console decisions    |
| Agent activity events             | Hooks                                                        | Hook/notify if supported, else dispatch events only | Dispatch events only |
| Agent drives the page             | Browser tools                                                | CDP developer mode, Computer Use                    | —                    |

## Appendix C. Dependency licences (checked 2026-11-17)

Registry metadata (`npm view`) for the D3 list, against `contrib/licence-allowlist.json` (allowed: MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, 0BSD, CC0-1.0, BlueOak-1.0.0, Unlicense; review: MPL-2.0).

| Package                            | Version | Licence      | Role                                                                        | Policy  |
| ---------------------------------- | ------- | ------------ | --------------------------------------------------------------------------- | ------- |
| vite                               | 8.3.8   | MIT          | build                                                                       | allowed |
| @vitejs/plugin-react               | 6.3.0   | MIT          | build                                                                       | allowed |
| @tailwindcss/vite                  | 4.3.5   | MIT          | build                                                                       | allowed |
| radix-ui (and `@radix-ui/react-*`) | 1.8.1   | MIT          | runtime                                                                     | allowed |
| class-variance-authority           | 0.7.1   | Apache-2.0   | runtime                                                                     | allowed |
| clsx                               | 2.1.1   | MIT          | runtime                                                                     | allowed |
| tailwind-merge                     | 3.7.0   | MIT          | runtime                                                                     | allowed |
| tw-animate-css                     | 1.4.0   | MIT          | runtime                                                                     | allowed |
| lucide-react                       | 1.73.0  | ISC          | runtime                                                                     | allowed |
| sonner                             | 2.0.8   | MIT          | runtime                                                                     | allowed |
| cmdk                               | 1.1.1   | MIT          | runtime                                                                     | allowed |
| @tanstack/react-table              | 9.3.1   | MIT          | runtime                                                                     | allowed |
| recharts                           | 3.10.1  | MIT          | runtime                                                                     | allowed |
| motion                             | 14.14.0 | MIT          | runtime, only if a borrowed component needs it (console only, never `src/`) | allowed |
| wavesurfer.js                      | 8.1.0   | BSD-3-Clause | runtime, optional                                                           | allowed |
| vitest                             | 5.1.0   | MIT          | dev                                                                         | allowed |
| @testing-library/react             | 16.3.3  | MIT          | dev                                                                         | allowed |
| @playwright/test                   | 1.65.1  | Apache-2.0   | dev                                                                         | allowed |
| shadow-plugin                      | 2.1.1   | MIT          | not used (beautifului dropped, D5)                                          | allowed |
| liveline                           | 0.0.7   | MIT          | not used (beautifului dropped, D5)                                          | allowed |

Transitive tree of a scratch install of the build and UI set (vite, plugin-react, tailwind, motion, lucide, cva, clsx, tailwind-merge, shadow-plugin): 177 packages, all allowed except `lightningcss` 1.33.0 (MPL-2.0, already present in this repository's lock and in the review list). Component collections: the uiarc free core and affectUI free items (both used) and beautifului (not used) are MIT; Spectrum UI publishes no licence and stays excluded. WP0 adds the chosen set and runs `pnpm deps:licences --write` and `--check` before merge.
