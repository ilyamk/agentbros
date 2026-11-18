# Reusable templates

## What is valuable

Add a reusable template-mode piece in `src/templates/` or `src/lib/templates/`, guided by [template recipes](../../docs/template-recipes.md). Inspect `pnpm video:recipe --help` and the registry before adding one.

## Not wanted

Project-specific templates, generic mock interfaces replacing real product UI, autonomous CSS animation or duplicate text/background components.

## Definition of done

Follow [template rules](../../src/templates/AGENTS.md); register the reusable piece, validate props, use frame-driven animation and render the supported formats with local fixtures.

## Evidence required

Render test and representative frames at playback size, with fixture identity and format; show the recipe that uses the piece.

## Gates

- `pnpm typecheck`
- `pnpm lint`
