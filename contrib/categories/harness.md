# Harness and MCP integration

## What is valuable

Reduce supported-harness errors or steps in `.claude/`, `.mcp.json` or `src/mcp/`. Inspect `pnpm commands` and [MCP rules](../../src/mcp/AGENTS.md) before exposing a command.

## Not wanted

Unsupported harness assumptions, automatic paid tools, duplicated instruction sources or broader MCP access than the workflow requires.

## Definition of done

Preserve Claude Code and Codex compatibility, tool exclusions and spend classes. Obtain protected-path approval and owner review; test both allowed and rejected tool requests.

## Evidence required

Behavioural bundle showing the previous failure and resulting behaviour, supported harness versions and offline contract tests.

## Gates

- `pnpm typecheck`
