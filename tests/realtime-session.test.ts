import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
  realpathSync,
  symlinkSync,
  truncateSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync, spawn } from "node:child_process";
import WebSocket, { WebSocketServer } from "ws";
import { encode, decode } from "@msgpack/msgpack";
import { createFalRealtimeTokenProvider } from "../src/lib/providers/fal-realtime-token";
import { planRealtimeSession, runRealtimeSession, type RealtimeSessionRequest } from "../src/lib/realtime/session";
import { digest } from "../src/lib/jobs/model-artifacts";
import { OperationStore } from "../src/lib/jobs/store";
import { claimOperationWork } from "../src/lib/jobs/work-lease";
const mediaRoot = mkdtempSync(path.join(tmpdir(), "realtime-media-"));
test.after(() =>
  rmSync(mediaRoot, {
    recursive: true,
    force: true,
  }),
);
const imageFile = path.join(mediaRoot, "frame.png");
const imageRun = spawnSync(
  "ffmpeg",
  ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", "-y", imageFile],
  {
    encoding: "utf8",
  },
);
assert.equal(imageRun.status, 0, imageRun.stderr);
const image = readFileSync(imageFile);
function fixture(t: test.TestContext, cap = 2) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "realtime-project-")));
  t.after(() =>
    rmSync(root, {
      recursive: true,
      force: true,
    }),
  );
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, {
    recursive: true,
  });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new OperationStore("demo", {
    directory: path.join(project, "pipeline"),
  });
  store.configure(
    {
      ceilingUsd: cap,
      maxJobUsd: cap,
      repairReserveFraction: 0,
      maxPaidAttemptsPerAsset: 2,
    },
    USER_GRANT,
  );
  const request: RealtimeSessionRequest = {
    version: 1,
    projectId: "demo",
    sessionId: "session",
    revisionId: "frame-1",
    operation: {
      family: "flux-2",
      variant: "klein",
      operation: "realtime",
      transport: "realtime",
      input: {
        image_url: `data:image/png;base64,${image.toString("base64")}`,
        seed: 35,
      },
    },
    quote: {
      currency: "USD",
      lowUsd: 0,
      expectedUsd: 0.2,
      highUsd: 0.5,
      bounded: true,
      confidence: "user-bound",
      source: "explicit offline test session cap, not provider enforcement",
      asOf: "2026-10-11",
    },
    limits: {
      maxFrames: 2,
      maxInputBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxControls: 4,
      timeoutMs: 2000,
    },
  };
  return {
    root,
    project,
    store,
    request,
  };
}
async function server(t: test.TestContext, handler: (socket: WebSocket, input: any) => void) {
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: 1024 * 1024,
  });
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  let connections = 0;
  const url = `ws://127.0.0.1:${
    (
      server.address() as {
        port: number;
      }
    ).port
  }`;
  server.on("connection", (socket) => {
    connections++;
    socket.on("message", (bytes) => handler(socket, decode(Buffer.from(bytes as ArrayBuffer))));
  });
  return {
    url,
    get connections() {
      return connections;
    },
    socketFactory: (remote: string, maxPayload: number) => {
      assert.match(
        remote,
        /^wss:\/\/fal.run\/fal-ai\/flux-2\/klein\/realtime\?fal_jwt_token=secret-token&max_buffering=1$/,
      );
      return new WebSocket(url, {
        maxPayload,
        perMessageDeflate: false,
      });
    },
  };
}
const result = (seed = 35, frames = 1) => ({
  seed,
  images: Array.from(
    {
      length: frames,
    },
    () => ({
      content: new Uint8Array(image),
      width: 32,
      height: 32,
      content_type: "image/png",
    }),
  ),
});
test("actual loopback MessagePack produces decoded immutable candidate frames and journal without auth secrets", async (t) => {
  const f = fixture(t);
  let payload: any;
  const s = await server(t, (socket, input) => {
    payload = input;
    socket.send(encode(result()));
  });
  let tokens = 0;
  const r = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => {
      tokens++;
      return "secret-token";
    },
    socketFactory: s.socketFactory,
  });
  assert.equal(r.metadata.state, "published");
  assert.equal(s.connections, 1);
  assert.equal(tokens, 1);
  assert.equal(payload.image_url, f.request.operation.input.image_url);
  assert.equal(payload.sessionId, undefined);
  assert.equal(payload.revisionId, undefined);
  assert.equal(f.store.summary().reservedUsd, 0.5);
  assert.equal(f.store.snapshot().jobs["realtime:session"].paidAttempts, 1);
  const manifest = JSON.parse(readFileSync(r.outputs[0], "utf8"));
  assert.equal(manifest.frames[0].width, 32);
  assert.equal(manifest.provenance.providerAck, false);
  const dirs = path.join(f.root, ".cache/realtime/demo");
  for (const folder of readdirSync(dirs))
    for (const file of readdirSync(path.join(dirs, folder)))
      if (file.endsWith(".json"))
        assert.ok(!readFileSync(path.join(dirs, folder, file), "utf8").includes("secret-token"));
  const resumed = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => {
      throw new Error("must not auth on published resume");
    },
  });
  assert.equal(resumed.metadata.state, "published");
  assert.equal(s.connections, 1);
});
test("interpolated chronological frames are bounded and publication intent cannot change on resume", async (t) => {
  const f = fixture(t);
  f.request.operation.input.enable_interpolation = true;
  const s = await server(t, (socket) => socket.send(encode(result(35, 2))));
  const r = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => "secret-token",
    socketFactory: s.socketFactory,
  });
  assert.equal(JSON.parse(readFileSync(r.outputs[0], "utf8")).frames.length, 2);
  f.request.revisionId = "changed";
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => "secret-token",
        socketFactory: s.socketFactory,
      }),
    /different intent|different|conflict|already/i,
  );
  assert.equal(s.connections, 1);
});
test("out-of-order seed result has no invented correlation and cannot be replayed", async (t) => {
  const f = fixture(t);
  const s = await server(t, (socket) => {
    socket.send(encode(result(99)));
    socket.send(encode(result(35)));
  });
  const r = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => "secret-token",
    socketFactory: s.socketFactory,
  });
  assert.equal(r.metadata.state, "unknown");
  assert.deepEqual(r.outputs, []);
  const again = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => {
      throw new Error("no automatic reconnect");
    },
  });
  assert.equal(again.metadata.state, "unknown");
  assert.equal(s.connections, 1);
  assert.equal(f.store.summary().reservedUsd, 0.5);
});
test("cancel after send closes connection, retains liability and reports no provider refund", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  const s = await server(t, () => controller.abort());
  const r = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => "secret-token",
    socketFactory: s.socketFactory,
    signal: controller.signal,
  });
  assert.equal(r.metadata.state, "cancelled");
  assert.equal(f.store.summary().reservedUsd, 0.5);
  assert.equal(f.store.snapshot().jobs["realtime:session"].release, undefined);
});
test("cancel before auth provably releases unsubmitted commitment", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  controller.abort();
  let tokens = 0;
  const r = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => {
      tokens++;
      return "secret-token";
    },
    signal: controller.signal,
  });
  assert.equal(r.metadata.state, "cancelled");
  assert.equal(tokens, 0);
  assert.equal(f.store.summary().reservedUsd, 0);
});
test("deadline/control flood/oversized payload are bounded unknown failures", async (t) => {
  for (const behavior of ["deadline", "control", "oversize"]) {
    const f = fixture(t);
    f.request.sessionId = behavior;
    f.request.limits.timeoutMs = 80;
    f.request.limits.maxResponseBytes = 256;
    const s = await server(t, (socket) => {
      if (behavior === "control")
        for (let n = 0; n < 5; n++)
          socket.send(
            encode({
              type: "x-fal-message",
              status: "ok",
            }),
          );
      if (behavior === "oversize") socket.send(Buffer.alloc(1024));
    });
    const r = await runRealtimeSession(f.request, {
      rootDir: f.root,
      store: f.store,
      tokenProvider: async () => "secret-token",
      socketFactory: s.socketFactory,
    });
    assert.equal(r.metadata.state, "unknown", behavior);
    assert.equal(f.store.summary().reservedUsd, 0.5);
  }
});
test("hard session bound refuses before auth/socket and one local worker owns session", async (t) => {
  const f = fixture(t, 0.1);
  let tokens = 0;
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => {
          tokens++;
          return "secret-token";
        },
      }),
    /budget|cap|per-job/i,
  );
  assert.equal(tokens, 0);
  const larger = fixture(t);
  const release = claimOperationWork(larger.store, "realtime:session")!;
  const r = await runRealtimeSession(larger.request, {
    rootDir: larger.root,
    store: larger.store,
    tokenProvider: async () => {
      tokens++;
      return "secret-token";
    },
  });
  assert.equal(r.metadata.state, "worker-owned");
  release();
  assert.equal(tokens, 0);
});
test("corrupt provider bytes fail real media decode and resume cached result without another socket", async (t) => {
  const f = fixture(t);
  const s = await server(t, (socket) =>
    socket.send(
      encode({
        seed: 35,
        images: [
          {
            content: new Uint8Array([1, 2, 3]),
            width: 32,
            height: 32,
            content_type: "image/png",
          },
        ],
      }),
    ),
  );
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => "secret-token",
        socketFactory: s.socketFactory,
      }),
    /Media cannot|decoded|decode|inspect|dimensions|codec/i,
  );
  assert.equal(f.store.snapshot().jobs["realtime:session"].state, "failed");
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => {
          throw new Error("must not reconnect");
        },
      }),
    /Media cannot|decoded|decode|inspect|dimensions|codec/i,
  );
  assert.equal(s.connections, 1);
  assert.equal(f.store.snapshot().jobs["realtime:session"].paidAttempts, 1);
});
test("actual worker SIGKILL after WS send restores dead lease but refuses ambiguous resend", async (t) => {
  const f = fixture(t);
  const s = await server(t, () => {});
  const script = path.join(f.root, "worker.ts");
  writeFileSync(
    script,
    `import WebSocket from ${JSON.stringify(path.resolve("node_modules/ws/index.js"))}; import {runRealtimeSession} from ${JSON.stringify(path.resolve("src/lib/realtime/session.ts"))}; import {readFileSync} from 'node:fs'; const input=JSON.parse(readFileSync(${JSON.stringify(path.join(f.root, "request.json"))},'utf8')); void runRealtimeSession(input,{rootDir:${JSON.stringify(f.root)},tokenProvider:async()=>'secret-token',socketFactory:()=>new WebSocket(${JSON.stringify(s.url)}),afterSend:()=>process.kill(process.pid,'SIGKILL')});`,
  );
  writeFileSync(path.join(f.root, "request.json"), JSON.stringify(f.request));
  const child = spawn(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), script], {
    cwd: f.root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr.on("data", (d) => (errors += String(d)));
  const [code, signal] = await once(child, "exit");
  assert.ok(signal === "SIGKILL" || code === 137, errors + ` exit:${code}/${signal}`);
  assert.equal(s.connections, 1);
  const r = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => {
      throw new Error("must not auth/replay crashed input");
    },
  });
  assert.equal(r.metadata.state, "unknown");
  assert.equal(s.connections, 1);
  assert.equal(f.store.summary().reservedUsd, 0.5);
});
test("default CLI plan is pure offline with no project, credentials, cache writes or sockets", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "request.json");
  writeFileSync(file, JSON.stringify(f.request));
  const r = spawnSync(
    process.execPath,
    [path.resolve("node_modules/tsx/dist/cli.mjs"), path.resolve("scripts/realtime-session.ts"), "--request", file],
    {
      cwd: f.root,
      encoding: "utf8",
      env: {
        ...process.env,
        FAL_KEY: "",
        FAL_REALTIME_TOKEN: "",
      },
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.metadata.dryRun, true);
  assert.equal(out.metadata.liveVerified, false);
  assert.equal(out.metadata.providerAck, false);
  assert.equal(existsSync(path.join(f.root, ".cache")), false);
  assert.deepEqual(f.store.snapshot().jobs, {});
});
test("strict session rejects CDN images, invented revision fields, zero budget and frame cap overflow", (t) => {
  const f = fixture(t);
  f.request.operation.input.image_url = "https://example.invalid/frame.png";
  assert.throws(() => planRealtimeSession(f.request), /URI|CDN|base64|realtime/i);
  f.request.operation.input.image_url = `data:image/png;base64,${image.toString("base64")}`;
  f.request.operation.input.fake_ack_id = "invented";
  assert.throws(() => planRealtimeSession(f.request));
  delete f.request.operation.input.fake_ack_id;
  f.request.quote.highUsd = 0;
  f.request.quote.expectedUsd = 0;
  assert.throws(() => planRealtimeSession(f.request), /positive/);
  f.request.quote.highUsd = 0.5;
  f.request.operation.input.enable_interpolation = true;
  f.request.limits.maxFrames = 1;
  assert.throws(() => planRealtimeSession(f.request), /interpolation/);
});
test("temporary auth matches official SDK single POST with bounded response and sanitized failure", async () => {
  let calls = 0;
  const provider = createFalRealtimeTokenProvider(
    () => "fixture-key",
    async (url, init) => {
      calls++;
      assert.equal(url, "https://rest.fal.ai/tokens/");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      assert.equal((init?.headers as Record<string, string>).Authorization, "Key fixture-key");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        allowed_apps: ["flux-2"],
        token_expiration: 120,
      });
      return new Response(
        JSON.stringify({
          detail: "short-lived-fixture-token",
        }),
      );
    },
  );
  assert.equal(await provider("fal-ai/flux-2/klein/realtime"), "short-lived-fixture-token");
  assert.equal(calls, 1);
  const failed = createFalRealtimeTokenProvider(
    () => "fixture-key",
    async () => {
      throw new Error("secret-key-token");
    },
  );
  await assert.rejects(
    () => failed("fal-ai/flux-2/klein/realtime"),
    (error) => !String(error).includes("secret-key-token"),
  );
  const oversized = createFalRealtimeTokenProvider(
    () => "key",
    async () => new Response("a".repeat(17000)),
  );
  await assert.rejects(() => oversized("fal-ai/flux-2/klein/realtime"), /bounded/);
});
test("concurrent actual socket session holds lease until cancellation; competing caller never connects", async (t) => {
  const f = fixture(t);
  const controller = new AbortController();
  let ready!: () => void;
  const sent = new Promise<void>((resolve) => (ready = resolve));
  const s = await server(t, () => ready());
  const first = runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => "secret-token",
    socketFactory: s.socketFactory,
    signal: controller.signal,
  });
  await sent;
  const second = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => {
      throw new Error("competing token acquisition forbidden");
    },
    socketFactory: s.socketFactory,
  });
  assert.equal(second.metadata.state, "worker-owned");
  assert.equal(s.connections, 1);
  controller.abort();
  assert.equal((await first).metadata.state, "cancelled");
});
test("invalid actual input bytes release proven unsubmitted reservation without token/socket", async (t) => {
  const f = fixture(t);
  f.request.operation.input.image_url = "data:image/png;base64,AQID";
  let tokens = 0;
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => {
          tokens++;
          return "secret-token";
        },
      }),
    /Media|codec|dimensions|input|decoded/i,
  );
  assert.equal(tokens, 0);
  assert.equal(f.store.summary().reservedUsd, 0);
  assert.equal(f.store.snapshot().jobs["realtime:session"].paidAttempts, 0);
});
test("backpressure watermark aborts before send without invented provider rejection/refund", async (t) => {
  const f = fixture(t);
  const s = await server(t, () => assert.fail("must not send when socket is backpressured"));
  const r = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => "secret-token",
    socketFactory: (url, max) => {
      const socket = s.socketFactory(url, max);
      Object.defineProperty(socket, "bufferedAmount", {
        get: () => f.request.limits.maxInputBytes + 1,
      });
      return socket;
    },
  });
  assert.equal(r.metadata.state, "unknown");
  assert.equal(f.store.summary().reservedUsd, 0.5);
});
test("valid durable capture resumes publication after local registry failure without another connection", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.project, "pipeline/asset-registry.json.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const s = await server(t, (socket) => socket.send(encode(result())));
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => "secret-token",
        socketFactory: s.socketFactory,
      }),
    /locked/,
  );
  assert.equal(f.store.snapshot().jobs["realtime:session"].state, "failed");
  rmSync(lock);
  const resumed = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => {
      throw new Error("no token on cached publication");
    },
  });
  assert.equal(resumed.metadata.state, "published");
  assert.equal(s.connections, 1);
  assert.equal(f.store.snapshot().jobs["realtime:session"].paidAttempts, 1);
  assert.equal(f.store.summary().reservedUsd, 0.5);
  const registry = JSON.parse(readFileSync(path.join(f.project, "pipeline/asset-registry.json"), "utf8"));
  assert.equal(registry.assets[0].provenance.billing.status, "unknown");
});

