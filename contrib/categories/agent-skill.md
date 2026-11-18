# Agent and skill definitions

## What is valuable

Fix an observed Claude Code or Codex failure in canonical `.agents/` definitions. Use `pnpm context:budget` to measure context cost and keep `.claude/` links pointing to the canonical files.

## Not wanted

Speculative instruction growth, copies of linked definitions, unsupported harnesses or a new contribution skill loaded by every video session.

## Definition of done

Keep leaf agents at depth one, preserve front matter and test the failure behaviour in supported harnesses. Obtain protected-path approval and owner review; follow the relevant playbook.

## Evidence required

Behavioural bundle on the failing task and a before/after context delta; request existing or maintainer-run evidence when a run needs paid access.

## Gates

- `pnpm lint`
