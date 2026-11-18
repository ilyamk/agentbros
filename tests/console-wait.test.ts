/**
 * `console:wait` (RFC 0004 D11, §8, WP7b, A7, A11): wakes on a decision applied or refused, a control change written
 * by the real `console:control`, and a card answer, each as the journal writers record them; `--since` replays what
 * came after an event id; a timeout is `{ok: true, event: "timeout"}`; two waiters both wake; SIGTERM exits at once.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { appendEvent, projectTarget, recordEvent, type EventInput } from "../src/lib/console/journal";
import { readEventsAfter } from "../src/lib/console/events-reader";
import { ulid } from "../src/lib/console/ulid";
import { outcomeOf, waitForConsole } from "../src/lib/console/wait";
import { ConsoleEventSchema, type ConsoleEvent } from "../src/types/console";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const PROJECT = "demo-film";
const ON = { AGENTBROS_EVENTS: "on" };

function workspace(t: TestContext): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-wait-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/projects", PROJECT, "pipeline"), { recursive: true });
  writeFileSync(path.join(root, "public/projects", PROJECT, "project.json"), JSON.stringify({ title: "Demo" }));
  return root;
}

const journal = (root: string): ConsoleEvent[] =>
  readFileSync(path.join(root, "public/projects", PROJECT, "pipeline/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => ConsoleEventSchema.parse(JSON.parse(line)));

/** Writes an event as the console's writers do and returns it. */
function record(root: string, input: Omit<EventInput, "project">): ConsoleEvent {
  assert.ok(recordEvent(projectTarget(root, PROJECT), { project: PROJECT, ...input }, { env: ON }));
  return journal(root).at(-1)!;
}

const applied = (root: string, answer = "B, but shorter hook") =>
  record(root, {
    kind: "decision.applied",
    step: "script",
    actor: "user",
    channel: "console",
    data: { decisionId: "dec-script-1", decisionKind: "gate", answer, choice: "b" },
  });

const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  AGENTBROS_NO_DOTENV: "1",
  AGENTBROS_EVENTS: "off",
  AGENTBROS_CONSOLE: "off",
  AGENTBROS_HOOKS: "off",
  AGENTBROS_STEP_ADMITTED: "",
  ...extra,
});

function waiter(root: string, args: string[]): { child: ChildProcess; done: Promise<Record<string, any>> } {
  const child = spawn(
    process.execPath,
    [TSX, path.join(REPO, "scripts/console-wait.ts"), "--project", PROJECT, ...args],
    {
      cwd: root,
      env: env(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk));
  const done = new Promise<Record<string, any>>((resolve, reject) => {
    const kill = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("console:wait did not exit"));
    }, 30_000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      const lines = stdout.trim().split("\n");
      try {
        assert.equal(lines.length, 1, `one JSON line: ${stdout}`);
        resolve({ code, ...JSON.parse(lines[0]!) });
      } catch (error) {
        reject(error);
      }
    });
  });
  return { child, done };
}

/** Resolves once the waiter says it is waiting (its tail cursor is set). */
const ready = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk;
      if (stderr.includes("console:wait: waiting")) resolve();
    });
  });

test("outcomeOf maps the four kinds and ignores everything else", () => {
  const base = { v: 1 as const, id: "01JC0000000000000000000000", at: "2026-11-17T10:00:00.000Z", project: PROJECT };
  assert.equal(
    outcomeOf({ ...base, kind: "card.posted", data: { cardId: "c1", cardKind: "question" } }, PROJECT),
    undefined,
  );
  assert.equal(
    outcomeOf({ ...base, project: "other", kind: "control.changed", data: { state: "paused" } }, PROJECT),
    undefined,
  );
  assert.deepEqual(
    outcomeOf({ ...base, kind: "card.answered", data: { cardId: "c1", choice: "a", text: "A, warmer" } }, PROJECT),
    { event: "card.answered", eventId: base.id, at: base.at, answer: "A, warmer", cardId: "c1", choice: "a" },
  );
  assert.deepEqual(
    outcomeOf(
      {
        ...base,
        kind: "decision.refused",
        step: "script",
        message: "stale",
        data: { decisionId: "d1", decisionKind: "gate", answer: "Yes" },
      },
      PROJECT,
    ),
    {
      event: "decision.refused",
      eventId: base.id,
      at: base.at,
      step: "script",
      answer: "Yes",
      decisionId: "d1",
      decisionKind: "gate",
      message: "stale",
    },
  );
});