test("execute plus forced dry-run remains offline without credentials or writes", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, "request.json");
  writeFileSync(file, JSON.stringify(f.request));
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/realtime-session.ts"),
      "--request",
      file,
      "--execute",
      "--dry-run",
    ],
    { cwd: f.root, encoding: "utf8", env: { ...process.env, FAL_KEY: "", FAL_REALTIME_TOKEN: "" } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).metadata.dryRun, true);
  assert.equal(existsSync(path.join(f.root, ".cache")), false);
  assert.deepEqual(f.store.snapshot().jobs, {});
});
test("pure planning and scoped CLI reject unsafe or mismatched project IDs before writes", (t) => {
  const f = fixture(t);
  f.request.projectId = "../escape";
  assert.throws(() => planRealtimeSession(f.request), /project/i);
  f.request.projectId = "demo";
  const file = path.join(f.root, "request.json");
  writeFileSync(file, JSON.stringify(f.request));
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/realtime-session.ts"),
      "--request",
      file,
      "--project",
      "other",
      "--execute",
      "--dry-run",
    ],
    { cwd: f.root, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error, "INVALID_INPUT");
  assert.equal(existsSync(path.join(f.root, ".cache")), false);
  assert.deepEqual(f.store.snapshot().jobs, {});
});

test("private cache symlink is refused before session intent/reservation or worker lease", async (t) => {
  const f = fixture(t);
  const publicCache = path.join(f.root, "public/cache");
  mkdirSync(publicCache);
  symlinkSync(publicCache, path.join(f.root, ".cache"));
  let tokens = 0;
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => {
          tokens++;
          return "secret-token";
        },
      }),
    /symlink/,
  );
  assert.equal(tokens, 0);
  assert.deepEqual(f.store.snapshot().jobs, {});
  assert.ok(!readdirSync(path.dirname(f.store.file)).some((n) => n.startsWith("operation-")));
});

