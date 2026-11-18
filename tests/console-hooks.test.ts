/**
 * Harness hooks (RFC 0004 §7.1): payload adapter per fixture, fail-open, kill switches, observe and surface journal
 * lines, orient (context size, dedupe, own agents only), relay, and the timing benchmark of synchronous roles.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ConsoleEventSchema, HookCursorSchema } from "../src/types/console";
// @ts-expect-error plain Node hook without types
import { ADAPTER_VERSION, childAgentId, normalise } from "../scripts/hooks/lib/payload.mjs";
import { CODEX_AGENT_MATCHER, hookEntries } from "../src/lib/harness/hooks";
import { FIXTURES, fixture, hookEnv, PROJECT, runHook, spawnHook, workspace } from "./helpers/console-hooks";

const fixtures = (harness: "claude" | "codex") =>
  readdirSync(path.join(FIXTURES, harness))
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -5));

const EXPECT: Record<string, Record<string, unknown>> = {
  "claude/SessionStart-startup": { event: "SessionStart", source: "startup" },
  "claude/SessionStart-compact": { event: "SessionStart", source: "compact" },
  "claude/UserPromptSubmit": { event: "UserPromptSubmit", prompt: "Carry on with the film." },
  "claude/PreToolUse-Bash": {
    event: "PreToolUse",
    tool: { kind: "shell", command: "pnpm film:measure --project demo-film" },
  },
  "claude/PostToolUse-Agent": { event: "PostToolUse", tool: { kind: "agent", subagentType: "fixer" } },
  "claude/PostToolUseFailure-Bash": { event: "PostToolUseFailure", tool: { kind: "shell", isInterrupt: false } },
  "claude/SubagentStart": { event: "SubagentStart", agentId: "agent-def456", agentType: "fixer" },
  "claude/SubagentStart-Explore": { event: "SubagentStart", agentType: "Explore" },
  "claude/SubagentStop": { event: "SubagentStop", agentId: "agent-def456", stopHookActive: false },
  "claude/Stop": { event: "Stop", stopHookActive: false },
  "claude/Stop-active": { event: "Stop", stopHookActive: true },
  "claude/StopFailure": { event: "StopFailure", failure: { type: "rate_limit" } },
  "claude/Notification-permission": { event: "Notification", notification: { type: "permission_prompt" } },
  "claude/Notification-idle": { event: "Notification", notification: { type: "idle_prompt" } },
  "claude/SessionEnd": { event: "SessionEnd", reason: "prompt_input_exit" },
  "codex/SessionStart": { event: "SessionStart", source: "startup", harness: "codex" },
  "codex/UserPromptSubmit": { event: "UserPromptSubmit", turnId: "turn_7" },
  "codex/PreToolUse-Bash": {
    event: "PreToolUse",
    tool: { kind: "shell", command: "pnpm film:measure --project demo-film" },
  },
  "codex/PreToolUse-exec-argv": {
    event: "PreToolUse",
    tool: { kind: "shell", command: "pnpm generate:model --project demo-film" },
  },
  "codex/PreToolUse-apply_patch": {
    event: "PreToolUse",
    tool: { kind: "patch", name: "apply_patch" },
  },
  "codex/PostToolUse-spawn_agent": { event: "PostToolUse", tool: { kind: "agent", subagentType: "fixer" } },
  "codex/SubagentStart": { event: "SubagentStart", agentId: "agent_9", agentType: "fixer" },
  "codex/SubagentStop": { event: "SubagentStop", agentId: "agent_9" },
  "codex/Stop": { event: "Stop", stopHookActive: false },
  "codex/Interrupt": { event: "Interrupt", turnId: "turn_8" },
  "codex/SessionEnd": { event: "SessionEnd", reason: "other" },
};

const subset = (actual: Record<string, unknown>, expected: Record<string, unknown>, at: string) => {
  for (const [key, value] of Object.entries(expected)) {
    if (value && typeof value === "object")
      subset(actual[key] as Record<string, unknown>, value as Record<string, unknown>, `${at}.${key}`);
    else assert.equal(actual?.[key], value, `${at}.${key}`);
  }
};

test("adapter: every fixture normalises to its event and fields; each names its provenance and source", () => {
  for (const harness of ["claude", "codex"] as const)
    for (const name of fixtures(harness)) {
      const file = fixture(harness, name);
      // documented: every field from the harness's own docs (or source); recorded: from a live session; synthetic: not
      // documented, kept for robustness.
      assert.ok(["documented", "recorded", "synthetic"].includes(file.provenance), `${harness}/${name} provenance`);
      assert.match(file.source, /^https:\/\//, `${harness}/${name} names its source`);
      assert.match(file.checked, /^\d{4}-\d{2}-\d{2}$/, `${harness}/${name} names the day it was checked`);
      const normal = normalise(harness, file.payload);
      assert.equal(normal.adapter, ADAPTER_VERSION);
      assert.equal(normal.harness, harness === "claude" ? "claude-code" : "codex");
      assert.ok(normal.sessionId, `${harness}/${name} session`);
      const expected = EXPECT[`${harness}/${name}`];
      assert.ok(expected, `an expectation for ${harness}/${name}`);
      subset(normal, expected, `${harness}/${name}`);
    }
  // Every event the installer uses has a fixture in its harness.
  const events = (harness: "claude" | "codex") =>
    new Set(fixtures(harness).map((name) => fixture(harness, name).payload.hook_event_name));
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "StopFailure",
    "Notification",
    "SessionEnd",
  ])
    assert.ok(events("claude").has(event), `claude fixture for ${event}`);
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SubagentStart",
    "SubagentStop",
    "Stop",
    "Interrupt",
    "SessionEnd",
  ])
    assert.ok(events("codex").has(event), `codex fixture for ${event}`);
  // Unknown fields are ignored; no event name, no payload.
  assert.equal(normalise("claude", { session_id: "s" }), undefined);
  assert.equal(normalise("claude", null), undefined);
  assert.equal(normalise("toString", { hook_event_name: "Stop" }), undefined);
  assert.equal(normalise("claude", { hook_event_name: "Stop", extra: { deep: [1] } }).event, "Stop");
});

/** Codex's matcher (codex-rs/hooks/src/engine/matcher.rs): `*`/empty all, `[A-Za-z0-9_|]` exact alternatives, else regex. */
const codexMatches = (pattern: string, inputs: string[]) =>
  pattern === "" || pattern === "*"
    ? true
    : /^[A-Za-z0-9_|]+$/.test(pattern)
      ? inputs.some((input) => pattern.split("|").includes(input))
      : inputs.some((input) => new RegExp(pattern).test(input));

