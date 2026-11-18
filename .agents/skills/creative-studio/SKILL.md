---
name: creative-studio
description: Make or resume a film or ad in Agent Bros. Pictures from playbook to delivery through its creative, media, rendering and review steps. A user's own recording goes to recording-recut.
---

# Creative studio

Work from the repository root. Read `AGENTS.md` and the project's existing artefacts before changing an approved story. Canonical projects live in `public/projects/{id}`; agent definitions are canonical in `.agents/agents/`; `.claude/agents` and `.claude/skills` are relative compatibility links, not separate sources. For software implementation, use the development plan rather than starting a video production pipeline.

## Choose the playbook first

The kind of video comes first: `pnpm playbook --match "<request>"`, read the candidate's `playbooks/<id>/AGENTS.md` and start with its `Start` command, which binds the project ([playbooks](../../../playbooks/AGENTS.md)). The playbook holds the method and quality bar for that kind of video and names the film type; this skill runs the chain it chooses.

Editing the user's own recording ("cut my video", subtitles, silences, shorts, several cameras, vertical) is not a film from this chain: hand it to the `footage-editor` agent and `pnpm footage:next --project <id>` ([footage editing](../../../docs/footage-editing.md)).

Otherwise the film's type (named by the playbook) picks the route: which steps run, where the material comes from, each step's tools, the reference strategy and what QA looks at. Ask the user unless they said it. `pnpm film:route` lists every type and `pnpm film:route --type <t>` prints one route; [film types](../../../docs/film-types.md) is the generated table. A hybrid adds a second type (`--secondary`). The `replica` type only when the user explicitly asks to copy a given film; follow the `reference-replica` skill. "In the style of" a reference is `reference-to-video`.

Then the mode. A film that has to stand beside the user's references is **bespoke**: `pnpm film:init --project <id> --type <t>`. A quick draft from registered recipes is `pnpm video:recipe` (preview, then materialize): its `project.json` is on the timeline route, which `pnpm next` renders, checks and delivers. An old template-mode project (one with `pipeline/pipeline-state.json`) is on that route too: the 16-stage pipeline was removed and its state is ignored. If the user wants quality and hasn't said which, it is bespoke.

## Bespoke mode: you run a loop, you do not write briefs

Read the [production chain](../../../docs/production-chain.md) index once; each step's `read` adds what that step needs (creative standards at strategy, ideas and script variants). Then:

```bash
pnpm film:init --project <id> --type <type> --product <path-to-product-material>
pnpm film:next --project <id>
```

Repeat: run `film:next`, do exactly what it says, run it again. It returns one of:

| Action | You do |
|---|---|
| `dispatch` | Run the `briefCommand` (`pnpm film:brief --project <id> --step <step>`). It writes the brief to `metadata.brief`; start a new subagent with `metadata.dispatch` as its whole prompt ("You are <agent>. Read and follow <brief path>…"), never the brief's text. With `dispatches[]` (concept teams, script variants), run every brief command and start all the subagents at once. Read the reports, then check the step's `orchestratorChecks.after` yourself |
| `run` | Run the script with the printed parameters, then open any picture it wrote |
| `ask` | Put the question to the user in their language, with the files to show and nothing decided for them. Record their words with `pnpm film:approve` or `music --action record` |
| `stop` | Tell the user why and what is needed |

Each answer also carries `console`: open its `url` (the studio console) once beside the chat; `appliedSince` lists what the user decided there since your last call, in their words; at an `ask` in Claude Code run `pnpm console:wait --project <id>` in the background instead of polling, unless `hooks.claude` is `installed` (its `wake` hook resumes you).

**What you are responsible for.** The chain decides who runs and when. You keep the judgement:

- Before each step, read `orchestratorChecks.before`. After it, read `after`, and open at least one output yourself. A subagent's report isn't evidence. `pnpm film:show --project <id> --step <step>` digests a step's JSON; never write a script to print it.
- If you want to add anything to a brief, it must be the user's own words, through `--note`. Never a list of techniques, a count of effects, a topic you prefer or a clip you'd like to reuse. That is the mistake this loop exists to prevent.
- Music is the user's decision. Agents can't hear: never claim a track or a film sounds good. Ask the user to listen.
- A failed `plan:check` or `film:measure` goes back to its owner or the fixer. Don't change targets to pass; only the user can change them. Don't argue with a number.
- A critic, and the creative director who judges the idea and script pools, is a new agent each round and gets only what `film:brief` gives it. Don't tell it what you intended, which team wrote what, or which idea you like. Below the threshold the round goes back to the teams, not to the user; code ranks, not you ([creative rubric](references/creative-rubric.md)).
- If the same problem appears twice, record it in `pipeline/spine.md` and propose a change to the rule or sensor.
- Only the user approves quality. Only what they confirm becomes a lesson, in their local memory (creative-postmortem); `design-reference/creative-lessons.md` holds the curated harness lessons.
- **Benchmark runs only:** when the user has asked for a benchmark of the chain itself, an `ask` may be passed with its `benchmarkProxy` command (`film:approve --proxy benchmark --reason "..."`). It is recorded as `proxy: "orchestrator-benchmark"`, shown as such in every later brief and in `film:status`, and never counts as the user's approval: `human` refuses it, so a proxied film can never be accepted, and a proxy on `material` never authorises spending. At the music step, record the track with the `benchmarkProxy` command (its answer starts `proxy (benchmark): `), never with invented user words. Never use it in a real production.