test("oversized sparse cached result is refused before reads, auth, socket or another reservation", async (t) => {
  const f = fixture(t);
  const lock = path.join(f.project, "pipeline/asset-registry.json.lock");
  writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const s = await server(t, (socket) => socket.send(encode(result())));
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => "secret-token",
        socketFactory: s.socketFactory,
      }),
    /locked/,
  );
  rmSync(lock);
  const cache = path.join(f.root, ".cache/realtime/demo", digest("session"), "result.msgpack");
  truncateSync(cache, 512 * 1024 * 1024); // Sparse local tamper: never allocate/read 512MiB.
  const before = f.store.snapshot();
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => {
          assert.fail("no auth on tampered cache");
        },
        socketFactory: () => {
          assert.fail("no socket on tampered cache");
        },
      }),
    /regular.*byte bound/,
  );
  assert.deepEqual(f.store.snapshot(), before);
  assert.equal(s.connections, 1);
  assert.equal(f.store.summary().reservedUsd, 0.5);
});

test("oversized cached private input is refused before auth and released as proven unsubmitted", async (t) => {
  const f = fixture(t);
  const journal = path.join(f.root, ".cache/realtime/demo", digest("session"));
  mkdirSync(journal, { recursive: true });
  const file = path.join(journal, `input-${digest(image)}.png`);
  writeFileSync(file, "");
  truncateSync(file, 512 * 1024 * 1024);
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => {
          assert.fail("no auth for tampered input");
        },
      }),
    /byte bound/,
  );
  assert.equal(f.store.summary().reservedUsd, 0);
  assert.equal(f.store.snapshot().jobs["realtime:session"].paidAttempts, 0);
});

