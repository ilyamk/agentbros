import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import type { TimelineIR } from "../src/types/timeline";
import { buildVisualSlipProposal as build } from "../src/lib/review-ui/visual-slip";
import { inspectSlipOriginal } from "../src/lib/review-ui/slip-original";
import { TimelineEditStore, applyEdit, compileTimelineIR } from "../src/lib/timeline-ir";
import { importAsset } from "../src/lib/assets/registry";
import { ReviewService } from "../src/lib/review-ui/service";
import { startReviewServer } from "../src/lib/review-ui/server";
import { hashFile } from "../src/lib/assets/registry";
import { planProjectRender } from "../src/lib/render-plan";
const r = (num: number, den = 1) => ({ num, den }),
  request = { expectedRevision: 0, trackId: "visual", clipId: "insert", delta: r(15) },
  context = { fps: 30, talkingHead: false, physicalRate: r(30), physicalDuration: r(3) };
function timeline(): TimelineIR {
  const c = {
    payload: { originalHash: "a".repeat(64) },
    id: "insert",
    assetId: "sha256:" + "a".repeat(64),
    start: r(15),
    source: { start: r(15), end: r(45), timebase: r(30) },
    rate: r(1),
    transition: { kind: "cut" as const },
    captions: [],
  };
  return {
    version: 1,
    projectId: "demo",
    timebase: r(30),
    tracks: [
      { id: "visual", kind: "visual", clips: [c] },
      ...(["presenter", "voiceover", "music", "sfx", "captions"] as const).map((kind) => ({
        id: kind,
        kind,
        clips: [
          {
            ...structuredClone(c),
            id: kind,
            source: { ...c.source, start: r(0), end: r(90) },
            start: r(0),
            captions: [{ id: "keep", text: "Protected speech", start: r(3), end: r(30) }],
          },
        ],
      })),
    ],
  };
}
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "visual-slip-"))),
    project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, "project.json"),
    JSON.stringify({
      name: "demo",
      productName: "demo",
      formats: ["square"],
      colors: {},
      voiceoverEnabled: false,
      scenes: [{ id: "hook", text: "", headline: "", visualType: "title", durationInFrames: 90 }],
    }),
  );
  const file = path.join(project, "video.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=30:duration=3",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      file,
    ],
    { timeout: 10000 },
  );
  const asset = importAsset({
    rootDir: root,
    projectId: "demo",
    sourceFile: file,
    rights: { licence: "synthetic-test" },
    provenance: { origin: "manual" },
  }).asset;
  const ir = timeline();
  ir.tracks[0].clips[0].assetId = asset.id;
  ir.tracks[0].clips[0].payload!.originalHash = asset.hash;
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize(ir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, file, asset, ir, store, service: new ReviewService("demo", root) };
}
test("positive and negative exact slips preserve output, metadata and all protected tracks using existing same-asset replace", () => {
  for (const delta of [r(15), r(-15)]) {
    const ir = timeline(),
      before = structuredClone(ir),
      cmd = build(ir, { ...request, delta }, context),
      next = applyEdit(ir, cmd);
    assert.equal(cmd.type, "replace");
    assert.deepEqual(next.tracks.slice(1), ir.tracks.slice(1));
    assert.deepEqual(next.tracks[0].clips[0], {
      ...ir.tracks[0].clips[0],
      source: { ...ir.tracks[0].clips[0].source, start: r(15 + delta.num), end: r(45 + delta.num) },
    });
    assert.equal(compileTimelineIR(next).durationInFrames, 90);
    assert.deepEqual(ir, before);
  }
});
test("exact authored source24/rate3/2 accepts signed rational delta without approximating renderer source phase", () => {
  const ir = timeline(),
    c = ir.tracks[0].clips[0];
  c.start = r(0);
  c.source = { start: r(8), end: r(32), timebase: r(24) };
  c.rate = r(3, 2);
  const cmd = build(ir, { ...request, delta: r(4, 5) }, context),
    next = applyEdit(ir, cmd);
  assert.deepEqual(next.tracks[0].clips[0].source.start, r(44, 5));
  assert.deepEqual(next.tracks[0].clips[0].source.end, r(164, 5));
});
test("strict requests reject zero/overflow/unknown fields/nonvisual/missing/source bounds/render ambiguity without mutation", () => {
  const ir = timeline(),
    before = structuredClone(ir);
  for (const raw of [
    { ...request, delta: r(0) },
    { ...request, delta: r(-16) },
    { ...request, delta: r(60) },
    { ...request, delta: r(1, 2) },
    { ...request, delta: r(Number.MAX_SAFE_INTEGER + 1) },
    { ...request, delta: r(1, 0) },
    { ...request, clipId: "absent" },
    { ...request, physicalDuration: r(9) },
    ...ir.tracks.slice(1).map((t) => ({ ...request, trackId: t.id, clipId: t.id })),
  ])
    assert.throws(() => build(ir, raw, context));
  assert.deepEqual(ir, before);
  const c = ir.tracks[0].clips[0];
  c.rate = r(1, 3);
  assert.throws(() => build(ir, request, context), /representable/);
});
test("selected captions, payload animation/loop, incoming/outgoing fades and talking-head refuse", () => {
  for (const edit of [
    (ir: TimelineIR) => ir.tracks[0].clips[0].captions.push({ id: "x", text: "x", start: r(20), end: r(25) }),
    (ir: TimelineIR) => {
      ir.tracks[0].clips[0].payload = { loop: true };
    },
    (ir: TimelineIR) => {
      const c = ir.tracks[0].clips[0];
      c.transition = { kind: "fade", duration: r(3) };
      ir.tracks[0].clips.push({ ...structuredClone(c), id: "after", start: r(45), transition: { kind: "cut" } });
    },
    (ir: TimelineIR) => {
      ir.tracks[0].clips.unshift({
        ...structuredClone(ir.tracks[0].clips[0]),
        id: "before",
        start: r(0),
        source: { start: r(0), end: r(15), timebase: r(30) },
        transition: { kind: "fade", duration: r(3) },
      });
    },
  ]) {
    const ir = timeline();
    edit(ir);
    assert.throws(() => build(ir, request, context));
  }
  assert.throws(() => build(timeline(), request, { ...context, talkingHead: true }), /talking-head/);
});
test("bounded decoded physical proof measures CFR origin/count, rejects hash/aliases/FIFO and actual VFR", (t) => {
  const f = fixture(t),
    file = path.resolve(f.root, "public", f.asset.files.original);
  assert.deepEqual(inspectSlipOriginal(file, f.asset.hash), {
    physicalRate: r(30),
    physicalDuration: r(3),
    decodedFrames: 90,
  });
  assert.throws(() => inspectSlipOriginal(file, "f".repeat(64)), /checksum/);
  const alias = path.join(f.project, "alias.mp4");
  symlinkSync(file, alias);
  assert.throws(() => inspectSlipOriginal(alias, f.asset.hash), /symlink/);
  const fifo = path.join(f.project, "fifo");
  execFileSync("mkfifo", [fifo]);
  assert.throws(() => inspectSlipOriginal(fifo, f.asset.hash), /regular/);
  const vfr = path.join(f.project, "vfr.mp4");
  execFileSync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=64x64:rate=30:duration=1",
      "-vf",
      "select=not(eq(n\\,5))",
      "-fps_mode",
      "vfr",
      "-c:v",
      "libx264",
      "-threads",
      "1",
      vfr,
    ],
    { timeout: 10000 },
  );
  assert.throws(() => inspectSlipOriginal(vfr, hashFile(vfr)), /CFR/);
});
test("service readonly preparation pins classification/original, Apply one history and Undo restore metadata/source", (t) => {
  const f = fixture(t),
    before = readFileSync(f.store.file),
    sha = hashFile(f.file),
    proposal = f.service.visualSlipProposal(request);
  assert.deepEqual(readFileSync(f.store.file), before);
  f.service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command });
  assert.equal(f.store.read().undo.length, 1);
  assert.deepEqual(f.store.read().timeline.tracks.slice(1), f.ir.tracks.slice(1));
  f.service.mutate({ action: "undo", expectedRevision: 1 });
  assert.deepEqual(f.store.read().timeline, f.ir);
  assert.equal(hashFile(f.file), sha);
});
test("authenticated HTTP readonly proposal rejects callers/stale CAS; concurrent Apply commits once and no denied writes", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const before = readFileSync(f.store.file),
    headers = { origin: app.origin, "x-review-token": app.token, "content-type": "application/json" },
    post = (route: string, body: unknown, h = headers) =>
      fetch(app.origin + route, { method: "POST", headers: h, body: JSON.stringify(body) });
  for (const h of [
    { ...headers, origin: "http://wrong.invalid" },
    { ...headers, "x-review-token": "" },
  ])
    assert.equal((await post("/api/visual-slip-proposal", request, h)).status, 403);
  assert.equal((await post("/api/visual-slip-proposal", { ...request, expectedRevision: 1 })).status, 409);
  assert.equal((await post("/api/visual-slip-proposal", { ...request, assetId: "x" })).status, 400);
  assert.deepEqual(readFileSync(f.store.file), before);
  const response = await post("/api/visual-slip-proposal", request);
  assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.deepEqual(readFileSync(f.store.file), before);
  const responses = await Promise.all([
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command }),
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command }),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await post("/api/visual-slip-proposal", request)).status, 409);
});
test("preparation detects changed originals; generic Apply still CAS-only and later render rejects corruption", (t) => {
  const f = fixture(t),
    proposal = f.service.visualSlipProposal(request),
    file = path.resolve(f.root, "public", f.asset.files.original),
    bytes = readFileSync(file);
  bytes[60] ^= 1;
  writeFileSync(file, bytes);
  assert.throws(() => f.service.visualSlipProposal(request), /checksum/);
  assert.equal(f.store.read().revision, 0);
  f.store.apply(proposal.command, 0);
  assert.equal(f.store.read().revision, 1);
  assert.throws(() => planProjectRender("demo", "square", f.root, { timeline: true }), /checksum/);
});

test("already out-of-physical old source cannot be rescued by slip; readonly journal FIFO is refused without blocking", (t) => {
  const ir = timeline();
  ir.tracks[0].clips[0].source = { start: r(75), end: r(105), timebase: r(30) };
  assert.throws(() => build(ir, { ...request, delta: r(-30) }, context), /physical/);
  const f = fixture(t);
  unlinkSync(f.store.file);
  execFileSync("mkfifo", [f.store.file]);
  assert.throws(() => f.service.visualSlipProposal(request), /regular/);
});
