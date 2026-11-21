---
category: fix
bump: patch
breaking: false
pr: 56
authors: [ilyamk]
harness: claude-code
---
The console's GitHub button shows the star count again: it asks for the count once the session is ready instead of on mount, when the server refused the request and it was never retried
