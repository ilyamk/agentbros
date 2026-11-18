/**
 * The `console` and `hooks` blocks of next-step answers (RFC 0004 D11, D16, §9.2, WP7a, A1): a real detached start in
 * a checkout-like root that a second call reuses, `AGENTBROS_CONSOLE=off` starting and writing nothing, a failed start
 * reported as `console.error`, the per-project `appliedSince` cursor, and the four CLIs carrying both blocks while
 * still succeeding. Every server started here is stopped, and no process is left behind.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { pidAlive, readLock } from "../src/lib/console/lock";
import {
  APPLIED_SINCE_FIRST,
  APPLIED_SINCE_MAX,
  consoleNextFields,
  cursorFile,
  NEXT_CURSOR_DIR,
  takeAppliedSince,
  writeCursor,
} from "../src/lib/console/next-block";
import { ensureConsoleServer, startOrReuseConsoleServer, stopConsoleServer } from "../src/lib/console/start";
import { appendEvent, projectTarget } from "../src/lib/console/journal";
import { ulid } from "../src/lib/console/ulid";
import { ConsoleNextBlockSchema, HooksStatusSchema, type InboxDecisionFile } from "../src/types/console";
import { makeRoot, PROJECT, removeRoot } from "./helpers/console-server";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const failedStart = async () => ({ error: "boom: port unavailable" });

/** makeRoot plus what isCheckoutRoot needs: package `agentbros`, `.git`, the console contract and app folders. */
function checkoutRoot(t: TestContext): string {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "agentbros", version: "0.0.0" }));
  mkdirSync(path.join(root, ".git"));
  mkdirSync(path.join(root, "src/types"), { recursive: true });
  writeFileSync(path.join(root, "src/types/console.ts"), "export {};\n");
  mkdirSync(path.join(root, "apps/console"), { recursive: true });
  return root;
}

let sequence = 0;
function decide(root: string, decidedAt: string, overrides: Partial<InboxDecisionFile> = {}): InboxDecisionFile {
  const id = overrides.id ?? `d${String(++sequence).padStart(4, "0")}`;
  const decision: InboxDecisionFile = {
    v: 1,
    id,
    project: PROJECT,
    kind: "gate",
    step: "script",
    title: "Approve the script",
    bindTo: [],
    answer: `Yes, ${id}.`,
    argv: ["pnpm", "film:approve", "--project", PROJECT, "--step", "script", "--answer", `Yes, ${id}.`],
    actor: "user",
    channel: "console",
    status: "applied",
    createdAt: decidedAt,
    decidedAt,
    result: { ok: true, elapsedMs: 3 },
    ...overrides,
  };
  const dir = path.join(root, "public/projects", PROJECT, "pipeline/inbox");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(decision));
  return decision;
}

