import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { prepareHandoff, executeResolveHandoff } from "../src/lib/backends/handoff";
import { LocalResolveAdapter } from "../src/lib/backends/resolve/adapter";
import { TimelineIRSchema } from "../src/types/timeline";
const r = (num: number) => ({ num, den: 1 });
function fixture(t: test.TestContext, flags: Record<string, unknown> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "resolve-worker-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const media = path.join(root, "source.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32:r=30:d=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    media,
  ]);
  const ir = TimelineIRSchema.parse({
    version: 1,
    projectId: "owned",
    timebase: r(30),
    tracks: [
      {
        id: "video",
        kind: "visual",
        clips: [
          {
            id: "v",
            assetId: "media",
            start: r(10),
            source: { start: r(15), end: r(65), timebase: r(30) },
            rate: r(1),
            transition: { kind: "cut" },
            captions: [],
          },
        ],
      },
    ],
  });
  const directory = path.join(root, "handoff");
  prepareHandoff(
    ir,
    {
      media: {
        path: media,
        kind: "video",
        timebase: r(30),
        durationFrames: r(90),
      },
    },
    directory,
    "original",
  );
  const stateFile = path.join(root, "state.json");
  const original = {
    name: "Owned synthetic original",
    tracks: { video: 1, audio: 0, subtitle: 0 },
    items: [
      {
        id: "original-item",
        source: media,
        startFrame: 0,
        endFrame: 29,
        recordFrame: 1000,
        trackIndex: 1,
        kind: "video",
      },
    ],
  };
  writeFileSync(stateFile, JSON.stringify({ current: "original", timelines: { original }, ...flags }));
  const adapter = new LocalResolveAdapter(directory, {
    sdkDirectory: path.resolve("tests/fixtures/resolve-sdk"),
    fixtureState: stateFile,
  });
  const state = () => JSON.parse(readFileSync(stateFile, "utf8"));
  return { directory, adapter, state, stateFile, original, ir, media, root };
}
test("actual isolated Python worker clones, appends exact source trims, reads native geometry and protects original", async (t) => {
  const f = fixture(t);
  const result = await executeResolveHandoff(f.directory, f.adapter);
  assert.equal(result.state, "verified");
  assert.equal(f.state().clones, 1);
  assert.deepEqual(f.state().timelines.original, f.original);
  assert.equal(f.state().current, "original");
  const append = f.state().calls.find((call: { method: string }) => call.method === "AppendToTimeline").info;
  assert.equal(append.startFrame, 15);
  assert.equal(append.endFrame, 64);
  assert.equal(append.recordFrame, 1010);
  assert.equal(append.mediaType, 1);
  assert.ok(existsSync(path.join(f.directory, "readback-verified.json")));
  assert.equal((await executeResolveHandoff(f.directory, f.adapter)).state, "verified");
  assert.equal(f.state().appends, 1);
});
test("native source replacement, extra clips and original DRT changes cannot verify", async (t) => {
  const f = fixture(t);
  await executeResolveHandoff(f.directory, f.adapter);
  const state = f.state();
  const clone = Object.keys(state.timelines).find((id) => id !== "original")!;
  state.timelines[clone].items.push({
    ...state.timelines[clone].items[0],
    id: "unbound-extra",
  });
  writeFileSync(f.stateFile, JSON.stringify(state));
  await assert.rejects(() => f.adapter.readback(clone), /missing\/extra/);
  state.timelines[clone].items.pop();
  state.timelines[clone].items[0].source = path.join(f.root, "other.mp4");
  writeFileSync(f.stateFile, JSON.stringify(state));
  await assert.rejects(() => f.adapter.readback(clone), /source replacement/);
  state.timelines[clone].items[0].source = f.media;
  state.timelines.original.name = "Changed original";
  writeFileSync(f.stateFile, JSON.stringify(state));
  await assert.rejects(() => executeResolveHandoff(f.directory, f.adapter), /Original timeline changed/);
});
test("acknowledgement loss after native clone is unknown and never blindly recloned", async (t) => {
  const f = fixture(t, { loseCloneAck: true });
  await assert.rejects(() => executeResolveHandoff(f.directory, f.adapter), /acknowledgement loss/);
  assert.equal((await executeResolveHandoff(f.directory, f.adapter)).state, "unknown");
  assert.equal(f.state().clones, 1);
  assert.deepEqual(f.state().timelines.original, f.original);
});
test("acknowledgement loss after append never reimports and requires reconciliation", async (t) => {
  const f = fixture(t, { loseImportAck: true });
  await assert.rejects(() => executeResolveHandoff(f.directory, f.adapter), /acknowledgement loss/);
  await assert.rejects(() => executeResolveHandoff(f.directory, f.adapter), /resolve-worker-import-result/);
  assert.equal(f.state().appends, 1);
  assert.equal(f.state().current, "original");
  assert.deepEqual(f.state().timelines.original, f.original);
});
test("unsupported caption subset fails before clone, local SDK absence reports unavailable", async (t) => {
  const f = fixture(t);
  const second = path.join(f.root, "captions");
  const ir = structuredClone(f.ir);
  ir.tracks[0].clips[0].captions = [{ id: "caption", text: "Caption", start: r(15), end: r(30) }];
  prepareHandoff(
    ir,
    {
      media: {
        path: f.media,
        kind: "video",
        timebase: r(30),
        durationFrames: r(90),
      },
    },
    second,
    "original",
  );
  const adapter = new LocalResolveAdapter(second, {
    sdkDirectory: path.resolve("tests/fixtures/resolve-sdk"),
    fixtureState: f.stateFile,
  });
  const probe = await adapter.probe();
  assert.equal(probe.available, false);
  assert.match(probe.reason!, /caption/);
  assert.equal(f.state().clones, undefined);
  const absent = new LocalResolveAdapter(f.directory, {
    sdkDirectory: path.join(f.root, "absent"),
  });
  assert.equal((await absent.probe()).available, false);
});

