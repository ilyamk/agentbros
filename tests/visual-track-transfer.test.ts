import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { transferFixture, r } from "./helpers/visual-transfer";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { compileTimelineIR, sourceToOutput } from "../src/lib/timeline-ir/compiler";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { startReviewServer } from "../src/lib/review-ui/server";
import { pointerProposal } from "../src/lib/review-ui/pointer";
const command = { type: "transfer", trackId: "visual", clipId: "shot", targetTrackId: "overlay", start: r(9003, 100) };
test("exact rational visual transfer preserves original media/captions/protected tracks and compiled source mapping", () => {
  const original = transferFixture(),
    before = JSON.stringify(original),
    after = applyEdit(original, command);
  assert.equal(JSON.stringify(original), before);
  assert.equal(after.tracks[0].clips.length, 0);
  assert.deepEqual(after.tracks[1].clips[0], { ...original.tracks[0].clips[0], start: command.start });
  assert.equal(JSON.stringify(after.tracks.slice(2)), JSON.stringify(original.tracks.slice(2)));
  const compiled = compileTimelineIR(after),
    clip = compiled.tracks[1].clips[0];
  assert.deepEqual(clip.captions[0].start, sourceToOutput(after.tracks[1].clips[0], r(20), after.timebase));
  assert.deepEqual(clip.source, original.tracks[0].clips[0].source);
  assert.deepEqual(clip.rate, r(3, 2));
  const proposed = pointerProposal({
    mode: "move",
    deltaPx: 0,
    laneWidth: 500,
    durationInFrames: 500,
    timebase: original.timebase,
    trackId: "visual",
    targetTrackId: "overlay",
    clip: compileTimelineIR(original).tracks[0].clips[0],
  });
  assert.deepEqual(proposed, { ...command, start: r(30) });
});
test("transfer retains 30fps and 29.97fps master/source variants at independent rates", () => {
  for (const fps of [r(30), r(30000, 1001)])
    for (const sourceFps of [r(24), r(30000, 1001)])
      for (const rate of [r(1), r(3, 2)]) {
        const ir = transferFixture();
        ir.timebase = fps;
        ir.tracks[0].clips[0].source.timebase = sourceFps;
        ir.tracks[0].clips[0].rate = rate;
        const before = compileTimelineIR(ir).tracks[0].clips[0],
          after = compileTimelineIR(applyEdit(ir, command)).tracks[1].clips[0];
        assert.deepEqual(after.duration, before.duration);
        assert.deepEqual(after.source, before.source);
        assert.deepEqual(after.rate, before.rate);
      }
});
test("transfer rejects same/missing/nonvisual target, collision, overlap, unsafe clocks and attached fades transactionally", () => {
  const original = transferFixture();
  for (const cmd of [
    { ...command, targetTrackId: "visual" },
    { ...command, targetTrackId: "missing" },
    ...original.tracks.slice(2).map((t) => ({ ...command, targetTrackId: t.id })),
    { ...command, start: r(-1) },
    { ...command, start: r(0, 0) },
  ])
    assert.throws(() => applyEdit(original, cmd));
  for (const track of original.tracks.slice(2))
    assert.throws(
      () => applyEdit(original, { ...command, trackId: track.id, clipId: track.clips[0].id }),
      /visual tracks only/,
    );
  for (const kind of ["collision", "overlap"]) {
    const ir = transferFixture();
    ir.tracks[1].clips = [
      {
        ...structuredClone(ir.tracks[0].clips[0]),
        id: kind === "collision" ? "shot" : "occupied",
        start: command.start,
      },
    ];
    assert.throws(() => applyEdit(ir, command), /exists|Overlapping/);
  }
  const ir = transferFixture(),
    shot = ir.tracks[0].clips[0],
    end = compileTimelineIR(ir).tracks[0].clips[0].end;
  ir.tracks[0].clips.push({ ...structuredClone(shot), id: "next", start: end });
  shot.transition = { kind: "fade", duration: r(3) };
  assert.throws(() => applyEdit(ir, command), /attached fade/);
  assert.throws(() => applyEdit(ir, { ...command, clipId: "next" }), /attached fade/);
  assert.equal(original.tracks[0].clips.length, 1);
});
test("authenticated HTTP transfer dry-run/CAS/undo/redo preserve exact journal and protected tracks", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "transfer-http-")),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize(transferFixture());
  const original = readFileSync(store.file),
    app = await startReviewServer({ projectId: "demo", rootDir: root });
  const request = (url: string, body: unknown) =>
    fetch(app.origin + url, {
      method: "POST",
      headers: { "x-review-token": app.token, origin: app.origin, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await request("/api/dry-run", { command, expectedRevision: 0 })).status, 200);
    assert.deepEqual(readFileSync(store.file), original);
    assert.equal((await request("/api/mutate", { action: "edit", command, expectedRevision: 0 })).status, 200);
    const after = store.read();
    assert.equal(after.revision, 1);
    assert.deepEqual(after.timeline, applyEdit(transferFixture(), command));
    assert.equal((await request("/api/mutate", { action: "edit", command, expectedRevision: 0 })).status, 409);
    assert.deepEqual(store.read(), after);
    assert.equal((await request("/api/mutate", { action: "undo", expectedRevision: 1 })).status, 200);
    assert.deepEqual(store.read().timeline, transferFixture());
    assert.equal((await request("/api/mutate", { action: "redo", expectedRevision: 2 })).status, 200);
    assert.deepEqual(store.read().timeline, after.timeline);
  } finally {
    app.server.closeAllConnections();
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production render planner retains transferred visual layer and exact source clock without migrating legacy output", async () => {
  const { planProjectRender } = await import("../src/lib/render-plan");
  const root = mkdtempSync(path.join(tmpdir(), "transfer-plan-")),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const config = {
    name: "Demo",
    productName: "Demo",
    formats: ["landscape"],
    colors: {},
    voiceoverEnabled: false,
    musicVolume: 0,
    scenes: [{ id: "hook", text: "", headline: "Demo", visualType: "title", durationInFrames: 90 }],
  };
  writeFileSync(path.join(project, "project.json"), JSON.stringify(config));
  const timeline = transferFixture();
  for (const track of timeline.tracks)
    for (const clip of track.clips) {
      const extension = ["visual", "presenter"].includes(track.kind) ? "mp4" : "wav";
      clip.assetId = "projects/demo/" + track.id + "." + extension;
      writeFileSync(path.join(root, "public", clip.assetId), "plan-only existing path, not a decoded fixture");
    }
  const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
  store.initialize(timeline);
  try {
    const legacy = planProjectRender("demo", undefined, root);
    store.apply(command, 0);
    const after = store.read().timeline,
      planned = planProjectRender("demo", undefined, root, { timeline: true });
    assert.deepEqual(planned.jobs[0].props.timeline, after);
    assert.deepEqual(after.tracks.slice(2), timeline.tracks.slice(2));
    assert.equal(after.tracks[1].clips[0].assetId, timeline.tracks[0].clips[0].assetId);
    assert.deepEqual(after.tracks[1].clips[0].rate, r(3, 2));
    assert.deepEqual(after.tracks[1].clips[0].source, timeline.tracks[0].clips[0].source);
    assert.deepEqual(planProjectRender("demo", undefined, root).jobs, legacy.jobs);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
