/**
 * The loopback preload Remotion Studio runs under (scripts/studio/loopback.cjs, RFC 0004 §17): listen arguments are
 * rewritten to a loopback host, wildcard and LAN binds never reach other interfaces, DNS-rebinding Host headers and
 * cross-site writes are refused, and the identity route answers. The process checks run a plain Node child under the
 * preload (no Remotion, no bundling).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { connect, createServer } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { httpGet } from "../src/lib/console/studio";

const REPO = path.resolve(import.meta.dirname, "..");
const PRELOAD = path.join(REPO, "scripts/studio/loopback.cjs");
const core = createRequire(import.meta.url)("../scripts/studio/loopback-core.cjs") as {
  IDENTITY_PATH: string;
  isLoopbackHost(host: unknown): boolean;
  rewriteListenArgs(args: unknown[]): unknown[];
  refusal(method: string, headers: Record<string, string | undefined>, ports?: ReadonlySet<number>): string | undefined;
  hostnameOf(header: string): string | undefined;
  FRAME_POLICY: string;
  withFramePolicy(value: unknown): string | string[];
};

test("listen arguments: wildcards, no host and LAN addresses become 127.0.0.1; loopback, paths and handles stay", () => {
  const cb = () => {};
  const rewrite = core.rewriteListenArgs;
  assert.deepEqual(rewrite([{ port: 3000, host: "::" }]), [{ port: 3000, host: "127.0.0.1", ipv6Only: false }]);
  assert.deepEqual(rewrite([{ port: 3000, host: "0.0.0.0" }]), [{ port: 3000, host: "127.0.0.1", ipv6Only: false }]);
  assert.deepEqual(rewrite([{ port: 3000 }]), [{ port: 3000, host: "127.0.0.1", ipv6Only: false }]);
  assert.deepEqual(rewrite([{ port: 1, host: "192.168.1.5" }]), [{ port: 1, host: "127.0.0.1", ipv6Only: false }]);
  assert.deepEqual(rewrite([{ port: 1, host: "::1" }]), [{ port: 1, host: "::1", ipv6Only: false }]);
  assert.deepEqual(rewrite([3000]), [{ port: 3000, host: "127.0.0.1" }]);
  assert.deepEqual(rewrite([3000, cb]), [{ port: 3000, host: "127.0.0.1" }, cb]);
  assert.deepEqual(rewrite([3000, "::", 511, cb]), [{ port: 3000, host: "127.0.0.1", backlog: 511 }, cb]);
  assert.deepEqual(rewrite(["3000", "localhost"]), [{ port: 3000, host: "localhost" }]);
  assert.deepEqual(rewrite([3000, undefined, cb]), [{ port: 3000, host: "127.0.0.1" }, cb]);
  assert.deepEqual(rewrite([]), [{ port: 0, host: "127.0.0.1" }]);
  assert.deepEqual(rewrite([cb]), [{ port: 0, host: "127.0.0.1" }, cb]);
  // A unix socket, a pipe and a handle keep their own address.
  assert.deepEqual(rewrite(["/tmp/studio.sock"]), ["/tmp/studio.sock"]);
  assert.deepEqual(rewrite([{ path: "/tmp/s.sock" }]), [{ path: "/tmp/s.sock" }]);
  assert.deepEqual(rewrite([{ fd: 3 }]), [{ fd: 3 }]);
  const original = [{ port: 3000, host: "::" }];
  rewrite(original);
  assert.deepEqual(original, [{ port: 3000, host: "::" }], "the caller's arguments are not mutated");
});

test("loopback hosts and Host headers", () => {
  for (const host of ["127.0.0.1", "127.8.9.10", "localhost", "::1", "[::1]", "::ffff:127.0.0.1", "LOCALHOST"])
    assert.equal(core.isLoopbackHost(host), true, host);
  for (const host of ["0.0.0.0", "::", "192.168.0.2", "evil.example", "127.0.0.1.evil.example", "", undefined])
    assert.equal(core.isLoopbackHost(host), false, String(host));
  assert.equal(core.hostnameOf("[::1]:3000"), "::1");
  assert.equal(core.hostnameOf("localhost:3000"), "localhost");
  assert.equal(core.hostnameOf("127.0.0.1"), "127.0.0.1");
});

test("requests: rebinding Host refused, cross-site writes refused, same-origin and tool requests pass", () => {
  const host = "127.0.0.1:3000";
  assert.equal(core.refusal("GET", { host }), undefined);
  assert.equal(core.refusal("GET", { host: "localhost:3000" }), undefined);
  assert.match(core.refusal("GET", { host: "evil.example:3000" })!, /loopback/);
  assert.match(core.refusal("GET", {})!, /loopback/);
  assert.equal(core.refusal("POST", { host, origin: "http://127.0.0.1:3000" }), undefined);
  assert.equal(core.refusal("POST", { host, "sec-fetch-site": "same-origin" }), undefined);
  assert.equal(core.refusal("POST", { host }), undefined, "no Origin: a local tool, not a browser page");
  assert.match(core.refusal("POST", { host, origin: "http://evil.example" })!, /foreign/);
  assert.match(core.refusal("POST", { host, origin: "https://127.0.0.1:3000" })!, /foreign/);
  assert.match(core.refusal("POST", { host, origin: "http://127.0.0.1.evil.example" })!, /foreign/);
  assert.match(core.refusal("POST", { host, origin: "null" })!, /opaque/);
  assert.match(core.refusal("PUT", { host, "sec-fetch-site": "cross-site" })!, /cross-site/);
  assert.match(core.refusal("DELETE", { host, origin: "not a url" })!, /invalid/);
  assert.match(core.refusal("OPTIONS", { host, origin: "https://evil.example" })!, /foreign/, "no CORS preflight");
  assert.match(core.refusal("GET", { host, origin: "https://www.remotion.dev" })!, /foreign/, "no cross-site reads");
  assert.equal(core.refusal("GET", { host, origin: `http://${host}` }), undefined);
});

test("cross-site: only a top-level GET or HEAD navigation passes; frames, scripts, fetches and writes are refused", () => {
  const host = "127.0.0.1:3000";
  const site = { host, "sec-fetch-site": "cross-site" };
  const navigate = { ...site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" };
  assert.equal(core.refusal("GET", navigate), undefined, "a link from elsewhere opens Studio");
  assert.equal(core.refusal("HEAD", navigate), undefined);
  assert.match(core.refusal("GET", site)!, /cross-site/, "no Sec-Fetch-Mode: not a navigation");
  assert.match(
    core.refusal("GET", { ...site, "sec-fetch-mode": "no-cors", "sec-fetch-dest": "script" })!,
    /cross-site/,
  );
  assert.match(core.refusal("GET", { ...site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" })!, /cross/);
  assert.match(core.refusal("GET", { ...site, "sec-fetch-mode": "navigate", "sec-fetch-dest": "frame" })!, /cross/);
  assert.match(core.refusal("GET", { ...site, "sec-fetch-mode": "cors", "sec-fetch-dest": "empty" })!, /cross-site/);
  assert.match(core.refusal("GET", { ...site, "sec-fetch-mode": "websocket" })!, /cross-site/);
  assert.match(core.refusal("POST", navigate)!, /cross-site/, "a cross-site form POST, even with no Origin");
  assert.match(core.refusal("OPTIONS", site)!, /cross-site/);
  for (const value of ["same-origin", "same-site", "none"])
    assert.equal(core.refusal("GET", { host, "sec-fetch-site": value, "sec-fetch-dest": "script" }), undefined, value);
});

test("an Origin must name a port this process listens on (Studio's own and its lazy-compilation server)", () => {
  const host = "127.0.0.1:3000";
  const ports = new Set([3000, 61_234]);
  assert.equal(core.refusal("POST", { host, origin: "http://127.0.0.1:3000" }, ports), undefined);
  assert.equal(core.refusal("POST", { host, origin: "http://localhost:3000" }, ports), undefined);
  assert.equal(core.refusal("GET", { host, origin: "http://127.0.0.1:61234" }, ports), undefined, "lazy compilation");
  assert.match(core.refusal("POST", { host, origin: "http://127.0.0.1:5173" }, ports)!, /another local server/);
  assert.match(core.refusal("GET", { host, origin: "http://localhost:4317" }, ports)!, /another local server/);
  assert.match(core.refusal("POST", { host, origin: "http://127.0.0.1" }, ports)!, /another local server/, "port 80");
  assert.equal(core.refusal("POST", { host }, ports), undefined, "no Origin: a local tool");
});

test("the frame policy is added to any CSP Studio sets, never dropped or doubled", () => {
  const policy = core.FRAME_POLICY;
  assert.equal(policy, "frame-ancestors 'self'");
  assert.equal(core.withFramePolicy(undefined), policy);
  assert.deepEqual(core.withFramePolicy("default-src 'self'"), ["default-src 'self'", policy]);
  assert.deepEqual(core.withFramePolicy(["a", policy]), ["a", policy]);
});

/** Starts a Node child under the preload that serves HTTP on `host`; resolves its port and a stop function. */
async function preloadedServer(
  host: string | null,
  handler = 'res.writeHead(200); res.end("ok " + req.method);',
): Promise<{ port: number; pid: number; stop: () => void; second: number }> {
  const listen = host === null ? "server.listen(0" : `server.listen({ port: 0, host: ${JSON.stringify(host)} }`;
  // A second server in the same process, as webpack's lazy compilation runs one.
  const code = `
    const http = require("node:http");
    const server = http.createServer((req, res) => { ${handler} });
    const second = http.createServer((req, res) => { res.writeHead(200); res.end("second"); });
    second.listen(0, () => {
      ${listen}, () => process.stdout.write(JSON.stringify({ ...server.address(), second: second.address().port }) + "\\n"));
    });
  `;
  const child = spawn(process.execPath, ["--require", PRELOAD, "-e", code], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, AGENTBROS_STUDIO_KEY: "0123456789abcdef" },
  });
  const address = await new Promise<{ address: string; port: number; second: number }>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]!));
    });
    child.once("exit", (code) => reject(new Error(`child exited ${code}`)));
  });
  assert.equal(address.address, "127.0.0.1", `bound to ${address.address} for host ${host}`);
  return { port: address.port, second: address.second, pid: child.pid!, stop: () => child.kill("SIGKILL") };
}

const lanAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((item) => item && !item.internal && item.family === "IPv4")
    .map((item) => item!.address);

const connects = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: 500 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });

for (const host of ["::", "0.0.0.0", null]) {
  test(`a server asking for ${host ?? "no host"} listens on 127.0.0.1 only, never on a LAN address`, async (t) => {
    const server = await preloadedServer(host);
    t.after(server.stop);
    assert.equal(await connects("127.0.0.1", server.port), true);
    for (const address of lanAddresses())
      assert.equal(await connects(address, server.port), false, `reachable on ${address}:${server.port}`);
  });
}

/** One request to the child; resolves the status and the response headers. */
const send = async (port: number, method: string, headers: Record<string, string>, pathname = "/api/x") => {
  const { request } = await import("node:http");
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0, headers: res.headers });
    });
    req.on("error", reject);
    req.end();
  });
};

test("the preloaded server refuses a rebinding Host and a cross-site POST, and answers its identity", async (t) => {
  const server = await preloadedServer("::");
  t.after(server.stop);
  const status = async (method: string, headers: Record<string, string>) =>
    (await send(server.port, method, headers)).status;
  const host = `127.0.0.1:${server.port}`;
  assert.equal(await status("GET", { Host: host }), 200);
  assert.equal(await status("GET", { Host: `evil.example:${server.port}` }), 403);
  assert.equal(await status("POST", { Host: host, Origin: "http://evil.example" }), 403);
  assert.equal(await status("POST", { Host: host, Origin: `http://${host}` }), 200);
  const identity = await httpGet(server.port, core.IDENTITY_PATH);
  assert.equal(identity?.status, 200);
  assert.deepEqual(JSON.parse(identity!.body), { pid: server.pid, key: "0123456789abcdef" });
});

