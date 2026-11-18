# Observing instruction context loading

`pnpm context:probe --harness claude-code|codex [--dry-run] [--seed SEED]` tests which instruction tokens a harness can recall without reading files. This is an opt-in maintainer experiment: a real run uses the selected harness's configured subscription or API account. Development and CI use a fake executable and make no model calls.

## Method

1. Inspect the offline plan with `pnpm context:probe --harness claude-code --dry-run`. It starts nothing and writes nothing. A seed generates five distinct SHA-256-based `CANARY-*` tokens; `--seed` repeats them, otherwise a fresh seed is recorded. The prompt never contains the token values.
2. A real run checks the installed harness's `--help` for the required flags and records its version. It creates a detached temporary git worktree at `HEAD`, so uncommitted instruction edits are excluded. It plants tokens in root `AGENTS.md`, `src/motion/AGENTS.md`, a new subagent definition body, a new skill body and that skill's description. Claude aliases under `.claude/` expose the canonical `.agents/` definitions.
3. Start the harness from that worktree's root. The prompt forbids reads, commands, searches, skill invocation and tools, and asks only for already-known tokens. Claude Code uses `-p --allowedTools '' --tools ''`; MCP servers are disabled. Codex uses `exec --sandbox read-only --ephemeral --json`. Codex's read-only sandbox permits reads; the prompt forbids them. This is a recall experiment, not proof of a tool prohibition enforced by that sandbox.
4. Claude Code runs a second fresh session allowing only Agent/Task dispatch, with no token values in the child prompt. The named child has no tools. Only an observed foreground dispatch result from the named child with no canaries in its prompt counts as the child's answer; a parent's assertion that it dispatched a child is inconclusive. Codex subagent loading is recorded as `n/a`.
5. Remove the temporary worktree even when a harness fails. Write a dated JSON record to `out/context/probes/` and append a dated section to this guide. Keep the JSON alongside any published observation. Failed or unconfirmed runs retain their status and never become negative loading results. A failed harness call exits non-zero after saving the record; its JSON error details name the evidence.

Calls have a two-minute timeout and bounded output. Worktree creation disables git hooks. The temporary checkout's Claude settings and MCP config are removed, and the run ignores user Claude settings; this deliberately excludes local hooks, plugins and external MCP instructions from the experiment. Existing user-level instructions or harness-managed configuration may still affect recall. Neither the source instructions nor tracked git history is changed. The guide receives an appended result only after a real run.

`CONTEXT_PROBE_HARNESS_BIN` selects a fake executable for offline tests. It receives the same literal arguments, working directory and planted files as a real harness, including `--help` and `--version` calls. Tests never rely on an installed or authenticated harness.

## Interpretation and limits

A recalled token is evidence that it was available, not a token-cost measurement. Missing tokens can reflect recall failure. Do not label absence as proof a file was not loaded. The nested-file token is a negative control for a session started at root; subdirectory starts, opening a nested source file, explicit skill invocation and compaction need separate experiments. Re-run after changing harness versions. The static byte estimate remains in [context budgets](context-budget.md).

No real harness results have been collected by this work package.

| Date (UTC) | Harness/version | Commit | Parent known layers | Subagent known layers | JSON record |
|---|---|---|---|---|---|