test("Codex subagent link: the matcher selects spawn_agent (canonical name, alias Agent, namespaced), nothing else", () => {
  const post = hookEntries("codex").PostToolUse!.filter((group) =>
    group.hooks.some((hook) => hook.command.endsWith(" codex observe")),
  );
  assert.deepEqual(
    post.map((group) => group.matcher),
    [CODEX_AGENT_MATCHER],
  );
  // Codex matches the canonical tool_name first, then its aliases (hook_names.rs: spawn_agent carries alias Agent).
  assert.ok(codexMatches(CODEX_AGENT_MATCHER, ["spawn_agent", "Agent"]));
  assert.ok(codexMatches(CODEX_AGENT_MATCHER, ["spawn_agent"]), "a build without the alias");
  assert.ok(codexMatches(CODEX_AGENT_MATCHER, ["multi_agent_v2spawn_agent"]), "a namespaced spawn tool");
  for (const other of [
    "Bash",
    "apply_patch",
    "Write",
    "Edit",
    "wait_agent",
    "spawn_agent_status",
    "mcp__x__spawn_agent2",
  ])
    assert.ok(!codexMatches(CODEX_AGENT_MATCHER, [other]), other);
  // The payload keeps the canonical name; the adapter reads it, and the namespaced form, as the agent tool.
  assert.equal(normalise("codex", { hook_event_name: "PostToolUse", tool_name: "spawn_agent" }).tool.kind, "agent");
  assert.equal(
    normalise("codex", { hook_event_name: "PostToolUse", tool_name: "multi_agent_v2spawn_agent" }).tool.kind,
    "agent",
  );
  assert.equal(normalise("codex", { hook_event_name: "PostToolUse", tool_name: "wait_agent" }).tool.kind, "other");
  assert.equal(
    normalise("codex", { hook_event_name: "PostToolUse", tool_name: "mcp__x__spawn_agent" }).tool.kind,
    "other",
    "an MCP tool is never a subagent link",
  );
  assert.doesNotMatch(CODEX_AGENT_MATCHER, /\(\?[=!<]/, "Rust regex has no lookaround");
});

test("child agent id: Claude Code's object response, Codex's JSON-text response, and nothing from anything else", () => {
  assert.equal(childAgentId({ response: { agentId: "a1" } }), "a1");
  assert.equal(childAgentId({ response: JSON.stringify({ agent_id: "a2", nickname: null }) }), "a2");
  assert.equal(childAgentId({ response: { agent_id: "a3" } }), "a3");
  assert.equal(childAgentId({ response: JSON.stringify({ task_name: "t", nickname: "n" }) }), undefined, "v2 result");
  assert.equal(childAgentId({ response: "{not json" }), undefined);
  assert.equal(childAgentId({ response: "plain text" }), undefined);
  assert.equal(childAgentId({ response: `{"agent_id":"${"x".repeat(70_000)}"}` }), undefined, "bounded");
  assert.equal(childAgentId(undefined), undefined);
});

test("fail open: malformed JSON, missing fields, unknown roles, no checkout or project exit 0 with no output", (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const roles = ["observe", "guard", "orient", "relay", "surface", "wake"];
  const inputs = [
    "",
    "{",
    "not json",
    "[]",
    "null",
    JSON.stringify({}),
    JSON.stringify({ hook_event_name: "PreToolUse" }),
    JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash" }),
    JSON.stringify({ hook_event_name: "SessionStart", cwd: 42, session_id: ["x"] }),
    JSON.stringify(ws.payload("claude", "PreToolUse-Bash", { cwd: "/nonexistent/place" })),
    JSON.stringify(ws.payload("claude", "Stop", { session_id: "../../etc" })),
  ];
  for (const role of roles)
    for (const input of inputs) {
      const run = spawnHook("claude", role, input, hookEnv({ AGENTBROS_HOOK_WAKE_MS: "50" }));
      assert.equal(run.status, 0, `${role} ${input.slice(0, 40)}`);
      assert.equal(run.stdout, "", `${role} ${input.slice(0, 40)}`);
    }
  for (const [harness, role] of [
    ["claude", "nope"],
    ["bogus", "guard"],
    ["", ""],
  ]) {
    const run = spawnHook(harness!, role!, JSON.stringify(ws.payload("claude", "PreToolUse-Bash")));
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
  }
  // An oversized payload is ignored.
  const big = JSON.stringify({ ...ws.payload("claude", "SessionStart-startup"), pad: "x".repeat(1_100_000) });
  const oversized = spawnHook("claude", "orient", big);
  assert.equal(oversized.status, 0);
  assert.equal(oversized.stdout, "");
});

test("fail open: unreadable lease, unwritable journal and cursor directories, a project that does not exist", async (t) => {
  const ws = workspace();
  t.after(() => {
    for (const dir of [path.join(ws.dir, "pipeline"), path.join(ws.dir, "pipeline/session"), path.join(ws.root, "out")])
      try {
        chmodSync(dir, 0o755);
      } catch {
        // not created
      }
    ws.cleanup();
  });
  ws.lease();
  const env = hookEnv({ AGENTBROS_STEP_GUARD: "enforce" });
  chmodSync(path.join(ws.dir, "pipeline/session"), 0o000);
  const guard = await runHook("claude", "guard", ws.payload("claude", "PreToolUse-Bash"), { env });
  assert.deepEqual(guard, {}, "an unreadable lease allows (runScript decides)");
  chmodSync(path.join(ws.dir, "pipeline/session"), 0o755);
  chmodSync(path.join(ws.dir, "pipeline"), 0o555);
  mkdirSync(path.join(ws.root, "out"), { recursive: true });
  chmodSync(path.join(ws.root, "out"), 0o555);
  for (const role of ["observe", "orient", "relay", "surface"]) {
    const name =
      role === "relay" ? "UserPromptSubmit" : role === "surface" ? "Notification-idle" : "SessionStart-startup";
    const run = spawnHook("claude", role, JSON.stringify(ws.payload("claude", name)), env);
    assert.equal(run.status, 0, role);
    if (role !== "orient") assert.equal(run.stdout, "", role);
  }
  chmodSync(path.join(ws.dir, "pipeline"), 0o755);
  const missing = await runHook(
    "claude",
    "guard",
    ws.payload("claude", "PreToolUse-Bash", { tool_input: { command: "pnpm film:measure --project no-such-film" } }),
    { env },
  );
  assert.deepEqual(missing, {});
  assert.deepEqual(readdirSync(path.join(ws.root, "public/projects")), [PROJECT], "no project is ever created");
});

test("kill switches: AGENTBROS_HOOKS=off disables every role, observe keeps only observe; AGENTBROS_EVENTS=off writes nothing", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const enforce = { AGENTBROS_STEP_GUARD: "enforce" };
  const denied = (env: NodeJS.ProcessEnv) =>
    runHook("claude", "guard", ws.payload("claude", "PreToolUse-Bash"), { env });
  assert.ok((await denied(hookEnv(enforce))).stdout, "on: the guard denies");
  // The refusal is journaled as runScript journals it (cli.start, cli.end VALIDATION); the switches below add nothing.
  assert.deepEqual(
    ws.events().map((event) => event.kind),
    ["cli.start", "cli.end"],
  );
  assert.deepEqual(await denied(hookEnv({ ...enforce, AGENTBROS_HOOKS: "off" })), {});
  assert.deepEqual(await denied(hookEnv({ ...enforce, AGENTBROS_HOOKS: "observe" })), {});
  const start = ws.payload("claude", "SessionStart-startup");
  assert.deepEqual(await runHook("claude", "orient", start, { env: hookEnv({ AGENTBROS_HOOKS: "observe" }) }), {});
  await runHook("claude", "observe", start, { env: hookEnv({ AGENTBROS_HOOKS: "off" }) });
  assert.equal(ws.events().length, 2);
  await runHook("claude", "observe", start, { env: hookEnv({ AGENTBROS_EVENTS: "off" }) });
  assert.equal(ws.events().length, 2);
  await runHook("claude", "observe", start, { env: hookEnv({ AGENTBROS_HOOKS: "observe" }) });
  assert.equal(ws.events().length, 3);
});

