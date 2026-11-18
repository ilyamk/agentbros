---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Film briefs go by reference: `film:brief` writes the brief and returns its path, a summary and a one-line `metadata.dispatch` that the orchestrator gives the subagent instead of the brief's text (`--print` still returns it), cutting the simulated product-promo run from 140k to 107k orchestrator tokens. Briefs quote the needed section of the creative teams, methods and rubric references instead of sending every agent to the whole file, and the new read-only `film:show` (also an MCP tool) prints a bounded digest of a step's inputs and outputs or one artefact, so agents no longer write scripts to look inside pipeline JSON.
