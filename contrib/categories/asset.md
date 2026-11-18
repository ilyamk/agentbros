# Shared asset manifests

## What is valuable

Add licence-clean shared asset manifests under `public/shared/` needed by a playbook. Inspect [asset rules](../../docs/assets.md) and `pnpm assets:sync --help` before selecting paths and hashes. Blender arsenal entries (`blender-arsenal/*.json`: extensions, library sources and pinned items, collections) follow [arsenal gates](../../docs/blender-arsenal/CONTRIBUTING.md) and must pass `pnpm blender:arsenal audit`.

## Not wanted

Media binaries, unverifiable licences, non-commercial restrictions incompatible with project licensing or assets with no consuming playbook.

## Definition of done

Include original source, licence evidence, hashes and retrieval metadata; verify manifest validation and reuse. Keep fetched originals and output out of git.

## Evidence required

Licence evidence and manifest hashes; identify the consuming playbook and record offline checks without claiming a network fetch was tested.

## Gates

- `pnpm typecheck`
