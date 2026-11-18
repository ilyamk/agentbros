/**
 * RFC 0004 D1, WP15: the optional Claude Code status line. The script counts what waits for the user from the running
 * console (127.0.0.1, token header, bounded time) or from the project files, prints one line, never fails and stays
 * within its budget; `harness:setup --statusline` plans, applies and removes only our `statusLine`, keeps the hooks,
 * and never replaces another tool's status line. Temporary roots only.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyHookPlans, hooksStatus, planHooks } from "../src/lib/harness/hooks";
import {
  applyStatusLinePlan,
  planStatusLine,
  statusLineEntry,
  statusLineStatus,
  STATUSLINE_FILE,
} from "../src/lib/harness/statusline";
import { BUDGET_MS, budgetMs, fromFiles, fromServer, statusLine } from "../scripts/hooks/console-statusline.mjs";
import { makeRoot, removeRoot, startTestServer } from "./helpers/console-server";

const REPO = path.resolve(import.meta.dirname, "..");
const SCRIPT = path.join(REPO, "scripts/hooks/console-statusline.mjs");
const roots: string[] = [];
after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A checkout-like root (the markers checkoutRoot looks for) with a waiting card, a gate lease and a paused project. */
function checkout() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-statusline-")));
  roots.push(root);
  mkdirSync(path.join(root, "scripts/hooks"), { recursive: true });
  writeFileSync(path.join(root, "scripts/hooks/agentbros-hook.mjs"), "");
  writeFileSync(path.join(root, "package.json"), "{}");
  const write = (relative: string, value: unknown) => {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(value));
  };
  write("public/projects/alpha/pipeline/cards/c1.json", { v: 1, id: "c1", expectsAnswer: true, title: "Pick one" });
  write("public/projects/alpha/pipeline/cards/c2.json", {
    v: 1,
    id: "c2",
    expectsAnswer: true,
    answer: { at: "2026-11-17T09:00:00Z", choice: "a" },
  });
  write("public/projects/beta/pipeline/session/control.json", { v: 1, state: "paused", at: "2026-11-17T09:00:00Z" });
  return root;
}

test("files: waiting cards and paused projects, within the budget", async () => {
  const root = checkout();
  assert.deepEqual(fromFiles(root, performance.now() + 1000), { waiting: 1, paused: 1, source: "files" });
  assert.equal(await statusLine(root, { server: null }), "Agent Bros console: 1 waiting · 1 paused");
  assert.equal(await statusLine(undefined), "");
  // An exhausted deadline scans nothing and still answers.
  assert.deepEqual(fromFiles(root, performance.now() - 1), { waiting: 0, paused: 0, source: "files" });
});

test("server: the home answer with the token header; a wrong token or a silent server falls back", async () => {
  const root = makeRoot();
  roots.push(root);
  const server = await startTestServer(root);
  try {
    const counts = await fromServer({ port: server.port, token: server.token }, 2000);
    assert.equal(counts?.source, "server");
    assert.equal(counts?.waiting, 0);
    assert.equal(await fromServer({ port: server.port, token: "0".repeat(64) }, 2000), undefined);
  } finally {
    await server.close();
    removeRoot(root);
  }
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const port = (silent.address() as { port: number }).port;
  const started = performance.now();
  assert.equal(await fromServer({ port, token: "x" }, 40), undefined);
  assert.ok(performance.now() - started < 200);
  silent.closeAllConnections();
  silent.close();
  const root2 = checkout();
  const line = await statusLine(root2, { server: { port, token: "x" } });
  assert.equal(line, "Agent Bros console: 1 waiting · 1 paused");
});

test("the script prints one line in a checkout, nothing outside one, and always exits 0", () => {
  const root = checkout();
  // A loaded test machine can spend the default 100 ms on Node's start alone: correctness runs with a wider budget.
  const env = { ...process.env, AGENTBROS_STATUSLINE_BUDGET_MS: "2000" };
  const run = (input: string) =>
    spawnSync(process.execPath, [SCRIPT], { input, encoding: "utf8", cwd: tmpdir(), timeout: 5000, env });
  const inside = run(JSON.stringify({ workspace: { current_dir: path.join(root, "public") } }));
  assert.equal(inside.status, 0);
  assert.equal(inside.stdout, "Agent Bros console: 1 waiting · 1 paused\n");
  const outside = run(JSON.stringify({ workspace: { current_dir: tmpdir() } }));
  assert.equal(outside.status, 0);
  assert.equal(outside.stdout, "");
  const garbage = run("not json");
  assert.equal(garbage.status, 0);
});

