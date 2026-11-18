import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  realpathSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { encode } from "@msgpack/msgpack";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
import { runRealtimeSession, type RealtimeSessionRequest } from "../src/lib/realtime/session";
import { OperationStore } from "../src/lib/jobs/store";
function fixture(t: test.TestContext, ceiling = 1) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "realtime-editor-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const image = path.join(root, "image.png");
  const ffmpeg = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32", "-frames:v", "1", "-y", image],
    { encoding: "utf8" },
  );
  assert.equal(ffmpeg.status, 0, ffmpeg.stderr);
  const bytes = readFileSync(image);
  const request = (revisionId: string): RealtimeSessionRequest => ({
    version: 1,
    projectId: "demo",
    sessionId: `editor-${revisionId}`,
    revisionId,
    operation: {
      family: "flux-2",
      variant: "klein",
      operation: "realtime",
      transport: "realtime",
      input: { image_url: `data:image/png;base64,${bytes.toString("base64")}`, seed: 35 },
    },
    quote: {
      currency: "USD",
      lowUsd: 0,
      expectedUsd: 0.2,
      highUsd: 0.5,
      bounded: true,
      confidence: "user-bound",
      source: "offline fixture planning bound",
      asOf: "2026-10-11",
    },
    limits: {
      maxFrames: 2,
      maxInputBytes: 1024 * 1024,
      maxResponseBytes: 1024 * 1024,
      maxControls: 4,
      timeoutMs: 2000,
    },
  });
  const store = new RealtimeEditorStore(root, "demo", "draft");
  store.create(ceiling);
  return { root, project, bytes, request, store };
}
test("multiple offline drafts replace only unsent input; CAS and aggregate liability survive restart", (t) => {
  const f = fixture(t);
  let state = f.store.add(0, f.request("first"));
  state = f.store.queue(state.sequence, "first");
  state = f.store.add(state.sequence, f.request("second"));
  state = f.store.queue(state.sequence, "second");
  assert.equal(state.revisions[0].status, "superseded");
  assert.equal(state.committedUsd, 0);
  assert.throws(() => f.store.cancel(0), /conflict/);
  state = f.store.handoff(state.sequence);
  assert.equal(state.committedUsd, 0.5);
  state = f.store.add(state.sequence, f.request("third"));
  state = f.store.queue(state.sequence, "third");
  assert.throws(() => f.store.handoff(state.sequence), /Unresolved/);
  const restart = new RealtimeEditorStore(f.root, "demo", "draft");
  state = restart.recover(state.sequence);
  assert.equal(state.revisions[1].status, "uncertain");
  assert.equal(state.committedUsd, 0.5);
  assert.throws(() => restart.handoff(state.sequence), /reconciliation/);
  state = restart.cancel(state.sequence);
  assert.equal(state.committedUsd, 0.5);
  assert.equal(state.queued, undefined);
  assert.throws(() => restart.add(state.sequence, f.request("second")), /reused/);
  assert.throws(() => restart.select(state.sequence, "second"), /verified/);
});
test("actual loopback result selection is pinned to durable published capture and no replay is invoked by restart", async (t) => {
  const f = fixture(t, 1);
  let state = f.store.add(0, f.request("first"));
  state = f.store.queue(state.sequence, "first");
  state = f.store.handoff(state.sequence);
  const financial = new OperationStore("demo", { directory: path.join(f.project, "pipeline") });
  financial.configure(
    { ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 },
    USER_GRANT,
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    socket.on("message", () =>
      socket.send(
        encode({
          seed: 35,
          images: [{ content: new Uint8Array(f.bytes), width: 32, height: 32, content_type: "image/png" }],
        }),
      ),
    );
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const captured = await runRealtimeSession(f.store.request("first"), {
    rootDir: f.root,
    store: financial,
    tokenProvider: async () => "fixture-token",
    socketFactory: () => new WebSocket(url),
  });
  assert.equal(captured.metadata.state, "published");
  state = f.store.recover(state.sequence); // Conservative crash recovery before attaching cached result.
  state = f.store.complete(state.sequence, "first", captured.outputs[0]);
  state = f.store.select(state.sequence, "first");
  assert.equal(new RealtimeEditorStore(f.root, "demo", "draft").read().selected, "first");
  assert.equal(connections, 1);
  assert.equal(state.committedUsd, 0.5);
  assert.throws(() => f.store.complete(state.sequence, "first", captured.outputs[0]), /Late/);
  state = f.store.add(state.sequence, f.request("second"));
  state = f.store.queue(state.sequence, "second");
  state = f.store.handoff(state.sequence);
  assert.throws(() => f.store.complete(state.sequence, "second", captured.outputs[0]), /associated/);
  const second = await runRealtimeSession(f.store.request("second"), {
    rootDir: f.root,
    store: financial,
    tokenProvider: async () => "fixture-token",
    socketFactory: () => new WebSocket(url),
  });
  assert.equal(second.metadata.state, "published");
  state = f.store.complete(state.sequence, "second", second.outputs[0]);
  state = f.store.select(state.sequence, "second");
  assert.equal(connections, 2);
  assert.equal(state.committedUsd, 1);
  assert.equal(state.selected, "second");
  state = f.store.add(state.sequence, f.request("third"));
  state = f.store.queue(state.sequence, "third");
  assert.throws(() => f.store.handoff(state.sequence), /ceiling/);
  writeFileSync(captured.outputs[1], "corrupt");
  assert.throws(() => f.store.read(), /hash mismatch/);
});
test("rejects wrong project, forged results and symlink input pins", (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.add(0, { ...f.request("first"), projectId: "other" }), /project/);
  let state = f.store.add(0, f.request("first"));
  state = f.store.queue(state.sequence, "first");
  state = f.store.handoff(state.sequence);
  const manifest = path.join(f.project, "pipeline/realtime/fake.json");
  mkdirSync(path.dirname(manifest), { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({
      projectId: "demo",
      sessionId: "editor-first",
      revisionId: "first",
      inputHash: state.revisions[0].inputHash,
      operationId: "realtime:editor-first",
      endpoint: "fal-ai/flux-2/klein/realtime",
      provenance: { providerAck: false },
      frames: [{ path: "image.png", sha256: "a".repeat(64) }],
    }),
  );
  assert.throws(() => f.store.complete(state.sequence, "first", manifest), /durable capture/);
  const request = path.resolve(f.root, state.revisions[0].request.path);
  rmSync(request);
  symlinkSync(path.join(f.root, "image.png"), request);
  assert.throws(() => f.store.read(), /symlink/);
});
test("CLI status emits one envelope, is offline and rejects unsupported actions", (t) => {
  const f = fixture(t);
  const script = path.resolve("scripts/realtime-editor.ts");
  const tsx = path.resolve("node_modules/tsx/dist/cli.mjs");
  const run = (action: string) =>
    spawnSync(process.execPath, [tsx, script, "--project", "demo", "--editor", "draft", "--action", action], {
      cwd: f.root,
      encoding: "utf8",
    });
  const status = run("status");
  assert.equal(status.status, 0, status.stdout);
  assert.equal(status.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(status.stdout).metadata.offline, true);
  const bad = run("execute");
  assert.equal(bad.status, 1);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  assert.equal(JSON.parse(bad.stdout).error, "INVALID_INPUT");
});

test("editor cannot alias a different project through a workspace-local symlink", (t) => {
  const f = fixture(t),
    alias = path.join(f.root, "public/projects/alias");
  symlinkSync(f.project, alias);
  assert.throws(() => new RealtimeEditorStore(f.root, "alias", "draft"), /project boundary.*symlinks/);
  assert.equal(existsSync(path.join(f.root, ".cache/realtime-editors/alias")), false);
});

test("bounded draft count and cancellation before handoff do not consume liability", (t) => {
  const f = fixture(t);
  let state = f.store.read();
  for (let n = 0; n < 32; n++) state = f.store.add(state.sequence, f.request(`revision-${n}`));
  assert.throws(() => f.store.add(state.sequence, f.request("overflow")), /capacity/);
  state = f.store.queue(state.sequence, "revision-31");
  state = f.store.cancel(state.sequence);
  assert.equal(state.committedUsd, 0);
  assert.equal(state.revisions[31].status, "cancelled");
});
test("failed local transport retains ambiguous handoff and recovery never reconnects", async (t) => {
  const f = fixture(t);
  let state = f.store.add(0, f.request("first"));
  state = f.store.queue(state.sequence, "first");
  state = f.store.handoff(state.sequence);
  const financial = new OperationStore("demo", { directory: path.join(f.project, "pipeline") });
  financial.configure(
    { ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 },
    USER_GRANT,
  );
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of server.clients) socket.terminate();
        server.close(() => resolve());
      }),
  );
  let connections = 0;
  server.on("connection", (socket) => {
    connections++;
    socket.close();
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = await runRealtimeSession(f.store.request("first"), {
    rootDir: f.root,
    store: financial,
    tokenProvider: async () => "fixture-token",
    socketFactory: () => new WebSocket(url),
  });
  assert.equal(result.metadata.state, "unknown");
  state = f.store.recover(state.sequence);
  assert.equal(state.committedUsd, 0.5);
  assert.equal(state.revisions[0].status, "uncertain");
  state = f.store.add(state.sequence, f.request("second"));
  state = f.store.queue(state.sequence, "second");
  assert.throws(() => f.store.handoff(state.sequence), /reconciliation/);
  assert.equal(connections, 1);
});
