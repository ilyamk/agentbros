---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: codex
---
Collect dependency licence notices and validate inventory freshness in CI and public exports

Collect every locked package identity, deduplicated licence texts and declared
integration evidence in a committed JSON/Markdown inventory. Validate freshness in
CI and regenerate after the credit ledger; strict checks retain unresolved reviews.

Evaluate permitted SPDX AND/OR combinations without granting exceptions for ELK,
Remotion or GSAP. Preserve public copyright attribution through exact leak-scan
exceptions while continuing to block new addresses and credentials.

Use the tsx CLI for inline memory and rhythm test probes so named imports work
with the configured Node 22 runtime.
