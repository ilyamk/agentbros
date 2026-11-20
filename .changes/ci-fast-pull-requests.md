---
category: fix
bump: patch
breaking: false
pr: 34
authors: [ilyamk]
harness: claude-code
---
Pull requests run CI on the primary Node only, so a PR needs half the runner jobs and waits less in the queue; pushes to main and the merge queue still run both Node versions. Dependabot groups every GitHub Actions bump into one pull request
