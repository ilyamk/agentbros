/**
 * The `wake` hook role (RFC 0004 §7.1, A12b): an async + asyncRewake Stop hook in Claude Code that exits 2 with a
 * one-line fact when the user decides in the console, and 0 on timeout, on stop_hook_active, when nothing waits, when
 * the session moved on, and in Codex. Short waits through AGENTBROS_HOOK_WAKE_MS.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HOOK, hookEnv, PROJECT, runHook, workspace, type Workspace } from "./helpers/console-hooks";

const env = (ms = 3000) => hookEnv({ AGENTBROS_HOOK_WAKE_MS: String(ms), AGENTBROS_HOOK_WAKE_POLL_MS: "50" });

const decide = (ws: Workspace, id = "d-1") => {
  mkdirSync(path.join(ws.dir, "pipeline/inbox"), { recursive: true });
  writeFileSync(
    path.join(ws.dir, "pipeline/inbox", `${id}.json`),
    JSON.stringify({
      v: 1,
      id,
      project: PROJECT,
      kind: "approve-gate",
      step: "script",
      title: "Approve script",
      bindTo: [],
      answer: "Approve script B.",
      argv: ["pnpm", "film:approve"],
      status: "applied",
      createdAt: new Date().toISOString(),
      decidedAt: new Date().toISOString(),
      result: { ok: true },
    }),
  );
};

/** A film waiting at a gate: the lease names film:approve. */
const gate = (ws: Workspace) => ws.lease({ allow: ["next", "film:approve"] });

test("wake: a console decision wakes Claude with exit 2 and one line", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  gate(ws);
  const started = Date.now();
  const waiting = runHook("claude", "wake", ws.payload("claude", "Stop"), { env: env() });
  setTimeout(() => decide(ws), 150);
  const result = await waiting;
  assert.equal(result.exit, 2);
  assert.equal(result.stderr!.trim().split("\n").length, 1);
  assert.match(
    result.stderr!,
    /^Agent Bros\. console: new in the console for project demo-film: Decision d-1 .* the user's words: "Approve script B\."/,
  );
  assert.ok(Date.now() - started < 2500, "woke before the timeout");
});

test("wake: a card answer also wakes; a card waiting is reason enough to wait", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  mkdirSync(path.join(ws.dir, "pipeline/cards"), { recursive: true });
  const card = {
    v: 1,
    id: "c-1",
    project: PROJECT,
    kind: "question",
    title: "Which ending?",
    from: { agent: "script-writer" },
    expectsAnswer: true,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(path.join(ws.dir, "pipeline/cards/c-1.json"), JSON.stringify(card));
  const waiting = runHook("claude", "wake", ws.payload("claude", "Stop"), {
    env: hookEnv({ AGENTBROS_PROJECT: PROJECT, AGENTBROS_HOOK_WAKE_MS: "3000", AGENTBROS_HOOK_WAKE_POLL_MS: "50" }),
  });
  setTimeout(
    () =>
      writeFileSync(
        path.join(ws.dir, "pipeline/cards/c-1.json"),
        JSON.stringify({ ...card, answer: { text: "The quiet one.", at: new Date().toISOString() } }),
      ),
    150,
  );
  const result = await waiting;
  assert.equal(result.exit, 2);
  assert.match(result.stderr!, /Card c-1 \("Which ending\?"\) was answered; the user's words: "The quiet one\."/);
});

test("wake: exits 0 on timeout, on stop_hook_active, with nothing waiting, in Codex and when the session moves on", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  assert.deepEqual(
    await runHook("claude", "wake", ws.payload("claude", "Stop"), { env: env() }),
    { exit: 0 },
    "nothing waits",
  );
  gate(ws);
  let started = Date.now();
  assert.deepEqual(await runHook("claude", "wake", ws.payload("claude", "Stop-active"), { env: env() }), { exit: 0 });
  assert.ok(Date.now() - started < 500, "stop_hook_active returns at once");
  assert.deepEqual(
    await runHook("codex", "wake", ws.payload("codex", "Stop"), { env: env() }),
    { exit: 0 },
    "Codex cannot rewake",
  );
  started = Date.now();
  assert.deepEqual(await runHook("claude", "wake", ws.payload("claude", "Stop"), { env: env(300) }), { exit: 0 });
  assert.ok(Date.now() - started >= 280, "waited until the timeout");
  // The user typed instead: relay touches the session's cursor and the waiting hook leaves quietly.
  const waiting = runHook("claude", "wake", ws.payload("claude", "Stop"), { env: env(5000) });
  setTimeout(() => void runHook("claude", "relay", ws.payload("claude", "UserPromptSubmit"), { env: env() }), 150);
  started = Date.now();
  assert.deepEqual(await waiting, { exit: 0 });
  assert.ok(Date.now() - started < 3000, "left when the session moved on");
  // A decision after the session moved on is told by relay on the next prompt.
  await new Promise((resolve) => setTimeout(resolve, 20));
  decide(ws, "d-2");
  const relayed = await runHook("claude", "relay", ws.payload("claude", "UserPromptSubmit"), { env: env() });
  assert.match(JSON.stringify(relayed.stdout), /Decision d-2/);
});

test("wake: the real child process exits 2 with the fact on stderr", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  gate(ws);
  const child = spawn(process.execPath, [HOOK, "claude", "wake"], { env: env(), stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  child.stdin.end(JSON.stringify(ws.payload("claude", "Stop")));
  setTimeout(() => decide(ws), 400);
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));
  assert.equal(code, 2);
  assert.equal(stdout, "");
  assert.match(stderr, /Decision d-1/);
});

test("review 7: an answer given after the session's cursor but before this Stop still wakes, and is told once", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease(); // nothing waits for the user any more: the answer already came
  const prompt = () => runHook("claude", "relay", ws.payload("claude", "UserPromptSubmit"), { env: env() });
  assert.deepEqual(await prompt(), {}, "the first prompt sets the cursor");
  await new Promise((resolve) => setTimeout(resolve, 20));
  decide(ws, "d-early");
  const started = Date.now();
  const result = await runHook("claude", "wake", ws.payload("claude", "Stop"), { env: env() });
  assert.equal(result.exit, 2);
  assert.match(result.stderr!, /Decision d-early/);
  assert.ok(Date.now() - started < 1000, "at once");
  assert.deepEqual(await prompt(), {}, "relay does not repeat it");
});
