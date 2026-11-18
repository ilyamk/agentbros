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
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { LocalEditorChannel, type LocalEditorTransport } from "../src/lib/realtime/channel";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
import {
  DEFAULT_LOCAL_EDITOR_LIMITS,
  LocalEditorReplySchema,
  LocalEditorLimitsSchema,
} from "../src/lib/realtime/channel-types";
import { digest } from "../src/lib/jobs/model-artifacts";
import type { z } from "zod";
const wait = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));
function fixture(t: test.TestContext, limits: z.input<typeof LocalEditorLimitsSchema> = DEFAULT_LOCAL_EDITOR_LIMITS) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "local-editor-channel-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new RealtimeEditorStore(root, "demo", "edit");
  store.create(2);
  const quote = {
    currency: "USD" as const,
    lowUsd: 0,
    expectedUsd: 0.2,
    highUsd: 0.5,
    bounded: true as const,
    confidence: "user-bound" as const,
    providerEnforced: false,
    source: "synthetic local planning-only bound",
    asOf: "2026-10-11",
  };
  const request = (revisionId: string) => ({
    version: 1 as const,
    projectId: "demo",
    revisionId,
    sessionId: `capture-${revisionId}`,
    operation: {
      family: "flux-2" as const,
      variant: "klein" as const,
      operation: "realtime" as const,
      transport: "realtime" as const,
      input: { image_url: "data:image/png;base64,AA==", seed: 35 },
    },
    quote,
    limits: { maxFrames: 1, maxInputBytes: 4096, maxResponseBytes: 4096, maxControls: 2, timeoutMs: 1000 },
  });
  store.add(0, request("one"));
  store.add(1, request("two"));
  const channel = new LocalEditorChannel(root, "demo", "edit", "local", limits);
  t.after(() => channel.close());
  const message = (messageId: string, action = "status", expectedSequence = store.read().sequence, payload = {}) =>
    Buffer.from(
      JSON.stringify({
        version: 1,
        localSessionId: "local",
        editorId: "edit",
        messageId,
        expectedSequence,
        action,
        ...payload,
      }),
    );
  return {
    root,
    project,
    store,
    channel,
    message,
    request,
    quote,
    reopen: () => new LocalEditorChannel(root, "demo", "edit", "local"),
  };
}
class FakeTransport implements LocalEditorTransport {
  messages = new Set<(bytes: Uint8Array) => void>();
  closes = new Set<() => void>();
  replies: Buffer[] = [];
  closed = false;
  hanging = false;
  throwing = false;
  sends = 0;
  onMessage(cb: (bytes: Uint8Array) => void) {
    this.messages.add(cb);
    return () => {
      this.messages.delete(cb);
    };
  }
  onClose(cb: () => void) {
    this.closes.add(cb);
    return () => {
      this.closes.delete(cb);
    };
  }
  send(bytes: Uint8Array, signal: AbortSignal) {
    this.sends++;
    if (this.throwing) return Promise.reject(Error("injected send fault"));
    if (this.hanging)
      return new Promise<void>((_, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(Error("aborted injected send"));
        };
        signal.addEventListener("abort", abort, { once: true });
      });
    this.replies.push(Buffer.from(bytes));
    return Promise.resolve();
  }
  emit(bytes: Uint8Array) {
    for (const cb of [...this.messages]) cb(bytes);
  }
  disconnect() {
    for (const cb of [...this.closes]) cb();
  }
  close() {
    this.closed = true;
  }
}
test("exact local messages associate two same-seed revisions, CAS, queue supersession and handoff; no transport/provider execution", async (t) => {
  const f = fixture(t);
  const first = await f.channel.accept(f.message("q1", "queue", 2, { revisionId: "one" }));
  assert.equal(first.association?.revisionId, "one");
  const next = await f.channel.accept(f.message("q2", "queue", 3, { revisionId: "two" }));
  assert.equal(next.association?.sessionId, "capture-two");
  assert.equal(f.store.read().revisions[0].status, "superseded");
  const handoff = await f.channel.accept(f.message("h", "handoff", 4));
  assert.equal(handoff.current.committedPlanningUsd, 0.5);
  assert.equal(handoff.providerAck, false);
  const conflict = await f.channel.accept(f.message("old", "cancel", 4));
  assert.equal(conflict.outcome, "conflict");
  assert.equal(f.store.read().sequence, 5);
  assert.equal(f.channel.journal.entries().length, 4);
});
test("same completed message ID returns pinned historical outcome with current verified CAS, never reexecutes action", async (t) => {
  const f = fixture(t),
    bytes = f.message("q", "queue", 2, { revisionId: "one" });
  const saved = await f.channel.accept(bytes);
  await f.channel.accept(f.message("cancel", "cancel", 3));
  const replay = await f.channel.accept(bytes);
  assert.equal(replay.historical, true);
  assert.equal(replay.resultingSequence, saved.resultingSequence);
  assert.equal(replay.current.sequence, 4);
  assert.equal(f.store.read().queued, undefined);
  const changed = await f.channel.accept(f.message("q", "queue", 4, { revisionId: "two" }));
  assert.equal(changed.outcome, "refused");
  assert.equal(f.store.read().sequence, 4);
  f.channel.close();
  const reopened = f.reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.journal.entries().length, 4);
});
test("strict protocol rejects unknown authority fields, wrong identities, UTF8 and changed units without editor mutation", async (t) => {
  const f = fixture(t);
  const original = readFileSync(path.join(f.store.directory, "002.json"));
  for (const bad of [
    Buffer.from("{"),
    Buffer.from([255]),
    f.message("x", "execute"),
    f.message("x", "status", 2, { token: "forbidden" }),
    Buffer.from(f.message("x").toString().replace('"local"', '"other"')),
  ]) {
    assert.equal((await f.channel.accept(bad)).outcome, "refused");
  }
  assert.deepEqual(readFileSync(path.join(f.store.directory, "002.json")), original);
  assert.equal(f.channel.journal.entries().length, 5);
});
test("persisted limits and repeated/refused ingress accounting never reset on reopen, excess closes capacity permanently", async (t) => {
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, maxCommands: 3 });
  const bytes = f.message("same");
  await f.channel.accept(bytes);
  f.channel.close();
  const again = f.reopen();
  t.after(() => again.close());
  await again.accept(bytes);
  await again.accept(Buffer.from("{"));
  await assert.rejects(again.accept(bytes), /bound/);
  again.close();
  const third = f.reopen();
  t.after(() => third.close());
  await assert.rejects(third.accept(bytes), /exhausted/);
  assert.equal(third.journal.entries().length, 3);
  third.close();
  assert.throws(
    () => new LocalEditorChannel(f.root, "demo", "edit", "local", DEFAULT_LOCAL_EDITOR_LIMITS),
    /limits cannot change/,
  );
});
test("oversized received message is recorded once and aggregate overflow persists terminal accounting", async (t) => {
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, maxMessageBytes: 256, maxReceivedBytes: 300 });
  assert.equal((await f.channel.accept(Buffer.alloc(257))).outcome, "refused");
  await assert.rejects(f.channel.accept(Buffer.alloc(44)), /bound/);
  const terminal = JSON.parse(readFileSync(path.join(f.channel.journal.directory, "terminal.json"), "utf8"));
  assert.equal(terminal.receivedBytes, 301);
  assert.equal(terminal.commands, 2);
});
test("disconnect between immutable intent and action leaves pending receipt, never mutates or replays after reopen", async (t) => {
  const f = fixture(t),
    transport = new FakeTransport();
  f.channel.attach(transport);
  transport.emit(f.message("q", "queue", 2, { revisionId: "one" }));
  transport.disconnect();
  await wait(5);
  assert.equal(f.store.read().sequence, 2);
  assert.equal(f.channel.diagnostics().handlers, 0);
  assert.equal(transport.closed, true);
  const again = f.reopen();
  t.after(() => again.close());
  assert.equal(again.inspect().unresolved.length, 1);
  assert.equal((await again.accept(f.message("q", "queue", 2, { revisionId: "one" }))).outcome, "uncertain");
  assert.equal(f.store.read().sequence, 2);
});
test("fault after actual editor write retains unknown outcome; checked explicit reconciliation does not repeat or refund", async (t) => {
  const f = fixture(t);
  const original = f.channel.store.queue.bind(f.channel.store);
  f.channel.store.queue = (sequence, id) => {
    original(sequence, id);
    throw Error("injected after editor write");
  };
  const reply = await f.channel.accept(f.message("q", "queue", 2, { revisionId: "one" }));
  assert.equal(reply.outcome, "uncertain");
  assert.equal(f.store.read().sequence, 3);
  const blocked = await f.channel.accept(f.message("new", "cancel", 3));
  assert.equal(blocked.outcome, "uncertain");
  assert.equal(f.store.read().sequence, 3);
  const pending = f.channel.inspect().unresolved[0],
    snapshot = f.channel.inspect().current;
  const reconciled = await f.channel.accept(
    f.message("ack", "reconcile", 3, {
      pendingMessageId: "q",
      intentSha256: pending.intentSha256,
      currentStateSha256: snapshot.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  assert.equal(reconciled.outcome, "ok");
  assert.deepEqual(reconciled.unresolved, []);
  assert.equal(f.store.read().sequence, 3);
  assert.equal(f.store.read().queued, "one");
  assert.equal((await f.channel.accept(f.message("after", "cancel", 3))).outcome, "ok");
});
test("abort between editor action and outcome preserves mutation and pending intent", async (t) => {
  const f = fixture(t),
    transport = new FakeTransport(),
    signal = new AbortController();
  f.channel.attach(transport, signal.signal);
  const original = f.channel.store.queue.bind(f.channel.store);
  f.channel.store.queue = (sequence, id) => {
    const state = original(sequence, id);
    signal.abort();
    return state;
  };
  transport.emit(f.message("q", "queue", 2, { revisionId: "one" }));
  await wait(10);
  assert.equal(f.store.read().sequence, 3);
  assert.equal(f.channel.inspect().unresolved.length, 1);
  assert.equal(f.channel.diagnostics().handlers, 0);
  assert.equal(transport.sends, 0);
});
test("lost send after outcome is safe historical readback, original action never replayed", async (t) => {
  const f = fixture(t),
    transport = new FakeTransport();
  transport.throwing = true;
  f.channel.attach(transport);
  const bytes = f.message("q", "queue", 2, { revisionId: "one" });
  transport.emit(bytes);
  await wait(10);
  assert.equal(f.channel.diagnostics().closed, true);
  assert.equal(f.channel.inspect().unresolved.length, 0);
  const next = f.reopen();
  t.after(() => next.close());
  const replay = await next.accept(bytes);
  assert.equal(replay.historical, true);
  assert.equal(f.store.read().sequence, 3);
});
test("one reply slot: hanging send plus next message refuses backpressure, settles and cleans owned handlers", async (t) => {
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, settleMs: 30 }),
    transport = new FakeTransport();
  transport.hanging = true;
  f.channel.attach(transport);
  transport.emit(f.message("one"));
  await wait(5);
  transport.emit(f.message("two"));
  await wait(10);
  assert.equal(f.channel.diagnostics().closed, true);
  assert.equal(f.channel.diagnostics().handlers, 0);
  assert.equal(f.channel.journal.entries().length, 2);
  assert.equal(transport.messages.size, 0);
  assert.equal(transport.closes.size, 0);
});
async function drainLocalMicrotasks() {
  for (let turn = 0; turn < 32; turn++) await Promise.resolve();
}
function assertDeadlineCleanup(channel: LocalEditorChannel, transport: FakeTransport) {
  assert.equal(channel.diagnostics().closed, true);
  assert.equal(channel.diagnostics().handlers, 0);
  assert.equal(channel.diagnostics().timers, 0);
  assert.equal(transport.messages.size, 0);
  assert.equal(transport.closes.size, 0);
  assert.equal(transport.closed, true);
  assert.equal(existsSync(path.join(path.dirname(channel.journal.directory), "lease.json")), false);
}
test("mocked send settlement closes exactly after its bound, retains completed action and never replays after reopen", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, settleMs: 15 }),
    transport = new FakeTransport();
  transport.hanging = true;
  const originalRequest = readFileSync(path.resolve(f.root, f.store.read().revisions[0].request.path));
  let actions = 0;
  const queue = f.channel.store.queue.bind(f.channel.store);
  f.channel.store.queue = (sequence, id) => {
    actions++;
    return queue(sequence, id);
  };
  const bytes = f.message("q", "queue", 2, { revisionId: "one" });
  f.channel.attach(transport);
  transport.emit(bytes);
  await drainLocalMicrotasks();
  assert.equal(transport.sends, 1);
  assert.equal(actions, 1);
  assert.equal(f.channel.journal.entries()[0].outcome?.reply.outcome, "ok");
  t.mock.timers.tick(14);
  await drainLocalMicrotasks();
  assert.equal(f.channel.diagnostics().closed, false);
  t.mock.timers.tick(1);
  await drainLocalMicrotasks();
  assert.equal(f.channel.diagnostics().reason, "Local protocol/action/reply failed");
  assertDeadlineCleanup(f.channel, transport);
  const again = f.reopen();
  t.after(() => again.close());
  assert.equal(again.journal.meta.expiresAt, f.channel.journal.meta.expiresAt);
  again.store.queue = () => {
    throw Error("must not replay completed action");
  };
  const historical = await again.accept(bytes);
  assert.equal(historical.historical, true);
  assert.equal(historical.resultingSequence, 3);
  assert.equal(historical.current.sequence, 3);
  assert.equal(again.inspect().unresolvedCount, 0);
  assert.equal(actions, 1);
  assert.deepEqual(readFileSync(path.resolve(f.root, f.store.read().revisions[0].request.path)), originalRequest);
  again.close();
});
test("mocked idle expiry has an exact first reason and preserves input, state, liability and absolute expiration on reopen", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, idleMs: 50 }),
    transport = new FakeTransport(),
    original = readFileSync(path.join(f.store.directory, "002.json"));
  const requestPath = path.resolve(f.root, f.store.read().revisions[0].request.path),
    request = readFileSync(requestPath);
  f.channel.attach(transport);
  t.mock.timers.tick(49);
  assert.equal(f.channel.diagnostics().closed, false);
  t.mock.timers.tick(1);
  assert.equal(f.channel.diagnostics().reason, "Local channel idle deadline");
  assertDeadlineCleanup(f.channel, transport);
  assert.equal(transport.sends, 0);
  assert.equal(f.channel.journal.entries().length, 0);
  const again = f.reopen();
  t.after(() => again.close());
  assert.equal(again.journal.meta.expiresAt, f.channel.journal.meta.expiresAt);
  assert.equal(again.store.read().committedUsd, 0);
  assert.equal(again.store.read().sequence, 2);
  assert.deepEqual(readFileSync(path.join(f.store.directory, "002.json")), original);
  assert.deepEqual(readFileSync(requestPath), request);
  again.close();
});
test("mocked total expiry wins despite refreshed idle and does not renew expired receipts or execute new input", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: Date.now() });
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, totalMs: 1000, idleMs: 500 }),
    transport = new FakeTransport(),
    original = readFileSync(path.join(f.store.directory, "002.json"));
  const requestPath = path.resolve(f.root, f.store.read().revisions[0].request.path),
    request = readFileSync(requestPath);
  f.channel.attach(transport);
  for (const id of ["s1", "s2"]) {
    t.mock.timers.tick(400);
    transport.emit(f.message(id));
    await drainLocalMicrotasks();
  }
  assert.equal(transport.sends, 2);
  assert.equal(f.channel.journal.entries().length, 2);
  t.mock.timers.tick(199);
  assert.equal(f.channel.diagnostics().closed, false);
  t.mock.timers.tick(1);
  assert.equal(f.channel.diagnostics().reason, "Local channel total deadline");
  assertDeadlineCleanup(f.channel, transport);
  assert.equal(f.store.read().sequence, 2);
  assert.equal(f.store.read().committedUsd, 0);
  const before = new Map(
    readdirSync(f.channel.journal.directory).map((name) => [
      name,
      readFileSync(path.join(f.channel.journal.directory, name)),
    ]),
  );
  const again = f.reopen();
  t.after(() => again.close());
  assert.equal(again.journal.meta.expiresAt, f.channel.journal.meta.expiresAt);
  let actions = 0;
  again.store.queue = () => {
    actions++;
    throw Error("expired input cannot execute");
  };
  await assert.rejects(
    again.accept(f.message("late", "queue", 2, { revisionId: "one" })),
    /absolute deadline bound expired/,
  );
  assert.equal(actions, 0);
  assert.deepEqual(readdirSync(again.journal.directory).sort(), [...before.keys()].sort());
  for (const [name, bytes] of before) assert.deepEqual(readFileSync(path.join(again.journal.directory, name)), bytes);
  assert.deepEqual(readFileSync(path.join(f.store.directory, "002.json")), original);
  assert.deepEqual(readFileSync(requestPath), request);
});
test("historical reply refuses changed snapshot and original request pins; absent/foreign outcome members fail closed", async (t) => {
  const f = fixture(t);
  await f.channel.accept(f.message("s"));
  const source = path.resolve(f.root, f.store.read().revisions[0].request.path);
  writeFileSync(source, "{}");
  await assert.rejects(f.channel.accept(f.message("s", "status", 2)), /hash mismatch|pin changed/);
});
test("source helper consumes bounded regular files, refuses FIFO/symlink and sparse oversized sidecar without blocking", async (t) => {
  const f = fixture(t);
  await f.channel.accept(f.message("s"));
  const outcome = path.join(f.channel.journal.directory, "000.outcome.json");
  rmSync(outcome);
  symlinkSync(path.join(f.root, "public/projects/demo/project.json"), outcome);
  assert.throws(() => f.channel.inspect(), /symlink/);
  rmSync(outcome);
  const fifo = spawnSync("mkfifo", [outcome], { timeout: 1000 });
  assert.equal(fifo.status, 0);
  const start = Date.now();
  assert.throws(() => f.channel.inspect(), /regular/);
  assert.ok(Date.now() - start < 500);
  rmSync(outcome);
  const fd = await import("node:fs");
  const file = path.join(f.channel.journal.directory, "unknown.json");
  writeFileSync(file, "");
  fd.truncateSync(file, 65537);
  assert.throws(() => f.channel.inspect(), /unknown/);
});
test("live lease rejects concurrent channel; dead owned subprocess lease can be reclaimed only without replay", async (t) => {
  const f = fixture(t);
  assert.throws(() => f.reopen(), /already owned/);
  f.channel.close();
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "-e",
      `import * as channelModule from './src/lib/realtime/channel.ts';const {LocalEditorChannel}=channelModule.default??channelModule;new LocalEditorChannel(${JSON.stringify(f.root)},'demo','edit','local');process.exit(0);`,
    ],
    {
      cwd: process.cwd(),
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME! },
      encoding: "utf8",
      timeout: SPAWN_TIMEOUT_MS,
    },
  );
  assert.equal(child.status, 0, child.stderr);
  const reclaimed = f.reopen();
  t.after(() => reclaimed.close());
  assert.equal(reclaimed.inspect().current.sequence, 2);
});
test("reconciliation refuses wrong target/current pin and cannot clear uncertain handoff liability", async (t) => {
  const f = fixture(t);
  await f.channel.accept(f.message("q", "queue", 2, { revisionId: "one" }));
  await f.channel.accept(f.message("h", "handoff", 3));
  await f.channel.accept(f.message("c", "cancel", 4));
  assert.equal(f.store.read().revisions[0].status, "uncertain");
  assert.equal(f.store.read().committedUsd, 0.5);
  const bad = await f.channel.accept(
    f.message("bad", "reconcile", 5, {
      pendingMessageId: "missing",
      intentSha256: "a".repeat(64),
      currentStateSha256: f.channel.inspect().current.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  assert.equal(bad.outcome, "uncertain");
  assert.equal(f.store.read().committedUsd, 0.5);
});
test("derive only declared controls; exact original inline input preserved and fresh positive quote required", async (t) => {
  const f = fixture(t),
    before = f.store.request("one");
  const result = await f.channel.accept(
    f.message("derive", "derive", 2, {
      patch: {
        sourceRevision: "one",
        revisionId: "three",
        sessionId: "capture-three",
        input: { prompt: "new local draft", seed: 35 },
        quote: f.quote,
      },
    }),
  );
  assert.equal(result.outcome, "ok");
  assert.equal(f.store.request("three").operation.input.image_url, before.operation.input.image_url);
  assert.equal(result.association?.requestSha256, f.store.read().revisions[2].request.sha256);
  assert.equal(f.store.read().committedUsd, 0);
  const refused = await f.channel.accept(
    f.message("unsafe", "derive", 3, {
      patch: {
        sourceRevision: "one",
        revisionId: "four",
        sessionId: "capture-four",
        input: { image_url: "new" },
        quote: f.quote,
      },
    }),
  );
  assert.equal(refused.outcome, "refused");
});
test("completed response receipt binding and historical sequence cannot be relabeled without refusal", async (t) => {
  const f = fixture(t);
  await f.channel.accept(f.message("s"));
  const file = path.join(f.channel.journal.directory, "000.outcome.json");
  const outcome = JSON.parse(readFileSync(file, "utf8"));
  outcome.reply.messageId = "other";
  writeFileSync(file, JSON.stringify(outcome));
  assert.throws(() => f.channel.inspect(), /binding/);
});
test("finite injected transport keeps exact request/reply hashes and default accepted snapshot bytes untouched by status", async (t) => {
  const f = fixture(t),
    transport = new FakeTransport(),
    before = readFileSync(path.join(f.store.directory, "002.json"));
  f.channel.attach(transport);
  const input = f.message("s");
  transport.emit(input);
  await wait(5);
  const reply = LocalEditorReplySchema.parse(JSON.parse(transport.replies[0].toString()));
  assert.equal(reply.messageSha256, digest(input));
  assert.deepEqual(readFileSync(path.join(f.store.directory, "002.json")), before);
  assert.equal(reply.providerPersistent, false);
  f.channel.close();
  assert.equal(transport.closed, true);
  assert.equal(transport.messages.size + transport.closes.size, 0);
  assert.equal(existsSync(path.join(path.dirname(f.channel.journal.directory), "lease.json")), false);
  assert.equal(readdirSync(f.channel.journal.directory).length, 3);
});

test("historical source snapshot and reported resulting sequence/hash stay bound independently of current CAS", async (t) => {
  const f = fixture(t);
  await f.channel.accept(f.message("q", "queue", 2, { revisionId: "one" }));
  await f.channel.accept(f.message("c", "cancel", 3));
  const file = path.join(f.channel.journal.directory, "000.outcome.json"),
    original = readFileSync(file);
  const raw = JSON.parse(original.toString());
  raw.reply.resultingSequence = 4;
  writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => f.channel.inspect(), /snapshot pin/);
  writeFileSync(file, original);
  const historical = path.join(f.store.directory, "003.json");
  writeFileSync(historical, Buffer.concat([readFileSync(historical), Buffer.from(" ")]));
  assert.throws(() => f.channel.inspect(), /pin changed|byte bound/);
});
test("same-FD growth and snapshot alias replacement are bounded refusals, not consumed-byte identity success", async (t) => {
  const f = fixture(t);
  const { channelRead } = await import("../src/lib/realtime/channel-files");
  const fs = await import("node:fs");
  const { syncBuiltinESMExports } = await import("node:module");
  const file = path.join(f.root, "growth.json");
  writeFileSync(file, '{"a":1}');
  const original = fs.default.readSync;
  let done = false;
  fs.default.readSync = ((...args: Parameters<typeof original>) => {
    const result = Reflect.apply(original, fs.default, args);
    if (!done && fs.fstatSync(args[0]).ino === fs.statSync(file).ino) {
      done = true;
      fs.appendFileSync(file, " ");
    }
    return result;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    assert.throws(() => channelRead(f.root, file, 1024), /grew|changed/);
  } finally {
    fs.default.readSync = original;
    syncBuiltinESMExports();
  }
  await f.channel.accept(f.message("s"));
  const outcome = path.join(f.channel.journal.directory, "000.outcome.json");
  rmSync(outcome);
  writeFileSync(outcome, "");
  fs.truncateSync(outcome, 65537);
  assert.throws(() => f.channel.inspect(), /byte bound/);
});
test("aggregate editor session-count capacity is not reset by new localSessionId or lease reopen", async (t) => {
  const f = fixture(t);
  f.channel.close();
  for (let index = 1; index < 32; index++) {
    const c = new LocalEditorChannel(f.root, "demo", "edit", `session-${index}`);
    c.close();
  }
  assert.throws(() => new LocalEditorChannel(f.root, "demo", "edit", "overflow-session"), /aggregate channel capacity/);
  const reopened = f.reopen();
  t.after(() => reopened.close());
  assert.equal(reopened.inspect().current.sequence, 2);
});
test("interrupted lease with pending intent can be inspected/reconciled but cannot replay on process takeover", async (t) => {
  const f = fixture(t);
  f.channel.close();
  const script = `import * as channelModule from './src/lib/realtime/channel.ts';const {LocalEditorChannel}=channelModule.default??channelModule; const c=new LocalEditorChannel(${JSON.stringify(f.root)},'demo','edit','local');c.store.queue=()=>{throw Error('fixture stopped before local mutation')};await c.accept(Buffer.from(${JSON.stringify(f.message("q", "queue", 2, { revisionId: "one" }).toString())}));process.exit(0);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME! },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  assert.equal(child.status, 0, child.stderr);
  const next = f.reopen();
  t.after(() => next.close());
  assert.equal(next.inspect().unresolved.length, 1);
  assert.equal(next.store.read().sequence, 2);
  const replay = await next.accept(f.message("q", "queue", 2, { revisionId: "one" }));
  assert.equal(replay.outcome, "uncertain");
  assert.equal(next.store.read().sequence, 2);
  next.close();
  const fresh = nextSession(t, f, "dead-lease-fresh");
  assert.equal(fresh.channel.inspect().unresolvedCount, 1);
  assert.equal(
    (await fresh.channel.accept(fresh.message("new", "queue", 2, { revisionId: "two" }))).outcome,
    "uncertain",
  );
  assert.equal(f.store.read().sequence, 2);
});
test("foreign/same-seed capture receipt and late result cannot become completed preview without genuine published pins", async (t) => {
  const f = fixture(t);
  await f.channel.accept(f.message("q", "queue", 2, { revisionId: "one" }));
  await f.channel.accept(f.message("h", "handoff", 3));
  const manifests = path.join(f.project, "pipeline/realtime");
  mkdirSync(manifests, { recursive: true });
  const request = f.store.read().revisions[1];
  writeFileSync(
    path.join(manifests, "foreign.json"),
    JSON.stringify({
      projectId: "demo",
      sessionId: request.sessionId,
      revisionId: request.revisionId,
      inputHash: request.inputHash,
      operationId: `realtime:${request.sessionId}`,
      provenance: { providerAck: false },
      endpoint: "fal-ai/flux-2/klein/realtime",
      frames: [{ path: "original.png", sha256: "b".repeat(64) }],
    }),
  );
  const reply = await f.channel.accept(
    f.message("fake", "complete", 4, { revisionId: "one", manifest: "pipeline/realtime/foreign.json" }),
  );
  assert.equal(reply.outcome, "uncertain");
  assert.equal(f.store.read().revisions[0].status, "in-flight");
  assert.equal(f.store.read().selected, undefined);
  assert.equal(f.store.read().committedUsd, 0.5);
});

test("historical reply keeps all saved source pins and verifies newly added current revision separately", async (t) => {
  const f = fixture(t);
  const input = f.message("old-status");
  await f.channel.accept(input);
  await f.channel.accept(
    f.message("new", "derive", 2, {
      patch: {
        sourceRevision: "one",
        revisionId: "three",
        sessionId: "capture-three",
        input: { prompt: "new revision" },
        quote: f.quote,
      },
    }),
  );
  const historical = await f.channel.accept(input);
  assert.equal(historical.current.sequence, 3);
  assert.equal(historical.historical, true);
  const file = path.join(f.channel.journal.directory, "000.outcome.json"),
    raw = JSON.parse(readFileSync(file, "utf8"));
  raw.pins = raw.pins.filter((pin: { path: string }) => !pin.path.endsWith(".request.json"));
  writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => f.channel.inspect(), /source\/output pin missing/);
});

test("cleanup failures do not cause unhandled rejection or unlink replaced/unrelated lease targets", async (t) => {
  const f = fixture(t),
    transport = new FakeTransport();
  transport.close = () => {
    throw Error("injected close failure");
  };
  f.channel.attach(transport);
  const lease = path.join(path.dirname(f.channel.journal.directory), "lease.json"),
    unrelated = path.join(f.root, "unrelated.json");
  writeFileSync(unrelated, "retained unrelated bytes");
  rmSync(lease);
  symlinkSync(unrelated, lease);
  assert.doesNotThrow(() => f.channel.close());
  await wait(5);
  assert.equal(readFileSync(unrelated, "utf8"), "retained unrelated bytes");
  assert.equal(f.channel.diagnostics().handlers, 0);
  assert.equal(f.channel.diagnostics().timers, 0);
  assert.match(f.channel.diagnostics().reason!, /release refused/);
});

test("isolated idle timer with FIFO lease records secondary cleanup refusal without uncaught errors or unrelated writes", async (t) => {
  const f = fixture(t);
  f.channel.close();
  const script = `import * as channelModule from './src/lib/realtime/channel.ts';const {LocalEditorChannel}=channelModule.default??channelModule;import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';let uncaught=0;process.on('uncaughtException',()=>{uncaught++});process.on('unhandledRejection',()=>{uncaught++});const c=new LocalEditorChannel(${JSON.stringify(f.root)},'demo','edit','timer',{...${JSON.stringify(DEFAULT_LOCAL_EDITOR_LIMITS)},idleMs:20,totalMs:80});const lease=path.join(path.dirname(c.journal.directory),'lease.json');fs.unlinkSync(lease);const p=spawnSync('mkfifo',[lease],{timeout:1000});if(p.status!==0)process.exit(2);await new Promise(r=>setTimeout(r,50));console.log(JSON.stringify({diagnostics:c.diagnostics(),uncaught,fifo:fs.lstatSync(lease).isFIFO(),sequence:c.store.read().sequence}));process.exit(uncaught?3:0);`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: process.cwd(),
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME! },
    encoding: "utf8",
    timeout: SPAWN_TIMEOUT_MS,
  });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.uncaught, 0);
  assert.equal(result.fifo, true);
  assert.equal(result.sequence, 2);
  assert.equal(result.diagnostics.closed, true);
  assert.equal(result.diagnostics.handlers, 0);
  assert.equal(result.diagnostics.timers, 0);
  assert.match(result.diagnostics.reason, /release refused/);
});
test("onClose with corrupt lease does not throw, replay an action or unlink changed ownership evidence", async (t) => {
  const f = fixture(t),
    transport = new FakeTransport();
  f.channel.attach(transport);
  const lease = path.join(path.dirname(f.channel.journal.directory), "lease.json");
  writeFileSync(lease, "{");
  assert.doesNotThrow(() => transport.disconnect());
  await wait(5);
  assert.equal(readFileSync(lease, "utf8"), "{");
  assert.equal(f.store.read().sequence, 2);
  assert.equal(f.channel.diagnostics().handlers, 0);
  assert.equal(f.channel.diagnostics().timers, 0);
  assert.match(f.channel.diagnostics().reason!, /release refused/);
});

