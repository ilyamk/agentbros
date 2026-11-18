---
category: fix
bump: patch
breaking: false
pr: 0
authors: [ilyamk]
harness: codex
---
Review all 205 dependency licence findings with integrity-pinned source-distribution decisions

Verify all 205 exact npm archives against locked SRI and retain manifests,
licence notices, upstream evidence, conditions and source-only decisions in a
protected ledger. Preserve original missing/UNLICENSED declarations and require
fresh review for changed artefacts or versions.

CI enforces the explicit repository-source scope. Binary/native/WASM and browser
bundle redistribution remains excluded, including Remotion FFmpeg and Mediabunny
codec obligations; operator entitlements and GSAP permitted-use terms still apply.
