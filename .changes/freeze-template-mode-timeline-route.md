---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Template mode is frozen: `pnpm next` sends a project.json without pipeline state (recipe drafts, campaign children, project:new) to a new timeline route (render, editorial QA, delivery), while projects with pipeline-state.json keep the legacy template route, marked legacy; pipeline:init, pipeline:stage and the template-only commands move to the legacy section, and the explainer, motion-design and product-tutorial playbooks drop their template alternatives
