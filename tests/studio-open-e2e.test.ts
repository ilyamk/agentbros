/**
 * End to end, gated by RUN_STUDIO_E2E=1 (it bundles the real `src/index.ts` and starts Remotion Studio): `studio:open`
 * on a fixture project starts Studio under the loopback preload, the composition URL answers on 127.0.0.1, every
 * listening socket of its process group is loopback and its LAN addresses refuse, a project change pushed through a
 * second `studio:open` reaches Studio live (`new-input-props` on its event stream) on the same process, and `--stop`
 * ends the whole group. In Chromium: Studio's own page loads with no refused request (assets, event streams, lazy
 * compilation on its second port), a same-site page on another port cannot frame it (CSP frame-ancestors), and a
 * cross-site page gets 403 for a frame or a script include while a plain link still opens it.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import path from "node:path";
import { writeControl } from "../src/lib/console/control";
import { notImplementedActions } from "../src/lib/console/data";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { studioActions } from "../src/lib/console/studio-actions";
import { postHeaders, raw, startTestServer } from "./helpers/console-server";

const RUN = process.env.RUN_STUDIO_E2E === "1";
const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const PROJECT = "studio-e2e";

function cli(root: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_NO_DOTENV: "1", AGENTBROS_EVENTS: "off" };
  delete env.AGENTBROS_CHANNEL;
  delete env.AGENTBROS_ACTOR;
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/studio-open.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env,
    timeout: 300_000,
  });
  const lines = run.stdout.trim().split("\n").filter(Boolean);
  assert.equal(lines.length, 1, `${run.stdout}\n${run.stderr}`);
  return JSON.parse(lines[0]!) as Record<string, any>;
}

/** Collects Studio's server-sent events until `stop()`. */
function events(port: number) {
  const messages: any[] = [];
  const req = request({ host: "127.0.0.1", port, path: "/events", headers: { Host: `127.0.0.1:${port}` } }, (res) => {
    let buffer = "";
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) messages.push(JSON.parse(data.slice(6)));
      }
    });
  });
  req.on("error", () => {});
  req.end();
  return { messages, stop: () => req.destroy() };
}

const get = (port: number, pathname: string) =>
  new Promise<number>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: pathname, headers: { Host: `127.0.0.1:${port}` } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", () => resolve(0));
    req.end();
  });

const connects = (host: string, port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: 1_000 });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("timeout", () => (socket.destroy(), resolve(false)));
    socket.once("error", () => resolve(false));
  });

/** A page server on 127.0.0.1 serving `html`; resolves its port. */
async function pageServer(t: TestContext, html: string): Promise<number> {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(html);
  });
  const port = await new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)),
  );
  t.after(() => server.close());
  return port;
}

