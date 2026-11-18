# Product advertising from original local media

`runProductAdWorkflow(raw, {action: 'plan'|'create', rootDir?, scopeRoot?})` builds a concrete five-beat ad: hook → problem → demo → proof → CTA. The request schema is `src/types/workflow-product-ad.ts`. There are no model/provider calls, placeholder assets, generated numbers or inferred approvals. All three requested formats are vertical 1080×1920, square 1080×1080 and landscape 1920×1080 at 30 fps; total length is at most 60 seconds.

The exact reproducible request generator and executable runner are in [the local example](../../examples/workflows/product-ad/README.md). Run it through the shared workflow CLI: `pnpm video:workflow --scenario product-ad --action plan|create --request FILE`; it is the `product-promo` playbook's alternative for supplied originals. `plan` reads, inspects and hashes supplied files without writes. `create` rejects existing projects, uses exclusive ownership, builds and fsyncs a private staging project, verifies source hashes again and atomically commits the complete project. Originals remain untouched. Interrupted pre-commit materialization cannot expose a partial final project.

## Required actual inputs

Each media entry declares `id`, local `path`, `sha256`, inspected `kind`, `provenance`, `rights`; visual media also require normalized `criticalRegion` `{x,y,width,height}`. At least two distinct original visuals are used. A demo beat requires original **video**, a selected source interval and an explicit `interaction` declaration `{action,visibleOutcome,startFrame,endFrame}` entirely within that selection. This identifies an actual supplied interaction; the program does not certify what happened semantically. Center-cover crop with the renderer's 1.08 zoom must preserve the critical region in every format or planning fails. Human framing notes remain required. Motion, text and safe zones use existing production components.

Each beat supplies `durationFrames`, `headline`, optional `subtext`, verbatim `spokenText`, visual selection, an audio selection and exact word timings. Spoken words must match captions exactly; word intervals are ordered, non-overlapping and inside owned beat frames. Media ranges must fit inspected source durations. Independent speech and music tracks own the sound; original product footage is muted so it cannot duplicate speech. Native frame counts use a 30 fps timebase; supplied source offsets are expressed in 30 fps equivalent frames, then video selections are decoded/re-encoded locally as precise 30 fps excerpts with immutable-original references. No automatic deletion or rate change occurs.

Music must cover the complete output range and uses explicit dialogue-first volume 0.25–0.35. There is no undocumented loop or silent fallback. Music cannot reuse overlapping original speech source intervals, even via an aliased media ID; explicit disjoint sections of one file remain possible. The final CTA headline/subtext must exactly equal the declared action/HTTPS destination. UI/product readable framing and excessive-copy concerns still require human review; crop geometry is not a text recognition system.

Proof requires claim IDs attached to concrete beats; every attached claim statement must actually appear in that beat’s visible or spoken copy. The evidence artifact exports flat `delivery.declaredClaims` (`claimId:beatId`, text, sceneId) plus exact preserved sources for the final delivery request. Proof requires original local text evidence with checksum, an actual matching excerpt and named review declaration/time. Evidence originals are preserved byte-for-byte under `assets/evidence/HASH.txt`. Unknown/missing IDs, unused claims, changed evidence or absent excerpts fail. No measurements or performance claims are invented or extrapolated. The supplied review is a declaration, not an approval manufactured by the workflow; final claim/story review remains pending.

`scopeRoot` adds canonical filesystem containment for every nested media/evidence input and the workspace root. Trusted local CLI callers may explicitly supply originals outside the workspace; MCP callers should always provide their authority root. Remote paths and symlink source files are not accepted.

## Output and rendering

The complete project includes canonical `project.json`, immutable asset registry/originals, `pipeline/timeline-edit.json`, exact source selections and claims in `pipeline/product-ad-evidence.json`, request and SRT/VTT sidecars. Proof documents, media hashes and timeline/story identity should be retained for final delivery. Canonical scenes preserve the visible titles/CTA; the timeline is authoritative for imported audio, source selections and captions. **Use `--timeline` for all renders of this workflow.**

```sh
pnpm render --project PROJECT --timeline --captions on --format vertical
pnpm render --project PROJECT --timeline --captions off --format vertical
# Repeat square and landscape; explicit --output is available for variant destinations.
```

Clean removes word captions; it retains planned titles, proof copy and CTA. Captioned includes the supplied speech words with exact beat timing. SRT/VTT groups never cross beat boundaries. Media paths are immutable local references, not provider URLs. All clip boundaries are intentional cuts; no hidden crossfade overlap changes speech timing.

`productionReady` remains false and human creative/visual/audio/licence/claim review is pending. Complete delivery through `scripts/delivery.ts --action snapshot|check --request DELIVERY.json [--snapshot SNAPSHOT.json]`, using approved source/story snapshot, exact formats/variants/placements, loudness and peak requirements, source rights, story-bound reviewed claims and hash-bound render receipts/reviews. The workflow never invents receipts, rights clearances, sales performance or creative approvals. Existing delivery checks decide whether a package is draft or production-ready.

## Local acceptance

```sh
pnpm exec tsx --test tests/workflow-product-ad.test.ts
RUN_WORKFLOW_RENDER_TESTS=1 WORKFLOW_ARTIFACTS_DIR=/tmp/avc-workflow-acceptance pnpm exec tsx --test tests/workflow-product-ad.browser.test.ts
pnpm exec tsc --noEmit
pnpm exec tsx scripts/lint-project.ts
```

Opt-in acceptance renders six actual MP4s through the existing Root in offline Chromium, with locally generated originals and clearly synthetic tone audio/captions. It verifies exact frame duration, dimensions, non-silent audio, caption pixel differences and visibility of the central product interaction in every crop. Retained start/demo/proof/tail PNGs, MP4s, sidecars and probe report are under `WORKFLOW_ARTIFACTS_DIR/product-ad`. Browser font substitution is explicitly labelled Arial/Georgia; this does not certify the intended production font appearance. Local technical acceptance does not replace human review or prove live API behavior, commercial rights, speech recognition or social performance.
