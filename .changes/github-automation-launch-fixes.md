---
category: security
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Launch-ready contribution automation: a tier-3 override for the maintainer (no protected-path block, never autoclosed, can `/unclaim`), a Dependabot intake route, CLA signatures by the `CLA.md` statement bound to the current `CLA.md` blob with refusals answered on the PR, releases triggered by the push to `main`, separate reviewer-gated `release` and unattended `automation` environments, a seven-day reminder before closing unapproved protected-path changes, early comment filters and per-source concurrency keys, job timeouts, read-only job tokens for App-token pushes, rebase-and-retry for bot pushes to `main` and a nightly whole-tree leak scan.
