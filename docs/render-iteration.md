# Render iteration

## Rebuild a local picture edit

On the ordinary project route, a repeat `pnpm render` can rebuild a full MP4 after a built-in scene's headline or subtext changes. It expands the affected scene and transition spans to GOP boundaries, encodes those frames and reuses the old audio. The old master needs a matching renderer receipt and dependency proof. Every decoded frame, its timestamp and the original audio stream are checked against the old master and the new excerpt before publication. The new complete receipt records the replaced range and base checksum. Incompatible changes or failed verification fall back to a full render. Pass `--full` to request a fresh full render explicitly. Previous masters and receipts are archived under `out/<project>/render-versions/` by checksum. Use the normal QA and approval flow on the new master.

## Readability warnings

Readability warnings appear in `metadata.readability` and on stderr before full rendering. Chromium captures the same sampled frame with and without DOM lettering to estimate contrast at the glyphs. It judges the most opaque sampled phase and checks the lowest sampled contrast in that phase. It also checks apparent type size at 390 px feed width and flags a hold only when even the longest interval consistent with the samples is too brief. Warnings include the text, frame range, measured value and target. They are advisory. Canvas text, unmeasurable glyphs and spans cut off by an inspection range have limited coverage. `contrastSamples` and `backdropFailures` indicate sampling coverage.