test("observe and surface: one valid ConsoleEvent line per event, durations joined by agent id, both harnesses", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const env = hookEnv();
  const at = (seconds: number) => new Date(T0 + seconds * 1000);
  const steps: [string, string, string, number][] = [
    ["claude", "observe", "SessionStart-startup", 0],
    ["claude", "observe", "SubagentStart", 5],
    ["claude", "observe", "SubagentStop", 65],
    ["claude", "observe", "PostToolUse-Agent", 66],
    ["claude", "observe", "PostToolUseFailure-Bash", 70],
    ["claude", "observe", "StopFailure", 71],
    ["claude", "surface", "Notification-permission", 72],
    ["claude", "observe", "Stop", 80],
    ["claude", "observe", "SessionEnd", 100],
    ["codex", "observe", "SessionStart", 110],
    ["codex", "observe", "PostToolUse-spawn_agent", 111],
    ["codex", "observe", "SubagentStart", 112],
    ["codex", "observe", "SubagentStop", 120],
    ["codex", "observe", "Interrupt", 121],
    ["codex", "observe", "Stop", 122],
    ["codex", "observe", "SessionEnd", 130],
  ];
  for (const [harness, role, name, seconds] of steps)
    assert.deepEqual(
      await runHook(harness, role, ws.payload(harness as "claude" | "codex", name), { env, now: at(seconds) }),
      {},
      `${harness} ${name} prints nothing`,
    );
  const events = ws.events();
  assert.equal(events.length, steps.length);
  for (const event of events) {
    const parsed = ConsoleEventSchema.safeParse(event);
    assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
    assert.equal(event.channel, "hook");
    assert.equal(event.actor, "agent");
    assert.equal(event.step, "material");
    assert.equal(event.project, PROJECT);
  }
  const data = events.map((event) => event.data as Record<string, unknown>);
  assert.equal(events[0]!.kind, "agent.start");
  assert.equal(data[0]!.scope, "session");
  assert.equal(events[2]!.kind, "agent.end");
  assert.equal(data[2]!.durationMs, 60_000, "subagent duration from its agent.start");
  assert.equal(data[3]!.type, "agent-link");
  assert.equal(data[3]!.agentId, "agent-def456");
  assert.equal(data[3]!.parentAgentId, ws.payload("claude", "Stop").session_id);
  assert.equal(data[4]!.type, "tool-failure");
  assert.equal(data[5]!.type, "stop-failure");
  assert.equal(data[6]!.type, "permission-prompt");
  assert.equal(data[7]!.type, "turn-end");
  assert.equal(data[8]!.durationMs, 100_000, "session duration");
  assert.equal(data[10]!.agentId, "agent_9", "Codex spawn_agent links its child");
  assert.equal(data[12]!.durationMs, 8_000);
  assert.equal(data[13]!.type, "interrupt");
  assert.deepEqual(
    events.map((event) => (event.agent as { harness: string }).harness),
    steps.map(([harness]) => (harness === "claude" ? "claude-code" : "codex")),
  );
});

