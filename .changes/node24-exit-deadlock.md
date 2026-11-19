---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
CLIs no longer hang after printing their result: on Node 24 and 26 (V8 13.6 and 14.6) process.exit could deadlock when platform shutdown joined a background Sparkplug or Maglev compile waiting for a garbage collection only the exiting main thread could run. The CLI helper turns off concurrent Sparkplug and Maglev before other modules load and runs one collection right before exit, which releases a compile started earlier; TurboFan stays.
