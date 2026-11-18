# Native and Blender workers

## What is valuable

Provide a local alternative to a paid route in `scripts/workers/`, `scripts/blender/` or `workers/`. Inspect `pnpm speech:local --help` and [optional backends](../../docs/optional-backends.md) for existing routes.

## Not wanted

Unbounded installation, unpinned downloads, machine-specific paths, committed model/media binaries or paid dependencies called free.

## Definition of done

Pin dependencies and fetched artefacts; follow [worker rules](../../scripts/workers/AGENTS.md) and [Blender rules](../../scripts/blender/AGENTS.md) where relevant. Add a fixture and gate platform-specific execution behind an explicit environment flag.

## Evidence required

Pinned dependencies, gated fixture test, supported platform and prerequisite list; report skips and local resource requirements.

## Gates

- `pnpm lint`
