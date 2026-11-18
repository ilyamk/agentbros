import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, realpathSync, unlinkSync, symlinkSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { EditCommandSchema, type TimelineIR } from "../src/types/timeline";
import { applyEdit, compileTimelineIR, parseTimelineEditDocument } from "../src/lib/timeline-ir";
import { buildVisualRemoveProposal as build } from "../src/lib/review-ui/visual-remove";
import { ReviewService } from "../src/lib/review-ui/service";
import { startReviewServer } from "../src/lib/review-ui/server";
import { splitProject, r } from "./helpers/review-visual-split";
import { hashFile } from "../src/lib/assets/registry";
const request = { expectedRevision: 0, trackId: "cutaways", clipId: "cutaway" },
  command = { type: "remove-visual", trackId: "cutaways", clipId: "cutaway" };
function fixture(t: test.TestContext, video = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "visual-remove-"))),
    f = splitProject(root, video);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { ...f, root, service: new ReviewService("demo", root) };
}
function ir(): TimelineIR {
  const c = {
    id: "cutaway",
    assetId: "sha256:" + "a".repeat(64),
    start: r(15),
    source: { start: r(7), end: r(37), timebase: r(30) },
    rate: r(1),
    transition: { kind: "cut" as const },
    captions: [],
    payload: { originalHash: "a".repeat(64) },
    extension: "keep",
  };
  return {
    version: 1,
    projectId: "demo",
    timebase: r(30),
    tracks: [
      { id: "cutaways", kind: "visual", clips: [c, { ...structuredClone(c), id: "after", start: r(60) }] },
      ...(["presenter", "voiceover", "music", "sfx", "captions"] as const).map((kind) => ({
        id: kind,
        kind,
        clips: [
          {
            ...structuredClone(c),
            id: kind,
            start: r(0),
            source: { ...c.source, start: r(0), end: r(120) },
            captions: [{ id: "protected", text: "Keep meaning", start: r(5), end: r(30) }],
          },
        ],
      })),
    ],
    custom: "keep",
  };
}
test("additive strict remove leaves gap, exact remaining clips/tracks/extensions and original input unchanged", () => {
  const input = ir(),
    before = structuredClone(input),
    cmd = build(input, request, { talkingHead: false }),
    next = applyEdit(input, cmd);
  assert.deepEqual(cmd, command);
  assert.deepEqual(next, {
    ...before,
    tracks: [{ ...before.tracks[0], clips: before.tracks[0].clips.slice(1) }, ...before.tracks.slice(1)],
  });
  assert.deepEqual(input, before);
  assert.deepEqual(compileTimelineIR(next).duration, compileTimelineIR(before).duration);
  assert.deepEqual(EditCommandSchema.parse(command), command);
  for (const raw of [
    { ...command, kind: "visual" },
    { ...command, clipId: "" },
    { ...command, trackId: "x".repeat(201) },
    { type: "remove", trackId: "cutaways", clipId: "cutaway" },
  ])
    assert.throws(() => EditCommandSchema.parse(raw));
});
test("missing/nonvisual/duplicate IDs/captions/payload/virtual/talkinghead/fades refuse without mutation", () => {
  const input = ir();
  for (const raw of [
    { ...command, clipId: "missing" },
    { ...command, trackId: "missing" },
    ...input.tracks.slice(1).map((t) => ({ ...command, trackId: t.id, clipId: t.id })),
  ])
    assert.throws(() => applyEdit(input, raw));
  for (const edit of [
    (v: TimelineIR) => v.tracks[0].clips.push(structuredClone(v.tracks[0].clips[0])),
    (v: TimelineIR) => v.tracks[0].clips[0].captions.push({ id: "x", text: "x", start: r(7), end: r(8) }),
    (v: TimelineIR) => {
      v.tracks[0].clips[0].payload = { scene: { headline: "authored" } };
    },
    (v: TimelineIR) => {
      v.tracks[0].clips[0].assetId = "scene:virtual";
    },
    (v: TimelineIR) => {
      v.legacyProject = { talkingHead: { enabled: true } };
    },
    (v: TimelineIR) => {
      const c = v.tracks[0].clips[0];
      c.transition = { kind: "fade", duration: r(3) };
      v.tracks[0].clips[1].start = r(45);
    },
    (v: TimelineIR) => {
      const c = v.tracks[0].clips[0];
      v.tracks[0].clips.unshift({
        ...structuredClone(c),
        id: "before",
        start: r(0),
        source: { ...c.source, start: r(0), end: r(15) },
        transition: { kind: "fade", duration: r(3) },
      });
    },
  ]) {
    const v = ir();
    edit(v);
    const before = structuredClone(v);
    assert.throws(() => applyEdit(v, command));
    assert.deepEqual(v, before);
  }
  assert.throws(() => build(input, request, { talkingHead: true }), /talking-head/);
});
test("exact duration change is refused even when ceil frame count remains identical", () => {
  const v = ir();
  v.tracks = [
    {
      id: "cutaways",
      kind: "visual",
      clips: [{ ...v.tracks[0].clips[0], start: r(0), source: { start: r(0), end: r(601, 10), timebase: r(30) } }],
    },
    {
      id: "anchor",
      kind: "voiceover",
      clips: [
        {
          ...v.tracks[1].clips[0],
          start: r(0),
          source: { start: r(0), end: r(1201, 20), timebase: r(30) },
          captions: [],
        },
      ],
    },
  ];
  assert.equal(compileTimelineIR(v).durationInFrames, 61);
  const shorter = structuredClone(v);
  shorter.tracks[0].clips = [];
  assert.equal(compileTimelineIR(shorter).durationInFrames, 61);
  assert.throws(() => applyEdit(v, command), /exact final timeline duration/);
});
test("batch validates only final state, duplicate remove is atomic, old duration-changing command remains compatible", () => {
  const input = ir();
  input.tracks[0].clips[1].start = r(45);
  const next = applyEdit(input, {
    type: "batch",
    commands: [{ type: "move", trackId: "cutaways", clipId: "after", start: r(15) }, command],
  });
  assert.equal(next.tracks[0].clips.length, 1);
  assert.deepEqual(next.tracks[0].clips[0].start, r(15));
  const before = structuredClone(input);
  assert.throws(() => applyEdit(input, { type: "batch", commands: [command, command] }), /not found/);
  assert.deepEqual(input, before);
  assert.doesNotThrow(() => applyEdit(input, { type: "move", trackId: "cutaways", clipId: "after", start: r(200) }));
  const transient = ir();
  transient.tracks = transient.tracks.slice(0, 1);
  transient.tracks[0].clips = transient.tracks[0].clips.slice(0, 1);
  assert.throws(() => applyEdit(transient, command), /exact final/);
  const restored = applyEdit(transient, {
    type: "batch",
    commands: [
      { type: "batch", commands: [command] },
      {
        type: "add-track",
        track: { id: "reinserted", kind: "visual", clips: [structuredClone(transient.tracks[0].clips[0])] },
      },
    ],
  });
  assert.deepEqual(compileTimelineIR(restored).duration, compileTimelineIR(transient).duration);
  const tail = structuredClone(input);
  tail.tracks = tail.tracks.slice(0, 1);
  assert.throws(
    () =>
      applyEdit(tail, {
        type: "batch",
        commands: [command, { type: "move", trackId: "cutaways", clipId: "after", start: r(90) }],
      }),
    /exact final timeline duration/,
  );
});
test("readonly static-image/video service, one history/Undo/Redo and existing parser retain all media and metadata", (t) => {
  for (const video of [false, true]) {
    const f = fixture(t, video),
      before = f.store.read(),
      bytes = readFileSync(f.store.file),
      file = path.resolve(f.root, "public", f.media.files.original),
      sha = hashFile(file),
      proposal = f.service.visualRemoveProposal(request);
    assert.deepEqual(readFileSync(f.store.file), bytes);
    f.service.mutate({ action: "edit", expectedRevision: 0, command: proposal.command });
    assert.equal(f.store.read().undo.length, 1);
    assert.equal(f.store.read().timeline.tracks.find((t) => t.id === "cutaways")!.clips.length, 0);
    assert.deepEqual(
      f.store.read().timeline.tracks.filter((t) => t.id !== "cutaways"),
      before.timeline.tracks.filter((t) => t.id !== "cutaways"),
    );
    assert.deepEqual(parseTimelineEditDocument(JSON.parse(readFileSync(f.store.file, "utf8"))), f.store.read());
    f.store.undo(1);
    assert.deepEqual(f.store.read().timeline, before.timeline);
    f.store.redo(2);
    assert.equal(f.store.read().timeline.tracks.find((t) => t.id === "cutaways")!.clips.length, 0);
    assert.equal(hashFile(file), sha);
  }
});
test("service bounds journal FIFO/aliases and refuses unknown/spoofed kind/config/original pins without writes", (t) => {
  const f = fixture(t),
    bytes = readFileSync(f.store.file);
  for (const raw of [
    { ...request, expectedRevision: 1 },
    { ...request, kind: "image" },
    { ...request, assetId: "fake" },
    { ...request, clipId: "missing" },
    { ...request, trackId: "voiceover", clipId: "clip" },
  ]) {
    assert.throws(() => f.service.visualRemoveProposal(raw));
    assert.deepEqual(readFileSync(f.store.file), bytes);
  }
  const registryFile = path.join(f.project, "pipeline/asset-registry.json"),
    registryBytes = readFileSync(registryFile),
    registry = JSON.parse(registryBytes.toString());
  registry.assets.push(structuredClone(registry.assets.find((a: { id: string }) => a.id === f.media.id)));
  writeFileSync(registryFile, JSON.stringify(registry));
  assert.throws(() => f.service.visualRemoveProposal(request), /Duplicate immutable asset ID/);
  assert.deepEqual(readFileSync(f.store.file), bytes);
  writeFileSync(registryFile, registryBytes);
  const configFile = path.join(f.project, "project.json"),
    config = JSON.parse(readFileSync(configFile, "utf8"));
  writeFileSync(
    configFile,
    JSON.stringify({ ...config, talkingHead: { enabled: true, presenterVideo: "projects/demo/manual.mp4" } }),
  );
  assert.throws(() => f.service.visualRemoveProposal(request), /talking-head/);
  writeFileSync(configFile, JSON.stringify(config));
  const file = path.resolve(f.root, "public", f.media.files.original),
    original = readFileSync(file);
  writeFileSync(file, Buffer.from("changed"));
  assert.throws(() => f.service.visualRemoveProposal(request), /checksum/);
  writeFileSync(file, original);
  const target = path.join(f.project, "journal-real.json");
  writeFileSync(target, bytes);
  unlinkSync(f.store.file);
  symlinkSync(target, f.store.file);
  assert.throws(() => f.service.visualRemoveProposal(request), /symlink/);
  unlinkSync(f.store.file);
  execFileSync("mkfifo", [f.store.file]);
  assert.throws(() => f.service.visualRemoveProposal(request), /regular/);
});
test("authenticated readonly HTTP and parallel CAS commit exactly once; stale/malformed deny without mutation", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const headers = { origin: app.origin, "x-review-token": app.token, "content-type": "application/json" },
    post = (route: string, body: unknown, h = headers) =>
      fetch(app.origin + route, { method: "POST", headers: h, body: JSON.stringify(body) }),
    bytes = readFileSync(f.store.file);
  for (const h of [
    { ...headers, origin: "http://wrong.invalid" },
    { ...headers, "x-review-token": "" },
  ])
    assert.equal((await post("/api/visual-remove-proposal", request, h)).status, 403);
  assert.equal((await post("/api/visual-remove-proposal", { ...request, expectedRevision: 1 })).status, 409);
  assert.equal((await post("/api/visual-remove-proposal", { ...request, kind: "visual" })).status, 400);
  assert.deepEqual(readFileSync(f.store.file), bytes);
  const response = await post("/api/visual-remove-proposal", request);
  assert.equal(response.status, 200);
  const proposal = await response.json();
  assert.deepEqual(readFileSync(f.store.file), bytes);
  const results = await Promise.all([
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command }),
    post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(f.store.read().undo.length, 1);
  assert.equal((await post("/api/visual-remove-proposal", request)).status, 409);
  assert.equal((await post("/api/mutate", { action: "undo", expectedRevision: 1 })).status, 200);
  assert.deepEqual(f.store.read().timeline, f.ir);
});
test("existing CLI one-JSON dryrun/apply/Undo supports new command without a new launcher or alternate journal", (t) => {
  const f = fixture(t),
    before = readFileSync(f.store.file),
    source = hashFile(path.resolve(f.root, "public", f.media.files.original));
  const run = (args: string[]) => {
    const p = spawnSync(
      process.execPath,
      [
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        path.resolve("scripts/timeline-edit.ts"),
        "--project",
        "demo",
        ...args,
      ],
      {
        cwd: f.root,
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
        encoding: "utf8",
        timeout: 10000,
        maxBuffer: 1024 * 1024,
      },
    );
    assert.equal(p.status, 0, p.stderr);
    const lines = p.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const value = JSON.parse(lines[0]);
    assert.equal(value.ok, true);
    return value;
  };
  assert.equal(run(["--revision", "0", "--command", JSON.stringify(command), "--dry-run"]).metadata.dryRun, true);
  assert.deepEqual(readFileSync(f.store.file), before);
  run(["--revision", "0", "--command", JSON.stringify(command)]);
  assert.equal(f.store.read().undo.length, 1);
  run(["--revision", "1", "--undo"]);
  assert.deepEqual(f.store.read().timeline, f.ir);
  assert.equal(hashFile(path.resolve(f.root, "public", f.media.files.original)), source);
});
