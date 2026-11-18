# Releases and generated credits

Last updated: 2026-11-17

Release maintenance is offline. It reads local git objects and explicit snapshots; it does not contact GitHub, submit paid work, commit or tag anything. The release workflow owns commits, tags and publication.

## Plan a release

```bash
pnpm release:plan
pnpm release:plan --since v0.1.0 --now 2026-11-15T00:00:00Z
```

The planner validates `.changes/*.md` and compares the current API with the last reachable stable `vX.Y.Z` tag's `docs/api/surface.json`, using the same builder and comparator as `pnpm api:surface --compare`. `--since` selects a baseline explicitly. Without a baseline surface, `initial` is true; without a release tag, the proposed version is the current package version, so launch remains `0.1.0`.

The highest declared bump or API classification wins. `breaking: true` counts as major. In `0.x`, a major or breaking change becomes a minor bump, minor stays minor and patch stays patch. From `1.x`, normal semantic version bumps apply. `underDeclared` lists entries below the API classification before the `0.x` mapping. This is a repository-wide comparison, so it cannot attribute an API change to a particular entry; the caller decides whether those declarations block intake.

The plan becomes ready at 15 entries, any breaking entry or detected breaking API change, any `security` entry, or 14 elapsed days since the last release tag's creation date with at least one entry. Lightweight tags use the tagged commit date. `--now` makes the calculation reproducible. Missing release history does not invent an elapsed time.

## Write entries and notes

```bash
pnpm change:add --category command --bump major --breaking --summary "Rename the export flag" --migration "Replace --old with --new." --author handle
pnpm release:notes --version 0.2.0
pnpm release:notes --version 0.2.0 --metrics-old old-metrics.json --metrics-new new-metrics.json --context-old old-context.json --context-new new-context.json
```

Breaking entries require a separate, non-empty `Migration:` paragraph. Notes put breaking changes first, then use category titles from `contrib/categories.json`, credit authors by category with GitHub profile links, and list tracked `showcases/*/showcase.json` files added since the baseline tag. A missing showcase folder is allowed. The contributors section leaves out `unknown`, the bot logins in `contrib/release.json` and any `[bot]` account.

Supply both members of each snapshot pair. Metrics snapshots use the raw JSON object produced by `pnpm metrics --write`; the notes use the same numeric delta helper as `pnpm metrics --diff`. Context snapshots use `pnpm context:budget --write` and its context delta helper, including row additions and removals. Copy each run's output to a distinct file before running the next. Historical recomputation and benchmark campaigns are not inferred. A section with no data (no contributors left after filtering, no snapshot pair or no non-zero delta, no new showcase) is omitted rather than printed as "not supplied" or "none".

Every command emits one JSON line. Markdown is in `metadata.notes`, so callers can store it without mixing prose and JSON on stdout.

## Apply a release

```bash
pnpm release:apply --version 0.2.0 --notes release-notes.md
```

Save `metadata.notes` from `release:notes` to a Markdown file and pass it with `--notes` to preserve showcase discovery. Without a notes file, apply builds notes from entries and any supplied snapshot pairs, with an empty showcase list. Apply never invokes git. It validates inputs, updates only the package version, prepends notes to `CHANGELOG.md` (creating its header when absent), consumes the validated change entries and preserves `.changes/README.md`. It refuses a version downgrade, a duplicate changelog version or an empty release. Its JSON result reports `metadata.tag`, for example `v0.2.0`. Run it in the release workflow's clean checkout.

## Release workflows

`release-pr.yml` (environment `automation`) runs on every push to `main`. When the plan is ready it applies the release on the `bot/release` branch (version bump, `CHANGELOG.md`, consumed entries) and opens the PR with the `release:ready` label, or retitles the one that is still open; it looks up only an open PR, so a merged release PR is never edited.

Merging that PR pushes to `main`. `release.yml` runs on the push, finds the merged PR through `/commits/{sha}/pulls` (same repository, `bot/release`, `release:ready`) in a job without an environment, reads the version from that commit's `package.json`, and skips with a notice when tag `vX.Y.Z` already exists. Only then does the reviewer-gated `release` job start: it builds and attests the source archive of the merge commit, runs `pnpm metrics --write` on its checkout of `main`, tags the merge commit and publishes the GitHub Release with the changelog section as notes and the archive and `metrics.json` as assets. Release jobs share the `release` concurrency group with `cancel-in-progress: false`, so a running release, including one waiting for approval, is never cancelled. GitHub keeps at most one pending job per group: if two more releases queue behind a running one, the older queued one is dropped and must be retried by dispatch. The group is on the job, not the workflow, so ordinary pushes to `main` never displace a queued release.

