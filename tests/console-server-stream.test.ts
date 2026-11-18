/**
 * Console reads and the SSE stream (RFC 0004 D6, FR1, WP2): the default data source's summaries, view and journal
 * page; `view.changed` within 1 s of a file change; `event` messages for new journal lines; revisions as SSE ids;
 * a stream outlives the request timeout; close() ends streams and watchers.
 */
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  ConsoleStreamMessageSchema,
  EventsPageSchema,
  ProjectsResponseSchema,
  ProjectViewSchema,
} from "../src/types/console";
import type { ConsoleServer } from "../src/lib/console/server";
import { ignoredChange } from "../src/lib/console/watch";
import { makeRoot, PROJECT, raw, removeRoot, startTestServer } from "./helpers/console-server";

type Frame = { event: string; id: string; data: unknown; at: number };

/** Opens an SSE stream and collects its frames. */
function openStream(server: ConsoleServer, query: string) {
  const frames: Frame[] = [];
  let response: IncomingMessage | undefined;
  const waiters: Array<() => void> = [];
  const req = request({
    host: "127.0.0.1",
    port: server.port,
    path: `/api/stream${query}`,
    headers: { Host: `127.0.0.1:${server.port}`, "x-console-token": server.token },
    agent: false,
  });
  const ready = new Promise<IncomingMessage>((resolve, reject) => {
    req.on("response", (res) => {
      response = res;
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        let at;
        while ((at = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, at);
          buffer = buffer.slice(at + 2);
          const fields = Object.fromEntries(
            block
              .split("\n")
              .filter((line) => line && !line.startsWith(":"))
              .map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]),
          );
          if (fields.data !== undefined)
            frames.push({ event: fields.event, id: fields.id, data: JSON.parse(fields.data), at: performance.now() });
          else if (block.startsWith(": heartbeat"))
            frames.push({ event: "heartbeat", id: "", data: null, at: performance.now() });
          waiters.splice(0).forEach((wake) => wake());
        }
      });
      resolve(res);
    });
    req.on("error", reject);
  });
  req.end();
  const until = async (predicate: (frames: Frame[]) => boolean, timeoutMs = 3000) => {
    const deadline = performance.now() + timeoutMs;
    while (!predicate(frames)) {
      if (performance.now() > deadline) throw new Error(`timed out; frames: ${JSON.stringify(frames)}`);
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  };
  return { frames, ready, until, close: () => (req.destroy(), response?.destroy()) };
}

const event = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    v: 1,
    id,
    at: "2026-11-17T09:00:00.000Z",
    project: PROJECT,
    kind: "cli.start",
    runId: "run-1",
    alias: "film:next",
    ...extra,
  }) + "\n";