test("in process: wakes on an event after the start, never on one before it", async (t) => {
  const root = workspace(t);
  applied(root, "An earlier answer");
  const waiting = waitForConsole({ rootDir: root, project: PROJECT, timeoutMs: 10_000, pollMs: 50 });
  record(root, { kind: "card.posted", data: { cardId: "c1", cardKind: "question" } });
  const event = applied(root);
  const outcome = await waiting;
  assert.equal(outcome.event, "decision.applied");
  assert.equal(outcome.eventId, event.id);
  assert.equal(outcome.answer, "B, but shorter hook");
  assert.equal(outcome.step, "script");
  assert.equal(outcome.choice, "b");
});

test("in process: a journal created after the start, abort and timeout", async (t) => {
  const root = workspace(t);
  const waiting = waitForConsole({ rootDir: root, project: PROJECT, timeoutMs: 10_000, pollMs: 50 });
  record(root, { kind: "control.changed", data: { state: "paused", previous: "running", answer: "Hold on." } });
  assert.deepEqual(
    [(await waiting).event, (await waiting).state, (await waiting).answer],
    ["control.changed", "paused", "Hold on."],
  );
  const controller = new AbortController();
  const aborted = waitForConsole({ rootDir: root, project: PROJECT, timeoutMs: 10_000, signal: controller.signal });
  controller.abort();
  assert.equal((await aborted).event, "interrupted");
  const t0 = performance.now();
  assert.equal((await waitForConsole({ rootDir: root, project: PROJECT, timeoutMs: 100 })).event, "timeout");
  assert.ok(performance.now() - t0 < 2000);
});

test("CLI: --since replays a decision, a card answer and a real console:control pause", async (t) => {
  const root = workspace(t);
  const mark = record(root, { kind: "card.posted", data: { cardId: "c1", cardKind: "choice" } });
  const decision = applied(root);
  const first = await waiter(root, ["--since", mark.id]).done;
  assert.equal(first.code, 0);
  assert.equal(first.ok, true);
  assert.deepEqual(
    [
      first.metadata.event,
      first.metadata.step,
      first.metadata.decisionId,
      first.metadata.answer,
      first.metadata.eventId,
    ],
    ["decision.applied", "script", "dec-script-1", "B, but shorter hook", decision.id],
  );

  const card = record(root, {
    kind: "card.answered",
    actor: "user",
    channel: "console",
    data: { cardId: "c1", choice: "a" },
  });
  const second = await waiter(root, ["--since", decision.id]).done;
  assert.deepEqual(
    [second.metadata.event, second.metadata.cardId, second.metadata.choice, second.metadata.eventId],
    ["card.answered", "c1", "a", card.id],
  );

  const run = spawnSync(
    process.execPath,
    [
      TSX,
      path.join(REPO, "scripts/console-control.ts"),
      "--project",
      PROJECT,
      "--state",
      "paused",
      "--answer",
      "Pause, please.",
    ],
    { cwd: root, encoding: "utf8", env: env({ ...ON, AGENTBROS_CHANNEL: "console", AGENTBROS_ACTOR: "user" }) },
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  // Paused: console:wait is a control alias and still runs.
  const third = await waiter(root, ["--since", card.id]).done;
  assert.equal(third.code, 0, JSON.stringify(third));
  assert.deepEqual(
    [third.metadata.event, third.metadata.state, third.metadata.answer],
    ["control.changed", "paused", "Pause, please."],
  );
});

test("CLI: two waiters both wake on one decision; the timeout is ok with event timeout; SIGTERM exits at once", async (t) => {
  const root = workspace(t);
  const one = waiter(root, ["--timeout-min", "1"]);
  const two = waiter(root, ["--timeout-min", "1"]);
  await Promise.all([ready(one.child), ready(two.child)]);
  const event = applied(root);
  for (const result of await Promise.all([one.done, two.done])) {
    assert.equal(result.code, 0);
    assert.deepEqual([result.metadata.event, result.metadata.eventId], ["decision.applied", event.id]);
  }

  const timeout = await waiter(root, ["--timeout-min", "0.005"]).done;
  assert.deepEqual([timeout.code, timeout.ok, timeout.metadata.event], [0, true, "timeout"]);

  const killed = waiter(root, ["--timeout-min", "5"]);
  await ready(killed.child);
  const t0 = performance.now();
  killed.child.kill("SIGTERM");
  const interrupted = await killed.done;
  assert.ok(performance.now() - t0 < 3000, "exits promptly");
  assert.deepEqual([interrupted.code, interrupted.metadata.event], [0, "interrupted"]);

  const missing = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/console-wait.ts"), "--project", "nope"], {
    cwd: root,
    encoding: "utf8",
    env: env(),
  });
  assert.equal(JSON.parse(missing.stdout.trim()).error, "PROJECT_NOT_FOUND");
  const badSince = spawnSync(
    process.execPath,
    [TSX, path.join(REPO, "scripts/console-wait.ts"), "--project", PROJECT, "--since", "x"],
    { cwd: root, encoding: "utf8", env: env() },
  );
  assert.equal(JSON.parse(badSince.stdout.trim()).error, "INVALID_INPUT");
});

