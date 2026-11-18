---
category: security
bump: minor
breaking: true
pr: 0
authors: [ilyamk]
harness: claude-code
---
Raising a project's spend ceiling, or setting a first one above zero, needs the user's own words (`pnpm budget --ceiling-usd N --answer "..."`), recorded with when and why in `operations.json` `policyEvents`; lowering stays free, the MCP `budget` tool cannot raise it, and a null `brief.budgetUsd` no longer installs a $10 ceiling on the first paid command

Migration: Existing stores keep their ceiling. To raise one, ask the user and pass their words with `--answer`. A project whose brief has no `budgetUsd` now needs `pnpm budget --project ID --ceiling-usd N --answer "<the user's words>"` before its first paid command. Code calling `OperationStore.configure` to raise a ceiling passes a `CeilingGrant` as the second argument.
