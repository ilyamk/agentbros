import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TimelineIRSchema } from "../src/types/timeline";
import { inspectEditorialProject, sourceBoundCaptionPeers } from "../src/lib/editorial/qa";
import { reviewedRequest } from "./workflow-recording-edit-fixtures";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";

test("separate caption owners require the same source, edit, rate and clock mapping", () => {
  const base = {
    id: "speech",
    assetId: "audio",
    start: { num: 30, den: 1 },
    source: { start: { num: 30, den: 1 }, end: { num: 90, den: 1 }, timebase: { num: 30, den: 1 } },
    rate: { num: 1, den: 1 },
    transition: { kind: "cut" },
    captions: [],
    payload: { sourceHash: "a".repeat(64), editHash: "b".repeat(64) },
  };
  const captions = {
    ...base,
    id: "independent-caption-name",
    assetId: "caption:inline",
    captions: [{ id: "word", text: "Source", start: { num: 30, den: 1 }, end: { num: 40, den: 1 } }],
  };
  const ir = TimelineIRSchema.parse({
    version: 1,
    projectId: "fixture",
    timebase: { num: 30, den: 1 },
    tracks: [
      { id: "voice", kind: "voiceover", clips: [base] },
      { id: "subtitles", kind: "captions", clips: [captions] },
    ],
  });
  const speech = ir.tracks[0]!.clips[0]!;
  assert.equal(sourceBoundCaptionPeers(ir, speech).length, 1);
  for (const mutation of ["source", "edit", "rate", "clock", "missing"] as const) {
    const changed = structuredClone(ir),
      peer = changed.tracks[1]!.clips[0]!;
    if (mutation === "source") peer.payload!.sourceHash = "c".repeat(64);
    if (mutation === "edit") peer.payload!.editHash = "c".repeat(64);
    if (mutation === "rate") peer.rate.num = 2;
    if (mutation === "clock") peer.start.num++;
    if (mutation === "missing") delete peer.payload;
    assert.deepEqual(sourceBoundCaptionPeers(changed, speech), [], mutation);
  }
  const sliced = structuredClone(ir),
    peer = sliced.tracks[1]!.clips[0]!;
  peer.start.num = 40;
  peer.source.start.num = 40;
  peer.source.end.num = 60;
  assert.equal(
    sourceBoundCaptionPeers(sliced, speech).length,
    1,
    "a separately split owner retains the same source/output mapping",
  );
});
test("actual recording workflow captions satisfy editorial QA on their separate canonical track", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "editorial-caption-owner-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = await reviewedRequest(root);
  await runRecordingEditWorkflow(request, { action: "create", rootDir: root });
  const result = inspectEditorialProject("recut", { rootDir: root, editedTimeline: true });
  assert.ok(
    !result.findings.some((f) => f.code === "CAPTIONS_MISSING" || f.code === "SPEECH_WORD_CUT"),
    JSON.stringify(result.findings),
  );
});
