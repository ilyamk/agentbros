# Tests and continuous integration

## What is valuable

Cover an untested contract in `tests/` or reduce suite time without weakening assertions. Follow [test rules](../../tests/AGENTS.md); use `pnpm test:fast` for the existing fast-suite route.

## Not wanted

Tests mirroring implementation, vacuous assertions, hidden skips, credentials or user-memory dependencies, and weaker checks presented as speedups.

## Definition of done

Use temporary repositories for Git behaviour and isolated fixtures for stateful checks. Prove regression tests fail on base, or supply comparable before/after timings. Seek protected-path approval for package/workflow work.

## Evidence required

Failing-on-base proof or timings with environment, workload and unchanged coverage. Propose workflow-path changes first: the current category paths do not include `.github/workflows/`.

## Gates

- `pnpm typecheck`
