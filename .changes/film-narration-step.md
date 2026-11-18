---
category: harness
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Film chain narration step: explainer, ui-demo and ai-video films (and hybrids with them) direct the narrator after the script (`narrator-director`, `pipeline/narrator-direction.json`), get the user's yes to the voice and its spend bound before paid takes (the lease allows `generate:voiceover` spending only then, never at sound), and `pnpm narration:check` measures the takes, checks receipts and word timings and writes caption words and `pipeline/narration.json` for the beat sheet, build and sound; skippable when the script has no voice
