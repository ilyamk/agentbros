# Benchmark tasks and calibration

## What is valuable

Freeze a small, checkable task for an uncovered playbook, or add judge calibration cases in `src/lib/evaluation/` and regression fixtures under `tests/`. Inspect `pnpm creative:bench --help` and [the benchmark guide](../../docs/creative-benchmark.md) before choosing an existing no-spend route.

## Not wanted

Uncheckable tasks, answer leakage, mutable reference outputs, paid runs by a contributor agent or claims that an LLM judged sound.

## Definition of done

Pin inputs, expected checks and version identity; demonstrate a reference run and preserve the original task when introducing a new version.

## Evidence required

A frozen task manifest and a reference run bundle; identify the playbook, harness, model, commit, rights and no-spend constraints. Obtain sponsored evidence from a maintainer if needed.

## Gates

- `pnpm typecheck`
