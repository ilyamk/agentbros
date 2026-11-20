---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
CI's checks job no longer repeats test:fast, whose files the full-suite shards already run, and the workflow contracts run as their own parallel job, so the checks job no longer sets the length of a CI run
