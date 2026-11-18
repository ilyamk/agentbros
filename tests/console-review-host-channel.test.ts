/**
 * RFC 0004 WP13a: the realtime local channel (WebSocket) through the console's review host. One-use tickets over an
 * authenticated same-origin POST, the upgrade at `/api/review/<project>/realtime/channel` with the channel's unchanged
 * admission rules, one instance per project, and shutdown that closes sockets and releases leases.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import WebSocket from "ws";
import type { ConsoleServer } from "../src/lib/console/server";
import { inspectLocalEditorHistory } from "../src/lib/realtime/channel-journal";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
import { makeRoot, PROJECT, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const SECOND = "second-film";
const PROTOCOL = "avc-local-editor-v1";

const request = (projectId: string, revisionId: string) => ({
  version: 1 as const,
  projectId,
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
  const root = makeRoot();
  t.after(() => removeRoot(root));
  mkdirSync(path.join(root, "public/projects", SECOND, "pipeline"), { recursive: true });
  writeFileSync(path.join(root, "public/projects", SECOND, "project.json"), "{}");
  for (const project of [PROJECT, SECOND]) {
    const store = new RealtimeEditorStore(root, project, "edit");
    store.create(2);
    store.add(0, request(project, "one"));
  }
  return root;
}

async function ticketFor(server: ConsoleServer, project = PROJECT, localSessionId = "local") {
  const res = await raw(server.port, {
    method: "POST",
    path: `/api/review/${project}/realtime/channel-ticket`,
    headers: postHeaders(server),
    body: JSON.stringify({ editorId: "edit", localSessionId }),
  });
  assert.equal(res.status, 200, res.text);
  return res.json();
}

const channelUrl = (server: ConsoleServer, project = PROJECT, origin = server.origin) =>
  origin.replace("http:", "ws:") + `/api/review/${project}/realtime/channel`;

function connect(
  server: ConsoleServer,
  ticket: any,
  options: { project?: string; url?: string; ws?: WebSocket.ClientOptions } = {},
) {
  return new WebSocket(options.url ?? channelUrl(server, options.project), [ticket.protocol, "t." + ticket.ticket], {
    origin: server.origin,
    perMessageDeflate: false,
    ...options.ws,
  });
}

function refused(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => {
    ws.once("unexpected-response", (_req, res) => {
      res.resume();
      resolve(res.statusCode!);
      ws.terminate();
    });
    ws.on("error", () => resolve(-1));
  });
}

async function exchange(ws: WebSocket, payload: unknown) {
  const reply = once(ws, "message");
  ws.send(JSON.stringify(payload));
  return JSON.parse((await reply)[0].toString());
}

const status = (session: string, sequence: number) => ({
  version: 1,
  localSessionId: session,
  editorId: "edit",
  messageId: "status-" + session,
  expectedSequence: sequence,
  action: "status",
});

test("ticket over authenticated same-origin POST; upgrade at the console path; token never in the URL; one use", async (t) => {
  const root = fixture(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const ticketPath = `/api/review/${PROJECT}/realtime/channel-ticket`;
  const body = JSON.stringify({ editorId: "edit", localSessionId: "local" });
  for (const headers of [
    { ...postHeaders(server), "x-console-token": "" },
    { ...postHeaders(server), Origin: "https://evil.test" },
    { ...postHeaders(server), Host: "evil.test" },
  ])
    assert.equal((await raw(server.port, { method: "POST", path: ticketPath, headers, body })).status, 403);
  const ticket = await ticketFor(server);
  assert.equal(ticket.path, "/api/realtime/channel", "the channel's own path; the client builds the console URL");
  assert.equal(ticket.protocol, PROTOCOL);
  assert.equal(ticket.providerAck, false);
  const variants: { project?: string; url?: string; ws?: WebSocket.ClientOptions }[] = [
    { ws: { origin: "https://evil.test" } },
    { ws: { origin: `http://localhost:${server.port}` } },
    { ws: { headers: { "Sec-WebSocket-Extensions": "other-extension" } } },
    { ws: { headers: { "Sec-Fetch-Site": "cross-site" } } },
    { ws: { protocolVersion: 8 } },
    { url: server.origin.replace("http:", "ws:") + "/api/realtime/channel" },
    { url: channelUrl(server) + "?ticket=" + ticket.ticket },
    { url: server.origin.replace("http:", "ws:") + `/api/review/${PROJECT}/realtime/other` },
    { url: server.origin.replace("http:", "ws:") + "/api/stream" },
    { project: "no-such-film" },
    { project: SECOND },
  ];
  for (const options of variants)
    assert.equal(await refused(connect(server, ticket, options)), 403, JSON.stringify(options));
  const ws = connect(server, ticket);
  await once(ws, "open");
  assert.equal(ws.protocol, PROTOCOL);
  const reply = await exchange(ws, status("local", 1));
  assert.equal(reply.outcome, "ok");
  assert.equal(reply.current.sequence, 1);
  assert.equal(reply.providerAck, false);
  assert.equal(await refused(connect(server, ticket)), 403, "a ticket is one-use");
  // One socket per editor: a second ticket for the same editor is refused while the first is open.
  const second = await raw(server.port, {
    method: "POST",
    path: ticketPath,
    headers: postHeaders(server),
    body: JSON.stringify({ editorId: "edit", localSessionId: "again" }),
  });
  assert.equal(second.status, 400);
  // channel-state reads the same history.
  const state = await raw(server.port, {
    path: `/api/review/${PROJECT}/realtime/channel-state?editor=edit`,
    headers: { "x-console-token": server.token },
  });
  assert.equal(state.status, 200);
  assert.equal(state.json().leasePresent, true);
  const closed = once(ws, "close");
  ws.close();
  await closed;
});

test("localhost origin works through the localhost Host", async (t) => {
  const root = fixture(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const ticket = await ticketFor(server);
  const origin = `http://localhost:${server.port}`;
  const ws = new WebSocket(channelUrl(server, PROJECT, origin), [ticket.protocol, "t." + ticket.ticket], {
    origin,
    perMessageDeflate: false,
  });
  ws.on("error", () => {});
  await once(ws, "open");
  ws.terminate();
});

test("projects have their own channels: two projects' editors open at once", async (t) => {
  const root = fixture(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const [first, second] = [await ticketFor(server, PROJECT), await ticketFor(server, SECOND)];
  const a = connect(server, first);
  const b = connect(server, second, { project: SECOND });
  await Promise.all([once(a, "open"), once(b, "open")]);
  assert.notEqual(server.review.get(PROJECT).channels, server.review.get(SECOND).channels);
  assert.equal(server.review.get(PROJECT).channels.diagnostics().sockets, 1);
  assert.equal(server.review.get(SECOND).channels.diagnostics().sockets, 1);
  assert.equal((await exchange(b, status("local", 1))).outcome, "ok");
  a.terminate();
  b.terminate();
});

test("console shutdown closes the channel sockets and releases their leases (review:ui's Ctrl+C did not)", async (t) => {
  const root = fixture(t);
  const server = await startTestServer(root);
  const ws = connect(server, await ticketFor(server));
  await once(ws, "open");
  assert.equal(inspectLocalEditorHistory(new RealtimeEditorStore(root, PROJECT, "edit")).leasePresent, true);
  const closed = once(ws, "close");
  await server.close();
  await closed; // the channel terminates its transport (1006) or the server sends 1001; either way it is closed
  assert.equal(ws.readyState, WebSocket.CLOSED);
  assert.equal(inspectLocalEditorHistory(new RealtimeEditorStore(root, PROJECT, "edit")).leasePresent, false);
  assert.equal(server.review.closed, true);
  assert.throws(() => server.review.get(PROJECT), /closing/);
});

test("an exhausted channel instance (64 tickets) is replaced when idle, so a long-lived console keeps working", async (t) => {
  const root = fixture(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  const before = server.review.get(PROJECT).channels;
  (before as unknown as { issued: number }).issued = 64;
  const ticket = await ticketFor(server);
  const after = server.review.get(PROJECT).channels;
  assert.notEqual(after, before);
  assert.equal(before.diagnostics().closed, true);
  const ws = connect(server, ticket);
  await once(ws, "open");
  // While a socket is open the instance is kept (its caps still apply).
  (after as unknown as { issued: number }).issued = 64;
  const refusedTicket = await raw(server.port, {
    method: "POST",
    path: `/api/review/${PROJECT}/realtime/channel-ticket`,
    headers: postHeaders(server),
    body: JSON.stringify({ editorId: "other", localSessionId: "local" }),
  });
  assert.equal(refusedTicket.status, 400);
  assert.equal(server.review.get(PROJECT).channels, after);
  ws.terminate();
});

test("an upgrade without a ticket issued for that project never creates the project's services", async (t) => {
  const root = fixture(t);
  const server = await startTestServer(root);
  t.after(() => server.close());
  assert.equal(server.review.loaded(PROJECT), false);
  const forged = { protocol: PROTOCOL, ticket: "a".repeat(64) };
  assert.equal(await refused(connect(server, forged)), 403);
  assert.equal(server.review.loaded(PROJECT), false);
  // A ticket issued for one project does not open another project's channel.
  const ticket = await ticketFor(server, PROJECT);
  assert.equal(await refused(connect(server, ticket, { project: SECOND })), 403);
  assert.equal(server.review.loaded(SECOND), false);
  const ws = connect(server, ticket);
  await once(ws, "open");
  ws.terminate();
});

test("the per-project ticket rate (64 per 10 minutes) survives an instance swap; swap cleanup errors are logged and rethrown at close", async (t) => {
  const root = fixture(t);
  const { ReviewHost, CHANNEL_TICKET_RATE } = await import("../src/lib/console/review/host");
  let now = 1_000_000;
  const logs: string[] = [];
  const host = new ReviewHost(root, { now: () => now, log: (line) => logs.push(line) });
  let n = 0;
  const stub = () => {
    const channels = host.get(PROJECT).channels as unknown as { issue: (body: unknown) => unknown };
    channels.issue = () => ({ ticket: (n++).toString(16).padStart(64, "0"), expiresAt: Date.now() + 5000 });
  };
  stub();
  for (let i = 0; i < CHANNEL_TICKET_RATE.count - 1; i++) await host.issueTicket(PROJECT, {});
  // Exhaust the instance: the swap happens, its cleanup fails, the ticket request still succeeds.
  const old = host.get(PROJECT).channels as unknown as { issued: number; close: () => Promise<void> };
  old.issued = 64;
  old.close = () => Promise.reject(new Error("Owned local lease cleanup refused"));
  const swapped = host.issueTicket(PROJECT, { editorId: "edit", localSessionId: "local" });
  const ticket = (await swapped) as { ticket: string };
  assert.match(ticket.ticket, /^[a-f0-9]{64}$/);
  assert.notEqual(host.get(PROJECT).channels, old);
  assert.match(logs.join("\n"), /swap cleanup \(demo-film\): Owned local lease cleanup refused/);
  stub();
  await assert.rejects(
    host.issueTicket(PROJECT, {}),
    /ticket rate reached/,
    "the new instance does not reset the rate",
  );
  now += CHANNEL_TICKET_RATE.windowMs + 1;
  await host.issueTicket(PROJECT, {});
  await assert.rejects(host.close(), /Owned local lease cleanup refused/);
});
