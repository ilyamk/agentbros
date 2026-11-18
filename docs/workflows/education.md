# Source-backed education workflow

Implementation plan: accept a concrete six-stage lesson with supplied originals, checksum-bound text evidence and captions. Reuse immutable imports, canonical TimelineIR and chapter slicing rather than generating media. Planning must write nothing; creation publishes a draft without overwriting projects. Success means exact frame/audio/caption mapping, protected context, chapter-local invalidation and a real offline ProductionRoot MP4 test. Local evidence checks establish file integrity and quoted excerpts, not scientific truth or creative approval.

Steps: inspect schemas; validate sources/media/learning structure; build canonical scene/audio/caption tracks and chapter manifest; stage immutable originals and evidence; publish project.json last; test negative inputs, long lessons, incremental caching and actual local renders.

## Inputs and learning logic

`runEducationWorkflow(raw, {action, rootDir, scopeRoot?})` accepts the strict version-1 schema in `src/types/workflow-education.ts`. Each chapter has exactly these beats in order: prerequisite → question → explanation → worked-example → application → recap. One supplied original voice source can serve the whole lesson with exact 30fps source windows. Each beat has a supplied image/video, headline, spoken script, claim IDs and ordered captions timed relative to that beat. Supply at least two distinct visual originals and music. No new media is generated.

Every source is a checksum-bound UTF-8 `.md`, `.txt` or `.json` original. Claims provide quoted evidence, a locator and optionally a supplied public URL. Exact excerpt containment is checked locally; URLs are never fetched. Inferences, illustrative conclusions and uncertain claims need an explicit uncertainty sentence. Every limitation and uncertainty must occur verbatim in the owning spoken beat and the chapter's self-contained recap. This makes recap reuse preserve scope rather than implying a stronger conclusion. Protected spans prevent cutting through context-bearing beats.

Captions must match supplied script text in order, ignoring punctuation/case, and cannot overlap or leave their beat. This checks the authored contract, not whether recorded audio actually says those words. That still requires listening/transcript review. Video originals play muted while supplied narration owns speech; image scenes use the existing photo renderer. No provider calls, hidden generation or fake approvals occur.

Planning reads/hashes/probes inputs without writing. Creation imports immutable originals under the existing SHA256 registry, copies evidence into `pipeline/evidence/`, creates canonical `project.json`, `pipeline/timeline-edit.json`, `pipeline/chapters.json`, `pipeline/education.json` and `pipeline/workflow-render.json`. Exclusive project reservation prevents overwrite; `project.json` is published last as the draft commit marker. Existing projects must be edited with the normal revisioned timeline APIs. A failed transaction removes only its own reserved new project. Inputs remain untouched. MCP should pass `scopeRoot`; every realpath original and destination must remain inside it. Normal local callers may explicitly supply external originals. Input counts/bytes, decoded dimensions and source duration are bounded; cache/private directories are rejected.

The published status is **draft-needs-source-creative-and-delivery-review**. Source integrity does not certify accuracy, licences, speaker consent, teaching quality or final QA. Supplied rights and provenance remain candidate declarations; unknown billing stays unknown.

## Local example and rendering

```sh
pnpm tsx examples/workflows/education/create-example.ts /absolute/new-example-directory
# Pass request.json to the shared video:workflow education plan/create entry point.
# Or call runEducationWorkflow(JSON.parse(readFileSync(requestFile, 'utf8')),
#   {action:'create',rootDir:workspaceRoot}) after resolving media/source paths.
pnpm video:longform -- --project education-demo --apply --assemble --chapters public/projects/education-demo/pipeline/chapters.json
# For an offline render, add --font-context <verified local font-role JSON>.
# Clean chapters/assembly have a separate cache: add --captions off.
```

The example deliberately uses local tones and two colored test images; its treatment is labelled synthetic technical evidence. Replace them with approved spoken narration and meaningful diagrams, repin SHA256 and author timings before producing a final video. The fixture plans 4.5 minutes across three complete learning chapters. Music and narration are separate original tracks with no regenerated TTS or paid replay.