test("rational FPS is rejected before native mutation and local installed probe is explicit", async (t) => {
  const f = fixture(t);
  const fps = { num: 30000, den: 1001 };
  const ir = structuredClone(f.ir);
  ir.timebase = fps;
  ir.tracks[0].clips[0].source.timebase = fps;
  const directory = path.join(f.root, "fractional");
  prepareHandoff(
    ir,
    {
      media: {
        path: f.media,
        kind: "video",
        timebase: fps,
        durationFrames: r(90),
      },
    },
    directory,
    "original",
  );
  const adapter = new LocalResolveAdapter(directory, {
    sdkDirectory: path.resolve("tests/fixtures/resolve-sdk"),
    fixtureState: f.stateFile,
  });
  const probe = await adapter.probe();
  assert.equal(probe.available, false);
  assert.match(probe.reason!, /integral frames and integer FPS/);
  assert.equal(f.state().clones, undefined);
  const actual = new LocalResolveAdapter(f.directory);
  const observed = await actual.probe();
  if (
    !existsSync(
      "/Library/Application Support/Blackmagic Design/DaVinci Resolve/Developer/Scripting/Modules/DaVinciResolveScript.py",
    )
  ) {
    assert.equal(observed.available, false);
    assert.equal(observed.liveVerified, false);
  }
});