test("observe: a session without a project writes nothing; the project comes from the command, the cursor, the lease or AGENTBROS_PROJECT", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  const env = hookEnv();
  await runHook("claude", "observe", ws.payload("claude", "SessionStart-startup"), { env });
  assert.equal(ws.events().length, 0, "no lease, no command, no variable: no project");
  await runHook("claude", "observe", ws.payload("claude", "SessionStart-startup"), {
    env: hookEnv({ AGENTBROS_PROJECT: PROJECT }),
  });
  assert.equal(ws.events().length, 1);
  await runHook("claude", "observe", ws.payload("claude", "SessionStart-startup"), {
    env: hookEnv({ AGENTBROS_PROJECT: "missing-project" }),
  });
  assert.equal(ws.events().length, 1, "a project that does not exist is never created");
  // The guard remembers the command's project for the session (cursor).
  await runHook("claude", "guard", ws.payload("claude", "PreToolUse-Bash"), { env });
  const cursor = JSON.parse(
    readFileSync(
      path.join(ws.root, "out/console/hooks", `${String(ws.payload("claude", "Stop").session_id)}.json`),
      "utf8",
    ),
  );
  assert.ok(HookCursorSchema.safeParse(cursor).success);
  assert.equal(cursor.project, PROJECT);
  await runHook("claude", "observe", ws.payload("claude", "Stop"), { env });
  assert.equal(ws.events().length, 2, "the cursor's project");
});

