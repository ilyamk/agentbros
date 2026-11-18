---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Stabilise contributor checks: trust-root discovery follows only code and JSON modules, so ignored `out/qa` reports no longer fail the workflow test; the FIFO refusal test allows a cold tsx start; `contrib/AGENTS.md` regains byte headroom
