import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import childProcess from "node:child_process";
import { EditCommandSchema } from "../src/types/timeline";
import { applyEdit, compileTimelineIR } from "../src/lib/timeline-ir";
import { visualObjectPosition } from "../src/lib/timeline-ir/reframe";
import { ReviewService } from "../src/lib/review-ui/service";
import { startReviewServer } from "../src/lib/review-ui/server";
import { reframeFixture } from "./helpers/review-format-reframe";
const command = {
  type: "reframe-visual",
  trackId: "visual",
  clipId: "hook",
  format: "vertical",
  position: { x: 0, y: 1 },
};
const input = (f: ReturnType<typeof reframeFixture>) => ({
  expectedRevision: 0,
  ...command,
  trackId: f.ir.tracks[0].id,
  clipId: f.ir.tracks[0].clips[0].id,
  type: undefined,
});
const request = (f: ReturnType<typeof reframeFixture>) => {
  const { type: _type, ...raw } = input(f);
  return raw;
};
function fixture(t: test.TestContext, video = false) {
  const f = reframeFixture(video);
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  return { ...f, service: new ReviewService("demo", f.root) };
}
test("strict typed command bounds coordinates formats null reset and rejects unknown nested metadata", (t) => {
  const f = fixture(t),
    cmd = { ...command, trackId: f.ir.tracks[0].id, clipId: f.ir.tracks[0].clips[0].id };
  assert.deepEqual(EditCommandSchema.parse(cmd), cmd);
  for (const raw of [
    { ...cmd, format: "portrait" },
    { ...cmd, extra: true },
    { ...cmd, position: { x: -0.01, y: 1 } },
    { ...cmd, position: { x: 0, y: 1.01 } },
    { ...cmd, position: { x: NaN, y: 0 } },
    { ...cmd, position: { x: Infinity, y: 0 } },
    { ...cmd, position: { x: 0, y: 0, zoom: 2 } },
  ])
    assert.throws(() => applyEdit(f.ir, raw));
  const ir = structuredClone(f.ir);
  ir.tracks[0].clips[0].payload!.reframe = { vertical: { x: 0, y: 1, zoom: 2 } };
  assert.throws(() => compileTimelineIR(ir), /reframe/);
});
test("per-format cover position changes only typed payload and reset leaves other formats source and protected tracks exact", (t) => {
  const f = fixture(t);
  f.ir.extension = { keep: "project" };
  f.ir.tracks[0].clips[0].extension = { keep: "clip" };
  for (const kind of ["presenter", "voiceover", "music", "sfx", "captions"] as const)
    f.ir.tracks.push({
      id: "protected-" + kind,
      kind,
      clips: [
        {
          ...structuredClone(f.ir.tracks[0].clips[0]),
          id: kind,
          captions: [
            { id: "protected-word", text: "Keep meaning", start: { num: 1, den: 1 }, end: { num: 20, den: 1 } },
          ],
          payload: { owner: kind, gain: 0.4 },
        },
      ],
    });
  const before = structuredClone(f.ir),
    cmd = { ...command, trackId: f.ir.tracks[0].id, clipId: f.ir.tracks[0].clips[0].id };
  assert.equal(visualObjectPosition(undefined, "vertical"), undefined);
  assert.equal(visualObjectPosition({ transform: { scale: 2 } }, "landscape"), undefined);
  let next = applyEdit(f.ir, cmd);
  const expected = structuredClone(before);
  expected.tracks[0].clips[0].payload!.reframe = { vertical: { x: 0, y: 1 } };
  assert.deepEqual(next, expected);
  assert.deepEqual(f.ir, before);
  assert.equal(visualObjectPosition(next.tracks[0].clips[0].payload, "vertical"), "0% 100%");
  assert.equal(visualObjectPosition(next.tracks[0].clips[0].payload, "square"), undefined);
  next = applyEdit(next, { ...cmd, format: "square", position: { x: 0.25, y: 0.75 } });
  next = applyEdit(next, { ...cmd, position: null });
  assert.equal(visualObjectPosition(next.tracks[0].clips[0].payload, "vertical"), undefined);
  assert.equal(visualObjectPosition(next.tracks[0].clips[0].payload, "square"), "25% 75%");
  assert.deepEqual(compileTimelineIR(next).duration, compileTimelineIR(before).duration);
  next = applyEdit(next, { ...cmd, format: "square", position: null });
  assert.deepEqual(next, before);
});
test("pure ownership refuses authored transform caption presenter virtual and attached fades", (t) => {
  const f = fixture(t),
    cmd = { ...command, trackId: f.ir.tracks[0].id, clipId: f.ir.tracks[0].clips[0].id };
  for (const mutation of [
    (v: typeof f.ir) => (v.tracks[0].kind = "presenter"),
    (v: typeof f.ir) => (v.tracks[0].clips[0].assetId = "scene:virtual"),
    (v: typeof f.ir) => (v.tracks[0].clips[0].payload!.transform = { scale: 1 }),
    (v: typeof f.ir) => (v.tracks[0].clips[0].payload!.scene = { headline: "owned" }),
    (v: typeof f.ir) =>
      v.tracks[0].clips[0].captions.push({
        id: "word",
        text: "protected",
        start: { num: 0, den: 1 },
        end: { num: 1, den: 1 },
      }),
    (v: typeof f.ir) => (v.legacyProject = { talkingHead: { enabled: true } }),
    (v: typeof f.ir) => (v.tracks[0].clips[0].transition = { kind: "fade", duration: { num: 3, den: 1 } }),
  ]) {
    const ir = structuredClone(f.ir);
    mutation(ir);
    const before = structuredClone(ir);
    assert.throws(() => applyEdit(ir, cmd));
    assert.deepEqual(ir, before);
  }
});
test("readonly static original proposal then CAS Apply one Undo preserves journal metadata files and exact duration", (t) => {
  const f = fixture(t),
    before = f.store.read(),
    bytes = fs.readFileSync(f.store.file),
    original = fs.readFileSync(f.file),
    proposal = f.service.visualReframeProposal(request(f));
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  assert.deepEqual(fs.readFileSync(f.file), original);
  assert.equal(proposal.originalSha256, f.asset.hash);
  f.service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command });
  assert.equal(f.store.read().undo.length, 1);
  assert.throws(() => f.service.visualReframeProposal(request(f)), /revision conflict/);
  f.service.mutate({ action: "undo", expectedRevision: 1 });
  assert.deepEqual(f.store.read().timeline, before.timeline);
  assert.deepEqual(fs.readFileSync(f.file), original);
});
test("unknown/spoofed fields missing originals aliases checksum metadata/config and invalid revisions refuse", (t) => {
  const f = fixture(t),
    raw = request(f),
    bytes = fs.readFileSync(f.store.file);
  for (const bad of [
    { ...raw, kind: "image" },
    { ...raw, physicalRate: { num: 30, den: 1 } },
    { ...raw, expectedRevision: 1 },
    { ...raw, format: "invalid" },
    { ...raw, clipId: "missing" },
  ])
    assert.throws(() => f.service.visualReframeProposal(bad));
  const registry = JSON.parse(fs.readFileSync(f.registryFile, "utf8"));
  registry.assets[0].kind = "audio";
  registry.assets[0].media.durationSec = 3;
  fs.writeFileSync(f.registryFile, JSON.stringify(registry));
  assert.throws(() => f.service.visualReframeProposal(raw), /registered imported/);
  registry.assets[0] = f.asset;
  fs.writeFileSync(f.registryFile, JSON.stringify(registry));
  const configFile = path.join(f.project, "project.json"),
    config = JSON.parse(fs.readFileSync(configFile, "utf8"));
  config.formats = ["square"];
  fs.writeFileSync(configFile, JSON.stringify(config));
  assert.throws(() => f.service.visualReframeProposal(raw), /not configured/);
  config.formats = ["vertical", "square", "landscape"];
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(f.file, "wrong bytes");
  assert.throws(() => f.service.visualReframeProposal(raw), /checksum/);
  const target = f.file + ".original";
  fs.renameSync(f.file, target);
  fs.symlinkSync(target, f.file);
  assert.throws(() => f.service.visualReframeProposal(raw), /symlink/);
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
});
test("post-classification late original registry config and journal mutation refuse without writes", (t) => {
  for (const kind of ["original", "registry", "config", "journal"]) {
    const f = fixture(t),
      originalOpen = fs.openSync;
    let triggered = false,
      reads = 0;
    fs.openSync = ((...args: Parameters<typeof fs.openSync>) => {
      const fd = originalOpen(...args);
      if (
        String(args[0]) ===
          (kind === "registry"
            ? f.registryFile
            : kind === "config"
              ? path.join(f.project, "project.json")
              : f.store.file) &&
        ++reads === 2
      ) {
        triggered = true;
        if (kind === "original") fs.writeFileSync(f.file, "late changed source");
        else if (kind === "registry") fs.writeFileSync(f.registryFile, "{}");
        else if (kind === "config") fs.writeFileSync(path.join(f.project, "project.json"), "{}");
        else {
          const doc = f.store.read();
          doc.revision++;
          fs.writeFileSync(f.store.file, JSON.stringify(doc));
        }
      }
      return fd;
    }) as typeof fs.openSync;
    syncBuiltinESMExports();
    try {
      assert.throws(() => f.service.visualReframeProposal(request(f)));
      assert.equal(triggered, true);
    } finally {
      fs.openSync = originalOpen;
      syncBuiltinESMExports();
    }
  }
});
test("physical video proof is private and mocked CPU CFR accepted VFR and duration spoof refused", (t) => {
  const f = fixture(t, true),
    originalExec = childProcess.execFileSync;
  let vfr = false,
    short = false,
    calls = 0;
  childProcess.execFileSync = ((_file: unknown, args: string[]) => {
    calls++;
    return JSON.stringify(
      args.includes("-show_frames")
        ? {
            frames: Array.from({ length: short ? 30 : 90 }, (_, i) => ({
              best_effort_timestamp: i + (vfr && i === 1 ? 1 : 0),
              duration: 1,
            })),
          }
        : {
            streams: [
              {
                codec_type: "video",
                codec_name: "h264",
                r_frame_rate: "30/1",
                avg_frame_rate: "30/1",
                time_base: "1/30",
                width: 12,
                height: 8,
              },
            ],
          },
    );
  }) as typeof childProcess.execFileSync;
  syncBuiltinESMExports();
  try {
    assert.equal(f.service.visualReframeProposal(request(f)).originalSha256, f.asset.hash);
    assert.equal(calls, 2);
    const doc = f.store.read(),
      clip = doc.timeline.tracks[0].clips[0];
    clip.source.end = { num: 30, den: 1 };
    clip.payload!.reframe = { vertical: { x: 0, y: 1 } };
    fs.writeFileSync(f.store.file, JSON.stringify(doc));
    const binding = { trackId: doc.timeline.tracks[0].id, clipId: clip.id },
      slip = f.service.visualSlipProposal({ expectedRevision: 0, ...binding, delta: { num: 1, den: 1 } });
    assert.deepEqual(applyEdit(doc.timeline, slip.command).tracks[0].clips[0].payload!.reframe, clip.payload!.reframe);
    assert.equal(f.store.read().revision, 0);
    clip.source.end = { num: 90, den: 1 };
    fs.writeFileSync(f.store.file, JSON.stringify(doc));
    vfr = true;
    assert.throws(() => f.service.visualReframeProposal(request(f)), /CFR/);
    vfr = false;
    short = true;
    assert.throws(() => f.service.visualReframeProposal(request(f)), /physical original duration/);
  } finally {
    childProcess.execFileSync = originalExec;
    syncBuiltinESMExports();
  }
});
test("readonly authenticated HTTP preparation then parallel Apply CAS commits once Undo exactly restores", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const headers = { origin: app.origin, "x-review-token": app.token, "content-type": "application/json" },
    post = (url: string, body: unknown, h = headers) =>
      fetch(app.origin + url, { method: "POST", headers: h, body: JSON.stringify(body) }),
    bytes = fs.readFileSync(f.store.file);
  assert.equal(
    (await post("/api/visual-reframe-proposal", request(f), { ...headers, origin: "http://bad.invalid" })).status,
    403,
  );
  assert.equal((await post("/api/visual-reframe-proposal", { ...request(f), kind: "image" })).status, 400);
  const response = await post("/api/visual-reframe-proposal", request(f));
  assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.deepEqual(fs.readFileSync(f.store.file), bytes);
  const statuses = await Promise.all(
    [1, 2].map(() =>
      post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command }).then((r) => r.status),
    ),
  );
  assert.deepEqual(statuses.sort(), [200, 409]);
  assert.equal(f.store.read().undo.length, 1);
  await post("/api/mutate", { action: "undo", expectedRevision: 1 });
  assert.deepEqual(f.store.read().timeline, f.ir);
});

