import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { audioProject, amplitude } from "./helpers/review-audio";
import { buildAudioPositionProposal as propose } from "../src/lib/review-ui/audio-position";
import { ReviewService } from "../src/lib/review-ui/service";
import { startReviewServer } from "../src/lib/review-ui/server";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { assertProjectAudioEdits } from "../src/lib/audio/edit-validation";
import { applyEdit } from "../src/lib/timeline-ir/commands";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { projectAudioMixWithInputs, projectAudioMix } from "../src/lib/audio/project-mix";
import { assertAudioMasterInputs } from "../src/lib/audio/master-inputs";
import { buildAudioMix } from "../src/lib/audio/local-mix";
const r = (num: number, den = 1) => ({ num, den });
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "audio-position-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = audioProject(root);
  return {
    ...f,
    root,
    guarded: new TimelineEditStore(f.store.file, (ir, cmd) => assertProjectAudioEdits(ir, cmd, "demo", root)),
    service: new ReviewService("demo", root),
  };
}
const move = { expectedRevision: 0, trackId: "sfx", clipId: "clip", mode: "move" as const, start: r(15) };
test("exact inward source trim anchors output edges without changing rate/gain/automation/protected tracks", (t) => {
  const f = fixture(t),
    ir = f.store.read().timeline;
  const sfx = ir.tracks.find((t) => t.id === "sfx")!.clips[0];
  sfx.source.timebase = r(30000, 1001);
  sfx.rate = r(3, 2);
  const original = structuredClone(ir);
  const cmd = propose(ir, {
      expectedRevision: 0,
      trackId: "sfx",
      clipId: "clip",
      mode: "trim",
      sourceStart: r(15, 2),
      sourceEnd: r(75),
    }),
    changed = applyEdit(ir, cmd),
    clip = changed.tracks.find((t) => t.id === "sfx")!.clips[0];
  assert.deepEqual(clip.start, r(1001, 200));
  assert.deepEqual({ ...clip, start: sfx.start, source: sfx.source }, sfx);
  assert.deepEqual(changed.tracks.slice(0, -1), ir.tracks.slice(0, -1));
  assert.deepEqual(ir, original);
  const oldCompiled = compileTimelineIR(ir).tracks.at(-1)!.clips[0],
    left = propose(ir, {
      expectedRevision: 0,
      trackId: "sfx",
      clipId: "clip",
      mode: "trim",
      sourceStart: r(15, 2),
      sourceEnd: r(90),
    }),
    after = compileTimelineIR(applyEdit(ir, left)).tracks.at(-1)!.clips[0];
  assert.deepEqual(after.end, oldCompiled.end);
});
test("strict current-ID music/SFX requests refuse protected/injected/noop/outward/overflow/overlap/loop origin without writes", (t) => {
  const f = fixture(t),
    before = readFileSync(f.store.file);
  const bad = [
    { ...move, start: r(-1) },
    { ...move, start: r(1) },
    { ...move, start: r(0) },
    { ...move, start: r(Number.MAX_SAFE_INTEGER + 1) },
    { ...move, start: r(1, 0) },
    { ...move, unexpected: true },
    { ...move, source: {} },
    { ...move, clipId: "missing" },
    ...["voiceover", "visual", "presenter", "captions"].map((trackId) => ({ ...move, trackId })),
    { ...move, mode: "trim", sourceStart: r(-1), sourceEnd: r(90) },
    { ...move, mode: "trim", sourceStart: r(0), sourceEnd: r(91) },
    { expectedRevision: 0, trackId: "music", clipId: "clip", mode: "trim", sourceStart: r(1), sourceEnd: r(90) },
  ];
  for (const input of bad) {
    assert.throws(() => f.service.audioPositionProposal(input));
    assert.deepEqual(readFileSync(f.store.file), before);
  }
  const ir = f.store.read().timeline;
  ir.tracks.at(-1)!.clips.push({ ...structuredClone(ir.tracks.at(-1)!.clips[0]), id: "next", start: r(90) });
  assert.throws(() => propose(ir, { ...move, start: r(1) }), /Overlapping/);
});
test("project guard refuses old loop-start trim bypass and final batch loopholes; physical/history changes reject atomically", (t) => {
  const f = fixture(t),
    before = readFileSync(f.store.file),
    trim = { type: "trim" as const, trackId: "music", clipId: "clip", start: r(15), end: r(90) };
  for (const action of ["dryRun", "apply"] as const)
    assert.throws(() => f.guarded[action](trim, 0), /zero source origin/);
  assert.deepEqual(readFileSync(f.store.file), before);
  assert.throws(
    () =>
      f.guarded.apply(
        { type: "batch", commands: [{ type: "move", trackId: "music", clipId: "clip", start: r(0) }, trim] },
        0,
      ),
    /zero source origin/,
  );
  assert.deepEqual(readFileSync(f.store.file), before);
  const proposal = f.service.audioPositionProposal({
    expectedRevision: 0,
    trackId: "music",
    clipId: "clip",
    mode: "trim",
    sourceStart: r(0),
    sourceEnd: r(60),
  });
  assert.deepEqual(readFileSync(f.store.file), before);
  f.guarded.apply(proposal.command, 0);
  const applied = readFileSync(f.store.file),
    registry = path.join(f.project, "pipeline/asset-registry.json"),
    bytes = readFileSync(registry),
    data = JSON.parse(bytes.toString());
  data.assets.find(
    (a: any) => a.id === f.ir.tracks.find((t) => t.kind === "music")!.clips[0].assetId,
  ).media.durationSec = 10;
  writeFileSync(registry, JSON.stringify(data));
  assert.throws(() => f.guarded.undo(1), /physical/);
  assert.deepEqual(readFileSync(f.store.file), applied);
  writeFileSync(registry, bytes);
  f.guarded.undo(1);
  assert.deepEqual(f.store.read().timeline, f.ir);
  f.guarded.redo(2);
  assert.equal(f.store.read().undo.length, 1);
});
test("authenticated readonly audio proposal/CAS Apply and Undo; actual guarded CLI rejects bypass before write", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  const headers = { origin: app.origin, "x-review-token": app.token, "content-type": "application/json" },
    before = readFileSync(f.store.file),
    input = { expectedRevision: 0, trackId: "sfx", clipId: "clip", mode: "trim", sourceStart: r(15), sourceEnd: r(75) };
  const post = (route: string, body: unknown, h = headers) =>
    fetch(app.origin + route, { method: "POST", headers: h, body: JSON.stringify(body) });
  for (const h of [
    { ...headers, "x-review-token": "" },
    { ...headers, origin: "http://foreign.invalid" },
  ])
    assert.equal((await post("/api/audio-position-proposal", input, h)).status, 403);
  assert.equal((await post("/api/audio-position-proposal", { ...input, expectedRevision: 1 })).status, 409);
  assert.deepEqual(readFileSync(f.store.file), before);
  const result = await post("/api/audio-position-proposal", input);
  assert.equal(result.status, 200);
  const proposal = await result.json();
  assert.deepEqual(readFileSync(f.store.file), before);
  assert.equal(
    (await post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command })).status,
    200,
  );
  assert.equal(f.store.read().undo.length, 1);
  assert.equal(
    (await post("/api/mutate", { action: "edit", expectedRevision: 0, command: proposal.command })).status,
    409,
  );
  assert.equal((await post("/api/mutate", { action: "undo", expectedRevision: 1 })).status, 200);
  assert.deepEqual(f.store.read().timeline, f.ir);
  const command = path.join(f.root, "command.json"),
    guard = path.join(f.root, "guard.cjs");
  writeFileSync(command, JSON.stringify({ type: "trim", trackId: "music", clipId: "clip", start: r(1), end: r(90) }));
  writeFileSync(
    guard,
    "process.stderr.write('guard:'+process.pid+'\\n');globalThis.fetch=()=>{throw Error('Network forbidden')};require('node:net').Socket.prototype.connect=()=>{throw Error('Network forbidden')};",
  );
  const pin = readFileSync(f.store.file);
  for (const dry of [false, true]) {
    const child = spawnSync(
      process.execPath,
      [
        "--require",
        guard,
        "--import",
        path.resolve("node_modules/tsx/dist/loader.mjs"),
        path.resolve("scripts/timeline-edit.ts"),
        "--project",
        "demo",
        "--revision",
        "2",
        "--command-file",
        command,
        ...(dry ? ["--dry-run"] : []),
      ],
      { cwd: f.root, env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH }, timeout: 10000, encoding: "utf8" },
    );
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, new RegExp("guard:" + child.pid));
    assert.equal(child.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(child.stdout).error, "VALIDATION");
    assert.match(JSON.parse(child.stdout).message, /zero source origin/);
    assert.deepEqual(readFileSync(f.store.file), pin);
  }
});
test("real PCM move/inward trims preserve protected speech and expected combined mix; loop original cycle and Undo/input bindings exact", (t) => {
  const f = fixture(t),
    original = projectAudioMixWithInputs("demo", { rootDir: f.root }),
    sources = original.plan.tracks.map((x) => readFileSync(x.source));
  const pcm = (role?: string) => {
    const plan = projectAudioMix("demo", { rootDir: f.root });
    const graph = buildAudioMix({
      ...plan,
      tracks: role ? plan.tracks.filter((t) => t.role === role) : plan.tracks,
      duckMusic: false,
    });
    return execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-threads",
        "1",
        ...graph.args,
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        graph.filter,
        "-map",
        "[master]",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { timeout: 10000 },
    );
  };
  const before = pcm(),
    speech = pcm("speech"),
    oldSfx = pcm("sfx");
  const expected = (actual: Buffer, sfx: Buffer) => {
    for (const b of [actual, sfx, before, oldSfx]) assert.equal(b.length, 3 * 48000 * 4);
    let maximum = 0;
    for (let i = 0; i < actual.length; i += 4)
      maximum = Math.max(
        maximum,
        Math.abs(actual.readFloatLE(i) - (before.readFloatLE(i) - oldSfx.readFloatLE(i) + sfx.readFloatLE(i))),
      );
    assert.ok(maximum < 6e-8, `combined sample float32 rounding ${maximum}`);
  };
  const proposal = f.service.audioPositionProposal({
    expectedRevision: 0,
    trackId: "sfx",
    clipId: "clip",
    mode: "trim",
    sourceStart: r(15),
    sourceEnd: r(75),
  });
  f.guarded.apply(proposal.command, 0);
  const afterSfx = pcm("sfx");
  expected(pcm(), afterSfx);
  assert.ok(amplitude(afterSfx, 1320, 0.05, 0.3) < 0.00002);
  assert.ok(amplitude(afterSfx, 1320, 0.7) > 0.04);
  assert.ok(amplitude(afterSfx, 1320, 2.6) < 0.00002);
  assert.deepEqual(pcm("speech"), speech);
  assert.deepEqual(projectAudioMix("demo", { rootDir: f.root }).tracks[1].keyframes, original.plan.tracks[1].keyframes);
  assert.throws(
    () => assertAudioMasterInputs(original.inputs, projectAudioMixWithInputs("demo", { rootDir: f.root }).inputs),
    /inputs changed/,
  );
  const trimmed = pcm();
  const moved = f.service.audioPositionProposal({
    expectedRevision: 1,
    trackId: "sfx",
    clipId: "clip",
    mode: "move",
    start: r(30),
  });
  f.guarded.apply(moved.command, 1);
  const movedSfx = pcm("sfx");
  expected(pcm(), movedSfx);
  assert.ok(amplitude(movedSfx, 1320, 0.5, 0.3) < 0.00002);
  assert.ok(amplitude(movedSfx, 1320, 1.3) > 0.04);
  assert.deepEqual(pcm("speech"), speech);
  f.guarded.undo(2);
  assert.deepEqual(pcm(), trimmed);
  f.guarded.undo(3);
  assert.deepEqual(pcm(), before);
  assertAudioMasterInputs(original.inputs, projectAudioMixWithInputs("demo", { rootDir: f.root }).inputs);
  const end = f.service.audioPositionProposal({
    expectedRevision: 4,
    trackId: "music",
    clipId: "clip",
    mode: "trim",
    sourceStart: r(0),
    sourceEnd: r(60),
  });
  f.guarded.apply(end.command, 4);
  const looped = pcm("music");
  assert.equal(looped.length, before.length);
  assert.ok(amplitude(looped, 880, 1.4) > 0.04);
  assert.ok(amplitude(looped, 880, 2.4) < 0.00002);
  assert.equal(projectAudioMix("demo", { rootDir: f.root }).tracks[1].loop, true);
  f.guarded.undo(5);
  assert.deepEqual(pcm(), before);
  for (let i = 0; i < sources.length; i++) assert.deepEqual(readFileSync(original.plan.tracks[i].source), sources[i]);
});
test("delayed trimmed local buses have finite project clocks for rate and explicit speech spans; historical no-delay graph stays unchanged", (t) => {
  const f = fixture(t),
    base = projectAudioMix("demo", { rootDir: f.root });
  for (const role of ["sfx", "speech"] as const) {
    const source = base.tracks.find((x) => x.role === role)!;
    const graph = buildAudioMix({
      ...base,
      duckMusic: false,
      tracks: [
        {
          ...source,
          startSec: 0.5,
          sourceStartSec: 0.5,
          sourceEndSec: 2.5,
          rate: 2,
          allowSpeechTrim: role === "speech",
          keyframes: [{ atSec: 1, volume: 0.8 }],
          volume: 0.4,
        },
      ],
    });
    assert.match(graph.filter, /adelay=500:all=1,asetpts=N\/SR\/TB,volume=/);
    const pcm = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-threads",
        "1",
        ...graph.args,
        "-filter_complex_threads",
        "1",
        "-filter_complex",
        graph.filter,
        "-map",
        "[master]",
        "-ar",
        "48000",
        "-ac",
        "1",
        "-f",
        "f32le",
        "pipe:1",
      ],
      { timeout: 10000 },
    );
    assert.equal(pcm.length, 576000);
    const hz = role === "speech" ? 440 : 1320;
    assert.ok(amplitude(pcm, hz, 0.1, 0.2) < 0.00002);
    assert.ok(amplitude(pcm, hz, 0.8, 0.2) > 0.07);
    assert.ok(amplitude(pcm, hz, 1.6, 0.3) < 0.00002);
  }
  const old = buildAudioMix({ ...base, duckMusic: false });
  assert.doesNotMatch(old.filter, /asetpts=N\/SR\/TB/);
  assert.match(old.filter, /adelay=0:all=1,volume=/);
});
