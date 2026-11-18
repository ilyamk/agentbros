# Reproducible product advertising project

```sh
pnpm exec tsx examples/workflows/product-ad/prepare-local-demo.ts --directory /tmp/product-ad-local-demo
pnpm exec tsx examples/workflows/product-ad/run-local.ts --request /tmp/product-ad-local-demo/product-ad-request.json --action plan
pnpm exec tsx examples/workflows/product-ad/run-local.ts --request /tmp/product-ad-local-demo/product-ad-request.json --action create
pnpm render --project synthetic-product-ad --timeline --captions on --format vertical
pnpm render --project synthetic-product-ad --timeline --captions off --format vertical
```

The first command generates synthetic originals **locally**, plus the exact strict request JSON with actual checksums, concrete source selections and timed words. It creates no remote generation calls and labels tone audio/technical captions, fictional product, non-commercial test rights and synthetic evidence. It is not finished commercial media. Existing projects are never replaced. Use a fresh projectId/directory for a rerun.

For real production, retain the generated JSON shape but replace every media entry with your permitted original file, actual SHA-256, correct provenance/licence and critical-region coordinates; use real recorded speech plus corresponding timed words. Replace the synthetic claim with exact source text evidence, matching file checksum, permitted excerpt and identified reviewer. Assign each beat the actual interaction shot or proof media. Supply a real CTA URL. Run `plan` again. Never keep a test declaration as production rights, source verification or speech alignment.

Treatment: an audience-facing hook states one useful job; the problem shows the starting friction; an uninterrupted selected interaction shows action → visible outcome; proof cites the exact visible result without invented conversion or speed metrics; the final frame repeats one action and readable destination. Music remains dialogue-first at 0.3; imported speech plays once. Each beat owns a contiguous frame interval and its own supplied caption phrase. Product-critical content must survive center-cover crop and subtle zoom in all three formats; review every crop, text size, sound and CTA before delivery.

Generated project artifacts contain pending human review, immutable originals and proof documents, checksum provenance, canonical scenes, exact TimelineIR and SRT/VTT. Rendering uses the existing production renderer with `--timeline`; a render is not a release approval. Use the strict delivery workflow described in `docs/workflows/product-ad.md`.