import { buildVisualGroupMove } from "../src/lib/review-ui/group-move";
import { buildVisualSlipProposal } from "../src/lib/review-ui/visual-slip";
import { buildVisualSplitProposal } from "../src/lib/review-ui/visual-split";
test("strict static maps compose with Slip Split group move and readonly Remove/Split preparations without widening authored payload", (t) => {
  const f = fixture(t),
    track = f.ir.tracks[0],
    clip = track.clips[0];
  clip.source.end = { num: 30, den: 1 };
  clip.payload!.reframe = { vertical: { x: 0, y: 1 }, square: { x: 0.25, y: 0.75 } };
  track.clips.push({ ...structuredClone(clip), id: "second", start: { num: 30, den: 1 } });
  f.ir.tracks.push({
    id: "anchor",
    kind: "visual",
    clips: [
      {
        ...structuredClone(clip),
        id: "anchor",
        source: { ...clip.source, end: { num: 90, den: 1 } },
        payload: { originalHash: f.asset.hash },
      },
    ],
  });
  fs.writeFileSync(f.store.file, JSON.stringify({ ...f.store.read(), timeline: f.ir }));
  const binding = { trackId: track.id, clipId: clip.id },
    map = structuredClone(clip.payload!.reframe);
  const slip = buildVisualSlipProposal(
    f.ir,
    { expectedRevision: 0, ...binding, delta: { num: 1, den: 1 } },
    { fps: 30, talkingHead: false, physicalRate: { num: 30, den: 1 }, physicalDuration: { num: 3, den: 1 } },
  );
  assert.deepEqual(applyEdit(f.ir, slip).tracks[0].clips[0].payload!.reframe, map);
  const split = f.service.visualSplitProposal({
    expectedRevision: 0,
    ...binding,
    at: { num: 15, den: 1 },
    newClipId: "right",
  });
  assert.equal(f.store.read().revision, 0);
  for (const c of applyEdit(f.ir, split.command).tracks[0].clips.filter((c) => [clip.id, "right"].includes(c.id)))
    assert.deepEqual(c.payload!.reframe, map);
  const remove = f.service.visualRemoveProposal({ expectedRevision: 0, ...binding });
  assert.equal(f.store.read().revision, 0);
  assert.deepEqual(applyEdit(f.ir, remove.command).tracks[0].clips[0].payload!.reframe, map);
  const grouped = buildVisualGroupMove(f.ir, {
    expectedRevision: 0,
    members: [binding, { trackId: track.id, clipId: "second" }],
    delta: { num: 1, den: 1 },
  });
  for (const c of applyEdit(f.ir, grouped).tracks[0].clips) assert.deepEqual(c.payload!.reframe, map);
  const authored = structuredClone(f.ir);
  authored.tracks[0].clips[0].payload!.transform = { scale: 1 };
  assert.throws(
    () =>
      buildVisualSplitProposal(
        authored,
        { expectedRevision: 0, ...binding, at: { num: 15, den: 1 }, newClipId: "right" },
        { kind: "image", fps: 30, talkingHead: false },
      ),
    /plain/,
  );
  assert.throws(
    () =>
      buildVisualSlipProposal(
        authored,
        { expectedRevision: 0, ...binding, delta: { num: 1, den: 1 } },
        { fps: 30, talkingHead: false, physicalRate: { num: 30, den: 1 }, physicalDuration: { num: 3, den: 1 } },
      ),
    /plain/,
  );
  delete authored.tracks[0].clips[0].payload!.reframe;
  assert.doesNotThrow(
    () =>
      buildVisualSplitProposal(
        authored,
        { expectedRevision: 0, ...binding, at: { num: 15, den: 1 }, newClipId: "right" },
        { kind: "image", fps: 30, talkingHead: false },
      ),
    "legacy split transform behavior unchanged when no new reframe exists",
  );
});
test("bounded metadata oversize FIFO and ancestor aliases cannot masquerade as valid preparation evidence", (t) => {
  const f = fixture(t),
    config = path.join(f.project, "project.json"),
    bytes = fs.readFileSync(config);
  fs.truncateSync(config, 2 * 1024 * 1024);
  assert.throws(() => f.service.visualReframeProposal(request(f)), /size/);
  fs.writeFileSync(config, bytes);
  fs.unlinkSync(config);
  childProcess.execFileSync("mkfifo", [config]);
  assert.throws(() => f.service.visualReframeProposal(request(f)), /regular/);
  fs.unlinkSync(config);
  fs.writeFileSync(config, bytes);
  const directory = path.dirname(f.file),
    target = directory + "-real";
  fs.renameSync(directory, target);
  fs.symlinkSync(target, directory);
  assert.throws(() => f.service.visualReframeProposal(request(f)), /symlink/);
});

import { planProjectRender } from "../src/lib/render-plan";
test("default render-plan carries strict map and refuses changed original after generic CAS Apply", (t) => {
  const f = fixture(t),
    proposal = f.service.visualReframeProposal(request(f)),
    original = fs.readFileSync(f.file);
  f.service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command });
  const job = planProjectRender("demo", "vertical", f.root, { timeline: true }).jobs[0];
  assert.deepEqual(job.props.timeline!.tracks[0].clips[0].payload!.reframe, { vertical: { x: 0, y: 1 } });
  f.service.mutate({ action: "undo", expectedRevision: 1 });
  const current = f.service.visualReframeProposal({ ...request(f), expectedRevision: 2 });
  fs.writeFileSync(f.file, "changed after Prepare");
  f.service.mutate({ action: "edit", expectedRevision: 2, command: current.command });
  assert.equal(f.store.read().revision, 3, "generic Apply remains timeline CAS, not an original-file transaction");
  assert.throws(() => planProjectRender("demo", "vertical", f.root, { timeline: true }), /checksum/);
  fs.writeFileSync(f.file, original);
});
