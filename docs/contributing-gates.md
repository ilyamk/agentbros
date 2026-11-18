# Offline contribution gates

Last updated: 2026-11-17

`pnpm contrib:intake --base BASE --head HEAD --body pr.md --context context.json`
compares two Git commits without checking out or executing contribution code.
It reads changed entry and package contents from those commits. Both references
must resolve locally. There are no network requests or credential loading.

Context is JSON: `{"cla":true,"openPrCount":1,"labels":[],"tier":0}`.
The open count includes this PR. Omitted context defaults to unsigned CLA,
one open PR, no labels and tier 0. Supply trusted context: a contributor's
self-declared approval or tier is not authority.

G0 checks the CLA, exactly one valid opening `agentbros:pr` block and the tier's
open-PR limit. The block declares category, size, autonomy, harness, model,
owner and change path. M and L require a positive issue number.

G1 requires exactly one added, valid change entry named by that block, the same
category in both, paths within that category, declared size at least actual
size and within tier limits, no binary or media files, `design-approved` for
protected paths and a `deps:` justification for newly introduced package
names in any dependency section. Deleting media is allowed. Renames are
checked as deletion plus addition. Generated catalogue, film-type guide and
credits files, `.changes/` and supporting `AGENTS.md` edits are allowed
alongside category paths. Maintainers review whether instruction edits describe
the change. These exceptions still receive the size, binary and protected-path checks.

Size counts additions plus deletions across the complete diff: S ≤300 lines,
M ≤1000, L above. Categories overlap intentionally: one declared category must
cover the whole change; overlap is not a multiple-category violation.

Tier 0 permits two open PRs, S/M and excludes instructions, harness and test-ci.
Tier 1 permits five, including L with `design-approved`. Tier 2 requires ten
merges and a maintainer grant and permits ten open PRs. Tier 3 has no count
limit. Three merges with slop share below 20% earn tier 1; share is slop closures
in the last 90 days divided by merges plus those slop closures. Two slop
closures in the last 30 days lower the computed tier once; the history supplier
maintains both windows. Process closures never count.

The pure `autoclose` evaluator accepts trusted PR facts and an explicit clock.
It implements the seven RFC closing reasons in order: CLA overdue by seven
days, newest excess PR, open duplicate (same files, ≥90% identical added lines),
unapproved protected paths overdue by seven days, media or leak hit, structure
overdue by seven days, and L without approved proposal. Each timed rule (CLA,
protected paths, structure) posts its own reminder first. Tier 3 (maintainer)
PRs are never closed, and tier 3 changes to protected paths need no
`design-approved` at intake; CODEOWNERS review still applies.
`CLOSURE_LABEL` maps each rule to its label: rules 3 (duplicate) and 5 (media
or leak) add `closed:slop`; rules 1, 2, 4, 6 and 7 add `closed:process`.
Closure messages explain the one-time `/appeal <reason>` route, except rule 5,
which cannot be appealed. `appealedRule` exempts only that rule and its
reminder; `"unknown"` (an unreadable appeal record) exempts every rule but 5.
Reopening and posting reminders are the caller's responsibility. Similarity is a fraction
from 0 to 1, calculated by the trusted caller.

Results use the standard single JSON line; blocking findings return exit 1
with findings and derived facts in `metadata`. Invalid arguments also fail.
Library callers provide `content` on added entries and current/previous
package contents for dependency checking; missing contents block the check.
`contrib/categories.json` and `contrib/protected.json` are validated contracts.
Only existing package commands appear in category gates; future gates belong
in optional `plannedGates`.

This offline stage does not verify CLA identities, label provenance, dependency
licences, leak scans, approved proposals, correctness or creative value. Those
need the separate trusted workflow stages in RFC 0001. No GitHub automation
is installed by these commands.

## Dependency gate

Required unprivileged `pr-intake` runs `pnpm deps:check --base BASE` on PRs and
merge groups, with the trusted event's base SHA. If `package.json` or
`pnpm-lock.yaml` changed, it runs `pnpm audit --prod --audit-level high` and checks
new package/version identities from the lockfile against installed `package.json`
licences. Audit failures block the required check. Missing metadata, unknown
expressions and unlisted licences block unless a protected exact-version review
covers this repository-source use.

