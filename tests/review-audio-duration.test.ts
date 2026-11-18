import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { audioProject } from "./helpers/review-audio";
import { assertProjectAudioEdits } from "../src/lib/audio/edit-validation";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { CliErrorObject } from "../src/lib/cli";
import { startReviewServer } from "../src/lib/review-ui/server";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "review-duration-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const f = audioProject(root),
    registryFile = path.join(f.project, "pipeline/asset-registry.json"),
    registry = JSON.parse(readFileSync(registryFile, "utf8"));
  const id = f.ir.tracks.find((t) => t.kind === "music")!.clips[0].assetId,
    asset = registry.assets.find((a: { id: string }) => a.id === id);
  const store = new TimelineEditStore(f.store.file, (ir, cmd) => assertProjectAudioEdits(ir, cmd, "demo", root));
  const stale = () => {
    asset.media.durationSec = 10;
    writeFileSync(registryFile, JSON.stringify(registry));
  };
  const restore = () => {
    asset.media.durationSec = 1;
    writeFileSync(registryFile, JSON.stringify(registry));
  };
  return { ...f, root, store, stale, restore, file: path.join(root, "public", asset.files.original) };
}
const off = { type: "audio-loop" as const, trackId: "music", clipId: "clip", loop: false };
const batch = {
  type: "batch" as const,
  commands: [
    off,
    { type: "trim" as const, trackId: "music", clipId: "clip", start: { num: 0, den: 1 }, end: { num: 30, den: 1 } },
  ],
};
test("genuine physical duration rejects modified registry for dry-run/apply/reset and history without journal changes", (t) => {
  const f = fixture(t),
    original = readFileSync(f.file),
    before = readFileSync(f.store.file);
  f.stale();
  for (const loop of [false, null, true])
    for (const action of ["dryRun", "apply"] as const) {
      assert.throws(() => f.store[action]({ ...off, loop }, 0), /differs from physical/);
      assert.deepEqual(readFileSync(f.store.file), before);
    }
  assert.throws(() => f.store.apply(batch, 0), /differs from physical/);
  assert.deepEqual(readFileSync(f.file), original);
  f.restore();
  f.store.dryRun(batch, 0);
  assert.deepEqual(readFileSync(f.store.file), before);
  f.store.apply(batch, 0);
  let pin = readFileSync(f.store.file);
  f.stale();
  assert.throws(() => f.store.undo(1), /differs from physical/);
  assert.deepEqual(readFileSync(f.store.file), pin);
  f.restore();
  f.store.undo(1);
  pin = readFileSync(f.store.file);
  f.stale();
  assert.throws(() => f.store.redo(2), /differs from physical/);
  assert.deepEqual(readFileSync(f.store.file), pin);
  f.restore();
  f.store.redo(2);
  assert.equal(f.store.read().revision, 3);
  assert.deepEqual(readFileSync(f.file), original);
});
test("actual guarded CLI and authenticated HTTP reject forged duration; missing probe has typed CLI envelope", async (t) => {
  const f = fixture(t);
  f.stale();
  const before = readFileSync(f.store.file),
    command = path.join(f.root, "command.json"),
    guard = path.join(f.root, "deny.cjs");
  writeFileSync(command, JSON.stringify(off));
  writeFileSync(
    guard,
    "globalThis.fetch=()=>{throw Error('Forbidden network')};for(const id of ['node:http','node:https']){const m=require(id);m.get=m.request=()=>{throw Error('Forbidden network')};}require('node:net').Socket.prototype.connect=()=>{throw Error('Forbidden network')};",
  );
  const cli = path.resolve("node_modules/tsx/dist/cli.mjs"),
    script = path.resolve("scripts/timeline-edit.ts");
  const run = (dry: boolean, envPath: string | undefined) =>
    spawnSync(
      process.execPath,
      [
        "--require",
        guard,
        cli,
        script,
        "--project",
        "demo",
        "--revision",
        "0",
        "--command-file",
        command,
        ...(dry ? ["--dry-run"] : []),
      ],
      { cwd: f.root, env: { AGENTBROS_NO_DOTENV: "1", PATH: envPath }, encoding: "utf8", timeout: 10000 },
    );
  for (const dry of [true, false]) {
    const child = run(dry, process.env.PATH);
    assert.equal(child.status, 1);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    assert.match(JSON.parse(child.stdout).message, /differs from physical/);
    assert.deepEqual(readFileSync(f.store.file), before);
  }
  const app = await startReviewServer({ projectId: "demo", rootDir: f.root });
  t.after(() => app.close());
  for (const route of ["/api/dry-run", "/api/mutate"]) {
    const response = await fetch(app.origin + route, {
      method: "POST",
      headers: { origin: app.origin, "x-review-token": app.token, "content-type": "application/json" },
      body: JSON.stringify({
        ...(route === "/api/mutate" ? { action: "edit" } : {}),
        expectedRevision: 0,
        command: off,
      }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).message, /differs from physical/);
    assert.deepEqual(readFileSync(f.store.file), before);
  }
  f.restore();
  const child = run(false, path.join(f.root, "no-tools"));
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stdout).error, "FFMPEG_MISSING");
  assert.deepEqual(readFileSync(f.store.file), before);
});
test("bounded probe failures and changes during probing reject before commit; unrelated reads/edits need no probe", (t) => {
  const f = fixture(t),
    bin = path.join(f.root, "bin");
  mkdirSync(bin);
  const executable = path.join(bin, "ffprobe"),
    oldPath = process.env.PATH,
    original = readFileSync(f.file),
    before = readFileSync(f.store.file);
  t.after(() => {
    process.env.PATH = oldPath;
  });
  process.env.PATH = bin;
  assert.throws(
    () => f.store.apply(off, 0),
    (e: unknown) => e instanceof CliErrorObject && e.code === "FFMPEG_MISSING",
  );
  for (const body of [
    "process.stdout.write('bad json')",
    "process.exit(1)",
    "process.stdout.write(JSON.stringify({streams:[{duration:'Infinity'}]}))",
    "process.stdout.write(JSON.stringify({streams:[{duration:'0'}]}))",
    "process.stdout.write(JSON.stringify({streams:[]}))",
    "process.stdout.write('x'.repeat(70000))",
    "require('node:fs').appendFileSync(process.argv.at(-1),'changed');process.stdout.write(JSON.stringify({streams:[{duration:'1'}]}))",
  ]) {
    writeFileSync(executable, "#!" + process.execPath + "\n" + body, { mode: 0o755 });
    assert.throws(() => f.store.apply(off, 0));
    assert.deepEqual(readFileSync(f.store.file), before);
    writeFileSync(f.file, original);
  }
  writeFileSync(executable, "#!" + process.execPath + "\nsetInterval(()=>{},1000)", { mode: 0o755 });
  const started = Date.now();
  assert.throws(() => f.store.apply(off, 0), /probe failed/);
  assert.ok(Date.now() - started < 8000);
  assert.deepEqual(readFileSync(f.store.file), before);
  assert.equal(f.store.read().revision, 0);
  f.store.apply({ type: "audio-gain", trackId: "music", clipId: "clip", gain: 0.2 }, 0);
  assert.equal(f.store.read().revision, 1);
});