test("native audio-only import uses timeline frame basis and independent audio lane", async (t) => {
  const f = fixture(t);
  const wav = path.join(f.root, "tone.wav");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  const ir = structuredClone(f.ir);
  ir.tracks.push({
    id: "dialogue",
    kind: "voiceover",
    clips: [
      {
        id: "a",
        assetId: "audio",
        start: r(0),
        source: { start: r(0), end: r(60), timebase: r(30) },
        rate: r(1),
        transition: { kind: "cut" },
        captions: [],
      },
    ],
  });
  const directory = path.join(f.root, "audio");
  prepareHandoff(
    ir,
    {
      media: {
        path: f.media,
        kind: "video",
        timebase: r(30),
        durationFrames: r(90),
      },
      audio: {
        path: wav,
        kind: "audio",
        timebase: r(30),
        durationFrames: r(90),
      },
    },
    directory,
    "original",
  );
  const adapter = new LocalResolveAdapter(directory, {
    sdkDirectory: path.resolve("tests/fixtures/resolve-sdk"),
    fixtureState: f.stateFile,
  });
  const result = await executeResolveHandoff(directory, adapter);
  assert.equal(result.state, "verified");
  const calls = f.state().calls.filter((v: { method: string }) => v.method === "AppendToTimeline");
  assert.equal(calls[1].info.mediaType, 2);
  assert.equal(calls[1].info.trackIndex, 1);
  assert.equal(calls[1].info.recordFrame, 1000);
  assert.deepEqual(f.state().timelines.original, f.original);
});
test("subprocess timeout after native clone preserves unknown dispatch without replay", async (t) => {
  const f = fixture(t, { delayCloneAckUntilRelease: true });
  const cloneWorker = new LocalResolveAdapter(f.directory, {
    sdkDirectory: path.resolve("tests/fixtures/resolve-sdk"),
    fixtureState: f.stateFile,
    timeoutMs: 500,
  });
  let cloneTimerEnabled = false;
  class CloneTimeoutAdapter extends LocalResolveAdapter {
    override cloneTimeline(timelineId: string, cloneName: string) {
      // Advance the clone deadline only after native mutation is observable.
      // Python startup/probe duration is not the acknowledgement-loss scenario.
      t.mock.timers.enable({ apis: ["setTimeout"] });
      cloneTimerEnabled = true;
      return cloneWorker.cloneTimeline(timelineId, cloneName);
    }
  }
  const adapter = new CloneTimeoutAdapter(f.directory, {
    sdkDirectory: path.resolve("tests/fixtures/resolve-sdk"),
    fixtureState: f.stateFile,
  });
  const rejection = assert.rejects(() => executeResolveHandoff(f.directory, adapter), /timeout/);
  let readinessPoll: ReturnType<typeof setInterval> | undefined;
  try {
    const readiness = new Promise<void>((resolve, reject) => {
      const started = Date.now();
      // setInterval remains real: the actual Python worker must persist a clone.
      const poll = setInterval(() => {
        try {
          if (f.state().clones === 1) {
            clearInterval(poll);
            resolve();
          } else if (Date.now() - started > 30000) {
            clearInterval(poll);
            reject(new Error("Native clone readiness was not observed"));
          }
        } catch (error) {
          // The tiny JSON state can be observed during the fake SDK's write.
          if (!(error instanceof SyntaxError)) {
            clearInterval(poll);
            reject(error);
          }
        }
      }, 10);
      readinessPoll = poll;
    });
    await Promise.race([
      readiness,
      rejection.then(() => {
        throw new Error("Timeout occurred before native clone readiness");
      }),
    ]);
    assert.ok(existsSync(path.join(f.directory, "clone-dispatch.json")));
    assert.equal(existsSync(path.join(f.directory, "clone-result.json")), false);
    t.mock.timers.tick(500); // Real adapter callback kills the sleeping Python child.
    await rejection;
  } finally {
    // Also terminate a pending clone if the readiness assertion itself fails.
    if (readinessPoll) clearInterval(readinessPoll);
    if (cloneTimerEnabled) {
      t.mock.timers.tick(500);
      t.mock.timers.reset();
    }
    writeFileSync(path.join(f.root, "state.clone-release"), "release");
  }
  assert.equal((await executeResolveHandoff(f.directory, adapter)).state, "unknown");
  assert.equal(f.state().clones, 1);
  assert.equal(f.state().appends, undefined);
  assert.deepEqual(f.state().timelines.original, f.original);
});

test("unsupported checksum-bound OTIO effects reject before any SDK mutation", async (t) => {
  const f = fixture(t),
    otioFile = path.join(f.directory, "timeline.otio");
  const otio = JSON.parse(readFileSync(otioFile, "utf8"));
  otio.tracks.children[0].children.find((v: { OTIO_SCHEMA: string }) => v.OTIO_SCHEMA === "Clip.2").effects = [
    { OTIO_SCHEMA: "LinearTimeWarp.1", time_scalar: 2 },
  ];
  writeFileSync(otioFile, JSON.stringify(otio));
  const manifestFile = path.join(f.directory, "handoff.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  manifest.exports.find((v: { name: string }) => v.name === "timeline.otio").sha256 = sha(readFileSync(otioFile));
  writeFileSync(manifestFile, JSON.stringify(manifest));
  writeFileSync(path.join(f.directory, "handoff.sha256"), sha(readFileSync(manifestFile)));
  const probe = await f.adapter.probe();
  assert.equal(probe.available, false);
  assert.match(probe.reason!, /Bake OTIO effects/);
  assert.equal(f.state().clones, undefined);
});

test("actual CLI probe emits one JSON line and no clone or budget mutation", (t) => {
  const f = fixture(t);
  const result = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/resolve-handoff.ts", "--directory", f.directory, "--action", "probe"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const envelope = JSON.parse(lines[0]);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.liveVerified, false);
  assert.equal(f.state().clones, undefined);
});

test("actual media FPS disagrees with supplied metadata: ffprobe rejects before clone", async (t) => {
  const f = fixture(t);
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=32x32:r=24:d=3",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    f.media,
  ]);
  const directory = path.join(f.root, "bad-source-fps");
  prepareHandoff(
    f.ir,
    {
      media: {
        path: f.media,
        kind: "video",
        timebase: r(30),
        durationFrames: r(90),
      },
    },
    directory,
    "original",
  );
  const adapter = new LocalResolveAdapter(directory, {
    sdkDirectory: path.resolve("tests/fixtures/resolve-sdk"),
    fixtureState: f.stateFile,
  });
  const probe = await adapter.probe();
  assert.equal(probe.available, false);
  assert.match(probe.reason!, /Actual local video FPS mismatch/);
  assert.equal(f.state().clones, undefined);
});
