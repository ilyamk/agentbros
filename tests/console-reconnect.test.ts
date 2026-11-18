import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import test from "node:test";
import { openEventStream } from "../apps/console/api/stream";
import { makeRoot, PROJECT, removeRoot, startTestServer } from "./helpers/console-server";

test(
  "an open console stream reconnects on the same origin with the tab's token after a server restart",
  { timeout: 10000 },
  async (t) => {
    const root = makeRoot();
    const server = await startTestServer(root);
    let running: typeof server | undefined = server;
    const headers = { "x-console-token": server.token };
    const events = new EventEmitter();
    const first = once(events, "open", { signal: t.signal });
    const rejections: number[] = [];
    let connections = 0;
    const unsubscribe = openEventStream({
      url: `${server.origin}/api/stream?project=${PROJECT}`,
      fetch,
      headers,
      onMessage: () => {},
      onOpen: () => {
        connections++;
        events.emit("open");
      },
      onError: (status) => {
        if (status !== undefined) rejections.push(status);
        events.emit("offline");
      },
    });
    t.after(async () => {
      unsubscribe();
      await running?.close();
      removeRoot(root);
    });

    await first;
    const offline = once(events, "offline", { signal: t.signal });
    await server.close();
    running = undefined;
    await offline;
    const second = once(events, "open", { signal: t.signal });
    running = await startTestServer(root, { port: server.port, version: "restarted" });
    assert.equal(running.origin, server.origin);
    await second;
    assert.equal(connections, 2);
    assert.deepEqual(rejections, []);
    const response = await fetch(`${server.origin}/api/projects`, { headers });
    assert.equal(response.status, 200);
    assert.ok((await response.json()).projects.some(({ id }: { id: string }) => id === PROJECT));
  },
);
