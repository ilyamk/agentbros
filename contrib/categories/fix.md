# Bug fixes

## What is valuable

Fix a reproducible bug in the smallest affected area. Start with its `AGENTS.md`, then use `pnpm commands --query <word>` to locate the existing workflow.

## Not wanted

Unrelated refactoring, speculative hardening, formatting churn, a fix with no reproduction or relabelling other work to bypass tier restrictions.

## Definition of done

Add a regression test that fails on the base revision and passes with the fix; preserve compatibility or obtain an approved L proposal. Include only necessary code, tests and supporting instructions. A `fix` PR may update the `AGENTS.md` lines describing its change, including at tier 0: the tier restriction applies to PRs categorised as `instructions`. These files are protected, so the PR waits for maintainer review and `design-approved`.

## Evidence required

Minimal reproduction and `pnpm contrib:fails-on-base --base BASE` proof that a changed test fails at base and all changed tests pass at head; name any skipped platform or render verification. Commit the tests and changed support files before running proof.

## Gates

- `pnpm typecheck`
- `pnpm lint`
- `pnpm contrib:fails-on-base`