test("the budget: 100 ms by default, from the process's start; the work itself is a few ms; a hard exit", async () => {
  assert.equal(BUDGET_MS, 100);
  assert.equal(budgetMs({}), 100);
  assert.equal(budgetMs({ AGENTBROS_STATUSLINE_BUDGET_MS: "50" }), 100, "never below the default");
  assert.equal(budgetMs({ AGENTBROS_STATUSLINE_BUDGET_MS: "99999" }), 2000);
  const root = checkout();
  const started = performance.now();
  await statusLine(root, { server: null });
  assert.ok(performance.now() - started < BUDGET_MS / 2, "reading the files fits well inside the budget");
  // A script that would hang (stdin never closed) still exits by itself.
  const hung = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: "utf8", timeout: 5000, stdio: "pipe" });
  assert.equal(hung.status, 0);
});

test("harness:setup --statusline: install keeps the hooks, is idempotent, removes only ours, never replaces another", () => {
  const root = checkout();
  // Hooks first, then the status line.
  applyHookPlans(root, [planHooks(root, "claude")]);
  assert.equal(statusLineStatus(root), "missing");
  const plan = planStatusLine(root);
  assert.equal(plan.action, "write");
  applyStatusLinePlan(root, plan);
  assert.equal(statusLineStatus(root), "installed");
  assert.equal(hooksStatus(root).claude, "installed");
  assert.equal(planStatusLine(root).action, "none");
  const settings = JSON.parse(readFileSync(path.join(root, STATUSLINE_FILE), "utf8"));
  assert.deepEqual(settings.statusLine, statusLineEntry());
  assert.doesNotMatch(JSON.stringify(settings), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  // Hooks re-applied after the status line keep it.
  applyHookPlans(root, [planHooks(root, "claude", "remove")]);
  applyHookPlans(root, [planHooks(root, "claude")]);
  assert.equal(statusLineStatus(root), "installed");
  // Remove: only ours.
  applyStatusLinePlan(root, planStatusLine(root, "remove"));
  assert.equal(statusLineStatus(root), "missing");
  assert.equal(hooksStatus(root).claude, "installed");
  // Another tool's status line is a conflict, never replaced or removed.
  const file = path.join(root, STATUSLINE_FILE);
  const other = { ...JSON.parse(readFileSync(file, "utf8")), statusLine: { type: "command", command: "my-line" } };
  writeFileSync(file, JSON.stringify(other));
  assert.equal(planStatusLine(root).action, "conflict");
  assert.equal(planStatusLine(root, "remove").action, "none");
  writeFileSync(file, "{ // comments");
  assert.equal(planStatusLine(root).action, "conflict");
});

test("harness:setup --statusline CLI plans without writing", () => {
  const root = checkout();
  const run = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO, "node_modules/tsx/dist/cli.mjs"), path.join(REPO, "scripts/harness-setup.ts"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" },
      },
    );
    const json = JSON.parse(result.stdout.trim().split("\n").at(-1)!);
    assert.equal(json.ok, true, result.stdout + result.stderr);
    return json;
  };
  const json = run("--statusline");
  assert.equal(json.metadata.mode, "statusline-plan");
  assert.equal(json.metadata.statusLine.action, "write");
  assert.equal(statusLineStatus(root), "missing");
  // It plans against the folder it runs in: another status line there is a conflict, and --apply changes nothing.
  mkdirSync(path.join(root, ".claude"), { recursive: true });
  const foreign = JSON.stringify({ statusLine: { type: "command", command: "my-line" } });
  writeFileSync(path.join(root, STATUSLINE_FILE), foreign);
  const conflict = run("--statusline", "--apply");
  assert.equal(conflict.metadata.statusLine.action, "conflict");
  assert.deepEqual(conflict.outputs, []);
  assert.equal(readFileSync(path.join(root, STATUSLINE_FILE), "utf8"), foreign);
});
