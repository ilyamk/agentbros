/**
 * Console server processes (RFC 0004 D16, WP2): detached start with a lock, reuse of a live server of the same
 * version, replacement of a stale lock, restart on a version change, stop verified by pid, the auto-start refusals of
 * `ensureConsoleServer`, idle shutdown and a start-up timing check (warn only). Every spawned server is stopped.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { codeRoot } from "../src/lib/console/bundle";
import { pidAlive, readLock, writeLock } from "../src/lib/console/lock";
import { loadOrCreateSessionToken, readSessionToken } from "../src/lib/console/session";
import {
  autoStartRefusal,
  ensureConsoleServer,
  isCheckoutRoot,
  startOrReuseConsoleServer,
  stopConsoleServer,
} from "../src/lib/console/start";
import { makeRoot, removeRoot, startTestServer } from "./helpers/console-server";

const exitedPid = () =>
  new Promise<number>((resolve) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("exit", () => resolve(child.pid!));
  });

describe("console server processes", () => {
  let root: string;
  const started = new Set<number>();
  const start = async (version: string) => {
    const result = await startOrReuseConsoleServer({ rootDir: root, port: 0, version, daemonArgs: ["--no-build"] });
    assert.ok(!("error" in result), "error" in result ? result.error : "");
    started.add(result.pid);
    return result;
  };

  before(() => {
    root = makeRoot();
  });
  after(async () => {
    await stopConsoleServer({ rootDir: root }).catch(() => undefined);
    for (const pid of started)
      if (pidAlive(pid))
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // gone
        }
    removeRoot(root);
  });

  test("the session token is created once with mode 0600 and survives restarts", () => {
    const token = loadOrCreateSessionToken(root);
    assert.match(token, /^[a-f0-9]{64}$/);
    const file = path.join(root, "out/console/session.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(loadOrCreateSessionToken(root), token);
    writeFileSync(file, "{broken");
    const replaced = loadOrCreateSessionToken(root);
    assert.notEqual(replaced, token);
    assert.equal(readSessionToken(root), replaced);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  });

  test("starts detached with a lock, reuses it, restarts on a version change and stops it", async () => {
    const t0 = performance.now();
    const first = await start("v1");
    const startMs = performance.now() - t0;
    // RFC 0004 §4.4: start-up under 2 s with a built bundle (detached spawn until health answers; warn only).
    if (startMs > 2000)
      process.stderr.write(
        `[console-server] warning: detached start-up took ${Math.round(startMs)} ms (target < 2000)\n`,
      );
    assert.equal(first.reused, false);
    const lock = readLock(root);
    assert.equal(lock?.pid, first.pid);
    assert.equal(lock?.version, "v1");
    assert.equal(lock?.url, first.baseUrl);
    assert.notEqual(first.pid, process.pid);
    assert.match(first.url, /#token=[a-f0-9]{64}$/);

    const again = await start("v1");
    assert.equal(again.reused, true);
    assert.equal(again.pid, first.pid);

    const project = await startOrReuseConsoleServer({ rootDir: root, port: 0, version: "v1", project: "demo-film" });
    assert.ok(!("error" in project) && project.url.endsWith("&project=demo-film"));

    const upgraded = await start("v2");
    assert.equal(upgraded.reused, false);
    assert.notEqual(upgraded.pid, first.pid);
    assert.equal(pidAlive(first.pid), false, "the old version was stopped");
    assert.equal(readLock(root)?.version, "v2");

    const log = readFileSync(path.join(root, "out/console/server.log"), "utf8");
    assert.ok(log.includes("listening on http://127.0.0.1:"));
    assert.ok(!log.includes(loadOrCreateSessionToken(root)), "the token is never logged");

    const stopped = await stopConsoleServer({ rootDir: root });
    assert.deepEqual([stopped.stopped, stopped.pid], [true, upgraded.pid]);
    assert.equal(pidAlive(upgraded.pid), false);
    assert.equal(readLock(root), undefined);
    const none = await stopConsoleServer({ rootDir: root });
    assert.equal(none.stopped, false);
  });

  test("a stale lock is replaced; a lock naming a foreign live process is never killed", async () => {
    const dead = await exitedPid();
    writeLock(root, { v: 1, pid: dead, port: 1, version: "v3", startedAt: new Date().toISOString() });
    const fresh = await start("v3");
    assert.equal(fresh.reused, false);
    assert.equal(readLock(root)?.pid, fresh.pid);
    assert.deepEqual((await stopConsoleServer({ rootDir: root })).stopped, true);

    // A lock that names this test process (alive, not a console server): stop leaves it alone.
    writeLock(root, { v: 1, pid: process.pid, port: 1, version: "v3", startedAt: new Date().toISOString() });
    const refused = await stopConsoleServer({ rootDir: root });
    assert.equal(refused.stopped, false);
    assert.equal(readLock(root), undefined, "the bogus lock is removed");
    // And start does not reuse it either.
    writeLock(root, { v: 1, pid: process.pid, port: 1, version: "v3", startedAt: new Date().toISOString() });
    const replacement = await start("v3");
    assert.equal(replacement.reused, false);
    assert.ok(pidAlive(process.pid));
    await stopConsoleServer({ rootDir: root });
  });

  test("ensureConsoleServer refuses when switched off, under node:test and outside a checkout; never throws", async () => {
    assert.match(String(autoStartRefusal(root, { AGENTBROS_CONSOLE: "off" })), /AGENTBROS_CONSOLE=off/);
    assert.match(String(autoStartRefusal(root, { NODE_TEST_CONTEXT: "child-v8" })), /node:test/);
    assert.match(String(autoStartRefusal(root, {})), /checkout root/);
    assert.equal(isCheckoutRoot(root), false);
    assert.equal(isCheckoutRoot(codeRoot()), true);
    // The real checkout is refused here because this process runs under node:test, and nothing is written.
    const refused = await ensureConsoleServer({ rootDir: codeRoot() });
    assert.ok("error" in refused);
    for (const env of [{ AGENTBROS_CONSOLE: "off" }, { NODE_TEST_CONTEXT: "1" }, {}]) {
      const result = await ensureConsoleServer({ rootDir: root, env });
      assert.ok("error" in result);
    }
    const missing = await ensureConsoleServer({ rootDir: path.join(root, "nope"), env: {} });
    assert.ok("error" in missing);
    assert.equal(readLock(root), undefined, "no server was started");
  });

  test("the server stops itself after the idle period", async () => {
    let idle = false;
    const server = await startTestServer(root, { idleMs: 120, onIdle: () => (idle = true) });
    try {
      const deadline = performance.now() + 2000;
      while (!idle && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(idle, true);
    } finally {
      await server.close();
    }
  });

  test("an in-process server with a built bundle is ready at once", async () => {
    const t0 = performance.now();
    const server = await startTestServer(root);
    await server.bundle.ready;
    const ms = performance.now() - t0;
    try {
      assert.equal(server.bundle.state.kind, "ready");
      if (ms > 2000)
        process.stderr.write(`[console-server] warning: start-up took ${Math.round(ms)} ms (target < 2000)\n`);
    } finally {
      await server.close();
    }
  });

  test("a failed bundle build still serves the API and an error page", async () => {
    const dist = path.join(root, "out/console/broken-dist");
    mkdirSync(dist, { recursive: true });
    const server = await startTestServer(root, {
      distDir: dist,
      build: true,
      builder: async () => ({ ok: false, built: false, bundle: "x", distDir: dist, elapsedMs: 1, error: "boom <b>" }),
    });
    try {
      await server.bundle.ready;
      const { raw } = await import("./helpers/console-server");
      const page = await raw(server.port, { path: "/" });
      assert.equal(page.status, 503);
      assert.ok(page.text.includes("could not be built") && page.text.includes("boom &lt;b&gt;"));
      const api = await raw(server.port, { path: "/api/projects", headers: { "x-console-token": server.token } });
      assert.equal(api.status, 200);
    } finally {
      await server.close();
    }
  });
});
