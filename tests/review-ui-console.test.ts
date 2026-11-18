/**
 * RFC 0004 WP13e/f: `pnpm review:ui` is the console's review alias (D2, parity row RU-SE01). In a
 * temporary checkout-like root the CLI starts the console detached, prints one JSON line whose URL opens the
 * project's Timeline page, reuses the server on a second run, and the daemon serves the campaign review (the daemon
 * mounts the campaign handler). The server is always stopped and no process is left behind.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { BUNDLE_VERSION_FILE, bundleHash, codeRoot, distDirOf } from "../src/lib/console/bundle";
import { readLock, pidAlive } from "../src/lib/console/lock";
import { stopConsoleServer } from "../src/lib/console/start";
import { SERVER_LOCK_FILE } from "../src/types/console";
import { CAMPAIGN, makeCampaign } from "./helpers/campaign-review";
import { makeRoot, raw, removeRoot } from "./helpers/console-server";

const SCRIPT = path.join(codeRoot(), "scripts/review-ui.ts");
const TSX = pathToFileURL(createRequire(path.join(codeRoot(), "package.json")).resolve("tsx")).href;

/** A root `isCheckoutRoot` accepts, with a fresh dist so the daemon never builds. */
function checkoutRoot(): string {
  const root = makeRoot();
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "agentbros", private: true }));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "src/types"), { recursive: true });
  writeFileSync(path.join(root, "src/types/console.ts"), "export {};\n");
  mkdirSync(path.join(root, "apps/console"), { recursive: true });
  writeFileSync(path.join(distDirOf(root), BUNDLE_VERSION_FILE), bundleHash() + "\n");
  return root;
}

function cli(root: string, args: string[], env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AGENTBROS_EVENTS: "off",
    AGENTBROS_HOOKS: "off",
    ...env,
  };
  delete childEnv.NODE_TEST_CONTEXT;
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete childEnv[key];
  return new Promise<{ code: number | null; json: any; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX, SCRIPT, ...args], {
      cwd: root,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      const lines = stdout.trim().split("\n");
      assert.equal(lines.length, 1, `one JSON line on stdout, got: ${stdout}`);
      resolve({ code, json: JSON.parse(lines[0]!), stderr });
    });
  });
}

const CONSOLE_ON = { AGENTBROS_CONSOLE: undefined };

test("review:ui starts or reuses the console at the Timeline page", { timeout: 60_000 }, async (t) => {
  const root = checkoutRoot();
  await makeCampaign(root);
  let pid: number | undefined;
  t.after(() => removeRoot(root));
  try {
    const first = await cli(root, ["--project", CAMPAIGN, "--port", "0", "--print-token"], CONSOLE_ON);
    assert.equal(first.code, 0, JSON.stringify(first.json));
    const meta = first.json.metadata;
    assert.equal(first.json.ok, true);
    assert.equal(typeof first.json.elapsedMs, "number");
    pid = meta.pid;
    assert.equal(meta.projectId, CAMPAIGN);
    assert.equal(meta.ui, "console");
    assert.equal(meta.campaign, true);
    assert.equal(meta.paidActions, false);
    assert.equal(meta.reused, false);
    assert.match(meta.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    const url = new URL(meta.url);
    assert.equal(url.origin, meta.origin);
    const fragment = new URLSearchParams(url.hash.slice(1));
    assert.match(fragment.get("token") ?? "", /^[a-f0-9]{64}$/);
    assert.equal(fragment.get("project"), CAMPAIGN);
    assert.equal(fragment.get("view"), "timeline");
    assert.match(first.stderr, /Keep the URL private/);
    assert.doesNotMatch(first.stderr, /legacy/);

    // The daemon mounts the campaign handler: the campaign view's state route answers.
    const port = Number(url.port);
    const state = await raw(port, {
      path: `/api/review/${CAMPAIGN}/campaign`,
      headers: { "x-console-token": fragment.get("token")! },
    });
    assert.equal(state.status, 200, state.text);
    assert.equal(state.json().campaignId, CAMPAIGN);
    // The real projector classifies the container as a campaign, so the console page shows the campaign view.
    const view = await raw(port, {
      path: `/api/projects/${CAMPAIGN}/view`,
      headers: { "x-console-token": fragment.get("token")! },
    });
    assert.equal(view.status, 200, view.text);
    assert.equal(view.json().project.route, "campaign");

    const second = await cli(root, ["--project", "demo-film"], CONSOLE_ON);
    assert.equal(second.json.ok, true, JSON.stringify(second.json));
    assert.equal(second.json.metadata.reused, true);
    assert.equal(second.json.metadata.pid, pid);
    assert.equal(second.json.metadata.campaign, false);
    // Not a terminal and no --print-token: the long-lived token stays out of stdout (agent transcripts).
    assert.equal(second.json.metadata.tokenInUrl, false);
    assert.match(
      second.json.metadata.url,
      new RegExp(`^${meta.origin}/#pair=[a-f0-9]{32}&project=demo-film&view=timeline$`),
      "a one-use pairing link instead of the token",
    );
    assert.ok(!JSON.stringify(second.json).includes(fragment.get("token")!), "no token on stdout");
    assert.match(second.stderr, /--open/);
    assert.equal(meta.tokenInUrl, true);
  } finally {
    const stopped = await stopConsoleServer({ rootDir: root });
    const lockPid = pid ?? readLock(root)?.pid;
    if (lockPid !== undefined) {
      if (pidAlive(lockPid))
        try {
          process.kill(lockPid, "SIGKILL");
        } catch {
          // gone
        }
      assert.equal(pidAlive(lockPid), false, "no console process remains");
    }
    assert.equal(existsSync(path.join(root, SERVER_LOCK_FILE)), false, "the lock is removed");
    if (pid !== undefined) assert.equal(stopped.stopped, true, stopped.reason ?? "");
  }
});

test("review:ui refuses before spawning anything", { timeout: 60_000 }, async (t) => {
  const root = checkoutRoot();
  t.after(() => removeRoot(root));
  const missing = await cli(root, ["--project", "no-such-project"], CONSOLE_ON);
  assert.equal(missing.json.error, "PROJECT_NOT_FOUND");
  const invalid = await cli(root, ["--project", "../evil"], CONSOLE_ON);
  assert.equal(invalid.json.ok, false);
  assert.equal(missing.code, 1);
  const off = await cli(root, ["--project", "demo-film"], { AGENTBROS_CONSOLE: "off" });
  assert.equal(off.json.ok, false);
  assert.equal(off.json.error, "INTERNAL");
  assert.match(off.json.message, /The console could not start/);
  assert.doesNotMatch(off.json.message, /legacy/);
  assert.equal(existsSync(path.join(root, SERVER_LOCK_FILE)), false, "nothing was started");
});