// --- Review fixes (2026-11-17) ---------------------------------------------------------------------------------------

const cliEnd = (alias: string): ConsoleEvent => ({
  v: 1,
  id: ulid(),
  at: new Date().toISOString(),
  project: PROJECT,
  kind: "cli.end",
  runId: ulid(),
  alias,
  ok: true,
  elapsedMs: 5,
});

test("review: without --since, a decision applied between the next answer and the wait is not missed", async (t) => {
  const root = workspace(t);
  const early = applied(root, "Before the answer");
  const end = cliEnd("film:next");
  assert.ok(appendEvent(projectTarget(root, PROJECT)!, end));
  record(root, { kind: "card.posted", data: { cardId: "c1", cardKind: "question" } });
  const late = applied(root, "Between the answer and the wait");
  const result = await waiter(root, ["--timeout-min", "0.2"]).done;
  assert.equal(result.code, 0);
  assert.deepEqual(
    [
      result.metadata.event,
      result.metadata.eventId,
      result.metadata.answer,
      result.metadata.since,
      result.metadata.sinceFrom,
    ],
    ["decision.applied", late.id, "Between the answer and the wait", end.id, "next"],
  );
  assert.notEqual(result.metadata.eventId, early.id);
  // --since the block's lastEventId works the same way.
  const after = await waiter(root, ["--since", end.id]).done;
  assert.equal(after.metadata.eventId, late.id);
});

test("review: a journal missing for a moment during rotation keeps the cursor, then finishes the rotated file", (t) => {
  const root = workspace(t);
  const first = applied(root, "one");
  const file = path.join(root, "public/projects", PROJECT, "pipeline/events.jsonl");
  const start = readEventsAfter(file);
  assert.deepEqual(
    start.events.map((event) => event.id),
    [first.id],
  );
  const missed = applied(root, "two");
  renameSync(file, path.join(path.dirname(file), `events.${ulid()}.1.rotating`));
  const gap = readEventsAfter(file, start.cursor);
  assert.deepEqual([gap.events, gap.reset, gap.cursor], [[], false, start.cursor]);
  const fresh = applied(root, "three");
  const after = readEventsAfter(file, gap.cursor);
  assert.deepEqual(
    after.events.map((event) => event.id),
    [missed.id, fresh.id],
  );
});
