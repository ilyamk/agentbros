---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Bespoke film code is now linted: the animatic and build steps fail through a new `project-lint-clean` done check when `src/projects/<id>/` breaks a render rule (unseeded randomness, wall clock, CSS or library animation, native media tags), each finding a `file:line CODE: message. Fix: …` line, and `pnpm lint --project <id>` fails on the same findings. Two new render rules: `STATIC_PATH` (a bare `projects/…`, `shared/…` or `public/…` media `src` without `staticFile()`) and `CSS_BG_IMAGE` (a CSS background with `url()`). `repo:hygiene --check` now fails on media binaries outside the documented exceptions, and a test keeps every leaf agent's tools free of Task, Agent and wildcards; the root rules and motion-engineer's law are shorter now that code enforces them.
