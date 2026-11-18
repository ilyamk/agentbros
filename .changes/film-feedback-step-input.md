---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
`pnpm feedback` turns the user's verdict on a watched film into a structured step input: each quoted item is routed by code to the step that owns its aspect, and on `--confirm` the step's open-feedback file reopens it and everything downstream through the receipt hashes; resealing with changed outputs marks the items addressed, the same objection twice asks the user