test("absolute deadline is checked after synchronous local mutation, not only by a deferred timer", async (t) => {
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, totalMs: 300 }),
    original = f.channel.store.queue.bind(f.channel.store);
  f.channel.store.queue = (sequence, id) => {
    const result = original(sequence, id);
    const end = Date.now() + 350;
    while (Date.now() < end) {
      /* bounded injected synchronous IO stall */
    }
    return result;
  };
  const result = await f.channel.accept(f.message("q", "queue", 2, { revisionId: "one" }));
  assert.equal(result.outcome, "uncertain");
  assert.equal(f.store.read().sequence, 3);
  assert.equal(f.channel.inspect().unresolved.length, 1);
  assert.equal(f.channel.diagnostics().closed, true);
  assert.equal(f.channel.diagnostics().timers, 0);
});

test("late callback after cleanup and synchronous disconnect during registration do not resurrect timers/handlers", async (t) => {
  const f = fixture(t),
    transport = new FakeTransport();
  f.channel.attach(transport);
  const late = [...transport.messages][0];
  f.channel.close();
  late(f.message("late"));
  await wait(5);
  assert.equal(f.channel.diagnostics().timers, 0);
  assert.equal(f.channel.journal.entries().length, 0);
  const next = f.reopen();
  t.after(() => next.close());
  const immediate = new FakeTransport();
  immediate.onClose = (cb) => {
    immediate.closes.add(cb);
    cb();
    return () => {
      immediate.closes.delete(cb);
    };
  };
  assert.doesNotThrow(() => next.attach(immediate));
  assert.equal(next.diagnostics().closed, true);
  assert.equal(immediate.closes.size + immediate.messages.size, 0);
  assert.equal(next.diagnostics().handlers, 0);
  assert.equal(next.diagnostics().timers, 0);
});

