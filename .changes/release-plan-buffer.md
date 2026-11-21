---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
The release planner reads git output larger than 1 MiB: `docs/api/surface.json` outgrew execFileSync's default buffer, so `release:plan` failed with ENOBUFS and no release PR was opened
