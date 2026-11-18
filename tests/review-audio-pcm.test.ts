import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { audioProject, amplitude } from "./helpers/review-audio";
import { projectAudioMix } from "../src/lib/audio/project-mix";
import { buildAudioMix } from "../src/lib/audio/local-mix";
import { planProjectRender } from "../src/lib/render-plan";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { assertProjectAudioEdits } from "../src/lib/audio/edit-validation";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
test("real PCM selected gain mutes all later automation while original speech/timing/captions remain exact", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "review-gain-pcm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { store, ir } = audioProject(root),
    original = projectAudioMix("demo", { rootDir: root }),
    sourceHashes = original.tracks.map((track) => readFileSync(track.source));
  const pcm = () => {
    const graph = buildAudioMix({ ...projectAudioMix("demo", { rootDir: root }), duckMusic: false });
    return execFileSync("ffmpeg", [
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
    ]);
  };
  const before = pcm();
  assert.equal(before.length / 4, 144000);
  store.apply({ type: "audio-gain", trackId: "music", clipId: "clip", gain: 0 }, 0);
  const muted = projectAudioMix("demo", { rootDir: root });
  assert.equal(muted.tracks[1].volume, 0);
  assert.ok(muted.tracks[1].keyframes.every((k) => k.volume === 0));
  assert.deepEqual(muted.tracks[0], original.tracks[0]);
  assert.deepEqual(muted.tracks[2], original.tracks[2]);
  const after = pcm();
  assert.equal(after.length, before.length);
  for (const start of [0.2, 1.7, 2.5]) {
    assert.ok(amplitude(before, 880, start) > 0.04);
    assert.ok(amplitude(after, 880, start) < 0.00002);
    assert.ok(Math.abs(amplitude(after, 440, start) - amplitude(before, 440, start)) < 0.00001);
    assert.ok(Math.abs(amplitude(after, 1320, start) - amplitude(before, 1320, start)) < 0.00001);
  }
  assert.deepEqual(
    store.read().timeline.tracks.filter((t) => t.kind === "voiceover"),
    ir.tracks.filter((t) => t.kind === "voiceover"),
  );
  assert.deepEqual(
    compileTimelineIR(store.read().timeline).tracks[1].clips[0].captions,
    compileTimelineIR(ir).tracks[1].clips[0].captions,
  );
  store.apply({ type: "audio-gain", trackId: "music", clipId: "clip", gain: 0.25 }, 1);
  const attenuated = projectAudioMix("demo", { rootDir: root });
  assert.equal(attenuated.tracks[1].volume, 0.1);
  assert.deepEqual(
    attenuated.tracks[1].keyframes,
    original.tracks[1].keyframes.map((k) => ({ ...k, volume: k.volume * 0.25 })),
  );
  const quarter = pcm();
  for (const start of [0.2, 2.5])
    assert.ok(Math.abs(amplitude(quarter, 880, start) / amplitude(before, 880, start) - 0.25) < 0.001);
  store.apply({ type: "audio-gain", trackId: "music", clipId: "clip", gain: null }, 2);
  assert.deepEqual(pcm(), before);
  assert.deepEqual(projectAudioMix("demo", { rootDir: root }), original);
  for (let i = 0; i < original.tracks.length; i++)
    assert.deepEqual(readFileSync(original.tracks[i].source), sourceHashes[i]);
  assert.equal(planProjectRender("demo", "square", root, { timeline: true }).jobs[0].durationInFrames, 90);
  // Turning off loop cannot make an extended window silently truncate or alter speech.
  const guarded = new TimelineEditStore(store.file, (ir, cmd) => assertProjectAudioEdits(ir, cmd, "demo", root));
  const committed = readFileSync(store.file);
  for (const loop of [false, null]) {
    const command = { type: "audio-loop", trackId: "music", clipId: "clip", loop };
    assert.throws(() => guarded.dryRun(command, 3), /would exceed/);
    assert.throws(() => guarded.apply(command, 3), /would exceed/);
    assert.deepEqual(readFileSync(store.file), committed);
  }
  guarded.apply(
    {
      type: "batch",
      commands: [
        { type: "audio-loop", trackId: "music", clipId: "clip", loop: false },
        { type: "trim", trackId: "music", clipId: "clip", start: { num: 0, den: 1 }, end: { num: 30, den: 1 } },
      ],
    },
    3,
  );
  assert.equal(planProjectRender("demo", "square", root, { timeline: true }).jobs[0].durationInFrames, 90);
  guarded.undo(4);
  assert.deepEqual(pcm(), before);
  assert.equal(projectAudioMix("demo", { rootDir: root }).tracks[1].loop, true);
});

