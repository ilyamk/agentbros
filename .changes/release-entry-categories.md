---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Release notes no longer fail on two pending change entries filed under an unknown feature category; a test now renders every pending entry, so an unknown category fails CI before it reaches main
