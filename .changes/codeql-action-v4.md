---
category: security
bump: patch
breaking: false
pr: 19
authors: [ilyamk]
harness: claude-code
---
CodeQL's init, analyze and upload-sarif actions move to v4.39.3 together (pinned to commit 33d7b85), and Dependabot now groups them, since a split bump leaves CodeQL on mismatched majors.
