# `replica`: Replica

Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).

An exact copy of one given film, shot for shot and frame for frame, with only what the user names swapped (only when they ask to copy a film, not for a film in its style).

Steps only this type runs: rights, replica-reference, replica-spec, replica-compare. It never joins another type as a hybrid.

| Step | Agent | Tools |
|---|---|---|
| replica-reference | reference-analyst | skill `reference-analysis`; `pnpm ref:validate` |
| replica-spec | reference-analyst | skill `reference-replica`; `pnpm library:list`; `pnpm ref:replica-check` |
| music | sound-director | skill `reference-replica` |
| material | asset-planner | `pnpm capture:app`; `pnpm resources`; skill `resource-discovery`; `pnpm asset:import` |
| build | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check`; `pnpm library:list`; skill `reference-replica`; `docs/real-ui.md`; `pnpm motion:strip`; `pnpm sfx:cues` |
| sound | sound-director | `pnpm sfx:map`; `pnpm sfx:find-segment`; `pnpm audio:review`; skill `sound-design-and-mix`; `pnpm sfx:cues` |
| replica-compare | script | `pnpm motion:strip` |

Reference: The film itself: every shot, cut, move, ease, colour and type size is measured from it and rebuilt within the replica tolerances; another owner's brand, characters, copy, voice and music are replaced.

QA looks hardest at: No measure in summary.withinTolerance has a failed shot; notMeasured checked by strip; Nothing of another owner's brand, characters, copy, voice or music remains; Product screens are the user's real product.
