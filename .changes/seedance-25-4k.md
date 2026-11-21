---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Seedance 2.5 accepts fal's schemas of 2026-11-20: 4K output is priced from the reviewed page rate on the global text-to-video and image-to-video endpoints ($0.0094 per 1,000 tokens) and 1080p now has its published rate there; any resolution without a reviewed rate stays unknown instead of falling back to the 480p/720p base rate. Drafts can be completed within 14 days. MOV output, an automatic reference task and drafts on the US endpoints are refused until the pipeline supports them.
