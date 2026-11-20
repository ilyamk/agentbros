---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
PR intake accepts a rebuilt patch of a large text file when GitHub's counts come from its heuristic diff: GitHub counted uv.lock at +428/-289 where the minimal diff is +424/-285, so every PR touching uv.lock stayed uncertain. The rebuilt diff must have the same net change and no more lines than GitHub's counts
