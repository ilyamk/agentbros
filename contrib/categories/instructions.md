# Agent instructions

## What is valuable

Remove, merge or relocate repeated rules in `AGENTS.md` files after an observed failure. Use `pnpm context:budget`, `pnpm instructions:lint` and `pnpm instructions:security` to inspect the change.

## Not wanted

Repeated rules, speculative prose, contributor rules loaded into video sessions, nested CLAUDE instruction copies or growth without required approval.

## Definition of done

Keep area-specific rules in their area, preserve working links/commands and stay within file budgets. Obtain protected-path approval, owner review and required context-growth approval; supply behavioural evidence.

## Evidence required

Context delta, lint/security results and a behavioural bundle for the affected task; request the maintainer audit and record its status without invoking a paid audit yourself.

## Gates

- `pnpm lint`
