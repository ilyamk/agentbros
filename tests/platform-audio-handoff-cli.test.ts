import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import cp, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  superviseHandoffProcess,
  runPlatformAudioHandoff,
  HandoffWorkerError,
  HandoffJobSchema,
} from "../src/lib/delivery/platform-audio-handoff-supervisor";
import { readHandoffWorkerInputs } from "../src/lib/delivery/platform-audio-handoff-worker";
import { platformFixture, now } from "./platform-audio-fixtures";
import { HandoffOwnership, parseHandoffProcesses } from "../src/lib/delivery/platform-audio-handoff-ownership";
const start = "Mon Oct 12 08:00:00 2026",
  pid = 987654;
let alive = true;
const rows = () => (alive ? [{ pid, parent: process.pid, start }] : []);
const job = { request: "request.json", snapshot: "snapshot.json" };
function fake(nonce: string, mode = "success") {
  alive = true;
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: PassThrough;
    stderr: PassThrough;
    connected: boolean;
    kill: (s: NodeJS.Signals) => boolean;
    send: (m: unknown, cb?: (e: Error | null) => void) => boolean;
    disconnect: () => void;
    unref: () => void;
    signals: NodeJS.Signals[];
  };
  Object.assign(child, { pid, stdout: new PassThrough(), stderr: new PassThrough(), connected: true, signals: [] });
  child.on("close", () => {
    alive = false;
  });
  child.unref = () => {};
  child.disconnect = () => {
    child.connected = false;
  };
  child.kill = (s) => {
    child.signals.push(s);
    if (mode !== "hang") queueMicrotask(() => child.emit("close", null, s));
    return true;
  };
  child.send = (_message, cb) => {
    cb?.(null);
    if (mode === "hang") return true;
    if (mode === "repeat") {
      queueMicrotask(() => child.emit("message", { type: "ready", nonce, pid }));
      return true;
    }
    queueMicrotask(() => {
      if (mode === "pipeerror") child.stdout.emit("error", Error("fixture pipe error"));
      else if (mode === "overflow") child.stdout.write(Buffer.alloc(1024 * 1024 + 1));
      else if (mode === "stderr") child.stderr.write(Buffer.alloc(1024 * 1024 + 1));
      else
        child.stdout.write(
          JSON.stringify(
            mode === "unprotected"
              ? { ok: true, productionReady: true }
              : {
                  ok: true,
                  productionReady: false,
                  state: "draft-needs-review",
                  status: "pending-manual",
                  marker: "local",
                  packetId: "0".repeat(64),
                  sha256: "0".repeat(64),
                  recovered: false,
                },
          ) + "\n",
        );
      child.connected = false;
      child.emit("disconnect");
      child.emit("close", 0, null);
    });
    return true;
  };
  queueMicrotask(() => child.emit("message", { type: "ready", nonce: mode === "forged" ? "wrong" : nonce, pid }));
  return child;
}
const dependencies = { inventory: rows, signal: () => {}, workMs: 100, cleanupMs: 20 };
test("private supervisor reaches actual registration/start and accepts guarded single result after disconnect/close", async () => {
  let sent = 0;
  const r = await superviseHandoffProcess(
    (n) => {
      const c = fake(n);
      const old = c.send;
      c.send = (m, cb) => {
        sent++;
        assert.equal((m as { type: string }).type, "start");
        assert.equal((m as { parentPid: number }).parentPid, process.pid);
        return old(m, cb);
      };
      return c as unknown as ChildProcess;
    },
    job,
    dependencies,
  );
  assert.equal(sent, 1);
  assert.equal(r.productionReady, false);
});
test("forged/repeated registration, stream overflow and unguarded success fail closed", async () => {
  for (const mode of ["forged", "repeat", "overflow", "stderr", "unprotected", "pipeerror"])
    await assert.rejects(
      superviseHandoffProcess((n) => fake(n, mode) as unknown as ChildProcess, job, dependencies),
      HandoffWorkerError,
    );
});
test("deadline has finite cleanup, uncertain publication and no replay even worker ignores signals", async () => {
  let launches = 0;
  const signals: NodeJS.Signals[] = [];
  await assert.rejects(
    superviseHandoffProcess(
      (n) => {
        launches++;
        return fake(n, "hang") as unknown as ChildProcess;
      },
      job,
      { ...dependencies, workMs: 10, cleanupMs: 10, signal: (_pid, s) => signals.push(s) },
    ),
    (e: unknown) => e instanceof HandoffWorkerError && e.code === "TIMEOUT" && e.publication === "unknown",
  );
  assert.equal(launches, 1);
  assert.equal(signals[0], "SIGTERM");
  assert.ok(signals.includes("SIGKILL"));
});
test("inventory unavailable and wrong initial parent cannot authorize tool work", async () => {
  for (const inventory of [
    () => {
      throw Error("inventory unavailable");
    },
    () => [{ pid, parent: process.pid + 1, start }],
  ])
    await assert.rejects(
      superviseHandoffProcess((n) => fake(n) as unknown as ChildProcess, job, { ...dependencies, inventory }),
      HandoffWorkerError,
    );
});
test("stable PID/start owns exec-renamed and reparented descendants, refuses PID reuse and unrelated rows", () => {
  alive = true;
  const o = new HandoffOwnership();
  o.register(pid, process.pid, rows());
  o.capture([...rows(), { pid: pid + 1, parent: pid, start }]);
  assert.deepEqual(
    o
      .targets([
        { pid, parent: 1, start },
        { pid: pid + 1, parent: 1, start },
        { pid: 42, parent: 1, start },
      ])
      .map((x) => x.pid),
    [pid + 1, pid],
  );
  assert.deepEqual(
    o.targets([
      { pid, parent: process.pid, start: start.replace("00:00", "00:01") },
      { pid: 42, parent: 1, start },
    ]),
    [],
  );
  const raw = ` ${pid} ${process.pid} ${start}\n`;
  assert.deepEqual(parseHandoffProcesses(raw), rows());
  assert.throws(() => parseHandoffProcesses(raw + "node"));
  assert.throws(() => parseHandoffProcesses("x".repeat(1024 * 1024 + 1)));
  assert.throws(() => new HandoffOwnership().register(pid, 99, rows()));
});
test("fixed production factory uses sandbox/closed argv/no inherited keys and no configurable worker", async () => {
  if (process.platform !== "darwin") return;
  const originalSpawn = cp.spawn,
    originalSync = cp.spawnSync;
  let launches = 0;
  let captured: unknown[] = [];
  cp.spawn = ((...args: unknown[]) => {
    launches++;
    captured = args;
    const argv = args[1] as string[];
    return fake(argv.at(-1)!);
  }) as unknown as typeof cp.spawn;
  cp.spawnSync = ((...args: unknown[]) => {
    assert.equal(args[0], "/bin/ps");
    assert.deepEqual(args[1], ["-axo", "pid=,ppid=,lstart="]);
    return {
      pid: 987650,
      signal: null,
      status: 0,
      stdout: alive ? ` ${pid} ${process.pid} ${start}\n` : "",
      stderr: "",
    };
  }) as typeof cp.spawnSync;
  syncBuiltinESMExports();
  try {
    await runPlatformAudioHandoff({ ...job, project: "demo" });
    assert.equal(launches, 1);
    assert.equal(captured[0], "/usr/bin/sandbox-exec");
    const argv = captured[1] as string[];
    assert.equal(argv[1], '(version 1)(allow default)(deny network*)(deny file-read* (regex #"/[.]env([.][^/]*)?$"))');
    assert.ok(argv[5].endsWith("platform-audio-handoff-worker.ts"));
    const opts = captured[2] as { env: Record<string, string>; shell: boolean; detached: boolean };
    assert.deepEqual(Object.keys(opts.env).sort(), ["HOME", "LC_ALL", "PATH", "TMPDIR"]);
    assert.equal(opts.shell, false);
    assert.equal(opts.detached, true);
    assert.equal(opts.env.HOME, "/var/empty");
    assert.throws(() => HandoffJobSchema.parse({ ...job, executable: "/bin/sh" }));
    assert.throws(() => HandoffJobSchema.parse({ ...job, recover: "../marker" }));
    assert.throws(() => HandoffJobSchema.parse({ ...job, request: "public/projects/demo/.env" }));
    assert.equal(HandoffJobSchema.parse({ ...job, project: "Old_Project" }).project, "Old_Project");
  } finally {
    cp.spawn = originalSpawn;
    cp.spawnSync = originalSync;
    syncBuiltinESMExports();
  }
});
test("actual CLI rejects scoped/recovery caller error before reading writerless FIFO or starting worker, one JSON only", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "native-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fifo = path.join(root, "request");
  assert.equal(cp.spawnSync("/usr/bin/mkfifo", [fifo], { timeout: 1000 }).status, 0);
  const guard = path.join(root, "guard.cjs");
  fs.writeFileSync(
    guard,
    `const fs=require('node:fs'),cp=require('node:child_process');const read=fs.readFileSync;fs.readFileSync=function(file,...a){if(String(file)===${JSON.stringify(fifo)}||String(file).endsWith('/.env'))throw Error('Forbidden caller read');return read.call(this,file,...a);};cp.spawn=()=>{throw Error('Unexpected worker launch');};require('node:module').syncBuiltinESMExports();`,
  );
  for (const tail of [
    ["--project", "../invalid"],
    ["--recover", "../marker"],
  ]) {
    const r = cp.spawnSync(
      process.execPath,
      [
        "--require",
        guard,
        "--import",
        "tsx",
        "scripts/delivery.ts",
        "--action",
        "handoff",
        "--request",
        fifo,
        "--snapshot",
        "absent",
        ...tail,
      ],
      {
        encoding: "utf8",
        timeout: SPAWN_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: "/opt/homebrew/bin:/usr/bin:/bin",
          HOME: "/var/empty",
          TMPDIR: "/private/tmp",
        },
      },
    );
    assert.equal(r.error, undefined);
    assert.equal(r.status, 1, r.stderr);
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const v = JSON.parse(lines[0]);
    assert.equal(v.ok, false);
    assert.equal(v.error, "VALIDATION");
    assert.ok(!v.message.includes("Forbidden caller read") && !v.message.includes("Unexpected worker launch"));
  }
});

