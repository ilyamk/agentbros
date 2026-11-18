---
category: test-ci
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Release gates are green on a fresh clone: CLIs accept later Node 26.13+/24.22+ patches with a warning, AGENTBROS_NO_DOTENV=1 keeps .env keys out of tests, spawned-process deadlines share a 30 s helper, the rhythm metadata helper tolerates a builtin _ctypes, the licence inventory and command catalogue are regenerated, and install docs add Chromium setup and HIGGSFIELD_API_KEY.
