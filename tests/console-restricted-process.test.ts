import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { test } from "node:test";
import { readLock, writeLock } from "../src/lib/console/lock";
import { startOrReuseConsoleServer, stopConsoleServer } from "../src/lib/console/start";
import { makeRoot, removeRoot, startTestServer } from "./helpers/console-server";

test("restricted process probes allow authenticated reuse and preserve the running daemon on a refused restart", async (t) => {
  const root = makeRoot();
  const server = await startTestServer(root);
  t.after(async () => {
    await server.close();
    removeRoot(root);
  });
  const lock = {
    v: 1 as const,
    pid: process.pid,
    port: server.port,
    url: server.origin,
    version: "test-version",
    startedAt: new Date().toISOString(),
  };
  writeLock(root, lock);
  const denied = Object.assign(new Error("Operation not permitted"), { code: "EPERM" });
  const uptime = t.mock.method(os, "uptime", () => {
    throw Object.assign(new Error("uv_uptime returned EPERM"), { code: "ERR_SYSTEM_ERROR", info: { code: "EPERM" } });
  });
  const spawnSync = t.mock.method(childProcess, "spawnSync", () => ({ status: null, error: denied }));
  syncBuiltinESMExports();
  try {
    const reuse = await startOrReuseConsoleServer({ rootDir: root, port: server.port, version: lock.version });
    assert.ok("reused" in reuse && reuse.reused && reuse.pid === lock.pid, JSON.stringify(reuse));
    const restart = await startOrReuseConsoleServer({ rootDir: root, port: server.port, version: "new-version" });
    assert.ok("error" in restart);
    assert.match(restart.error, /Cannot verify console process/);
    assert.equal(restart.existingBaseUrl, `${server.origin}/`);
    const stop = await stopConsoleServer({ rootDir: root });
    assert.equal(stop.stopped, false);
    assert.match(stop.reason ?? "", /Cannot verify console process/);
    assert.deepEqual(readLock(root), lock);
  } finally {
    uptime.mock.restore();
    spawnSync.mock.restore();
    syncBuiltinESMExports();
  }
});
