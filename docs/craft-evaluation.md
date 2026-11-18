# Offline craft evaluation (SKILL-03)

`pnpm exec tsx scripts/craft-evaluation.ts --action rubric` returns the maintained version-1 rubrics for product-ad, education, recording-edit and shorts-series. `--action evaluate --request /absolute/manifest.json --scope-root /absolute/workspace` evaluates a strict local manifest read-only, without provider calls, artifact writes or generation. Capture the single JSON envelope to a new report file through your orchestrator; do not overwrite a previous run. A defective baseline with a passing candidate is a successful comparison; a defective final variant returns `VALIDATION`, with its report in `details.report`.

## Manifest and reproducibility

The schema lives in `src/types/craft-evaluation.ts`. Required fields:

- `version: 1`, unique evaluation `id`, `scenario` (the four CLI workflow names), `material` (`synthetic-fixture` or `supplied-pilot`).
- Shared `inputs`: `{id,path,sha256}` for every source media, factual evidence and recording source. Paths resolve against `scope-root`. For shorts include source project/timeline/context artifacts; the existing shorts validator additionally checks the source dependency closure.
- `baseline`, and optional `candidate`: variant ID, pinned `request`, nonempty `skills` (actual skill snapshots), `configuration`, `decisions`, optional artifact `evidence`, `delivery`, and `review`. Every pin has ID/path/SHA-256. IDs are unique within a variant and its shared inputs. Corresponding artifact IDs across variants provide the before/after hash diff.
- Optional `repairs`: criterion ID, exact baseline/candidate fingerprints, candidate decision artifact ID and concrete rationale. Run once to obtain fingerprints, record the repair and run again. Repairs do not affect variant fingerprints.

Copy required skills/configuration into the authorized workspace or select a scope that already contains them. Do not set `/` as scope to bypass the intended boundary. JSON is parsed from the same bounded bytes that pass its pin hash; regular files, symlink rejection, stable reads, 8 MiB JSON/skill/configuration bounds and 32 GiB media bounds apply. Nothing in a manifest is executed. Preserve immutable originals. Changing shared media, transcript or protected context between variants is rejected; use a separate evaluation when inputs intentionally change.

`decisions` is strict JSON: `version:1`, `decisions:[{criterion,observation,choice,rationale,evidenceIds,unresolved?}]`. Record a concrete decision for every creative rubric criterion. `evidenceIds` must cite actual pins; observations, choices and unresolved assumptions remain distinct. Completeness is a technical property, not evidence of good taste.

## What is measured

The runner executes the existing `video:workflow` read-only planning contracts against the exact supplied request. These check source/claim/timing/protected selection dependencies and reject known defects. Its `workflowMetadata` retains those results. It does not render, measure loudness or inspect pixels. `technical:pass` means the workflow and decision-completeness contracts passed, and any supplied delivery evidence has no imported blocker or missing requested output. Without delivery evidence, its separate criterion remains pending.

Optional `delivery` imports an existing strict `DeliveryManifestSchema` report. The pinned project configuration must match every imported render identity; each delivered output must match an explicit artifact path/hash and source identity. Errors remain visible as `imported-blocked`, incomplete packages as `imported-incomplete`; both fail the technical `delivery-evidence` criterion and return a failing CLI envelope for the final variant. Successful import is `imported-checks`, which verifies the bindings and report shape, **not** the truth of copied measurements or human identity. Continue using the existing strict delivery workflow for actual output QA and release. Arbitrary screenshots/report files can be pinned as evidence but do not become measured acceptance.

Artifact hash changes report only `added`, `removed`, `changed` or `unchanged`. They cannot imply improved clarity, synchronization, audience response, conversion or virality.

## Human observations and repairs

`review` pins strict JSON with `version:1`, `origin` (`human-declared` or `synthetic-fixture`), reviewer name, ISO `reviewedAt`, exact `variantFingerprint`, and `observations:[{criterion,judgement,note,evidenceIds}]`. Judgement is `accepted`, `changes-requested` or `uncertain`. Cite a specific frame, phrase/context or artifact in the note. Review cannot override technical criteria. Missing observations remain pending; stale fingerprints, unpinned evidence, agent-origin reviews and extra approval fields are rejected.

Synthetic evaluations accept only fixture-origin observations; these remain `creative:pending` even if a fixture declares acceptance. Supplied-pilot observations are explicitly human-declared, unauthenticated judgements. This runner never creates release approval. Every creative criterion must have a current accepted human observation for `human-declared-accepted`; technical failures still remain failures. A repair is `evidence-resolved` only for a technical fail→pass or a human changes-requested→accepted on the same criterion; otherwise it stays unverified.

## Four pilot procedure

1. Reuse supplied originals and explicit request reviews for each workflow; preserve rights, factual qualifications, negations and episode source context.
2. Save exact skill versions, configuration, craft decisions, workflow request, generated timeline/configuration and actual delivery/contact-sheet/audio reports as pins.
3. Evaluate baseline. Use the concrete rubric questions to ask a human for observations bound to that fingerprint and those artifacts.
4. Repair only the recorded defect, evaluate candidate using the same supplied inputs, then record repair links and exact before/after evidence.
5. Keep final technical acceptance, imported render evidence, pending creative decisions and release approval distinct. Track defects that remain unresolved.

Local tests use actual FFmpeg synthetic supplied-media fixture files and generated workflow artifacts for all four scenarios, not real creators or subscriptions. Real human-reviewed advertisements, teaching examples, recording edits and shorts remain separate acceptance work. No numerical artistic score or predicted outcome is generated.
