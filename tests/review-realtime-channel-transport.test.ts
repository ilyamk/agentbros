import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
import WebSocket from "ws";
import { socketTransport } from "../src/lib/review-ui/realtime-channel";
class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  sent = 0;
  ended = 0;
  callback?: (error?: Error) => void;
  send(_bytes: unknown, _options: unknown, callback: (error?: Error) => void) {
    this.sent++;
    this.callback = callback;
  }
  terminate() {
    this.ended++;
    this.emit("close");
  }
}
const transport = (socket: FakeSocket) => socketTransport(socket as unknown as WebSocket);
test("transport enforces one bounded send/abort/deadline and cleans its exact abort listeners", async () => {
  const socket = new FakeSocket(),
    t = transport(socket),
    controller = new AbortController(),
    pending = t.send(new Uint8Array(4), controller.signal);
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  socket.callback?.();
  assert.equal(socket.sent, 1);
  const high = new FakeSocket();
  high.bufferedAmount = 65536;
  await assert.rejects(transport(high).send(new Uint8Array(1), new AbortController().signal), /backpressure/);
  assert.equal(high.sent, 0);
  const hanging = new FakeSocket(),
    signal = new AbortController().signal;
  await assert.rejects(transport(hanging).send(new Uint8Array(1), signal), /deadline/);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
test("transport synchronous send rejection and late callbacks remain one failure without leaked listener/timer", async () => {
  const socket = new FakeSocket();
  socket.send = () => {
    throw Error("synchronous send failure");
  };
  const signal = new AbortController().signal;
  await assert.rejects(transport(socket).send(new Uint8Array(1), signal), /synchronous send failure/);
  assert.equal(getEventListeners(signal, "abort").length, 0);
});
test("binary/invalid UTF8 never reach local command callback and detach removes only owned listeners", () => {
  const socket = new FakeSocket(),
    t = transport(socket),
    received: Uint8Array[] = [];
  const unrelated = () => {};
  socket.on("message", unrelated);
  const off = t.onMessage((bytes) => received.push(bytes));
  socket.emit("message", Buffer.from("valid"), false);
  socket.emit("message", Buffer.from("binary"), true);
  socket.emit("message", Buffer.from([0xff]), false);
  assert.equal(received.length, 1);
  assert.equal(socket.ended, 2);
  off();
  assert.deepEqual(socket.listeners("message"), [unrelated]);
});
