# `explainer`: Explainer

Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).

Teaching an idea with diagrams, data and worked examples, usually with a voice.

Supplied media instead? Use `pnpm video:workflow --scenario education` (guide docs/workflows/education.md) when a source-backed lesson with chapters and timed captions.

| Step | Agent | Tools |
|---|---|---|
| reference | reference-analyst | `pnpm sfx:map` |
| narration | narrator-director | `pnpm elevenlabs:capabilities`; `pnpm voices`; skill `directing-and-performance`; skill `script-and-education` |
| look | design-director | `pnpm library:list`; `library:list --category data`; skill `script-and-education` |
| beat-sheet | motion-director | `library:list --category data`; block `before-after-split` |
| animatic | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check` |
| build | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check`; `library:list --category data`; `library:list --category kinetic`; `pnpm sfx:cues` |
| sound | sound-director | `pnpm sfx:map`; `pnpm sfx:find-segment`; `pnpm audio:review`; `pnpm generate:dialogue`; skill `sound-design-and-mix` |

Reference: An explainer: match how long each idea is held and how a diagram builds; take no diagram.

QA looks hardest at: Every number and claim sourced; One idea on screen at a time, held long enough to read; Diagrams change state in place rather than cut.
