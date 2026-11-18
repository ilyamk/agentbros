/**
 * RFC 0004 §13 "Server security" for the console server (WP2): loopback bind, Host check, token and cookie, CSRF
 * header and exact Origin on POST, path traversal (`..`, encoded, absolute, symlinks, hidden files), security headers
 * and no secrets in any response.
 */
import assert from "node:assert/strict";
import { mkdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import type { ConsoleServer } from "../src/lib/console/server";
import { consoleCookieName, MEDIA_READ_LABEL, mediaReadValue } from "../src/lib/console/http/auth";
import { healthProof } from "../src/lib/console/lock";
import { SSE_MAX_CLIENTS_PER_PROJECT } from "../src/lib/console/sse";
import { makeRoot, PROJECT, postHeaders, raw, removeRoot, startTestServer } from "./helpers/console-server";

const SECRET = "sk-" + "fake-console-secret-0123456789abcdef";

describe("console server security", () => {
  let root: string;
  let server: ConsoleServer;
  let cookie: string;

  before(async () => {
    root = makeRoot();
    writeFileSync(path.join(root, ".env"), `FAL_KEY=${SECRET}\nOPENAI_API_KEY=${SECRET}\n`);
    process.env.AGENTBROS_FAKE_CONSOLE_SECRET = SECRET;
    const project = path.join(root, "public/projects", PROJECT);
    writeFileSync(path.join(project, ".env"), `SECRET=${SECRET}\n`);
    mkdirSync(path.join(project, "media"), { recursive: true });
    writeFileSync(path.join(project, "media/frame.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(path.join(project, "notes.json"), JSON.stringify({ ok: true }));
    writeFileSync(path.join(project, "pipeline/events.jsonl"), "{}\n");
    mkdirSync(path.join(project, "pipeline/jobs"), { recursive: true });
    writeFileSync(path.join(project, "pipeline/jobs/job.json"), JSON.stringify({ provider: "fal" }));
    symlinkSync(path.join(root, ".env"), path.join(project, "media/link.png"));
    symlinkSync(root, path.join(project, "rootlink"));
    // A second project whose folder is a symlink to the first.
    symlinkSync(project, path.join(root, "public/projects/alias"));
    server = await startTestServer(root);
    const session = await raw(server.port, { method: "POST", path: "/api/session", headers: postHeaders(server) });
    cookie = String(session.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  });

  after(async () => {
    await server?.close();
    delete process.env.AGENTBROS_FAKE_CONSOLE_SECRET;
    removeRoot(root);
  });

  test("binds 127.0.0.1 only", () => {
    const address = server.server.address();
    assert.ok(address && typeof address === "object");
    assert.equal(address.address, "127.0.0.1");
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/);
  });

  test("session token file is 0600 and stable across restarts", async () => {
    const file = path.join(root, "out/console/session.json");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const second = await startTestServer(root);
    try {
      assert.equal(second.token, server.token);
    } finally {
      await second.close();
    }
  });

  test("Host must be 127.0.0.1:<port> or localhost:<port>", async () => {
    const headers = { "x-console-token": server.token };
    for (const host of ["evil.example", `evil.example:${server.port}`, `127.0.0.1:${server.port + 1}`, "127.0.0.1"]) {
      const res = await raw(server.port, { path: "/api/projects", headers: { ...headers, Host: host } });
      assert.equal(res.status, 403, host);
      assert.equal(res.json().error, "FORBIDDEN");
    }
    // Even the static page refuses a rebinding Host.
    assert.equal((await raw(server.port, { path: "/", headers: { Host: "evil.example" } })).status, 403);
    const local = await raw(server.port, {
      path: "/api/projects",
      headers: { ...headers, Host: `localhost:${server.port}` },
    });
    assert.equal(local.status, 200);
  });

  test("static files are the only unauthenticated paths; index.html carries a CSP nonce", async () => {
    const page = await raw(server.port, { path: "/" });
    assert.equal(page.status, 200);
    const nonce = /<meta name="csp-nonce" content="([^"]+)">/.exec(page.text)?.[1];
    assert.ok(nonce);
    assert.match(
      String(page.headers["content-security-policy"]),
      new RegExp(`style-src 'self' 'nonce-${nonce.replace(/[+/=]/g, "\\$&")}'`),
    );
    const again = await raw(server.port, { path: "/" });
    assert.notEqual(/content="([^"]+)"/.exec(again.text)?.[1], nonce, "a fresh nonce per response");
    assert.equal((await raw(server.port, { path: "/app.js" })).status, 200);
    assert.equal((await raw(server.port, { path: "/style.css" })).status, 200);
    for (const target of [
      "/api/projects",
      `/api/projects/${PROJECT}/view`,
      `/api/projects/${PROJECT}/events`,
      `/api/stream?project=${PROJECT}`,
      `/media/${PROJECT}/media/frame.png`,
      `/thumb/${PROJECT}/media/frame.png`,
      "/api/session",
      "/nope",
    ]) {
      const res = await raw(server.port, { path: target });
      assert.equal(res.status, 403, target);
      assert.equal(res.json().error, "FORBIDDEN");
    }
  });

  test("the header authenticates reads; the cookie holds a derived value, never the token, and reads media only", async () => {
    assert.equal(
      (await raw(server.port, { path: "/api/projects", headers: { "x-console-token": server.token } })).status,
      200,
    );
    const value = cookie.split("=")[1]!;
    assert.notEqual(value, server.token, "the cookie never carries the token");
    assert.equal(value, mediaReadValue(server.token));
    assert.doesNotMatch(cookie, new RegExp(server.token));
    // No health proof (an HMAC of the token over a caller-chosen nonce) can equal the cookie value.
    assert.doesNotMatch(MEDIA_READ_LABEL, /^[a-f0-9]{32}$/, "the label is no valid nonce");
    for (const nonce of ["0".repeat(32), "f".repeat(32)]) assert.notEqual(healthProof(server.token, nonce), value);
    // Even a perfect same-origin browser request: the cookie alone opens no JSON read, no stream, no token.
    const sameOrigin = { Cookie: cookie, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" };
    for (const target of [
      "/api/projects",
      `/api/projects/${PROJECT}/view`,
      `/api/projects/${PROJECT}/events`,
      `/api/stream?project=${PROJECT}`,
      "/api/stream",
      "/api/metrics",
      "/api/library",
      "/api/session",
      `/api/review/${PROJECT}/state`,
    ]) {
      const res = await raw(server.port, { path: target, headers: sameOrigin });
      assert.equal(res.status, 403, target);
      assert.doesNotMatch(res.text, new RegExp(server.token), target);
    }
    // Media still loads with the cookie, as <img> and <video> send it.
    const media = await raw(server.port, { path: `/media/${PROJECT}/media/frame.png`, headers: { Cookie: cookie } });
    assert.equal(media.status, 200);
    for (const bad of ["0".repeat(64), server.token, server.token.slice(1), ""]) {
      assert.equal(
        (await raw(server.port, { path: "/api/projects", headers: { "x-console-token": bad.slice(0, 63) } })).status,
        403,
      );
      assert.equal(
        (
          await raw(server.port, {
            path: `/media/${PROJECT}/media/frame.png`,
            headers: { Cookie: `${consoleCookieName(server.token)}=${bad}` },
          })
        ).status,
        403,
        "a cookie holding the raw token (an old session) or anything else is refused",
      );
    }
    assert.equal(
      (await raw(server.port, { path: "/api/projects", headers: { Cookie: `review_session_x=${server.token}` } }))
        .status,
      403,
    );
  });

  test("each checkout's cookie has its own name, so another console's cookie never logs this one out", async () => {
    const otherToken = "1".repeat(64);
    const otherName = consoleCookieName(otherToken);
    assert.notEqual(otherName, consoleCookieName(server.token));
    assert.equal(consoleCookieName(server.token), cookie.split("=")[0], "stable: derived from the token");
    const both = `${otherName}=${mediaReadValue(otherToken)}; ${cookie}`;
    const path = `/media/${PROJECT}/media/frame.png`;
    assert.equal((await raw(server.port, { path, headers: { Cookie: both } })).status, 200);
    assert.equal(
      (await raw(server.port, { path, headers: { Cookie: `${otherName}=${mediaReadValue(otherToken)}` } })).status,
      403,
    );
  });

  test("POST /api/session needs the header and the exact Origin; the cookie is HttpOnly SameSite=Strict Path=/", async () => {
    const set = String(
      (await raw(server.port, { method: "POST", path: "/api/session", headers: postHeaders(server) })).headers[
        "set-cookie"
      ],
    );
    assert.match(set, /^agentbros_console_[a-f0-9]{12}=[a-f0-9]{64}; HttpOnly; SameSite=Strict; Path=\/$/);
    assert.ok(!set.includes(server.token), "Set-Cookie never carries the token");
    const noHeader = await raw(server.port, {
      method: "POST",
      path: "/api/session",
      headers: { Origin: server.origin, Cookie: cookie },
    });
    assert.equal(noHeader.status, 403);
    const noOrigin = await raw(server.port, {
      method: "POST",
      path: "/api/session",
      headers: { "x-console-token": server.token },
    });
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.headers["set-cookie"], undefined);
    // Neither Sec-Fetch-Site nor Origin (no browser sends a POST like that): refused even with the token.
    const bare = await raw(server.port, {
      method: "POST",
      path: "/api/session",
      headers: { "x-console-token": server.token, "Content-Type": "application/json" },
    });
    assert.equal(bare.status, 403);
    const wrongOrigin = await raw(server.port, {
      method: "POST",
      path: "/api/session",
      headers: postHeaders(server, { Origin: "http://evil.example" }),
    });
    assert.equal(wrongOrigin.status, 403);
  });

  test("GET /api/session never returns the token: the header gets { ok: true }, the cookie nothing", async () => {
    const ok = await raw(server.port, { path: "/api/session", headers: { "x-console-token": server.token } });
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.json(), { ok: true });
    for (const site of ["same-origin", "cross-site", "same-site", "none"]) {
      const res = await raw(server.port, { path: "/api/session", headers: { Cookie: cookie, "Sec-Fetch-Site": site } });
      assert.equal(res.status, 403, site);
      assert.doesNotMatch(res.text, new RegExp(server.token));
    }
  });

  test("streams are capped per project (429 past the cap)", async () => {
    const streams: { close(): void }[] = [];
    const { request } = await import("node:http");
    const open = (target = `/api/stream?project=${PROJECT}`) =>
      new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: server.port,
            path: target,
            agent: false,
            headers: { Host: `127.0.0.1:${server.port}`, "x-console-token": server.token },
          },
          (res) => {
            streams.push({ close: () => req.destroy() });
            if (res.statusCode !== 200) res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end();
      });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < SSE_MAX_CLIENTS_PER_PROJECT + 1; i++) statuses.push(await open());
      assert.deepEqual(statuses.slice(0, -1), Array(SSE_MAX_CLIENTS_PER_PROJECT).fill(200));
      assert.equal(statuses.at(-1), 429);
      assert.equal(await open("/api/stream"), 200, "the all-projects stream is its own key");
    } finally {
      for (const stream of streams) stream.close();
    }
  });

  test("a present foreign Origin is refused on every request; other methods are refused without CORS headers", async () => {
    const cross = await raw(server.port, {
      path: "/api/projects",
      headers: { "x-console-token": server.token, Origin: `http://127.0.0.1:${server.port + 1}` },
    });
    assert.equal(cross.status, 403);
    for (const method of ["OPTIONS", "PUT", "DELETE", "PATCH"]) {
      const res = await raw(server.port, {
        method,
        path: `/api/projects/${PROJECT}/decisions`,
        headers: { ...postHeaders(server), "Access-Control-Request-Method": "POST" },
      });
      assert.ok(res.status === 405 || res.status === 403, method);
      assert.equal(res.headers["access-control-allow-origin"], undefined);
    }
  });

  test("every POST needs the CSRF header and the exact Origin, then a strict JSON body", async () => {
    const target = `/api/projects/${PROJECT}/decisions`;
    const body = JSON.stringify({ kind: "frame-feedback", answer: "Make the logo bigger." });
    const cases: Array<[string, Record<string, string>, string, number]> = [
      ["cookie only", { Cookie: cookie, Origin: server.origin, "Content-Type": "application/json" }, body, 403],
      ["no origin", { "x-console-token": server.token, Cookie: cookie, "Content-Type": "application/json" }, body, 403],
      ["wrong origin", postHeaders(server, { Origin: "http://localhost:1" }), body, 403],
      ["charset suffix", postHeaders(server, { "Content-Type": "application/json; charset=utf-8" }), body, 400],
      ["form", postHeaders(server, { "Content-Type": "application/x-www-form-urlencoded" }), "a=b", 400],
      ["bad json", postHeaders(server), "{", 400],
      ["unknown field", postHeaders(server), JSON.stringify({ kind: "frame-feedback", answer: "x", extra: 1 }), 400],
      ["empty words", postHeaders(server), JSON.stringify({ kind: "frame-feedback", answer: "  " }), 400],
      [
        "over 64 KiB",
        postHeaders(server),
        JSON.stringify({ kind: "frame-feedback", answer: "x".repeat(70 * 1024) }),
        400,
      ],
      ["valid", postHeaders(server), body, 501],
    ];
    for (const [name, headers, payload, status] of cases) {
      const res = await raw(server.port, { method: "POST", path: target, headers, body: payload });
      assert.equal(res.status, status, name);
    }
    const valid = await raw(server.port, { method: "POST", path: target, headers: postHeaders(server), body });
    assert.equal(valid.json().error, "NOT_IMPLEMENTED");
    const control = await raw(server.port, {
      method: "POST",
      path: `/api/projects/${PROJECT}/control`,
      headers: postHeaders(server),
      body: JSON.stringify({ state: "paused", answer: "Pause please." }),
    });
    assert.equal(control.status, 501);
    const card = await raw(server.port, {
      method: "POST",
      path: `/api/projects/${PROJECT}/cards/card-1/answer`,
      headers: postHeaders(server),
      body: JSON.stringify({ choice: "a" }),
    });
    assert.equal(card.status, 404); // the default server answers cards (WP11); this one does not exist
    assert.equal(card.json().error, "NOT_FOUND");
    const badCard = await raw(server.port, {
      method: "POST",
      path: `/api/projects/${PROJECT}/cards/..%2Fx/answer`,
      headers: postHeaders(server),
      body: JSON.stringify({ choice: "a" }),
    });
    assert.equal(badCard.status, 400);
    const unknown = await raw(server.port, {
      method: "POST",
      path: "/api/projects/no-such-project/decisions",
      headers: postHeaders(server),
      body,
    });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json().error, "PROJECT_NOT_FOUND");
  });

  test("path traversal, absolute paths, symlinks and hidden files are refused", async () => {
    const auth = { "x-console-token": server.token };
    const refused = [
      `/media/${PROJECT}/../../.env`,
      `/media/${PROJECT}/media/../../../.env`,
      `/media/${PROJECT}/%2e%2e/%2e%2e/.env`,
      `/media/${PROJECT}/..%2F..%2F.env`,
      `/media/${PROJECT}/media%2F..%2F..%2F..%2F.env`,
      `/media/${PROJECT}//etc/passwd`,
      `/media/${PROJECT}/%2Fetc%2Fpasswd`,
      `/media/${PROJECT}/C:%5Cwindows`,
      `/media/${PROJECT}/.env`,
      `/media/${PROJECT}/media/link.png`,
      `/media/${PROJECT}/rootlink/.env`,
      `/media/${PROJECT}/rootlink/public/projects/${PROJECT}/media/frame.png`,
      `/media/alias/media/frame.png`,
      `/media/..%2F..%2F/x.png`,
      `/media/${PROJECT}/@out/../../.env`,
      `/thumb/${PROJECT}/../../.env`,
      `/thumb/${PROJECT}/media/link.png`,
    ];
    for (const target of refused) {
      const res = await raw(server.port, { path: target, headers: auth });
      assert.ok(res.status === 403 || res.status === 400, `${target} → ${res.status}`);
      assert.ok(!res.text.includes(SECRET), target);
    }
    // Structured state, journals and provider records reach the UI only through the view API.
    for (const target of ["notes.json", "project.json", "pipeline/events.jsonl", "pipeline/jobs/job.json"])
      assert.equal(
        (await raw(server.port, { path: `/media/${PROJECT}/${target}`, headers: auth })).status,
        403,
        target,
      );
    // The real file is served; a missing one is 404.
    assert.equal((await raw(server.port, { path: `/media/${PROJECT}/media/frame.png`, headers: auth })).status, 200);
    assert.equal((await raw(server.port, { path: `/media/${PROJECT}/media/none.png`, headers: auth })).status, 404);
    assert.equal((await raw(server.port, { path: `/api/projects/..%2F..%2Fetc/view`, headers: auth })).status, 400);
  });

  test("every response carries the security headers", async () => {
    for (const [target, headers] of [
      ["/", {}],
      ["/api/projects", { "x-console-token": server.token }],
      ["/api/projects", {}],
      ["/nope", { "x-console-token": server.token }],
      [`/media/${PROJECT}/media/frame.png`, { Cookie: cookie }],
    ] as const) {
      const res = await raw(server.port, { path: target, headers: { ...headers } });
      assert.equal(res.headers["cache-control"], "no-store", target);
      assert.equal(res.headers["x-content-type-options"], "nosniff", target);
      assert.equal(res.headers["referrer-policy"], "no-referrer", target);
      const csp = String(res.headers["content-security-policy"]);
      for (const directive of [
        "default-src 'none'",
        "script-src 'self'",
        "img-src 'self'",
        "media-src 'self'",
        "connect-src 'self'",
        "font-src 'self'",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
      ])
        assert.ok(csp.includes(directive), `${target}: ${directive}`);
    }
  });

  test("no secret appears in any response", async () => {
    const auth = { "x-console-token": server.token, Cookie: cookie };
    const targets = [
      "/",
      "/app.js",
      "/style.css",
      "/api/health",
      "/api/session",
      "/api/projects",
      `/api/projects/${PROJECT}/view`,
      `/api/projects/${PROJECT}/events`,
      `/media/${PROJECT}/notes.json`,
      `/media/${PROJECT}/.env`,
      `/media/${PROJECT}/../../.env`,
      `/media/${PROJECT}/media/link.png`,
      `/media/${PROJECT}/rootlink/.env`,
      "/nope",
    ];
    for (const target of targets) {
      const res = await raw(server.port, { path: target, headers: auth });
      const all = res.text + JSON.stringify(res.headers);
      assert.ok(!all.includes(SECRET), `${target} leaked the secret`);
    }
    const post = await raw(server.port, {
      method: "POST",
      path: `/api/projects/${PROJECT}/decisions`,
      headers: postHeaders(server),
      body: JSON.stringify({ kind: "frame-feedback", answer: "x" }),
    });
    assert.ok(!post.text.includes(SECRET));
  });
});
