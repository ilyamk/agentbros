---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
deps: undici 8.12.4 (MIT), the version Node bundles, for an Agent with long header and body timeouts on the ElevenLabs music request; already in the lockfile through jsdom
---
ElevenLabs music generation works end to end: every composition-plan section is sent with lines (the API refused plans without them), the request waits up to its own 10-minute limit instead of being cut by fetch's 300 s header wait, and the film chain's music step may run generate:music once the project budget ceiling was raised in the user's words
