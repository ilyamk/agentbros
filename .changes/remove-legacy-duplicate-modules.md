---
category: harness
bump: major
breaking: true
pr: 0
authors: [ilyamk]
harness: claude-code
---
Remove legacy duplicate modules and dead code: scripts/generate-meme.ts (pnpm generate:meme already runs generate-image.ts --model gpt-image-2), the unused src/lib/apis barrel and Pollinations client, dead fal helpers and the unused @fal-ai/client dependency, generateSoundEffect and transcribeAndSave; src/lib/elevenlabs.ts moves to src/lib/elevenlabs/tts.ts.

Migration: Replace pnpm exec tsx scripts/generate-meme.ts with pnpm generate:meme --prompt TEXT --output public/projects/ID/assets/memes/NAME.png --project ID --quality high. Import voiceover and forced-alignment helpers from src/lib/elevenlabs/tts.ts instead of src/lib/elevenlabs.ts.
