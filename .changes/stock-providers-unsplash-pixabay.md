---
category: feature
bump: minor
breaking: false
pr: 0
authors: [ilyamk]
harness: claude-code
---
Unsplash and Pixabay join Pexels as stock adapters behind one interface (`src/lib/resources/stock/`): `pnpm resources --action search --provider auto` searches every source with a key and ranks the results for the frame (`--format`, `--zoom`), aspect, words and colour; acquisition downloads the size the frame needs, refuses a too-small file, reports Unsplash downloads and writes the usual receipt. Pixabay searches are cached 24 hours, rate-limit headers are remembered between runs, and creators reach release credits only on request (`--credit`, `--action credits`). The legacy `fetch:stock` and `fetch:pixabay` fetchers, which kept no licence record, are removed; asset-plan stock items now acquire through the same service. Set `UNSPLASH_ACCESS_KEY` (Access Key only) in `.env`.
