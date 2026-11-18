---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Any Node 26.x or 24.x now runs the CLIs, MCP and contribution tools (with a warning off the CI-tested 26.13.1/24.22.3 pins); `engines` is `^26.0.0 || ^24.0.0`. The pre-push hook switches to `.nvmrc` through nvm when the shell default is another major, and prints the leak check's reason when it blocks a push.
