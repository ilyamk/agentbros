# `collage`: Collage

Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).

Mixed media: cut-out photos, paper, texture and type assembled on a flat field.

| Step | Agent | Tools |
|---|---|---|
| reference | reference-analyst | `pnpm sfx:map` |
| material | asset-planner | `pnpm resources`; skill `resource-discovery`; `pnpm rmbg`; `pnpm generate:image`; skill `model-and-asset-production`; `pnpm asset:import` |
| look | design-director | block `paper-collage-assemble`; `library:list --category effects` |
| beat-sheet | motion-director | block `paper-collage-assemble`; `library:list --category transitions` |
| animatic | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check` |
| build | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check`; block `paper-collage-assemble`; `library:list --category effects`; `pnpm sfx:cues` |
| sound | sound-director | `pnpm sfx:map`; `pnpm sfx:find-segment`; `pnpm audio:review`; `pnpm sfx:library`; `pnpm sfx:cues` |

Reference: A collage film: match the density of a frame and how pieces arrive; take no cut-outs.

QA looks hardest at: Every cut-out licensed for modification; Clean cut edges at full size; A frame reads as one composition, not a pile.
