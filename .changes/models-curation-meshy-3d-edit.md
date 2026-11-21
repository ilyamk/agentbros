---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
meshy/v7.1/text-to-3d is verified again on fal's 2026-11-20 schema, and its guard refuses texture_image_url with texture_prompt, which that schema now forbids. Slot 3d.edit uses meshy/n1/retexture as its hero and meshy/v7/retexture as a budget candidate, since fal removed fal-ai/hunyuan-3d/v3.1/smart-topology
