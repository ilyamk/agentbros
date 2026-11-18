# Event frames, browser measurements and repair evidence

```bash
pnpm qa:evidence -- --project my-video --format vertical --dry-run
pnpm qa:evidence -- --project my-video --format vertical --input out/my-video/vertical.mp4
pnpm qa:evidence -- --project my-video --format vertical --browser --timeline
pnpm qa:evidence -- --project my-video --format vertical --browser --font-context public/projects/my-video/resources/fonts.json
```

The planner uses the same legacy/IR compilers as production rendering. It selects first/last frames, scene/clip boundaries, transition start/middle/end, CTA hold and early/final reveal holds. The final hold samples before the nine-frame exit fade; it is a candidate for maximum visible text, not a claim that an arbitrary staggered/custom animation finished. Exact IR boundaries are quantized with `renderBoundary`. Event count is capped (default 40; `--max 2..300`); reports list omitted events. First/last are retained. Missing/omitted/custom-layout evidence always requires review.

Each run creates a new `pipeline/qa-evidence/{format}-{uuid}/` directory. Real FFmpeg extracts the selected frame numbers, writes PNGs and a static contact sheet, checks actual decoded frame count/rate and measures sampled luminance. A near-black last expected frame becomes `UNEXPECTED_BLACK_TAIL`; other dark samples become `NEAR_BLACK_EVENT`. Mean gray luminance below 3 is a conservative candidate, not a claim that a scene is aesthetically wrong. Specify intentional frame indices with `--intentional-dark-frames 107,108` when reviewed darkness is deliberate. Frame count mismatch remains a finding; visual/audio continuity and intentional ending fades still need manual review. Variable-frame-rate or mismatched output rates are rejected for precise extraction.

`--browser` bundles the actual production Root and renders those frames again through Remotion. Opt-in `qaEvidence` mounts an invisible diagnostic probe. It waits `document.fonts.ready`, measures native text Range boxes, computed font availability and clipping ancestors, and records format safe-zone violations. A MutationObserver repeats measurement after deferred captions/media DOM changes; there is no independent animation clock or timer. Invisible/display:none content is excluded. Actual measured text may still be occluded by another layer, and Range unions are conservative; these findings require visual confirmation. There is no blanket quality score or automatic approval. No visible text yields `needs-review-no-visible-text`, rather than a pass. Production typography/headline/phone/legacy custom layout art direction is not auto-repaired.

`--offline-fonts` is solely for tests/smoke checks. It substitutes local fonts and explicitly records `offline-substitute-not-production-font-approval`; it cannot approve production fonts or glyph coverage. Actual production fonts may require downloading their regular font assets, but this command makes no generation/provider API request. `--captions off` produces clean evidence without loading/mounting talking-head captions; speech source and timeline stay the same. The tests compare real clean/captioned frames and measured caption presence.

For a manual repair, rerender and collect a second evidence report, then write a request JSON:

```json
{
  "before": "/absolute/path/before/evidence.json",
  "after": "/absolute/path/after/evidence.json",
  "description": "Shortened headline and rerendered all affected frames",
  "actor": "Declared reviewer",
  "expectedAttempt": 0,
  "maxAttempts": 2
}
```

Run `pnpm qa:evidence -- --project my-video --repair-file request.json`. The locked atomic ledger freezes before/after report hashes, source hashes and actual frame hashes, validates artifact confinement/integrity and records declared action/author. Attempt revision conflicts fail; a configured cap cannot be raised on retry (maximum three). The ledger is evidence of a declared manual repair, not an authenticated approval, automatic fix, provider refund or proof that all quality problems were solved. Every entry remains `requires-manual-review`.

```bash
pnpm exec tsx --test tests/qa-evidence.test.ts
RUN_QA_EVIDENCE_TESTS=1 pnpm exec tsx --test tests/qa-evidence-browser.test.ts
pnpm exec tsc --noEmit
```

Coverage: actual FFmpeg frames/black tail/duration; exact scene/IR event timing; repair attempts/artifact tampering; actual production Root overlong Russian text; negative safe zones/clipped glyphs/failed native FontFace; captioned vs clean talking-head pixels and measured word presence. No live APIs or spending.

Use `--audio-master` and `--font-context` with the same sidecars passed to `render`. Cached font mode uses the validated local loader and records `cached-production-fonts`; it is mutually exclusive with `--offline-fonts`. CLI evidence pins the complete render source identity before/after capture. A changed source refuses the report; delivery only counts current source-bound production font measurements. Matching measured failures always block delivery; missing DOM/event/font evidence remains explicit manual-review coverage, never an automatic pass.

QA now additionally emits source-bound paginated review pages and `reviewPack`. Its measured production DOM diagnostics are labelled separately from extracted MP4 pixels. See [agent vision](agent-vision.md#source-bound-review-packs).
