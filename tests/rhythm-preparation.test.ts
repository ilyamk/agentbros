import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { RhythmAnalysisRequestSchema } from "../src/types/rhythm-evidence";
import { parseRhythmProbe } from "../src/lib/audio/rhythm-preparation";
import { RhythmPublisher } from "../src/lib/audio/rhythm-publisher";
import { RhythmReadContext } from "../src/lib/audio/rhythm-files";
import {
  runRhythmOwnedProcess,
  resolveRhythmTool,
  parseRhythmProcessRows,
  captureRhythmOwned,
  selectRhythmSignalTargets,
} from "../src/lib/audio/rhythm-process";

/** Rhythm analysis runs only on macOS (tools under sandbox-exec, workspace in /private/tmp); elsewhere these skip. */
const macOsOnly = (t: { skip(message?: string): void }) => {
  if (process.platform === "darwin") return false;
  t.skip("Rhythm runs only on macOS");
  return true;
};
const metadata = () => ({
  streams: [
    {
      index: 0,
      codec_type: "audio",
      codec_name: "pcm_s16le",
      sample_rate: "16000",
      channels: 1,
      time_base: "1/16000",
      duration_ts: 16000,
    },
  ],
  frames: [
    { media_type: "audio", stream_index: 0, pts: 0, best_effort_timestamp: 0, nb_samples: 8000 },
    { media_type: "audio", stream_index: 0, pts: 8000, best_effort_timestamp: 8000, nb_samples: 8000 },
  ],
});
function folder(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rhythm-c-fake-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const bounds = { timeoutMs: Math.min(SPAWN_TIMEOUT_MS, 90000), stallMs: 10000, stdoutBytes: 4096, stderrBytes: 4096 };
const fake = (code: string, b: any = bounds) => runRhythmOwnedProcess(process.execPath, ["-e", code], b);
test("strict actual metadata parser uses frame clock and physical stream terminal, not container duration", () => {
  const m = metadata(),
    parsed = parseRhythmProbe(m, m);
  assert.equal(parsed.summary.analysisSamples, 16000);
  assert.equal(parsed.summary.duration.num, 1);
  const withoutOrigin = metadata();
  assert.equal(parseRhythmProbe(withoutOrigin, withoutOrigin).summary.sourceSamples, 16000);
});
/** The host below always runs Node; this only stands in for the pinned binary, whose size is bounded. */
const fakeTool = (t: Parameters<typeof folder>[0]) => {
  const file = path.join(folder(t), "fake-tool");
  writeFileSync(file, "fake tool DATA; never executed");
  return file;
};
test("parser refuses unknown streams, priming, missing terminal, unsafe/fractional ticks, frame substitutions and gaps", () => {
  for (const mutate of [
    (m: any) => m.streams.push({ ...m.streams[0], index: 1 }),
    (m: any) => (m.streams[0].codec_name = "aac"),
    (m: any) => (m.streams[0].start_pts = 1),
    (m: any) => delete m.streams[0].duration_ts,
    (m: any) => (m.streams[0].duration_ts = "16000.0"),
    (m: any) => (m.streams[0].duration_ts = "9007199254740992"),
    (m: any) => (m.streams[0].initial_padding = 1),
    (m: any) => (m.frames[0].side_data_list = [{ skip_samples: 1 }]),
    (m: any) => (m.frames[1].pts = 8001),
    (m: any) => (m.frames[1].stream_index = 1),
    (m: any) => (m.frames[0].best_effort_timestamp = 1),
    (m: any) => (m.frames[0].media_type = "video"),
  ]) {
    const m = metadata();
    mutate(m);
    assert.throws(() => parseRhythmProbe(m, m));
  }
});
test("tighten-only source execution request never accepts executor/path/expanded limits", () => {
  const request = {
    version: 1,
    contract: "source-rhythm-evidence-v1",
    projectId: "demo",
    assetId: "sha256:" + "a".repeat(64),
    assetSha256: "a".repeat(64),
    profile: "rms-onset-v1-mono16k",
  };
  assert.equal(
    RhythmAnalysisRequestSchema.safeParse({ ...request, limits: { wholeMs: 1000, pcmBytes: 64 } }).success,
    true,
  );
  for (const limits of [
    { wholeMs: 90001 },
    { stderrBytes: 262145 },
    { sourceBytes: 0 },
    { execute: "/bin/sh" },
    { decodeMs: 0.5 },
  ])
    assert.equal(RhythmAnalysisRequestSchema.safeParse({ ...request, limits }).success, false);
  assert.equal(RhythmAnalysisRequestSchema.safeParse({ ...request, toolPath: "/bin/sh" }).success, false);
});
test("publisher enrolls exact owned files, fsync/nooverwrite publication and cleanup only exact own bytes", (t) => {
  const root = folder(t),
    context = new RhythmReadContext(root),
    publisher = new RhythmPublisher(context, "demo", 1024);
  publisher.directory(".cache/rhythm-evidence/demo/key");
  publisher.directory("public/projects/demo/pipeline/rhythm");
  publisher.write(".cache/rhythm-evidence/demo/key/source.bin", Buffer.from("owned"));
  const pin = publisher.publish(
    "public/projects/demo/pipeline/rhythm/data.evidence.json",
    Buffer.from("{}"),
    ".cache/rhythm-evidence/demo/key/report-staged.json",
  );
  assert.equal(readFileSync(path.join(root, pin.path), "utf8"), "{}");
  assert.throws(() => publisher.write(pin.path, Buffer.from("replace")), /already exists/);
  context.assertUnchanged();
  publisher.cleanup();
  assert.equal(publisher.publicationOccurred, true);
  assert.equal(readFileSync(path.join(root, pin.path), "utf8"), "{}");
});
test("publisher rejects unexpected membership without refreshing it and never cleans replaced foreign bytes", (t) => {
  const root = folder(t),
    context = new RhythmReadContext(root),
    publisher = new RhythmPublisher(context, "demo", 1024);
  publisher.directory(".cache/rhythm-evidence/demo/key");
  const pin = publisher.write(".cache/rhythm-evidence/demo/key/source.bin", Buffer.from("owned"));
  writeFileSync(path.join(root, ".cache/rhythm-evidence/demo/key/foreign.bin"), "unrelated");
  assert.throws(() => publisher.write(".cache/rhythm-evidence/demo/key/new.bin", Buffer.from("new")), /membership/);
  writeFileSync(path.join(root, pin.path), "foreign replacement");
  assert.throws(() => publisher.cleanup(), /changed/);
  assert.equal(readFileSync(path.join(root, pin.path), "utf8"), "foreign replacement");
});
test("publisher enforces private directory/aggregate/single preparation caps and nonregular aliases", (t) => {
  const root = folder(t),
    context = new RhythmReadContext(root),
    publisher = new RhythmPublisher(context, "demo", 5);
  publisher.directory(".cache/rhythm-evidence/demo");
  assert.throws(() => publisher.write(".cache/rhythm-evidence/demo/large.bin", Buffer.alloc(6)), /artifact byte bound/);
  for (let i = 0; i < 32; i++) mkdirSync(path.join(root, `.cache/rhythm-evidence/demo/${i}`));
  assert.throws(() => publisher.checkCapacity(0, 1), /capacity/);
  symlinkSync("/missing", path.join(root, ".cache/rhythm-evidence/demo/bad"));
  assert.throws(() => publisher.checkCapacity(), /alias/);
});
test("owned trusted fake process success/nonzero/credential sanitized, never installed tool invocation", async () => {
  const result = await fake(
    "process.stdout.write(JSON.stringify({credential:process.env.FAL_KEY??null}));process.stderr.write('small');",
  );
  assert.deepEqual(JSON.parse(result.stdout.toString()), { credential: null });
  assert.equal(result.stderrBytes, 5);
  await assert.rejects(fake("process.stderr.write('bad');process.exit(7)"), /failed.*7.*bad/);
});
test("owned fake stdout/stderr caps, stall, total deadline and already-cancelled launch settle", async () => {
  await assert.rejects(fake("process.stdout.write('x'.repeat(8192))"), /stdout/);
  await assert.rejects(fake("process.stderr.write('x'.repeat(8192))"), /stderr/);
  await assert.rejects(fake("setInterval(()=>{},1000)", { ...bounds, stallMs: 80 }), /stalled/);
  await assert.rejects(
    fake("setInterval(()=>process.stdout.write('a'),20)", { ...bounds, timeoutMs: 120, stallMs: 1000 }),
    /deadline/,
  );
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => fake("", { ...bounds, signal: controller.signal }), /before spawn/);
});
test("abort after finite exact fixture readiness reaps late TERM descendant and leaves unrelated process alive", async (t) => {
  const root = folder(t),
    receipt = path.join(root, "child.txt"),
    ready = path.join(root, "ready.json"),
    controller = new AbortController(),
    nonce = (await import("node:crypto")).randomUUID();
  const unrelated = (await import("node:child_process")).spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore",
  });
  t.after(() => unrelated.kill("SIGKILL"));
  const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(receipt)},String(c.pid));});fs.writeFileSync(${JSON.stringify(ready + ".tmp")},JSON.stringify({version:1,nonce:${JSON.stringify(nonce)},pid:process.pid,ppid:process.ppid}),{flag:'wx'});fs.linkSync(${JSON.stringify(ready + ".tmp")},${JSON.stringify(ready)});fs.unlinkSync(${JSON.stringify(ready + ".tmp")});setInterval(()=>process.stdout.write('a'),20);`;
  const promise = fake(code, { ...bounds, signal: controller.signal });
  const settled = promise.then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  let readinessTimer: ReturnType<typeof setInterval> | undefined, deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const poll = () => {
        try {
          const consumed = new RhythmReadContext(root).optional("ready.json", 1024);
          if (!consumed) return;
          const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(consumed.bytes));
          assert.deepEqual(Object.keys(value).sort(), ["nonce", "pid", "ppid", "version"]);
          assert.equal(value.version, 1);
          assert.equal(value.nonce, nonce);
          assert.equal(value.ppid, process.pid);
          assert.ok(Number.isSafeInteger(value.pid) && value.pid > 0);
          resolve();
        } catch (error) {
          reject(error);
        }
      };
      readinessTimer = setInterval(poll, 20);
      deadline = setTimeout(() => reject(Error("Own TERM fixture readiness deadline")), 1500);
      poll();
    });
    clearInterval(readinessTimer);
    clearTimeout(deadline);
    controller.abort();
    const result = await settled;
    assert.ok("error" in result);
    assert.match(String(result.error), /cancelled/);
    process.kill(unrelated.pid!, 0);
    const child = Number(readFileSync(receipt, "utf8"));
    assert.throws(
      () => process.kill(child, 0),
      (e: any) => e.code === "ESRCH",
    );
  } finally {
    clearInterval(readinessTimer);
    clearTimeout(deadline);
    controller.abort();
    await settled;
  }
});
test("missing trusted installation resolver reports unavailable without execution/download", () => {
  const old = process.env.PATH;
  process.env.PATH = "/definitely-missing-rhythm-tools";
  try {
    assert.throws(() => resolveRhythmTool("ffmpeg"), /unavailable/);
  } finally {
    process.env.PATH = old;
  }
});
test("complete preparation with explicitly fake trusted subprocess pins snapshot/commit/readback and refuses repeated publication", async (t) => {
  if (macOsOnly(t)) return;
  const root = folder(t),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const { AssetRecordSchema } = await import("../src/types/assets"),
    { createHash } = await import("node:crypto"),
    { prepareRhythmEvidenceForTrustedTests } = await import("../src/lib/audio/rhythm-preparation"),
    { readRhythmEvidence } = await import("../src/lib/audio/rhythm-evidence");
  const bytes = Buffer.from("fake source DATA; never WAV decoded"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    original = `projects/demo/assets/imported/${sha}.wav`;
  mkdirSync(path.dirname(path.join(root, "public", original)), { recursive: true });
  writeFileSync(path.join(root, "public", original), bytes);
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: `sha256:${sha}`,
    hash: sha,
    revision: 1,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "audio",
    files: { original, bytes: bytes.length, mime: "audio/wav" },
    media: { durationSec: 1, timebase: "1/16000", sampleRate: 16000, channels: 1, codec: "pcm_s16le", hasAudio: true },
    provenance: { origin: "manual", tool: "explicit fake DATA test, not codec acceptance" },
    rights: {},
    entityLinks: [],
    status: "candidate",
  });
  writeFileSync(path.join(project, "project.json"), "{}");
  writeFileSync(
    path.join(project, "pipeline/asset-registry.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, assets: [asset] }),
  );
  const request = {
      version: 1,
      contract: "source-rhythm-evidence-v1",
      projectId: "demo",
      assetId: asset.id,
      assetSha256: sha,
      profile: "rms-onset-v1-mono16k",
    },
    m = metadata();
  let calls = 0;
  const tool = fakeTool(t),
    host = {
      resolve: () => tool,
      run: async (_name: any, _file: any, args: string[], b: any) => {
        calls++;
        if (!args.includes("-version")) {
          assert.equal(args[args.indexOf("-f") + 1], "wav", "fixed WAV demuxer, never playlist autodetection");
          assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
        }
        const body = args.includes("-version")
          ? "process.stdout.write('FAKE trusted Node DATA fixture, not FFmpeg');"
          : args.includes("-show_frames")
            ? `process.stdout.write(${JSON.stringify(JSON.stringify({ frames: m.frames }))});`
            : args.includes("-show_streams")
              ? `process.stdout.write(${JSON.stringify(JSON.stringify({ streams: m.streams }))});`
              : "process.stdout.write(Buffer.alloc(16000*4));";
        return runRhythmOwnedProcess(process.execPath, ["-e", body], b);
      },
    };
  const result = await prepareRhythmEvidenceForTrustedTests(root, request, host);
  assert.equal(calls, 5);
  assert.equal(result.evidence.analysis.tempoBpm, null);
  assert.equal(result.evidence.apiCalls, 0);
  assert.deepEqual(readFileSync(path.join(root, result.evidence.artifacts.originalSnapshot!.path)), bytes);
  assert.deepEqual(readRhythmEvidence(root, "demo", result.file, result.sha256, result.runtime), result.evidence);
  const saved = readFileSync(path.join(project, result.file));
  for (const pin of [result.evidence.artifacts.originalSnapshot!, result.evidence.artifacts.commit!]) {
    const file = path.join(root, pin.path),
      original = readFileSync(file);
    writeFileSync(file, "altered DATA");
    assert.throws(() => readRhythmEvidence(root, "demo", result.file, result.sha256, result.runtime));
    writeFileSync(file, original);
  }
  assert.equal(
    readdirSync(path.join(root, ".cache/rhythm-evidence/demo")).some((n) => n.startsWith(".staging")),
    false,
  );
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(root, request, host), /already exists/);
  assert.deepEqual(readFileSync(path.join(project, result.file)), saved);
  assert.equal(
    readdirSync(path.join(root, ".cache/rhythm-evidence/demo")).some((n) => n.startsWith(".staging")),
    false,
  );
  const lease = path.join(root, ".cache/rhythm-evidence/demo/.preparation-lock");
  writeFileSync(lease, "foreign lease");
  const before = calls;
  await assert.rejects(prepareRhythmEvidenceForTrustedTests(root, request, host), /already exists/);
  assert.equal(calls, before);
  assert.equal(readFileSync(lease, "utf8"), "foreign lease");
});
test("exact staging retirement retains other files and output cannot bypass literal path bounds", (t) => {
  const root = folder(t),
    context = new RhythmReadContext(root),
    publisher = new RhythmPublisher(context, "demo", 1024);
  publisher.directory(".cache/rhythm-evidence/demo/staging");
  const pin = publisher.write(".cache/rhythm-evidence/demo/staging/source.bin", Buffer.from("owned"));
  context.check(pin, 1024);
  publisher.retire(pin.path);
  publisher.retireDirectory(".cache/rhythm-evidence/demo/staging");
  context.assertUnchanged();
  assert.throws(() => publisher.directory("../outside"), /literal path/);
  publisher.cleanup();
});
test("captured consumed file identity rejects restore-to-identical bytes after intervening writes", (t) => {
  const root = folder(t),
    file = "data.json";
  writeFileSync(path.join(root, file), "{}");
  const context = new RhythmReadContext(root);
  context.json(file, 1024);
  writeFileSync(path.join(root, file), "changed");
  writeFileSync(path.join(root, file), "{}");
  assert.throws(() => context.assertUnchanged(), /pin changed/);
});

test("production ownership selection follows exact stable birth across exec but refuses recycled/foreign identities", () => {
  const text = " 101 10 Mon Oct 12 08:00:00 2026 /usr/bin/sandbox-exec\n 102 101 Mon Oct 12 08:00:01 2026 /bin/child";
  const rows = parseRhythmProcessRows(text);
  assert.equal(rows.length, 2);
  const owned = captureRhythmOwned(rows, [], { pid: 101, parentPid: 10, live: true });
  assert.deepEqual(
    owned.map((r) => r.pid),
    [101, 102],
  );
  const after = rows.map((r) => ({ ...r, command: r.pid === 101 ? "/trusted/ffmpeg" : r.command })),
    updated = captureRhythmOwned(after, owned, { pid: 101, parentPid: 10, live: true }),
    selection = selectRhythmSignalTargets(after, updated, { pid: 101, live: true });
  assert.equal(updated[0].start, owned[0].start);
  assert.equal(updated[0].command, "/trusted/ffmpeg");
  assert.deepEqual(
    selection.targets.map((r) => r.pid),
    [102, 101],
  );
  assert.equal(selection.groupPid, 101);
  const recycled = after.map((r) => ({ ...r, start: "Mon Oct 12 08:10:00 2026" }));
  const denied = captureRhythmOwned(recycled, updated, { pid: 101, parentPid: 10, live: true });
  assert.equal(denied[0].start, owned[0].start);
  assert.deepEqual(selectRhythmSignalTargets(recycled, denied, { pid: 101, live: true }), {
    targets: [],
    groupPid: null,
  });
  const foreign = [{ ...after[0], pid: 999, ppid: 10 }];
  assert.deepEqual(selectRhythmSignalTargets(foreign, updated, { pid: 101, live: true }), {
    targets: [],
    groupPid: null,
  });
  assert.deepEqual(captureRhythmOwned([{ ...rows[0], ppid: 999 }], [], { pid: 101, parentPid: 10, live: true }), []);
  assert.equal(selectRhythmSignalTargets(after, updated, { pid: 101, live: false }).groupPid, null);
});
test("known reparented descendant exec stays owned but a new birth under known root cannot reuse captured PID", () => {
  const rows = [
      { pid: 101, ppid: 10, start: "A", command: "root" },
      { pid: 102, ppid: 101, start: "B", command: "child" },
    ],
    owned = captureRhythmOwned(rows, [], { pid: 101, parentPid: 10, live: true }),
    live = [
      { ...rows[1], ppid: 1, command: "exec-child" },
      { pid: 103, ppid: 102, start: "C", command: "late-child" },
    ];
  const updated = captureRhythmOwned(live, owned, { pid: 101, parentPid: 10, live: false });
  assert.deepEqual(
    selectRhythmSignalTargets(live, updated, { pid: 101, live: false }).targets.map((r) => r.pid),
    [103, 102],
  );
  const changed = [rows[0], { ...rows[1], start: "different" }];
  const unchanged = captureRhythmOwned(changed, owned, { pid: 101, parentPid: 10, live: true });
  assert.equal(unchanged.find((r) => r.pid === 102)!.start, "B");
  assert.deepEqual(
    selectRhythmSignalTargets(changed, unchanged, { pid: 101, live: true }).targets.map((r) => r.pid),
    [101],
  );
});

test("post-publication lease-finally refusal reports durable uncertainty and retains exact output/foreign lease", async (t) => {
  if (macOsOnly(t)) return;
  const root = folder(t),
    project = path.join(root, "public/projects/demo");
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  const { AssetRecordSchema } = await import("../src/types/assets"),
    { createHash } = await import("node:crypto"),
    { prepareRhythmEvidenceForTrustedTests } = await import("../src/lib/audio/rhythm-preparation"),
    { readRhythmEvidence } = await import("../src/lib/audio/rhythm-evidence");
  const bytes = Buffer.from("fake source DATA; never WAV decoded"),
    sha = createHash("sha256").update(bytes).digest("hex"),
    original = `projects/demo/assets/imported/${sha}.wav`;
  mkdirSync(path.dirname(path.join(root, "public", original)), { recursive: true });
  writeFileSync(path.join(root, "public", original), bytes);
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: `sha256:${sha}`,
    hash: sha,
    revision: 1,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "audio",
    files: { original, bytes: bytes.length, mime: "audio/wav" },
    media: { durationSec: 1, timebase: "1/16000", sampleRate: 16000, channels: 1, codec: "pcm_s16le", hasAudio: true },
    provenance: { origin: "manual", tool: "explicit fake DATA test, not codec acceptance" },
    rights: {},
    entityLinks: [],
    status: "candidate",
  });
  writeFileSync(path.join(project, "project.json"), "{}");
  writeFileSync(
    path.join(project, "pipeline/asset-registry.json"),
    JSON.stringify({ schemaVersion: 1, revision: 1, assets: [asset] }),
  );
  const request = {
      version: 1,
      contract: "source-rhythm-evidence-v1",
      projectId: "demo",
      assetId: asset.id,
      assetSha256: sha,
      profile: "rms-onset-v1-mono16k",
    },
    m = metadata();
  let calls = 0;
  const tool = fakeTool(t),
    host = {
      resolve: () => tool,
      run: async (_name: any, _file: any, args: string[], b: any) => {
        calls++;
        if (!args.includes("-version")) {
          assert.equal(args[args.indexOf("-f") + 1], "wav", "fixed WAV demuxer, never playlist autodetection");
          assert.equal(args[args.indexOf("-protocol_whitelist") + 1], "file,pipe");
        }
        const body = args.includes("-version")
          ? "process.stdout.write('FAKE trusted Node DATA fixture, not FFmpeg');"
          : args.includes("-show_frames")
            ? `process.stdout.write(${JSON.stringify(JSON.stringify({ frames: m.frames }))});`
            : args.includes("-show_streams")
              ? `process.stdout.write(${JSON.stringify(JSON.stringify({ streams: m.streams }))});`
              : "process.stdout.write(Buffer.alloc(16000*4));";
        return runRhythmOwnedProcess(process.execPath, ["-e", body], b);
      },
    };
  const fs = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module"),
    originalLink = fs.default.linkSync;
  let publishedFile: string | undefined, publishedBytes: Buffer | undefined, retainedFd: number | undefined;
  const lease = path.join(root, ".cache/rhythm-evidence/demo/.preparation-lock");
  fs.default.linkSync = ((from: any, to: any) => {
    const result = originalLink(from, to);
    if (String(to).startsWith(project) && String(to).endsWith(".evidence.json")) {
      publishedFile = String(to);
      publishedBytes = readFileSync(publishedFile);
      retainedFd = fs.openSync(lease, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
      const before = fs.fstatSync(retainedFd);
      fs.unlinkSync(lease);
      writeFileSync(lease, "foreign lease retained");
      assert.notEqual(fs.lstatSync(lease).ino, before.ino);
    }
    return result;
  }) as typeof originalLink;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      prepareRhythmEvidenceForTrustedTests(root, request, host),
      /lease cleanup.*immutable output publication occurred.*verify pinned output before retry/,
    );
  } finally {
    fs.default.linkSync = originalLink;
    syncBuiltinESMExports();
    if (retainedFd !== undefined) fs.closeSync(retainedFd);
  }
  assert.ok(publishedFile && publishedBytes);
  assert.equal(calls, 5);
  assert.deepEqual(readFileSync(publishedFile), publishedBytes);
  assert.equal(readFileSync(lease, "utf8"), "foreign lease retained");
  const evidence = JSON.parse(publishedBytes.toString()),
    pinSha = createHash("sha256").update(publishedBytes).digest("hex"),
    runtime = {
      artifactMetadata: evidence.runtime.artifactMetadata,
      ffmpeg: { file: tool, version: "FAKE trusted Node DATA fixture, not FFmpeg" },
      ffprobe: { file: tool, version: "FAKE trusted Node DATA fixture, not FFmpeg" },
    };
  assert.deepEqual(readRhythmEvidence(root, "demo", path.relative(project, publishedFile), pinSha, runtime), evidence);
  for (const pin of [
    evidence.artifacts.originalSnapshot,
    evidence.artifacts.commit,
    evidence.artifacts.clock,
    evidence.artifacts.pcm,
  ])
    assert.equal(
      createHash("sha256")
        .update(readFileSync(path.join(root, pin.path)))
        .digest("hex"),
      pin.sha256,
    );
});
