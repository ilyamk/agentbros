# Step lease

A step's tools are data in the chain (`ChainStep.commands`, `toolsFor()` in `src/lib/film/routes.ts`, the footage answer's argv). The step lease turns that data into a check, so an agent that drifts (a tool of another step, a paid call before the user's yes, its own approval) is told so by the command itself, not only by its brief's prose. Threat model: agent drift, not an adversary; a person can always turn the guard off.

## The lease

`pnpm next` (film and footage routes), `film:next`, `film:brief` and `footage:next` write `public/projects/<id>/pipeline/session/lease.json` (`StepLeaseSchema`, `src/types/step-lease.ts`; code `src/lib/step-lease/`):

| Field                                 | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `step`, `owner`, `role`, `lanes`      | The current step, its agent, `orchestrator`/`owner`/`critic`/`fixer`, and the fan-out lanes briefed (parallel `film:brief --team`/`--variant` merge)                                                                                                                                                                                                                                                                                                                            |
| `allow`                               | The control set, the step's own commands (`film:done` included), the route's `command` tools for the film type, and every alias the next-step answer names (`film:approve` after a question, `creative:rank`, `music --action record`, `feedback`); a `film:brief` lease adds the aliases its brief names (a critic's `critic:pack`, a fixer's render and sensors), never approvals, `feedback` or `budget`; footage: the aliases of the answer's argv, commands and follow-ups |
| `spending`, `paidAllowed`, `paidWhen` | Aliases in `allow` that may spend (registry `paid` or `may-spend`). Film: spend only on `material` and `narration`, after the user's own (not a proxy's) approval of the current `material.json` or `narrator-direction.json`; critics never. Footage: `paidWhen: budget-ceiling`, spend once `budget --ceiling-usd --answer "<the user's words>"` has set a ceiling                                                                                                            |
| `chainHash`                           | Film: the receipts (`pipeline/chain`, without `fixer-rounds.json`), approvals and skips; footage: goals and playbook binding. A seal, approval or skip makes the lease stale                                                                                                                                                                                                                                                                                                    |
| `issuedAt`, `expiresAt`               | Two hours                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

The control set (`CONTROL_ALIASES`): `next`, `film:next`, `film:status`, `film:brief`, `film:done`, `footage:next`, `step:unlock`, `step:violations`, the studio console's `console`, `console:wait`, `console:control` and the user's per-job `job:cancel` (RFC 0004 D12), and the user's own `film:policy` and `film:revert` (always admitted, even on a stale or expired lease, so an enforced autonomous run can always be narrowed back), plus `film:route`, `feedback`, `memory`, `library:list`, `library:preview`, `playbook`, `commands`, `budget`, `cost:report`, `lint`, `typecheck`, `console:card`. `film:done` removes the lease of the step it sealed or skipped; a closed chain or a stopped footage answer removes it too.

## The guard

