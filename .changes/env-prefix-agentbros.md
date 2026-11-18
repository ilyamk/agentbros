---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
All repository environment variables now use the `AGENTBROS_` prefix; the old `AVC_` names (for example `AVC_MEMORY_ROOT`, `AVC_NO_SPEND`, `AVC_FAL_PRICES`) are renamed with the same suffix. No release has shipped the old names.
