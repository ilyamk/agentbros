# RFC 0002: Value-first contribution, delivery and quality loop

Status: draft for discussion, 2026-11-16. Nothing here is decided; RFC 0001 decisions D1–D17 stand until this RFC records an amendment. Section 9 marks the items small enough to land before the public launch.
Date: 2026-11-16
Repository: [ilyamk/agentbros](https://github.com/ilyamk/agentbros)
Owner: the maintainer (`@ilyamk`)
Amends: [RFC 0001](0001-contribution-system.md) §5, §6, §8, §9, §10 and decisions D12 and D14 (clarification only)

## Summary

RFC 0001 built the machinery for an open repository: gates, tiers, triage, releases, a benchmark, a showcase gallery and profiles. An audit of that machinery on 2026-11-16, before the public launch, found that it checks the **form** of a contribution in detail and the **value** of a contribution hardly at all:

- form: an eight-field PR block, a single declared category, declared size, CLA identity, 606 protected paths, seven automatic closing rules;
- value: category "evidence" is prose nobody checks, the sensor category's gate is `pnpm lint`, the creative layer of the benchmark has never produced a number, and the calibration corpus is private.

For autonomous agents this is the worst combination. Agents are good at satisfying formal checks and poor at guessing what is useful, so a system that measures form and not value invites the slop it is built to stop.

This RFC proposes to:

1. fix the launch blockers that make the documented path fail for a newcomer (§3.1);
2. derive what can be derived and check evidence instead of declarations (§3.2, §3.3);
3. publish work as a machine-readable task contract that agents can filter by capability and verify by command (§3.4);
4. credit humans, agents and models only from verified data, including a public ledger of agents as contributors (§3.5);
5. close the quality loop with an open calibration corpus, a first benchmark campaign, a community model × task matrix, prompt regression and field verdict bundles (§3.6);
6. make releases a delivery channel users actually consume (§3.7).

---

## 1. State on 2026-11-16 (evidence)

### 1.1 What has run

- `ilyamk/agentbros` does not exist yet; the private repository carries every workflow.
- No tag, no `CHANGELOG.md`, 33 pending `.changes/` entries (all `pr: 0`, five `authors: [unknown]`).
- No `showcases/`, no `community/contributors/`, no `bench/results/`.
- `contrib/triage.json` has `enabled: false` and `pricing: {}`; `bench/config.json` has placeholder judge models and `null` calibration thresholds; `bench/allowed_signers` authorises nobody.
- Hosted-runner jobs have not yet completed a run of `ci`, `pr-intake`, `release-pr` or `pages`. The gate funnel is tested by unit tests with fakes only.

### 1.2 Launch blockers (verified in code)

| # | Defect | Where |
|---|---|---|
| B1 | The bot tells people to post `I have read the CLA and I agree to it.`; the signer refuses it because `CLA.md` does not contain the sentence. The test passes because it fakes `CLA.md`. | `scripts/github/gh-cla.ts:5,34`; `tests/github-scripts.test.ts` |
| B2 | Only Claude Code's co-author address is exempt from CLA resolution; Codex, Cursor or Copilot trailers leave CLA unresolved, although D13 makes Codex a supported harness. | `scripts/github/gh-pr-facts.ts` (`AGENT_COAUTHOR_EMAILS`) |
| B3 | Scout asks for library previews at `docs/library/previews/<id>.jpg`; the intake media regex blocks every image and autoclose rule 5 closes the PR as `closed:slop`. | `src/lib/contrib/scout.ts:184-198`; `src/lib/contrib/intake.ts:51` |
| B4 | Every closing rule except the CLA one adds `closed:slop`, including over-limit and missing-proposal closures; `closedAsSlop` counts the whole history. One procedural mistake raises the tier-1 bar from 3 to 5 merges. | `scripts/github/gh-autoclose.ts:91-93`; `src/lib/contrib/history.ts:35` |
| B5 | The `appealed` label exempts a PR from every closing rule, including leaks and media; `/appeal` does not check who closed the PR. | `scripts/github/gh-autoclose.ts:20`; `src/lib/contrib/commands.ts` |
| B6 | Release notes link `[@unknown](https://github.com/unknown)`, a real account. | `src/lib/release/index.ts:156-164` |
| B7 | `gh pr view bot/release` does not filter by state, so after the first release the next cycle probably edits the merged PR instead of opening one (untested). | `.github/workflows/release-pr.yml:64` |
| B8 | `release.yml` has no `workflow_dispatch`, no concurrency group and no existing-tag check; a rejected or slow approval leaves `main` bumped and untagged. | `.github/workflows/release.yml` |
| B9 | `showcase-media` is created as a normal release and can become the repository's "Latest" instead of `vX.Y.Z`. | `.github/workflows/showcase.yml` |
| B10 | Per `docs/github.md`, the same App key sits in `release` (reviewer) and `automation` (no reviewer) with an always-bypass on `main`, so the release reviewer gate can be bypassed by any `automation` job. This is a GitHub setting and needs checking in the settings. | `docs/github.md:15-47` |

### 1.3 Design debt

- **Category gates are near-empty.** From `contrib/categories.json`: `sensor` runs `pnpm lint` with no owner review; `lesson`, `showcase`, `bench`, `reference`, `docs`, `asset`, `audio` run `pnpm typecheck` only. Their evidence requirements are prose in the category cards.
- **Easy to game.** `fix`, `lesson` and `security` cover `**`; the tier-0 `test-ci` ban checks only the declared category. A `fails-on-base` test can import a symbol that does not exist yet. A `novelty:` line clears the novelty gate. Duplicate detection needs an identical file set.
- **Protection covers the valuable categories.** 606 protected entries include `scripts/**`, `package.json` and every library group's `index.ts`/`registry.ts`, so a new block or command needs `design-approved`, and rule 4 closes it as slop after 7 days of maintainer silence.
- **Duplicated checks.** `cla.yml` re-runs the full `github:facts --check`; category gates repeat lint/typecheck from `ci.yml`; leak scanning exists twice; `test:fast` runs inside and beside the sharded suite.
- **Promised, not built.** `library:catalogue` has no `--check`; `context-growth-approved` is read by no code; `api:surface --check` and `format:check` run in no workflow; no macOS job; `/bench-lite` only adds a label; nothing awards `reproduced`.
- **Triage.** Two models through one OpenRouter key rather than two vendors; newcomers (tier 0) are not auto-triaged; `triage:likely-slop` removes `ready-for-owner`, which is more than "advisory".
- **Tasks.** Scout ranks by category weight plus a size bonus. In the 2026-11-15 snapshot of 466 jobs the curated security task ranks 466th and `critic-golden-cases` 273rd; 211 library and 120 test-ci rows bury the 12 curated ones. No job states the capabilities it needs (macOS, GPU, ffmpeg, a harness session, a signing key, design approval) or a command that accepts it. Scouted rows are not issues, so `/claim` needs a hand-made issue whose dropdown values are lost (`scout.ts:569-571` defaults to `fix`/`S`).
- **Credit.** Change-entry `authors`, catalogue `authors` and `reproduced: true` are self-declared; instruction bytes removed are credited in full to every author of a commit; the PR block's `autonomy`, `harness` and `model` are parsed and never used.
- **Quality.** Eight `ready` playbooks have `benchmarks: []`; the instruction baseline holds 337 grandfathered findings with no shrinking test; no behavioural regression for prompt changes runs anywhere automatic; calibration media are git-ignored and one reference is private; field verdicts never leave the user's machine.
- **Releases.** Users install and update from `main` (`docs/install.md`), so tags, the tarball and its attestation have no consumer and there is no rollback path other than a revert.

### 1.4 What works and must be kept

- No `pull_request_target`; privileged jobs never run fork code and **re-derive facts from the REST API** instead of trusting artefacts.
- Triage treats the diff as data inside random delimiters, with schema-checked output and a canary; its verdict cannot merge or close.
- Closures are deterministic, explained and appealable.
- Trust tiers and open-PR limits bind the accountable human, not the agent.
- The bump is detected from the API surface, not only declared.
- Every workflow starts from `permissions: {}`; actions are pinned by SHA; releases carry build provenance.
- `creative-postmortem`: a lesson only from a user verdict, a rule only after two occurrences, "would have caught" measured by running the change.
- Benchmark honesty rules: blind pairwise judging, Bradley–Terry with intervals, a published noise floor, no LLM verdict on sound (D5).
- Measured and gated context budgets.

---

## 2. Goals, non-goals, constraints

**Goals**

1. A newcomer, human or agent, following the documented path gets a green, mergeable PR without a maintainer's help.
2. An agent can discover work it is able to do, know how it will be accepted, and prove acceptance locally with the same command CI runs.
3. A quality claim in a PR carries evidence CI can recompute; a claim CI cannot recompute goes to a human, not through.
4. Credit and reputation come only from data the contributor cannot write themselves.
5. Outsiders can measure, reproduce and extend the benchmark and calibration without private material.
6. Users consume releases, with a rollback.

**Non-goals**

- Ranking by PR count (D14 stands).
- LLM judging of sound (D5 stands).
- Harnesses beyond Claude Code and Codex (D13 stands; §3.1 only stops other co-author trailers from breaking CLA).
- Automatic telemetry (D15 stands; field bundles in §3.6 are opt-in and manual).

**Constraints.** One maintainer. Provider keys never in CI. No privileged job runs fork code. Every change in this RFC keeps the RFC 0001 security model (§6.5).

---

## 3. Specification

### 3.1 Launch fixes

| Fix | Specification | Test |
|---|---|---|
| F1 CLA short form | Add a "How to sign" line to `CLA.md` containing `CLA_STATEMENT` verbatim. `gh-cla.ts` keeps reading it from `CLA.md`. | A test reads the real `CLA.md` and asserts it contains `CLA_STATEMENT`. |
| F2 Agent co-authors | Replace the single address with `contrib/agent-coauthors.json`: known harness noreply addresses (Claude Code, Codex, Copilot, Cursor) plus a rule that any co-author whose name or address matches a listed harness is the submitting human's contribution. The human owner still signs. | Fixture PRs with each trailer resolve CLA to the PR author. |
| F3 Library previews | Previews are not contributed as binaries. A trusted job renders `docs/library/previews/<id>.jpg` after merge (the block's code is reviewed by then) and commits it with the post-merge regen. Scout stops asking for a preview and asks for a renderable preview composition instead. Novelty's image check runs in the post-merge job and opens an issue on a near-duplicate. | Scout text test; intake fixture with a `.jpg` under previews is still blocked; post-merge test renders a fixture block. |
| F4 Closure taxonomy | Two labels: `closed:slop` only for rule 3 (duplicate), rule 5 (media/leak) and a maintainer's manual slop close; `closed:process` for rules 1, 2, 4, 6 and 7. Only `closed:slop` counts in history, inside a 90-day window. | `history.ts` and `gh-autoclose.ts` unit tests per rule. |
| F5 Appeals | `/appeal` works only on a bot closure; `appealed` exempts the PR from the rule that closed it, never from rule 5. | `commands.ts` and autoclose tests. |
| F6 Release notes | Drop `unknown` and bot handles from contributors; omit a section rather than print "Not supplied". | `releaseNotes` fixture. |
| F7 Release PR lookup | `gh pr list --head bot/release --state open`. | Workflow test asserts the state filter. |
| F8 Release idempotency | `release.yml`: `workflow_dispatch` with a version input, `concurrency: release`, skip when the tag exists, fail loudly when `main`'s version and the latest tag disagree for more than one day (nightly check). | Workflow test. |
| F9 Latest release | `gh release create showcase-media --latest=false`; same for `bench-bundles`. | Workflow test. |
| F10 Key split | Two Apps: `agentbros-release` (tags and releases, only in `release`, reviewer required) and `agentbros-automation` (regen, showcase, models PR; no tag or release permission). Document in `docs/github.md`; check in settings. | `docs/github.md` checklist; a test that no workflow outside `release.yml` uses the release App secret. |
| F11 Dry run | Run the full funnel in a sandbox repository before cutover (RFC 0001 cutover step 7), with one PR per closing rule and one release cycle twice. | Recorded run links in the launch checklist (not tracked evidence). |

### 3.2 Intake: derive, do not declare

**PR block v2.** Four fields, all describing accountability or provenance:

```html
<!-- agentbros:pr
owner: <human GitHub handle>
autonomy: autonomous | assisted | human
harness: claude-code | codex | other
model: <model id or none>
-->
```

- `size` is computed from the diff (it always was; the declared value only produced mismatches).
- `category` is inferred: the narrowest category whose `paths` cover every changed file, after removing tests, `.changes/` and generated files. A PR may add `category:` to the block only when two categories tie; intake then checks it is one of them.
- `issue` moves to the body as an ordinary `Closes #N`, required for M/L by intake.
- `change` disappears (see below).
- v1 blocks stay accepted for one release with a warning.

**Change entries written by the bot.** The PR body carries a fenced `change` section:

````md
```change
bump: patch | minor | major
breaking: false
summary: One sentence for the release notes.
deps: <only when a dependency is added>
novelty: <only when overlapping ids exist>
migration: <only when breaking>
```
````

After merge, `post-merge-regen` writes `.changes/<pr>-<slug>.md` with `pr`, `category`, `authors: [<PR author>]` and `harness` from the block. This removes `change:add` from the contributor loop, self-declared authors, `@unknown`, and the `pr: 0` race with `release-pr`. Maintainer direct commits keep `pnpm change:add`.

**Two required checks.**

| Check | Context | Contains |
|---|---|---|
| `intake` | trusted (`workflow_run`, REST re-derivation) | G0, G1, category inference, evidence presence (§3.3), CLA, closure decisions |
| `ci` | untrusted (`pull_request`) | lint, typecheck, sharded tests, browser/render, Python, `format:check`, `api:surface --check`, generator `--check`s, recomputable evidence (§3.3) |

`cla.yml` keeps only the signing job; `category-gates.yml` and `context-budget.yml` become jobs inside `ci`. One cause produces one red check.

**Trust roots instead of 606 protected paths.** `contrib/protected.json` keeps about 30 entries:

- `.github/**`, `CODEOWNERS`, `contrib/*.json`, `.github/trust.json`;
- `src/lib/contrib/**`, `scripts/github/**` and the trust-root closure of privileged jobs (`trust-roots.ts`);
- `src/lib/{providers,budget,jobs}/**`, `src/lib/pricing.ts`, the endpoint registry;
- `AGENTS.md` files, `.agents/**`, `.claude/**`, `.mcp.json`, `CLAUDE.md`;
- `package.json` scripts and dependencies, the lockfile;
- licence, CLA, rubric files, `bench/hidden/**`;
- the `repo:hygiene` guard.

Library `index.ts`/`registry.ts` become generated from block files (`pnpm library:catalogue` already scans them), so a new block touches only its own files. New `scripts/*.ts` files outside the trust-root closure are unprotected; adding them to `package.json` is the protected step and gets review.

**Rule 4 with maintainer latency.** The 7-day protected-path timer starts when the PR is otherwise green and pauses while `design-approved` is requested and unanswered. A closure under rule 4 is `closed:process`.

**Category scoping.** `fix`, `lesson` and `security` lose `**`: `fix` covers source and tests of the files it fixes (computed from the failing-on-base test's import graph), `lesson` covers `design-reference/**`, `playbooks/**`, `.agents/skills/**/references/**` and `docs/**`, `security` stays broad but requires owner review. `fails-on-base` requires the failing test to fail on an assertion, not on a module or symbol resolution error.

**Triage.** Either configure it before launch (prices, two keys from two vendors, `minTierForAutoTriage: 0` with the per-owner monthly cap) or state in `docs/triage.md`, the PR template and the README that triage is inactive. `triage:likely-slop` keeps a PR out of the owner queue, so the docs must call it that, not "advisory".

### 3.3 Evidence artefacts

A category that makes a quality claim requires `evidence/<pr-slug>.json` in the PR, validated by a per-category Zod schema in `src/types/contrib-evidence.ts`. CI recomputes the deterministic part; anything it cannot recompute is shown to the maintainer as unverified.

| Category | Evidence schema (key fields) | Recomputed in `ci` | Shown as unverified |
|---|---|---|---|
| sensor | `corpus` (open corpus version), `pairs`, `accuracy`, `falsePositiveRate`, `threshold`, command | `judge:calibrate`-style deterministic sensor run on the open corpus (§3.6) must reproduce `accuracy ≥ 0.85` and false positives ≤ 10 % | — |
| library | block id, preview composition id, `motion:check` summary, `usedBy` (playbook or showcase) | determinism lint, `motion:check` on the preview composition, catalogue `--check` | `usedBy` until a showcase uses it |
| playbook | match regression set, `benchmarks` ids | `playbook --match` regression; non-empty `benchmarks` when `ready` | — |
| lesson | occurrences (≥ 2, anonymised), `wouldHaveCaught`, `wouldWronglyCatch`, the sensor or rule changed | the sensor or rule runs on the bundled anonymised fixtures and reproduces both counts | occurrence provenance |
| fix | failing test id | fails on base with an assertion, passes on head | — |
| agent-skill, instructions | context delta, golden-brief run (§3.6.4) | context budget; golden-brief deterministic checks | behavioural run on a model (label-triggered) |
| bench | suite version, task hashes | suite hash recomputation | — |
| provider | dated price source URL, mock lifecycle tests | tests | price correctness |
| showcase | delivery receipt hash, harness tag | receipt verification | creative quality |

A PR in these categories without evidence gets `needs-human` and no `ready-for-owner`; it is not closed.

### 3.4 Task contract v1

Extend `CuratedOpportunitiesSchema` (`src/types/contrib-tools.ts`) and the scout output into one `TaskSchema`:

```ts
{
  id: string;                 // stable: sha256(category:source:key), never from line text
  title: string;
  category: CategoryId;
  size: "S" | "M" | "L";
  source: "curated" | "scout:<scanner>" | "issue";
  priority: 0 | 1 | 2 | 3;    // maintainer-set; curated default 2, scouted default 0
  value: {                    // what moves if this is done
    metric?: string;          // e.g. "bench:explainer.completion", "sensor:flash.accuracy"
    rationale: string;
  };
  requires: {
    os?: ("macos" | "linux")[];
    gpu?: boolean;
    tools?: ("ffmpeg" | "blender" | "python" | "swift")[];
    harnessSession?: ("claude-code" | "codex")[];
    signingKey?: boolean;     // SSH key on allowed_signers
    designApproval?: boolean;
    paid: false;              // contributor tasks never require spend
  };
  read: string[];             // files to read first, scoped like step reads
  verify: string[];           // commands CI runs to accept; the local check runs the same
  definitionOfDone: string[]; // prose, kept for humans
  claim?: { by: string; issue: number; expires: string };
  epic?: string;              // groups mechanical rows
}
```

**Ranking.** `score = 1000·priority + valueWeight(value.metric) + epicPenalty + sizeBonus`, where mechanical scanners fold into one epic row per scanner and category (for example, "211 library blocks without a playbook use" becomes one epic with sub-items). Curated rows always outrank scouted rows of the same priority.

**Publishing.** `pages.yml` writes `api/tasks.json` (schema-versioned) beside the needs board; the MCP bridge exposes `contrib_tasks` (read-only, filters as below); `pnpm contrib:scout --json` emits the same schema.

**Capability filter.** `pnpm contrib:scout --can macos,ffmpeg,codex --tier 0` returns only tasks whose `requires` the agent meets and whose size its tier allows. `pnpm contrib:doctor` detects the local capabilities to pass to `--can`.

**Claiming.** `pnpm contrib:claim <task-id>` (needs `gh`) opens the opportunity issue with `category:*`, `size:*` and `task:<id>` labels set from the contract (not from free text), comments `/claim`, and prints the issue number. The bot treats a `task:<id>` issue opened by a tier-0+ author for a contract row as `agent-ready` without maintainer triage, because the row is already maintainer-approved data. A claim counts as linked to any open PR by the claimant that references the issue, draft or not.

**Acceptance.** `contrib:check` runs the task's `verify` commands in addition to the category gates; `intake` re-runs them in `ci`. A task without `verify` cannot be `priority ≥ 2`.

### 3.5 Verified credit and the agent ledger

**Sources of credit, all derived by trusted jobs:**

| Signal | Source |
|---|---|
| Merged contribution by category | merged PR author and inferred category (§3.2) |
| Block authored and used | PR author of the block's first merge; uses from showcase receipts and bench bundles |
| Sensor caught a real defect | a delivery receipt or bench bundle whose sensor failure led to a fix (linked by the fix PR's evidence) |
| Lesson verified | the postmortem meta-loop marking the change `verified` (exported in a field bundle, §3.6.5) |
| Reproduced benchmark | a maintainer or tier-2 reproduction recorded by `bench:reproduce` (new; awards `reproduced`) |
| Instruction bytes removed | net bytes of the PR's own diff, credited to its author only |

Self-declared `authors`, catalogue `authors` and `reproduced: true` stop counting.

**Agent ledger.** A generated page and `api/agents.json` with one row per `harness × model` from merged and closed PR blocks:

- PRs opened, merged, closed by reason (`slop`, `process`);
- reverts within 30 days;
- review rounds to merge;
- share of tasks with `verify` passing on first CI run;
- categories touched.

It ranks no human. It compares agents as contributors, which is the product's own subject, and gives every agent vendor and user a reason to report `harness` and `model` honestly. Rows below 10 PRs show "insufficient data".

**Impact badges.** Replace count badges with consequence badges: "block in 5 delivered films", "sensor caught a defect", "lesson verified", "benchmark reproduced". Profiles stay alphabetical.

**D14 clarification (proposed amendment).** "No leaderboard by pull-request count" stays. Add: "Impact statistics computed from verified data may be shown on profiles, and agents (harness × model) may be compared as contributors; humans are not ranked."

### 3.6 Quality loop

**3.6.1 Open calibration corpus.** `bench/corpus/` holds manifests (not media) of licence-clean references: CC-BY or CC0 films and films the maintainer or contributors made for the purpose, each with licence evidence. `ref:degrade` copies are generated deterministically from a seed. `pnpm corpus:sync` fetches them. Sensor calibration in §3.3 runs against a pinned corpus version. The private corpus stays for the maintainer's own calibration but stops being the only one.

**3.6.2 First benchmark campaign, no-spend.** Order:

1. register the maintainer's key in `bench/allowed_signers`;
2. run the no-spend public tasks for both harnesses, three runs per cell;
3. `bench:verify` writes accepted results to `bench/results/<campaign>/` (tracked JSON, no media);
4. `site:build` publishes process and technical layers and the `bench:rate` output when a creative layer exists;
5. set judge models, caps and calibration thresholds only when the calibration set exists; until then the creative column says "not measured".

Also fix the docs to say nine tasks, not four.

**3.6.3 Community model × task matrix.** Anyone with a subscription runs public cells and submits a signed bundle (RFC 0001 §8.3). The matrix page shows each cell's label (`community`, `reproduced`, `maintainer`) and run count. `bench:reproduce` samples cells for the maintainer or tier-2 runners. This is the main way outside compute improves model choice: model slot promotions in `docs/model-slots-guide.md` may cite matrix cells as evidence.

**3.6.4 Prompt regression.** `bench/golden/` holds fixed briefs per step (strategy, ideas, script, motion plan) with recorded inputs. Two levels:

- deterministic, in `ci` for every PR touching `.agents/**`, `AGENTS.md` or `playbooks/**`: the step's rendered brief (`film:brief`) is built for each golden case and checked for size, required reads and absence of removed rules;
- behavioural, label-triggered (`/golden` by tier ≥ 2 or the maintainer): a small model runs the golden cases in a sandbox with no keys and the outputs pass `plan:check`, schema validation and the step's gates. Spend is the maintainer's or a sponsor's, capped in `bench/config.json`.

Add a test that `contrib/instructions-baseline.json` never grows, and a scout task per baselined finding.

**3.6.5 Field verdict bundles.** `pnpm field:report --bundle` writes an anonymised, signed bundle: model-slot verdicts (`models:verdict`), sensor failures and their resolution, postmortem change status, approvals and rounds, harness and model. No briefs, transcripts or media. Submission uses the benchmark bundle route. A nightly job aggregates accepted bundles into `api/field.json`: first-pass acceptance per model slot, sensor precision in the field, playbook delivery counts (which can promote a playbook to `proven`).

**3.6.6 Seed the gallery.** Five to ten maintainer showcases (free routes first) before launch, so the gallery, profiles and "block used in films" signals are not empty on day one.

**3.6.7 Playbook consistency.** Either add a benchmark task for each of the eight `ready` playbooks with empty `benchmarks`, or move them to `beta`; then make `--strict-benchmarks` the default.

### 3.7 Releases as a delivery channel

- **Stable channel by default.** `docs/install.md` clones and checks out the latest tag. `pnpm harness:update` fetches tags, shows the changelog sections and migration notes between the current and latest tag, refuses with local changes, checks out the tag, reinstalls and runs `preflight` and `test:fast`. `--edge` follows `main`. `--to <tag>` rolls back.
- **Release notes** only include sections that have data (F6). Metrics deltas come from `pnpm metrics` run in `release-pr` and attached to the release.
- **Cadence (D12)** is unchanged. A security entry makes the PR ready and mentions the maintainer.
- **Alternative** if a stable channel is rejected: drop the tarball and attestation and call a release a changelog checkpoint.

---

## 4. Architecture

### 4.1 Data flow

```text
                         untrusted (fork)                        trusted (default branch)
 contributor/agent ── PR ──► ci (pull_request, no secrets) ─┐
   reads api/tasks.json      lint · tests · generators --check│
   contrib:claim             evidence recompute               │ workflow_run
   contrib:check             golden (deterministic)           ▼
                                                     intake (REST re-derivation)
                                                     G0 CLA · G1 paths/size/media/leak
                                                     category inference · evidence presence
                                                     closure decisions · labels
                                                              │ ready-for-owner
                                                              ▼
                                                      maintainer review ── merge queue
                                                              │ push to main
                       ┌──────────────────────────────────────┼──────────────────────────┐
                       ▼                                      ▼                          ▼
             post-merge (automation App)             release-pr / release        pages (nightly + push)
             .changes/<pr>-<slug>.md from PR          (release App, reviewer)     api/tasks.json
             previews rendered, regen, credit         tag · notes · provenance    api/agents.json
                                                                                  api/field.json · bench
                       ▲                                                          ▲
     bundles (signed): bench:run ─► bench-verify ─► bench/results ────────────────┘
                       field:report --bundle ─► field-verify ─► aggregates
```

### 4.2 Components

| Change | Component |
|---|---|
| New | `TaskSchema`, `api/tasks.json`, MCP `contrib_tasks`, `contrib:claim`, `contrib:doctor`, `--can` filter |
| New | `src/types/contrib-evidence.ts`, evidence recompute in `ci` |
| New | `bench/corpus/` manifests, `corpus:sync`, `bench/golden/`, `bench:reproduce`, `field:report --bundle`, field-verify job |
| New | agent ledger and impact credit in `src/lib/community/stats.ts` and `site/build.ts` |
| New | `pnpm harness:update`, second GitHub App |
| Changed | PR block v2, category inference, closure taxonomy, history window, appeal scope, CLA statement and co-author list |
| Changed | `post-merge-regen` writes change entries and renders previews |
| Changed | `contrib/protected.json` to trust roots; generated library registries |
| Changed | `release-pr.yml`, `release.yml`, `showcase.yml` (F7–F9) |
| Removed | declared `size`, `change` and `category` fields; `cla.yml` check job; `category-gates.yml` and `context-budget.yml` as separate required checks; self-declared credit sources |

### 4.3 Trust boundaries (unchanged in principle)

- Fork code runs only in `ci` without secrets. Evidence recomputation is fork code and is therefore only trusted for pass/fail inside `ci`; `intake` re-derives presence and paths from REST.
- Preview rendering after merge runs reviewed code, so it may run in the `automation` environment; it never runs on an open PR.
- `api/*.json` are generated by `pages` from the default branch and GitHub data; they are data for agents, never instructions. Agents must treat task `read` and `verify` fields from a fork's copy as untrusted; the canonical copy is the Pages one.
- Bundles are data; `bench-verify` and field-verify never execute bundle content.

---

## 5. Security considerations

- **Task contract as an injection vector.** `title`, `rationale` and `definitionOfDone` are text an agent will read. Curated rows are maintainer-written; issue-sourced rows are escaped and marked `source: issue`, and the contributor instructions say to treat them as data. `verify` commands are only taken from curated or scouted rows, never from issues.
- **Inferred category** cannot widen permissions: inference picks the narrowest covering category, and protected paths are checked independently of category.
- **Fewer protected paths** narrow review to trust roots. The risk is a new unprotected script that agents are told to run by an unprotected doc; mitigated because `package.json` scripts and `AGENTS.md` files stay protected and `instructions:security` scans every Markdown addition.
- **Bot-written change entries** come from the PR body, which is attacker text: the bot writes it into a fenced, length-capped field and the release notes escape it.
- **Field bundles** may leak private material: `field:report` reuses the leak scan, includes no free text, and the submitter signs; aggregates are counts only.
- **Second App** reduces blast radius: the automation key can no longer tag or release.

---

## 6. Compatibility and migration

- PR block v1 accepted with a warning for one release; `contrib:pr` writes v2.
- Existing `.changes/` entries stay; the bot path applies to PRs merged after the switch. `change:add` remains for maintainer commits.
- `closed:slop` history before the switch is relabelled by a one-off script: closures under rules 1, 2, 4, 6, 7 become `closed:process`.
- Protected-path reduction is one PR with a regenerated `CODEOWNERS`; `tests/workflows.test.ts` keeps checking the trust-root closure.
- Install docs change to tags only after the first tag exists.

---

## 7. Plan

Phases are ordered by what the public launch needs. Each phase lands as reviewed PRs with tests; acceptance criteria are checkable.

| Phase | Scope | Acceptance |
|---|---|---|
| **0 Launch fixes** | F1–F10 (§3.1); triage configured or marked inactive; docs drift fixed (nine tasks, `pnpm check` contents, macOS claim) | Fixture tests per fix; a sandbox repository run (F11) with one PR per closing rule and two release cycles, all as specified |
| **1 Derive, do not declare** | PR block v2, category inference, bot-written change entries, two required checks, trust roots, generated library registries, rule-4 timer, category scoping, assertion-only `fails-on-base` | Contribution guide shrinks (target: `contrib/AGENTS.md` under 5 KiB, PR block 4 fields); a new library block PR touches no protected path; one cause gives one red check |
| **2 Task contract** | `TaskSchema`, epics, ranking, `api/tasks.json`, MCP tool, `--can`, `contrib:doctor`, `contrib:claim`, `verify` in `contrib:check` and `ci` | Every curated task has `requires` and `verify`; curated tasks rank above scouted tasks; an agent can go from `contrib:scout --can …` to a claimed issue with one command |
| **3 Evidence** | Evidence schemas and recompute for sensor, library, playbook, lesson, fix; `needs-human` without evidence; open calibration corpus v1 | A sensor PR without reproducible calibration cannot get `ready-for-owner`; corpus v1 has ≥ 20 licence-clean references and their degraded copies |
| **4 Benchmark and gallery** | First no-spend campaign, `bench/results/`, site tables, `bench:reproduce`, five to ten seeded showcases, playbook `ready`/benchmarks consistency, stable release channel and `harness:update` | Site shows a non-empty benchmark table with labels and run counts; gallery shows seeded films; install docs use tags |
| **5 Credit and ledger** | Verified credit sources, agent ledger, impact badges, D14 amendment | No credit field is self-declared; ledger page lists harness × model rows from real PRs |
| **6 Quality loop** | Golden briefs (deterministic in `ci`, behavioural on label), baseline-never-grows test, field verdict bundles and aggregates, model-slot evidence from the matrix and field | A prompt PR shows its golden diff; field aggregates reach `api/field.json`; one model-slot decision cites matrix or field evidence |

---

## 8. Alternatives considered

- **Keep declared fields and add more checks.** Rejected: each declared field is a way to fail for reasons unrelated to value, and each check of it is more machinery for one maintainer.
- **Rely on LLM triage for value.** Rejected as the primary mechanism: it is costly, two-model agreement is not evidence, and an injection-shaped diff can still move a PR to `needs-human`. Triage stays advisory beside recomputed evidence.
- **Public leaderboard of humans.** Rejected (D14). The agent ledger compares agents, which is the product question, without ranking people.
- **Mirror the private repository instead of one-time export.** Out of scope; D1 stands.
- **Drop releases entirely.** Possible (§3.7 alternative), but users then have no rollback and breaking changes reach everyone at once.

---

## 9. Quick wins before launch (about two hours each or less)

These need no design decision beyond this draft and can land first:

| Item | Effort |
|---|---|
| F1 CLA statement in `CLA.md` plus a real-file test | 15 min |
| F2 co-author list for Codex and other harnesses | 30 min |
| F4 `closed:process` vs `closed:slop` plus a 90-day window | 45 min |
| F5 appeal scope and rule 5 not exemptable | 30 min |
| F6 release notes without `unknown` and empty sections | 20 min |
| F7 open-state filter in `release-pr.yml`; F9 `--latest=false` | 15 min |
| F8 `workflow_dispatch`, concurrency and tag-exists guard in `release.yml` | 30 min |
| F3 (interim) scout stops asking for preview images | 15 min |
| Triage marked inactive in docs and PR template, or configured | 20 min |
| Docs drift: nine bench tasks, `pnpm check` contents, macOS CI claim | 20 min |
| Curated tasks get `requires` and `verify` fields (schema extension, data only) and rank above scouted rows | 90 min |
| Eight `ready` playbooks without benchmarks moved to `beta` (or a task each) | 30 min |

F10 (second App) and F11 (sandbox run) are settings and operations work for the maintainer, not code.

---

## 10. Risks

- **Scope.** Phases 1–6 are several weeks for one maintainer. Mitigation: each phase stands alone; phase 0 and §9 are enough for launch.
- **Open corpus quality.** Licence-clean references may be weaker than the private corpus, so calibrations may differ. Mitigation: publish both numbers where the maintainer can run both.
- **Ledger incentives.** Vendors may tune agents to the ledger. Mitigation: it reports reverts and slop closures, not only merges, and rows need ten PRs.
- **Inference surprises.** Category inference may pick a category the contributor did not expect. Mitigation: `contrib:check` prints the inferred category and the reason.
- **Bundle trust.** Signed field and bench bundles bind a person, not the truth of the content. Mitigation: aggregates show counts and contributors, and reproduction labels stay separate.

## 11. Open questions

1. Stable channel (§3.7) or changelog-only releases?
2. Who pays for behavioural golden runs and creative judging, and the monthly cap?
3. Should tier-0 PRs be auto-triaged once triage is configured, given cost and injection-driven `needs-human`?
4. Is the agent ledger public from launch or after a minimum volume?
5. Which licence-clean sources seed the open corpus?
6. Does D14 take the amendment in §3.5 as written?

## 12. Decision record

Pending. The maintainer records accepted, changed and rejected sections here with dates.
