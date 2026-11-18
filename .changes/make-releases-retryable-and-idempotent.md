---
category: test-ci
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Make releases retryable and idempotent: dispatch retry, one release at a time, tag-exists skip, metrics.json asset, open-PR-only release PR edits, showcase-media never Latest, and release notes without bots, unknown authors or empty sections
