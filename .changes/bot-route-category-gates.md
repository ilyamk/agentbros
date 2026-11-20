---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
category-gates no longer fails every Dependabot, release and models-refresh PR: without a change entry the catch-all fix and security categories (paths "**") matched every file, so a dependency bump needed a failing-on-base test. Catch-all categories now apply only when a change entry declares them.
