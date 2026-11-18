# Memory — Agent Rules

Last updated: 2026-11-17

What agents have learned from this user: their decisions, preferences and confirmed lessons, agents' observations, project episodes and tool gaps. It is **personal and local**: everything here except this file is git-ignored, survives project deletion (but `usage/<project>.json`), is never cleared by `workspace:clean` unless asked explicitly, and is never exported. Code: [src/lib/memory](../src/lib/memory/AGENTS.md); schema: `src/types/memory.ts`.

## Layout

One Markdown file per entry, `memory/<dir>/<id>.md`: front matter is the schema, the body is free text. `usage/<project>.json` is not an entry: the library blocks each film used, written by `library:usage` and film:done on build, read by plan:check's `cross-film-repetition` for films whose project still exists; it is project footprint, removed with the project (`project:remove`, `workspace:clean --scope projects`, which also takes records of projects already gone). The local index (index.json) is generated (`pnpm memory --reindex`); never edit it. `metrics.jsonl` is append-only: removing a project appends a `removed` line for its id, and `readMetrics` counts only lines after the last one, so a new project reusing the id starts clean. Ids are `<type>-<yyyymmdd>-<slug>`.

## The seven types

| Type | Write it when | Source | Example summary |
|---|---|---|---|
| `preference` | The user states a lasting taste | the user's words | Captions sit in the lower third, never centred |
| `decision` | The user settles a choice that later films should keep | the user's words | Every promo also ships a square cut |
| `lesson` | The user confirms what went wrong or right in a film and why | the user's words | Hooks must show the product in the first second |
| `observation` | An agent notices something in this user's work, unconfirmed | an agent, with evidence | The critic flagged a flat ending in two promos |
| `episode` | A project ends: what was made, rounds, spend, outcome | measured, names its project | Promo delivered after three critique rounds |
| `gap` | A tool, sensor or block was missing and work went around it | an agent or measured | No sensor measures caption overlap with UI |
| `proposal` | A repeat calls for a change to the harness | an agent (`--propose`), the user approves | Add a caption overlap sensor to qa |

## Who writes

The orchestrator is the only writer, through `pnpm memory --add`. Leaf agents never write here: they propose an entry in their report (type, summary, scope, evidence), and the orchestrator decides. The orchestrator records its own observations with `--agent orchestrator`.

Scope any type with --playbook, --step, --platform. `--playbook` must name an existing playbook and `--step` a known step id (film chain, `footage:next` or template stage); the command lists the valid ones. Platforms: tiktok, instagram-reels, youtube-shorts, youtube, instagram-feed, linkedin, x, app-store, google-play, website, presentation. Scope a lesson to every step it governs (a step filter is strict): an entry scoped to steps never shows at another step.

```bash
pnpm memory --add --type decision --summary "Every promo also ships a square cut" --quote "<the user's words>" --playbook product-promo
pnpm memory --add --type lesson --summary "The hook shows the product in the first second" --quote "<the user's words>" \
  --playbook product-promo,ugc-ad --step script,beat-sheet,build --platform tiktok,instagram-reels --axis hook --body-file /tmp/lesson.md
pnpm memory --add --type gap --summary "No sensor measures caption overlap with product UI" --agent orchestrator \
  --evidence "out/demo/qa frame 40" --playbook product-tutorial --step qa --platform youtube-shorts --body-file /tmp/gap.md
pnpm memory --add --type gap --summary "<one line>" --measured "<command run as the workaround>"
pnpm memory --add --type observation --summary "<one line>" --agent creative-critic --evidence "<artefact path or frame>"
pnpm memory --add --type episode --summary "<one line>" --measured "<command or file>" --project <id>
pnpm memory --seen <id> --evidence "<where it showed up again>"
```

A workaround may be recorded as a gap from an agent or `--measured "<command run>"`.

## The user-words rule

- A preference, decision or lesson needs `--quote`: the user's own words, verbatim, in their language. The schema refuses any other source.
- An agent's view, however confident, is an observation. It becomes a lesson only when the user confirms it in their own words.
- Acceptance without words is not a lesson; record an episode.
- Only the user's words supersede a preference, decision or lesson: an observation can never replace one.
- Generalise lessons. The summary names no product or brand: write "the hook shows the product in the first second", not the product's name. Put specifics (project, frames, the brand) in the body (`--body-file`).

Decisions the harness takes under an autonomous policy live in the project ledger (`pipeline/decisions.jsonl`, [autonomy](../docs/production-chain/autonomy.md)), never in `memory/decisions/`: a decision there is only ever the user's words.

## Never write

- Secrets, API keys, tokens, passwords, private URLs with credentials.
- Other people's personal data beyond what the user gave for the work.
- Anything the user asked not to keep.

