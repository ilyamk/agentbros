import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, unlinkSync } from "node:fs";
import { timingFixture } from "./workflow-recording-timing-fixtures";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { planProjectRender } from "../src/lib/render-plan";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";

async function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "recording-evidence-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = timingFixture(root, "ntsc");
  const plan = await runRecordingEditWorkflow(fixture.request, { action: "plan", rootDir: root });
  const reviewed = {
    ...fixture.request,
    review: {
      reviewer: "SYNTHETIC TIMING TEST ONLY",
      reviewedAt: "2026-10-11T00:00:00Z",
      approvedEditHash: plan.metadata.editHash,
      meaningPreserved: true,
    },
  };
  await runRecordingEditWorkflow(reviewed, { action: "create", rootDir: root });
  const projectId = fixture.request.projectId;
  const project = path.join(root, "public/projects", projectId);
  return {
    root,
    project,
    projectId,
    reportFile: path.join(project, "pipeline/recording-edit.json"),
    registryFile: path.join(project, "pipeline/asset-registry.json"),
  };
}
test("v2 render source identity includes original raw bytes and registry while legal timeline edits remain reversible", async (t) => {
  const f = await fixture(t);
  const report = JSON.parse(readFileSync(f.reportFile, "utf8"));
  const registry = JSON.parse(readFileSync(f.registryFile, "utf8"));
  const original = registry.assets.find((asset: any) => asset.id === report.sourceAssetId);
  const identity = captureRenderIdentity(f.projectId, "landscape", { rootDir: f.root, timeline: true });
  assert.ok(
    identity.sources.some(
      (source) => source.path === "public/" + original.files.original && source.sha256 === report.request.source.sha256,
    ),
  );
  assert.ok(
    identity.sources.some(
      (source) => source.path.endsWith("/pipeline/asset-registry.json") && source.role === "creative",
    ),
  );
  const store = new TimelineEditStore(path.join(f.project, "pipeline/timeline-edit.json"));
  const initial = store.read().timeline;
  const edit = store.apply(
    {
      type: "batch",
      commands: initial.tracks.map((track) => ({
        type: "trim",
        trackId: track.id,
        clipId: "last",
        start: track.clips[1].source.start,
        end: { num: track.clips[1].source.end.num - 1, den: 1 },
      })),
    },
    0,
  );
  assert.equal(
    planProjectRender(f.projectId, "landscape", f.root, { timeline: true }).jobs[0].durationInFrames,
    identity.durationInFrames - 1,
  );
  assert.notEqual(
    captureRenderIdentity(f.projectId, "landscape", { rootDir: f.root, timeline: true }).sourceSnapshotHash,
    identity.sourceSnapshotHash,
  );
  assert.deepEqual(store.undo(edit.revision).timeline, initial);
  assert.equal(
    planProjectRender(f.projectId, "landscape", f.root, { timeline: true }).jobs[0].durationInFrames,
    identity.durationInFrames,
  );
});
test("v2 render refuses source-policy/review/map relabeling and original/derivative provenance or bytes tampering", async (t) => {
  const f = await fixture(t);
  const reportBytes = readFileSync(f.reportFile),
    registryBytes = readFileSync(f.registryFile);
  for (const mutate of [
    (r: any) => r.normalization.masterToDecodedFrame[0]++,
    (r: any) => (r.normalization.sourceBoundaries[1].sourceSec += 0.01),
    (r: any) => r.normalization.repeatedMasterFrames++,
    (r: any) => (r.normalization.mappingHash = "0".repeat(64)),
    (r: any) => {
      r.normalization.authenticAudioDurationSec += 0.01;
      r.normalization.authenticContentDurationSec += 0.01;
    },
    (r: any) => (r.normalization.boundaryMaxErrorSec = 0),
    (r: any) => (r.identity.source.sha256 = "0".repeat(64)),
    (r: any) => (r.request.source.version += "-tampered"),
    (r: any) => (r.request.source.fps.num = 30),
    (r: any) => (r.reviewEvidence.approvedEditHash = "0".repeat(64)),
    (r: any) => {
      r.version = 1;
      r.request.version = 1;
    },
  ]) {
    const report = JSON.parse(reportBytes.toString());
    mutate(report);
    writeFileSync(f.reportFile, JSON.stringify(report));
    assert.throws(() => planProjectRender(f.projectId, "landscape", f.root, { timeline: true }));
    writeFileSync(f.reportFile, reportBytes);
  }
  const report = JSON.parse(reportBytes.toString()),
    registry = JSON.parse(registryBytes.toString());
  for (const id of [report.sourceAssetId, report.normalizedVideoAssetId, report.audioAssetId]) {
    const asset = registry.assets.find((item: any) => item.id === id);
    const file = path.join(f.root, "public", asset.files.original),
      bytes = readFileSync(file);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    writeFileSync(file, changed);
    assert.throws(
      () => captureRenderIdentity(f.projectId, "landscape", { rootDir: f.root, timeline: true }),
      /bytes changed/,
    );
    writeFileSync(file, bytes);
  }
  for (const id of [report.normalizedVideoAssetId, report.audioAssetId]) {
    const changed = JSON.parse(registryBytes.toString());
    changed.assets.find((item: any) => item.id === id).provenance.referenceAssetIds = [];
    writeFileSync(f.registryFile, JSON.stringify(changed));
    assert.throws(() => planProjectRender(f.projectId, "landscape", f.root, { timeline: true }), /provenance/);
    writeFileSync(f.registryFile, registryBytes);
  }
  const original = registry.assets.find((item: any) => item.id === report.sourceAssetId);
  const file = path.join(f.root, "public", original.files.original),
    bytes = readFileSync(file);
  const alias = path.join(f.root, "alias.mp4");
  writeFileSync(alias, bytes);
  unlinkSync(file);
  symlinkSync(alias, file);
  assert.throws(() => planProjectRender(f.projectId, "landscape", f.root, { timeline: true }), /symlink/);
});
