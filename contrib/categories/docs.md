# Guides and documentation

## What is valuable

Correct or shorten a guide in `docs/`, root Markdown or `design-reference/*.md` using current code as evidence. Follow [docs rules](../../docs/AGENTS.md) and use `pnpm commands --query <word>` to confirm aliases.

## Not wanted

Vacuous prose, marketing, stale flags, unverifiable claims or changes to historical verification records to imply new acceptance.

## Definition of done

Keep British English, resolve local links and check command names against `package.json`. Put public proposals in `docs/rfcs/`; keep local plans/evidence out of the contribution. Obtain approval for any protected instruction or licence file.

## Evidence required

Link and command checks plus the source for corrected behaviour; run the documentation contract tests for changed guides.

## Gates

- `pnpm typecheck`
