# `footage`: Footage

Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).

Live footage or b-roll, stock or supplied, cut to music with type over picture.

Supplied media instead? Use the `footage-editor` agent with `pnpm footage:next --project <id>` (guide docs/footage-editing.md) when the film is cut from the user's own footage or recordings, keeping their speech.

| Step | Agent | Tools |
|---|---|---|
| reference | reference-analyst | `pnpm sfx:map` |
| material | asset-planner | `pnpm resources`; skill `resource-discovery`; `pnpm asset:import` |
| look | design-director | skill `cinematography`; block `type-hero-word`; `library:list --category typography` |
| beat-sheet | motion-director | skill `editorial-storytelling` |
| animatic | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check` |
| build | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check`; skill `editorial-storytelling`; `library:list --category typography`; `pnpm sfx:cues` |
| sound | sound-director | `pnpm sfx:map`; `pnpm sfx:find-segment`; `pnpm audio:review`; `pnpm sfx:library`; `pnpm sfx:cues` |

Reference: A cut-to-music footage film: measure cut rate and sync; match the grade's contrast and the caption scale.

QA looks hardest at: Every clip licensed for this use, with provenance; No clip looks like generic stock next to the idea; Captions small and out of the subject's way.
