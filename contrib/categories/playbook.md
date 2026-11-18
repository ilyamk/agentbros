# Task playbooks

## What is valuable

Cover a real missing request in `playbooks/` or make a draft ready. Use `pnpm playbook --match "<request>"` and inspect `src/lib/playbooks/` before adding another route.

## Not wanted

Duplicate routes, vague intake questions, unchecked QA lists or ready status with empty benchmarks.

## Definition of done

Validate `playbooks/<id>/playbook.json`, make intake and QA checkable, preserve matches for other playbooks and populate benchmarks before declaring ready. Follow [playbook rules](../../playbooks/AGENTS.md).

## Evidence required

Match regression cases, benchmark identifiers and their reference evidence; show the previously uncovered request. Run `pnpm contrib:novelty --base BASE`; for an overlap, add `novelty:` to the change entry naming each existing id and what is new.

## Gates

- `pnpm typecheck`
- `pnpm contrib:novelty`
