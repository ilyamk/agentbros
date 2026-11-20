# GitHub administration

Last updated: 2026-11-20

This is the deployment guide for the contribution workflows in `ilyamk/agentbros`.
Local fixture tests establish API and workflow contracts; they do not establish live
GitHub behaviour. Keep the repository private until the sandbox checks below pass. The licence (Business Source License 1.1,
`BUSL-1.1`), CLA version 2.0, commercial licence and trademark policy are final (2026-11-17).

## Settings to apply by hand

1. Set `main` as the default branch. Enable Actions with read-only default token
   permissions and allow the explicitly pinned actions used by these workflows.
   Leave "Allow GitHub Actions to create and approve pull requests" off: the
   release and model-refresh PRs are opened with the App's token, not
   `GITHUB_TOKEN`. Create the
   GitHub App `agentbros-release` (contents and pull-request write, installed on
   this repository only); store its client ID as the variable
   `RELEASE_APP_CLIENT_ID` and its private key as the secret
   `RELEASE_APP_PRIVATE_KEY` in both the `release` and `automation`
   environments. The slug must stay `agentbros-release`, or update
   `contrib/release.json` and the workflows' `git config user.name` to match,
   else autoclose treats the release PR as an ordinary PR. Bot commits use the
   bot account's noreply address (`<user id>+agentbros-release[bot]@users.noreply.github.com`),
   resolved at run time from `GET /users/agentbros-release[bot]`. This single
   App is the current wiring; step 8 splits it so that no unattended job holds
   a key that can tag or publish a release.
2. Create a `main` ruleset: require pull requests, squash merging, the merge queue,
   passing checks `pr-intake`, `ci`, `category-gates` and `context-budget`, and
   CODEOWNERS review. Dismiss stale approvals, require approval of the latest push,
   resolve review conversations, and deny deletion and force pushes. Do not
   require signed commits: the App's commits pushed with `git` are unsigned.
   Bypass list, nothing else:
   - Repository admin (`ilyamk`) in **pull request only** mode. `ilyamk` is the
     sole CODEOWNER and GitHub never counts an author's own approval, so without
     this bypass no owner PR can satisfy CODEOWNERS review. The bypass still
     forbids direct pushes.
   - The `agentbros-release` App, **always**: `post-merge-regen` and `showcase`
     push generated commits straight to `main` (rebasing and retrying up to three
     times when `main` moves). Without it those pushes are rejected.

   Do not give ordinary contributors a bypass. Keep the required checks on
   `merge_group` as well. Create a second ruleset for `bot/*` allowing only the App
   (and the owner) to push.
