import test from "node:test";
import assert from "node:assert/strict";
import { createReviewChannelClient } from "../src/lib/review-ui/realtime-channel-client";
import { digest } from "../src/lib/jobs/model-artifacts";
class Socket {
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  sent: string[] = [];
  closed = 0;
  send(raw: string) {
    this.sent.push(raw);
  }
  close() {
    this.closed++;
    this.onclose?.();
  }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(extra: Record<string, unknown> = {}) {
  const sockets: Socket[] = [],
    statuses: unknown[] = [],
    reads: any[] = [];
  const client = createReviewChannelClient({
    ticket: async (input) => ({
      version: 1,
      ...input,
      ticket: "a".repeat(64),
      expiresAt: Date.now() + 5000,
      path: "/api/realtime/channel",
      protocol: "avc-local-editor-v1",
      sequence: 1,
      stateSha256: "b".repeat(64),
      providerAck: false,
      providerPersistent: false,
      liveVerified: false,
    }),
    socket: () => {
      const socket = new Socket();
      sockets.push(socket);
      return socket;
    },
    hash: async (raw) => digest(raw),
    id: () => "message-" + Math.random().toString(16).slice(2),
    current: async (reply) => {
      reads.push(reply.current);
    },
    changed: () => {},
    status: (value) => statuses.push(value),
    ...extra,
  });
  const open = async () => {
    const opened = client.open("edit", "local");
    await tick();
    sockets.at(-1)!.onopen?.();
    await opened;
  };
  const reply = (socket: Socket, changes = {}) => {
    const raw = socket.sent.at(-1)!,
      message = JSON.parse(raw);
    socket.onmessage?.({
      data: JSON.stringify({
        version: 1,
        editorId: "edit",
        localSessionId: "local",
        messageId: message.messageId,
        messageSha256: digest(raw),
        action: message.action,
        expectedSequence: message.expectedSequence,
        outcome: "ok",
        historical: false,
        current: { sequence: 2, stateSha256: "c".repeat(64), committedPlanningUsd: 0, ceilingUsd: 2 },
        unresolved: [],
        providerAck: false,
        providerPersistent: false,
        liveVerified: false,
        ...changes,
      }),
    });
  };
  return { client, sockets, statuses, reads, open, reply };
}

test("explicit open sends no command or reconnect; each action has one exact correlated slot and reserved identity wins", async () => {
  const s = setup();
  await s.open();
  const socket = s.sockets[0];
  assert.equal(socket.sent.length, 0);
  const result = s.client.send("status", { version: 9, editorId: "other", messageId: "spoof" }, 1);
  assert.equal(s.client.busy(), true);
  await assert.rejects(s.client.send("queue", {}, 1), /pending reply/);
  await tick();
  const raw = JSON.parse(socket.sent[0]);
  assert.equal(raw.version, 1);
  assert.equal(raw.editorId, "edit");
  assert.notEqual(raw.messageId, "spoof");
  s.reply(socket);
  assert.equal((await result).outcome, "ok");
  s.client.close();
  assert.equal(socket.sent.length, 1);
  assert.equal(s.sockets.length, 1);
});
test("historical outcome is displayed separately and verified current readback is authority", async () => {
  const s = setup();
  await s.open();
  const result = s.client.send("queue", { revisionId: "one" }, 1);
  await tick();
  s.reply(s.sockets[0], {
    historical: true,
    resultingSequence: 2,
    stateSha256: "e".repeat(64),
    current: { sequence: 9, stateSha256: "d".repeat(64), committedPlanningUsd: 0.5, ceilingUsd: 2 },
  });
  await result;
  assert.equal(s.reads[0].sequence, 9);
  assert.equal((s.statuses.at(-1) as any).resultingSequence, 2);
  assert.equal((s.statuses.at(-1) as any).currentSequence, 9);
  s.client.close();
});
test("wrong correlation/identity/digest/provider flags/shape refuse before current readback and never retry", async () => {
  for (const change of [
    { messageId: "other" },
    { messageSha256: "e".repeat(64) },
    { editorId: "other" },
    { localSessionId: "other" },
    { providerAck: true },
    { providerPersistent: true },
    { liveVerified: true },
    { current: { sequence: 256, stateSha256: "f".repeat(64), committedPlanningUsd: 0, ceilingUsd: 2 } },
  ]) {
    const s = setup();
    await s.open();
    const result = s.client.send("status", {}, 1);
    await tick();
    s.reply(s.sockets[0], change);
    await assert.rejects(result, /correlation\/protocol/);
    assert.equal(s.reads.length, 0);
    assert.equal(s.sockets[0].sent.length, 1);
    assert.equal(s.client.active(), false);
  }
});
test("current-read failure/disconnect invalidate pending action; late async read cannot close a replacement connection", async () => {
  let done!: (value?: unknown) => void;
  const s = setup({
    current: () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  });
  await s.open();
  const result = s.client.send("status", {}, 1);
  await tick();
  s.reply(s.sockets[0]);
  await tick();
  s.client.close("switched editor");
  await assert.rejects(result, /switched editor/);
  await s.open();
  done();
  await tick();
  assert.equal(s.client.active(), true);
  assert.equal(s.sockets[1].closed, 0);
  assert.equal(s.sockets[1].sent.length, 0);
  s.client.close();
  const fail = setup({
    current: async () => {
      throw Error("Current pin changed");
    },
  });
  await fail.open();
  const pending = fail.client.send("status", {}, 1);
  await tick();
  fail.reply(fail.sockets[0]);
  await assert.rejects(pending, /Current pin changed/);
  assert.equal(fail.client.active(), false);
});
test("close during hashing settles immediately and cannot send late command", async () => {
  let finish!: (hash: string) => void;
  const s = setup({
    hash: () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  });
  await s.open();
  const pending = s.client.send("handoff", {}, 1);
  s.client.close("hide");
  await assert.rejects(pending, /hide/);
  finish("a".repeat(64));
  await tick();
  assert.equal(s.sockets[0].sent.length, 0);
  assert.equal(s.client.busy(), false);
});
test("oversized reply/request and nontext reply refuse with no accepted state", async () => {
  const s = setup();
  await s.open();
  await assert.rejects(s.client.send("derive", { text: "x".repeat(17000) }, 1), /16 KiB/);
  assert.equal(s.sockets[0].sent.length, 0);
  const result = s.client.send("status", {}, 1);
  await tick();
  s.sockets[0].onmessage?.({ data: new Uint8Array(2) });
  await assert.rejects(result, /bounded local reply/);
  assert.equal(s.reads.length, 0);
});
test("pending reply/hash deadline is finite and does not resend or reconnect", async () => {
  const s = setup({ hash: () => new Promise<string>(() => {}) });
  await s.open();
  const pending = s.client.send("queue", { revisionId: "one" }, 1);
  await assert.rejects(pending, /deadline/);
  assert.equal(s.sockets[0].sent.length, 0);
  assert.equal(s.sockets.length, 1);
  assert.equal(s.client.active(), false);
});
test("unknown barrier disables mutations but allows explicit status/reconcile, then releases only after checked reply", async () => {
  const row = { localSessionId: "old", messageId: "lost", intentSha256: "e".repeat(64) },
    s = setup();
  await s.open();
  let pending = s.client.send("status", {}, 1);
  await tick();
  s.reply(s.sockets[0], { unresolved: [row], unresolvedCount: 1, unresolvedTruncated: false });
  await pending;
  assert.equal(s.client.blocked(), true);
  await assert.rejects(s.client.send("handoff", {}, 1), /reconciliation/);
  assert.equal(s.sockets[0].sent.length, 1);
  pending = s.client.send(
    "reconcile",
    {
      targetLocalSessionId: "old",
      pendingMessageId: "lost",
      intentSha256: row.intentSha256,
      currentStateSha256: "c".repeat(64),
      acknowledge: "unknown-local-outcome-no-replay",
    },
    2,
  );
  await tick();
  s.reply(s.sockets[0], { unresolved: [], unresolvedCount: 0 });
  await pending;
  assert.equal(s.client.blocked(), false);
  s.client.close();
});