/** Studio in a real browser: its own page works; other pages can neither frame it nor include its scripts. */
async function browserChecks(t: TestContext, port: number, url: string) {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const studio = `http://127.0.0.1:${port}`;

  // 1. Studio's own page: every request it makes to this machine succeeds.
  const page = await browser.newPage();
  const refused: string[] = [];
  const failed: string[] = [];
  const ports = new Set<string>();
  page.on("response", (response) => {
    const target = new URL(response.url());
    if (!["127.0.0.1", "localhost"].includes(target.hostname)) return;
    ports.add(target.port);
    if (response.status() >= 400) refused.push(`${response.status()} ${response.url()}`);
  });
  page.on("requestfailed", (failure) => {
    const target = new URL(failure.url());
    if (["127.0.0.1", "localhost"].includes(target.hostname))
      failed.push(`${failure.failure()?.errorText} ${failure.url()}`);
  });
  await page.goto(url);
  await page.getByText("ProjectVertical").first().waitFor({ timeout: 120_000 });
  await page.waitForTimeout(5_000); // the composition's lazy chunk and the event streams
  assert.deepEqual(refused, [], "Studio's own requests refused");
  assert.deepEqual(failed, [], "Studio's own requests failed");
  t.diagnostic(`Studio's page used ports ${[...ports].join(", ")}`);
  await page.close();

  // 2. A same-site page on another port: the frame is blocked by frame-ancestors, the page never shows in it.
  const sameSite = await pageServer(t, `<!doctype html><iframe id="f" src="${url}"></iframe>`);
  const framing = await browser.newPage();
  await framing.goto(`http://127.0.0.1:${sameSite}/`);
  await framing.waitForTimeout(3_000);
  const framed = framing.frames().filter((frame) => frame !== framing.mainFrame());
  assert.equal(framed.length, 1);
  assert.ok(!framed[0]!.url().startsWith(studio), `Studio loaded in a frame: ${framed[0]!.url()}`);
  await framing.close();

  // 3. A cross-site page (localhost is another site than 127.0.0.1): frame and script get 403; a link still opens.
  const crossSite = await pageServer(
    t,
    `<!doctype html><iframe src="${url}"></iframe><script src="${studio}/bundle.js"></script><a id="go" href="${url}">Studio</a>`,
  );
  const cross = await browser.newPage();
  const statuses = new Map<string, number>();
  cross.on("response", (response) => {
    if (response.url().startsWith(studio)) statuses.set(response.request().resourceType(), response.status());
  });
  await cross.goto(`http://localhost:${crossSite}/`);
  await cross.waitForTimeout(3_000);
  assert.equal(statuses.get("document"), 403, "a cross-site frame");
  assert.equal(statuses.get("script"), 403, "a cross-site script include");
  const [navigation] = await Promise.all([cross.waitForNavigation(), cross.click("#go")]);
  assert.equal(navigation?.status(), 200, "a link from another site opens Studio");
  await cross.close();
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test(
  "studio:open starts a loopback-only Studio, updates its props live and stops its whole process group",
  { skip: RUN ? false : "set RUN_STUDIO_E2E=1 (bundles src/index.ts and starts Remotion Studio)", timeout: 600_000 },
  async (t: TestContext) => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-studio-e2e-")));
    const dir = path.join(root, "public/projects", PROJECT);
    mkdirSync(path.join(dir, "pipeline"), { recursive: true });
    const demo = JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/legacy/demo/project.json"), "utf8"));
    writeFileSync(path.join(dir, "project.json"), JSON.stringify({ ...demo, musicVolume: 0, formats: ["vertical"] }));
    t.after(() => {
      cli(root, ["--project", PROJECT, "--stop"]);
      rmSync(root, { recursive: true, force: true });
    });

    const opened = cli(root, ["--project", PROJECT, "--timeout-ms", "240000"]);
    assert.equal(opened.ok, true, JSON.stringify(opened));
    const { url, port, pid, reused } = opened.metadata;
    assert.equal(reused, false);
    assert.equal(url, `http://127.0.0.1:${port}/ProjectVertical`);
    assert.equal(await get(port, "/ProjectVertical"), 200);

    // Every listening socket of the Studio's process group is on loopback; its LAN addresses refuse.
    const lsof = spawnSync("lsof", ["-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-g", String(pid)], { encoding: "utf8" });
    const listening = lsof.stdout.split("\n").slice(1).filter(Boolean);
    assert.ok(listening.length > 0, lsof.stdout + lsof.stderr);
    for (const line of listening) assert.match(line, /TCP (127\.0\.0\.1|\[::1\]):\d+ \(LISTEN\)/, line);
    const lan = Object.values(networkInterfaces())
      .flat()
      .filter((item) => item && !item.internal && item.family === "IPv4")
      .map((item) => item!.address);
    for (const address of lan) assert.equal(await connects(address, port), false, `reachable on ${address}`);

    await browserChecks(t, port, url);

    // A project change goes out through a second studio:open, to the same Studio, live.
    const stream = events(port);
    t.after(stream.stop);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const config = JSON.parse(readFileSync(path.join(dir, "project.json"), "utf8"));
    writeFileSync(path.join(dir, "project.json"), JSON.stringify({ ...config, tagline: "Changed while open" }));
    const again = cli(root, ["--project", PROJECT]);
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual([again.metadata.reused, again.metadata.pid, again.metadata.propsChanged], [true, pid, true]);
    let update: any;
    for (let i = 0; i < 50 && !update; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      update = stream.messages.find((message) => message.type === "new-input-props");
    }
    assert.ok(update, `no new-input-props event: ${JSON.stringify(stream.messages.map((m) => m.type))}`);
    assert.equal(update.newProps.tagline, "Changed while open");

    // Paused by the user: an agent's studio:open is refused; the user's click in the console reuses the same Studio.
    loadOrCreateSessionToken(root);
    writeControl(dir, { state: "paused", answer: "Pause for a moment.", channel: "console" });
    const agent = cli(root, ["--project", PROJECT]);
    assert.equal(agent.error, "PAUSED");
    const server = await startTestServer(root, { actions: { ...notImplementedActions, ...studioActions(root) } });
    t.after(() => server.close());
    const STUDIO = `/api/projects/${PROJECT}/studio`;
    const clicked = await raw(server.port, { method: "POST", path: STUDIO, headers: postHeaders(server), body: "{}" });
    assert.equal(clicked.status, 200, clicked.text);
    assert.deepEqual(clicked.json(), { ok: true, url, reused: true });
    const status = await raw(server.port, { path: STUDIO, headers: { "x-console-token": server.token } });
    assert.equal(status.json().running.url, url);
    const viaConsole = await raw(server.port, {
      method: "POST",
      path: `${STUDIO}/stop`,
      headers: postHeaders(server),
      body: "{}",
    });
    assert.equal(viaConsole.status, 200, viaConsole.text);
    assert.equal(viaConsole.json().running, undefined);
    writeControl(dir, { state: "running", answer: "Go on.", channel: "console" });

    const stopped = cli(root, ["--project", PROJECT, "--stop"]);
    assert.equal(stopped.metadata.stopped, 0, "the console's stop already ended it");
    for (let i = 0; i < 30 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(alive(pid), false);
    const group = spawnSync("pgrep", ["-g", String(pid)], { encoding: "utf8" });
    assert.equal(group.stdout.trim(), "", "no process of the group is left");
  },
);