test(
  "actual project CLI and HTTP refuse disabling/resetting extended loops before commit; final trimmed batch and changed-original history validation are atomic",
  { timeout: 90000 },
  async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "review-loop-routes-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const { store } = audioProject(root),
      before = readFileSync(store.file);
    const { spawnSync } = await import("node:child_process"),
      { writeFileSync } = await import("node:fs"),
      { startReviewServer } = await import("../src/lib/review-ui/server");
    const loader = path.resolve("node_modules/tsx/dist/loader.mjs"),
      script = path.resolve("scripts/timeline-edit.ts"),
      commandFile = path.join(root, "command.json"),
      guard = path.join(root, "guard.cjs");
    // A direct loader keeps the preload in the script process. The CLI launcher
    // otherwise spawns a child without this guard; startup is part of the deadline.
    const cliDeadlineMs = 10000;
    writeFileSync(
      guard,
      "process.stderr.write('scriptGuardActive:'+process.pid+'\\n');globalThis.fetch=()=>{throw Error('Forbidden network')};for(const id of ['node:http','node:https']){const m=require(id);m.get=m.request=()=>{throw Error('Forbidden network')};}require('node:net').Socket.prototype.connect=()=>{throw Error('Forbidden network')};const fs=require('node:fs'),open=fs.openSync;fs.openSync=(file,flags,...args)=>{try{if(typeof file==='string'&&fs.lstatSync(file).isFIFO())process.stderr.write('fifoOpenFlags:'+flags+'\\n');}catch{}return open(file,flags,...args)};require('node:module').syncBuiltinESMExports();",
    );
    const runCli = (args: string[]) => {
      const child = spawnSync(process.execPath, ["--require", guard, "--import", loader, script, ...args], {
        cwd: root,
        env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH },
        encoding: "utf8",
        timeout: cliDeadlineMs,
      });
      assert.ifError(child.error);
      assert.ok(
        child.stderr.includes("scriptGuardActive:" + child.pid + "\n"),
        "Guard must execute in the script process",
      );
      assert.equal(child.stdout.trim().split("\n").length, 1, "CLI must emit exactly one envelope");
      return child;
    };
    for (const loop of [false, null]) {
      writeFileSync(commandFile, JSON.stringify({ type: "audio-loop", trackId: "music", clipId: "clip", loop }));
      for (const dry of [true, false]) {
        const child = runCli([
          "--project",
          "demo",
          "--revision",
          "0",
          "--command-file",
          commandFile,
          ...(dry ? ["--dry-run"] : []),
        ]);
        assert.equal(child.status, 1);
        const result = JSON.parse(child.stdout);
        assert.equal(result.ok, false);
        assert.match(result.message, /would exceed/);
        assert.deepEqual(readFileSync(store.file), before);
      }
    }
    const app = await startReviewServer({ projectId: "demo", rootDir: root });
    t.after(() => app.close());
    const post = (route: string, command: unknown) =>
      fetch(app.origin + route, {
        method: "POST",
        headers: { "x-review-token": app.token, origin: app.origin, "content-type": "application/json" },
        body: JSON.stringify({ ...(route === "/api/mutate" ? { action: "edit" } : {}), expectedRevision: 0, command }),
      });
    const command = { type: "audio-loop", trackId: "music", clipId: "clip", loop: false };
    for (const route of ["/api/dry-run", "/api/mutate"]) assert.equal((await post(route, command)).status, 400);
    assert.deepEqual(readFileSync(store.file), before);
    const batch = {
      type: "batch",
      commands: [
        command,
        { type: "trim", trackId: "music", clipId: "clip", start: { num: 0, den: 1 }, end: { num: 30, den: 1 } },
      ],
    };
    writeFileSync(commandFile, JSON.stringify(batch));
    const applied = runCli(["--project", "demo", "--revision", "0", "--command-file", commandFile]);
    assert.equal(applied.status, 0);
    assert.equal(JSON.parse(applied.stdout).metadata.revision, 1);
    assert.equal(planProjectRender("demo", "square", root, { timeline: true }).jobs[0].durationInFrames, 90);
    const guarded = new TimelineEditStore(store.file, (ir, cmd) => assertProjectAudioEdits(ir, cmd, "demo", root));
    guarded.undo(1);
    guarded.redo(2);
    const mix = projectAudioMix("demo", { rootDir: root }),
      original = readFileSync(mix.tracks[1].source),
      current = readFileSync(store.file);
    writeFileSync(mix.tracks[1].source, "corrupt");
    assert.throws(() => guarded.undo(3), /checksum/);
    assert.deepEqual(readFileSync(store.file), current);
    writeFileSync(mix.tracks[1].source, original);
    guarded.undo(3);
    // A new loop-on followed by a nonzero trim in the same batch must not evade final-candidate checks.
    const pin = readFileSync(store.file);
    assert.throws(
      () =>
        guarded.apply(
          {
            type: "batch",
            commands: [
              { type: "audio-loop", trackId: "music", clipId: "clip", loop: true },
              { type: "trim", trackId: "music", clipId: "clip", start: { num: 15, den: 1 }, end: { num: 90, den: 1 } },
            ],
          },
          4,
        ),
      /zero source origin/,
    );
    assert.deepEqual(readFileSync(store.file), pin);
    // New project loop edits must reject special originals without blocking on open.
    writeFileSync(commandFile, JSON.stringify({ type: "audio-loop", trackId: "music", clipId: "clip", loop: true }));
    const fs = await import("node:fs"),
      file = mix.tracks[1].source,
      external = path.join(root, "external.wav");
    writeFileSync(external, original);
    try {
      for (const kind of ["fifo", "symlink"]) {
        fs.unlinkSync(file);
        if (kind === "fifo") execFileSync("mkfifo", [file]);
        else fs.symlinkSync(external, file);
        const denied = runCli(["--project", "demo", "--revision", "4", "--command-file", commandFile]);
        assert.equal(denied.status, 1);
        const result = JSON.parse(denied.stdout);
        assert.equal(result.ok, false);
        assert.equal(result.error, "VALIDATION");
        assert.deepEqual(result.outputs ?? [], []);
        assert.deepEqual(readFileSync(store.file), pin);
        if (kind === "fifo") {
          const flags = [...denied.stderr.matchAll(/fifoOpenFlags:(\d+)/g)].map((m) => Number(m[1]));
          assert.ok(flags.length > 0, "FIFO refusal must reach its guarded production open");
          assert.ok(
            flags.every((flag) => (flag & fs.constants.O_NONBLOCK) !== 0 && (flag & fs.constants.O_NOFOLLOW) !== 0),
            "FIFO open must be nonblocking and no-follow",
          );
        }
        fs.unlinkSync(file);
        writeFileSync(file, original);
      }
    } finally {
      fs.rmSync(file, { force: true });
      writeFileSync(file, original);
    }
  },
);