/** A whole second near the real clock, so leases issued now are valid at the test's times. */
const T0 = Math.floor(Date.now() / 1000) * 1000;
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const context = (result: { stdout?: Record<string, unknown> }) =>
  (result.stdout?.hookSpecificOutput as { additionalContext?: string } | undefined)?.additionalContext;

test("orient: facts within 1,200 characters, English, prefixed; injected once per change; compact re-injects", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease({ allow: ["next", "film:approve", ...Array.from({ length: 200 }, (_, i) => `tool:${i}`)] });
  const env = hookEnv();
  const first = await runHook("claude", "orient", ws.payload("claude", "SessionStart-startup"), { env });
  const text = context(first)!;
  assert.ok(text.startsWith("Agent Bros. console: project demo-film (film route)."), text);
  assert.ok(text.length <= 1200);
  assert.match(text, /Current step material, owner asset-planner/);
  assert.match(text, /Waiting for the user: an approval at the current step/);
  assert.match(text, /console server is not running/);
  assert.equal((first.stdout!.hookSpecificOutput as { hookEventName: string }).hookEventName, "SessionStart");
  assert.deepEqual(await runHook("claude", "orient", ws.payload("claude", "SessionStart-startup"), { env }), {});
  assert.ok(context(await runHook("claude", "orient", ws.payload("claude", "SessionStart-compact"), { env })));
  // A change (a pause) is injected again.
  writeFileSync(
    path.join(ws.dir, "pipeline/session/control.json"),
    JSON.stringify({
      v: 1,
      state: "paused",
      by: "user",
      channel: "console",
      at: "2026-11-17T10:00:00Z",
      answer: "Hold on.",
      history: [],
    }),
  );
  const paused = context(await runHook("claude", "orient", ws.payload("claude", "SessionStart-startup"), { env }));
  assert.match(paused!, /The user paused this project at 2026-11-17T10:00:00Z \("Hold on\."\)/);
  // The console URL comes from a live server lock.
  mkdirSync(path.join(ws.root, "out/console"), { recursive: true });
  writeFileSync(
    path.join(ws.root, "out/console/server.json"),
    JSON.stringify({ v: 1, pid: process.pid, port: 4317, version: "x", startedAt: "2026-11-17T10:00:00Z" }),
  );
  const live = context(await runHook("codex", "orient", ws.payload("codex", "SessionStart"), { env }));
  assert.match(live!, /Console: http:\/\/127\.0\.0\.1:4317\//);
});

