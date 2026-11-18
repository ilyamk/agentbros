import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  truncateSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashFile } from "../src/lib/assets/registry";
import { workflowClaims } from "../src/lib/workflows/claims";
import { readWorkflowEvidence } from "../src/lib/workflows/local-evidence";
import { chartQuantityHash, inspectChartQuantitySources } from "../src/lib/chart-quantity-sources";
import { LeftPanelSchema } from "../src/types/video";
import { type ChartPanel } from "../src/lib/chart-domain";
import { TimelineEditStore, parseTimelineEditDocument } from "../src/lib/timeline-ir/store";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { shortsFixture } from "./workflow-shorts-series.fixture";
import { inspectShortsSeriesSource, runShortsSeriesWorkflow } from "../src/lib/workflows/shorts-series";
const quantity = {
  kind: "return-percent-v1" as const,
  unit: "%" as const,
  subjectId: "dca",
  basisId: "nominal",
  methodId: "buy-hold",
  period: { start: "2015-01-01", end: "2025-01-01" },
};
function fixture(t: test.TestContext, mode: "inherited" | "product" | "education" = "inherited") {
  const root = mkdtempSync(path.join(tmpdir(), "chart-source-")),
    project = path.join(root, "public/projects/demo");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(project, "pipeline/evidence"), { recursive: true });
  const panel = LeftPanelSchema.parse({
    kind: "chart",
    yUnit: "%",
    quantity,
    data: [{ value: 95 }],
    callout: {
      value: "+95%",
      binding: { version: 1, kind: "point-value-label-v1", expectedQuantity: quantity, formatter: "signed-percent-v1" },
    },
  }) as ChartPanel;
  const scene = {
    id: "proof",
    text: "Synthetic numerical declaration",
    visualType: "title",
    durationInFrames: 30,
    presenterStartSec: 0,
    presenterEndSec: 1,
    leftPanel: panel,
  };
  const config = {
    name: "synthetic chart",
    formats: ["landscape"],
    productName: "fixture",
    colors: {},
    musicVolume: 0,
    voiceoverEnabled: false,
    talkingHead: { enabled: true, presenterVideo: "projects/demo/presenter.mp4" },
    scenes: [scene],
  };
  const configFile = path.join(project, "project.json");
  writeFileSync(configFile, JSON.stringify(config));
  writeFileSync(path.join(project, "presenter.mp4"), "source identity fixture only; no render");
  const sourceFile = path.join(project, "pipeline/evidence/source.json");
  const source = { version: 1, records: [{ id: "synthetic", quantity, value: 95 }] };
  writeFileSync(sourceFile, JSON.stringify(source));
  const citation = {
    path: "projects/demo/pipeline/evidence/source.json",
    sha256: hashFile(sourceFile),
    excerpt: '"value":95',
  };
  let claimFile: string;
  if (mode === "inherited") {
    claimFile = path.join(project, "pipeline/workflow-claims.json");
    writeFileSync(
      claimFile,
      JSON.stringify({
        version: 1,
        projectId: "demo",
        claims: [{ id: "claim:proof", text: scene.text, sceneId: "proof", sourceUrls: [], evidence: [citation] }],
      }),
    );
  } else if (mode === "product") {
    claimFile = path.join(project, "pipeline/product-ad-evidence.json");
    writeFileSync(
      claimFile,
      JSON.stringify({
        claimEvidence: [{ id: "claim", statement: scene.text, evidence: citation }],
        beats: [{ id: "proof", claimIds: ["claim"] }],
      }),
    );
  } else {
    claimFile = path.join(project, "pipeline/education.json");
    writeFileSync(
      claimFile,
      JSON.stringify({
        request: {
          sources: [{ id: "source", sha256: citation.sha256 }],
          claims: [{ id: "claim", evidence: [{ sourceId: "source", excerpt: citation.excerpt }] }],
          chapters: [{ beats: [{ id: "proof", spokenText: scene.text, claimIds: ["claim"] }] }],
        },
        evidenceFiles: [{ id: "source", sha256: citation.sha256, file: "pipeline/evidence/source.json" }],
      }),
    );
  }
  const bridge = {
    version: 1,
    projectId: "demo",
    bindings: [
      {
        sceneId: "proof",
        chartHash: chartQuantityHash(panel),
        seriesIndex: 0,
        dataIndex: 0,
        claimId: "claim:proof",
        quantity,
        value: 95,
        source: { ...citation, recordId: "synthetic" },
      },
    ],
  };
  const bridgeFile = path.join(project, "pipeline/evidence/chart-quantity-bindings.json");
  const save = () => writeFileSync(bridgeFile, JSON.stringify(bridge));
  save();
  const inspect = () => inspectChartQuantitySources(root, "demo");
  return {
    root,
    project,
    config,
    scene,
    panel,
    configFile,
    source,
    sourceFile,
    citation,
    bridge,
    bridgeFile,
    claimFile,
    save,
    inspect,
  };
}
for (const mode of ["product", "education", "inherited"] as const)
  test(`${mode} bridge corresponds to existing exact claim/source declarations without truth or approval`, (t) => {
    const f = fixture(t, mode),
      bytes = readFileSync(f.configFile),
      result = f.inspect();
    assert.equal(result.status, "declared-correspondence");
    assert.equal(result.correspondence.length, 1);
    assert.equal(result.factualTruth, "unverified");
    assert.equal(result.humanApproval, "not-inferred");
    assert.equal(result.inputs.find((p) => p.path.endsWith("/source.json"))?.sha256, f.citation.sha256);
    assert.deepEqual(readFileSync(f.configFile), bytes);
  });
