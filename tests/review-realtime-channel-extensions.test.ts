import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { connect } from "node:net";
import { once } from "node:events";
import WebSocket from "ws";
import { startReviewServer } from "../src/lib/review-ui/server";
import { RealtimeEditorStore } from "../src/lib/realtime/editor";
const offer = "permessage-deflate; client_max_window_bits";
async function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "channel-offer-"))),
    project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new RealtimeEditorStore(root, "demo", "edit");
  store.create(1);
  const app = await startReviewServer({ rootDir: root, projectId: "demo" });
  t.after(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, store, app };
}
async function ticket(app: Awaited<ReturnType<typeof startReviewServer>>) {
  const res = await fetch(app.origin + "/api/realtime/channel-ticket", {
    method: "POST",
    headers: { "x-review-token": app.token, origin: app.origin, "content-type": "application/json" },
    body: JSON.stringify({ editorId: "edit", localSessionId: "local" }),
  });
  assert.equal(res.status, 200);
  return res.json();
}
function maskedStatus() {
  const bytes = Buffer.from(
      JSON.stringify({
        version: 1,
        localSessionId: "local",
        editorId: "edit",
        messageId: "status",
        expectedSequence: 0,
        action: "status",
      }),
    ),
    mask = Buffer.from([1, 2, 3, 4]),
    header = Buffer.alloc(bytes.length < 126 ? 2 : 4);
  header[0] = 0x81;
  header[1] = 0x80 | (bytes.length < 126 ? bytes.length : 126);
  if (header.length === 4) header.writeUInt16BE(bytes.length, 2);
  return Buffer.concat([header, mask, Buffer.from(bytes.map((v, i) => v ^ mask[i % 4]))]);
}
async function raw(app: Awaited<ReturnType<typeof startReviewServer>>, cap: any, extensions: string[]) {
  return new Promise<{ header: string; frame?: Buffer }>((resolve, reject) => {
    const u = new URL(app.origin),
      socket = connect(Number(u.port), "127.0.0.1");
    let bytes = Buffer.alloc(0),
      header = "",
      sent = false,
      finished = false;
    const timer = setTimeout(() => finish(Error("Bounded handshake deadline")), 2000);
    const finish = (error?: Error, result?: { header: string; frame?: Buffer }) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(result!);
    };
    socket.on("error", (error) => finish(error));
    socket.on("connect", () =>
      socket.write(
        [
          "GET " + cap.path + " HTTP/1.1",
          "Host: " + u.host,
          "Origin: " + app.origin,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Version: 13",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
          "Sec-WebSocket-Protocol: " + cap.protocol + ", t." + cap.ticket,
          ...extensions.map((v) => "Sec-WebSocket-Extensions: " + v),
          "",
          "",
        ].join("\r\n"),
      ),
    );
    socket.on("data", (chunk) => {
      bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (bytes.length > 65536) return finish(Error("Bounded handshake bytes"));
      if (!header) {
        const end = bytes.indexOf("\r\n\r\n");
        if (end < 0) return;
        header = bytes.subarray(0, end).toString();
        bytes = bytes.subarray(end + 4);
        if (!header.startsWith("HTTP/1.1 101")) return finish(undefined, { header });
      }
      if (!sent) {
        sent = true;
        socket.write(maskedStatus());
      }
      if (bytes.length < 2) return;
      let size = bytes[1] & 127,
        offset = 2;
      if (size === 126) {
        if (bytes.length < 4) return;
        size = bytes.readUInt16BE(2);
        offset = 4;
      }
      if (size === 127) return finish(Error("Unexpected oversized frame"));
      if (bytes.length >= offset + size) finish(undefined, { header, frame: bytes.subarray(0, offset + size) });
    });
  });
}
async function idle(app: Awaited<ReturnType<typeof startReviewServer>>) {
  const deadline = Date.now() + 1000;
  while (app.channels.diagnostics().sockets && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
  assert.equal(app.channels.diagnostics().sockets, 0);
}
test(
  "raw absent/exact bounded browser offer returns101, no negotiated extensions, uncompressed local status",
  { timeout: 10000 },
  async (t) => {
    for (const extensions of [[], [offer]]) {
      const { app, store } = await fixture(t),
        cap = await ticket(app),
        result = await raw(app, cap, extensions);
      assert.match(result.header, /^HTTP\/1.1 101/);
      assert.doesNotMatch(result.header, /sec-websocket-extensions/i);
      const frame = result.frame!;
      assert.equal(frame[0] & 0x70, 0);
      assert.equal(frame[0] & 15, 1);
      assert.equal(frame[1] & 128, 0);
      const reply = JSON.parse(frame.subarray((frame[1] & 127) === 126 ? 4 : 2).toString());
      assert.equal(reply.current.sequence, 0);
      assert.equal(reply.providerAck, false);
      assert.equal(store.read().committedUsd, 0);
      await idle(app);
      assert.match((await raw(app, cap, [])).header, /^HTTP\/1.1 403/);
    }
  },
);
test(
  "malformed/unsupported/duplicate offers refuse before ticket consume or journal; same exact retry succeeds once",
  { timeout: 15000 },
  async (t) => {
    const { app, root } = await fixture(t),
      cap = await ticket(app);
    for (const values of [
      [""],
      ["permessage-deflate"],
      ["other-extension"],
      [offer + ", other-extension"],
      [offer, offer],
      ["permessage-deflate; client_max_window_bits=15"],
      ["permessage-deflate; client_max_window_bits; server_no_context_takeover"],
      ["PerMessage-Deflate; client_max_window_bits"],
      ["permessage-deflate;  client_max_window_bits"],
      ['permessage-deflate; client_max_window_bits="15"'],
      ["x".repeat(65)],
    ]) {
      const result = await raw(app, cap, values);
      assert.match(result.header, /^HTTP\/1.1 403/);
      assert.equal(app.channels.diagnostics().tickets, 1);
      assert.equal(app.channels.diagnostics().sockets, 0);
      assert.equal(existsSync(path.join(root, ".cache/realtime-channels")), false);
    }
    assert.match((await raw(app, cap, [offer])).header, /^HTTP\/1.1 101/);
    await idle(app);
    assert.equal(app.channels.diagnostics().tickets, 0);
    assert.match((await raw(app, cap, [offer])).header, /^HTTP\/1.1 403/);
  },
);
test(
  "installed ws default offer remains unnegotiated, reports empty extensions and receives uncompressed status",
  { timeout: 10000 },
  async (t) => {
    const { app } = await fixture(t),
      cap = await ticket(app);
    const ws = new WebSocket(app.origin.replace("http:", "ws:") + cap.path, [cap.protocol, "t." + cap.ticket], {
      origin: app.origin,
      perMessageDeflate: true,
    });
    t.after(() => ws.terminate());
    let responseExtensions: unknown;
    ws.on("upgrade", (res) => {
      responseExtensions = res.headers["sec-websocket-extensions"];
    });
    await once(ws, "open");
    assert.equal(ws.extensions, "");
    assert.equal(responseExtensions, undefined);
    const response = once(ws, "message");
    ws.send(
      JSON.stringify({
        version: 1,
        localSessionId: "local",
        editorId: "edit",
        messageId: "status",
        expectedSequence: 0,
        action: "status",
      }),
      { compress: true },
    );
    const [data, binary] = await response;
    assert.equal(binary, false);
    assert.equal(JSON.parse(data.toString()).providerPersistent, false);
    const end = once(ws, "close");
    ws.close();
    await end;
  },
);
