# CLI commands

## What is valuable

Automate a manual playbook step in `scripts/` using `src/lib/cli/`. Inspect `pnpm commands --query <word>` and reuse helpers before adding a command.

## Not wanted

Unused commands, duplicate aliases, ad hoc argument parsing, extra stdout progress or paid behaviour disguised as local work.

## Definition of done

Follow [script rules](../../scripts/AGENTS.md); add the package alias and registry spend class, name the command in its playbook and test help plus invalid input against the JSON-line/exit-code contract.

## Evidence required

JSON contract tests, registry entry and playbook use; include an offline success fixture when applicable.

## Gates

- `pnpm typecheck`
- `pnpm lint`
