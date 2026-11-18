---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Step lease: `next`, `film:next`, `film:brief` and `footage:next` write the current step's allow list and spend authority to `pipeline/session/lease.json`; every CLI and the MCP bridge check it (warn by default, `AGENTBROS_STEP_GUARD=enforce` refuses), `pnpm step:unlock --reason` is the recorded escape hatch, `film:status` reports out-of-step runs, and an optional Claude Code PreToolUse hook gives early feedback
