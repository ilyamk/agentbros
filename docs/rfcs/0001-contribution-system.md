# RFC 0001: Open contribution system

Status: decisions agreed 2026-11-15; phases 0-prep to 8 implemented and merged into main (2026-11-15). A `ready` playbook without `benchmarks` is a warning (`pnpm playbook --check --strict-benchmarks` makes it an error) until every ready playbook has a task; eight still lack one. Pending, needing the maintainer: a live test in a GitHub sandbox repository, the triage and benchmark-judging spend caps, and the cutover to `ilyamk/agentbros`.
Date: 2026-11-15
Repository: [ilyamk/agentbros](https://github.com/ilyamk/agentbros)
Owner: the maintainer (`@ilyamk`)

This RFC turns Agent Bros. Pictures from a single-owner working copy into a public repository that people and their agents can fork, improve and send pull requests to, autonomously, without flooding the maintainer with low-value work and without loading the context of agents that are making videos. It covers:

1. the public repository and how it starts;
2. how instruction files load into agents' context and how we keep them lean;
3. the contributor protocol for autonomous agents;
4. the categories of contribution and what makes each one valuable;
5. the gates a pull request passes before the maintainer sees it, and the security model;
6. how many contributors work in parallel without merge conflicts;
7. inventory metrics and the quality benchmark;
8. the showcase gallery and contributor profiles;
9. releases;
10. GitHub configuration and workflows;
11. the implementation plan, phase by phase, with tests and acceptance criteria.

Every link and slug in this RFC and in everything it creates uses `ilyamk/agentbros`, the name the public repository will carry.

---

## 1. Decisions

Taken with the maintainer on 2026-11-15. A change to one of them is a new RFC or an amendment recorded here.

| # | Question | Decision |
|---|---|---|
| D1 | Private and public versions | **Public from scratch.** `ilyamk/agentbros` starts from a clean tree built by `pnpm export:public --git`; the current private repository (2114 commits) is archived and receives no further work. All new work happens in the public repository. |
| D2 | Private material | **Stays local and git-ignored** at the same paths (`docs/workstreams/`, `docs/*-plan.md`, `docs/verification/`, `docs/archive/`, `design-reference/{videos,screenshots,bg-patterns,device-mockup}/`). Development plans become public RFCs in `docs/rfcs/`. |
| D3 | CI platform | **GitHub Actions only.** `.gitlab-ci.yml` is removed. |
| D4 | Versioning | **0.x until the contracts stabilise.** The public launch is `0.1.0`; a breaking change bumps the minor, everything else the patch. `1.0.0` is a deliberate, separately announced event. |
| D5 | Quality metrics policy | **A public creative rating is allowed, with limits.** Blind pairwise comparisons, Bradley–Terry ratings with confidence intervals, the noise floor published beside every number, judges admitted only after calibration. **Sound is never judged by an LLM**: measured audio plus a human panel. This amends the "no numerical artistic score" line of [craft evaluation](../craft-evaluation.md), which keeps holding for `craft:evaluate` itself. |
| D6 | Benchmark funding | **Sponsored runs.** Contributors run benchmark cells with their own harness subscriptions and keys and submit result bundles. Bundles are signed by the submitter's GitHub-registered key. The official table counts a community bundle only after the maintainer re-checks it deterministically and reproduces a random sample. Creative judging needs keys the submitter cannot influence; who pays for it and the monthly cap are **undecided** (§14). |
| D7 | LLM triage of pull requests | **Two vendors** (one Claude model, one OpenAI model) judge each pull request independently, reading the diff as data and never running fork code. Disagreement adds `triage:needs-human`. Spend cap about USD 0.50 per pull request. |
| D8 | What happens to slop | **Automatic closing only for deterministic reasons** (§6.4). An LLM verdict only labels a pull request and moves it out of the maintainer's queue. Every closure explains itself and offers `/appeal`. |
| D9 | Showcase media | **Release assets plus GitHub Pages.** `main` holds only `showcase.json` files; thumbnails and preview clips are uploaded by a bot to a dedicated `showcase-media` release; the gallery site is published on Pages. |
| D10 | Licence agreement | **Own CLA workflow plus an AI clause.** The human who owns the GitHub account signs once by comment; contributions their agents make on their instruction count as theirs. The CLA was finalised on 2026-11-16, before the repository went public; version 2.0 (2026-11-17) accompanies the move to the Business Source License 1.1. |
| D11 | Freedom of autonomous agents | **Trust tiers** (§5.4): a newcomer has at most two open pull requests and S or M tasks only; three merged pull requests unlock more; slop closures lower the tier. |
| D12 | Release cadence | **Threshold plus time.** A release pull request is always open; the bot marks it ready at 15 or more change entries, any breaking change, or 14 days after the last release with at least one entry. Security fixes release at once. The maintainer merges it. |
| D13 | Supported harnesses | **Claude Code and Codex** are the officially supported harnesses: behavioural instruction tests, benchmark matrix rows and instruction adapters exist for these two only. Other harnesses are out of scope until a new RFC. |
| D14 | Recognition | **Profiles and release credits.** Contributor profiles with automatically computed statistics per category, credits in every release and on the site, category badges. No leaderboard by pull-request count. |
| D15 | Field data | **Manual, late.** No automatic telemetry. A later `pnpm field:report` builds an anonymised summary the user chooses to attach to a showcase or an issue (phase 8). |
| D16 | Where this plan lives | This file, the first public RFC and the template for large contributions. |
| D17 | Repository name | `ilyamk/agentbros` in every link, badge, template and workflow. |

---

## 2. Current state (2026-11-15)

What exists and is reused:

- **Public tree builder.** `pnpm export:public` (`scripts/export-public.ts`, `src/lib/leak-scan.ts`, `public-export.json`): denylist with reasons, import closure, leak scan of paths and contents, `--git` for a one-commit repository. It becomes the launch tool (phase 0) and its scanner becomes a CI gate.
- **Upstream channel from users.** `pnpm memory:upstream` exports an applied memory proposal as leak-scanned patch files and a generalised `PR.md`; `ref:contribute` does the same for reference analyses ([contributing references](../contributing-references.md)).
- **Instruction discipline.** `tests/agents-md.test.ts` enforces size budgets (root 17 KiB, areas 24 KiB, sub-areas 10 KiB, a shrinking list), `Last updated` dates, link resolution, `CLAUDE.md` as a one-line import.
- **Registries.** 171 package scripts with a command registry carrying a spend class (`src/lib/cli/commands.ts`, `pnpm commands`), 130 library blocks (`docs/library/catalogue.json`, generated), 17 playbooks with `playbook.json` (each has a `benchmarks` field, empty everywhere), 24 agents, 32 skills, `CREDITS.md`, `inspiredBy`.
- **Quality machinery.** `creative:bench` (merged blind pool, three fresh judges, measured noise floor: [creative benchmark](../creative-benchmark.md)), hash-pinned rubric versions (`src/lib/film/creative-rubric.ts`), `craft:evaluate` with pinned manifests and human-declared reviews, sensors (`plan:check`, `film:measure`, `motion:check`, the slop catalogue), `judge:calibrate`, `ref:degrade`, a 22-film reference corpus, strict delivery manifests with source and render identity, the cost ledger (`budget`, `cost:report`), `library:usage`, memory metrics (`approved`, `rejected`, `round`, `sensor-fail`, `spend`, `delivered`).
- **Tests.** 372 test files; `pnpm check`; `test:fast` with a measured slow list; environment-gated browser, render and model suites.
- **Contribution paperwork.** `CONTRIBUTING.md`, the CLA (final since 2026-11-16; version 2.0 since 2026-11-17), the licence. Since 2026-11-17 the repository is source-available under the Business Source License 1.1 (`LICENSE`): free production use for individuals, organisations of up to three people and non-profits, a [commercial licence](../../COMMERCIAL-LICENSE.md) for everyone else, and each version converts to AGPL-3.0-or-later four years after its first public release. Python that runs inside Blender is GPL-3.0-or-later (`LICENSES/GPL-3.0-or-later.txt`); third-party components are listed in [NOTICE.md](../../NOTICE.md); the names and logos follow [TRADEMARKS.md](../../TRADEMARKS.md).

What is missing or blocks open contribution:

| Gap | Consequence |
|---|---|
| `export:public --git` makes a new one-commit repository each time | Nothing stable to fork; resolved by D1 (one launch, then the public repository is canonical) |
| No GitHub workflows, only `.gitlab-ci.yml` | No gates on pull requests |
| Root `AGENTS.md` is 17 319 of 17 408 bytes; of 17 playbook files, 6 are within 30 bytes of the 10 KiB cap and 13 within 250 bytes; `scripts/AGENTS.md` 20 KiB, `src/lib/AGENTS.md` 17 KiB, `src/motion/AGENTS.md` 15 KiB | No room for any new rule without a cut |
| Every session loads the root file plus the descriptions of 32 skills (6 363 bytes) and 24 agents (7 164 bytes): about 31 KB, roughly 8k tokens before any task | Context cost is not measured or gated |
| Generated aggregates are tracked (`catalogue.json` with `sourceHash`, the playbook index between markers, the command catalogue in `scripts/AGENTS.md`), plus the single `CREDITS.md` table, `Last updated` lines and hard-coded README numbers (17 / 130 / 24) | Guaranteed merge conflicts once several contributors work in parallel |
| `public-export.json` stores private client names and the owner's handle as sha256 of lower-case words | Short words in a public file can be recovered by dictionary attack; must not ship publicly |
| 394 verification records and about 30 Markdown files linking into `docs/verification/` | Those links dangle once the folder is git-ignored |
| No change log, no release tooling, version `1.0.0` while in early access | No releases |

---

## 3. Public repository and launch (D1, D2, D3, D17)

### 3.1 Launch sequence

1. **Clean the source.** In the private working copy:
   - fix every `references` entry `export:public --dry-run` reports (dangling links into denied paths): replace links to `docs/verification/*` with a sentence or drop them; replace links to `*-plan.md` with links to the guides their `Status:` line names;
   - move private names and the owner handle out of `public-export.json` into a git-ignored `leak-patterns.local.json` (§6.6); the tracked config keeps only generic patterns (home paths, worktrees, e-mail addresses, keys);
   - rewrite or drop machine-pinned tests that `denyByContent` excludes, so the public suite is the full suite;
   - rebrand leftovers: `~/.cache/ai-video-creator` → `~/.cache/agentbros` (with a one-time migration that moves an existing cache), the MCP server key in `docs/mcp.md`, `author: "ai_video_creator sfx-synth"` in `public/shared/sfx/*/manifest.json`, `docs/publishing.md` paths;
   - set `package.json` `version` to `0.1.0`;
   - extend `.gitignore` with every D2 path so they stay on disk and out of git.
2. **Build.** `pnpm export:public --output ../agentbros --git`; zero `hits`, zero `brokenImports`, zero `references`.
3. **Verify the tree** as [publishing](../publishing.md) describes: fresh install, `pnpm check`, `pnpm test:browser` where possible, `pnpm preflight`.
4. **Create** `ilyamk/agentbros` (private at first), push, configure GitHub (§10), run all workflows green, then publish.
5. **Switch the working copy.** The maintainer's checkout points `origin` at `ilyamk/agentbros`; the old repository is archived read-only. The D2 folders are kept as they are on disk.
6. **Retire the export tool's publishing role.** `export:public` stays as `pnpm leak:check` (tree mode, used in CI and in a pre-push hook) and the launch tool is documented as history in `docs/publishing.md`.

### 3.2 What changes in the rules

- `docs/AGENTS.md`: the Plans and Evidence rows say the folders are local and git-ignored; RFCs are public.
- Root `AGENTS.md` repository map: `docs/` lists `rfcs/`.
- `tests/harness-only.test.ts` keeps forbidding project material; a new test fails if any D2 path is tracked.

---

## 4. Instruction context

### 4.1 How context forms

**Proven by this repository's own rules.**
- Agents start at the repository root.
- `CLAUDE.md` is the one-line import `@AGENTS.md`, so Claude Code loads the root `AGENTS.md` at session start.
- Started at the root, Codex loads only the root file, capped at 32 KiB.
- Nested `AGENTS.md` files are opened on demand, because next-step answers (`pnpm next`, `film:brief`) and the root table name them.

**To verify in phase 2, not assumed** (recalled harness behaviour or unknown):
1. Whether Codex concatenates `AGENTS.md` files from the root down to the working directory when started in a subfolder.
2. Whether skills cost their name and description in every session and their body only when invoked, in each harness; whether agent definitions cost their description in every orchestrator session.
3. Whether Claude Code auto-loads a nested `CLAUDE.md` or `AGENTS.md` when it reads files in that folder.
4. What a Claude Code subagent receives: its own definition only, or the project memory as well.
5. Whether Codex reads `.agents/skills` descriptions at start and how they count against its limits.
6. Whether either harness re-reads instruction files after a context compaction.

**Method: a canary probe** (`pnpm context:probe`, phase 2).
- In a temporary worktree, plant a unique token in each candidate file: root, a nested `AGENTS.md`, a subagent definition, a skill body.
- Start each harness and, without allowing file reads, ask which tokens it knows. Repeat inside a subagent.
- The result is a dated record in `docs/context-loading.md`. That guide becomes the reference for every rule below and is re-run when a harness version changes.

### 4.2 Budgets measured, not guessed

`pnpm context:budget` computes, offline and deterministically:

| Measure | Definition |
|---|---|
| **Boot context**, per harness | Root `AGENTS.md` + skill descriptions + agent descriptions + MCP server instructions declared in `.mcp.json` (bytes and an estimated token count from a pinned tokenizer) |
| **Step context**, per playbook × step | Everything a next-step answer tells the agent to read at that step: the playbook's `AGENTS.md` and `read` files, the area guides `film:brief` names. Taken from the same functions that build next-step answers, so it cannot drift |
| **Subagent context**, per leaf agent | Its definition plus the brief `film:brief` would print for its step, on the fixture project |
| **Contributor context** | `CONTRIBUTING.md` + `contrib/AGENTS.md` + one category card |

The output is `out/context/budget.json`, plus a Markdown table posted on every pull request that touches instructions, showing deltas against the base branch.

**Gates.**
- Existing byte caps stay as they are.
- Boot context may not grow without the `context-growth-approved` label from the maintainer.
- A step-context increase over 2 KB in any step needs the same label.
- "One in, one out" at a cap: a file at its limit grows only by an equal cut in the same file.

### 4.3 Deterministic hygiene checks (`pnpm instructions:lint`)

- **Duplicates.** Shingle similarity (word 8-grams) between every pair of instruction files and within a file. A paragraph that repeats another one elsewhere in the hierarchy fails unless it is a one-line pointer.
- **Dead references.** Every `pnpm <name>` and `scripts/...` must exist in `package.json` or the command registry. Every path must resolve. Every skill and agent named must exist.
- **Level.** A rule that names files of only one area must live in that area's file, not in the root. Detected from the paths and commands a paragraph names.
- **Dates.** A file changed in a commit carries that day's date. On pull requests the post-merge bot sets the date (§7).
- **Description lint.** Skill and agent descriptions each get a cap (600 bytes) and must state when to use them, not what they contain.

### 4.4 LLM review of instructions (`pnpm instructions:audit`)

This runs weekly on `main` and on pull requests that change instructions. It only reports, never edits, and uses both D7 vendors.

**Questions per section.**
- Which tasks read it, from the step-context map.
- Is it relevant to each of them?
- Is it filler, a restatement, outdated, or in conflict with another level?
- Does it belong one level lower?

**Output.** `out/context/audit.json`, a nightly issue "Instruction audit" with ranked findings, and labels on pull requests. Findings feed `category:instructions` opportunities in the scout (§5.2).

### 4.5 Behavioural tests of instructions (`bench/instructions/`)

A small suite of agentic tasks with checkable outcomes, run in Claude Code and Codex only (D13). Examples:

- name the command that renders a bespoke film;
- add a trivial library block that passes `library:catalogue`;
- fix a seeded failing test;
- start a project for "a 20-second product promo" and stop at the first gate;
- refuse an unauthorised paid generation.

**Metrics.** Success, tokens, tool calls, rule violations (a forbidden import, a paid call, a tracked project file).

**Who runs it.** The maintainer, or a trusted runner under D6, before merging a change to the root file, an area file, a skill or an agent. The result bundle is attached to the pull request. A drop in success rate beyond the noise measured by repeating the suite blocks the merge.

### 4.6 Keeping contributor rules out of working agents' context

| Who | Loads |
|---|---|
| An agent making a video | Root file (one extra table row, ~120 bytes, §4.7), next-step reads. Never `contrib/` |
| A leaf subagent | Its definition and brief. Never `contrib/` |
| A contributor agent | Root file, `CONTRIBUTING.md`, `contrib/AGENTS.md`, one `contrib/categories/<id>.md`, the area `AGENTS.md` it changes |

No contribution skill is added, because a skill would put its description in every session. The entry point is the root table row and a short paragraph in the README section "For agents".

### 4.7 Making room in the root file

The root file has about 89 free bytes. Phase 2 frees space before anything is added:

- Move the "Project cleanup" section (≈1.6 KB) to a new `docs/cleanup.md` guide. The root keeps two lines: the repository is never a project store; use `pnpm project:remove` and `pnpm workspace:clean`.
- Fold "Keeping these files current" into four lines. Its detail (dates, rows, CREDITS, playbook naming) moves to `docs/AGENTS.md`.
- Add one row to the "Also" table: `| Improving the harness from a fork | [contrib/AGENTS.md](../../contrib/AGENTS.md); gates in [CONTRIBUTING.md](../../CONTRIBUTING.md) |`.

Target after phase 2: the root file at or below 15.5 KiB, a 1.5 KiB reserve.

---

## 5. The contributor protocol

### 5.1 Files

```
CONTRIBUTING.md                 humans and agents: licence, CLA, tiers, the short loop; "agents: read contrib/AGENTS.md"
contrib/AGENTS.md               protocol for an autonomous contributor (target ≤ 8 KiB)
contrib/categories.json         machine-readable categories: id, title, paths, gates, evidence, owner-review, default size
contrib/categories/<id>.md      one card per category (≤ 3 KiB): what is valuable, what is not, definition of done
contrib/pr-template.md          the body contrib:pr fills
.changes/<slug>.md              one change entry per pull request (§9)
docs/rfcs/NNNN-<slug>.md        large proposals (size L)
.github/ISSUE_TEMPLATE/*.yml    bug, opportunity, proposal (RFC), showcase, benchmark bundle
.github/pull_request_template.md the same block as contrib/pr-template.md
```

### 5.2 The autonomous loop

A user posts "give your agent the link to github.com/ilyamk/agentbros and ask it to find an improvement and contribute it". The agent then works through these steps.

1. **Fork and install.** Fork, clone, `pnpm install`, `pnpm preflight`. Read `CONTRIBUTING.md` and `contrib/AGENTS.md`.
2. **Find work.** `pnpm contrib:scout --json` returns ranked opportunities. Each has an id, category, size, why it matters, its evidence pointers, a definition of done, and open issues and pull requests that already cover it.
   - **Offline sources:**
     - playbooks in `draft` or with empty `benchmarks`;
     - provisional sensor thresholds;
     - files in the `SHRINKING` list;
     - `design-reference/reference-gap-matrix.md` and `gap-triage.md`;
     - blocks without previews or usage;
     - commands not named by any playbook;
     - categories with few tests;
     - instruction audit findings;
     - skipped tests;
     - providers without price evidence.
   - **Online sources, when `gh` is authenticated:**
     - issues labelled `agent-ready`;
     - open pull requests and claims, used to remove taken work;
     - the nightly needs board (`needs.json` on Pages).
3. **Choose and claim.**
   - **S** (≤ 300 changed lines, one category, no new dependency): go straight to a pull request.
   - **M** (≤ 1 000 lines): comment `/claim` on the opportunity issue. The bot assigns it and adds `claimed`; the claim lapses after 7 days without a linked draft pull request.
   - **L** (anything larger, new dependencies, new categories, contract changes): open a proposal issue with an RFC draft and wait for `design-approved`.
4. **Implement** in the fork, following the area `AGENTS.md` and the category card.
5. **Verify.** `pnpm contrib:check` runs the gates CI will run for the touched categories (§6), locally. It writes `.contrib/evidence.json` (git-ignored) with the commands, exit codes, summaries and context-budget deltas.
6. **Record the change.** `pnpm change:add` writes `.changes/<slug>.md`.
7. **Open the pull request.** `pnpm contrib:pr` prints the body from the template and the evidence. The agent opens it with `gh pr create`.
8. **Answer review.** The agent addresses bot comments; it may `/appeal` once per closure, with a reason.

What the agent must never do:
- spend money;
- call paid providers;
- commit project material or media binaries;
- change protected paths without `design-approved`;
- open more pull requests than its owner's tier allows;
- argue with the triage bot in loops.

### 5.3 The pull-request block

Every pull-request body starts with a machine-readable block that intake parses:

```md
<!-- agentbros:pr
category: library            # one id from contrib/categories.json
size: S                      # S | M | L
issue: 123                   # required for M and L
autonomy: autonomous         # autonomous | assisted | human
harness: claude-code         # claude-code | codex | other
model: <model id>
owner: <github handle of the accountable human>
change: .changes/hero-wipe-block.md
-->
```

It is followed by human-readable sections: what changed and why, evidence (from `.contrib/evidence.json`), what was not verified, and risks.

### 5.4 Trust tiers (D11)

Tiers are computed from GitHub history by the intake workflow; the maintainer can override them in `.github/trust.json`.

| Tier | Earned by | Open PRs | Sizes | Extra |
|---|---|---|---|---|
| 0 newcomer | default | 2 | S, M | no `instructions`, `harness` or `ci` categories |
| 1 contributor | 3 merged, slop share < 20 % | 5 | S, M, L with `design-approved` | all categories (owner review still applies) |
| 2 trusted | 10 merged, maintainer grant | 10 | all | may comment `/bench-lite`; may run hidden benchmark cells (§7.3) |
| 3 maintainer | — | — | — | merges, labels |

Two deterministic slop closures within 30 days drop the owner one tier for 30 days.

---

## 6. Gates and security

### 6.1 The funnel

Only pull requests that pass every gate get `ready-for-owner`; the maintainer's queue is that label.

| Gate | Runs in | Secrets | Blocks on |
|---|---|---|---|
| G0 accountability | `pr-intake` (pull_request) | none | No CLA signature for the owner; no PR block or invalid block; open-PR limit of the tier exceeded |
| G1 structure | `pr-intake` | none | Missing `.changes` entry; size over the tier or the declared size; paths outside the declared category (`contrib/categories.json`); more than one category; media binaries; leak scan hit; new dependency without `deps:` justification in the change entry; licence of new dependencies outside the allowlist; protected paths (§6.5) without `design-approved` |
| G2 correctness | `ci` (pull_request, merge_group) | none | `pnpm lint`, `pnpm typecheck`, full `pnpm test` sharded, browser and render suites, determinism lint, category gates (§6.2) |
| G3 value | `category-gates`, `context-budget` | none | A `fix` without a test that fails on the base branch; a block or playbook duplicate (§6.2); a new command or block that no playbook names; instruction growth without the label; generated artefacts that do not regenerate identically |
| G4 triage | `ai-triage` (workflow_run) | vendor keys | Never blocks; labels `triage:promising`, `triage:needs-work`, `triage:likely-slop`, `triage:needs-human` and posts one structured comment |
| G5 impact | `bench-lite` (label or `/bench-lite` by tier ≥ 2) | none in CI | Never runs automatically; posts no-spend benchmark deltas for affected playbooks from a sponsored bundle (§7) |
| Owner | maintainer | — | Merge through the merge queue |

### 6.2 Category gates

Each category declares its gate commands in `contrib/categories.json`; the full table is in §6.7.

- **library.**
  - `pnpm library:catalogue` regenerates identically.
  - A preview renders; the block passes the determinism lint and `motion:check` on its preview.
  - `inspiredBy` and a CREDITS entry exist when a source is named.
  - Novelty check: description similarity (TF-IDF cosine) and preview frames (perceptual hash) against the catalogue. Above the threshold the block must name the existing block it improves and why.
- **provider.**
  - Entries in `src/lib/pricing.ts` and the endpoint registry carry a dated price source.
  - Mock tests cover submit, poll, resume and failure. No network in tests.
  - Budget admission and job ownership follow `src/lib/AGENTS.md`.
- **playbook.**
  - Schema valid; `pnpm playbook --match` regression set unchanged for other playbooks.
  - Intake questions and `qa` items are concrete.
  - `benchmarks` is non-empty before `status: ready`.
- **sensor.**
  - The threshold carries `// calibrated on N references, <date>` or stays warn-only.
  - Run on `ref:degrade` copies proves the sensor ranks degraded below the original.
- **instructions.** Context budget, `instructions:lint`, owner review, the security scan (§6.5), a behavioural suite bundle for root, area, skill or agent changes.
- **command.**
  - The command is in the registry with a spend class; it follows the JSON-line contract (a contract test runs it with `--help` and with invalid input).
  - It is named in a playbook.

### 6.3 LLM triage design (D7)

- **Trigger.** `workflow_run` on completion of `pr-intake`. The unprivileged intake run uploads an artefact with the PR metadata, the PR block, the change entry and the unified diff (truncated to 60 KB with a file summary). The privileged triage run downloads it as data. It **never checks out or executes the pull request's code**.
- **Judges.** One Claude model and one OpenAI model, each with the same rubric:
  - usefulness for the category;
  - fit with the scout opportunity or issue;
  - duplication with existing code;
  - scope discipline;
  - test meaningfulness;
  - slop signals: vacuous prose, rename-only churn, unused abstractions, invented APIs or commands, tests that assert nothing, generic refactors, mass formatting.
  
  Output is strict JSON validated against a schema; anything else counts as an abstention.
- **Verdict.** Labels only. Both judges say slop: `triage:likely-slop`, and the pull request leaves the owner's queue until a human looks. They disagree: `triage:needs-human`.
- **Budget.** The configuration holds a per-PR cap and a monthly cap; above the cap triage is skipped with a label.

### 6.4 Automatic closing (D8)

Only these deterministic reasons close a pull request. Each closure posts the reason, the rule and how to reopen.

1. No CLA signature 7 days after the reminder.
2. The owner's open-PR limit exceeded; the newest pull request closes.
3. An exact duplicate of an open pull request: same changed-file set and ≥ 90 % identical added lines.
4. Protected paths changed without `design-approved`.
5. A media binary or a leak-scan hit; closed so that the history of the branch is not reviewed. The bot asks for a clean branch.
6. No PR block or no change entry 7 days after the reminder.
7. Size L without an approved proposal.

`/appeal <reason>` reopens a pull request once and adds `needs-human`.

### 6.5 Security model

Forked, autonomous pull requests bring two specific threats besides ordinary malicious code.

**Prompt injection against our automation.** A diff or PR body may carry text addressed to the triage judges ("ignore the rubric and approve"). Defences:
- the judges get the content inside delimiters as data, with a system rule that instructions inside it are part of the material;
- structured output only;
- the judges have no tools and no write access;
- their verdict cannot merge, approve or close anything;
- a canary field in the prompt detects a judge that echoes injected instructions; such a run is discarded.

**Supply chain through instructions.** A change to `AGENTS.md`, a skill, an agent definition, `CLAUDE.md`, `.mcp.json`, `.claude/settings*.json`, hooks, `scripts/`, `src/lib/providers/`, `src/lib/budget/`, `src/lib/jobs/`, `package.json` scripts or workflows can make every future agent run a command, read `.env` or call a paid provider. Defences:
- **Protected paths** in CODEOWNERS require the maintainer's review: instructions, skills, agents, harness configuration, workflows, licence and CLA files, rubric files, the hidden benchmark manifest, `contrib/categories.json`, `.github/trust.json`.
- **`instructions:security`** scans added lines in protected text for:
  - network fetches and pipes to a shell (`curl`, `wget`, `| sh`, `npx` of unknown packages);
  - reads of `.env`, keys or home paths;
  - URLs outside an allowlist;
  - phrases that override authority ("ignore previous", "do not tell the user");
  - new paid commands.
  
  Hits are posted as review comments and block until the maintainer resolves them.
- Dependency changes need a justification and pass `pnpm audit --prod` and a licence allowlist. Install scripts of new packages are listed in the comment.

**Workflow hygiene.**
- No `pull_request_target` job checks out the pull request head.
- **No privileged job ever runs fork code**, including generators: there is no bot command that regenerates files on a contributor's branch, because generators such as `library:catalogue` import the pull request's modules.
- `workflow_run` jobs treat artefacts as untrusted data. A fork can edit `pr-intake.yml` itself and upload a forged artefact, so the privileged jobs that label or close **re-derive the changed files, paths, size and binaries from the GitHub API** and never trust the artefact's verdicts.
- A pull request that touches `.github/**` can never receive `ready-for-owner` automatically; it always gets `needs-human`.
- Every workflow declares the least `permissions`; third-party actions are pinned by commit SHA.
- Vendor keys exist only in the `triage` environment, protected to `main`.
- Provider keys never exist in CI.

**Repository settings.** Secret scanning with push protection, Dependabot alerts and updates, CodeQL for TypeScript, private vulnerability reporting, `SECURITY.md`.

### 6.6 Leak protection after launch

- The tracked `public-export.json` keeps generic patterns only. Private names and the owner handle move to the git-ignored `leak-patterns.local.json`.
- A pre-push hook in the maintainer's checkout (`pnpm leak:check --local`) runs the full scan.
- CI runs `pnpm leak:check` on every pull request's added lines: home paths, worktree paths, e-mail addresses other than allowed ones, provider key formats, private-key headers.

### 6.7 Categories

`contrib/categories.json` is the single list. Ordered by value to the quality of the films the harness makes:

| id | What | Paths | Valuable when | Evidence required |
|---|---|---|---|---|
| `bench` | Benchmark tasks, judge calibration sets | `bench/` | A task is frozen, small, checkable, and covers a playbook with empty `benchmarks` | Task manifest validates; a reference run bundle |
| `sensor` | Sensors, validators, slop-catalogue checks | `src/lib/film/measure.ts`, `src/lib/qa/`, `design-reference/slop-catalogue.md`, … | It catches a real failure seen in films, with a calibrated threshold | `ref:degrade` ranking, calibration note |
| `library` | Motion library blocks | `src/motion/library/` | It fills a gap named by a playbook or the gap matrix, studied from a reference | Preview, determinism, novelty, playbook use |
| `playbook` | New playbooks, draft → ready | `playbooks/` | A real kind of request is uncovered or a draft gains benchmarks | Match regression, benchmarks |
| `provider` | Providers and API integrations | `src/lib/providers/`, `src/lib/pricing.ts`, endpoint registry | A capability the routes need, priced with evidence | Mock tests, price source, budget admission |
| `command` | CLI commands | `scripts/`, `src/lib/cli/` | A playbook step is manual today | Contract test, registry, playbook mention |
| `worker` | Python, Swift, Blender workers | `scripts/workers/`, `scripts/blender/` | Local, free alternative to a paid route | Pinned deps, gated test, fixture |
| `audio` | Analysis, mixing, SFX | `src/lib/audio/`, `public/shared/sfx` manifests | Measured improvement, never "sounds better" | Measurements before and after |
| `reference` | Reference analyses, technique cards | `design-reference/library/`, `design-reference/techniques/` | Structure-only, rights clean, used by a block or rule | `ref:contribute` output |
| `agent-skill` | Agents and skills | `.agents/` | Fixes an observed failure | Behavioural bundle, context delta |
| `instructions` | `AGENTS.md` files | `**/AGENTS.md` | Removes, merges or relocates more than it adds | Context delta, lint, audit, bundle |
| `harness` | Claude Code and Codex integration, MCP bridge | `.claude/`, `.mcp.json`, `src/mcp/` | Fewer steps or errors for agents | Behavioural bundle |
| `template` | Templates, text components, backgrounds, mockups | `src/templates/` | Template mode gains a reusable piece | Render test |
| `asset` | Shared asset manifests | `public/shared/**/manifest.json` | Licence-clean, needed by a playbook | Licence evidence; no binaries |
| `test-ci` | Tests, fixtures, CI | `tests/`, `.github/workflows/` | Covers an untested contract or speeds the suite | Failing-on-base proof or timing |
| `lesson` | Generalised lessons from `memory:upstream` | wherever the proposal points | A cause seen twice became a rule or sensor | The proposal's evidence, leak-clean |
| `fix` | Bug fixes | any | A reproducible bug | Test failing on base |
| `docs` | Guides, translations | `docs/`, `README.md` | Corrects or shortens | Link check |
| `showcase` | Showcase entries | `showcases/` | A real film made with the harness | `showcase:add` output (§8) |
| `security` | Security fixes | any | — | Private advisory first |

Each card in `contrib/categories/<id>.md` also lists what is **not** wanted. For example, for `library`: a re-skin of an existing block; a block no playbook can use; a block built from a third-party film's frames.

---

## 7. Working without conflicts

| Source of conflict | Resolution |
|---|---|
| `docs/library/catalogue.json` and its `sourceHash` | Pull requests may include it; the `post-merge-regen` workflow regenerates it on `main` after every merge. An unprivileged CI job checks that it regenerates identically. A conflict only in generated files is resolved by the contributor with `pnpm regen` (one command running every generator) after rebasing; no bot ever writes to a contributor's branch (§6.5) |
| Playbook index between markers, command catalogue in `scripts/AGENTS.md`, `docs/film-types.md` | Same: generated, regenerated after merge, `pnpm regen` locally |
| `CREDITS.md` single table | Split into `credits/<id>.json`, one file per source; `pnpm credits:write-doc` builds `CREDITS.md`, regenerated after merge |
| `Last updated` lines | Contributors do not edit them; `post-merge-regen` sets the date of every `AGENTS.md` changed in the merge. `tests/agents-md.test.ts` accepts a date up to 1 day older than the last commit that touched the file |
| README numbers (17 / 130 / 24) and badges | Generated from `metrics.json` between markers by `pnpm metrics --write-readme`, after merge |
| Change log | `.changes/<slug>.md` per pull request; never one shared file |
| Showcase index | One folder per showcase; the gallery index is built for Pages, not tracked |
| Two agents on the same opportunity | Claims (§5.2), scout de-duplication, the duplicate rule in §6.4 |
| Branch protection | Merge queue required on `main`; squash merges; linear history |

---

## 8. Metrics and the benchmark

Three layers, published separately so that one never stands in for another.

### 8.1 Inventory and health (deterministic, every merge and release)

`pnpm metrics` writes `out/metrics/metrics.json`, published to Pages and summarised in the README.

- **Raw counts.** Playbooks by status, blocks by category, commands by spend class, providers and endpoints, agents, skills, sensors, reference films, technique cards, templates, tests.
- **Verified capabilities.** These are the headline numbers; raw counts are listed but not headlined.
  - A block counts when it has a preview, a determinism test and at least one playbook or showcase use.
  - A provider counts when it has a price source and mock tests.
  - A playbook counts when it is `ready` with non-empty `benchmarks`.
  - A sensor counts when it is calibrated, not provisional.
  - A command counts when it is named by a playbook and has a contract test.
- **Health.** Test count and pass rate, suite duration (fast and full), lint and typecheck status, boot and step context per harness, instruction files over target, open slop share, median time to first review.
- **Release deltas.** The difference between two `metrics.json` snapshots goes into the release notes (§9).

### 8.2 Agent Bros Bench: what the product achieves

**Purpose.** Answer two questions honestly, each with the other variable held fixed:
1. Does the harness get better? Fixed model and harness, varying harness commits.
2. How do agents differ on the same harness? Fixed commit, varying harness × model.

**Suite** (`bench/`):
- `bench/tasks/<id>/task.json`: playbook, brief text, supplied material (licence-clean, small, fetched by manifest), constraints (format, length, no-spend or paid tier), the gates simulated as approvals with fixed answers (`bench/answers/<id>.json`), and checkable criteria.
- **Tiers.**
  - *No-spend:* local and free routes, playbooks that need no generation.
  - *Paid:* generation playbooks, each with a declared maximum cost.
- **Splits.** A public split anyone can run, and a hidden split whose manifests live outside the repository and run only by the maintainer or tier-2 trusted runners. Without a hidden split contributors would tune the harness to the public tasks.
- **Versioning.** The suite is versioned (`bench/suite.json` with a hash of every task); a change is a new version, never an edit, like the rubric.

**Runs** (`pnpm bench:run`):
- A cell is task × harness × model × harness commit.
- At least three runs per cell.
- The runner starts the harness in a clean worktree at the given commit, feeds the brief and the fixed gate answers, enforces a wall-time and token limit, and collects a **result bundle**:
  - final render and its delivery receipt;
  - the project footprint (minus binaries over a limit);
  - the harness transcript;
  - token and tool-call counts;
  - ledger spend;
  - environment (OS, harness version, model id);
  - hashes of everything.

**Scoring layers.**

| Layer | How | Who |
|---|---|---|
| Process | Completion rate (delivery check passes), steps, rounds, gate re-asks, rule violations, wall time, tokens, USD from the ledger | Deterministic, recomputed by CI from the bundle |
| Technical | Delivery check, loudness and true peak, sync and drift, `motion:check`, slop sensors, safe zones, readability measures | Deterministic, recomputed by CI |
| Creative (picture) | Blind pairwise comparison within one task: films stripped of metadata, shown in both orders. Panel of judges from two vendors. Ratings by Bradley–Terry with bootstrap 95 % intervals | LLM judges, admitted per calibration; a human panel on a sample |
| Sound | Measured audio from the technical layer plus human panel listening on a sample. No LLM verdict on sound (D5) | Humans |

**Honesty rules.**
- **Judge admission.** A judge model and prompt is admitted only if it ranks originals above their `ref:degrade` copies and agrees with the human panel on a calibration set beyond a set level. This extends `judge:calibrate`; it is re-checked on every judge or suite version.
- **Noise floor.** Every published delta shows the interval and the measured judge noise, computed with the method of the [creative benchmark](../creative-benchmark.md). A delta inside the noise is published as "no detectable change".
- **Pre-registration.** The protocol version, suite version, judges and analysis are fixed before a run campaign and published with it.
- **Raw data.** Bundles (minus restricted material), judgements and analysis scripts are published with every table.
- **Normalisation.** Quality per USD and per minute are reported beside absolute quality.
- **Contamination.** Judges never see harness, model or commit. Bundles are renamed by a random key held by the maintainer.

### 8.3 Sponsored runs (D6)

- Anyone can run public-split cells with `pnpm bench:run` and submit a bundle through the `benchmark bundle` issue form. A bot uploads the bundle to the `bench-bundles` release; large files go there too.
- **Signed bundles.** `bench:run` writes a manifest of every file's hash; the submitter signs it with an SSH key registered on their GitHub account (`ssh-keygen -Y sign`; Sigstore as an alternative). `bench-verify` checks the signature against the account's public keys, so every bundle is bound to an accountable person.
- `bench-verify` recomputes the process and technical layers from the bundle. A mismatch rejects the bundle.
- The maintainer (or a tier-2 runner) reproduces a random sample of each campaign's cells. A reproduction outside the noise marks the submitter's bundles `unverified` for that campaign.
- Labels in the published table:
  - `community` (verified deterministically);
  - `reproduced` (sample reproduced);
  - `maintainer` (hidden split or run by the maintainer).
- Creative judging and the human panel are organised by the maintainer, never by the submitter. Who pays for judging (maintainer keys, a sponsor's donated budget, or both) and its monthly cap are undecided (§14); the cap will live in `bench/config.json`.

### 8.4 Field data (D15, phase 8)

`pnpm field:report --project <id>` builds an anonymised summary of a project from memory metrics: rounds, approvals, sensor failures, spend, delivery. Nothing is sent; the user may attach it to a showcase or an issue.

---

## 9. Releases (D4, D12)

### 9.1 Change entries

`pnpm change:add` writes `.changes/<slug>.md`:

```md
---
category: library
bump: minor            # patch | minor | major (0.x: major is applied as minor)
breaking: false
pr: 0                  # filled by the bot after merge
authors: [handle]
harness: codex
---
New `wipe-diagonal` block: a diagonal wipe with motion blur, studied from …
```

Intake validates it. `post-merge-regen` fills `pr`.

### 9.2 Detecting the bump from the code

`pnpm api:surface` writes `docs/api/surface.json`:
- commands and their flags (from the command registry and each script's specs);
- the JSON-line contract;
- every exported Zod schema as JSON Schema;
- library block ids and props;
- MCP tools;
- playbook ids;
- environment variables read.

`pnpm release:plan` compares the surface of `main` with the last tag:
- removed or narrowed items are breaking;
- added items are a minor;
- the rest is a patch.

If a change entry declares less than the surface shows, intake fails with the diff.

### 9.3 Release flow

1. `release-pr` workflow, on every push to `main`: aggregates `.changes/*.md` into the release pull request.
   - Contents: version, notes grouped by category, breaking changes with migration notes, contributors with links to their profiles, metrics deltas (§8.1), context deltas, new showcases, the latest benchmark campaign if one ran.
   - **Ready criteria (D12):** ≥ 15 entries, any breaking entry, or 14 days since the last release with ≥ 1 entry. When ready, the bot adds `release:ready` and mentions the maintainer.
2. The maintainer merges it. For a minor release, a benchmark campaign is advised; a missing one is stated in the notes.
3. `release` workflow on merge:
   - bumps `package.json`;
   - deletes consumed `.changes/*.md`;
   - writes `CHANGELOG.md`;
   - tags `vX.Y.Z`;
   - creates the GitHub Release with the notes and `metrics.json`;
   - publishes the site.
4. Security fixes: a `security` change entry makes the release pull request ready at once.

---

## 10. Showcase gallery and community (D9, D14)

### 10.1 Showcase entries

`showcases/<slug>/showcase.json`, validated by `src/types/showcase.ts`:

- **Film:** `title`, `summary`, `language`, `format`, `durationSec`, `playbook`, `route`, `filmType`, `libraryBlocks` (from `library:usage`).
- **How it was made:** `harness` (`claude-code` | `codex`), `model`, `harnessVersion` (tag or commit of `ilyamk/agentbros`), `wallTimeMin`, `rounds`, `userInterventions`.
- **Budget:** `budget.totalUsd` and `budget.byProvider[]` (from `cost:report`), `budget.subscriptionNote` (harness subscription costs are declared, not inferred).
- **Settings:** brief excerpt, music route, voice, references used (structure only), key `motion-plan` choices.
- **Author:** `author.handle`, `author.displayName`, `author.links[]`, `author.credits` (their regalia, free text, length-capped).
- **Links:** `links[]` (YouTube, X, TikTok, Instagram, Vimeo, own site).
- **Rights:** `rights` (declaration that the author holds the rights to every piece of material and the publication); `licence` of the entry text.
- **Evidence:** `evidence.deliveryReceiptHash`, `evidence.snapshotId`, `verification` (below).
- `media` (filled by the bot): thumbnail, contact sheet and preview-clip URLs in the `showcase-media` release.

**Verification levels:**
- `declared`: the author's word;
- `receipt`: a delivery receipt from a tagged harness version matches the declared render hash;
- `maintainer`: the maintainer watched it and checked the links;
- `reproducible`: inputs are public and a re-run is possible.

`pnpm showcase:add --project <id>` builds the entry from the project footprint:
- reads the delivery receipt, `cost:report`, `library:usage`, the brief and memory metrics;
- leak-scans and strips private text;
- renders a 1280-px thumbnail, a contact sheet and a ≤ 10 s muted preview clip into `out/<id>/showcase/` (not tracked);
- prints the pull-request body.

The `showcase` workflow uploads the media to the `showcase-media` release on merge and writes the URLs into the entry.

### 10.2 The site

GitHub Pages at `https://ilyamk.github.io/agentbros/`, built from the tracked data by a small static generator. Pages:

- **gallery:** filter by playbook, harness, model, budget, length, verification;
- **showcase detail:** media, technical and budget card, settings, links, author;
- **contributors;**
- **metrics:** inventory, health, context;
- **benchmark tables:** with intervals and data downloads;
- **needs board:** scout opportunities;
- **release history.**

The README section "Now Showing" lists the latest verified showcases, generated after merge.

### 10.3 Contributor profiles and credits (D14)

- `community/contributors/<handle>.json`: display name, links, short bio, free-text credits. It is written by the contributor; everything else is computed.
- **Computed statistics:**
  - merged pull requests by category;
  - blocks authored and their use in showcases;
  - showcases;
  - benchmark bundles reproduced;
  - instruction bytes removed.
- **Badges** are computed per category (first block, ten blocks, calibrated sensor, and so on).
- **Credits.** Every release lists contributors by category in the studio's "credits" style; the site keeps a cumulative credits page.
- No ranking by pull-request count.

### 10.4 Community channels

- **GitHub Discussions:** Ideas, RFCs, Showcase, Q&A, Benchmark.
- `CODE_OF_CONDUCT.md` (Contributor Covenant), `SUPPORT.md`.
- `GOVERNANCE.md`: who maintains, how tiers work, how decisions and RFCs are taken.

---

## 11. GitHub configuration and workflows

### 11.1 Repository settings

- **Default branch protection:** `main` through a ruleset. Required:
  - checks: `pr-intake`, `ci`, `category-gates`, `context-budget`;
  - the merge queue;
  - CODEOWNERS review for protected paths;
  - squash merge only;
  - no force pushes.
- **Labels:** `category:*`, `size:*`, `tier:*`, `triage:*`, `claimed`, `agent-ready`, `design-approved`, `ready-for-owner`, `needs-human`, `context-growth-approved`, `release:ready`, `bench-lite`, `security`.
- **Environments:** `triage` (vendor keys, `main` only), `release` (the `agentbros-release` App key, `main` only), `pages`.
- Discussions on, private vulnerability reporting on, secret scanning push protection on, Dependabot on.

### 11.2 Workflows

| Workflow | Trigger | Permissions and secrets | Does |
|---|---|---|---|
| `pr-intake.yml` | pull_request | read; none | G0–G1; uploads the triage artefact; posts a status comment |
| `ci.yml` | pull_request, merge_group, push main | read; none | lint, typecheck, `test:fast`, full tests sharded across 4 Ubuntu jobs, browser and render suites (Chrome + FFmpeg), macOS job for Swift workers |
| `category-gates.yml` | pull_request | read; none | Path-filtered category jobs from `contrib/categories.json`; failing-on-base proof |
| `context-budget.yml` | pull_request (instruction paths) | read; none | `context:budget`, `instructions:lint`, `instructions:security`; uploads the comment artefact |
| `pr-comment.yml` | workflow_run of the above | pull-requests: write; none | Posts the comments the unprivileged runs prepared (as data) |
| `ai-triage.yml` | workflow_run of `pr-intake` | pull-requests: write; `triage` env | Two-vendor triage (§6.3) |
| `autoclose.yml` | schedule (hourly), workflow_run | pull-requests: write | Applies §6.4 rules and reminders; claim expiry |
| `commands.yml` | issue_comment | issues/pull-requests: write; no checkout | `/claim`, `/unclaim`, `/appeal`, `/bench-lite` (tier-checked); labels and assignments only |
| `cla.yml` | pull_request, issue_comment | pull-requests: write; contents: write on the `cla-signatures` branch only | Checks signatures, records a signature comment |
| `post-merge-regen.yml` | push main | contents: write; release env | Regenerates catalogues, indexes, `CREDITS.md`, dates, README markers; fills change-entry PR numbers; one bot commit |
| `release-pr.yml` | push main | contents, pull-requests: write | Maintains the release pull request (§9.3) |
| `release.yml` | release pull request merged | contents: write | Tag, Release, changelog, metrics |
| `pages.yml` | push main, release | pages: write | Builds the site from tracked data and the media releases |
| `showcase.yml` | showcase PR merged | contents: write | Uploads media to `showcase-media`, writes URLs |
| `bench-verify.yml` | bundle issue labelled | issues: write | Re-computes deterministic layers of a submitted bundle |
| `nightly.yml` | schedule | issues: write; `triage` env for audit | `metrics`, `contrib:scout` → `needs.json`, `instructions:audit`, stale claims, dependency licence report |
| `codeql.yml` | schedule, pull_request | security-events: write | CodeQL |

Third-party actions are pinned by SHA. Every workflow has a test in `tests/workflows.test.ts` that parses it and asserts:
- its `permissions`;
- no `pull_request_target` with a checkout of the head;
- secrets only inside protected environments;
- actions pinned.

---

## 12. Implementation plan

**Order (amended 2026-11-15).** Everything is built and tested in the current working copy first, on the branch `contrib-system`; the move to `ilyamk/agentbros` with one initial commit comes last. Phase 0 is therefore split: its preparation tasks (references, leak patterns, test completeness, rebrand, ignores, version, CI) run with the other phases, and its cutover tasks (build, verify, create the repository, archive the old one) run after phases 1–8. Pieces that only GitHub can exercise (fork pull requests, `workflow_run`, the merge queue, Pages, releases, the CLA bot) are tested locally with fixtures and workflow lint, then live on a throwaway private sandbox repository before the cutover; the repository goes public only after that. Every phase ends with its guide written and the matching `AGENTS.md` rows updated in the same commits, per the root rules.

### Phase 0: launch the public repository (D1–D3, D17)

| Task | Output | Tests and acceptance |
|---|---|---|
| Fix dangling references to denied paths | Guides without links into `docs/verification/` or `*-plan.md` | `export:public --dry-run` reports `references: []` |
| Move private leak patterns local | `leak-patterns.local.json` (ignored), loader merging it when present | `tests/leak-scan.test.ts`: local file used when present, tracked config has no hash patterns |
| Public suite completeness | Machine-pinned tests rewritten or deleted | `export:public` denies no test by content |
| Rebrand leftovers | Cache dir `~/.cache/agentbros` with migration, MCP key, SFX manifest author, publishing doc | Migration test with a temp home |
| Ignore D2 paths | `.gitignore` entries; test that none is tracked | `tests/harness-only.test.ts` extended |
| Version | `package.json` `0.1.0` | — |
| Minimal CI | `ci.yml` (lint, typecheck, full tests, `test:browser`), delete `.gitlab-ci.yml` | Green on the exported tree |
| Build, verify, create `ilyamk/agentbros`, archive the old repository | Public repository, private until phase 4 ends | Fresh-clone install and `pnpm check` pass |

Exit: the maintainer works only in `ilyamk/agentbros`.

### Phase 1: security baseline and intake (G0, G1)

| Task | Output | Tests and acceptance |
|---|---|---|
| CLA with AI clause, final text | `CLA.md` final, `cla.yml`, `cla-signatures` branch | Workflow test; a signature comment is recorded; an unsigned PR is blocked |
| CODEOWNERS and protected paths | `.github/CODEOWNERS`, `contrib/protected.json` | Test that every protected glob matches at least one file |
| Categories registry | `contrib/categories.json` + schema in `src/types/contrib.ts` | Every tracked file maps to at least one category; categories' gates name existing commands |
| PR block and change entries | `src/lib/contrib/pr-block.ts`, `pnpm change:add`, schema | Parser tests including malformed blocks |
| `pr-intake.yml` with G0–G1 | `scripts/contrib-intake.ts` (JSON-line CLI, runs locally too) | Fixture PRs: wrong category paths, binary, oversize, missing entry, protected path |
| `leak:check` | Tree and added-lines modes | Tests with planted hits |
| `instructions:security` | Scanner over added lines in protected text | Fixtures for each pattern class |
| Workflow lint | `tests/workflows.test.ts` | Fails on an unpinned action or a head checkout under `pull_request_target` |
| Repository settings | Ruleset, labels (`.github/labels.json` + sync script), environments, `SECURITY.md` | Settings recorded in `docs/github.md`; label sync idempotent |

### Phase 2: context hygiene (§4)

| Task | Output | Tests and acceptance |
|---|---|---|
| Canary probe | `pnpm context:probe`, `docs/context-loading.md` with dated results for Claude Code and Codex | The six open questions of §4.1 answered with evidence |
| Root file reserve | `docs/cleanup.md`, shorter "Keeping these files current", contrib row | Root ≤ 15.5 KiB; test budget unchanged |
| `context:budget` | `src/lib/context/budget.ts`, CLI, `context-budget.yml` | Step map built from next-step functions on fixture projects; snapshot test; PR comment fixture |
| `instructions:lint` | Duplicates, dead references, level, descriptions | Seeded fixtures; current tree passes or gets a tracked baseline that may only shrink |
| Description caps | Skill and agent descriptions ≤ 600 bytes | Test in `agents-md.test.ts` |
| Shrink the shrinking list | `scripts/AGENTS.md`, `src/lib/AGENTS.md`, `src/motion/AGENTS.md` to 12 KiB targets | `SHRINKING` entries removed |
| `instructions:audit` | Two-vendor audit, nightly issue | Dry-run mode with recorded responses in tests |
| Behavioural suite v1 | `bench/instructions/` (8–12 tasks), `pnpm instructions:eval` producing a bundle | Runs in both harnesses; repeat noise measured and recorded |

### Phase 3: contributor protocol (§5)

| Task | Output | Tests and acceptance |
|---|---|---|
| `CONTRIBUTING.md` rewrite | Humans and agents, tiers, loop | Link test |
| `contrib/AGENTS.md` and 20 category cards | ≤ 8 KiB and ≤ 3 KiB | Size tests; each card names its gates from `categories.json` |
| `contrib:scout` | Offline sources + `gh` sources, ranked JSON | Fixture repository with known gaps; de-duplication against fake open PRs |
| `contrib:check` | Runs category gates locally, writes `.contrib/evidence.json` | Same gate set as CI, verified by a test comparing both lists |
| `contrib:pr` | Body from template and evidence | Snapshot test |
| Issue forms and PR template | `.github/ISSUE_TEMPLATE/*`, `pull_request_template.md` | YAML schema test |
| Comment commands | `commands.yml`: `/claim`, `/unclaim`, `/appeal`, `/bench-lite` | Unit tests of the command parser and tier checks |
| `pnpm regen` | One command running every generator | Running it twice changes nothing |
| Dry run with real agents | A Claude Code and a Codex session given only the repository link | Each produces a pull request that passes G0–G3 without human help; frictions become fixes |

### Phase 4: value gates, triage, conflicts (§6, §7)

| Task | Output | Tests and acceptance |
|---|---|---|
| Category gates | `category-gates.yml`, failing-on-base job, novelty checks for blocks and playbooks | Fixtures: duplicate block, fix without failing test |
| `ai-triage.yml` | Two judges, schema, caps, canary | Recorded-response tests; injection fixtures do not change the verdict schema or labels beyond `needs-human` |
| `autoclose.yml` | §6.4 rules, reminders, appeal | Rule-by-rule tests on fixture events |
| Trust tiers | Tier computation + `.github/trust.json` override | Tests on synthetic histories |
| Conflict removal | `credits/*.json` + `credits:write-doc`; `post-merge-regen.yml`; date rule; README markers | Two fixture branches adding blocks merge cleanly in a merge-queue simulation |
| Merge queue on | Ruleset updated | — |
| **Go public** | Repository made public, announcement post | Phases 0–4 green; CLA legally reviewed |

### Phase 5: metrics and releases (§8.1, §9)

| Task | Output | Tests and acceptance |
|---|---|---|
| `pnpm metrics` | Raw and verified counts, health, context | Snapshot test on the fixture tree; README markers generated |
| `api:surface` | `docs/api/surface.json` | Breaking, minor and patch fixtures |
| `release:plan`, `release:notes` | Grouped notes, contributors, metric deltas | Golden notes from fixture entries |
| `release-pr.yml`, `release.yml` | Release pull request and tagging | Dry run on a fork |
| First release | `v0.1.0` notes generated from launch entries | — |

### Phase 6: showcase gallery and community (§10)

| Task | Output | Tests and acceptance |
|---|---|---|
| Showcase schema | `src/types/showcase.ts` | Schema tests |
| `showcase:add` | Entry from a project, leak-scanned, media into `out/` | Fixture project end to end |
| `showcase.yml` | Media upload to `showcase-media` | Dry-run mode |
| Site | Static generator under `site/`, `pages.yml` | Builds from fixtures; link check; no runtime third-party scripts |
| Profiles and badges | `community/contributors/*.json`, statistics, credits in releases | Tests of the statistics on synthetic history |
| Discussions, `CODE_OF_CONDUCT.md`, `SUPPORT.md`, `GOVERNANCE.md` | — | Link test |
| Seed showcases | 3–5 films by the maintainer with `receipt` verification | Visible on the site |

### Phase 7: Agent Bros Bench (§8.2, §8.3)

| Task | Output | Tests and acceptance |
|---|---|---|
| Suite format | `bench/suite.json`, `task.json` schema, answers, material manifests | Hash pinning like the rubric |
| Public split v1 | 8–12 tasks: no-spend tier across footage-edit, shorts-from-long, explainer, motion-design, product-promo; 2–3 paid tasks with cost caps | Each task validated by a reference run |
| Hidden split v1 | Manifests outside the repository | Runner accepts an external path |
| `bench:run` | Harness runner for Claude Code and Codex, bundle writer | Fake-harness test producing a valid bundle |
| Bundle signing | Hash manifest + SSH signature, checked against the GitHub account's keys | Unsigned, wrongly signed and altered bundles rejected |
| `bench-verify` | Deterministic recomputation | Tampered-bundle fixtures rejected |
| Judging | Pairwise packets, two-vendor judges, Bradley–Terry with bootstrap, calibration on `ref:degrade` and a human set | Synthetic preferences recover a known ranking; uncalibrated judge refused |
| Human panel | Protocol, form, sampling | Recorded in `docs/benchmark.md` |
| Publication | Tables on the site with intervals, labels and raw data | — |
| Policy update | `docs/craft-evaluation.md` and root rules aligned with D5 | Same commit as the first published table |
| Playbook `benchmarks` | Filled from the suite | Playbook validator requires them for `ready` |

### Phase 8: field reports and lessons upstream (§8.4)

| Task | Output | Tests and acceptance |
|---|---|---|
| `field:report` | Anonymised project summary, leak-scanned | Fixture memory |
| `memory:upstream` → pull request | Its `PR.md` follows the PR block and change-entry formats; category `lesson` | End-to-end from a fixture proposal |

### Order and dependencies

```
0-prep ─┐
1 security+intake ─▶ 2 context ─▶ 3 protocol ─▶ 4 value+triage ─┐
                         5 metrics+releases ─▶ 6 gallery ────────┤
                         7 bench (needs 5, 2) ─▶ 8 field reports ┤
                                                                 ▼
                     sandbox repository: live GitHub tests ─▶ 0-cutover: init commit in ilyamk/agentbros ─▶ public
```

---

## 13. Risks

| Risk | Mitigation |
|---|---|
| Slop volume after the announcement exceeds triage budget | Tier limits, deterministic closures before triage, monthly triage cap with a skip label |
| Instruction supply-chain attack | Protected paths, owner review, `instructions:security`, behavioural suite |
| Benchmark gaming | Hidden split, reproduction sampling, noise floor, pre-registration |
| LLM judges disagree with people | Calibration gate on human sets; sound human-only; intervals published |
| Generated-file conflicts despite the bot | Merge queue, `pnpm regen` |
| Context creep from new rules | Budgets in CI, one-in-one-out, nightly audit |
| CLA not enforceable for agent output | Final CLA text (2026-11-16); accountable human signer |
| Leak of private names in the public history | Local leak patterns, pre-push hook, CI leak scan, launch from a scanned tree |

## 14. Open items to settle during implementation

- **Before going public:** the monthly triage cap in USD (D7). The CLA with its AI clause (D10) was finalised on 2026-11-16.
- **Before phase 7:** who pays for creative judging and its monthly cap (D6); the exact judge models, the human-panel size and the calibration agreement threshold, recorded in `bench/config.json`.
- Results of the canary probe (phase 2) may change §4.6 and §4.7.
- The novelty thresholds for blocks and playbooks, calibrated on the current catalogue (phase 4).