test("the preloaded server: Origins of its own ports pass, another local port's are refused", async (t) => {
  const server = await preloadedServer(null);
  t.after(server.stop);
  const host = `127.0.0.1:${server.port}`;
  const status = async (origin: string, method = "POST") =>
    (await send(server.port, method, { Host: host, Origin: origin })).status;
  assert.equal(await status(`http://127.0.0.1:${server.port}`), 200);
  assert.equal(await status(`http://localhost:${server.second}`), 200, "its second (lazy-compilation) server");
  // A port of another local server (this test runner's), not of the Studio process.
  const other = createServer();
  const otherPort = await new Promise<number>((resolve) =>
    other.listen(0, "127.0.0.1", () => resolve((other.address() as { port: number }).port)),
  );
  t.after(() => other.close());
  assert.equal(await status(`http://127.0.0.1:${otherPort}`), 403);
  assert.equal(await status(`http://127.0.0.1:${otherPort}`, "GET"), 403);
  const lazy = await send(server.second, "GET", {
    Host: `127.0.0.1:${server.second}`,
    Origin: `http://127.0.0.1:${server.port}`,
  });
  assert.equal(lazy.status, 200, "Studio's page reaches the lazy-compilation server");
});

test("the preloaded server frames for no one: every response, refusals and identity included, carries the policy", async (t) => {
  const server = await preloadedServer("127.0.0.1");
  t.after(server.stop);
  const host = `127.0.0.1:${server.port}`;
  const csp = async (method: string, headers: Record<string, string>, pathname?: string) =>
    (await send(server.port, method, { Host: host, ...headers }, pathname)).headers["content-security-policy"];
  assert.equal(await csp("GET", {}), "frame-ancestors 'self'");
  assert.equal(await csp("POST", { Origin: "http://evil.example" }), "frame-ancestors 'self'", "a 403");
  assert.equal(await csp("GET", {}, core.IDENTITY_PATH), "frame-ancestors 'self'");
  const iframe = await send(server.port, "GET", {
    Host: host,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "iframe",
  });
  assert.equal(iframe.status, 403, "a cross-site frame");
  const script = await send(server.port, "GET", {
    Host: host,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Dest": "script",
  });
  assert.equal(script.status, 403, "a cross-site script include");
  const link = await send(server.port, "GET", {
    Host: host,
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  });
  assert.equal(link.status, 200, "a link from elsewhere still opens");
});

