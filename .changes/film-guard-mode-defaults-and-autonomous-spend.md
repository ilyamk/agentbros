---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
The film guard's defaults now follow the mode: interactive projects stop at 60 rounds and 12 active hours, autonomous ones keep 30 and 4 (limits the user set still win); `film:revert` counts as a re-entry. `pnpm film:policy --spend-usd N` (on the user's words) lets an autonomous policy approve paid material: pending generated items with their bound, while every autonomously approved item's bound sums within N and the plan fits the durable budget; each approval is a `spend` decision with `amountUsd` in `pipeline/decisions.jsonl`, revocable with `film:revert`

Migration: Policies written before this change stored every default limit, so an interactive project with such a policy keeps 30 rounds and 4 hours until its limits are revised; raise them with `pnpm film:policy --project ID --raise maxTotalRounds=60 --raise maxActiveHours=12 --answer "<the user's words>"`.