## Reading

- Next-step answers (`pnpm next`, `film:next`, `footage:next`) carry a short `memory` field: the few entries for this playbook, step and platform. Respect decisions and preferences there unless the user says otherwise now.
- Where an answer waits on the user (a gate, a choice, a recorded revision) or follows a delivery, it carries `capture` (`moment`, `hint`, `commands`): `pnpm memory` templates scoped to this playbook, step and platform, never pre-filled. Fill `--quote` only with the user's own words; leaf agents propose, never run them.
- `pnpm memory --query "<words>" [--playbook <id>] [--step <s>] [--platform <p>] [--type <t>]` ranks entries within hard caps (7 entries, 1200 characters), keeping only those whose words match (2026-11-17); `pnpm memory --id <id>` prints one in full; `--list` lists all, with warnings for invalid files.
- MCP exposes the read-only actions only.
- A film's rejected items go through `pnpm feedback` ([production chain](../docs/production-chain/feedback.md)); its confirmed answer carries the `rejection` capture with `--step` and the rubric `--axis` filled, `--quote` still the user's words.

## Hygiene

- **Supersede, never delete.** When a new entry replaces one, add it with `--supersedes <id>`; the old one stays as history. `--retire <id>` when an entry no longer holds and nothing replaces it.
- **Contradictions are asked.** When the user's words contradict an active decision or preference, ask which holds, then supersede.
- **Repeats.** Before adding, `--query` for the problem. An add is refused when an active entry has the same type, an overlapping scope (same project or none; shared playbooks when both name some) and a near-identical summary (token Jaccard >= 0.8). Count the sighting on the existing entry with `--seen <id> --evidence "<what>"`; never add a reworded copy. The evidence becomes a dated line in the body.
- **Metrics and episodes are written by commands**, best-effort: film:approve (approved), recut:plan --reject (rejected), film:done on a reviewed step (round), film:measure and motion:check failures (sensor-fail), budget --receipt (spend, USD), a production-ready delivery check (delivered), which also drafts one measured episode per project.
- **After a delivery**, run `pnpm memory --consolidate`: merge duplicates, review stale entries (over 180 days) with the user, fix broken files. Observations and gaps seen twice or more feed the improvement loop below.

## Improvement loop

1. `pnpm memory --consolidate` lists `suggest`: observations and gaps seen twice or more that no proposed, approved, applied or verified proposal answers.
2. Propose (method: `creative-postmortem` skill): `pnpm memory --propose --summary "<one line>" --change sensor|rule|playbook|tool|chain|critic|retire --target <paths> --cause <ids> [--test <path>] --agent orchestrator --evidence "<consolidate>"`. Causes are active observations, gaps or lessons. The scope is the union of the causes' playbooks, steps and platforms (a project only if all share one); a target or test path that does not exist yet is a warning (it may be a new file).
3. Put it to the user. Only on their go-ahead: `pnpm memory --approve <id> --quote "<the user's words>"`; turned down: `--reject <id> --text "<why>"`, with `--quote "<the user's words>"` once it was approved.
4. A subagent in its own git worktree implements it with a test that fails before and passes after; merged on the user's go-ahead. Then, from the repository root, `pnpm memory --applied <id> --commit <sha>[,<sha>]` (each must be a commit reachable from HEAD, so merged; a warning when none touches a target or the test).
5. `--consolidate` `review` grades applied proposals: a cause (or an entry superseding it) seen on a later day than `appliedAt` → candidate ineffective (a same-day sighting does not count); none for 30 days → candidate verified; else watching, with days left. A lesson cause has no sightings, so it can only reach verified.
6. The verdict is the user's, and they may give it before a review candidate appears (the candidate is advice, not a gate). Record it in their words: `--verdict <id> --state verified|ineffective --quote "<the user's words>" --text "<why>"`. An ineffective change gets a new `--change retire` proposal; `--verdict <id> --state retired` closes one.

Proposals never appear in next-step `memory`; `--query --type proposal` and `--list --type proposal` show them. `pnpm memory:upstream --id <id>` exports an applied or verified proposal's commits as format-patch files and a generalised `PR.md` in `memory/upstream/<id>/`; a leak scan (the export patterns, optional local patterns from leak-patterns.local.json, every entry's words, project ids and author emails) refuses on any hit (`LEAK`). It never pushes; the user sends it. `--dry-run` lists the commits, files and hits without writing.

Blender improvement logs are tracked separately in `blender-arsenal/improvements/`; `memory --consolidate` lists their verdicts without importing personal memory into them. `blender:improve gaps` joins unresolved logged gaps with active Blender memory, matching stable gap ids mentioned in the summary/body. The orchestrator still writes observations/gaps through `memory --add`.
