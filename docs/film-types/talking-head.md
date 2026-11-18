# `talking-head`: Talking head

Generated from `src/lib/film/routes.ts` by `pnpm film:route --write-doc`; do not edit by hand. Every type, and each step's owner, inputs and outputs: [film types](../film-types.md).

A presenter or UGC creator speaking to camera, recorded, with captions and inserts.

Supplied media instead? Use the `footage-editor` agent with `pnpm footage:next --project <id>` (guide docs/footage-editing.md) when the recordings exist and the job is to select and cut them.

| Step | Agent | Tools |
|---|---|---|
| reference | reference-analyst | `pnpm sfx:map` |
| material | asset-planner | skill `recording-guide`; skill `directing-and-performance`; `pnpm asset:import` |
| look | design-director | `src/templates/talkinghead`; skill `captions-and-localization` |
| beat-sheet | motion-director | skill `recording-recut` |
| animatic | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check` |
| build | motion-engineer | `pnpm viz:list`; `pnpm viz:prepare`; `pnpm viz:preview`; `pnpm viz:render`; `pnpm viz:mount`; `pnpm viz:check`; `src/templates/talkinghead`; skill `captions-and-localization`; `pnpm sfx:cues` |
| sound | sound-director | `pnpm sfx:map`; `pnpm sfx:find-segment`; `pnpm audio:review`; `pnpm speech:replace`; `pnpm audio:transform`; skill `sound-design-and-mix` |

Reference: A presenter film: match the cut rate inside speech and the caption style; never the person.

QA looks hardest at: Speech intelligible, music ducked under it; Captions timed to the words and readable; No cut breaks a sentence's meaning.
