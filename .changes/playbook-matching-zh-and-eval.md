---
category: playbook
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Playbook matching reads Chinese: every playbook has `zh` triggers, matched as character runs, and the reference, replica, remix and project modifiers understand Chinese. One extra word may stand inside a phrase; `triggers.generic` marks broad triggers that score half and never bind on their own; a trigger shared with a variant names the variant. `pnpm playbook --eval` scores matching on a labelled corpus of 221 English, Russian and Chinese requests, and the tests hold its floors (no wrong clear match)
