---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Step guard: with `AGENTBROS_STEP_GUARD` unset, a project with an autonomous policy or a benchmark run (a `--proxy benchmark` approval, or `AGENTBROS_INTERACTION_MODE=autonomous`) is enforced, interactive work still warns; `pnpm step:violations` (MCP `step_violations`) reports out-of-step runs by step, command and code with `clean`; `film:policy` and `film:revert` are always admitted
