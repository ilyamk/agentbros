# `motion-graphics`: Motion graphics

Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).

An animated product or promo film built from type, shapes, UI and 3D, with no outside footage.

| Step | Agent | Tools |
|---|---|---|
| reference | reference-analyst | `pnpm sfx:map` |
| look | design-director | `pnpm library:list`; `library:list --category kinetic`; block `type-hero-word`; block `blender-plate`; skill `engine-selection` |
| beat-sheet | motion-director | `pnpm library:list`; `library:list --category kinetic`; `library:list --category transitions` |
| animatic | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check` |
| build | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check`; `pnpm library:list`; `library:list --category kinetic`; block `blender-plate`; skill `blender-3d`; skill `vork-3d-vfx`; `pnpm vork:recipe`; `pnpm sfx:cues` |
| sound | sound-director | `pnpm sfx:map`; `pnpm sfx:find-segment`; `pnpm audio:review`; `pnpm sfx:synth`; `pnpm sfx:cues` |

Reference: A motion-design film: measure its pace and sync; take its type scale, grounds and carries, never its frames.

QA looks hardest at: Type scale bimodal, never mid-size; Every cut caused or on a downbeat; No sparing block without a reason in the plan.
