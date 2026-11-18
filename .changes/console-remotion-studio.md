---
category: command
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---

The studio console's "Open in Remotion Studio" now starts Studio for the project in its current state on the user's click and opens it in a new tab: a bespoke film's build.json composition, or a project's format composition with exactly the render's props, updated live when opened again. New `studio:open` (`--status`, `--stop`) and console routes `GET`/`POST /api/projects/<id>/studio` and `…/studio/stop`. Studio runs under a loopback preload (127.0.0.1 only, non-loopback Host and cross-site writes refused), one per target, and stops with the console.