for (const [label, handler, expected] of [
  [
    "setHeader",
    `res.setHeader("Content-Security-Policy", "default-src 'self'"); res.end("x");`,
    "default-src 'self', frame-ancestors 'self'",
  ],
  [
    "writeHead with an object",
    `res.writeHead(200, { "Content-Security-Policy": "default-src 'self'" }); res.end("x");`,
    "default-src 'self', frame-ancestors 'self'",
  ],
  [
    "writeHead with a message and an object",
    `res.writeHead(200, "OK", { "content-type": "text/plain" }); res.end("x");`,
    "frame-ancestors 'self'",
  ],
  [
    "writeHead with raw headers",
    `res.writeHead(200, ["Content-Security-Policy", "default-src 'self'", "X-A", "1"]); res.end("x");`,
    "default-src 'self', frame-ancestors 'self'",
  ],
] as const)
  test(`Studio's own CSP through ${label} keeps the frame policy`, async (t) => {
    const server = await preloadedServer("127.0.0.1", handler);
    t.after(server.stop);
    const reply = await send(server.port, "GET", { Host: `127.0.0.1:${server.port}` });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["content-security-policy"], expected);
  });

test("pnpm studio starts Remotion Studio only under the loopback preload, in argv and NODE_OPTIONS", async () => {
  const { readFileSync } = await import("node:fs");
  const pkg = JSON.parse(readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.equal(pkg.scripts.studio, "node scripts/studio/studio.cjs");
  const wrapper = createRequire(import.meta.url)("../scripts/studio/studio.cjs") as {
    studioArgv(cli: string, args: string[]): string[];
    studioNodeOptions(existing?: string): string;
    preload: string;
  };
  assert.equal(wrapper.preload, PRELOAD);
  assert.deepEqual(wrapper.studioArgv("/cli.js", ["--port", "3001"]), [
    "--require",
    PRELOAD,
    "/cli.js",
    "studio",
    "--port",
    "3001",
  ]);
  assert.equal(wrapper.studioNodeOptions(""), `--require "${PRELOAD}"`);
  assert.equal(
    wrapper.studioNodeOptions(" --max-old-space-size=4096 "),
    `--max-old-space-size=4096 --require "${PRELOAD}"`,
  );
});
