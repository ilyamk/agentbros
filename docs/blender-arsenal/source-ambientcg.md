# ambientCG: source evaluation

Verified research: 2026-11-15. This note consolidates existing [source research and measured acceptance](README.md#measured-acceptance-2026-11-15); no new downloads were made for GROW.

## Purpose for films

v3 filters validated locally. Pins retain /get?file=. PBR maps preferred; original .blend and MaterialX retained.

## Licence & permissions

[CC0-1.0](https://docs.ambientcg.com/license/); redistribution: Never commit downloaded files; verify asset-specific redistribution terms.. Attribution: {title} — {url}

Adapter: `ambientcg-api`. Read the guide for account, automation and per-item restrictions; source approval does not clear individual files. Unknown automation/AI terms remain unresolved, not implicitly permitted. No extension Python is installed by a source listing. Native .blend files load with autoexec disabled and isolated profiles.

## Headless & determinism test

The existing collection proofs used Blender 5.2.3, CPU Cycles, 640×360 / 16 samples. See the guide for machine/load, append evidence and exact acquisition receipts. These asset append trials did not compare frame-alone/range pixels. A shot still needs a fixed seed, pre-render simulation bake and pixel determinism proof.

## Trial results

4 material ZIPs, 21,137,634 bytes total; successful acquisitions 7.42, 6.65, 4.49 and 4.52 s.

Measurements are from the existing 2026-11-15 acceptance report, not new GROW runtime claims. Sample count is stated above; 0 means untested, not free or fast. The guide records the collection proof commands/receipts; the standalone fixture is `RUN_BLENDER_TESTS=1 pnpm exec tsx --import ./tests/helpers/memory-root.ts --test tests/blender-assets.test.ts` (synthetic assets, no network). A real-source repeat requires consented cached files. Do not download to reproduce without consent.

## Verdict

The repo owner approved this CC0/bundled source listing on 2026-11-15 for use within its licence. Existing adapter restrictions remain: manual sources require a user-downloaded archive, and future acquisitions require download consent. Zero-trial sources are approved listings with unverified render quality, not measured production assets.

## Recipes that use it

Optional assets for local film scene scripts; no recipe has an implicit network dependency. Keep CC-BY/OFL notices and per-item usage credits with the render metadata.