test("A1: the first call starts a detached server, the second reuses it; the block has a one-use pairing URL, never the token", async (t) => {
  const root = checkoutRoot(t);
  const options = {
    rootDir: root,
    project: PROJECT,
    env: {},
    port: 0,
    version: "wp7-test",
    daemonArgs: ["--no-build"],
  };
  let pid: number | undefined;
  try {
    const first = await consoleNextFields({ ...options, timeoutMs: 15_000 });
    ConsoleNextBlockSchema.parse(first.console);
    HooksStatusSchema.parse(first.hooks);
    assert.equal(first.console.error, undefined, String(first.console.error));
    const PAIR_URL = /^(http:\/\/127\.0\.0\.1:\d+)\/#pair=([a-f0-9]{32})&project=demo-film$/;
    assert.match(first.console.url ?? "", PAIR_URL);
    assert.ok(!JSON.stringify(first).includes("token"), "the session token never appears in the block");
    pid = readLock(root)?.pid;
    assert.ok(pid && pidAlive(pid));
    assert.deepEqual(first.hooks, { claude: "missing", codex: "missing" });

    const t0 = performance.now();
    const second = await consoleNextFields(options);
    const reuseMs = performance.now() - t0;
    const [, origin, code] = PAIR_URL.exec(first.console.url!)!;
    assert.equal(PAIR_URL.exec(second.console.url ?? "")?.[1], origin, "same server");
    assert.notEqual(second.console.url, first.console.url, "a fresh code per answer");
    // A fresh browser opening the link redeems the code once (the page's POST /api/session/pair).
    const redeem = () =>
      fetch(`${origin}/api/session/pair`, {
        method: "POST",
        headers: { Origin: origin!, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
        body: JSON.stringify({ code }),
      });
    const paired = await redeem();
    assert.equal(paired.status, 200);
    assert.match(((await paired.json()) as { token: string }).token, /^[a-f0-9]{64}$/);
    assert.equal((await redeem()).status, 403, "single use");
    assert.equal(readLock(root)?.pid, pid, "the live server is reused, not restarted");
    if (reuseMs > 500) process.stderr.write(`[console-next] warning: reuse took ${Math.round(reuseMs)} ms\n`);
  } finally {
    await stopConsoleServer({ rootDir: root });
    if (pid && pidAlive(pid)) process.kill(pid, "SIGKILL");
  }
  assert.ok(pid && !pidAlive(pid), "no server process remains");
});

test("AGENTBROS_CONSOLE=off starts nothing and writes nothing", async (t) => {
  const root = checkoutRoot(t);
  decide(root, "2026-11-17T10:00:00.000Z");
  const fields = await consoleNextFields({ rootDir: root, project: PROJECT, env: { AGENTBROS_CONSOLE: "off" } });
  assert.match(fields.console.error ?? "", /AGENTBROS_CONSOLE=off/);
  assert.equal(fields.console.url, undefined);
  assert.deepEqual(fields.console.appliedSince, []);
  assert.equal(readLock(root), undefined);
  assert.equal(existsSync(path.join(root, "out/console/session.json")), false);
  assert.equal(existsSync(path.join(root, NEXT_CURSOR_DIR)), false);
});

test("a failed or throwing start is console.error; pending still counts the waiting cards", async (t) => {
  const root = checkoutRoot(t);
  const cards = path.join(root, "public/projects", PROJECT, "pipeline/cards");
  mkdirSync(cards, { recursive: true });
  writeFileSync(
    path.join(cards, "q1.json"),
    JSON.stringify({
      v: 1,
      id: "q1",
      project: PROJECT,
      kind: "question",
      title: "Which hook?",
      from: { agent: "script-writer" },
      expectsAnswer: true,
      createdAt: new Date().toISOString(),
    }),
  );
  const failed = await consoleNextFields({ rootDir: root, project: PROJECT, env: {}, start: failedStart });
  assert.equal(failed.console.error, "boom: port unavailable");
  assert.equal(failed.console.url, undefined);
  assert.equal(failed.console.pending, 1);
  const thrown = await consoleNextFields({
    rootDir: root,
    project: PROJECT,
    env: {},
    start: async () => {
      throw new Error("spawn EACCES");
    },
  });
  assert.equal(thrown.console.error, "spawn EACCES");
});

test("a reachable older console still offers a project pairing link", async (t) => {
  const root = checkoutRoot(t);
  const fields = await consoleNextFields({
    rootDir: root,
    project: PROJECT,
    env: {},
    start: async () => ({ error: "Another version is running", existingBaseUrl: "http://127.0.0.1:4317/" }),
  });
  assert.equal(fields.console.error, "Another version is running");
  assert.match(fields.console.url ?? "", /^http:\/\/127\.0\.0\.1:4317\/#pair=[a-f0-9]{32}&project=demo-film$/);
});

test("appliedSince: the first answer shows the last few, then only what was decided since, ties included", (t) => {
  const root = checkoutRoot(t);
  const base = Date.parse("2026-11-17T10:00:00.000Z");
  const at = (minutes: number) => new Date(base + minutes * 60_000).toISOString();
  const decided = [1, 2, 3, 4, 5].map((minute) => decide(root, at(minute)));
  decide(root, at(6), { id: "old-superseded", status: "superseded" });
  writeFileSync(path.join(root, "public/projects", PROJECT, "pipeline/inbox/torn.json"), "{");

  const first = takeAppliedSince(root, PROJECT).decisions;
  assert.deepEqual(
    first.map((decision) => decision.id),
    decided.slice(-APPLIED_SINCE_FIRST).map((decision) => decision.id),
  );
  assert.deepEqual(takeAppliedSince(root, PROJECT).decisions, [], "nothing new since the last answer");

  const refused = decide(root, at(7), {
    status: "refused",
    result: { ok: false, error: "VALIDATION", message: "stale" },
  });
  const tie = decide(root, at(7));
  assert.deepEqual(
    takeAppliedSince(root, PROJECT).decisions.map((decision) => [decision.id, decision.status]),
    [
      [refused.id, "refused"],
      [tie.id, "applied"],
    ],
  );
  const late = decide(root, at(7));
  assert.deepEqual(
    takeAppliedSince(root, PROJECT).decisions.map((decision) => decision.id),
    [late.id],
    "a decision with the same time as the cursor but not yet told is reported",
  );

  for (let minute = 10; minute < 10 + APPLIED_SINCE_MAX + 5; minute++) decide(root, at(minute));
  const bounded = takeAppliedSince(root, PROJECT);
  assert.equal(bounded.decisions.length, APPLIED_SINCE_MAX, "bounded per answer");
  assert.equal(bounded.truncated, 5, "and says how many were left out");
});

test("appliedSince in the block: decided once, reported once", async (t) => {
  const root = checkoutRoot(t);
  const decision = decide(root, new Date().toISOString());
  const first = await consoleNextFields({ rootDir: root, project: PROJECT, env: {}, start: failedStart });
  assert.deepEqual(
    first.console.appliedSince.map((item) => [item.id, item.answer]),
    [[decision.id, decision.answer]],
  );
  const second = await consoleNextFields({ rootDir: root, project: PROJECT, env: {}, start: failedStart });
  assert.deepEqual(second.console.appliedSince, []);
});

function cli(cwd: string, script: string, args: string[], env: NodeJS.ProcessEnv) {
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_HOOKS: "off", ...env },
  });
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `${script}: one JSON line\n${run.stdout}\n${run.stderr}`);
  return { status: run.status, envelope: JSON.parse(lines[0]!) as Record<string, any> };
}

