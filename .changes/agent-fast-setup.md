---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Fast first-run setup for agents: SETUP.md, `./setup.sh` / `./setup.ps1` plan prerequisites by consent scope (repo, user, system) and install the approved ones, `pnpm bootstrap` applies repository steps with an optional one-second test render and writes out/setup/REPORT.md (machine limits, what works with no keys, keys by goal), and `pnpm keys` reports which service keys are set, never their values; one key registry now feeds doctor, keys and bootstrap, kept equal to .env.example by a test
