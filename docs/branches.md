# Branches and pull-request titles

Last updated: 2026-11-20

How contributors, their agents and the owner name, keep and finish branches. Intake does not check branch names yet; the rules keep the history readable and match what [category gates](contributing-gates.md) already enforce on the PR.

## Name

- One branch, one PR, one category. Name it `<category>/<slug>`: the PR block's `category` id from [categories.json](../contrib/categories.json), then a short kebab-case slug, optionally led by the issue number: `fix/console-github-stars`, `library/31-orbit-wipe`, `docs/branch-conventions`.
- There is no `feat/`: use the category whose paths cover the change (`library`, `command`, `playbook`, …).

| Prefix | Who creates it | Merged into `main` |
|---|---|---|
| `<category>/` | contributors in their fork; the owner in this repository | yes, by squash |
| `diag/`, `spike/` | anyone, for diagnostics and experiments | never: draft PRs only |
| `bot/` | the automation App only (its own ruleset) | through the App's PRs |
| `dependabot/` | GitHub | through the Dependabot route ([GitHub automation](github.md#maintainer-and-dependabot-routes)) |

## Keep it current

- Branch from the current `main` (`upstream/main` in a fork).
- Update by rebasing on `main`, never by merging `main` into the branch. Resolve conflicts in generated files with `pnpm regen`, then rerun the checks.
- An M change opens a draft PR within seven days of its `/claim` ([contributor loop](../contrib/AGENTS.md#work-autonomously-within-the-protocol)).

## Title

- One imperative sentence in British English, at most 72 characters, without a prefix: the PR block carries the category. Examples: “Show the GitHub star count once the console session is ready”, “Intake counts docs/api/surface.json as generated”.
- `main` takes squash merges only, and the squash title is `COMMIT_OR_PR_TITLE`: with a single commit GitHub keeps the commit's title, so make it match the PR title.

## Finish

- GitHub deletes the head branch on merge. Delete your local copy with `git branch -D <branch>`: a squash merge is not an ancestor of `main`, so `git branch --merged` does not list it.
- Close a `diag/` or `spike/` PR when its question is answered and record the finding in the PR or an issue.
