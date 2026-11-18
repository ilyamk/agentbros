import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  copyFileSync,
  symlinkSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { captureDeliverySnapshot, checkDelivery } from "../src/lib/delivery/service";
import { captureRenderIdentity } from "../src/lib/delivery/identity";
import { hashFile } from "../src/lib/assets/registry";
import { OperationStore } from "../src/lib/jobs/store";
import { PipelineStageSchema } from "../src/types/pipeline";
import { reviewGates } from "../src/lib/delivery/reviews";
import { importResource } from "../src/lib/font-resources/registry";
import { createFontManifest, FONT_ROLES } from "../src/lib/font-resources/manifest";
import { prepareRenderFontContext } from "../src/lib/font-resources/render-context";
import { inspectSfnt } from "../src/lib/font-resources/sfnt";
import { planProjectRender } from "../src/lib/render-plan";
import { extractEvidenceFrames } from "../src/lib/qa-evidence/frames";
import { DeliveryRequestSchema, type DeliveryRequest } from "../src/types/delivery";
import { TimelineEditStore, adaptLegacyProject } from "../src/lib/timeline-ir";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { USER_GRANT } from "./helpers/ceiling-grant";
const work = mkdtempSync(path.join(tmpdir(), "delivery-media-"));
test.after(() => rmSync(work, { recursive: true, force: true }));
function video(name: string, size = "1920x1080", seconds = 1, fps = 30) {
  const file = path.join(work, name);
  if (!existsSync(file)) {
    const run = spawnSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        `color=c=${name.includes("black") ? "black" : "blue"}:s=${size}:r=${fps}:d=${seconds}`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${seconds}`,
        "-af",
        "loudnorm=I=-16:TP=-2:LRA=7",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-t",
        String(seconds),
        "-y",
        file,
      ],
      { encoding: "utf8" },
    );
    assert.equal(run.status, 0, run.stderr);
  }
  return file;
}
const config = () => ({
  name: "delivery fixture",
  formats: ["landscape"],
  productName: "test",
  colors: {},
  musicVolume: 0,
  voiceoverEnabled: false,
  scenes: [{ id: "hook", text: "Hello", visualType: "title", headline: "Hello", durationInFrames: 30 }],
});
function fixture(t: test.TestContext, media = video("valid.mp4")) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "delivery-project-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), JSON.stringify(config()));
  mkdirSync(path.join(root, "out/demo"), { recursive: true });
  copyFileSync(media, path.join(root, "out/demo/landscape.mp4"));
  const request: DeliveryRequest = {
    version: 1,
    projectId: "demo",
    formats: ["landscape"],
    variants: ["captioned"],
    placements: ["youtube"],
    approvalMode: "manual",
    loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
  };
  const captured = captureDeliverySnapshot(request, { rootDir: root });
  return { root, project, request, ...captured };
}
function reviews(f: ReturnType<typeof fixture>) {
  const human = {
    reviewedBy: "Fixture reviewer",
    reviewedAt: new Date().toISOString(),
    evidence: "Explicit local test declaration",
  };
  f.request.manualApproval = {
    ...human,
    storyHash: f.snapshot.identities[0].storyHash,
    sourceSnapshotHash: f.snapshot.id,
  };
  f.request.visualReview = {
    ...human,
    sourceSnapshotHash: f.snapshot.id,
    outputHashes: [hashFile(path.join(f.root, "out/demo/landscape.mp4"))],
    approved: true,
  };
  f.request.renderBindings = f.snapshot.identities.map((i) => ({
    version: 1,
    sourceSnapshotHash: i.sourceSnapshotHash,
    propsHash: i.propsHash,
    outputSha256: hashFile(path.join(f.root, "out/demo/landscape.mp4")),
    format: i.format,
    captions: i.captions,
    createdAt: human.reviewedAt,
    sources: i.sources,
    evidence: "human-declared",
    reviewedBy: human.reviewedBy,
    note: human.evidence,
  }));
  return f;
}
const codes = (r: ReturnType<typeof checkDelivery>) => r.blockers.map((f) => f.code);
test("measured video produces immutable checksummed package only with explicit evidence", (t) => {
  const f = reviews(fixture(t));
  const result = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(result.productionReady, true, JSON.stringify(result.blockers));
  assert.equal(result.manifest.apiCalls, 0);
  assert.equal(result.manifest.costs, null);
  const release = result.outputs.find((file) => file.endsWith("/release.json"))!;
  assert.ok(release);
  const sums = JSON.parse(readFileSync(path.join(path.dirname(release), "checksums.json"), "utf8"));
  for (const sum of sums) assert.equal(hashFile(path.join(path.dirname(release), sum.file)), sum.sha256);
  assert.equal(result.manifest.outputs[0].fps, 30);
});
test("production missing approvals/visual review/binding persists actionable blocked report", (t) => {
  const f = fixture(t);
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes("CREATIVE_APPROVAL_REQUIRED"));
  assert.ok(codes(r).includes("VISUAL_REVIEW_REQUIRED"));
  assert.ok(codes(r).includes("RENDER_BINDING_MISSING"));
  assert.equal(JSON.parse(readFileSync(r.report, "utf8")).state, "blocked");
  assert.deepEqual(r.outputs, [r.report]);
});
test("draft remains needs-review and never publishes a ready package", (t) => {
  const f = fixture(t);
  f.request.mode = "draft";
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.ok, true);
  assert.equal(r.productionReady, false);
  assert.equal(r.manifest.state, "draft-needs-review");
  assert.equal(r.outputs.length, 1);
});
test("wrong encoded dimensions/fps/duration are genuine FFmpeg blockers", (t) => {
  const f = reviews(fixture(t, video("bad.mp4", "1280x720", 0.4, 25)));
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  for (const code of ["RESOLUTION_MISMATCH", "FPS_MISMATCH", "RENDER_DURATION_MISMATCH"])
    assert.ok(codes(r).includes(code), JSON.stringify(r.blockers));
});
test("explicit chosen loudness is enforced", (t) => {
  const f = reviews(fixture(t));
  f.request.loudness.targetLufs = -10;
  assert.ok(codes(checkDelivery(f.request, f.snapshot, { rootDir: f.root })).includes("LOUDNESS_OUTSIDE_TARGET"));
});
test("required clean variant cannot silently reuse captioned output", (t) => {
  const f = reviews(fixture(t));
  f.request.variants = ["clean", "captioned"];
  const c = captureDeliverySnapshot(f.request, { rootDir: f.root });
  const r = checkDelivery(f.request, c.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("RENDER_MISSING"));
});
test("alignment and dependency changes invalidate previously captured output identity", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.project, "voiceover"));
  const words = path.join(f.project, "voiceover/hook.words.json");
  writeFileSync(words, JSON.stringify({ words: [{ text: "Hello", start: 0, end: 0.5, loss: 0 }] }));
  writeFileSync(path.join(f.root, "package.json"), "{}");
  const c = captureDeliverySnapshot(f.request, { rootDir: f.root });
  Object.assign(f, c);
  reviews(f);
  writeFileSync(words, JSON.stringify({ words: [{ text: "Changed", start: 0, end: 0.5, loss: 0 }] }));
  writeFileSync(path.join(f.root, "package.json"), ' {"version":"changed"}');
  assert.ok(codes(checkDelivery(f.request, f.snapshot, { rootDir: f.root })).includes("SOURCE_CHANGED"));
});
test("shared public assets captured; overridden template missing image is ignored", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, "public/shared"));
  writeFileSync(path.join(f.root, "public/shared/image.png"), "local image fixture");
  const raw = {
    ...config(),
    scenes: [
      {
        ...config().scenes[0],
        imageUrl: "shared/image.png",
        template: { id: "scene.image-proof", version: 1, props: { headline: "Hello", imageUrl: "missing.png" } },
      },
    ],
  };
  writeFileSync(path.join(f.project, "project.json"), JSON.stringify(raw));
  const i = captureRenderIdentity("demo", "landscape", { rootDir: f.root });
  assert.ok(i.sources.some((s) => s.path === "public/shared/image.png"));
});
test("rights bind exact bytes and placement; stale/incorrect placement cannot release", (t) => {
  const f = fixture(t);
  mkdirSync(path.join(f.project, "assets"));
  const asset = path.join(f.project, "assets/image.png");
  writeFileSync(asset, "owned image fixture");
  const raw = { ...config(), scenes: [{ ...config().scenes[0], imageUrl: "projects/demo/assets/image.png" }] };
  writeFileSync(path.join(f.project, "project.json"), JSON.stringify(raw));
  Object.assign(f, captureDeliverySnapshot(f.request, { rootDir: f.root }));
  reviews(f);
  const review = {
    reviewedBy: "Owner",
    reviewedAt: new Date().toISOString(),
    evidence: "Owned original declared",
    sha256: hashFile(asset),
    licence: "owned-original",
    sourceUrl: "manual:original",
    commercialAllowed: true,
    modifiedAllowed: true,
    placements: ["tiktok"],
    attribution: "",
  };
  f.request.rightsReviews = [review];
  assert.ok(codes(checkDelivery(f.request, f.snapshot, { rootDir: f.root })).includes("RIGHTS_UNCONFIRMED"));
  review.placements = ["youtube"];
  assert.equal(checkDelivery(f.request, f.snapshot, { rootDir: f.root }).productionReady, true);
  review.sha256 = "0".repeat(64);
  assert.ok(codes(checkDelivery(f.request, f.snapshot, { rootDir: f.root })).includes("RIGHTS_UNCONFIRMED"));
});
test("unresolved paid job and over-cap actuals block release, retained reservation visible", (t) => {
  const f = reviews(fixture(t));
  const store = new OperationStore("demo", { directory: path.join(f.project, "pipeline") });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 }, USER_GRANT);
  store.reserveOperation({
    operationId: "pending",
    provider: "fixture",
    endpoint: "fixture",
    inputHash: "hash",
    assetId: "image",
    repair: false,
    quote: {
      currency: "USD",
      lowUsd: 0.5,
      expectedUsd: 0.5,
      highUsd: 0.5,
      bounded: true,
      source: "offline",
      asOf: "2026-10-11",
      confidence: "published-rate",
    },
  });
  store.transitionJob("pending", "submitting");
  store.transitionJob("pending", "unknown");
  let r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("GENERATION_UNRESOLVED"));
  assert.equal(r.manifest.costs?.reservedUsd, 0.5);
  store.reconcileBilling("pending", {
    receiptId: "bill",
    actualUsd: 2,
    source: "offline fixture",
    confirmedAt: new Date().toISOString(),
  });
  r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("BUDGET_EXCEEDED"));
});
test("educational declaration demands source-backed reviewed claim map", (t) => {
  const f = fixture(t);
  writeFileSync(path.join(f.project, "project.json"), JSON.stringify({ ...config(), educational: true }));
  Object.assign(f, captureDeliverySnapshot(f.request, { rootDir: f.root }));
  reviews(f);
  assert.ok(codes(checkDelivery(f.request, f.snapshot, { rootDir: f.root })).includes("CLAIMS_REVIEW_REQUIRED"));
});
test("escaping output symlink rejected and failure report remains local", (t) => {
  const f = reviews(fixture(t));
  const out = path.join(f.root, "out/demo/landscape.mp4");
  rmSync(out);
  symlinkSync(video("valid.mp4"), out);
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("OUTPUT_CHECK_FAILED"));
  assert.ok(r.report.startsWith(f.project));
});
test("CLI QA failure returns one JSON line, report output and nonzero status", (t) => {
  const f = fixture(t);
  const requestFile = path.join(f.root, "request.json");
  writeFileSync(requestFile, JSON.stringify(f.request));
  const run = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/delivery.ts"),
      "--request",
      requestFile,
      "--snapshot",
      f.file,
    ],
    { cwd: f.root, encoding: "utf8" },
  );
  assert.equal(run.status, 1, run.stderr);
  assert.equal(run.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.ok(result.outputs[0]?.endsWith(".json"), run.stdout);
  assert.ok(result.metadata.blockers.length > 0);
});
test("empty whitespace reviewer evidence rejected", () =>
  assert.equal(
    DeliveryRequestSchema.safeParse({
      version: 1,
      projectId: "demo",
      formats: ["landscape"],
      variants: ["clean"],
      placements: ["youtube"],
      loudness: { targetLufs: -16, toleranceLu: 1, maxTruePeakDb: -1, audioRequired: true },
      manualApproval: {
        reviewedBy: " ",
        reviewedAt: new Date().toISOString(),
        evidence: " ",
        storyHash: "0".repeat(64),
        sourceSnapshotHash: "0".repeat(64),
      },
    }).success,
    false,
  ));
test("published generation without invoice warns, keeps bound commitment and never claims zero actuals", (t) => {
  const f = reviews(fixture(t));
  const store = new OperationStore("demo", { directory: path.join(f.project, "pipeline") });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 }, USER_GRANT);
  store.reserveOperation({
    operationId: "published",
    provider: "fixture",
    endpoint: "fixture",
    inputHash: "hash",
    assetId: "image",
    repair: false,
    quote: {
      currency: "USD",
      lowUsd: 0.5,
      expectedUsd: 0.5,
      highUsd: 0.5,
      bounded: true,
      source: "offline",
      asOf: "2026-10-11",
      confidence: "published-rate",
    },
  });
  store.transitionJob("published", "submitting");
  store.transitionJob("published", "result-ready", {
    providerRequestId: "fixture-request",
    result: { image: "fixture-result" },
  });
  store.transitionJob("published", "downloading");
  store.transitionJob("published", "validated");
  store.transitionJob("published", "published");
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.productionReady, true, JSON.stringify(r.blockers));
  assert.equal(r.manifest.costs?.reservedUsd, 0.5);
  assert.ok(r.manifest.findings.some((f) => f.code === "BILLING_UNRECONCILED"));
});
test("renderer receipt mismatched props cannot bless existing output", (t) => {
  const f = reviews(fixture(t));
  const receipt = { ...f.request.renderBindings![0], evidence: "renderer", propsHash: "0".repeat(64) };
  writeFileSync(path.join(f.root, "out/demo/landscape.mp4.receipt.json"), JSON.stringify(receipt));
  assert.ok(codes(checkDelivery(f.request, f.snapshot, { rootDir: f.root })).includes("RENDER_BINDING_MISSING"));
});
test("mutable QA/gates/operation progress never invalidates authored render sources", (t) => {
  const f = fixture(t);
  const before = captureRenderIdentity("demo", "landscape", { rootDir: f.root });
  for (const name of ["pipeline-state.json", "qa.json", "operations.json", "render-evidence.json"])
    writeFileSync(
      path.join(f.project, "pipeline", name),
      JSON.stringify({ status: "changed", timestamp: new Date().toISOString() }),
    );
  const after = captureRenderIdentity("demo", "landscape", { rootDir: f.root });
  assert.equal(after.sourceSnapshotHash, before.sourceSnapshotHash);
});
test("a legacy pipeline-state.json's stage approvals are ignored: delivery needs the user's manualApproval", (t) => {
  const f = reviews(fixture(t));
  const now = new Date().toISOString();
  const stages = Object.fromEntries(PipelineStageSchema.options.map((s) => [s, { status: "pending", attempts: 0 }]));
  const history: any[] = [];
  for (const stage of ["brief", "script", "design", "storyboard", "qa"]) {
    stages[stage] = { status: "done", attempts: 1 };
    history.push(
      { timestamp: now, stage, action: "complete" },
      { timestamp: now, stage, action: "approve", actor: "Fixture reviewer" },
    );
  }
  const state = { projectId: "demo", stages, history, createdAt: now, updatedAt: now };
  writeFileSync(path.join(f.project, "pipeline/pipeline-state.json"), JSON.stringify(state));
  const legacy: any[] = [];
  reviewGates(f.root, DeliveryRequestSchema.parse({ ...f.request, approvalMode: "pipeline" }), f.snapshot, legacy);
  assert.ok(
    legacy.some((finding) => finding.code === "CREATIVE_APPROVAL_REQUIRED"),
    "stage approvals do not count",
  );
  const manual: any[] = [];
  reviewGates(f.root, DeliveryRequestSchema.parse({ ...f.request, approvalMode: "manual" }), f.snapshot, manual);
  assert.ok(!manual.some((finding) => finding.code === "CREATIVE_APPROVAL_REQUIRED"));
  assert.ok(manual.some((finding) => finding.code === "HUMAN_DECLARED_APPROVAL"));
});
test("requested subtitles without actual aligned cues block delivery instead of making empty sidecars", (t) => {
  const f = reviews(fixture(t));
  f.request.subtitles = ["srt", "vtt"];
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("SUBTITLE_EXPORT_FAILED"));
  assert.equal(r.productionReady, false);
});
test(
  "delivery font context reproduces frozen renderer identity and hashes selected font originals",
  { skip: !existsSync("/System/Library/Fonts/Supplemental/Arial.ttf") },
  (t) => {
    const f = fixture(t);
    const source = "/System/Library/Fonts/Supplemental/Arial.ttf";
    const actual = inspectSfnt(readFileSync(source));
    const record = importResource(
      "demo",
      source,
      {
        kind: "font",
        family: actual.family,
        style: actual.style as "normal",
        weight: actual.weight,
        subset: "local-test",
        requiredText: "Hello",
        source: "local system fixture",
        licence: "test-only",
        licenceEvidence: "no redistribution permission asserted",
        licenceText: "Fixture only",
        attribution: "local font fixture",
        checkedAt: new Date().toISOString(),
      },
      f.root,
    );
    const selection = {
      family: actual.family,
      style: actual.style as "normal",
      weights: [actual.weight],
      subset: "local-test",
      requiredText: "Hello",
    };
    const roles = Object.fromEntries(FONT_ROLES.map((role) => [role, selection])) as Record<
      (typeof FONT_ROLES)[number],
      typeof selection
    >;
    const manifest = createFontManifest("demo", roles, f.root);
    const file = path.join(f.root, "font-context.json");
    writeFileSync(file, JSON.stringify(manifest));
    f.request.fontContext = file;
    const captured = captureDeliverySnapshot(f.request, { rootDir: f.root });
    const props = planProjectRender("demo", "landscape", f.root).jobs[0].props;
    const prepared = prepareRenderFontContext("demo", file, props, f.root);
    const renderer = captureRenderIdentity("demo", "landscape", {
      rootDir: f.root,
      fontContext: prepared.contextFile,
      fontCaptureFiles: prepared.captureFiles,
    });
    assert.equal(captured.snapshot.identities[0].sourceSnapshotHash, renderer.sourceSnapshotHash);
    assert.ok(
      renderer.sources.some(
        (s) => s.path === `public/${record.original}` && s.sha256 === record.hash && s.role === "asset",
      ),
    );
    const unfonted = captureRenderIdentity("demo", "landscape", { rootDir: f.root });
    assert.notEqual(renderer.sourceSnapshotHash, unfonted.sourceSnapshotHash);
  },
);
test("declarative font context rejects arbitrary JavaScript instead of executing it", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "font-context.json");
  writeFileSync(file, '{"version":1,"faces":[],"roles":{},"code":"process.exit(0)"}');
  f.request.fontContext = file;
  assert.throws(() => captureDeliverySnapshot(f.request, { rootDir: f.root }), /Invalid declarative font context/);
});
function evidence(f: ReturnType<typeof fixture>) {
  const output = path.join(f.root, "out/demo/landscape.mp4");
  const dir = path.join(f.project, "pipeline/qa-evidence/local");
  const extraction = extractEvidenceFrames(
    output,
    dir,
    [
      { frame: 0, reasons: ["start"] },
      { frame: 29, reasons: ["tail"] },
    ],
    30,
    30,
    [],
  );
  const report = {
    version: 1,
    projectId: "demo",
    format: "landscape",
    sourceHash: hashFile(output),
    propsHash: f.snapshot.identities[0].propsHash,
    omittedEvents: 0,
    extraction,
  };
  const file = path.join(dir, "evidence.json");
  writeFileSync(file, JSON.stringify(report));
  return { file, report };
}
test("actual black-tail extraction blocks despite supplied visual approval", (t) => {
  const f = reviews(fixture(t, video("black.mp4")));
  const ev = evidence(f);
  assert.ok(ev.report.extraction.findings.some((f) => f.code === "UNEXPECTED_BLACK_TAIL"));
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("QA_EVIDENCE_FAILURE"));
  assert.ok(r.blockers.some((f) => f.message.includes("UNEXPECTED_BLACK_TAIL")));
});
test("matching evidence verifies extracted frame hash and ignores report for different output", (t) => {
  const f = reviews(fixture(t));
  const ev = evidence(f);
  writeFileSync(ev.report.extraction.frames[0].file, "tampered");
  let r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("OUTPUT_CHECK_FAILED"));
  ev.report.sourceHash = "0".repeat(64);
  writeFileSync(ev.file, JSON.stringify(ev.report));
  r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.productionReady, true, JSON.stringify(r.blockers));
  assert.ok(r.manifest.findings.some((f) => f.code === "AUTOMATED_QA_NOT_PROVEN"));
});
test("matching measured report omission remains warning and no browser/font approval is invented", (t) => {
  const f = reviews(fixture(t));
  const ev = evidence(f);
  ev.report.omittedEvents = 5;
  writeFileSync(ev.file, JSON.stringify(ev.report));
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.productionReady, true, JSON.stringify(r.blockers));
  assert.ok(r.manifest.findings.some((f) => f.code === "QA_EVIDENCE_OMISSIONS"));
  assert.ok(r.manifest.findings.some((f) => f.code === "BROWSER_QA_NOT_PROVEN"));
  const record = (r.manifest.reviewEvidence.qaEvidence as any[])[0];
  assert.equal(record.productionFontsMeasured, false);
});
test("browser report protocol forwards measured failure and never treats offline font mode as font proof", (t) => {
  const f = reviews(fixture(t));
  const ev = evidence(f);
  const supplied: any = ev.report;
  supplied.browser = {
    fontMode: "offline-substitute-not-production-font-approval",
    frames: [
      {
        ...supplied.extraction.frames[0],
        measurement: { findings: [{ code: "TEXT_CLIPPED", text: "protocol test only" }] },
      },
    ],
    findings: [],
  };
  writeFileSync(ev.file, JSON.stringify(supplied));
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(r.blockers.some((f) => f.code === "QA_EVIDENCE_FAILURE" && f.message.includes("TEXT_CLIPPED")));
  assert.ok(r.manifest.findings.some((f) => f.code === "FONT_EVIDENCE_NOT_PRODUCTION"));
  assert.equal((r.manifest.reviewEvidence.qaEvidence as any[])[0].productionFontsMeasured, false);
});
test("matching evidence cannot refer to a frame outside its own report folder", (t) => {
  const f = reviews(fixture(t));
  const ev = evidence(f);
  ev.report.extraction.frames[0].file = video("valid.mp4");
  ev.report.extraction.frames[0].sha256 = hashFile(video("valid.mp4"));
  writeFileSync(ev.file, JSON.stringify(ev.report));
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.ok(codes(r).includes("OUTPUT_CHECK_FAILED"));
});
test("existing bounded synthetic delivery fixture publishes separate selected subtitle files with source hashes and checksums", (t) => {
  const f = fixture(t),
    ir = adaptLegacyProject(config(), "demo"),
    visual = ir.tracks.find((track) => track.kind === "visual")!.clips[0]!;
  for (const [id, text] of [
    ["speaker-en", "Hello."],
    ["translation-fr", "Bonjour."],
  ])
    ir.tracks.push({
      id,
      kind: "captions",
      clips: [
        {
          ...structuredClone(visual),
          id: `${id}-clip`,
          captions: [{ id: `${id}-word`, text, start: { num: 0, den: 1 }, end: { num: 30, den: 1 } }],
        },
      ],
    });
  new TimelineEditStore(path.join(f.project, "pipeline/timeline-edit.json")).initialize(ir);
  f.request.timeline = true;
  f.request.subtitleTracks = [
    { trackId: "speaker-en", language: "en", filename: "english.srt", format: "srt" },
    { trackId: "translation-fr", language: "fr", filename: "french.vtt", format: "vtt" },
  ];
  Object.assign(f, captureDeliverySnapshot(f.request, { rootDir: f.root }));
  reviews(f);
  const result = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(result.productionReady, true, JSON.stringify(result.blockers));
  const release = result.outputs.find((file) => file.endsWith("/release.json"))!,
    directory = path.dirname(release),
    manifest = JSON.parse(readFileSync(release, "utf8"));
  assert.deepEqual(
    manifest.subtitleOutputs.map((output: { filename: string }) => output.filename),
    ["english.srt", "french.vtt"],
  );
  for (const output of manifest.subtitleOutputs)
    assert.equal(hashFile(path.join(directory, output.filename)), output.sha256);
  const sums = JSON.parse(readFileSync(path.join(directory, "checksums.json"), "utf8"));
  for (const name of ["english.srt", "french.vtt", "release.json"])
    assert.equal(sums.find((row: { file: string }) => row.file === name).sha256, hashFile(path.join(directory, name)));
  assert.equal(
    manifest.reviewEvidence.subtitleSelection.timelineSource.sha256,
    hashFile(path.join(f.project, "pipeline/timeline-edit.json")),
  );
  assert.equal(manifest.apiCalls, 0);
  assert.ok(manifest.findings.some((finding: { code: string }) => finding.code === "HUMAN_DECLARED_RENDER_BINDING"));
});
test("legacy subtitle delivery keeps captions.srt filename and exact historical bytes on the same bounded fixture", (t) => {
  const f = fixture(t),
    ir = adaptLegacyProject(config(), "demo");
  ir.tracks.find((track) => track.kind === "visual")!.clips[0]!.captions = [
    { id: "word", text: "Hello.", start: { num: 0, den: 1 }, end: { num: 30, den: 1 } },
  ];
  new TimelineEditStore(path.join(f.project, "pipeline/timeline-edit.json")).initialize(ir);
  f.request.timeline = true;
  f.request.subtitles = ["srt"];
  Object.assign(f, captureDeliverySnapshot(f.request, { rootDir: f.root }));
  reviews(f);
  const result = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(result.productionReady, true, JSON.stringify(result.blockers));
  assert.equal(result.manifest.subtitleOutputs, undefined);
  const file = result.outputs.find((file) => file.endsWith("/captions.srt"))!;
  assert.ok(file);
  assert.equal(readFileSync(file, "utf8"), "1\n00:00:00,000 --> 00:00:01,000\nHello.\n");
});
for (const fault of ["corrupt-written-subtitle", "change-journal-before-release", "corrupt-subtitle-after-checksums"])
  test(`final subtitle package refuses ${fault} before release commit marker`, (t) => {
    const f = fixture(t),
      ir = adaptLegacyProject(config(), "demo"),
      visual = ir.tracks.find((track) => track.kind === "visual")!.clips[0]!;
    ir.tracks.push({
      id: "captions-en",
      kind: "captions",
      clips: [
        {
          ...structuredClone(visual),
          id: "captions-en-clip",
          captions: [{ id: "word", text: "Hello.", start: { num: 0, den: 1 }, end: { num: 30, den: 1 } }],
        },
      ],
    });
    const journal = path.join(f.project, "pipeline/timeline-edit.json");
    new TimelineEditStore(journal).initialize(ir);
    f.request.timeline = true;
    f.request.subtitleTracks = [{ trackId: "captions-en", language: "en", filename: "english.srt", format: "srt" }];
    Object.assign(f, captureDeliverySnapshot(f.request, { rootDir: f.root }));
    reviews(f);
    const original = fs.linkSync;
    let mutated = false,
      subtitleFile = "";
    const mock = t.mock.method(fs, "linkSync", (source: fs.PathLike, target: fs.PathLike) => {
      original(source, target);
      if (fault === "corrupt-subtitle-after-checksums" && String(target).endsWith("/checksums.json")) {
        mutated = true;
        subtitleFile = path.join(path.dirname(String(target)), "english.srt");
        writeFileSync(subtitleFile, "late corrupted after checksums");
      }
      if (fault !== "corrupt-subtitle-after-checksums" && String(target).endsWith("/english.srt")) {
        mutated = true;
        subtitleFile = String(target);
        if (fault === "corrupt-written-subtitle") writeFileSync(target, "corrupted after immutable write");
        else writeFileSync(journal, readFileSync(journal, "utf8") + " ");
      }
    });
    syncBuiltinESMExports();
    try {
      const result = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
      assert.equal(mutated, true);
      assert.equal(result.productionReady, false);
      assert.ok(codes(result).includes("PACKAGE_PUBLICATION_FAILED"));
      assert.equal(existsSync(subtitleFile), true);
      assert.equal(existsSync(path.join(path.dirname(subtitleFile), "release.json")), false);
      assert.equal(JSON.parse(readFileSync(result.report, "utf8")).state, "blocked");
      assert.deepEqual(result.outputs, [result.report]);
    } finally {
      mock.mock.restore();
      syncBuiltinESMExports();
    }
  });
test("a study-only replica renders and checks locally but is never production-ready", (t) => {
  const f = reviews(fixture(t));
  const rights = path.join(f.project, "pipeline/replica-rights.json");
  const answer = (status: string) =>
    writeFileSync(
      rights,
      JSON.stringify({
        schemaVersion: 1,
        status,
        userStatement: "I just want to study it",
        askedAt: new Date().toISOString(),
      }),
    );
  answer("study-only");
  let r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.productionReady, false);
  assert.ok(
    r.blockers.some((b) => b.code === "REPLICA_STUDY_ONLY" && b.message.startsWith("Study only, not for publication")),
    JSON.stringify(r.blockers),
  );
  f.request.mode = "draft";
  r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.ok, true);
  assert.equal(r.productionReady, false);
  delete f.request.mode;
  writeFileSync(rights, "{}");
  assert.ok(
    codes(checkDelivery(f.request, f.snapshot, { rootDir: f.root })).includes("REPLICA_STUDY_ONLY"),
    "an unreadable answer counts as study-only",
  );
  answer("owned");
  assert.equal(checkDelivery(f.request, f.snapshot, { rootDir: f.root }).productionReady, true);
  const requestFile = path.join(f.root, "request.json");
  answer("study-only");
  writeFileSync(requestFile, JSON.stringify(f.request));
  const run = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/delivery.ts"),
      "--request",
      requestFile,
      "--snapshot",
      f.file,
    ],
    { cwd: f.root, encoding: "utf8" },
  );
  const result = JSON.parse(run.stdout);
  assert.equal(result.ok, false);
  assert.equal(result.metadata.productionReady, false);
  assert.equal(result.metadata.publication, "study only, not for publication");
});
test("a partial (render --frames) receipt never passes as a final output", (t) => {
  const f = reviews(fixture(t));
  const receipt = {
    ...f.request.renderBindings![0],
    evidence: "renderer",
    partial: { startFrame: 0, endFrame: 9, totalFrames: 30 },
  };
  writeFileSync(path.join(f.root, "out/demo/landscape.mp4.receipt.json"), JSON.stringify(receipt));
  const r = checkDelivery(f.request, f.snapshot, { rootDir: f.root });
  assert.equal(r.productionReady, false);
  assert.ok(codes(r).includes("PARTIAL_RENDER"), JSON.stringify(codes(r)));
});
