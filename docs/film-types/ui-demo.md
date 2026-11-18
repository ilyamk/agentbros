# `ui-demo`: UI demo

Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).

The real product's screens in use: a web or mobile app recorded and staged at reading scale.

| Step | Agent | Tools |
|---|---|---|
| reference | reference-analyst | `pnpm sfx:map` |
| narration | narrator-director | `pnpm elevenlabs:capabilities`; `pnpm voices`; skill `directing-and-performance` |
| material | asset-planner | `pnpm capture:app`; `pnpm capture:html`; `pnpm asset:import` |
| look | design-director | `pnpm library:list`; `library:list --category ui`; block `ui-camera-read` |
| beat-sheet | motion-director | `library:list --category ui`; block `ui-camera-read` |
| animatic | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check` |
| build | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check`; `library:list --category ui`; block `ui-camera-read`; `pnpm sfx:cues` |
| sound | sound-director | `pnpm sfx:map`; `pnpm sfx:find-segment`; `pnpm audio:review`; `pnpm sfx:synth`; `pnpm sfx:cues` |

Reference: A product-demo film: match how long a screen is held and how close the camera reads it; take no layouts.

QA looks hardest at: UI text readable at phone size (26 px after the push); Real captures, no drawn placeholder in the final; The click and the state change land on the beat.