test("published manifest validates scoped frame paths before reading even a checksum-bound malformed receipt", async (t) => {
  const f = fixture(t);
  const s = await server(t, (socket) => socket.send(encode(result())));
  const published = await runRealtimeSession(f.request, {
    rootDir: f.root,
    store: f.store,
    tokenProvider: async () => "secret-token",
    socketFactory: s.socketFactory,
  });
  const manifestFile = published.outputs[0]!;
  const original = readFileSync(manifestFile, "utf8");
  for (const change of ["escaping-path", "invalid-frame-shape"]) {
    const manifest = JSON.parse(original);
    if (change === "escaping-path") manifest.frames[0].path = "../outside.png";
    else manifest.frames = "malformed";
    const bytes = JSON.stringify(manifest);
    writeFileSync(manifestFile, bytes);
    // Deliberately bind altered receipt in fixture storage, to exercise structure/path validation independently of hash mismatch.
    const stored = JSON.parse(readFileSync(f.store.file, "utf8"));
    stored.jobs["realtime:session"].result.captureManifestHash = digest(bytes);
    writeFileSync(f.store.file, JSON.stringify(stored));
    await assert.rejects(
      () =>
        runRealtimeSession(f.request, {
          rootDir: f.root,
          store: f.store,
          tokenProvider: async () => {
            assert.fail("no auth on published resume");
          },
        }),
      change === "escaping-path" ? /path\/identity mismatch/ : /frames/,
    );
  }
  truncateSync(manifestFile, 512 * 1024 * 1024);
  await assert.rejects(
    () =>
      runRealtimeSession(f.request, {
        rootDir: f.root,
        store: f.store,
        tokenProvider: async () => {
          assert.fail("no auth on oversized receipt");
        },
      }),
    /byte bound/,
  );
  assert.equal(s.connections, 1);
  assert.equal(f.store.summary().reservedUsd, 0.5);
});
