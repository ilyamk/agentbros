---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Studio console: a banner at the top of every page asks the user to connect the agent hooks while Claude Code's or Codex's are missing or out of date; its dialog explains why the hooks matter for the console, shows each harness's status, checks again and installs or updates them (`harness:setup --hooks --apply`) on the user's click, and the banner can be hidden for good in this browser; Settings and the banner share one hooks status.