test("project creation and next-step commands carry console and hooks even if a start is refused", (t) => {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "console-next-cli-")));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(path.join(cwd, "public/projects"), { recursive: true });
  const project = ["--project", "film-c"];
  // Off (as every test suite runs) and on: here the start is refused (node:test, not a checkout), so console.error.
  for (const [script, args, setting] of [
    ["scripts/create-project.ts", ["template-c"], ""],
    ["scripts/film-init.ts", [...project, "--type", "motion-graphics"], "off"],
    ["scripts/film-next.ts", project, "off"],
    ["scripts/next.ts", project, "off"],
    ["scripts/film-next.ts", project, ""],
    ["scripts/next.ts", project, ""],
  ] as const) {
    const { status, envelope } = cli(cwd, script, [...args], { AGENTBROS_CONSOLE: setting });
    assert.equal(status, 0, JSON.stringify(envelope));
    assert.equal(envelope.ok, true);
    const block = ConsoleNextBlockSchema.parse(envelope.metadata.console);
    assert.equal(block.url, undefined);
    assert.match(block.error ?? "", setting === "off" ? /AGENTBROS_CONSOLE=off/ : /node:test|checkout root/);
    assert.deepEqual(HooksStatusSchema.parse(envelope.metadata.hooks), { claude: "missing", codex: "missing" });
  }
  assert.equal(existsSync(path.join(cwd, "out/console/server.json")), false, "no server was started");
});

// --- Review fixes (2026-11-17) ---------------------------------------------------------------------------------------