function nextSession(t: test.TestContext, f: ReturnType<typeof fixture>, localSessionId: string) {
  const channel = new LocalEditorChannel(f.root, "demo", "edit", localSessionId);
  t.after(() => channel.close());
  const message = (messageId: string, action = "status", expectedSequence = f.store.read().sequence, payload = {}) =>
    Buffer.from(
      JSON.stringify({ version: 1, localSessionId, editorId: "edit", messageId, expectedSequence, action, ...payload }),
    );
  return { channel, message };
}
async function unknownQueue(f: ReturnType<typeof fixture>) {
  const original = f.channel.store.queue.bind(f.channel.store);
  f.channel.store.queue = (sequence, id) => {
    original(sequence, id);
    throw Error("injected uncertain after queue publication");
  };
  const reply = await f.channel.accept(f.message("unknown", "queue", 2, { revisionId: "one" }));
  assert.equal(reply.outcome, "uncertain");
  assert.equal(f.store.read().sequence, 3);
  return reply;
}
test("expired predecessor blocks fresh-ID mutations; exact checked acknowledgement never replays or changes expired bytes", async (t) => {
  const f = fixture(t, { ...DEFAULT_LOCAL_EDITOR_LIMITS, totalMs: 300, idleMs: 300 });
  await unknownQueue(f);
  const oldDirectory = f.channel.journal.directory,
    original = new Map(readdirSync(oldDirectory).map((name) => [name, readFileSync(path.join(oldDirectory, name))]));
  f.channel.close();
  await wait(310);
  const expired = f.reopen();
  t.after(() => expired.close());
  await assert.rejects(expired.accept(f.message("expired")), /deadline|closed/);
  expired.close();
  const fresh = nextSession(t, f, "fresh");
  const status = fresh.channel.inspect();
  assert.equal(status.unresolvedCount, 1);
  assert.equal(status.unresolved[0].localSessionId, "local");
  assert.equal(
    (await fresh.channel.accept(fresh.message("blocked", "queue", 3, { revisionId: "two" }))).outcome,
    "uncertain",
  );
  assert.equal(f.store.read().sequence, 3);
  let actions = 0;
  const queue = fresh.channel.store.queue.bind(fresh.channel.store);
  fresh.channel.store.queue = (seq, id) => {
    actions++;
    return queue(seq, id);
  };
  const pending = status.unresolved[0];
  const ackBytes = fresh.message("ack", "reconcile", 3, {
    targetLocalSessionId: "local",
    pendingMessageId: pending.messageId,
    intentSha256: pending.intentSha256,
    currentStateSha256: status.current.stateSha256,
    acknowledge: "unknown-local-outcome-no-replay",
  });
  const acknowledged = await fresh.channel.accept(ackBytes);
  assert.equal(acknowledged.outcome, "ok");
  assert.equal(acknowledged.unresolvedCount, 0);
  assert.equal(actions, 0);
  assert.equal(f.store.read().sequence, 3);
  assert.equal(f.store.read().committedUsd, 0);
  for (const [name, bytes] of original) assert.deepEqual(readFileSync(path.join(oldDirectory, name)), bytes);
  assert.deepEqual(readdirSync(oldDirectory).sort(), [...original.keys()].sort());
  assert.equal((await fresh.channel.accept(fresh.message("new", "queue", 3, { revisionId: "two" }))).outcome, "ok");
  assert.equal(actions, 1);
  const historical = await fresh.channel.accept(ackBytes);
  assert.equal(historical.historical, true);
  assert.equal(historical.resultingSequence, 3);
  assert.equal(historical.current.sequence, 4);
  assert.equal(historical.unresolvedCount, 0);
  assert.equal(actions, 1);
});
test("partial acknowledgement/outcome pair clears neither target nor new reconciliation and is never auto-published", async (t) => {
  const f = fixture(t);
  await unknownQueue(f);
  f.channel.close();
  const fresh = nextSession(t, f, "partial"),
    status = fresh.channel.inspect(),
    target = status.unresolved[0];
  const finish = fresh.channel.journal.finish.bind(fresh.channel.journal);
  fresh.channel.journal.finish = () => {
    throw Error("injected between ack and outcome");
  };
  await assert.rejects(
    fresh.channel.accept(
      fresh.message("ack", "reconcile", 3, {
        targetLocalSessionId: "local",
        pendingMessageId: target.messageId,
        intentSha256: target.intentSha256,
        currentStateSha256: status.current.stateSha256,
        acknowledge: "unknown-local-outcome-no-replay",
      }),
    ),
    /between ack/,
  );
  fresh.channel.journal.finish = finish;
  assert.ok(existsSync(path.join(fresh.channel.journal.directory, "000.ack.json")));
  assert.equal(existsSync(path.join(fresh.channel.journal.directory, "000.outcome.json")), false);
  const next = nextSession(t, f, "after-partial");
  const pending = next.channel.inspect();
  assert.equal(pending.unresolvedCount, 2);
  assert.deepEqual(new Set(pending.unresolved.map((p) => p.localSessionId)), new Set(["local", "partial"]));
  assert.equal((await next.channel.accept(next.message("new", "cancel", 3))).outcome, "uncertain");
  assert.equal(f.store.read().sequence, 3);
  // Acknowledge only the interrupted acknowledgement; original queue remains unknown.
  const interrupted = pending.unresolved.find((p) => p.localSessionId === "partial")!;
  const result = await next.channel.accept(
    next.message("ack-partial", "reconcile", 3, {
      targetLocalSessionId: "partial",
      pendingMessageId: interrupted.messageId,
      intentSha256: interrupted.intentSha256,
      currentStateSha256: pending.current.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  assert.equal(result.unresolvedCount, 1);
  assert.equal(result.unresolved[0].localSessionId, "local");
  assert.equal(f.store.read().sequence, 3);
});
test("session-qualified duplicate IDs, wrong target and current pin cannot acknowledge another history", async (t) => {
  const f = fixture(t);
  await unknownQueue(f);
  f.channel.close();
  const second = nextSession(t, f, "second");
  // Disconnect after a reconcile intent with wrong session: it stays independently unknown.
  const first = second.channel.inspect().unresolved[0];
  const wrong = await second.channel.accept(
    second.message("unknown", "reconcile", 3, {
      targetLocalSessionId: "absent",
      pendingMessageId: first.messageId,
      intentSha256: first.intentSha256,
      currentStateSha256: second.channel.inspect().current.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  assert.equal(wrong.outcome, "uncertain");
  second.channel.close();
  const third = nextSession(t, f, "third");
  const all = third.channel.inspect();
  assert.equal(all.unresolvedCount, 2);
  assert.equal(all.unresolved.filter((p) => p.messageId === "unknown").length, 2);
  const correct = await third.channel.accept(
    third.message("ack-local", "reconcile", 3, {
      targetLocalSessionId: "local",
      pendingMessageId: first.messageId,
      intentSha256: first.intentSha256,
      currentStateSha256: all.current.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  assert.equal(correct.unresolvedCount, 1);
  assert.equal(correct.unresolved[0].localSessionId, "second");
  assert.equal(f.store.read().sequence, 3);
});
test("predecessor metadata, acknowledgement crossrefs and source pins are checked before mutation, not dropped", async (t) => {
  for (const kind of ["metadata", "before", "ack", "fifo", "source"] as const) {
    await t.test(kind, async (t) => {
      const f = fixture(t);
      await unknownQueue(f);
      f.channel.close();
      const fresh = nextSession(t, f, "fresh");
      const status = fresh.channel.inspect(),
        pending = status.unresolved[0];
      if (kind === "ack") {
        await fresh.channel.accept(
          fresh.message("ack", "reconcile", 3, {
            targetLocalSessionId: "local",
            pendingMessageId: pending.messageId,
            intentSha256: pending.intentSha256,
            currentStateSha256: status.current.stateSha256,
            acknowledge: "unknown-local-outcome-no-replay",
          }),
        );
        const file = path.join(fresh.channel.journal.directory, "000.ack.json");
        const value = JSON.parse(readFileSync(file, "utf8"));
        value.targetLocalSessionId = "foreign";
        writeFileSync(file, JSON.stringify(value));
      } else if (kind === "source") {
        writeFileSync(path.resolve(f.root, f.store.read().revisions[0].request.path), "{}");
      } else {
        const file = path.join(f.channel.journal.directory, kind === "metadata" ? "session.json" : "000.ingress.json");
        if (kind === "fifo") {
          rmSync(file);
          const r = spawnSync("mkfifo", [file], { timeout: 1000 });
          assert.equal(r.status, 0);
        } else {
          const value = JSON.parse(readFileSync(file, "utf8"));
          if (kind === "metadata") value.editorId = "foreign";
          else value.before.sha256 = "f".repeat(64);
          writeFileSync(file, JSON.stringify(value));
        }
      }
      const before = readFileSync(path.join(f.store.directory, "003.json"));
      await assert.rejects(
        fresh.channel.accept(fresh.message("new", "queue", 3, { revisionId: "two" })),
        /identity|pin|receipt|regular|hash|binding/,
      );
      assert.deepEqual(readFileSync(path.join(f.store.directory, "003.json")), before);
      assert.equal(existsSync(path.join(f.store.directory, "004.json")), false);
    });
  }
});
test("historical duplicate refreshes editor-global barrier while retaining its original outcome sequence", async (t) => {
  const f = fixture(t);
  const bytes = f.message("status");
  const saved = await f.channel.accept(bytes);
  f.channel.close();
  const other = nextSession(t, f, "other"),
    original = other.channel.store.queue.bind(other.channel.store);
  other.channel.store.queue = (s, id) => {
    original(s, id);
    throw Error("after write");
  };
  assert.equal(
    (await other.channel.accept(other.message("q", "queue", 2, { revisionId: "one" }))).outcome,
    "uncertain",
  );
  other.channel.close();
  const reopened = f.reopen();
  t.after(() => reopened.close());
  const historical = await reopened.accept(bytes);
  assert.equal(historical.historical, true);
  assert.equal(historical.resultingSequence, saved.resultingSequence);
  assert.equal(historical.current.sequence, 3);
  assert.equal(historical.unresolvedCount, 1);
  assert.equal(historical.unresolved[0].localSessionId, "other");
});
test("complete unresolved set blocks mutations beyond the bounded 64-row reply prefix", async (t) => {
  const f = fixture(t);
  const firstState = f.store.read();
  for (let i = 0; i < 40; i++) {
    const bytes = f.message(`p-${i}`, "queue", 2, { revisionId: "one" });
    f.channel.journal.receive(bytes, JSON.parse(bytes.toString()), f.channel.journal.snapshot(firstState), true);
  }
  f.channel.close();
  const second = nextSession(t, f, "second");
  for (let i = 0; i < 40; i++) {
    const bytes = second.message(`p-${i}`, "queue", 2, { revisionId: "two" });
    second.channel.journal.receive(
      bytes,
      JSON.parse(bytes.toString()),
      second.channel.journal.snapshot(firstState),
      true,
    );
  }
  second.channel.close();
  const third = nextSession(t, f, "third");
  const status = third.channel.inspect();
  assert.equal(status.unresolvedCount, 80);
  assert.equal(status.unresolved.length, 64);
  assert.equal(status.unresolvedTruncated, true);
  assert.equal(
    (await third.channel.accept(third.message("new", "queue", 2, { revisionId: "two" }))).outcome,
    "uncertain",
  );
  assert.equal(f.store.read().sequence, 2);
});
test("history membership and consumed pins cannot change between initial discovery and mutation admission", async (t) => {
  const f = fixture(t);
  await unknownQueue(f);
  f.channel.close();
  const fresh = nextSession(t, f, "fresh");
  const original = fresh.channel.journal.receive.bind(fresh.channel.journal);
  fresh.channel.journal.receive = (...args) => {
    const entry = original(...args);
    const file = path.join(f.channel.journal.directory, "session.json");
    const bytes = readFileSync(file);
    writeFileSync(file, Buffer.concat([bytes, Buffer.from(" ")]));
    return entry;
  };
  await assert.rejects(fresh.channel.accept(fresh.message("status")), /pin changed|regular byte bound/);
  assert.equal(f.store.read().sequence, 3);
});
test("journal consumed-byte accounting is shared across repeated reads and resets only at operation boundary", (t) => {
  const f = fixture(t);
  const journal = f.channel.journal;
  const state = f.store.read(),
    actual = journal.snapshot(state).byteLength;
  // Boundary injection avoids a 256MiB fixture: the next reads still consume genuine same-FD bytes.
  const counter = journal as unknown as { verifiedBytes: number };
  journal.beginVerification();
  counter.verifiedBytes = 256 * 1024 * 1024 - actual * 2;
  journal.snapshot(state);
  assert.equal(counter.verifiedBytes, 256 * 1024 * 1024 - actual);
  journal.snapshot(state);
  assert.equal(counter.verifiedBytes, 256 * 1024 * 1024);
  assert.throws(() => journal.snapshot(state), /aggregate verification byte bound/);
  journal.beginVerification();
  assert.equal(journal.snapshot(state).byteLength, actual);
  assert.equal(counter.verifiedBytes, actual);
});
async function expiredPair(t: test.TestContext, markerFault = false) {
  const f = fixture(t);
  await unknownQueue(f);
  f.channel.close();
  const active = new LocalEditorChannel(f.root, "demo", "edit", "late", {
    ...DEFAULT_LOCAL_EDITOR_LIMITS,
    totalMs: 1000,
    idleMs: 1000,
  });
  t.after(() => active.close());
  const message = Buffer.from(
    JSON.stringify({
      version: 1,
      localSessionId: "late",
      editorId: "edit",
      messageId: "late-ack",
      expectedSequence: 3,
      action: "reconcile",
      targetLocalSessionId: "local",
      pendingMessageId: "unknown",
      intentSha256: active.inspect().unresolved[0].intentSha256,
      currentStateSha256: active.inspect().current.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  const fs = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module");
  const original = fs.default.linkSync;
  fs.default.linkSync = ((source, destination) => {
    const file = destination.toString();
    if (markerFault && file === path.join(active.journal.directory, "000.ack-failure.json"))
      throw Error("injected failure-marker disk refusal");
    original(source, destination);
    if (file === path.join(active.journal.directory, "000.outcome.json"))
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.max(1, active.journal.meta.expiresAt - Date.now() + 20),
      );
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    await assert.rejects(active.accept(message), markerFault ? /failure marker publication failed/ : /deadline/);
  } finally {
    fs.default.linkSync = original;
    syncBuiltinESMExports();
  }
  assert.ok(existsSync(path.join(active.journal.directory, "000.ack.json")));
  assert.ok(existsSync(path.join(active.journal.directory, "000.outcome.json")));
  return { f, active };
}
test("observed post-publication expiry retains paired receipts and exact failure marker; later ack never clears original by proxy", async (t) => {
  const { f, active } = await expiredPair(t);
  const markerFile = path.join(active.journal.directory, "000.ack-failure.json"),
    markerBytes = readFileSync(markerFile),
    marker = JSON.parse(markerBytes.toString());
  assert.equal(marker.ingressSha256, digest(readFileSync(path.join(active.journal.directory, "000.ingress.json"))));
  assert.equal(marker.outcomeSha256, digest(readFileSync(path.join(active.journal.directory, "000.outcome.json"))));
  assert.equal(marker.acknowledgementSha256, digest(readFileSync(path.join(active.journal.directory, "000.ack.json"))));
  assert.equal(marker.expiresAt, active.journal.meta.expiresAt);
  assert.ok(marker.observedAt >= marker.expiresAt);
  const next = nextSession(t, f, "after-late"),
    status = next.channel.inspect();
  assert.equal(status.unresolvedCount, 2);
  assert.equal((await next.channel.accept(next.message("new", "cancel", 3))).outcome, "uncertain");
  const target = status.unresolved.find((p) => p.localSessionId === "late")!;
  const acknowledged = await next.channel.accept(
    next.message("ack-late", "reconcile", 3, {
      targetLocalSessionId: "late",
      pendingMessageId: target.messageId,
      intentSha256: target.intentSha256,
      currentStateSha256: status.current.stateSha256,
      acknowledge: "unknown-local-outcome-no-replay",
    }),
  );
  assert.equal(acknowledged.unresolvedCount, 1);
  assert.equal(acknowledged.unresolved[0].localSessionId, "local");
  assert.equal(f.store.read().sequence, 3);
  assert.deepEqual(readFileSync(markerFile), markerBytes);
  const ack = JSON.parse(readFileSync(path.join(next.channel.journal.directory, "001.ack.json"), "utf8"));
  assert.equal(ack.targetFailureSha256, digest(markerBytes));
  assert.equal(ack.targetOutcomeSha256, marker.outcomeSha256);
  next.channel.close();
  for (const [field, value] of [
    ["index", 1],
    ["outcomeSha256", "f".repeat(64)],
    ["expiresAt", marker.expiresAt + 1],
    ["observedAt", marker.expiresAt - 1],
    ["editorId", "foreign"],
  ] as const) {
    writeFileSync(markerFile, JSON.stringify({ ...marker, [field]: value }));
    const bad = nextSession(t, f, `tamper-${field}`);
    assert.throws(() => bad.channel.inspect(), /failure binding/);
    bad.channel.close();
    writeFileSync(markerFile, markerBytes);
  }
});
test("observed expiry marker write failure records secondary uncertainty and does not pretend an unpersisted marker exists", async (t) => {
  const { f, active } = await expiredPair(t, true);
  assert.match(active.diagnostics().secondaryFailure!, /may remain unmarked/);
  assert.equal(existsSync(path.join(active.journal.directory, "000.ack-failure.json")), false);
  assert.equal(f.store.read().sequence, 3);
  // Deliberate crash/write-failure limit: reader cannot infer a missing marker. Do not claim atomic expiry.
  const next = nextSession(t, f, "after-marker-fault");
  assert.equal(next.channel.inspect().unresolvedCount, 0);
});
