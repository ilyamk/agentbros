---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Every film render is kept as `out/<id>/versions/<sha256 prefix>.mp4` with an index of its steps and measure verdict, so a later render no longer loses an earlier one; `listFilmVersions` and `bestFilmVersion` rank them by measure pass, then critic total
