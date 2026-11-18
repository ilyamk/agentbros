# Three supplied selections, pending human approval

`pending-selections.json` mirrors the **synthetic local test fixture** in `tests/workflow-shorts-series.fixture.ts`: four 1-second red/blue/green/yellow blocks and 220/440/880/1100 Hz tones. Russian strings are supplied test caption labels, not generated claims or a transcription. This example does not pretend to have recorded speech or production approvals.

1. Run the documented workflow browser test to materialize and inspect the three synthetic clips and their evidence. Test approval declarations are explicitly synthetic, never reusable for production.
2. For an actual existing recording, author the source TimelineIR and ChapterManifest from that recording. Replace ranges and labels in the pending file with exact source timecodes; retain negation/qualification dependencies.
3. Call `inspectShortsSeriesSource` to obtain actual immutable source pins. Have a human review the exact recording, ranges and context. Only then supply `approvedBy`, `approvedAt`, `selectionHash(ranges)` and `approvedSourceHash` in a real workflow request.
4. Plan and create through `runShortsSeriesWorkflow`; render all episodes with `--timeline`, inspect vertical and optional square crops, then run QA and rights/delivery review.

The pending file deliberately cannot pass the production request schema until genuine explicit review is supplied. No source checksum, approval or performance claim is invented. See [workflow documentation](../../../docs/workflows/shorts-series.md).
