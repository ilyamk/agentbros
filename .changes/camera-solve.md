---
category: fix
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Add `pnpm camera:solve`: solve a moving plate camera (KLT tracks outside a subject matte, epipolar filter, Blender libmv with outlier rounds, metric scale from the subject's width) into an OpenCV camera.json, and `vorkCamera` to render Vork inserts through it with a keyed focus pull