3. Create environments, each with deployment branches restricted to `main`:
   - `release`: required reviewer `ilyamk`; used only by `release.yml` (tag,
     GitHub release, provenance). Holds the App variable and secret.
   - `automation`: no reviewers; used by `release-pr`, `post-merge-regen`,
     `showcase` publish and the `models-refresh` PR job, which run unattended on
     every push or schedule. Holds the same App variable and secret.
   - `triage`: required reviewer for the first paid run; vendor keys below.
   - `pages` and `models`: as in the table below.

   Set the **repository** variable `TRIAGE_ENABLED` to `true` only when paid triage
   is configured. Environment variables are invisible to a job-level `if:`, so it
   cannot live in `triage`; while it is unset, `ai-triage` and the nightly audit do
   not start and never request the `triage` environment. Until step 8 is done,
   the same App key sits in `release` and `automation`, so an `automation` job
   could tag or publish without the `release` reviewer: complete step 8 before
   the first public release. Protect environment
   settings from contributor edits. A fork PR must not be able to obtain either
   vendor key. `release.yml` runs on the push to `main` that merging the
   `bot/release` PR creates: a reviewer-free `detect` job finds the merged PR
   (`head.ref == bot/release`, same repository, label `release:ready`) through
   `/commits/{sha}/pulls`, and only then does the gated `release` job start.
   A rejected or failed release is retried by dispatching `release` on `main`
   with its version; a version whose tag exists is skipped with a notice
   ([release workflows](releases.md#release-workflows)).
4. Create orphan data branches `cla-signatures` and `automation-state`, with no
   executable workflows. Initialise `signatures.json` on `cla-signatures` with
   `{"version":1,"signatures":[]}`. Initialise `triage-budget.json` on
   `automation-state` with `{"version":1,"reservations":[]}`. The automation also
   writes `triage-ledger.jsonl` there. Protect both branches against deletion and
   force pushes; restrict their writers to the automation identity and owner.
   GitHub's `contents: write` token permission cannot itself be restricted to one
   branch: use branch rulesets and a dedicated GitHub App/token where necessary.
5. Enable secret scanning, push protection, Dependabot alerts/security updates,
   private vulnerability reporting and CodeQL (free for public repositories):

   ```bash
   gh api -X PATCH repos/ilyamk/agentbros --input - <<'JSON'
   {"security_and_analysis": {"secret_scanning": {"status": "enabled"},
     "secret_scanning_push_protection": {"status": "enabled"}}}
   JSON
   gh api -X PUT repos/ilyamk/agentbros/private-vulnerability-reporting
   gh api -X PUT repos/ilyamk/agentbros/vulnerability-alerts
   gh api -X PUT repos/ilyamk/agentbros/automated-security-fixes
   ```

   Under Actions → General, require approval for fork pull request workflows from
   first-time contributors (or all outside collaborators). After the first
   `scorecard` run on `main`, the README's Scorecard badge resolves; the CodeQL badge
   resolves after the first `codeql` run. Register the project at
   <https://www.bestpractices.dev/> with a maintainer account, answer the passing
   questionnaire from [the evidence map](#openssf-best-practices-evidence), and add
   its badge (`https://www.bestpractices.dev/projects/<id>/badge`) in place of the
   README comment. Select GitHub Actions as the Pages
   build source. The `pages` environment deploys to
   `https://ilyamk.github.io/agentbros/`; configure that environment name explicitly
   rather than relying on an automatically created `github-pages` environment.
6. Enable Discussions with Announcements (maintainers only), Ideas, Q&A and
   Show and tell categories. Keep security reports in private advisories.
7. Run `pnpm github:labels` with a repository token to synchronise
   `.github/labels.json`. Run `pnpm github:codeowners --check` before enabling
   required ownership review. CODEOWNERS is generated only from
   `contrib/protected.json`, always assigning `@ilyamk`. Set the repository
   About box: description "Source-available, agent-driven video production
   system built on Remotion (BUSL-1.1)"; topics `remotion`, `video`,
   `video-production`, `ai-agents`, `claude-code`, `codex`, `motion-design`,
   `source-available`. Do not use the `open-source` topic or describe the
   repository as open source. GitHub's licence detection does not recognise
   every Business Source License 1.1 file and may show "Other". The GPL text for
   the Blender code lives in `LICENSES/GPL-3.0-or-later.txt`, outside the root,
   so it is not taken for the repository licence. Check the sidebar in the
   sandbox: it must not show GPL-3.0 or AGPL-3.0 as the repository licence;
   "Other" or "BUSL-1.1" is correct, and `package.json` declares `BUSL-1.1`.

8. Split the GitHub App (RFC 0002 B10/F10). A GitHub App's `contents: write`
   permission already includes creating tags and releases, so the split is
   enforced by keys, environments and rulesets together, not by App permissions
   alone:
   - [x] Create a second App, `agentbros-automation`, installed on this
     repository only with contents and pull-request write. Store its client ID
     as the variable `AUTOMATION_APP_CLIENT_ID` and its private key as the
     secret `AUTOMATION_APP_PRIVATE_KEY`, **only** in `automation`.
   - [x] Keep `agentbros-release` (contents write) for tags and releases. Store
     its key and client ID **only** in `release` (required reviewer `ilyamk`)
     and delete them from `automation`.
   - [x] Add a tag ruleset on `refs/tags/v*` that restricts creation, update and
     deletion, with `agentbros-release` as the only bypass. The automation App
     then cannot create a version tag, and so cannot publish a version release.
   - [x] Move the always-bypass on the `main` ruleset from `agentbros-release`
     to `agentbros-automation` (`post-merge-regen` and `showcase` push to
     `main`; the release job never pushes). Let the `bot/*` ruleset allow only
     `agentbros-automation` and the owner.
   - [x] Code follow-up (done ahead of the settings): `release-pr`,
     `post-merge-regen`, `showcase` publish and the `models-refresh` PR job mint
     their token from `AUTOMATION_APP_CLIENT_ID`/`AUTOMATION_APP_PRIVATE_KEY`,
     falling back to the release App's while those are unset, and commit as the
     minting App's slug (`<slug>[bot]`, `BOT_ID` looked up from it).
     `contrib/release.json` `botLogins` lists both bots, since either may author
     the release PR. A workflow test pins that only `release.yml` requires the
     release key. Once the release key is deleted from `automation`, the
     fallback reads an empty secret, so no unattended job can hold it; drop the
     fallback in a later change. `showcase-media` stays creatable by the
     automation App: it is not a `v*` tag and is created with `--latest=false`.
   - [x] Check in Settings → Environments and Rules that the result matches,
     then record it in the sandbox evidence.

## Applied settings (2026-11-18)

`ilyamk/agentbros` was created from a clean export, configured while private
with Actions disabled, made public, and only then had Actions enabled. The
settings above are applied, with these differences:

- **Merge queue**: not available to repositories owned by a personal account,
  so the `main` ruleset has no merge-queue rule. PRs merge by squash once the
  four required checks (`pr-intake`, `ci`, `category-gates`, `context-budget`,
  all from GitHub Actions) and CODEOWNERS review pass. Keeping those checks on
  `merge_group` costs nothing and is ready for a move to an organisation.
- **Data branches**: the `cla-signatures` and `automation-state` ruleset
  forbids deletion and force pushes but does not restrict updates, because the
  CLA and triage jobs write through `GITHUB_TOKEN`
  (`github-actions[bot]`), which a branch-update restriction would block.
- **Allowed actions**: GitHub-owned actions plus `astral-sh/setup-uv@*` and
  `ossf/scorecard-action@*`. "Require actions to be pinned to a full-length
  commit SHA" stays off: GitHub's own composite actions (for example
  `actions/upload-pages-artifact`) call other actions by tag. Our workflows pin
  every action by SHA, enforced by `tests/workflows.test.ts`.
- **App split (step 8)**: done from the start. `agentbros-release` holds keys
  only in `release` (required reviewer `ilyamk`) and is the only bypass of the
  `v*` tag ruleset; `agentbros-automation` holds keys only in `automation`, is
  the always-bypass of `main` and may push `bot/*` with the owner.
- **Fork pull requests**: workflows from all outside contributors wait for
  approval. Secret scanning, push protection, private vulnerability reporting,
  Dependabot alerts and security updates are on; CodeQL uses the advanced
  setup in `codeql.yml`, so default setup stays off.
- **Sandbox**: the throwaway sandbox run was skipped; the first PR on the
  public repository is the live check of the intake, CI and post-merge routes.

All GitHub jobs use Linux; macOS/Swift and MLX checks remain local. Weekly/manual Python acceptance covers pinned Blender and public CPU models.

CI uses exact primary/reserve Node versions from the nvm files, explicit pinned pnpm installation without Corepack, and `runtime:check` before checks. Both runtime roles cover full-suite shards and browser/render jobs ([runtime policy](node-runtime.md)). Linux CI also runs locked Python lint, format, types, contracts, audit and affected profiles ([Python policy](python-runtime.md)).

## Environment credentials

| Environment | Secrets | Token permissions and purpose |
|---|---|---|
| `triage` | `TRIAGE_ANTHROPIC_API_KEY`, `TRIAGE_OPENAI_API_KEY`, `TRIAGE_OPENROUTER_API_KEY` | Judge-only vendor credentials. The job's GitHub token has contents write for the automation-state data branch, PR write for advisory labels, and actions read to download data. |
| `release` | `RELEASE_APP_PRIVATE_KEY` (secret), `RELEASE_APP_CLIENT_ID` (variable) | Reviewer-gated; `release.yml` only, one release at a time (`release` concurrency group). Its job token has contents read plus OIDC id-token and attestations write; the tag and release use the App token. |
| `automation` | `RELEASE_APP_PRIVATE_KEY` (secret), `RELEASE_APP_CLIENT_ID` (variable); after step 8 only the automation App's key | No reviewers. `release-pr`, `post-merge-regen`, `showcase` publish and the `models-refresh` PR job; their job tokens are read-only. The `agentbros-release` GitHub App, installed on this repository only with contents and pull-request write. Each job mints a one-hour installation token with `actions/create-github-app-token`, scoped to the permissions it needs; its login must be listed in `contrib/release.json` ([releases](releases.md#release-pr-intake)); the bot maintains its own release branch and generated outputs. Never a contributor branch. |
| `pages` | None | GitHub's Pages write and OIDC id-token write permissions. |
| `models` | `FAL_KEY`, `HIGGSFIELD_API_KEY`; optional variables `MODELS_SAMPLE_IMAGE`, `MODELS_SAMPLE_VIDEO`, `MODELS_SAMPLE_AUDIO` | Read-only token. `models-refresh.yml` runs `pnpm models:refresh` daily (free catalogue, schema and price reads and estimates, never generation) and uploads an allow-listed patch; a second job in `automation` applies it as data and opens or updates the `bot/models-refresh` PR for owner review. Use keys that cannot spend beyond what the account owner accepts. |

Other jobs use only the job-scoped `github.token`; they receive no vendor or
provider secrets. No CI job receives media-generation provider keys.

The CI checks job runs `pnpm deps:licences --check --strict --scope repository-source`
against the inventory and protected exact-version review ledger. It checks source
distribution only; dependency binaries and browser bundles require separate
clearance ([licence procedure](dependency-licences.md)).

Triage config v2 ships with `enabled: false`, two OpenRouter slots from different
model families, USD 0.25 per-PR and USD 10 monthly planning bounds, and no assumed
prices. Disabled PR/audit jobs return a clean skip and apply no labels/comments.
Before enabling, fill in verified exact-model prices and create only the
configured providers' dedicated credentials. A dedicated OpenRouter key with
`limit` and `limit_reset: monthly` supplies the provider-side billing cap; our
reservations are planning bounds. See [triage configuration](triage.md#configuration-and-costs).

The wrapper re-derives intake, CLA, current head, author tier and label-actor
permissions from REST before admission. It rebuilds review material from the same
facts. Tier zero requires a maintainer-applied `triage:requested` label. Each
owner gets four monthly runs by default. Maintainers can then dispatch `ai-triage`
with input `pr`; applying the label alone does not launch a paid pass. There is no
`pull_request_target` path. Skips produce no comment spam.

The automation-state branch reserves the quoted pass before judges start. The
restored ledger attributes provider settlements to that run. Complete ledger
evidence settles the remote reservation to actual cost (with up to three SHA
conflict retries); missing or unsettled evidence retains the full bound.
Cancellation never releases it. Monthly and per-PR checks use settled amounts
where known. A new head may run again up to `maxRunsPerPr` (default two), within
the same cumulative per-PR cap. The same head cannot run twice. PR reservations
store owner and head SHA; legacy unscoped charges remain conservative. PR/audit
jobs share one concurrency group. Never delete ambiguous reservations to retry
for free. The application step ignores skipped or stale-head reports.

Maintainers can also use `pnpm triage:local --pr NUMBER --harness codex|claude|both`
with their own subscription authentication. Optional `--post` checks the head
again and applies advisory comments and `triage:*` labels through their own `gh`.
The external judges run in empty temporary directories with restricted tools and
no GitHub-token environment. See [local triage](triage.md#local-subscription-triage).

## Trust boundaries and integration

Read-only PR jobs can execute PR code without credentials. Privileged jobs check
out only the default branch and install its locked dependencies with
`--ignore-scripts --config.ignore-pnpmfile=true`. The configuration form disables
pnpmfile hooks as well as lifecycle scripts; pnpm 12.11.2's flag documentation
was unavailable offline, so the configuration form is used conservatively.
`contrib/protected.json` covers package-manager hooks/configuration and the
computed transitive modules of privileged workflow commands. The workflow test
recomputes this set, including spawned catalogue generators, and refuses gaps;
regenerate CODEOWNERS after extending protection. Required unprivileged intake
also runs the dependency audit and licence gate described in
[contribution gates](contributing-gates.md#dependency-gate). They download artefacts into `out/untrusted-*` and pass those paths only
as data to base-branch scripts. The comment workflow can show an untrusted context
report as quoted text; that report never decides gate status.

Before labelling or closing, the scripts obtain file paths (including renames),
line counts, author history, labels and CLA signatures through GitHub REST.
Pagination or file-list truncation fails closed for that PR. Maintenance and
advisory application isolate each PR's failure, add `needs-human` if absent and
continue other PRs and claim expiry; a failed label request is reported as an
unlabelled skip rather than aborting the batch. When GitHub omits a text file's
patch (a large file such as `uv.lock`), intake rebuilds it from the merge base
and head contents (blobs for files over 1 MB) and keeps it only when its line
counts equal GitHub's; the rebuilt patch is leak-scanned like any other. A patch
that cannot be rebuilt or does not match, and any incomplete patch, defers to
human review; an absent patch alone is not evidence of a binary. Media extensions and NUL bytes provide binary evidence. Workflow
changes, including a rename out of `.github/`, cannot automatically enter the
owner queue. Appeals retain `appealed` and `needs-human` labels; only a human can
clear their review requirement, and autoclose still applies every rule but the
appealed one (rule 5 always). Omitted or stale gate runs cannot admit a PR.
An old workflow result is ignored after its head revision changes.

The adapters share the contribution policy modules:

- `src/lib/contrib/history.ts`: `historySummary(prs, now, overrides, handle)`;
- `src/lib/contrib/commands.ts`: `decideCommentCommand(context)` and
  `activeClaims(claims, now)`;
- `src/lib/contrib/gates.ts`: `contributionGates(categories, base)`; the GitHub
  category wrapper selects the exact exported `category:*` gate names.

The adapters use these modules rather than duplicate their policies. API tests
inject pure decisions and recorded responses. Workflow commands for triage,
instruction audits, regeneration, releases, Pages, scouting, showcase media and
benchmark verification are registered in the integrated command catalogue.

CLA acceptance uses the exact statement in `CLA.md` (`I have read the CLA and I
agree to it.`), posted by a human account as a new PR comment. The signature is
bound to the current `CLA.md` blob, recorded with the default-branch commit at
signing time, so later merges do not invalidate it. The older long form naming a
commit is accepted when that commit's `CLA.md` blob equals the current one. A
comment that looks like a signature but is refused gets an explanatory reply.
Only comments containing the statement start the `cla` signature job, which has
no shared concurrency group. The registry appends through the contents API with
optimistic concurrency. The repository owner is the Licensor and needs no
signature; `Co-authored-by` trailers for the coding agents listed in
`contrib/agent-coauthors.json` (Claude Code, OpenAI Codex, GitHub Copilot and
Cursor, matched by email or by a listed login's `users.noreply` address, each
with its evidence) are not signatories, since agents cannot sign and their
output is the submitting human's Contribution (2026-11-17). PR
checks include commit authors and `Co-authored-by` identities; unresolved email
identities defer acceptance. A valid new signature requests a rerun of failed
intake for the same head, so the required check can become green without a new
commit. The CLA's signing instructions and AI clause are final and match this route
(2026-11-16).

Release planning and application run on the base branch. The narrow release route described below permits only API-verified bot identity and release diffs; it always requires human review. Repeated plans merge the latest base ancestry into the bot branch and restore the latest base tree before applying the release, then push normally. The release workflow reads the merged revision's changelog because consumed change entries have already been removed. Post-merge regeneration supplies the merged PR number when GitHub associates it with the push; verify merge-queue batches separately.

Showcase media is acquired from manifest attachment URLs after merge, sanitised without secrets and published through a protected job. Benchmark submissions are acquired from issue attachments after a maintainer applies `bench:submitted`; a separate reporting job consumes schema-validated results. Public export verification checks signature and integrity only, with measurements explicitly labelled as claims requiring the private original for recomputation. No source recordings or media binaries are added to git. Details and guide links are below.

## Maintainer and Dependabot routes

`.github/trust.json` grants `ilyamk` tier 3. Tier 3 has no open-PR, size or
category limits, needs no `design-approved` for protected paths at intake
(CODEOWNERS review still applies), is never closed by autoclose, and may
`/unclaim` others' claims; `gh-commands` reads overrides from the default branch.
The owner's PRs still carry the PR block and one change entry.

The owner works on branches in this repository rather than a fork, under the
contributor rule `<category>/<slug>` ([branch rules](branches.md));
`diag/*` and `spike/*` are draft-only. The only long-lived branches are `main`,
`cla-signatures` and `automation-state`; `bot/*` belongs to the App. The
repository allows squash merges only, keeps the commit or PR title as the squash
title (`COMMIT_OR_PR_TITLE`) and deletes head branches on merge (checked
2026-11-20).

Same-repository Dependabot PRs (`dependabot[bot]`, `dependabot/*` branch) that
change only `package.json`, `pnpm-lock.yaml` or `.github/workflows/*.yml` take the
`dependabot-route`: no CLA, PR block or change entry, pass G0/G1 with warnings,
always get `needs-human`, never `ready-for-owner`, and autoclose skips them. The
required `deps:check` gate still decides: a bump to a package whose exact version
is recorded in `contrib/licence-reviews.json` needs a new review entry before
intake can pass.

Autoclose rule 4 (protected paths without `design-approved`) posts a reminder
and closes only seven days later, like rules 1 and 6. `pr-intake` also runs on
`labeled`/`unlabeled`, so applying `design-approved` re-runs the required check.
After a `pr-intake` run, autoclose processes only that PR; the hourly sweep
handles all open PRs, duplicates and claim expiry, fetching the PR list once per
run. Every job has `timeout-minutes`; no `run:` script interpolates `${{ }}`.

## Sandbox test and cutover order

Follow RFC 0001 §12: build and test locally first, exercise GitHub on a throwaway
private sandbox, then export a clean initial tree, verify a fresh clone, create
the private `ilyamk/agentbros` repository, apply its settings, run the workflows,
and only then publish and archive the previous private repository.

In the sandbox:

1. Done (2026-11-17): every action is pinned to a real commit SHA; no all-zero
   placeholder remains. The workflow tests still list any placeholder as a
   warning, so a new one cannot slip in unnoticed.
2. Set the three environments and data branches; synchronise labels, exercise
   CODEOWNERS ownership, merge queue checks and bot branch restrictions. Use test
   vendor credentials and an explicitly authorised small budget only for the
   sandbox's paid portion; local tests never call vendors.
3. Open same-repository and fork PRs: unsigned, signed, co-authored, malformed PR
   block, invalid change entry, protected paths, oversized, binary, text with an
   omitted patch, duplicate and synthetic leak examples. Confirm reminders use
   bot comments, deterministic closures explain the rule, and `/appeal <reason>`
   only reopens once for human review.
4. Forge an intake artefact claiming success and including executable files.
   Confirm only REST facts affect labels/closures, no downloaded code executes,
   all four gate runs must match the head, and `.github/**` changes always need
   human review. Complete an old triage run after pushing a new revision and
   confirm it has no effect on the new head.
5. Exercise `/claim`, `/unclaim`, `/bench-lite`, tier limits and expiry after
   seven days without a linked draft. A bare issue number in prose must not
   count as a link. Verify edited or impersonated comments cannot sign or run
   commands as another user.
6. Verify triage agreement/disagreement, disabled skips, unknown-price refusal, remote state refusal,
   settlement and SHA-conflict retries, owner quotas, label-actor permissions,
   cancellation after remote reservation and same-head rerun protection. Confirm refusal never merges, approves or closes a PR.
7. Merge normal changes, repeat post-merge regeneration, update the release PR
   twice, merge it and check the tag, notes and `metrics.json` asset. Reject the
   `release` approval once, then retry with a `release` dispatch (`version`
   input) and confirm a second dispatch of the published version only posts a
   notice. Confirm a third release cycle opens a new PR rather than editing the
   merged one, and that `showcase-media` never shows as Latest. Publish a showcase, verify its
   uploaded media and committed URLs, verify a tampered benchmark bundle, build
   Pages and check internal links. Confirm the expected fork/token constraints
   and required-check names through the actual GitHub UI.
8. Record sandbox evidence, including the licence shown in the sidebar, and
   remaining integration gaps (the licence and CLA version 2.0 are final).
   Only after these are resolved should the final clean-tree cutover proceed.

## Attachment intake and release routing

The release bot has a narrow API-verified G0/G1 intake route controlled by `contrib/release.json`; only the configured account on the same-repository `bot/release` branch with the allowed release diff qualifies. It receives `release` and `needs-human`, cannot enter `ready-for-owner` automatically, and autoclose skips it. See [release intake](releases.md#release-pr-intake). Keep this policy protected and set the configured bot login to the account that owns the release bot token.


The same protected `contrib/release.json` policy also permits `bot/models-refresh`, with the same verified bot logins and same-repository head/base identity. Every path must be a JSON file beneath `src/lib/models/` or `src/lib/providers/schemas/`, the current `docs/model-slots.md` comparison page. Only complete text A/M/D patches qualify; forks, renames, binaries, missing/truncated patches and extra paths use normal intake. Matching PRs receive `models-refresh-route` and `needs-human`, never automatic `ready-for-owner`, and autoclose skips them even before labels are applied. Run reports are ignored `out/qa/` outputs attached for seven days, not allowed patch paths. Merge accepts proposed candidates; activation remains an explicit owner command.

`pages.yml` checks out full history, writes metrics and Markdown/JSON scout data, then builds Pages. `showcase.yml` processes changed showcase manifests on default-branch pushes after merge: an unprivileged job downloads allowlisted HTTPS attachments and re-encodes bounded media; a protected `automation` job revalidates the SHA-256 manifest and file properties, uploads assets to the `showcase-media` release (created with `--latest=false`, so it never becomes the repository's Latest release) and commits only showcase metadata/README through the existing bot push path. Its commit shares the regeneration concurrency group. See [showcase media](showcases.md#publish-reviewed-media).

`bench-verify.yml` starts only when a maintainer applies `bench:submitted`. Its read-only job downloads/extracts the issue attachments and verifies signatures against the event author's GitHub keys. The reporting job has `contents: read, issues: write`, installs only base code and consumes a strict benchmark JSON report, bound to the event issue and author. It upserts one comment and manages `bench:verified`/`bench:rejected`. Attachment processing has no secrets or write permissions; no workflow interpolates issue prose into shell commands. See [benchmark submission](benchmark.md#submit-a-bundle-for-github-verification).

## OpenSSF Best Practices evidence

Answers for the passing-level questionnaire; each points at what already exists.

| Criterion area | Evidence |
|---|---|
| Description, interaction, contribution | [README](../README.md), [CONTRIBUTING](../CONTRIBUTING.md), [GOVERNANCE](../GOVERNANCE.md), issue forms and Discussions |
| Licence | Business Source License 1.1 (`BUSL-1.1`) in `LICENSE`, source-available and converting to AGPL-3.0-or-later four years after each release; other licences mapped in `NOTICE.md` (GPL-3.0-or-later Blender code in `LICENSES/GPL-3.0-or-later.txt`); commercial licence in `COMMERCIAL-LICENSE.md`; [trademark policy](../TRADEMARKS.md); [CLA](../CLA.md) version 2.0. The OpenSSF badge asks for an open-source licence: BUSL-1.1 is not one, so this criterion is not met until a version's Change Date |
| Documentation | [install](install.md), [commands](commands.md), area `AGENTS.md` files |
| Public version control, unique versions, release notes | Git on GitHub; semantic versions in `package.json`; `CHANGELOG.md` generated from `.changes/` at each release ([releases](releases.md)) |
| Bug reporting and response | GitHub issues with forms; [SUPPORT](../SUPPORT.md) |
| Vulnerability reporting | Private vulnerability reporting, [SECURITY](../SECURITY.md) |
| Working build, automated tests, new tests for new functionality | `pnpm check`; `ci.yml`; category gates require a regression test and failing-on-base proof for fixes ([contribution gates](contributing-gates.md)) |
| Compiler warnings, static analysis | TypeScript strict, ESLint in `pnpm lint`; CodeQL on every PR |
| Secure delivery, no leaked credentials | HTTPS-only GitHub delivery; secret scanning with push protection; `leak:check`; release provenance attestations |
| Dynamic analysis | Not claimed; the node:test suites and browser render tests are functional, not fuzzing |

Workflow evaluation (2026-11-15): both Node roles retain `bench:workflow` contract reports in CI; macOS records installed-native results, with unavailable resources skipped and downloads forbidden. Nightly refreshes the deterministic reports. No CI job silently starts a real agent or provider. Local/hosted execution are distinct evidence ([guide](agent-workflow-e2e.md)).