test("explicit wrong metric, numeric value, claim/scene, hash, subject, record and target are blocked", (t) => {
  const f = fixture(t),
    original = structuredClone(f.bridge);
  const changes = [
    (b: typeof f.bridge) => {
      b.bindings[0].quantity.subjectId = "other";
    },
    (b: typeof f.bridge) => {
      b.bindings[0].quantity.kind = "population-outperformed-percent-v1" as never;
      Object.assign(b.bindings[0].quantity, { cohortId: "traders", comparatorId: "dca-traders" });
    },
    (b: typeof f.bridge) => {
      b.bindings[0].value = 96;
    },
    (b: typeof f.bridge) => {
      b.bindings[0].claimId = "other";
    },
    (b: typeof f.bridge) => {
      b.bindings[0].sceneId = "other";
    },
    (b: typeof f.bridge) => {
      b.bindings[0].chartHash = "0".repeat(64);
    },
    (b: typeof f.bridge) => {
      b.bindings[0].source.recordId = "missing";
    },
    (b: typeof f.bridge) => {
      b.bindings[0].source.sha256 = "0".repeat(64);
    },
    (b: typeof f.bridge) => {
      b.bindings[0].source.excerpt = "different";
    },
    (b: typeof f.bridge) => {
      b.bindings[0].seriesIndex = 1;
    },
  ];
  for (const change of changes) {
    f.bridge.bindings = structuredClone(original.bindings);
    change(f.bridge);
    f.save();
    assert.equal(f.inspect().status, "blocked");
  }
});
test("stale normalized source record under newly pinned evidence cannot replace metric, cohort, method or value", (t) => {
  const f = fixture(t);
  f.source.records[0].quantity.methodId = "changed-method";
  writeFileSync(f.sourceFile, JSON.stringify(f.source));
  const sha256 = hashFile(f.sourceFile);
  f.bridge.bindings[0].source.sha256 = sha256;
  f.save();
  const claims = JSON.parse(readFileSync(f.claimFile, "utf8"));
  claims.claims[0].evidence[0].sha256 = sha256;
  writeFileSync(f.claimFile, JSON.stringify(claims));
  assert.equal(f.inspect().status, "blocked");
});
test("missing inherited bridge remains source pending; fake approval, duplicate bindings and inactive chart cannot pass", (t) => {
  const f = fixture(t);
  unlinkSync(f.bridgeFile);
  assert.equal(f.inspect().status, "unverified");
  assert.ok(f.inspect().findings.some((f) => f.code === "CHART_SOURCE_REVIEW_REQUIRED"));
  f.save();
  const fake = { ...f.bridge, approved: true };
  writeFileSync(f.bridgeFile, JSON.stringify(fake));
  assert.equal(f.inspect().status, "blocked");
  f.bridge.bindings.push(structuredClone(f.bridge.bindings[0]));
  f.save();
  assert.equal(f.inspect().status, "blocked");
  f.bridge.bindings.pop();
  f.save();
  f.config.talkingHead.enabled = false;
  writeFileSync(f.configFile, JSON.stringify(f.config));
  assert.equal(f.inspect().status, "blocked");
  unlinkSync(f.bridgeFile);
  assert.equal(f.inspect().status, "not-applicable");
});
test("bridge and normalized evidence are snapshot-bound; newly invalid declarations refuse capture", (t) => {
  const f = fixture(t),
    claims = JSON.parse(readFileSync(f.claimFile, "utf8"));
  claims.claims.push({ ...structuredClone(claims.claims[0]), id: "alternative:proof" });
  writeFileSync(f.claimFile, JSON.stringify(claims));
  const original = captureRenderIdentity("demo", "landscape", { rootDir: f.root });
  assert.ok(original.sources.some((p) => p.path.endsWith("/chart-quantity-bindings.json") && p.role === "creative"));
  f.bridge.bindings[0].claimId = "alternative:proof";
  f.save();
  const changed = captureRenderIdentity("demo", "landscape", { rootDir: f.root });
  assert.notEqual(changed.storyHash, original.storyHash);
  assert.notEqual(changed.sourceSnapshotHash, original.sourceSnapshotHash);
  f.source.records.push({ ...structuredClone(f.source.records[0]), id: "alternate-record" });
  writeFileSync(f.sourceFile, JSON.stringify(f.source));
  const sourceHash = hashFile(f.sourceFile);
  claims.claims.forEach((claim: { evidence: { sha256: string }[] }) => {
    claim.evidence[0].sha256 = sourceHash;
  });
  writeFileSync(f.claimFile, JSON.stringify(claims));
  f.bridge.bindings[0].source.sha256 = sourceHash;
  f.bridge.bindings[0].source.recordId = "alternate-record";
  f.save();
  const sourceChanged = captureRenderIdentity("demo", "landscape", { rootDir: f.root });
  assert.notEqual(sourceChanged.storyHash, changed.storyHash);
  f.bridge.bindings[0].quantity.methodId = "invalid-change";
  f.save();
  assert.throws(
    () => captureRenderIdentity("demo", "landscape", { rootDir: f.root }),
    (error: unknown) => (error as { code: string }).code === "VALIDATION",
  );
});
test("bounded source reader rejects leaf/parent aliases, invalid UTF8, sparse oversize and FIFOs; inherited claim discovery uses it", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  writeFileSync(outside, "outside");
  const leaf = path.join(f.project, "leaf");
  symlinkSync(outside, leaf);
  assert.throws(() => readWorkflowEvidence(leaf, f.project, 1024), /project|regular|aliases/);
  const dir = path.join(f.project, "alias");
  symlinkSync(path.dirname(f.sourceFile), dir);
  assert.throws(() => readWorkflowEvidence(path.join(dir, "source.json"), f.project, 1024), /parent aliases/);
  const bad = path.join(f.project, "bad");
  writeFileSync(bad, Buffer.from([0xff]));
  assert.throws(() => readWorkflowEvidence(bad, f.project, 1024), /encoded/);
  const big = path.join(f.project, "big");
  writeFileSync(big, "");
  truncateSync(big, 16 * 1024 * 1024);
  assert.throws(() => readWorkflowEvidence(big, f.project, 1024), /size invalid/);
  const fifo = path.join(f.project, "fifo");
  assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
  assert.throws(() => readWorkflowEvidence(fifo, f.project, 1024), /regular/);
  unlinkSync(f.claimFile);
  assert.equal(spawnSync("mkfifo", [f.claimFile]).status, 0);
  assert.throws(() => workflowClaims(f.root, "demo"), /regular/);
});
const r = (num: number) => ({ num, den: 1 });
test("bounded active timeline payload replaces canonical chart; removed or altered chart invalidates stale bridge", (t) => {
  const f = fixture(t),
    timelineFile = path.join(f.project, "pipeline/timeline-edit.json");
  const timeline = {
    version: 1,
    projectId: "demo",
    timebase: r(30),
    tracks: [
      {
        id: "visual",
        kind: "visual",
        clips: [
          {
            id: "proof",
            assetId: "scene:proof",
            start: r(0),
            source: { start: r(0), end: r(30), timebase: r(30) },
            rate: r(1),
            transition: { kind: "cut" },
            captions: [],
            payload: { scene: f.scene },
          },
        ],
      },
    ],
  };
  const store = new TimelineEditStore(timelineFile);
  const initial = store.initialize(timeline);
  assert.equal(inspectChartQuantitySources(f.root, "demo", { timeline: true }).status, "declared-correspondence");
  const changed = structuredClone(initial);
  changed.timeline.tracks[0].clips[0].payload!.scene = { ...f.scene, leftPanel: { ...f.panel, data: [{ value: 96 }] } };
  writeFileSync(timelineFile, JSON.stringify(changed));
  assert.equal(inspectChartQuantitySources(f.root, "demo", { timeline: true }).status, "blocked");
  assert.equal(f.inspect().status, "declared-correspondence", "Canonical chart remains independent of active edit");
  const absent = structuredClone(initial);
  absent.timeline.tracks[0].clips[0].payload!.scene = { ...f.scene, leftPanel: undefined };
  writeFileSync(timelineFile, JSON.stringify(absent));
  assert.equal(inspectChartQuantitySources(f.root, "demo", { timeline: true }).status, "blocked");
  writeFileSync(timelineFile, JSON.stringify(initial));
  assert.deepEqual(parseTimelineEditDocument(JSON.parse(readFileSync(timelineFile, "utf8"))), store.read());
  const cloned = parseTimelineEditDocument(initial);
  cloned.timeline.projectId = "other";
  assert.equal(initial.timeline.projectId, "demo");
  for (const bad of [
    { ...initial, revision: -1 },
    { ...initial, undo: [{ command: { kind: "invalid" }, before: initial.timeline, after: initial.timeline }] },
    { ...initial, timeline: { ...initial.timeline, timebase: r(0) } },
  ])
    assert.throws(() => parseTimelineEditDocument(bad));
});

