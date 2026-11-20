---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Intake counts docs/api/surface.json as a generated file, like the library catalogue: a library PR that changes block props must carry the regenerated surface for CI, and intake no longer refuses it as outside the library category
