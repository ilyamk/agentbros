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
  existsSync,
  readdirSync,
  symlinkSync,
} from "node:fs";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
import { request as httpRequest } from "node:http";
import { startReviewServer } from "../src/lib/review-ui/server";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
import { LocalEditorChannel } from "../src/lib/realtime/channel";
import { inspectLocalEditorHistory } from "../src/lib/realtime/channel-journal";
import { digest } from "../src/lib/jobs/model-artifacts";
const request = (revisionId: string) => ({
  version: 1 as const,
  projectId: "demo",
  revisionId,
  sessionId: "source-" + revisionId,
  operation: {
    family: "flux-2" as const,
    variant: "klein" as const,
    operation: "realtime" as const,
    transport: "realtime" as const,
    input: { image_url: "data:image/png;base64,YQ==", seed: 35 },
  },
  quote: {
    currency: "USD" as const,
    lowUsd: 0,
    expectedUsd: 0.5,
    highUsd: 0.5,
    bounded: true as const,
    confidence: "user-bound" as const,
    source: "offline fixture only; no encoded media",
    asOf: "2026-10-12",
  },
  limits: { maxFrames: 2, maxInputBytes: 1024 * 1024, maxResponseBytes: 1024 * 1024, maxControls: 4, timeoutMs: 2000 },
});
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "review-channel-"))),
    project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new RealtimeEditorStore(root, "demo", "edit");
  store.create(2);
  store.add(0, request("one"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, project, store };
}
const headers = (app: Awaited<ReturnType<typeof startReviewServer>>) => ({
  "x-review-token": app.token,
  origin: app.origin,
  "content-type": "application/json",
});
async function admission(
  app: Awaited<ReturnType<typeof startReviewServer>>,
  editorId = "edit",
  localSessionId = "local",
) {
  const r = await fetch(app.origin + "/api/realtime/channel-ticket", {
    method: "POST",
    headers: headers(app),
    body: JSON.stringify({ editorId, localSessionId }),
  });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
async function socket(app: Awaited<ReturnType<typeof startReviewServer>>, ticket: any) {
  const ws = new WebSocket(app.origin.replace("http:", "ws:") + ticket.path, [ticket.protocol, "t." + ticket.ticket], {
    origin: app.origin,
    perMessageDeflate: false,
  });
  await once(ws, "open");
  return ws;
}
async function exchange(ws: WebSocket, payload: unknown) {
  const result = once(ws, "message");
  ws.send(JSON.stringify(payload));
  return JSON.parse((await result)[0].toString());
}
const message = (session: string, id: string, action: string, expected = 1, extra = {}) => ({
  version: 1,
  localSessionId: session,
  editorId: "edit",
  messageId: id,
  expectedSequence: expected,
  action,
  ...extra,
});
async function closed(ws: WebSocket) {
  const done = once(ws, "close");
  ws.close();
  await done;
  await new Promise((resolve) => setImmediate(resolve));
}

test("nonowning history inspection has no mkdir/metadata/lease/timer and rechecks current source/snapshot/history/lease", (t) => {
  const f = fixture(t),
    parent = path.join(f.root, ".cache/realtime-channels/demo", digest("edit"));
  assert.equal(existsSync(parent), false);
  const read = inspectLocalEditorHistory(f.store);
  assert.equal(read.unresolvedCount, 0);
  read.recheck();
  assert.equal(existsSync(parent), false);
  assert.equal("receive" in read, false);
  const file = f.store.request("one");
  assert.equal(file.operation.input.image_url, request("one").operation.input.image_url);
  const source = f.store.read().revisions[0].request.path;
  writeFileSync(path.join(f.root, source), "corrupt");
  assert.throws(() => read.recheck(), /Editor artifact hash mismatch/);
  assert.equal(existsSync(parent), false);
});
test("nonowning inspection refuses unknown history/symlink/FIFO and membership changes rather than treating corruption as empty", (t) => {
  const f = fixture(t),
    read = inspectLocalEditorHistory(f.store),
    parent = path.join(f.root, ".cache/realtime-channels/demo", digest("edit"));
  mkdirSync(parent, { recursive: true });
  assert.throws(() => read.recheck(), /appeared/);
  writeFileSync(path.join(parent, "unknown"), "x");
  assert.throws(() => inspectLocalEditorHistory(f.store), /unknown/);
  rmSync(parent, { recursive: true });
  symlinkSync(f.project, parent);
  assert.throws(() => inspectLocalEditorHistory(f.store), /symlink/);
  rmSync(parent);
  mkdirSync(parent);
  execFileSync("mkfifo", [path.join(parent, "lease.json")]);
  assert.throws(() => inspectLocalEditorHistory(f.store), /regular/);
});
test("ticket and upgrade authenticate exact Host/Origin/token/protocol before any channel journal, token is not in URL", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  const payload = { editorId: "edit", localSessionId: "local" },
    url = app.origin + "/api/realtime/channel-ticket";
  for (const h of [
    { ...headers(app), "x-review-token": "" },
    { ...headers(app), origin: "" },
    { ...headers(app), origin: "https://evil.test" },
  ])
    assert.equal((await fetch(url, { method: "POST", headers: h, body: JSON.stringify(payload) })).status, 403);
  const wrongHost = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(url, { method: "POST", headers: { ...headers(app), host: "evil.test" } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on("error", reject);
    req.end(JSON.stringify(payload));
  });
  assert.equal(wrongHost, 403);
  assert.equal(
    (
      await fetch(url, {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ ...payload, provider: "fal.ai" }),
      })
    ).status,
    400,
  );
  assert.equal(existsSync(path.join(f.root, ".cache/realtime-channels")), false);
  const ticket = await admission(app);
  assert.equal(existsSync(path.join(f.root, ".cache/realtime-channels")), false);
  assert.ok(!ticket.path.includes(ticket.ticket));
  for (const options of [
    { origin: "https://evil.test", perMessageDeflate: false },
    { origin: app.origin, perMessageDeflate: false, headers: { "Sec-WebSocket-Extensions": "other-extension" } },
    { origin: app.origin, perMessageDeflate: false, protocolVersion: 8 },
  ]) {
    const ws = new WebSocket(
      app.origin.replace("http:", "ws:") + ticket.path,
      [ticket.protocol, "t." + ticket.ticket],
      options,
    );
    const refusal = new Promise<number>((resolve) => {
      ws.once("unexpected-response", (_req, res) => {
        res.resume();
        resolve(res.statusCode!);
        ws.terminate();
      });
      ws.on("error", () => {});
    });
    assert.equal(await refusal, 403);
    assert.equal(existsSync(path.join(f.root, ".cache/realtime-channels")), false);
  }
  const ws = await socket(app, ticket);
  assert.equal(ws.protocol, ticket.protocol);
  const state = f.store.read();
  const reply = await exchange(ws, message("local", "status", "status"));
  assert.equal(reply.current.sequence, state.sequence);
  assert.equal(reply.providerAck, false);
  assert.equal(reply.providerPersistent, false);
  const reused = new WebSocket(
    app.origin.replace("http:", "ws:") + ticket.path,
    [ticket.protocol, "t." + ticket.ticket],
    { origin: app.origin, perMessageDeflate: false },
  );
  const deny = new Promise<number>((resolve) => {
    reused.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode!);
      reused.terminate();
    });
    reused.on("error", () => {});
  });
  assert.equal(await deny, 403);
  await closed(ws);
});
test("real local correlated channel preserves CAS/one action/history/current, protected originals and honest handoff; active HTTP mutation refuses", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  const original = readFileSync(path.join(f.root, f.store.read().revisions[0].request.path)),
    ticket = await admission(app),
    ws = await socket(app, ticket);
  const post = (input: unknown) =>
    fetch(app.origin + "/api/realtime", { method: "POST", headers: headers(app), body: JSON.stringify(input) });
  assert.equal((await post({ action: "queue", editorId: "edit", expected: 1, revisionId: "one" })).status, 409);
  const bytes = message("local", "queue", "queue", 1, { revisionId: "one" }),
    first = await exchange(ws, bytes);
  assert.equal(first.outcome, "ok");
  assert.equal(first.resultingSequence, 2);
  assert.equal(first.messageSha256, digest(JSON.stringify(bytes)));
  assert.equal(first.association.revisionId, "one");
  const conflict = await exchange(ws, message("local", "stale", "handoff", 1));
  assert.equal(conflict.outcome, "conflict");
  assert.equal(f.store.read().sequence, 2);
  const handoff = await exchange(ws, message("local", "handoff", "handoff", 2));
  assert.equal(handoff.current.committedPlanningUsd, 0.5);
  const repeated = await exchange(ws, bytes);
  assert.equal(repeated.historical, true);
  assert.equal(repeated.resultingSequence, 2);
  assert.equal(repeated.current.sequence, 3);
  assert.equal(f.store.read().sequence, 3);
  await exchange(ws, message("local", "cancel", "cancel", 3));
  assert.equal(f.store.read().committedUsd, 0.5);
  assert.deepEqual(readFileSync(path.join(f.root, f.store.read().revisions[0].request.path)), original);
  await closed(ws);
  assert.equal((await post({ action: "recover", editorId: "edit", expected: 4 })).status, 200);
});
test("expired predecessor unknown blocks HTTP after restart; fresh authenticated recovery only acknowledges exact target without replay/expiry change", async (t) => {
  const f = fixture(t),
    realNow = Date.now,
    creationTime = realNow() - 1000;
  let old: LocalEditorChannel | undefined;
  try {
    // Control only the predecessor's admission, not the real HTTP/WS recovery clock.
    Date.now = () => creationTime;
    old = new LocalEditorChannel(f.root, "demo", "edit", "old", {
      maxCommands: 64,
      maxMessageBytes: 16384,
      maxReplyBytes: 65536,
      maxSidecarBytes: 8 * 1024 * 1024,
      maxReceivedBytes: 1024 * 1024,
      totalMs: 50,
      idleMs: 15000,
      settleMs: 2000,
    });
    const pending = old.accept(Buffer.from(JSON.stringify(message("old", "lost", "queue", 1, { revisionId: "one" }))));
    old.close();
    assert.equal((await pending).outcome, "uncertain");
  } finally {
    old?.close();
    Date.now = realNow;
  }
  assert.ok(old);
  assert.ok(Date.now() >= old.journal.meta.expiresAt);
  assert.equal(old.journal.meta.expiresAt - old.journal.meta.createdAt, 50);
  const metaFile = path.join(old.journal.directory, "session.json"),
    meta = readFileSync(metaFile);
  assert.equal(f.store.read().sequence, 1);
  const app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  const pre = readFileSync(path.join(f.store.directory, "001.json"));
  const post = await fetch(app.origin + "/api/realtime", {
    method: "POST",
    headers: headers(app),
    body: JSON.stringify({ action: "queue", editorId: "edit", expected: 1, revisionId: "one" }),
  });
  assert.equal(post.status, 409);
  assert.deepEqual(readFileSync(path.join(f.store.directory, "001.json")), pre);
  const ticket = await admission(app, "edit", "recovery"),
    ws = await socket(app, ticket),
    status = await exchange(ws, message("recovery", "status", "status"));
  assert.equal(status.unresolvedCount, 1);
  assert.equal(
    (await exchange(ws, message("recovery", "blocked", "queue", 1, { revisionId: "one" }))).outcome,
    "uncertain",
  );
  const target = status.unresolved[0],
    ack = await exchange(
      ws,
      message("recovery", "ack", "reconcile", 1, {
        targetLocalSessionId: target.localSessionId,
        pendingMessageId: target.messageId,
        intentSha256: target.intentSha256,
        currentStateSha256: status.current.stateSha256,
        acknowledge: "unknown-local-outcome-no-replay",
      }),
    );
  assert.equal(ack.outcome, "ok");
  assert.equal(ack.unresolvedCount, 0);
  assert.equal(f.store.read().sequence, 1);
  assert.deepEqual(readFileSync(metaFile), meta);
  await closed(ws);
});
test("bounded ticket count/socket capacity, binary/oversize denial and owned shutdown leave unrelated loopback server alive", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  const sockets: WebSocket[] = [];
  for (let i = 0; i < 4; i++) {
    const id = "e" + i,
      s = new RealtimeEditorStore(f.root, "demo", id);
    s.create(1);
    sockets.push(await socket(app, await admission(app, id, "local")));
  }
  assert.equal(app.channels.diagnostics().sockets, 4);
  assert.equal(
    (
      await fetch(app.origin + "/api/realtime/channel-ticket", {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ editorId: "edit", localSessionId: "other" }),
      })
    ).status,
    400,
  );
  const closeEvents = sockets.map((s) => once(s, "close"));
  await app.close();
  await app.close();
  await Promise.all(closeEvents);
  assert.deepEqual(app.channels.diagnostics(), { sockets: 0, tickets: 0, issued: 4, closed: true });
  const other = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => other.close());
  assert.equal((await fetch(other.origin + "/api/realtime", { headers: headers(other) })).status, 200);
  const one = await socket(other, await admission(other)),
    ended = once(one, "close");
  one.send(Buffer.from("binary"));
  await ended;
  await new Promise((r) => setImmediate(r));
  assert.equal(f.store.read().sequence, 1);
  const two = await socket(other, await admission(other, "edit", "two")),
    ended2 = once(two, "close");
  two.send("x".repeat(16385));
  await ended2;
  assert.equal(f.store.read().sequence, 1);
});
test("five-second tickets expire without journals, outstanding count is eight and total issuance64 survives consumption", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  const tickets = [];
  for (let i = 0; i < 8; i++) tickets.push(await admission(app, "edit", "s" + i));
  assert.equal(app.channels.diagnostics().tickets, 8);
  const denied = await fetch(app.origin + "/api/realtime/channel-ticket", {
    method: "POST",
    headers: headers(app),
    body: JSON.stringify({ editorId: "edit", localSessionId: "ninth" }),
  });
  assert.equal(denied.status, 400);
  assert.equal(existsSync(path.join(f.root, ".cache/realtime-channels")), false);
  await new Promise((r) => setTimeout(r, 5050));
  assert.equal(app.channels.diagnostics().tickets, 0);
  const expired = new WebSocket(
    app.origin.replace("http:", "ws:") + tickets[0].path,
    [tickets[0].protocol, "t." + tickets[0].ticket],
    { origin: app.origin, perMessageDeflate: false },
  );
  expired.on("error", () => {});
  const refusal = await new Promise<number>((resolve) =>
    expired.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode!);
      expired.terminate();
    }),
  );
  assert.equal(refusal, 403);
  assert.equal(existsSync(path.join(f.root, ".cache/realtime-channels")), false);
  for (let i = 0; i < 4; i++) new RealtimeEditorStore(f.root, "demo", "cap" + i).create(1);
  // Eight expired tickets consumed issuance budget. Remaining56 successful admissions use14 sessions/editor (below32).
  for (let i = 0; i < 56; i++) {
    const ticket = await admission(app, "cap" + (i % 4), "s" + i),
      ws = await socket(app, ticket);
    await closed(ws);
  }
  assert.equal(app.channels.diagnostics().issued, 64);
  assert.equal(
    (
      await fetch(app.origin + "/api/realtime/channel-ticket", {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ editorId: "edit", localSessionId: "limit" }),
      })
    ).status,
    400,
  );
});
test("nonowning current snapshot and lease identity changes refuse; corrupt owned cleanup remains server close failure", async (t) => {
  const f = fixture(t),
    read = inspectLocalEditorHistory(f.store);
  f.store.add(1, request("two"));
  assert.throws(() => read.recheck(), /snapshot changed/);
  const app = await startReviewServer({ rootDir: f.root, projectId: "demo" }),
    ticket = await admission(app),
    ws = await socket(app, ticket),
    history = inspectLocalEditorHistory(f.store);
  assert.equal(history.leasePresent, true);
  const lease = path.join(f.root, ".cache/realtime-channels/demo", digest("edit"), "lease.json");
  const old = readFileSync(lease);
  writeFileSync(
    lease,
    JSON.stringify({ pid: process.pid, nonce: "11111111-1111-4111-8111-111111111111", localSessionId: "other" }),
  );
  assert.throws(() => history.recheck(), /lease changed/);
  const closeEvent = once(ws, "close");
  await assert.rejects(app.close(), /lease cleanup refused/);
  await closeEvent;
  assert.notDeepEqual(readFileSync(lease), old);
  assert.equal(app.server.listening, false);
  await assert.rejects(app.close(), /lease cleanup refused/);
});
test("unfinished owned HTTP body is closed finitely with no mutation and unrelated server remains usable", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ rootDir: f.root, projectId: "demo" }),
    other = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => other.close());
  t.after(() => app.close());
  const req = httpRequest(app.origin + "/api/realtime", {
    method: "POST",
    headers: { ...headers(app), "transfer-encoding": "chunked" },
  });
  req.on("error", () => {});
  req.write('{"action":');
  await new Promise((r) => setTimeout(r, 20));
  const before = Date.now();
  await app.close();
  assert.ok(Date.now() - before < 1500);
  assert.equal(f.store.read().sequence, 1);
  assert.equal(app.server.listening, false);
  assert.equal((await fetch(other.origin + "/api/realtime", { headers: headers(other) })).status, 200);
  req.destroy();
});
test("validated dead own subprocess lease admits only normal owning recovery; no PID leaks or HTTP bypass", async (t) => {
  const f = fixture(t);
  const childCode = `import * as channelModule from './src/lib/realtime/channel.ts';const {LocalEditorChannel}=channelModule.default??channelModule;const c=new LocalEditorChannel(process.argv[1],'demo','edit','crashed');const state=c.store.read();c.journal.receive(Buffer.from(JSON.stringify({version:1,editorId:'edit',localSessionId:'crashed',messageId:'lost',expectedSequence:state.sequence,action:'queue',revisionId:'one'})),{version:1,editorId:'edit',localSessionId:'crashed',messageId:'lost',expectedSequence:state.sequence,action:'queue',revisionId:'one'},c.journal.snapshot(state),true);process.exit(0);`;
  execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", childCode, f.root], {
    timeout: 10000,
    env: Object.fromEntries(
      ["PATH", "HOME", "TMPDIR"].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]),
    ),
  });
  const before = inspectLocalEditorHistory(f.store);
  assert.equal(before.leasePresent, true);
  assert.equal(before.mayAcquire(), true);
  const parent = path.join(f.root, ".cache/realtime-channels/demo", digest("edit")),
    oldMeta = path.join(parent, digest("crashed"), "session.json"),
    original = readFileSync(oldMeta),
    lease = path.join(parent, "lease.json");
  const app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  assert.equal(
    (
      await fetch(app.origin + "/api/realtime", {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ action: "queue", editorId: "edit", expected: 1, revisionId: "one" }),
      })
    ).status,
    409,
  );
  const ticket = await admission(app, "edit", "recover-crash");
  assert.equal(JSON.stringify(ticket).includes('"pid"'), false);
  const ws = await socket(app, ticket),
    status = await exchange(ws, message("recover-crash", "status", "status"));
  assert.equal(status.unresolvedCount, 1);
  assert.equal(f.store.read().sequence, 1);
  const row = status.unresolved[0];
  const ack = await exchange(
    ws,
    message("recover-crash", "ack", "reconcile", 1, {
      targetLocalSessionId: row.localSessionId,
      pendingMessageId: row.messageId,
      intentSha256: row.intentSha256,
      currentStateSha256: status.current.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  assert.equal(ack.outcome, "ok");
  assert.equal(f.store.read().sequence, 1);
  assert.deepEqual(readFileSync(oldMeta), original);
  await closed(ws);
  const cleanupDeadline = Date.now() + 1000;
  while (app.channels.diagnostics().sockets > 0 && Date.now() < cleanupDeadline)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(app.channels.diagnostics().sockets, 0);
  assert.equal(existsSync(lease), false);
});
test("live/unknown/corrupt lease or exclusive guard cannot produce a recovery ticket or HTTP mutation", async (t) => {
  const f = fixture(t),
    app = await startReviewServer({ rootDir: f.root, projectId: "demo" });
  t.after(() => app.close());
  const parent = path.join(f.root, ".cache/realtime-channels/demo", digest("edit"));
  mkdirSync(parent, { recursive: true });
  const lease = path.join(parent, "lease.json"),
    guard = lease + ".guard",
    base = { pid: process.pid, nonce: "11111111-1111-4111-8111-111111111111", localSessionId: "owned" };
  for (const value of [
    base,
    { ...base, pid: Number.MAX_SAFE_INTEGER },
    { ...base, pid: -1 },
    { ...base, nonce: "bad" },
  ]) {
    writeFileSync(lease, JSON.stringify(value));
    assert.equal(
      (
        await fetch(app.origin + "/api/realtime/channel-ticket", {
          method: "POST",
          headers: headers(app),
          body: JSON.stringify({ editorId: "edit", localSessionId: "new" }),
        })
      ).status,
      400,
    );
    assert.equal(f.store.read().sequence, 1);
  }
  rmSync(lease);
  writeFileSync(guard, "");
  assert.equal(inspectLocalEditorHistory(f.store).mayAcquire(), false);
  assert.equal(
    (
      await fetch(app.origin + "/api/realtime/channel-ticket", {
        method: "POST",
        headers: headers(app),
        body: JSON.stringify({ editorId: "edit", localSessionId: "new" }),
      })
    ).status,
    400,
  );
  assert.equal(readdirSync(parent).length, 1);
});
test("new unknown parent member after readonly inspection fails closed before writes", (t) => {
  const f = fixture(t),
    parent = path.join(f.root, ".cache/realtime-channels/demo", digest("edit"));
  mkdirSync(parent, { recursive: true });
  const inspection = inspectLocalEditorHistory(f.store),
    before = readFileSync(path.join(f.store.directory, "001.json"));
  writeFileSync(path.join(parent, "unrecognized"), "x");
  assert.throws(() => inspection.recheck(), /unknown parent member/);
  assert.deepEqual(readFileSync(path.join(f.store.directory, "001.json")), before);
});
