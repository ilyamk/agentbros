import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { timingFixture } from "./workflow-recording-timing-fixtures";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { planProjectRender } from "../src/lib/render-plan";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { readAssetRegistry } from "../src/lib/assets/registry";

// Regression for a demonstrated two-label downgrade bypass in the first v2 evidence guard.
test("normalized recording evidence cannot downgrade version labels or hide normalized fields while retaining old review", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "recording-evidence-audit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = timingFixture(root, "vfr");
  const plan = await runRecordingEditWorkflow(f.request, { action: "plan", rootDir: root });
  await runRecordingEditWorkflow(
    {
      ...f.request,
      review: {
        reviewer: "SYNTHETIC EVIDENCE AUDIT ONLY",
        reviewedAt: "2026-10-11T00:00:00Z",
        approvedEditHash: plan.metadata.editHash,
        meaningPreserved: true,
      },
    },
    { action: "create", rootDir: root },
  );
  const file = path.join(root, "public/projects", f.request.projectId, "pipeline/recording-edit.json");
  const original = readFileSync(file, "utf8"),
    report = JSON.parse(original);
  for (const hideFields of [false, true]) {
    const downgrade = structuredClone(report);
    downgrade.version = 1;
    downgrade.request.version = 1;
    if (hideFields) {
      delete downgrade.request.source.normalization;
      delete downgrade.normalization;
      delete downgrade.normalizedVideoAssetId;
      delete downgrade.normalizedVideoHash;
    }
    writeFileSync(file, JSON.stringify(downgrade));
    assert.throws(
      () => planProjectRender(f.request.projectId, "landscape", root, { timeline: true }),
      /recording|normaliz|identity|review|version|source/i,
    );
  }
  const forgedSummary = structuredClone(report);
  forgedSummary.normalization.authenticAudioDurationSec += 0.001;
  forgedSummary.normalization.authenticContentDurationSec = Math.min(
    forgedSummary.normalization.authenticAudioDurationSec,
    forgedSummary.normalization.decodedAudioDurationSec,
  );
  writeFileSync(file, JSON.stringify(forgedSummary));
  assert.throws(
    () => planProjectRender(f.request.projectId, "landscape", root, { timeline: true }),
    /recording|timing|identity|audio|summary/i,
  );
  writeFileSync(file, original);
  assert.equal(
    planProjectRender(f.request.projectId, "landscape", root, { timeline: true }).jobs[0].durationInFrames,
    120,
  );
  const registry = readAssetRegistry(f.request.projectId, root);
  const raw = registry.assets.find((asset) => asset.id === report.sourceAssetId)!;
  const identity = captureRenderIdentity(f.request.projectId, "landscape", { rootDir: root, timeline: true });
  assert.ok(
    identity.sources.some(
      (source) =>
        source.path === `public/${raw.files.original}` &&
        source.sha256 === f.request.source.sha256 &&
        source.role === "asset",
    ),
    "delivery must pin raw immutable VFR original as well as normalized active media",
  );
  const registryFile = path.join(root, "public/projects", f.request.projectId, "pipeline/asset-registry.json");
  const originalRegistry = readFileSync(registryFile, "utf8");
  for (const id of [report.normalizedVideoAssetId, report.audioAssetId]) {
    const missingDuration = JSON.parse(originalRegistry);
    delete missingDuration.assets.find((asset: { id: string }) => asset.id === id).media.durationSec;
    writeFileSync(registryFile, JSON.stringify(missingDuration));
    assert.throws(
      () => planProjectRender(f.request.projectId, "landscape", root, { timeline: true }),
      /duration|asset|recording/i,
    );
  }
  writeFileSync(registryFile, originalRegistry);
  appendFileSync(path.join(root, "public", raw.files.original), "\0");
  assert.throws(
    () => planProjectRender(f.request.projectId, "landscape", root, { timeline: true }),
    /recording|bytes|source|hash/i,
  );
});
