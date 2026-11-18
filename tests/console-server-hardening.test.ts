/**
 * Regression tests for the WP2 review (RFC 0004): cross-port reads (S1), bounded thumbnails (S2), a token-free
 * health challenge and pid checks (S3), `@out/` limited to projects (S4), atomic start-lock takeover, single daemon
 * and orphan-free timeouts (C1), recoverable bundle state (C2), storage errors failing the request only (C3), `--stop`
 * bound to this checkout (C4) and SSE backpressure (C5).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, writeFileSync, utimesSync, existsSync, readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  acquireStartLock,
  daemonProcessMatches,
  healthProof,
  liveServer,
  pidAlive,
  probeHealth,
  readLock,
  startLockPath,
  writeLock,
} from "../src/lib/console/lock";
import type { ConsoleServer } from "../src/lib/console/server";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { SseHub } from "../src/lib/console/sse";
import { startOrReuseConsoleServer, stopConsoleServer } from "../src/lib/console/start";
import { quantizeTime, ThumbnailService, widthBucket } from "../src/lib/console/thumbs";
import { resolveMedia } from "../src/lib/console/media";
import { consoleCookieName, mediaReadValue } from "../src/lib/console/http/auth";
import { BUNDLE_VERSION_FILE } from "../src/lib/console/bundle";
import { makeRoot, PROJECT, raw, removeRoot, startTestServer, TEST_BUNDLE } from "./helpers/console-server";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;

describe("console server hardening", () => {
  let root: string;
  let server: ConsoleServer;
  let cookie: string;
  const started = new Set<number>();

  before(async () => {
    root = makeRoot();
    const project = path.join(root, "public/projects", PROJECT);
    mkdirSync(path.join(project, "media"), { recursive: true });
    writeFileSync(path.join(project, "media/frame.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    mkdirSync(path.join(root, "out/qa"), { recursive: true });
    writeFileSync(path.join(root, "out/qa/notes.md"), "qa evidence");
    mkdirSync(path.join(root, "out", PROJECT), { recursive: true });
    writeFileSync(path.join(root, "out", PROJECT, "notes.md"), "render notes");
    server = await startTestServer(root);
    cookie = `${consoleCookieName(server.token)}=${mediaReadValue(server.token)}`;
  });
  after(async () => {
    await server?.close();
    await stopConsoleServer({ rootDir: root }).catch(() => undefined);
    for (const pid of started) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
    removeRoot(root);
  });

  test("S1: a page on another port gets nothing with our cookie", async () => {
    const crossPort = { Cookie: cookie, "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors" };
    for (const target of [
      `/media/${PROJECT}/media/frame.png`,
      `/thumb/${PROJECT}/media/frame.png`,
      "/api/projects",
      `/api/projects/${PROJECT}/view`,
      "/api/session",
      `/api/stream?project=${PROJECT}`,
      "/",
    ])
      for (const site of ["same-site", "cross-site"]) {
        const res = await raw(server.port, { path: target, headers: { ...crossPort, "Sec-Fetch-Site": site } });
        assert.equal(res.status, 403, `${site} ${target}`);
      }
    // The cookie never opens a JSON read, even same-origin; media accepts it as <video> sends it.
    assert.equal((await raw(server.port, { path: "/api/projects", headers: { Cookie: cookie } })).status, 403);
    assert.equal(
      (await raw(server.port, { path: "/api/projects", headers: { Cookie: cookie, "Sec-Fetch-Site": "same-origin" } }))
        .status,
      403,
    );
    assert.equal(
      (await raw(server.port, { path: "/api/projects", headers: { "x-console-token": server.token } })).status,
      200,
    );
    for (const site of ["same-origin", "none"])
      assert.equal(
        (
          await raw(server.port, {
            path: `/media/${PROJECT}/media/frame.png`,
            headers: { Cookie: cookie, "Sec-Fetch-Site": site },
          })
        ).status,
        200,
        site,
      );
    assert.equal((await raw(server.port, { path: "/", headers: { "Sec-Fetch-Site": "none" } })).status, 200);
  });

  test("S2: thumbnail parameters are quantized and bounded", () => {
    assert.equal(widthBucket(1), 96);
    assert.equal(widthBucket(500), 640);
    assert.equal(widthBucket(5000), 1920);
    assert.equal(quantizeTime(0.5432, 3), 0.5);
    assert.equal(quantizeTime(0.56, 3), 0.6);
    assert.equal(quantizeTime(999, 3), 2.9);
    assert.equal(quantizeTime(1.23, undefined), 1.2);
  });

  test(
    "S2: one cache entry per quantized time, a capped cache, a capped queue, bad times refused",
    { skip: !hasFfmpeg && "ffmpeg not installed" },
    async () => {
      const video = path.join(root, "public/projects", PROJECT, "media/clip.mp4");
      const made = spawnSync(
        "ffmpeg",
        ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=d=2:s=64x36:r=10", "-y", video],
        { stdio: "ignore" },
      );
      assert.equal(made.status, 0);
      const thumbs = new ThumbnailService({ rootDir: root, maxCacheFiles: 3 });
      const media = resolveMedia(root, PROJECT, ["media", "clip.mp4"]);
      const files = new Set<string>();
      for (const t of [0.51, 0.52, 0.5399, 0.49]) files.add(await thumbs.thumbnail(media, { t, w: 50 }));
      assert.equal(files.size, 1, "close times share one frame");
      await thumbs.thumbnail(media, { t: 1e6, w: 50 }).then(
        () => assert.fail("refused"),
        (error) => assert.equal(error.status, 400),
      );
      for (const t of [Infinity, Number.NaN, -1])
        await thumbs.thumbnail(media, { t, w: 50 }).then(
          () => assert.fail(String(t)),
          (error) => assert.equal(error.status, 400),
        );
      const beyond = await thumbs.thumbnail(media, { t: 3600, w: 50 });
      assert.ok(existsSync(beyond), "clamped to the duration");
      for (const t of [0.1, 0.2, 0.3, 0.4]) await thumbs.thumbnail(media, { t, w: 50 });
      const count = readdirSync(thumbs.cacheDir).flatMap((dir) => readdirSync(path.join(thumbs.cacheDir, dir))).length;
      assert.ok(count <= 3, `cache capped at 3, found ${count}`);

      const busy = new ThumbnailService({ rootDir: root, maxQueue: 1 });
      const results = await Promise.allSettled(
        [1.0, 1.1, 1.2, 1.3, 1.4, 1.5].map((t) => busy.thumbnail(media, { t, w: 1280 })),
      );
      assert.ok(
        results.some((r) => r.status === "rejected" && (r.reason as { code?: string }).code === "BUSY"),
        "a full queue answers 503 BUSY",
      );
    },
  );

  test("C3: a failed cache write rejects the request and the server keeps running", async (t) => {
    if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions as a user");
    const fake = path.join(root, "fake-ffmpeg.mjs");
    // Writes the output, then makes its folder read-only so the final rename fails.
    writeFileSync(
      fake,
      `#!${process.execPath}\nimport { writeFileSync, chmodSync } from "node:fs";\nimport path from "node:path";\nconst out = process.argv.at(-1);\nwriteFileSync(out, "jpg");\nchmodSync(path.dirname(out), 0o555);\n`,
    );
    chmodSync(fake, 0o755);
    writeFileSync(path.join(root, "fake-ffprobe"), `#!/bin/sh\necho 2\n`);
    chmodSync(path.join(root, "fake-ffprobe"), 0o755);
    const thumbs = new ThumbnailService({ rootDir: root, ffmpeg: fake, ffprobe: path.join(root, "fake-ffprobe") });
    const media = resolveMedia(root, PROJECT, ["media", "frame.png"]);
    try {
      await assert.rejects(thumbs.thumbnail(media, { w: 1920 }), (error: { status?: number }) => error.status === 500);
    } finally {
      for (const dir of readdirSync(thumbs.cacheDir)) chmodSync(path.join(thumbs.cacheDir, dir), 0o755);
    }
    assert.equal(server.server.listening, true);
  });

  test("S3: the health probe never sends the token and needs a valid proof", async () => {
    const token = loadOrCreateSessionToken(root);
    const seen: IncomingMessage[] = [];
    const impostor = createServer((req, res) => {
      seen.push(req);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, version: "v", pid: process.pid, port: 1, startedAt: "x", proof: "0".repeat(64) }),
      );
    });
    await new Promise<void>((resolve) => impostor.listen(0, "127.0.0.1", resolve));
    const port = (impostor.address() as { port: number }).port;
    try {
      writeLock(root, { v: 1, pid: process.pid, port, version: "v", startedAt: new Date().toISOString() });
      assert.equal(await liveServer(root, token), undefined, "a wrong proof is not our server");
      assert.ok(seen.length > 0);
      for (const req of seen) {
        const all = JSON.stringify(req.headers) + req.url;
        assert.ok(!all.includes(token), "the token never leaves in a probe");
      }
      // The real server proves itself.
      const health = await probeHealth(server.port, server.token);
      assert.equal(health?.pid, process.pid);
      const nonce = "ab".repeat(16);
      const answer = await raw(server.port, { path: `/api/health?nonce=${nonce}` });
      assert.equal(answer.json().proof, healthProof(server.token, nonce));
      assert.equal((await raw(server.port, { path: "/api/health" })).status, 400);
      // A lock from before this boot is ignored, and a pid that is not our daemon is never matched.
      writeLock(root, { v: 1, pid: process.pid, port: server.port, version: "v", startedAt: "2000-01-01T00:00:00Z" });
      assert.equal(await liveServer(root, server.token), undefined);
      assert.equal(daemonProcessMatches(process.pid, root), false);
    } finally {
      impostor.close();
      writeFileSync(path.join(root, "out/console/server.json"), "{}");
    }
  });

  test("S4: @out/ serves only an existing project's renders", async () => {
    const headers = { "x-console-token": server.token };
    assert.equal((await raw(server.port, { path: `/media/${PROJECT}/@out/notes.md`, headers })).status, 200);
    assert.equal((await raw(server.port, { path: "/media/qa/@out/notes.md", headers })).status, 403);
    assert.equal((await raw(server.port, { path: "/media/console/@out/session.json", headers })).status, 403);
    assert.equal((await raw(server.port, { path: "/media/other-thing/@out/notes.md", headers })).status, 404);
  });

  test("C2: a throwing build leaves the server up, and a later good dist is picked up", async () => {
    const dist = path.join(root, "out/console/recover-dist");
    const other = await startTestServer(root, {
      distDir: dist,
      build: true,
      builder: async () => {
        throw new Error("vite exploded");
      },
    });
    try {
      await other.bundle.ready;
      assert.equal(other.bundle.state.kind, "failed");
      assert.equal((await raw(other.port, { path: "/" })).status, 503);
      mkdirSync(dist, { recursive: true });
      for (const [name, body] of [
        ["index.html", "<html><head></head><body>ok</body></html>"],
        ["app.js", ""],
        ["style.css", ""],
        [BUNDLE_VERSION_FILE, TEST_BUNDLE],
      ])
        writeFileSync(path.join(dist, name), body);
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const page = await raw(other.port, { path: "/" });
      assert.equal(page.status, 200);
      assert.ok(page.text.includes("ok"));
    } finally {
      await other.close();
    }
  });

  test("C5: a client that stops reading is dropped", () => {
    const listeners: Array<() => void> = [];
    const source = {
      revision: () => 0,
      watch: (_: string | undefined, onChange: (c: { type: "view.changed"; revision: number }) => void) => {
        listeners.push(() => onChange({ type: "view.changed", revision: 1 }));
        return () => undefined;
      },
    };
    const emitter = new EventEmitter();
    const res = Object.assign(emitter, {
      writableEnded: false,
      destroyed: false,
      writableLength: 0,
      writeHead() {},
      write(chunk: string) {
        this.writableLength += chunk.length * 1000;
        return false;
      },
      destroy() {
        this.destroyed = true;
        emitter.emit("close");
      },
      end() {},
    });
    const req = { socket: { setNoDelay() {}, setKeepAlive() {} } };
    const hub = new SseHub(source as never, { maxBuffered: 10_000, heartbeatMs: 60_000 });
    hub.open(req as never, res as never, undefined);
    for (let i = 0; i < 5; i++) listeners[0]!();
    assert.equal(res.destroyed, true);
    assert.equal(hub.size, 0);
  });

  test("C1: start-lock takeover is atomic and a fresh holder is respected", async () => {
    const file = startLockPath(root);
    const dead = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      child.on("exit", () => resolve(child.pid!));
    });
    writeFileSync(file, JSON.stringify({ pid: dead, at: "2000-01-01T00:00:00Z" }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const release = acquireStartLock(root);
    assert.ok(release, "a stale start lock is taken over");
    assert.equal(JSON.parse(readFileSync(file, "utf8")).pid, process.pid);
    assert.equal(acquireStartLock(root), undefined, "a live holder keeps it");
    release();
    assert.equal(existsSync(file), false);
    assert.equal(readdirSync(path.dirname(file)).filter((name) => name.includes(".stale-")).length, 0, "no leftovers");
  });

  test("C1/C4: one daemon per checkout, no orphan on timeout, --stop only this checkout's daemon", async () => {
    const first = await startOrReuseConsoleServer({
      rootDir: root,
      port: 0,
      version: "h1",
      daemonArgs: ["--no-build"],
    });
    assert.ok(!("error" in first), "error" in first ? first.error : "");
    started.add(first.pid);
    assert.equal(daemonProcessMatches(first.pid, root), true);

    // A second daemon for the same root (a racing starter) sees the live one and exits.
    const tsx = pathToFileURL(createRequire(path.resolve("package.json")).resolve("tsx")).href;
    const daemon = path.resolve("src/lib/console/daemon.ts");
    const second = spawn(
      process.execPath,
      ["--import", tsx, daemon, "--root", root, "--port", "0", "--version", "h1", "--no-build"],
      { stdio: "ignore" },
    );
    const code = await new Promise<number | null>((resolve) => second.on("exit", resolve));
    assert.equal(code, 0);
    assert.equal(readLock(root)?.pid, first.pid);

    // A lock in another checkout naming this daemon is never acted upon by --stop there.
    const other = makeRoot();
    try {
      writeLock(other, { v: 1, pid: first.pid, port: first.port, version: "h1", startedAt: new Date().toISOString() });
      const refused = await stopConsoleServer({ rootDir: other });
      assert.equal(refused.stopped, false);
      assert.equal(pidAlive(first.pid), true);
    } finally {
      removeRoot(other);
    }
    assert.equal((await stopConsoleServer({ rootDir: root })).stopped, true);
    assert.equal(pidAlive(first.pid), false);

    // A starter that gives up stops the child it spawned.
    const late = await startOrReuseConsoleServer({
      rootDir: root,
      port: 0,
      version: "h2",
      timeoutMs: 1,
      daemonArgs: ["--no-build"],
    });
    assert.ok("error" in late && late.pid);
    started.add(late.pid);
    const deadline = performance.now() + 5000;
    while (pidAlive(late.pid) && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.equal(pidAlive(late.pid), false, "no orphan daemon");
  });
});