`runScript` (`src/lib/cli/index.ts`) loads the guard only when the project named by `--project` has a lease. It maps `process.argv[1]` to its registry entries (several aliases can share a script; spend is the highest) and checks, in order: the always-admitted commands; a child of an admitted command (`AGENTBROS_STEP_ADMITTED`, the lease's hash, set after admission); spend without paid authority and without `--dry-run`; expiry; staleness; the allow list. A failure says the step, its owner, what is allowed, `pnpm next --project <id>` and the escape hatch. Without a lease (manual and development work, template projects) nothing changes.

Modes:

- `warn`: the command runs; `metadata.stepGuard` and stderr carry the warning, and `pipeline/session/violations.jsonl` records it.
- `enforce`: refused with `VALIDATION` before the script's own work, also recorded.
- `off`: no guard.

The mode is resolved per project (`effectiveGuardMode`, `src/lib/step-lease/guard.ts`), first match wins:

| Source                                                                                                                                                                                                                          | Mode      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `AGENTBROS_STEP_GUARD=warn\|enforce\|off` (any other value counts as unset)                                                                                                                                                     | That mode |
| An autonomous policy in force (`pipeline/policy.json`, read by `autonomousPolicy` in `src/lib/film/autonomy.ts`; an `interactive` latest revision or an unreadable file does not count)                                         | `enforce` |
| A benchmark run: a `film:approve --proxy benchmark` event in `pipeline/approvals/*.json`, or a launch with `AGENTBROS_INTERACTION_MODE=autonomous` (the bench harness sets it, so a run enforces before its first proxied gate) | `enforce` |
| Otherwise: interactive work                                                                                                                                                                                                     | `warn`    |

A refusal names the reason (`Step guard (enforce, the project's autonomous policy)`); each `violations.jsonl` line carries `modeSource` (`env`, `policy`, `benchmark`, `default`).

## Report

`pnpm step:violations --project <id> [--since <ISO time>]` (read-only; MCP `step_violations`) sums `violations.jsonl` by step, command, code and step × command × code, with totals (`outOfStep`, `unlocked`, `refused`), `byMode`, the guard's effective mode and source, and `clean`: no out-of-step run without an unlock. Without `--project` it lists every project with a `pipeline/session/` and an overall `clean`. It is always admitted, like `step:unlock`. Before enforcing interactive work too, run it over interactive projects: a command that keeps showing up in a step is a gap in that step's allow list, not agent drift; `--since` counts only the runs after a fix.

## MCP

`prepareCommand` (`src/mcp/bridge.ts`) applies the same check, with the same mode resolution, before `--allow-paid`, in enforce mode: an out-of-step tool is refused; a spend refusal on a dry-run tool is narrowed to `--dry-run=true`, so `--allow-paid` can only narrow what the step allows. In warn mode the child's `runScript` warns and records once.

## Escape hatch

`pnpm step:unlock --project <id> --reason "<why>" [--minutes 30]` (1–240 minutes; CLI only, not an MCP tool) appends to `pipeline/session/unlocks.jsonl`. While it lasts, out-of-step commands run in any mode, an enforcing policy or benchmark included, and are recorded as `unlocked`; spend still needs the user's approval. `film:status` reports `stepGuard.outOfStep`: the out-of-step runs no unlock covered.

## Harness hooks

The `guard` role of `scripts/hooks/agentbros-hook.mjs` ([harnesses](harnesses.md#hooks), RFC 0004 §7.1) applies this guard in Claude Code and Codex at `PreToolUse`, before a shell command starts: for each `pnpm <alias> --project <id>` (or `scripts/<file>` run directly) it resolves the script's aliases and spend from `scripts/hooks/lib/commands.json` (generated from the registry), resolves the mode as `effectiveGuardMode` does (variable, autonomous policy, benchmark), and in enforce mode denies with the same reason as `runScript` (spend, expiry, staleness, allow list; an active unlock admits all but spend). It also refuses every non-control alias of a paused or stopped project (`pipeline/session/control.json`), whatever the guard mode, mirroring the `PAUSED` refusal; every `--project`/`-p` value is judged, as written and lowercased (any id `projectDir` resolves, so `MyFilm` cannot pass a paused `myfilm`); only a script that runs the one job a single `--operation-id` names (`COMPLETION_SCRIPTS`, equal in `src/lib/console/control.ts` and the hook) is left to `runScript`, which admits it only when it completes an already-submitted paid job (soft pause). A console grant (`AGENTBROS_CONSOLE_GRANT`) lifts the pause in `runScript` only, never this guard or the step lease. It never denies what `runScript` would admit: warn mode, `--help`, an unknown alias, a script that never calls `runScript` (`guarded: false` in the table), an unreadable lease or policy, an ambiguous line (command substitution, subshells, unbalanced quotes) and everything after a `cd`, an `export` or a control command in the same line (`step:unlock … && …`) are allowed; operators inside quotes do not split, and `VAR=value` prefixes count. `runScript` stays the authority. Install it with `pnpm harness:setup --hooks --apply` after the user agrees. `scripts/hooks/claude-step-guard.mjs` is a shim over the role for one release; an install replaces its old settings entry.

## Checks

`tests/step-lease.test.ts`: allow lists for every step and type (registered aliases only), the predicate, warn and enforce, nested admission, stale and expired leases, MCP refusal and narrowing, `step:unlock` (also as the exit under an enforcing policy), mode resolution (variable, policy, benchmark proxy, interaction mode, interactive), `step:violations`, footage leases and the hook's stdin fixtures; `tests/console-hooks-guard.test.ts` checks the hook's verdicts against `checkStep` and the pause check.
