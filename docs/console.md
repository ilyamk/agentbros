# Studio console

Last updated: 2026-11-18

The studio console is a local web page that shows every project live and takes the user's decisions where they are easiest to make well. It runs on `127.0.0.1`, beside the chat: in the Claude Code desktop preview pane, the Codex in-app browser or any browser. Design and decisions: [RFC 0004](rfcs/0004-studio-console.md). Code: `src/lib/console/` (server, projector, actions), `src/lib/local-server/` (loopback security shared with `review:ui`), `apps/console/` (the React UI, [rules](../apps/console/AGENTS.md)), `scripts/hooks/` (harness hooks, [harnesses](harnesses.md#hooks)), contract `src/types/console.ts`.

The console is a view and a remote control, never a second source of truth. Everything it shows is read from the project's own files (chain state, job store, cost ledger, assets, renders, QA, delivery) and from the event journal. Everything it changes goes through the same CLIs an agent or the user would run, with the user's words.

## Starting it

- **Auto-start.** `pnpm next`, `film:next`, `footage:next`, `film:init` and `project:new` start the server detached when none runs (at most 4 s; reuse when one does) and return `console: { url?, error?, pending, appliedSince, truncated?, lastEventId? }` and `hooks: { claude, codex }`. `console.url` normally carries a one-use pairing code (`#pair=<code>`). A failed or refused start yields `console.error` without failing the command. A verified older server can still supply a project link alongside the warning. At project start or resume the orchestrator uses the native browser pane, reuses the dashboard tab and checks that the correct project is visible. See [desktop browser handoff](harnesses.md#desktop-browser-handoff).
- **By hand.** `pnpm console` starts or reuses the server and returns `metadata.url`, `tokenInUrl`, `baseUrl`, `port`, `reused`, `fellBack`, `pid` and `version`. To a terminal, or with `--print-token`, `url` is the session URL with `#token=…`; otherwise it is a one-use pairing link. `--open` opens the session in the default browser without printing the token, `--project <id>` opens at that project, `--port <n>` asks for another port, `--stop` stops the server. One server serves every project of the checkout.
- **Port.** 4317 by default; when it is busy the server takes a free port and says so (`fellBack`). The lock `out/console/server.json` (pid, port, version) lets every caller reuse the running server. Log: `out/console/server.log`. The server stops itself after 12 hours without requests.
- **Session.** The per-machine token lives in `out/console/session.json` (mode 0600) and stays the same across restarts. A page receives it from a `#token=` URL, or redeems a `#pair=` code with `POST /api/session/pair`; it strips either from the address bar at once and keeps the token in its tab's `sessionStorage`, so the same tab reloads and reconnects after a server restart. While the server is down, the tab retries and shows its offline status. If the session is missing or refused, open a fresh pairing link in the same tab. JSON reads, the event stream (read with `fetch` and the header) and every POST send the token in `x-console-token`; no route ever returns it. The `HttpOnly; SameSite=Strict` cookie `agentbros_console_<12 hex of the token's hash>` (one name per checkout) holds only a derived value that loads media, thumbnails, library previews and review files. Pairing codes are single use, valid 10 minutes, at most five outstanding, stored only as an HMAC in `out/console/pairing.json`; every redemption is listed in Settings under "Paired browsers" and announced by a toast in open tabs.
- **Versions.** `pnpm console` replaces a running server of another version (after a pull or a console change). Next-step answers never restart or stop a running server: a busy or different-version server is reported as `console.error`, and `pnpm console` fixes it.
- **Restricted sessions.** Authenticated health probes can confirm a running console when boot time is unavailable. Restart and stop still require process ownership verification. If the session cannot inspect the process, the console keeps the server and its lock in place. Run `pnpm console` from the local terminal to replace it.
- **Build.** The server builds the UI bundle into `out/console/dist/` (`index.html`, `app.js`, `style.css`) when its source hash changes; `pnpm console:build` builds and verifies it by hand.

## Pages

| Page           | Address                                 | Shows                                                                                                                                                                                                                                                                                             |
| -------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Home           | `#/`                                    | Every project: route, current step, active agent, waiting count, spend and ceiling, control state, latest render                                                                                                                                                                                  |
| Project canvas | `#/projects/<id>`                       | The pinned list of what waits for the user, the step rail with reasons, then one panel per step group for the project's route; generic Money, Agents, Assets, Step guard, Advisories and History panels                                                                                           |
| Decision       | `#/projects/<id>/decision/<decisionId>` | The canvas focused on one decision card (notifications open this)                                                                                                                                                                                                                                 |
| History        | `#/projects/<id>/history`               | The journal: every CLI run with timing and result, agent dispatches and runs, job states, decisions, control changes and card answers; compare two versions the view carries (renders in the A/B compare, documents and step outputs as a line diff)                                              |
| Timeline       | `#/projects/<id>/timeline`              | The local review of a timeline project (see below); a campaign container shows its campaign review                                                                                                                                                                                                |
| Metrics        | `#/metrics`                             | Decisions, time to decision, rework, refusals, spend per project and month, wasted spend (settled spend on outputs a later rejection superseded; unknown-priced and unattributed beside the sum, never $0), agent time; from journals, inboxes and ledgers only, never sent anywhere              |
| Library        | `#/library`                             | The motion library's blocks with previews (read-only)                                                                                                                                                                                                                                             |
| Settings       | `#/settings`                            | Language (English, Russian, Chinese), theme (dark studio, light), notifications per kind, paired browsers, hooks status per harness with the install command and an Install button (runs `harness:setup --hooks --apply` after a confirm; `GET /api/hooks`, `POST /api/hooks/install`), port hint |

Route panels on the canvas:

- **Film** (bespoke chain, replica): brief and strategy, discovery and truth, ideas, music, script, look, beat sheet, material, narration, animatic and build, critic and fixes, QA and delivery, final verdict. Idea and script pools are shown blind (anonymous ids, per-axis scores, pairwise results, the top three and the arguments against); the chosen one appears only after the user's step.
- **Footage** (the user's recording): source, transcript excerpt, the recut plan with cuts and before/after timing, captions, shorts, cameras, reframe paths and renders.
- **Replica, recipe, campaign**: a route canvas with the material of that route; a campaign container shows a summary and its Timeline page.

Media are range-served renders with frame strips, frame stepping, a stale badge when the composition changed since the render, and "Open in Remotion Studio" for the live picture ([below](#remotion-studio)). The console never runs composition code itself.

## Project settings

The gear on a Home card opens its project settings. Saving a name updates the Studio Console title for that project while preserving its ID, paths and links. New projects can set the title with `film:init --title` or `project:new --title`. Existing projects without a display title use their configured title or name, the brief title if present, then the project ID.

To delete a project, choose **Delete project**, type its ID, then choose **Delete permanently**. The console runs `project:remove --project <id> --yes` and refreshes the project list. The [cleanup guards](cleanup.md) protect tracked files, shared paths and active work. The dialogue shows the reason if deletion is refused.

## Decisions

A decision is a waiting user act derived from the project's state: a gate, an idea or script choice, a paid quote, a clarification, a raise of a policy limit, the recut plan's edit hash, the final verdict. The card shows the material, the exact command and an editable phrase prefilled in the UI language. What the user submits is stored verbatim with `channel: "console"`, and the server applies it at once by running the owning CLI as the user:

| Act                                                                                | Command the server runs                                                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Approve a gate, choose an idea or script, approve a film quote                     | `film:approve --project P --step S --answer=<words> --expect <hash>` (`--choice <idea>` for an idea)                    |
| Ask for changes, one more critic round                                             | `feedback --project P --step S --answer=<words> --confirm` (after a render: `feedback --file`, written from the words)  |
| Skip a skippable step                                                              | `film:done --project P --step S --skip=<words>`                                                                         |
| Autonomy, budget ceiling                                                           | `film:policy --autonomy … --answer=<words>`, `budget --ceiling-usd … --answer=<words>` (never more than the CLI allows) |
| Footage quote, recut plan                                                          | `budget --ceiling-usd`, `recut:plan --approve <hash> --decision=<id>`                                                   |
| Final verdict (score 1–10, rubric axes, what worked, what did not, frame comments) | `film:approve --step human`, then `memory --add --type decision` and `feedback` for the frame comments                  |
| Rate a styleframe, reference or render                                             | `ref:rate --project P --path=<file> --score 1..5 [--note=<words>]`                                                      |
| Comment on a frame                                                                 | `feedback --project P --frame N [--region x,y,w,h] --watched=<render> --answer=<words> --confirm`                       |

Rules that make this safe:

- **Expect hashes.** Every pending decision carries `expect`, a hash over every bound file and the quote. The request must send it back unchanged; `film:approve --expect` re-checks the outputs the user saw. A changed artefact makes the decision stale (409) and the card refreshes.
- **One outcome per decision.** A decided id never runs a second, different choice (409 `ALREADY_DECIDED` with the stored outcome); the same request again returns the stored outcome. A new round after "changes" gets a new id. Ratings and frame comments carry a `requestId`, so a repeated click records once.
- **Words as one token.** The user's words reach the CLI as one `--flag=value` argument, so text such as `-h` is never read as a flag.
- **Record.** `pipeline/inbox/<decisionId>.json` keeps the request, argv, the CLI's envelope and the status (`applied`, `refused`, `superseded`, `partial` when a verdict follow-up failed, `unknown` after a timeout or crash); the journal gets `decision.applied` or `decision.refused`. `POST /api/projects/<id>/decisions?dryRun=1` shows the argv without running it.
- **Grant and intent.** Each command the server spawns carries `AGENTBROS_CONSOLE_GRANT`, an HMAC with the session token over the exact argv and project, valid for 60 s. It lets the user's own decisions apply while the project is paused; it never lifts the step lease, budget admission or any gate. `recut:plan --approve` also needs the intent the server writes just before the spawn (`pipeline/inbox/intent/<decision>.json`); the grant alone approves nothing.
- **Spending stays with the agent.** Approving a quote records the user's yes; the paid call happens later through the agent's CLI under normal admission.

Ratings land in `pipeline/ratings.json`; a note also becomes a memory preference in the user's words. The look owner's brief lists the latest rating per styleframe; the critic never sees ratings. A frame comment reopens the build and appears in the fixer's next brief with the frame and the area.

Document tiles open a dialogue in the console. During strategy review, switch between `strategy.md` and `strategy.json` in the same dialogue and edit either file. Later film steps use the JSON values. The Markdown is the written summary, so review it after changing those values. Saving checks the loaded revision, validates the new strategy and records the new review hashes. Approve the updated card after reviewing both files. The authenticated `document` API serves the strategy JSON to this dialogue and accepts edits only to those two files during the pending review. Other supported text documents open for reading.

## Autonomy and budget

The project's top bar changes autonomy and the budget ceiling as a `policy` decision: `film:policy --autonomy … [--ceiling-usd …]` on a film, `budget --ceiling-usd …` elsewhere, with the user's words, idempotent per request id and journaled. A raise or an autonomous mode is dry-run first and shows the exact command and the amounts before and after; the user confirms it. The console never grants more than the CLI allows; a lowered film ceiling also lowers the job store's.

## Pause, resume and stop

The project's top bar pauses, resumes or stops it: `console:control --project P --state paused|running|stopped --answer "<words>" [--reason …]` writes `pipeline/session/control.json` and journals `control.changed`. While a project is paused or stopped, every non-control command fails with `PAUSED` (halt and tell the user; never retry), and the guard hook refuses it before it starts. Pause is soft: a paid job already submitted completes and keeps its result. Stop lists every in-flight paid job with its reservation; the user cancels one at a time, each on its own confirmation, through `job:cancel --project P --operation-id <id> --answer "<words>"`. A job that cannot be cancelled shows why (`cancelReason`); a cancellation is never faked. Only the user resumes.

## Agent cards

An agent shows the user a comparison or asks a question with `pnpm console:card --project P --kind <compare|grid|rating|choice|question|markdown|media> --data card.json [--expires-in 2h]` (MCP: `avc_console_card`). Cards are Zod-checked, at most 256 KiB, Markdown without HTML, with media confined to the project or its `out/<id>/`. They are stored in `pipeline/cards/<id>.json`; the user's answer is written there and journaled as `card.answered`. `avc_console_url` and `avc_console_view` are read-only MCP tools ([MCP](mcp.md)). Applying decisions and pause or resume are never MCP tools.

## Waking the agent

- **`console:wait`.** `pnpm console:wait --project P [--timeout-min 30] [--since <eventId>]` blocks until the project's journal records `decision.applied`, `decision.refused`, `control.changed` or `card.answered` after the newest next-step answer (or after `--since`, the answer's `console.lastEventId`), then prints it. A timeout or interrupt is `ok` with `event: "timeout"` or `"interrupted"`. In Claude Code the orchestrator runs it in the background at a gate and is re-invoked when it exits.
- **Hooks banner.** While `GET /api/hooks` reports Claude Code's or Codex's hooks `missing` or `stale`, every page shows a banner asking to connect them. Its dialog says why hooks matter, shows the status per harness, checks again, and installs or updates with `harness:setup --hooks --apply` on the user's click after the plan is shown. The banner's close button hides it for good in this browser (localStorage); Settings keeps the hooks.
- **Hooks.** With `pnpm harness:setup --hooks --apply`, the `wake` hook resumes a waiting Claude Code session after a console decision, and `relay` adds the user's console decisions to the next prompt in both Claude Code and Codex. When `hooks.claude` is `installed`, the orchestrator does not need `console:wait`.
- **Without either**, the next user message wakes the agent and the next-step answer's `console.appliedSince` lists what the user decided (cursor `out/console/next-cursor/<project>.json`).

## Notifications

Off until the user turns them on at the first-run prompt or in Settings, with per-kind toggles: a decision or card waiting, a failed command at the current step, a pause refusal, a finished render or delivery check, a finished paid job, the agent waiting for permission or input. The server sends them (never a CLI), deduplicated per decision, card, job or event with a cursor in `out/console/notify.json`, a cooldown and a rate limit. Only fixed templates with the project, step and error code reach the OS, never the user's words. On macOS, `terminal-notifier` (when on `PATH`) opens the card on click; otherwise `osascript` shows the notice without click-through. An open console tab with browser permission notifies instead; nothing is sent while a console tab is focused.

## Snapshot

`pnpm console:snapshot --project P [--max-bytes N]` writes `out/<id>/console-snapshot.html`: one self-contained, read-only page of the project's view, scrubbed of secrets, the token and home paths, with media named by relative path, at most 8 MiB. It is never published by the command. Publishing it (for example as an Artifact) needs the user's explicit request, because the data leaves the machine.

## Status line

`pnpm harness:setup --statusline` plans an optional Claude Code status line (`Agent Bros console: 2 waiting · 1 paused`), `--statusline --apply` writes the `statusLine` entry into `.claude/settings.local.json` after the user's yes, `--statusline --remove` removes it. Another tool's status line is reported as a conflict, never replaced. The script `scripts/hooks/console-statusline.mjs` reads the running console or the project files and ends within 100 ms (`AGENTBROS_STATUSLINE_BUDGET_MS` allows up to 2000).

## Timeline review

The Timeline page hosts the local review on the console server: every review route under `/api/review/<project>/` over the unchanged review services, with the timeline edit forms, snapshots and takes, assets and entities, budget, visualisations, QA evidence, chapters, the offline realtime editor and campaign review. `pnpm review:ui --project P [--port N] [--open] [--print-token]` is its alias: it starts or reuses the console and returns the Timeline URL (a campaign container opens its campaign view); the token URL goes only to a terminal or with `--print-token`, otherwise a one-use pairing link ([local review](local-review-ui.md)).

## Remotion Studio

"Open in Remotion Studio" starts Studio for the project in its current state, on the user's click only, and opens it in a new tab (amended D21, 2026-11-18). The server runs `studio:open` as the user with the console grant, so it works on a paused project too; an agent running `pnpm studio:open` on a paused project is refused with `PAUSED` like any other command.

- **What opens.** A bespoke film: `pipeline/build.json`'s `composition` and `entry` (default `src/index.ts`; a repository file, no traversal, no symlink out, no path segment starting with `-`), with its `props` file as `--props` when it names one, as `film:render` passes it (a file under `public/`, checked like the entry). A project.json project: `src/index.ts` and `ProjectVertical`, `ProjectSquare` or `ProjectLandscape` for the chosen format (default its first), with exactly the props `pnpm render` passes (the timeline journal when the route renders it), written to `out/console/studio/<project>/props.<format>.json`. A campaign container, a film without build.json and a folder with neither are unavailable, with the reason.
- **Live.** Studio watches that props file: opening again rewrites it (only when it changed) and the open tab updates without a restart. Code changes reload through Studio's own hot reload.
- **One per target.** At most one Studio per (project, entry, props file), reused while its pid is alive, is still a `remotion studio` process started when recorded, and answers on its port; a Studio of ours that does not answer in time is reported (`TIMEOUT`), never killed; one left from a film's earlier props file or entry is stopped when the film opens again. Status and `--stop` act only on the project's own Studios. State in `out/console/studio/<key>.json` (0600), kept while `ps` cannot tell whether its pid is still Studio; log in `<key>.log`. Ports from 3000 upwards, never 4317.
- **Loopback only.** Remotion Studio binds every interface and has unauthenticated endpoints that write files, so it runs under `scripts/studio/loopback.cjs` (also through `NODE_OPTIONS` for Node children): every server of the process binds `127.0.0.1`; a `Host` that is not loopback (DNS rebinding), an `Origin` that is not a page on one of the process's own loopback ports (Studio itself answers CORS for any https site; its lazy compilation has a second port) and any `Sec-Fetch-Site: cross-site` request but a top-level GET navigation (a frame, a script include, a fetch, a write) get 403; every response carries `Content-Security-Policy: frame-ancestors 'self'`, so no other page can frame Studio's buttons. The new tab's copy of the console's session is cleared before it leaves `about:blank`. Studio's own "Network:" log line still prints a LAN address; nothing answers there.
- **Stopping.** The console's shutdown stops the Studios started from it (`owner: "console"`); `pnpm studio:open --project <id> --stop` stops a project's; the console's API has `POST …/studio/stop`.

API: `GET /api/projects/<id>/studio` (status, in-process: no spawn, no props), `POST /api/projects/<id>/studio` with `{ format? }` (`{ ok, url, reused }`), `POST /api/projects/<id>/studio/stop` (the fresh status). Refusals: `STAGE_INCOMPLETE` and `PAUSED` 409, `INVALID_INPUT` 400, `TIMEOUT` 504 (a cold bundle can take a minute; Studio waits up to 90 s).

Tests: `tests/studio-open.test.ts`, `studio-loopback.test.ts`, `console-studio-routes.test.ts`; `RUN_STUDIO_E2E=1` runs `studio-open-e2e.test.ts`, which starts real Studio (loopback listeners, live props, group stop) and loads it in Chromium (its own page works; framing and cross-site includes are refused).

Not protected: any local process can reach Studio's endpoints on 127.0.0.1 (the same-OS-user boundary of D15); Studio runs the project's composition code with the user's rights, as `pnpm studio` always did.

## Editing table and Studio

The project header has two buttons beside the Canvas, History and Timeline tabs (none on a static snapshot):

- **Editing table** opens the project's Timeline page (a campaign container: its campaign review) in a new tab. The tab is opened with an opener, so the browser copies this tab's session to it: no token appears in its address and nothing else is needed to sign in. If the browser blocks the tab, the console says so; allow pop-ups for the console's address.
- **Edit myself (pause agent)**, in the Editing table's menu while the project runs, opens the same tab and pauses the project with the words "I am editing the timeline myself…" and the reason `editing-table: …`, so the agent's commands fail with `PAUSED` and it does not overwrite your edits. Your own timeline edits, undo and redo still apply while paused. The Timeline page then shows "The agent is paused while you edit"; **Done — hand back to the agent** resumes the project with words naming the timeline revision you left it at. The ordinary Pause and Resume in the top bar keep working, and a pause made there shows no banner.
- **Open in Remotion Studio** (also on large media players) appears when Studio can open the project: a bespoke film opens its build composition, a project.json project its composition in the format you choose. The console asks its server to start a loopback-only Studio of the project as it is now, or to reuse the running one; the first start can take a minute, and the new tab shows Studio when it is ready. Where Studio cannot open the project (a campaign container), the player says why and offers the `pnpm studio` command to copy.

## API keys

**Settings → API keys** displays the full form as soon as the key catalogue loads. If the fields are disabled, choose **Edit API keys** to open the editor in your default browser. A terminal launch with `pnpm console --open` also enables the fields. The platform links open in separate tabs. Use the eye to show or hide a key, and the copy button to copy a single value. Type a replacement or mark a key for removal, then choose **Save** at the bottom. **Cancel** discards drafts and reloads the current settings. Openverse's client ID and client secret must form a pair. Status indicates presence and format. Saving never contacts a provider or authorises spending.

The console writes changes atomically to the checkout's ignored `.env.console.json` with mode `0600` on POSIX. Saved values take precedence over legacy `.env` and exported values for the affected keys. A removal suppresses the previous value in new operations. To remove a legacy copy from disk or revoke access to it, remove it at its source or revoke it with the provider. Unmanaged keys use the existing environment. New CLI runs pick up saved changes without restarting the console. Running jobs retain the credentials they started with. `AGENTBROS_NO_DOTENV=1` makes a CLI invocation use only its supplied environment.

The operating system opens the browser with a separate credentials capability in its URL fragment. The handoff request gets a status reply. The console strips the fragment before showing the page and keeps the capability in the tab's session storage. Regular pairing links render masked fields from key statuses and platform links. Reveal, copy and save require the separate capability, an authenticated console session and exact same origin. Status and save responses omit values. A reveal response carries a single key, with caching disabled.

## Security model

The boundary is D15 of the RFC: the server binds `127.0.0.1` only; it refuses a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding) and cross-site fetches; JSON reads, the stream and every POST need the `x-console-token` header, and POSTs the exact `Origin` (CSRF); the cookie's derived value reads only media, thumbnails, library previews and review files; no route returns the token; JSON bodies are capped at 64 KiB and streams at 16 per project; files are served only from inside the project or its `out/<id>/`, never through a symlink, and never JSON, logs or HTML from `/media`; the page runs under a strict CSP with no inline script, no remote origin and no font asset. User and agent text is shown as written, never as HTML.

Agent-visible output never carries the token: next-step answers, a non-terminal `pnpm console` and `review:ui` give pairing links. A command counts as the user's console decision (`actor: user`, `channel: console`) only with a grant that verifies for its exact argv; `AGENTBROS_ACTOR` or `AGENTBROS_CHANNEL` set by anyone else is recorded as a claim, not as the user's act.

The guard hook adds defence in depth, besides the pause and step-lease refusals: it denies an agent's tool call that reads or writes `out/console/session.json`, writes a project's `pipeline/inbox/`, names `AGENTBROS_CONSOLE_GRANT`, sets `AGENTBROS_ACTOR` or `AGENTBROS_CHANNEL`, or asks any command for `--print-token`. In Claude Code it runs on the shell and file tools; in Codex on the shell and `apply_patch`, whose edits of those paths count as writes. An older hook install shows as `stale`; re-run `pnpm harness:setup --hooks --apply`.

Not protected:

- Whoever reads a next-step answer can redeem its pairing code before the user does and gets a session. Settings and the toast make that visible, not impossible.
- Any process of the same OS user can read `session.json`, act as the console and forge a grant (the D15 boundary). The intent narrows this only for `recut:plan --approve`.
- The guard matches text and paths; a glob or an indirection gets past it.
- Another user on the same machine is kept out only by the file modes in `out/console/`.

## Environment switches

| Variable                                       | Effect                                                                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AGENTBROS_CONSOLE=off`                        | No auto-start, no next-step cursor, no decisions in next-step answers; `review:ui` refuses to start the console (`pnpm console` still does) |
| `AGENTBROS_EVENTS=off` (or `0`, `false`, `no`) | No journal lines from CLIs or hooks                                                                                                         |
| `AGENTBROS_HOOKS=off` / `observe`              | Every hook role off / only `observe`                                                                                                        |
| `AGENTBROS_NOTIFY=off` (or `0`, `false`, `no`) | Notifications held off whatever the settings                                                                                                |
| `AGENTBROS_STATUSLINE_BUDGET_MS`               | Status line time budget, 100–2000 ms                                                                                                        |

Tests set the first three to `off` by default (`tests/helpers/memory-root.ts`).

## Troubleshooting

| Symptom                               | Fix                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "This session is not valid"           | The tab has no token: open a fresh `console.url` from a next-step answer (pairing links work once, for 10 minutes), or `pnpm console --open` for the default browser |
| `console.error` in a next-step answer | Read `out/console/server.log`; a busy or different-version server: `pnpm console` (it replaces the old one), or `pnpm console --stop` then `pnpm console`            |
| Studio does not open                  | Read `out/console/studio/<key>.log` (the error names it); `pnpm studio:open --project <id> --status`; `--stop`, then open again                                      |
| Port 4317 taken                       | The server falls back and says so; `pnpm console --stop && pnpm console --port <N>` for a fixed one                                                                  |
| A decision answers 409                | The material changed or the decision was taken elsewhere; the card refreshes with the current state                                                                  |
| Every command fails with `PAUSED`     | The user paused the project; only the user resumes, in the console or with `console:control --state running`                                                         |
| `hooks.claude` is `stale`             | Settings > Install, or `pnpm harness:setup --hooks --apply` (after the user's yes), then restart the session                                                         |
| No macOS notification                 | Turn them on in Settings; check `AGENTBROS_NOTIFY`; install `terminal-notifier` for click-through                                                                    |
| The page is blank or old after a pull | `pnpm console` restarts a server of another version; `pnpm console:build` shows bundle errors                                                                        |