describe("console reads and stream", () => {
  let root: string;
  let server: ConsoleServer;
  const auth = () => ({ "x-console-token": server.token });
  const journal = () => path.join(root, "public/projects", PROJECT, "pipeline/events.jsonl");

  before(async () => {
    root = makeRoot();
    writeFileSync(journal(), event("01KA0000000000000000000001") + "not json\n" + event("01KA0000000000000000000002"));
    server = await startTestServer(root, { requestTimeoutMs: 300, heartbeatMs: 200 });
  });
  after(async () => {
    await server?.close();
    removeRoot(root);
  });

  test("projects, view and journal pages follow the contract", async () => {
    const projects = ProjectsResponseSchema.parse(
      (await raw(server.port, { path: "/api/projects", headers: auth() })).json(),
    );
    assert.deepEqual(
      projects.projects.map((p) => [p.id, p.route, p.title]),
      [[PROJECT, "timeline", "Demo film"]],
    );
    const view = ProjectViewSchema.parse(
      (await raw(server.port, { path: `/api/projects/${PROJECT}/view`, headers: auth() })).json(),
    );
    assert.equal(view.project.id, PROJECT);
    const page = EventsPageSchema.parse(
      (await raw(server.port, { path: `/api/projects/${PROJECT}/events?limit=1`, headers: auth() })).json(),
    );
    assert.deepEqual(
      page.events.map((e) => e.id),
      ["01KA0000000000000000000001"],
    );
    assert.equal(page.next, "01KA0000000000000000000001");
    const rest = EventsPageSchema.parse(
      (await raw(server.port, { path: `/api/projects/${PROJECT}/events?since=${page.next}`, headers: auth() })).json(),
    );
    assert.deepEqual(
      rest.events.map((e) => e.id),
      ["01KA0000000000000000000002"],
    );
    assert.equal(rest.next, null);
    assert.equal(
      (await raw(server.port, { path: `/api/projects/${PROJECT}/events?limit=0`, headers: auth() })).status,
      400,
    );
    assert.equal((await raw(server.port, { path: "/api/projects/missing-one/view", headers: auth() })).status, 404);
    assert.equal((await raw(server.port, { path: "/api/projects/Bad_Id/view", headers: auth() })).status, 400);
    assert.equal((await raw(server.port, { path: "/api/stream?project=missing-one", headers: auth() })).status, 404);
  });

  test("view.changed arrives within 1 s of a file change; journal lines arrive as events", async () => {
    const stream = openStream(server, `?project=${PROJECT}`);
    const res = await stream.ready;
    try {
      assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
      await stream.until((frames) => frames.some((f) => f.event === "view.changed"));
      const first = stream.frames.find((f) => f.event === "view.changed")!;
      assert.equal(first.id, "0", "the first message carries the current revision");
      await new Promise((resolve) => setTimeout(resolve, 100));
      const changedAt = performance.now();
      writeFileSync(path.join(root, "public/projects", PROJECT, "pipeline/state.json"), "{}");
      await stream.until((frames) => frames.some((f) => f.event === "view.changed" && f.id !== "0"), 1500);
      const second = stream.frames.find((f) => f.event === "view.changed" && f.id !== "0")!;
      assert.ok(second.at - changedAt < 1000, `view.changed after ${Math.round(second.at - changedAt)} ms`);
      assert.deepEqual(ConsoleStreamMessageSchema.parse(second.data), {
        type: "view.changed",
        project: PROJECT,
        revision: Number(second.id),
      });

      appendFileSync(journal(), event("01KA0000000000000000000003", { kind: "cli.end", ok: true, elapsedMs: 5 }));
      await stream.until((frames) => frames.some((f) => f.event === "event"), 1500);
      const message = ConsoleStreamMessageSchema.parse(stream.frames.find((f) => f.event === "event")!.data);
      assert.equal(message.type === "event" && message.event.id, "01KA0000000000000000000003");
      const revisions = stream.frames.filter((f) => f.id).map((f) => Number(f.id));
      assert.deepEqual(
        revisions,
        [...revisions].sort((a, b) => a - b),
        "revisions never go back",
      );

      // Downloads and caches never change a view.
      const before = stream.frames.length;
      mkdirSync(path.join(root, "public/projects", PROJECT, "downloads"), { recursive: true });
      writeFileSync(path.join(root, "public/projects", PROJECT, "downloads/big.bin"), "x");
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(
        stream.frames.slice(before).filter((f) => f.event === "view.changed").length,
        0,
        "downloads/ ignored",
      );
      // The stream outlived the 300 ms request timeout and kept its heartbeat.
      assert.ok(stream.frames.some((f) => f.event === "heartbeat"));
      assert.equal(res.destroyed, false);
    } finally {
      stream.close();
    }
  });

  test("the home stream reports changes in any project", async () => {
    const stream = openStream(server, "");
    await stream.ready;
    try {
      await stream.until((frames) => frames.some((f) => f.event === "view.changed"));
      writeFileSync(path.join(root, "public/projects", PROJECT, "project.json"), JSON.stringify({ title: "Renamed" }));
      await stream.until((frames) => frames.filter((f) => f.event === "view.changed").length >= 2, 6000);
    } finally {
      stream.close();
    }
  });

  test("ignoredChange skips downloads, caches and temporary files", () => {
    for (const file of ["downloads/a.mp4", "pipeline/cache/x.json", "a/.cache/b", "x.tmp", "node_modules/a", "y.lock"])
      assert.equal(ignoredChange(file), true, file);
    for (const file of ["project.json", "pipeline/events.jsonl", "pipeline/brief.json"])
      assert.equal(ignoredChange(file), false, file);
  });

  test("close() ends open streams", async () => {
    const other = await startTestServer(root);
    const stream = openStream(other, `?project=${PROJECT}`);
    const res = await stream.ready;
    const ended = new Promise<void>((resolve) => res.on("close", () => resolve()));
    await other.close();
    await ended;
    assert.equal(other.server.listening, false);
  });
});