To make a film in a reference's style, read [reference to video](../reference-to-video/SKILL.md).

## Promo profile (45 s or less)

For a short promo, follow [the promo profile](../../../docs/production-chain.md#the-promo-profile-films-of-45-s-or-less): a pilot shot replaces the animatic and reference numbers are advisory; the human checkpoints, pilot MP4 and final film included, are never auto-approved, even after "do it yourself".

Build from the library: `pnpm library:list --query "<what>"` before any new component (skill `motion-library`); numbers come from `design-reference/craft-rules.md`.

## A project.json project: render, QA, delivery

`pnpm next --project <id>` for a `project.json` without a bespoke brief (a recipe draft, a campaign child, `project:new`, an old template-mode project) answers render, `qa:editorial`, delivery and done ([delivery](../../../docs/delivery.md)). `pnpm pipeline:check --project <id>` is a stateless findings probe (artefact schemas, file references, charts) that any project may run. Do not treat an artefact's presence as an approval: delivery needs the user's `manualApproval`.

## Production constraints

- Paid operations need a checked budget and authorised spending. Never interpret an unknown price as free. In a no-live-API session, use existing/imported/synthetic assets and leave generation explicitly pending.
- Use generation scripts rather than ad hoc provider calls; parse `{ok, outputs, metadata, error, retryAfterMs}`. Progress belongs on stderr. Caller/validation errors stop; network/timeouts may retry with bounded backoff. Never blindly resubmit an ambiguous paid job.
- Choose presenter audio deliberately: embedded presenter audio must not also mount scene TTS. Align captions against the audio actually delivered. Native presenter generation is followed by deferred alignment after verified media exists: voice-producer runs after talking-head and before the render. A TTS skip leaves missing alignment/caption evidence pending; use valid supplied timings or explicitly authorised budgeted alignment, never a paid call under no-spend instructions.
- Use the generic project renderer with canonical `project.json`. Preserve legacy custom compositions. Read the Remotion skill for frame-based animation and media handling; previews are not evidence of successful export.
- Use `pnpm timeline:edit` for reversible track edits, `pnpm asset:import` for harness originals, `pnpm entity:card` for pinned world refs and `pnpm resources` for rights-aware discovery. An explicit `--audio-master` render replaces every original audio layer with the locally measured master.
- Run pipeline preflight before render. Inspect event/boundary screenshots and final sound. QA records actual defects, fixes and evidence; do not approve a missing asset, black tail, duplicate voice or broken caption timing.

Return the deliverable paths, requested formats, QA findings and the cost report. Distinguish local estimates from provider billing and local contract verification from live model acceptance.

For supplied-input ad, lesson, recut and shorts decisions, read the selected [worked production example](references/worked-production-decisions.md). It connects source evidence, motivated camera/cuts, original imports, style packs, captions and targeted repair; the examples do not establish approvals or audience outcomes.

Keep `pipeline/spine.md` from [the template](references/spine-template.md): read it before each render attempt and add to it after.

## Modern production and final delivery

When original media, spoken scripts/timings and reviewed selections are already supplied, route product ads and sourced lessons through the concrete [local workflows](../../../docs/workflows.md). Recuts and shorts of the user's own recording start from `pnpm footage:next`, which emits the `video:workflow` steps itself. `pnpm video:workflow` plans by default; creation and chapter assembly are local only. Keep the workflow's required timeline mode, frozen source/context and human delivery gates. A materialized project or series commit is not an approval. For changed shorts content, derive a newly reviewed series rather than editing its frozen selection.

Route new asset plans through [exact modern model requests](../../../docs/production-model-routing.md); prefer approved reuse and original harness imports. Legacy aliases retain their old routing and are never silently upgraded. Asset-plan schema acceptance alone does not validate provider input: inspect the exact operation dry-run, quote, reference pins, region, audio and durable budget headroom. A no-spend session leaves paid operations pending.

Use `pnpm exec tsx scripts/import-font-resource.ts --help` for licensed local font/icon resources; create validated font context with semantic roles and render with `--font-context` when needed. Keep originals and licence evidence. The official MCP stdio bridge exposes whitelisted existing CLI tools; inspect its tool schemas and results, not arbitrary shell commands. Its default no-spend policy remains active unless the trusted harness explicitly enables paid actions and the underlying policy admits them.

For requested delivery, read [strict local delivery](../../../docs/delivery.md) and run `pnpm exec tsx scripts/delivery.ts --help`, prepare the strict request with formats, clean/captioned variants, placements and explicit loudness/peak/audio requirements, then `--action snapshot --request REQUEST.json`. Render against that approved source/story snapshot, retaining hash-bound render receipts, visual reviews and rights/claims evidence. Run `--action check --request REQUEST.json --snapshot SNAPSHOT.json`; parse its envelope and retain failed QA reports. Do not claim `production-ready` for `draft-needs-review`, missing required approval events, unresolved paid liability or missing review evidence. The successful production package is immutable and contains release.json, media, checksums, credits and requested sidecars. These production gates do not create additional software-development approval gates.