test("claim source hash and excerpt validate the same consumed bytes even if a capture observer changes the file", (t) => {
  const f = fixture(t);
  let replaced = false;
  const claims = workflowClaims(f.root, "demo", {
    capture(input) {
      if (input.path === f.sourceFile && !replaced) {
        replaced = true;
        assert.equal(input.sha256, f.citation.sha256);
        writeFileSync(f.sourceFile, "Changed after consumed read");
      }
    },
  });
  assert.equal(claims[0].evidence[0].sha256, f.citation.sha256);
  assert.throws(() => workflowClaims(f.root, "demo"), /source changed/);
  assert.equal(f.inspect().status, "blocked");
});
test("supplied broken bridge alias and leaf evidence alias cannot masquerade as omission", (t) => {
  const f = fixture(t);
  unlinkSync(f.bridgeFile);
  symlinkSync(path.join(f.project, "missing"), f.bridgeFile);
  assert.equal(f.inspect().status, "blocked");
  unlinkSync(f.bridgeFile);
  f.save();
  const sourceOriginal = path.join(f.project, "original.json");
  writeFileSync(sourceOriginal, readFileSync(f.sourceFile));
  unlinkSync(f.sourceFile);
  symlinkSync(sourceOriginal, f.sourceFile);
  assert.throws(() => workflowClaims(f.root, "demo"), /regular|aliases/);
  assert.equal(f.inspect().status, "blocked");
});
test("real shorts creation retains optional typed chart metadata but missing remapped bridge remains explicitly pending", (t) => {
  const f = shortsFixture(t),
    originalHash = hashFile(f.video);
  const panel = LeftPanelSchema.parse({
    kind: "chart",
    yUnit: "%",
    quantity,
    data: [{ value: 95 }],
    callout: {
      value: "+95%",
      binding: { version: 1, kind: "point-value-label-v1", expectedQuantity: quantity, formatter: "signed-percent-v1" },
    },
  }) as ChartPanel;
  f.project.talkingHead = {
    enabled: true,
    presenterVideo: "projects/source/original.mp4",
  } as typeof f.project.talkingHead;
  f.project.scenes[0].leftPanel = panel;
  const clip = f.timeline.tracks.find((track) => track.kind === "visual")!.clips[0];
  clip.assetId = "scene:source";
  clip.payload = { scene: f.project.scenes[0] };
  writeFileSync(path.join(f.directory, "project.json"), JSON.stringify(f.project));
  writeFileSync(
    path.join(f.directory, "pipeline/timeline-edit.json"),
    JSON.stringify({ version: 1, revision: 4, timeline: f.timeline, undo: [], redo: [] }),
  );
  const inspected = inspectShortsSeriesSource("source", "pipeline/chapters.json", { rootDir: f.root });
  f.request.source = inspected.source;
  f.request.episodes.forEach((episode) => (episode.approvedSourceHash = inspected.approvalSourceHash));
  runShortsSeriesWorkflow(f.request, { action: "create", rootDir: f.root });
  for (const episode of f.request.episodes) {
    const id = `technical-series-${episode.selection.id}`,
      file = path.join(f.root, "public/projects", id, "project.json"),
      config = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(config.scenes[0].leftPanel.quantity, quantity);
    assert.deepEqual(config.scenes[0].leftPanel.callout.binding.expectedQuantity, quantity);
    const result = inspectChartQuantitySources(f.root, id, { timeline: true });
    assert.equal(result.status, "unverified");
    assert.ok(result.findings.some((f) => f.code === "CHART_SOURCE_REVIEW_REQUIRED"));
    assert.equal(result.correspondence.length, 0);
  }
  assert.equal(hashFile(f.video), originalHash);
});
