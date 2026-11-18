# Checking chart figures and sources

`pnpm chart:inspect --project ID` checks the canonical project; `pnpm chart:inspect --project ID --timeline` checks the active chart payloads of the edit journal. The command reads local files, returns one JSON envelope, does not create sources, does not call generation and does not assert factual accuracy. The MCP `chart_inspect` has the same project/timeline arguments and a read-only scope.

The same label "95%" can mean a return or a share of people. For a checkable chart the author explicitly sets `quantity.kind` (`return-percent-v1` or `population-outperformed-percent-v1`), `unit:"%"`, subject/basis/method IDs and a calendar period. A share of people also needs cohort/comparator IDs. A shared axis requires consistent measurements; the subject may differ between series. Legacy charts without declarations are compatible but remain unconfirmed.

Callout `binding:{version:1,kind:"point-value-label-v1",expectedQuantity:QUANTITY,formatter:"signed-percent-v1"}` binds the label to the actual hero/default-last-or-explicit point. The text must format the value exactly, without rounding: a final value of 96 does not confirm a bound callout "+95%". A freeform callout is kept as unverified.

The source is stored as local version1 JSON with `records:[{id,quantity,value}]`. Its SHA256/excerpt must already belong to an existing owning workflow claim of this scene. In `pipeline/evidence/chart-quantity-bindings.json` each binding contains sceneId, the whole parsed/defaulted chartHash, seriesIndex/dataIndex, claimId, quantity/value and source{path,sha256,excerpt,recordId}. Use `chartQuantityHash(LeftPanelSchema.parse(panel))` from `src/lib/chart-quantity-sources.ts`; do not hash an arbitrary unchecked JSON string instead of the renderer payload. The source path uses the existing public-relative citation contract. Detailed schema/IO contract: quantity/source.

Interpreting the result:

| Status | Next action |
|---|---|
| `blocked` | Fix the exact metric/value/target/source conflict; the CLI returns VALIDATION with details |
| `unverified` | Check the missing declaration or source; the absence of errors does not confirm the claim |
| `declared-correspondence` | The exact bytes/record/value/declarations matched; separately check the meaning of the speech, the research and the required factual review |
| `not-applicable` | There is no active chart in the selected renderer mode; this is not an assessment of the project's accuracy |

`pipeline:check` shows the exact storyboard/project/bridge refs. The non-strict health probe keeps errors in findings and `readyToProceed:false`; strict returns VALIDATION. An informational source pending stays visible and nonblocking. Render planning, including `--dry-run`, refuses on explicit quantity/source errors before Chromium and checks that the consumed config/journal bytes match the effective charts. `--timeline` cannot borrow a stale canonical chart.

A new short keeps the quantity metadata, but without a matching remapped bridge it stays source pending. A change to evidence/bridge is part of the existing story/source snapshot and requires a current review. No status creates human approval or release authorisation; `factualTruth:"unverified"` and `humanApproval:"not-inferred"` are kept. The physical frames must still be checked for cropping, text overlap, contrast and fit with the story. Local route acceptance.
