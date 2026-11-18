---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
The test suite and CI pass on Linux (Ubuntu 26.04, FFmpeg 8). Fixed for Linux users: studio:open's per-project lock no longer removes another opener's lock when the file system reuses an inode; fal:quote and fal batches hand the request to generate:model on descriptor 0 instead of opening /dev/stdin, which Linux refuses for a socket; recording checks ignore AAC end padding that FFmpeg 8 decodes past the declared duration and report the WebM remux hint before an Opus start offset; motion:check counts Chromium's console echo of an uncaught exception once. CI installs the pinned Python before python:check. Rhythm tests that need macOS's sandbox-exec skip elsewhere.