If the approval is rejected or times out, or the job fails, `main` stays bumped and untagged. Retry from the Actions tab: run `release` on `main` with the `version` input (for example `0.2.0`; empty means the version on `main`). The dispatch finds the merged same-repository `bot/release` PR whose merge commit set `package.json` to that version, checks that the commit is on `main`, and continues exactly as the push would, including the tag-exists skip, so a retry of a published version does nothing. GitHub Pages rebuilds on the merge push and nightly; the release job itself never pushes.

### Differences from RFC 0001 §9.3

RFC 0001 §9.3 describes the `release` workflow bumping `package.json`, deleting the entries, writing `CHANGELOG.md` and publishing the site. In the implemented flow the bump, changelog and entry removal happen in the `bot/release` PR, which the maintainer reviews; `release.yml` only tags, attests and publishes, and Pages rebuilds from the merge push. Notes carry no benchmark campaign line, since campaigns are not yet attached to releases.

## Credits as source files

Add or edit one `credits/<id>.json` per source. `src/types/credits.ts` defines four strict variants: repositories, reference films, assets and tools, covering every original table column. `id` matches the filename; `section` selects the table; `order` controls its position, with the id breaking ties. Existing positions use increments of ten to allow insertion.

```bash
pnpm credits:write-doc
pnpm credits:write-doc --check
```

The conversion preserves all 107 original rows and regenerates the original `CREDITS.md` byte for byte. Static prose and table headers live in `src/lib/release/credits-template.md`; source facts live only in the JSON files. Existing prose describing a row refers to the generated row. Keep library `inspiredBy` declarations alongside these credits.

## Regenerate after merge

```bash
pnpm regen:post-merge --base BASE_SHA --head HEAD_SHA --pr 123
pnpm regen:post-merge --base BASE_SHA --head HEAD_SHA --pr 123 --date 2026-11-15
```

This trusted command runs `pnpm regen`: library catalogue, playbook index, command catalogue, model slots, film routes, API surface, README metrics, credits and dependency licences, in that order. For a checkout without the alias it uses `scripts/regen.ts`, or the fallback list in `src/lib/release/post-merge.ts` if that script is also absent. Generator output is captured and failures stop processing.

After regeneration, it dates every surviving `AGENTS.md` changed between the commits and fills zero `pr:` fields only in newly added change entries when `--pr` is supplied. Existing PR numbers, older entries and Markdown bodies are preserved. It uses local git objects and does not create a worktree. The default date is today in UTC; `--date` makes tests and reruns reproducible. Run it only on trusted merged code, in a checkout of the supplied head. Generated files may change; the workflow commits the result.

## Release PR intake

`contrib/release.json` defines the trusted bot logins and the exact `bot/release` head branch used by `release-pr.yml`. Intake reads this policy from the API base revision and requires API-derived author, head-branch and repository identities. Head and base repository names must match; forks cannot use the release route. The PR author is the identity of the token `release-pr.yml` mints, so it must be the `agentbros-release` GitHub App's installation token (login `agentbros-release[bot]`, the same name `release-pr.yml` commits as). A personal token in its place would make the release PR a normal PR, which intake holds for `design-approved` and autoclose then closes. If the App gets another slug, change `botLogins` and the workflow's `user.name` together; `tests/workflows.test.ts` checks they agree.

Every changed path must be a version-only `package.json` modification, `CHANGELOG.md`, a deleted `.changes/*.md` entry other than `.changes/README.md`, `docs/api/surface.json`, or a README change confined to the generated metrics/showcases markers. Package and README changes require complete patches plus both revisions. Added, removed or renamed package/README files, truncated patches, binary files and extra paths fall back to normal intake. `release:apply` currently writes only the package version, changelog and consumed entries, so no other generated paths are exempted.

A matching PR passes G0/G1 with `release-route`, receives `release` and `needs-human`, never receives automatic `ready-for-owner`, and is skipped by autoclose even before labels are applied. Correctness checks and the maintainer's review remain required. The narrow route does not authorise other bot changes.

The same protected `contrib/release.json` policy also permits `bot/models-refresh`, with the same verified bot logins and same-repository head/base identity. Every path must be a JSON file beneath `src/lib/models/` or `src/lib/providers/schemas/`, the current `docs/model-slots.md` comparison page. Only complete text A/M/D patches qualify; forks, renames, binaries, missing/truncated patches and extra paths use normal intake. Matching PRs receive `models-refresh-route` and `needs-human`, never automatic `ready-for-owner`, and autoclose skips them even before labels are applied. Run reports are ignored workflow artifacts with seven-day retention, not accepted commit paths. Merge accepts proposed candidates; activation remains an explicit owner command.