`contrib/licence-allowlist.json` allows MIT, ISC, BSD-2-Clause, BSD-3-Clause,
Apache-2.0, 0BSD, CC0-1.0, BlueOak-1.0.0 and Unlicense. MPL-2.0 is flagged for
maintainer review and needs a matching source-only decision or an explicit policy
change. The automatic policy checker
accepts the policy's SPDX identifiers and parenthesised `AND`/`OR` combinations:
`AND` requires every term, while `OR` needs an allowed option. `WITH`, malformed
expressions and unlisted terms without an allowed alternative remain blocked.
This is a conservative policy evaluator, not a full SPDX validator. In particular,
`EPL-2.0 OR GPL-3.0-or-later` remains blocked by the policy: the GPL option would
bind the Licensor's BUSL-1.1 code, so only an exact-version review that selects
EPL-2.0 clears it. See [the ELK review](dependency-licences.md#elkjs-0121).
GPL or AGPL code combined with ours would bind the Licensor's own files and is
not accepted outside the separately licensed GPL-3.0-or-later Blender component;
LGPL code is acceptable where its source and relinking terms can be met; see [the BUSL-1.1 assessment](dependency-licences.md#assessment-for-busl-11-and-the-commercial-licence).
CI also runs `pnpm deps:licences --check --strict --scope repository-source` for
the complete inventory and protected exact-version reviews, even when the diff
is empty. Reviewed archive metadata can resolve a platform gap only for the
matching name/version, lock hash, integrity and manifest. Conditions remain in
the report; no review clears binary or browser-bundle distribution. See [dependency licences](dependency-licences.md).
It lists each new package's preinstall, install, postinstall and prepare scripts
as data, without executing them. Installation disables lifecycle scripts and
pnpmfile hooks. Offline tests mock the audit; the real required job uses the
registry audit service and fails closed when it is unavailable. Newly locked
optional packages for other platforms may lack installed metadata on Ubuntu.
Maintainers must provide a vetted installation or an exact-version review backed
by the locked tarball's verified integrity, manifest and licence evidence. The
gate does not infer terms from a similarly named platform package.

## Find, check and draft a contribution

`pnpm contrib:scout --json --tier 0 --limit 20` ranks opportunities without
network access. Use `--category bench` to narrow the list and
`--markdown needs.md` to write a needs board. JSON is always the stdout
contract; `--json` makes that intent explicit. Opportunity ids hash the source
identity and category. Each result includes its reason, evidence pointers,
definition of done and issue/PR coverage.

Sources cover draft playbooks and empty benchmarks, provisional sensor
comments, the shared metrics reader's SHRINKING targets and provider price
findings, reference-gap tables, missing block previews/playbook use, commands
without a playbook, instruction-lint baseline findings and syntactically
skipped tests. Scout reuses the metrics pricing rule: a provider needs a dated
price source. Test coverage alone cannot establish price evidence. Preview
files must exist; a catalogue declaration alone does not establish a preview.

Mechanical findings are grouped into contribution-sized rows: instruction-lint
baseline findings per file (S up to 10 findings, otherwise M), skipped tests
per test file and commands without a playbook per command section (S up to 15
commands). Evidence lists are capped and end with a count of the rest. Three
further sources read structured fields only:

- **Techniques:** `design-reference/techniques/*.md` front-matter with
  `status: draft` becomes a `library` row to demonstrate the technique (S when
  `demo` names a block, otherwise M), following
  [edit-research](../.agents/skills/edit-research/SKILL.md) step 1.
- **Slop:** in `design-reference/slop-catalogue.md`, a first-table row whose
  `Source` is `provisional` becomes a `sensor` row to calibrate the threshold;
  a `## 3D slop` row whose `Sensor` names only the critic before its first
  semicolon becomes a `sensor` row to make it measurable. Columns are located by
  header name.
- **Curated:** `contrib/opportunities.json` (protected) holds
  maintainer-written rows, `{ "version": 1, "opportunities": [{ "key",
  "category", "size", "title", "why", "evidence", "definitionOfDone" }] }`,
  validated by `CuratedOpportunitiesSchema`. The id derives from `curated:<key>`
  and the category; a malformed file or an unknown category fails the run.

Ids derive from a namespaced source key (file, section, card id, signature or
curated key), never a line number, so they survive edits. The needs-board JSON
(`--out-json`, and the stdout `metadata`) holds `opportunities`, `dropped`,
`assumptions`, an optional `warning`, `counts` (rows per category, in ranking
order) and `total`. `counts` and `total` cover every ranked row before
`--category` and `--limit`; `--tier` and `--online` apply first.

Ranking weights follow RFC 0001 §6.7: bench 2000, sensor 1900, library 1800,
playbook 1700, provider 1600, command 1500, worker 1400, audio 1300,
reference 1200, agent-skill 1100, instructions 1000, harness 900, template
800, asset 700, test-ci 600, lesson 500, fix 400, docs 300, showcase 200,
security 100. Sizes add S=3, M=2, L=1. Tier 0 first filters out forbidden
categories and L, then puts S before M, then applies value weights. Other
tiers retain value-first order. Equal scores sort by stable id.

Reference parsing assumes pipe-delimited Markdown tables: `Library` cells
containing missing, weak or legacy in the matrix, and `Class` cells BLOCK,
MODE or HELPER in triage. COVERED, SKIP and explicitly completed rows are
excluded. Prose is not parsed. Historical rows may already be addressed;
confirm current catalogue coverage before claiming them. Skip discovery parses TypeScript test calls, ignores comments, strings and
explicit false options, and may include justified environment gates.

`--online` is the only mode that queries GitHub. It first checks that `gh`
is installed and authenticated, then reads up to 1000 open issues and 1000
open PRs. Agent-ready issues become opportunities. Matching uses opportunity
ids, titles, evidence paths and PR files. Claimed issues and matching open
PRs remove taken work; removed items retain their covering refs in the JSON
`dropped` list. Failed authentication or queries retain offline results with
a warning. Online runner tests are fully mocked.

`pnpm contrib:check --base BASE` uses the merge-base of BASE and HEAD.
Without `--base`, it tries upstream/main, origin/main, each remote's symbolic
HEAD, then main. If discovery fails, pass `--base <commit>`. The PR drafter
uses the same discovery. It checks the committed triple-dot diff; run
`pnpm change:add` and make a local commit before checking. Uncommitted edits
are not included in intake and produce a warning. A valid added change entry
declares the gate category; `--category <id>` may also select it and must agree
with the entry. Without either, it falls back to matching path categories.
The GitHub category adapter uses the same declared-category selection.
Path/category mismatches remain intake findings. Locally, a category gate with
the same command as an always-on gate (`pnpm lint`, `pnpm typecheck`) runs once,
and a failed test gate's summary names the failing test files. The shared exported gate
plan is `src/lib/contrib/gates.ts`, for CI generators and consistency tests:

1. Contribution intake, with `--body pr.md` and optional trusted
   `--context context.json` for full G0/G1; without a body, structural checks
   reuse the intake evaluator and change-entry category, omitting PR-body,
   CLA, tier and open-PR checks. Protected paths still need trusted approval.
2. The declared category's gates (or matching categories when undeclared), de-duplicated in category order.
3. Lint, typecheck, fast tests, context budget against the base, instruction
   lint, instruction security against the base, diff leak check against the
   base and API surface freshness.

Gate output and start/end progress with duration stream to stderr. Each gate
times out after 30 minutes for test suites and regression proof, 5 minutes otherwise; use
`--timeout-min <minutes>` to override. Evidence is saved atomically before
the first gate and after every gate; unfinished/skipped gates remain unverified
after interruption. Interrupting stops the run and its active process group.
Gate failures and timeouts do not prevent later checks from collecting evidence.
`.contrib/evidence.json` records base/head, categories, each literal command,
exit code, duration and a short summary, plus omitted checks. It is ignored
by Git. `--only typecheck` or `--skip lint,test:fast` supports iteration;
category gates have names such as `category:typecheck` and `category:library:catalogue`. Shared lint
or typecheck may run again after category gates, preserving the agreed order.
A partial run is recorded as partial, even when every selected check passes.

`pnpm contrib:pr --model MODEL --owner HANDLE --out pr.md` drafts the body
from exactly one added `.changes` entry and the committed diff. It validates
category/size/issue/autonomy/harness flags, requires an issue for M/L, and
includes What, Why, Evidence, Not verified and Risks. Supply `--why` and
`--risks` to replace the drafting prompts. `--what` overrides the change-entry
body. The body prints as `metadata.body` in the JSON envelope and is also
written with `--out`. Stale base/HEAD evidence is marked unverified and its
passing results suppressed. Tracked edits and untracked source/configuration
or test files also mark committed HEAD unverified; evidence records dirty
paths before and after gates. PR drafts suppress passing results for such
evidence or when these changes appear after the check. Untracked prose
drafts and the evidence directory are excluded. The command never invokes `gh`.

## G3 regression proof and novelty

The shared category plan runs `pnpm contrib:fails-on-base --base BASE` for
`fix`, and `pnpm contrib:novelty --base BASE` for `library` and `playbook`.
The unprivileged GitHub category adapter executes that same plan, without secrets.
These commands inspect committed revisions; commit the change entry, tests,
fixtures and catalogue before checking.

Regression proof accepts `--head REF` (default HEAD) and `--force` for another
category. Changed or added `tests/**/*.test.ts` files run one at a time with
`node --import tsx --test --import ./tests/helpers/memory-root.ts`, with a
ten-minute timeout per file and explicit TAP reporting to verify execution. A detached temporary base worktree receives only
head versions of changed tests and changed support files under `tests/`,
preserving binary fixtures. It links the current checkout's installed
`node_modules`; no installation or network request occurs. A separate detached
head worktree tests the committed head, so dirty source cannot establish proof.
Both worktrees are removed after success, failure, timeout or handled interruption.

The JSON `metadata.proof.outcome` is `proved` when at least one test fails at
base and all changed tests pass at head; `not-applicable` for another category;
`no-test` for a fix with no changed tests; `passes-on-base` when the tests do not
reproduce the bug; or `fails-on-head`. The last three block. Timeouts, interrupted
runs and runner errors cannot establish proof and fail the command.

Novelty compares new or materially changed catalogue items by id, ignoring the
catalogue's aggregate source hash and excluding an item's own base version.
New playbooks are checked by summary and triggers. TF-IDF cosine uses a shared
vocabulary, smoothed inverse document frequency and stop words, without a new
dependency. `contrib/novelty.json` sets text thresholds to 0.6 for blocks and
0.55 for playbooks. Every item's report retains its top three text neighbours.
New items in the same contribution are also compared with one another.

For block previews, ffmpeg decodes committed images to 9×8 greyscale pixels
and the checker compares 64-bit dHashes. A Hamming distance of 10 or less
blocks; the closest three image neighbours are reported. Catalogue preview
paths and `docs/library/previews/<id>.jpg`, `.png` or `.webp` are supported.
A missing preview or unavailable ffmpeg produces an explicit skip reason;
invalid previews fail rather than silently bypassing comparison. New playbooks
also run the existing matcher against each of their English triggers and report
existing routes ranked ahead of them, including the matcher's tie ordering.

A text score above its threshold, a close preview or a competing playbook
requires `novelty: existing-id adds <what is new>` in the single added change
entry. `pnpm change:add --novelty "existing-id adds adjustable perspective"`
writes this field. Name every reported overlapping id and explain the difference;
a bare id or an explanation without the overlapping ids does not clear the check. Accepted
justifications retain neighbours and scores in the report. This checks that an
explanation is present; maintainers assess whether the difference has value.

## Regeneration

`pnpm regen` runs library catalogue, playbook index, command catalogue, model
slots, film routes, API surface, README metrics, `credits:write-doc` and
`deps:licences`, in that fixed order (`src/lib/contrib/regen.ts`).
Credits generation is skipped only in a checkout without that registered alias.
It stops at a failed generator and reports changes already made. Changed
paths are measured by content before and after the run, including new,
non-ignored files, so a second successful run reports no changes if the
underlying generators are deterministic. Existing generators may update
files outside this work package; regenerate on an integrated checkout.

## Comment decisions and trust history

The pure parser in `src/lib/contrib/commands.ts` accepts standalone `/claim`,
`/unclaim`, `/bench-lite` and one-line `/appeal <reason>` commands. The
trusted workflow supplies the comment author, tier, target state, claims,
appeal history and current time, then executes the returned assignment,
label, reopen and comment actions. This module makes no GitHub calls.

Claims require an open issue, expire exactly seven days after claiming
unless linked to a draft PR, and use the tier open-PR limits as active-claim
limits (2/5/10/unlimited). Another active claimant blocks a claim. The
claimant or a maintainer can unclaim. Bench-lite requires an open PR and
tier ≥2. Only the closed PR's author may appeal, once, and only a closure by
the automation: the trusted caller sets `closedByRule` when the last `closed`
event's actor is `github-actions[bot]` and the bot's `agentbros:autoclose`
comment names the rule (labels are not required, so closures labelled before
`closed:process` existed stay appealable). A manual closure or rule 5 is
refused. An accepted appeal reopens the PR, adds `appealed` and
needs-human, and the adapter records `Appealed rule N` in a bot
`agentbros:appeal` comment before reopening; autoclose reads it back so the
appealed rule alone stops closing the PR. The caller must persist claim
timestamps; returned actions do not themselves record that history.

`historySummary` converts an already author/repository-filtered GitHub PR
list into the existing `computeTier` input. Only closed, unmerged PRs with
the trusted `closed:slop` label count as slop closures; `closed:process` and
`triage:likely-slop` from LLM triage do not count. The label comes from
autoclose rules 3 and 5 or a maintainer's manual slop closure. Both windows
exclude future timestamps: the share window starts strictly after now minus
90 days, the demotion window after now minus 30 days.
`.github/trust.json` holds version 1 and an overrides array of handle, tier,
reason and optional ISO timestamp `until`. Handles compare case-insensitively;
expired overrides are ignored. Grants feed the existing tier computation,
including its ten-merge condition for tier 2 and temporary demotion rule.
