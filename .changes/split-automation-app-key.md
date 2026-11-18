---
category: security
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Unattended bot workflows mint their token from a separate automation App (falling back to the release App until it is configured) and commit as the minting App, so the release key can live only in the reviewer-gated `release` environment; contributors set up with `pnpm bootstrap --apply`, which installs the Chromium the vision tests need
