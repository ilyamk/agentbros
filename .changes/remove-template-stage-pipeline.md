---
category: harness
bump: major
breaking: true
pr: 0
authors: [ilyamk]
harness: claude-code
---
Remove the frozen 16-stage template-mode pipeline: `pipeline:init`, `pipeline:stage` and their MCP tools (`pipeline_init`, `pipeline_stage`), the stage state machine (`src/lib/pipeline/state.ts`), the `template` route of `pnpm next`, and the stage-only agents `character-bible`, `storyboarder`, `rhythm-editor`, `audio-mixer` and `composer` with the template-mode references. Every project.json project now goes to the timeline route (render, editorial QA, delivery), and a leftover `pipeline/pipeline-state.json` is ignored and noted in `detectedBy`; delivery and campaign final outputs always need `manualApproval`, and `qa:editorial` no longer reads stage statuses. `pipeline:check` stays as a stateless findings probe (artefact schemas, file references, charts, creative, film and music-rights findings) with no stage status or capture. `film:init` no longer writes `pipeline-state.json`; an older film's `approve` entries in it still count.

Migration: an old template project resumes with `pnpm next --project <id>` and is delivered with `approvalMode: "manual"` and the user's `manualApproval`; its stage approvals in `pipeline-state.json` no longer count. Replace `pipeline:init` with `pnpm project:new` or `pnpm video:recipe --action materialize`, and drop `pipeline:stage` calls. A campaign `child-gates` package no longer offers template stage approvals.
