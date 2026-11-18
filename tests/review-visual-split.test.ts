import { planProjectRender } from "../src/lib/render-plan";
import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TimelineIR } from "../src/types/timeline";
import { buildVisualSplitProposal as build } from "../src/lib/review-ui/visual-split";
import { applyEdit, compileTimelineIR, TimelineEditStore } from "../src/lib/timeline-ir";
import { ReviewService } from "../src/lib/review-ui/service";
import { startReviewServer } from "../src/lib/review-ui/server";
import { importAsset } from "../src/lib/assets/registry";
const r = (num: number, den = 1) => ({ num, den });
const image = { kind: "image" as const, fps: 30, talkingHead: false },
  video = { ...image, kind: "video" as const };
const request = { expectedRevision: 0, trackId: "visual", clipId: "left", at: r(30), newClipId: "right" };
function timeline(): TimelineIR {
  const clip = {
    id: "left",
    assetId: "sha256:" + "a".repeat(64),
    start: r(0),
    source: { start: r(7), end: r(97), timebase: r(30) },
    rate: r(1),
    transition: { kind: "cut" as const },
    captions: [],
    payload: { transform: { scale: 1.1 }, original: true },
  };
  return {
    version: 1 as const,
    projectId: "demo",
    timebase: r(30),
    tracks: [
      { id: "visual", kind: "visual" as const, clips: [clip] },
      ...(["presenter", "voiceover", "music", "sfx", "captions"] as const).map((kind) => ({
        id: kind,
        kind,
        clips: [
          {
            ...structuredClone(clip),
            id: kind,
            captions: [{ id: "word", text: "Protected", start: r(15), end: r(30) }],
          },
        ],
      })),
    ],
  };
}
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "visual-split-")),
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
  const file = path.join(project, "image.png");
  execFileSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:size=64x64", "-frames:v", "1", "-threads", "1", file],
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
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize(ir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, store, ir, service: new ReviewService("demo", root) };
}
test("existing split proposal preserves contiguous exact sources/rate/payload/protected tracks and render duration", () => {
  const ir = timeline(),
    before = structuredClone(ir),
    command = build(ir, request, video),
    next = applyEdit(ir, command),
    [left, right] = next.tracks[0].clips;
  assert.deepEqual(command, { type: "split", trackId: "visual", clipId: "left", at: r(30), newClipId: "right" });
  assert.deepEqual(left.source.end, r(37));
  assert.deepEqual(right.source.start, left.source.end);
  assert.deepEqual(right.source.end, ir.tracks[0].clips[0].source.end);
  assert.deepEqual(right.payload, left.payload);
  assert.deepEqual(right.rate, left.rate);
  assert.deepEqual(next.tracks.slice(1), ir.tracks.slice(1));
  assert.equal(compileTimelineIR(next).durationInFrames, 90);
  assert.deepEqual(ir, before);
});
test("actual authored clock conversion admits exact fractional source at rate3/2 and source24 without guessing metadataFPS", () => {
  const ir = timeline();
  const c = ir.tracks[0].clips[0];
  c.source = { start: r(8), end: r(56), timebase: r(24) };
  c.rate = r(3, 2);
  const next = applyEdit(ir, build(ir, { ...request, at: r(16) }, video));
  assert.deepEqual(next.tracks[0].clips[1].source.start, r(136, 5));
  assert.deepEqual(next.tracks[0].clips[1].start, r(16));
  assert.deepEqual(next.tracks[0].clips[1].rate, r(3, 2));
  assert.equal(compileTimelineIR(next).tracks[0].clips.at(-1)!.end.num, 40);
});
test("strict IDs/caller shapes/range/renderphase/protected tracks refuse; images do not invent a video source phase", () => {
  const ir = timeline();
  for (const raw of [
    { ...request, at: r(0) },
    { ...request, at: r(90) },
    { ...request, at: r(30, 2), newClipId: "left" },
    { ...request, at: r(61, 2) },
    { ...request, at: r(Number.MAX_SAFE_INTEGER + 1) },
    { ...request, newClipId: "" },
    { ...request, newClipId: "x".repeat(201) },
    { ...request, clipId: "missing" },
    { ...request, context: video },
    ...ir.tracks.slice(1).map((t) => ({ ...request, trackId: t.id, clipId: t.id })),
  ])
    assert.throws(() => build(ir, raw, video));
  const fractional = timeline();
  fractional.tracks[0].clips[0].source.start = r(15, 2);
  assert.throws(() => build(fractional, request, video), /source phase/);
  assert.doesNotThrow(() => build(fractional, request, image));
  const rate = timeline();
  rate.tracks[0].clips[0].rate = r(3, 2);
  assert.throws(() => build(rate, { ...request, at: r(31) }, video), /source phase/);
  assert.doesNotThrow(() => build(rate, request, video));
  const approximate = timeline();
  approximate.tracks[0].clips[0].rate = r(1, 3);
  assert.throws(() => build(approximate, { ...request, at: r(3) }, video), /exactly representable/);
  const start = timeline();
  start.tracks[0].clips[0].start = r(1, 2);
  assert.throws(() => build(start, request, image), /output-frame/);
  assert.throws(() => build(ir, request, { ...video, talkingHead: true }), /talking-head/);
});
test("selected captions/attached fades/authored overlays refuse without changing legacy generic split behavior", () => {
  const captions = timeline();
  captions.tracks[0].clips[0].captions.push({ id: "word", text: "Word", start: r(20), end: r(40) });
  assert.throws(() => build(captions, request, video), /caption-bearing/);
  assert.doesNotThrow(() =>
    applyEdit(captions, { type: "split", trackId: "visual", clipId: "left", at: r(30), newClipId: "right" }),
  );
  const scene = timeline();
  scene.tracks[0].clips[0].payload!.scene = { visualType: "video", headline: "Animated" };
  assert.throws(() => build(scene, request, video), /authored overlays/);
  const fade = timeline();
  const selected = fade.tracks[0].clips[0];
  selected.transition = { kind: "fade", duration: r(9) };
  fade.tracks[0].clips.push({ ...structuredClone(selected), id: "next", start: r(90), transition: { kind: "cut" } });
  assert.throws(() => build(fade, request, video), /attached/);
  assert.doesNotThrow(() =>
    applyEdit(fade, { type: "split", trackId: "visual", clipId: "left", at: r(30), newClipId: "right" }),
  );
  const incoming = structuredClone(fade);
  incoming.tracks[0].clips[1].id = "target";
  assert.throws(() => build(incoming, { ...request, clipId: "target", at: r(120) }, video), /attached/);
});
test("server proposal resolves bounded trusted kind/config, requires import and refuses talking-head, readonly journal on failures", (t) => {
  const f = fixture(t),
    before = readFileSync(f.store.file),
    proposal = f.service.visualSplitProposal(request);
  assert.equal(proposal.snapshot.durationInFrames, 90);
  assert.deepEqual(readFileSync(f.store.file), before);
  for (const raw of [
    { ...request, expectedRevision: 1 },
    { ...request, assetId: "supplied" },
    { ...request, trackId: "voiceover", clipId: "voiceover" },
  ]) {
    assert.throws(() => f.service.visualSplitProposal(raw));
    assert.deepEqual(readFileSync(f.store.file), before);
  }
  const configFile = path.join(f.project, "project.json"),
    config = JSON.parse(readFileSync(configFile, "utf8"));
  config.talkingHead = { enabled: true, presenterVideo: "projects/demo/presenter.mp4" };
  writeFileSync(configFile, JSON.stringify(config));
  assert.throws(() => f.service.visualSplitProposal(request), /talking-head/);
  assert.deepEqual(readFileSync(f.store.file), before);
});
test("authenticated readonly HTTP split, parallel CAS single commit and one Undo preserve originals/protected tracks", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const before = readFileSync(f.store.file),
    source = readFileSync(path.join(f.project, "image.png")),
    headers = { origin: app.origin, "x-review-token": app.token, "content-type": "application/json" },
    post = (route: string, body: unknown, h = headers) =>
      fetch(app.origin + route, { method: "POST", headers: h, body: JSON.stringify(body) });
  for (const h of [
    { ...headers, origin: "http://foreign.invalid" },
    { ...headers, "x-review-token": "" },
  ])
    assert.equal((await post("/api/visual-split-proposal", request, h)).status, 403);
  assert.equal((await post("/api/visual-split-proposal", { ...request, expectedRevision: 1 })).status, 409);
  assert.equal((await post("/api/visual-split-proposal", { ...request, newClipId: "left" })).status, 400);
  assert.deepEqual(readFileSync(f.store.file), before);
  const response = await post("/api/visual-split-proposal", request);
  assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.deepEqual(readFileSync(f.store.file), before);
  const results = await Promise.all([
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command }),
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.store.read().undo.length, 1);
  assert.deepEqual(f.store.read().timeline.tracks.slice(1), f.ir.tracks.slice(1));
  assert.equal((await post("/api/visual-split-proposal", request)).status, 409);
  assert.equal((await post("/api/mutate", { action: "undo", expectedRevision: 1 })).status, 200);
  assert.deepEqual(f.store.read().timeline, f.ir);
  assert.deepEqual(readFileSync(path.join(f.project, "image.png")), source);
});

test("prepare checks original pins, while unchanged generic Apply uses timeline CAS and render rejects later-corrupt original", (t) => {
  const f = fixture(t),
    proposal = f.service.visualSplitProposal(request),
    registry = JSON.parse(readFileSync(path.join(f.project, "pipeline/asset-registry.json"), "utf8")),
    asset = registry.assets.find((a: any) => a.id === f.ir.tracks[0].clips[0].assetId),
    file = path.resolve(f.root, "public", asset.files.original),
    before = readFileSync(f.store.file);
  const bytes = readFileSync(file);
  bytes[45] ^= 1;
  writeFileSync(file, bytes);
  assert.throws(() => f.service.visualSplitProposal(request), /checksum mismatch/);
  assert.deepEqual(readFileSync(f.store.file), before);
  f.store.apply(proposal.command, 0);
  assert.equal(f.store.read().revision, 1);
  assert.throws(() => planProjectRender("demo", "square", f.root, { timeline: true }), /checksum mismatch/);
});
