---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
CLIs no longer hang after printing their result on Node 24: V8 13.6 could deadlock in process.exit when platform shutdown joined a background Sparkplug compile waiting for a garbage collection only the exiting main thread could run. The CLI helper now turns off background compilation (Sparkplug, the optimising compilers, OSR, code-cache deserialisation) on Node below 26 before other modules load; Node 26 keeps the default.