test("orient: own subagents get their lease; built-in and plugin agents get nothing", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const env = hookEnv();
  const own = context(await runHook("claude", "orient", ws.payload("claude", "SubagentStart"), { env }));
  assert.match(own!, /^Agent Bros\. console: project demo-film; you run as fixer\./);
  assert.match(own!, /Step tools: asset:import, generate:model; spending is not authorised/);
  assert.ok(own!.length <= 1200);
  assert.ok(context(await runHook("codex", "orient", ws.payload("codex", "SubagentStart"), { env })));
  for (const agentType of ["Explore", "general-purpose", "Plan", "my-plugin:fixer", ""])
    assert.deepEqual(
      await runHook("claude", "orient", ws.payload("claude", "SubagentStart-Explore", { agent_type: agentType }), {
        env,
      }),
      {},
      agentType,
    );
});

test("relay: decisions, card answers and control changes after the session's cursor, once each, bounded", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const env = hookEnv();
  const prompt = (harness: "claude" | "codex", now: Date) =>
    runHook(harness, "relay", ws.payload(harness, "UserPromptSubmit"), { env, now });
  assert.deepEqual(await prompt("codex", new Date(T0 - 600_000)), {}, "first prompt sets the cursor");
  mkdirSync(path.join(ws.dir, "pipeline/inbox"), { recursive: true });
  mkdirSync(path.join(ws.dir, "pipeline/cards"), { recursive: true });
  const decision = {
    v: 1,
    id: "d-script-1",
    project: PROJECT,
    kind: "approve-gate",
    step: "script",
    title: "Approve script B",
    bindTo: [],
    answer: "Approve script B. Shorter hook please.",
    argv: ["pnpm", "film:approve"],
    status: "applied",
    createdAt: iso(-570),
    decidedAt: iso(-540),
    result: { ok: true },
  };
  writeFileSync(path.join(ws.dir, "pipeline/inbox/d-script-1.json"), JSON.stringify(decision));
  writeFileSync(
    path.join(ws.dir, "pipeline/cards/c-1.json"),
    JSON.stringify({
      v: 1,
      id: "c-1",
      project: PROJECT,
      kind: "choice",
      title: "Which look?",
      from: { agent: "design-director" },
      options: [
        { id: "a", label: "Warm" },
        { id: "b", label: "Cold" },
      ],
      expectsAnswer: true,
      createdAt: iso(-590),
      answer: { choice: "b", text: "Cold, but softer.", at: iso(-480) },
    }),
  );
  const told = context(await prompt("codex", new Date(T0 - 420_000)))!;
  assert.ok(told.startsWith("Agent Bros. console: new in the console for project demo-film:"));
  assert.match(
    told,
    /Decision d-script-1 .* was applied in the console; the user's words: "Approve script B\. Shorter hook please\."/,
  );
  assert.match(told, /Card c-1 \("Which look\?"\) was answered: "Cold" \(b\); the user's words: "Cold, but softer\."/);
  assert.deepEqual(await prompt("codex", new Date(T0 - 400_000)), {}, "told once");
  // Many items stay within the bound.
  for (let i = 0; i < 40; i++)
    writeFileSync(
      path.join(ws.dir, `pipeline/inbox/d-${i}.json`),
      JSON.stringify({ ...decision, id: `d-${i}`, answer: "x".repeat(400), decidedAt: iso(-300 + i) }),
    );
  // Decided items are files written when decided: the cursor skips files older than its watermark.
  const many = context(await prompt("codex", new Date(T0 - 200_000)))!;
  assert.ok(many.length <= 1200, String(many.length));
  assert.match(many, /more not shown/);
  // Review 8: hidden items are told on the next prompts, each exactly once.
  const toldIds = new Set<string>();
  let text: string | undefined = many;
  for (let round = 0; text && round < 20; round++) {
    for (const match of text.matchAll(/Decision (d-\d+) /g)) {
      assert.ok(!toldIds.has(match[1]!), `${match[1]} told once`);
      toldIds.add(match[1]!);
    }
    text = context(await prompt("codex", new Date(T0 - 100_000 + round)));
  }
  assert.equal(toldIds.size, 40, "no hidden item is lost");
});

