# Khronos glTF sample assets: source evaluation

Verified research: 2026-11-15. This note consolidates existing [source research and measured acceptance](README.md#measured-acceptance-2026-11-15); no new downloads were made for GROW.

## Purpose for films

Per-model SPDX allowlist: CC0/CC-BY-4.0 plus LegalMark notices. Restricted/NC/EULA models excluded.

## Licence & permissions

[Per-asset licences](https://github.com/KhronosGroup/glTF-Sample-Assets); redistribution: Never commit downloaded files; verify asset-specific redistribution terms.. Attribution: {title} — {url}

Adapter: `khronos-git`. Read the guide for account, automation and per-item restrictions; source approval does not clear individual files. Unknown automation/AI terms remain unresolved, not implicitly permitted. No extension Python is installed by a source listing. Native .blend files load with autoexec disabled and isolated profiles.

## Headless & determinism test

The existing collection proofs used Blender 5.2.3, CPU Cycles, 640×360 / 16 samples. See the guide for machine/load, append evidence and exact acquisition receipts. These asset append trials did not compare frame-alone/range pixels. A shot still needs a fixed seed, pre-render simulation bake and pixel determinism proof.

## Trial results

1 SheenChair GLB, 4,125,648 bytes; acquisition/inspection 2.82 s.

Measurements are from the existing 2026-11-15 acceptance report, not new GROW runtime claims. Sample count is stated above; 0 means untested, not free or fast. The guide records the collection proof commands/receipts; the standalone fixture is `RUN_BLENDER_TESTS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-assets.test.ts` (synthetic assets, no network). A real-source repeat requires consented cached files. Do not download to reproduce without consent.

## Verdict

Proposed: the owner's 2026-11-15 automated-use authorisation covers CC0/bundled sources without accounts/keys. This registry has mixed/non-CC0 licensing or a key requirement, so that authorisation does not approve it. Individual files may be usable after a separate scoped decision; no new acquisition is authorised here.

## Recipes that use it

Optional assets for local film scene scripts; no recipe has an implicit network dependency. Keep CC-BY/OFL notices and per-item usage credits with the render metadata.
