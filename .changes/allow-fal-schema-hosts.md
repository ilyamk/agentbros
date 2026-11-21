---
category: fix
bump: patch
breaking: false
pr: 55
authors: [ilyamk]
harness: claude-code
---
The instruction security scan allows the fal hosts (api.fal.ai, v3.fal.media, v3b.fal.media and fal's storage.googleapis.com examples) already present in the tracked fal operation snapshots, so refreshing a snapshot is no longer blocked