test("review: a next-step caller never kills a busy or other-version daemon, and stays within its deadline", async (t) => {
  const root = checkoutRoot(t);
  const started = await startOrReuseConsoleServer({
    rootDir: root,
    port: 0,
    version: "v1",
    daemonArgs: ["--no-build"],
  });
  assert.ok(!("error" in started), "error" in started ? started.error : "");
  const pid = started.pid;
  try {
    // Another version: left running, reported.
    const other = await ensureConsoleServer({ rootDir: root, env: {}, port: 0, version: "v2", timeoutMs: 4000 });
    assert.ok("error" in other && /another version \(v1\)/.test(other.error), JSON.stringify(other));
    assert.ok(pidAlive(pid), "the other-version daemon still runs");
    // Busy (stopped, so its health never answers): left running, reported within the deadline.
    process.kill(pid, "SIGSTOP");
    const t0 = performance.now();
    const busy = await ensureConsoleServer({ rootDir: root, env: {}, port: 0, version: "v1", timeoutMs: 3000 });
    const ms = performance.now() - t0;
    process.kill(pid, "SIGCONT");
    assert.ok("error" in busy && /busy/.test(busy.error), JSON.stringify(busy));
    assert.ok(ms < 4000, `one deadline for the whole call: ${Math.round(ms)} ms`);
    assert.ok(pidAlive(pid), "the busy daemon still runs");
    assert.equal(readLock(root)?.pid, pid);
  } finally {
    try {
      process.kill(pid, "SIGCONT");
    } catch {
      // gone
    }
    await stopConsoleServer({ rootDir: root });
    if (pidAlive(pid)) process.kill(pid, "SIGKILL");
  }
  assert.equal(pidAlive(pid), false, "no server process remains");
});

const cliEnd = (alias: string) => ({
  v: 1 as const,
  id: ulid(),
  at: new Date().toISOString(),
  project: PROJECT,
  kind: "cli.end" as const,
  runId: ulid(),
  alias,
  ok: true,
  elapsedMs: 5,
});

test("review: the block carries lastEventId (the journal's newest id) and truncated", async (t) => {
  const root = checkoutRoot(t);
  const target = projectTarget(root, PROJECT)!;
  const end = cliEnd("next");
  assert.ok(appendEvent(target, end));
  const base = Date.now() - 60_000;
  for (let index = 0; index < 4; index++) decide(root, new Date(base + index).toISOString());
  const fields = await consoleNextFields({ rootDir: root, project: PROJECT, env: {}, start: failedStart });
  assert.equal(fields.console.lastEventId, end.id);
  assert.equal(fields.console.truncated, undefined, "the first answer shows the last few, nothing truncated");
  for (let index = 0; index < 13; index++) decide(root, new Date(base + 1000 + index).toISOString());
  const again = await consoleNextFields({ rootDir: root, project: PROJECT, env: {}, start: failedStart });
  assert.equal(again.console.appliedSince.length, 10);
  assert.equal(again.console.truncated, 3);
  ConsoleNextBlockSchema.parse(again.console);
});

test("review: the cursor never moves backwards, and an agent's cursor is its own", async (t) => {
  const root = checkoutRoot(t);
  const file = cursorFile(root, PROJECT);
  const later = { v: 1 as const, project: PROJECT, decidedAtMs: 2000, ids: ["b"], updatedAt: new Date().toISOString() };
  writeCursor(file, later);
  writeCursor(file, { ...later, decidedAtMs: 1000, ids: ["a"] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).decidedAtMs, 2000, "an older write does not win");
  writeCursor(file, { ...later, ids: ["c"] });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).ids.sort(), ["b", "c"], "ties merge their ids");

  const decision = decide(root, new Date().toISOString(), { id: "agent-split" });
  const leaf = await consoleNextFields({
    rootDir: root,
    project: PROJECT,
    env: { AGENTBROS_AGENT: "footage-editor" },
    start: failedStart,
  });
  assert.ok(leaf.console.appliedSince.some((item) => item.id === decision.id));
  const orchestrator = await consoleNextFields({ rootDir: root, project: PROJECT, env: {}, start: failedStart });
  assert.ok(
    orchestrator.console.appliedSince.some((item) => item.id === decision.id),
    "the leaf agent's answer did not consume the orchestrator's",
  );
  assert.ok(existsSync(cursorFile(root, PROJECT, "footage-editor")));
});
