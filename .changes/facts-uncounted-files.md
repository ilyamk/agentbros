---
category: fix
bump: patch
breaking: false
pr: 49
authors: [ilyamk]
harness: claude-code
---
PR facts rebuild the patch of a modified file that GitHub lists with neither a patch nor counts (past its diff limits, as on the 153-file models refresh), so its added lines reach the leak scan, and a rebuilt patch carries its own line counts, so the models-refresh intake route accepts a bot refresh whose large files GitHub omits