test("timing: synchronous roles finish quickly (warn above 150 ms)", (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const env = hookEnv({ AGENTBROS_STEP_GUARD: "enforce" });
  const cases: [string, string][] = [
    ["guard", "PreToolUse-Bash"],
    ["orient", "SessionStart-startup"],
    ["relay", "UserPromptSubmit"],
    ["observe", "SubagentStart"],
  ];
  for (const [role, name] of cases) {
    const input = JSON.stringify(ws.payload("claude", name));
    spawnHook("claude", role, input, env); // warm the file cache
    const runs = Array.from({ length: 3 }, () => spawnHook("claude", role, input, env).ms).sort((a, b) => a - b);
    const median = runs[1]!;
    if (median > 150) t.diagnostic(`warn: ${role} took ${median.toFixed(0)} ms (budget 150 ms)`);
    assert.ok(median < 2500, `${role} stays far below its entry timeout (${median.toFixed(0)} ms)`);
  }
});

test("review 8: items sharing the last shown item's time are not skipped", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const env = hookEnv();
  const prompt = () =>
    runHook("codex", "relay", ws.payload("codex", "UserPromptSubmit"), { env, now: new Date(T0 - 10_000) });
  await runHook("codex", "relay", ws.payload("codex", "UserPromptSubmit"), { env, now: new Date(T0 - 600_000) });
  mkdirSync(path.join(ws.dir, "pipeline/inbox"), { recursive: true });
  for (let i = 0; i < 12; i++)
    writeFileSync(
      path.join(ws.dir, `pipeline/inbox/s-${i}.json`),
      JSON.stringify({
        v: 1,
        id: `s-${i}`,
        project: PROJECT,
        kind: "approve-gate",
        title: "Same time",
        bindTo: [],
        answer: "y".repeat(250),
        argv: ["pnpm", "film:approve"],
        status: "applied",
        createdAt: iso(-500),
        decidedAt: iso(-400),
        result: { ok: true },
      }),
    );
  const seen = new Set<string>();
  for (let round = 0; round < 15; round++) {
    const text = context(await prompt());
    if (!text) break;
    // Told in full, or (a group too large for one message) by id.
    for (const match of text.matchAll(/\b(s-\d+)\b/g)) seen.add(match[1]!);
  }
  assert.equal(seen.size, 12);
});

test("review 9: secrets typed into a command or echoed in an error never reach the journal", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const command = `FAL_KEY=sk-live-SECRET1 OPENAI_API_KEY='SECRET2' pnpm generate:model --project ${PROJECT} --api-key SECRET3 --token=SECRET4`;
  await runHook(
    "claude",
    "observe",
    ws.payload("claude", "PostToolUseFailure-Bash", {
      tool_input: { command },
      error: "401: Authorization: Bearer SECRET5abcdef rejected; FAL_KEY=SECRET6",
    }),
    { env: hookEnv() },
  );
  const line = readFileSync(path.join(ws.dir, "pipeline/events.jsonl"), "utf8");
  assert.ok(line.includes("FAL_KEY=<redacted>"), line);
  for (const secret of ["SECRET1", "SECRET2", "SECRET3", "SECRET4", "SECRET5", "SECRET6"])
    assert.ok(!line.includes(secret), secret);
  assert.ok(ConsoleEventSchema.safeParse(JSON.parse(line)).success);
});