test("actual worker input contract binds project and same consumed request/snapshot; no client manifest or Boolean authority", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "native-worker-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = platformFixture(root),
    request = path.join(root, "request.json"),
    snapshot = path.join(f.project, "pipeline/snapshot.json");
  fs.writeFileSync(request, JSON.stringify(f.request));
  fs.writeFileSync(
    snapshot,
    JSON.stringify({ version: 1, projectId: "demo", id: "0".repeat(64), createdAt: now, identities: [f.identity] }),
  );
  assert.throws(() => readHandoffWorkerInputs(root, { request, snapshot, project: "other" }), /Scoped project/);
  const inputs = readHandoffWorkerInputs(root, { request, snapshot, project: "demo" });
  assert.equal(inputs.request.projectId, "demo");
  inputs.inputPins();
  fs.writeFileSync(request, JSON.stringify({ ...f.request, fontContext: "public/projects/demo/fonts.json" }));
  assert.throws(
    () => readHandoffWorkerInputs(root, { request, snapshot, recover: "0".repeat(64) }),
    (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
  );
  fs.writeFileSync(request, JSON.stringify(f.request));
  const changedSnapshot = JSON.parse(fs.readFileSync(snapshot, "utf8"));
  changedSnapshot.identities[0].sources.push({ path: "src/.env", sha256: "0".repeat(64), role: "code" });
  fs.writeFileSync(snapshot, JSON.stringify(changedSnapshot));
  assert.throws(() => readHandoffWorkerInputs(root, { request, snapshot }), /Environment files/);
  fs.writeFileSync(
    snapshot,
    JSON.stringify({ version: 1, projectId: "demo", id: "0".repeat(64), createdAt: now, identities: [f.identity] }),
  );
  fs.appendFileSync(request, " ");
  assert.throws(() => inputs.inputPins(), /changed/);
  assert.throws(() => readHandoffWorkerInputs(root, { request, snapshot, check: true }));
  assert.throws(() => readHandoffWorkerInputs(root, { request, snapshot, manifest: { productionReady: true } }));
  fs.writeFileSync(request, JSON.stringify({ ...f.request, platformAudioPlacement: undefined }));
  assert.throws(() => readHandoffWorkerInputs(root, { request, snapshot }), /Explicit supported/);
});