Chapter fingerprints include local scene/claim evidence, exact media source spans and content hashes. Editing one chapter invalidates only its dependencies; shared original or renderer changes intentionally invalidate all affected chapters. Claim files also belong in full render identity. Use the existing longform runner for chapter-local checksummed render cache and the existing delivery/QA workflow for final assembly and acceptance. Claim IDs and supplied source URLs are exposed in delivery metadata; approvals remain empty until genuine review.

## Verification

```sh
pnpm tsx --test tests/workflow-education.test.ts
RUN_WORKFLOW_RENDER_TESTS=1 WORKFLOW_ARTIFACTS_DIR=/absolute/evidence pnpm tsx --test tests/workflow-education-browser.test.ts
RUN_WORKFLOW_RENDER_TESTS=1 RUN_WORKFLOW_LONGFORM_TESTS=1 WORKFLOW_ARTIFACTS_DIR=/absolute/evidence pnpm tsx --test tests/workflow-education-browser.test.ts
```

The real browser tests use ProductionRoot, offline system-font substitution and supplied synthetic sources. They render MP4 chapter jobs, assemble contiguous chapters with FFmpeg, decode the result, check exact video frames/duration and the audio stream, prove actual caption mounting, verify cache reuse without another render, and re-render exactly one changed chapter. The optional long acceptance renders 180 seconds in six chapters at reduced test resolution. Retained artefacts contain MP4, probe/treatment reports and labelled chapter, worked-example, recap and tail PNGs. They prove local technical behavior, not real speech alignment or artistic delivery readiness.

## Exact reusable chapter assembly

Production `assembleChapters(plan, result?, {rootDir?, outputFile?, timeoutMs?})` in `src/lib/longform/assembly.ts` consumes the existing `projectChapterPlan` and optional `renderChapters` result. It accepts only the selected project's canonical cached outputs, their exact recorded fingerprints/SHA256, 30fps and authored frame counts, matching even dimensions and sufficient decoded audio samples. The output stays under `out/{projectId}`. All ancestors are checked before creating directories; existing outputs cannot be overwritten.

The assembler trims every chapter's video by frame count and audio by decoded source sample count, rebases timestamps, converts audio to 48kHz stereo and concatenates through FFmpeg's filter graph. It re-encodes the full assembly locally. This avoids cumulative AAC packet padding from naive MP4 stream-copy concat. It probes the final frame count/FPS/dimensions/duration and fully decodes the complete result before immutable publication. The `.assembly.json` sidecar binds the child source checksums, chapter fingerprints, assembly identity and output hash. A matching previously assembled output is decoded/verified and reused. Changed chapters re-render individually; assembly itself still re-encodes all chapters. It does not claim pixel identity with a whole-project render: chapter-local animation clocks can differ. `video:longform --assemble` plans by default; add `--apply` to execute. `--output` selects an immutable MP4 under the project's `out/` directory. MCP exposes the same options through `avc_longform`.

The assembly sidecar records observed chapter/encoding integrity; it is not a whole-project renderer receipt or a creative approval. For automatic whole-project receipt generation, render the complete TimelineIR with `pnpm render --project education-demo --timeline`. To deliver a chapter assembly through strict delivery, a human must explicitly review and bind that exact output hash, noting the chapter-local animation clocks, and supply all other current approvals/QA/rights/claims required by delivery. Never relabel an assembly as an automatically observed canonical whole-project render.

```ts
const plan = projectChapterPlan(projectId, manifest, { rootDir });
const rendered = await renderChapters(plan, { dryRun: false, render: backend });
const assembled = assembleChapters(plan, rendered, { rootDir });
```

Claim IDs alone never establish attribution: every referenced claim's exact authored statement must occur verbatim in its owning spoken script. Write a separate sourced claim for a paraphrase or example rather than attaching an unrelated sentence to an existing claim ID. This is a structural safeguard, not an automated semantic fact checker. Final review must still check that the excerpt supports the claim and that no additional unsupported assertion appears in the script.

Captioned and clean chapter assemblies use separate cache namespaces (`format/cache.json` and `format/clean/cache.json`) and cannot mix caption flags. Assembly receipts bind the captured per-chapter font context when present; these describe the already rendered chapter snapshots, while new project plans invalidate changed font inputs. Custom `outputFile` paths must be canonical absolute paths inside the selected project's output directory. Omitting it uses a deterministic immutable assembly path.
