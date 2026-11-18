import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { adaptLegacyProject } from "../src/lib/timeline-ir/legacy";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
test("workflow claim evidence and reviewed source selections change delivery story identity", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "workflow identity "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline/evidence"), { recursive: true });
  const config = {
    name: "Identity",
    productName: "Identity",
    formats: ["landscape"],
    colors: {},
    musicVolume: 0,
    voiceoverEnabled: false,
    scenes: [{ id: "example", text: "", headline: "Example", visualType: "title", durationInFrames: 30 }],
  };
  writeFileSync(path.join(project, "project.json"), JSON.stringify(config));
  new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json")).initialize(
    adaptLegacyProject(config, "demo"),
  );
  writeFileSync(
    path.join(project, "pipeline/workflow-render.json"),
    JSON.stringify({ version: 1, workflow: "education", projectId: "demo", timelineRequired: true }),
  );
  writeFileSync(
    path.join(project, "pipeline/education.json"),
    JSON.stringify({ lesson: "Reviewed original", claims: [{ id: "claim", source: "source-a" }] }),
  );
  writeFileSync(path.join(project, "pipeline/evidence/source-a.txt"), "Reviewed statement with caveat.");
  // Edited tracks are authoritative: legacy music/VO sidecars need not exist.
  writeFileSync(path.join(project, "project.json"), JSON.stringify({ ...config, musicVolume: 0.3 }));
  const before = captureRenderIdentity("demo", "landscape", { rootDir: root, timeline: true });
  assert.ok(before.sources.some((source) => source.path.endsWith("education.json") && source.role === "creative"));
  assert.ok(before.sources.some((source) => source.path.endsWith("source-a.txt") && source.role === "creative"));
  writeFileSync(path.join(project, "pipeline/evidence/source-a.txt"), "Edited statement dropping caveat.");
  const changedEvidence = captureRenderIdentity("demo", "landscape", { rootDir: root, timeline: true });
  assert.notEqual(changedEvidence.storyHash, before.storyHash);
  assert.notEqual(changedEvidence.sourceSnapshotHash, before.sourceSnapshotHash);
  writeFileSync(
    path.join(project, "pipeline/recording-edit.json"),
    JSON.stringify({ editHash: "new reviewed selection" }),
  );
  const changedSelection = captureRenderIdentity("demo", "landscape", { rootDir: root, timeline: true });
  assert.notEqual(changedSelection.storyHash, changedEvidence.storyHash);
  assert.notEqual(changedSelection.sourceSnapshotHash, changedEvidence.sourceSnapshotHash);
});