test("cancellation before spawn creates no child; explicit abort after authenticated start cancels one owned worker without replay", async () => {
  const before = new AbortController();
  before.abort();
  let launches = 0;
  await assert.rejects(
    superviseHandoffProcess(
      (n) => {
        launches++;
        return fake(n) as unknown as ChildProcess;
      },
      job,
      { ...dependencies, abort: before.signal },
    ),
    (e) => e instanceof HandoffWorkerError && e.publication === "not-started",
  );
  assert.equal(launches, 0);
  const after = new AbortController();
  await assert.rejects(
    superviseHandoffProcess(
      (n) => {
        launches++;
        const c = fake(n, "hang");
        queueMicrotask(() => after.abort());
        return c as unknown as ChildProcess;
      },
      job,
      { ...dependencies, workMs: 1000, cleanupMs: 20, abort: after.signal },
    ),
    (e) => e instanceof HandoffWorkerError && e.code === "TIMEOUT" && e.publication === "unknown",
  );
  assert.equal(launches, 1);
});

test("font recovery with missing snapshot refuses before QA and any filesystem write", (t) => {
  const root = fs.mkdtempSync(path.join(tmpdir(), "native-readonly-font-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = platformFixture(root),
    request = path.join(root, "request.json");
  fs.writeFileSync(request, JSON.stringify({ ...f.request, fontContext: "public/projects/demo/font-context.json" }));
  const originals = {
    writeFileSync: fs.writeFileSync,
    writeSync: fs.writeSync,
    mkdirSync: fs.mkdirSync,
    linkSync: fs.linkSync,
    renameSync: fs.renameSync,
    unlinkSync: fs.unlinkSync,
  };
  let writes = 0;
  for (const key of Object.keys(originals))
    (fs as unknown as Record<string, unknown>)[key] = () => {
      writes++;
      throw Error("Font recovery write forbidden");
    };
  syncBuiltinESMExports();
  try {
    assert.throws(
      () => readHandoffWorkerInputs(root, { request, snapshot: "does-not-exist", recover: "0".repeat(64) }),
      /escapes scope/,
    );
    assert.throws(
      () =>
        readHandoffWorkerInputs(root, {
          request,
          snapshot: path.join(f.project, "does-not-exist"),
          recover: "0".repeat(64),
        }),
      (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT",
    );
    assert.equal(writes, 0);
    assert.equal(fs.existsSync(path.join(root, ".cache")), false);
  } finally {
    Object.assign(fs, originals);
    syncBuiltinESMExports();
  }
});
