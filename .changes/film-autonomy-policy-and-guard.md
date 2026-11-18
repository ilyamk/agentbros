---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Autonomy as a project policy and a global guard for the film chain: `pnpm film:policy` grants, in the user's own words, an autonomous policy (`pipeline/policy.json`: budget bound to OperationStore, pre-answers, auto-pass steps, limits) under which film:next passes only the gates it names, each decision recorded in `pipeline/decisions.jsonl` and revocable with `pnpm film:revert`; every project, interactive too, now stops at its round, re-entry, active-hour and spend limits (`pipeline/guard.jsonl`) and presents the best kept version, raised only on the user's words

Migration: Interactive projects answer exactly as before until a limit is reached (defaults: 30 rounds, 6 per step, 2 re-entries per step, 4 active hours); raise one with `pnpm film:policy --project ID --raise <limit>=<n> --answer "<the user's words>"`. A policy with a budget refuses OperationStore ceilings above its cap and providers outside its list.
