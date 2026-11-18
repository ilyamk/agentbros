/**
 * The `guard` hook role (RFC 0004 §7.1): parity with runScript's step-lease verdicts (checkStep), the pause check,
 * the command table it reads, the shared alias lists and the deprecated claude-step-guard shim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { eventNotice } from "../src/lib/console/notify-rules";
import { ConsoleEventSchema, type ConsoleEvent } from "../src/types/console";
import path from "node:path";
import { checkStep, entriesForScript } from "../src/lib/step-lease/guard";
import { ALWAYS_ADMITTED, CONTROL_ALIASES } from "../src/lib/step-lease/lease";
import { COMMAND_REGISTRY } from "../src/lib/cli/commands";
import {
  HOOK_COMMANDS_FILE,
  hookCommandTable,
  hookCommandTableText,
  reachesGuard,
} from "../src/lib/harness/hook-commands";
import { readLease } from "../src/lib/step-lease/lease";
import { SESSION_FILE } from "../src/types/console";
import { GRANT_AT_ENV, GRANT_ENV } from "../src/lib/console/grant";
import type { StepLease } from "../src/types/step-lease";
// @ts-expect-error plain Node hook without types
import * as guardLib from "../scripts/hooks/lib/guard.mjs";
// @ts-expect-error plain Node hook without types
import * as shim from "../scripts/hooks/claude-step-guard.mjs";
// @ts-expect-error plain Node hook without types
import { normalise } from "../scripts/hooks/lib/payload.mjs";
import { hookEnv, PROJECT, REPO, runHook, spawnHook, workspace, type Workspace } from "./helpers/console-hooks";

test("the hook's alias lists and command table match the lease and the registry", () => {
  assert.deepEqual(guardLib.ALWAYS_ADMITTED, [...ALWAYS_ADMITTED]);
  assert.deepEqual(guardLib.CONTROL_ALIASES, [...CONTROL_ALIASES]);
  assert.deepEqual(shim.ALWAYS_ADMITTED, [...ALWAYS_ADMITTED]);
  const file = path.join(REPO, HOOK_COMMANDS_FILE);
  if (process.env.AGENTBROS_WRITE_HOOK_TABLE === "1") writeFileSync(file, hookCommandTableText());
  assert.equal(
    JSON.stringify(JSON.parse(readFileSync(file, "utf8"))),
    JSON.stringify(hookCommandTable()),
    `${HOOK_COMMANDS_FILE} lags the registry: rerun this test with AGENTBROS_WRITE_HOOK_TABLE=1, then pnpm format`,
  );
});

test("invocations: pnpm aliases and direct scripts, sibling aliases, spend, --project and --dry-run per segment", () => {
  const calls = guardLib.invocations(
    "git status && pnpm run film:measure --project a-b; pnpm generate:image --project=c --dry-run | tee log && npx tsx scripts/python-check.ts --project d && pnpm install && pnpm bogus:thing --project e",
  );
  assert.deepEqual(
    calls.map((call: Record<string, unknown>) => [call.alias, call.project, call.dryRun, call.known]),
    [
      ["film:measure", "a-b", false, true],
      ["generate:image", "c", true, true],
      ["python:check", "d", false, true], // the first registry alias of the script, as runScript names it
      ["bogus:thing", "e", false, false],
    ],
  );
  assert.deepEqual(calls[1].aliases, ["generate:image", "generate:meme"]);
  assert.deepEqual(guardLib.invocations("cd x && pnpm next"), [
    { barrier: true },
    guardLib.invocations("pnpm next")[0],
  ]);
  assert.deepEqual(guardLib.invocations('echo "$(pnpm film:measure --project a)"'), [{ barrier: true }]);
  assert.equal(calls[1].spend, COMMAND_REGISTRY.find((entry) => entry.alias === "generate:image")!.paid);
  assert.equal(
    normalise("codex", {
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: ["bash", "-lc", "pnpm next"] },
    }).tool.command,
    "pnpm next",
  );
});

type Case = {
  name: string;
  command: string;
  env?: NodeJS.ProcessEnv;
  lease?: Partial<StepLease> | "unreadable";
  setup?: (ws: Workspace) => void;
};

const writeJson = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const policy = (autonomy: string) => (ws: Workspace) =>
  writeJson(path.join(ws.dir, "pipeline/policy.json"), {
    schemaVersion: 1,
    projectId: PROJECT,
    revisions: [
      { revision: 1, at: "2026-11-17T09:00:00Z", autonomy, grantedBy: { answer: "go on", at: "2026-11-17T09:00:00Z" } },
    ],
  });

const ENFORCE = { AGENTBROS_STEP_GUARD: "enforce" };
const cmd = (alias: string, extra = "") => `pnpm ${alias} --project ${PROJECT}${extra}`;

const CASES: Case[] = [
  { name: "in step", command: cmd("asset:import"), env: ENFORCE },
  { name: "out of step", command: cmd("film:measure"), env: ENFORCE },
  { name: "out of step, warn", command: cmd("film:measure"), env: { AGENTBROS_STEP_GUARD: "warn" } },
  { name: "out of step, off", command: cmd("film:measure"), env: { AGENTBROS_STEP_GUARD: "off" } },
  { name: "out of step, interactive default", command: cmd("film:measure") },
  { name: "out of step, autonomous policy", command: cmd("film:measure"), setup: policy("autonomous") },
  { name: "out of step, interactive policy", command: cmd("film:measure"), setup: policy("interactive") },
  {
    name: "out of step, benchmark proxy",
    command: cmd("film:measure"),
    setup: (ws) =>
      writeJson(path.join(ws.dir, "pipeline/approvals/script.json"), {
        events: [{ answer: "proxy", at: "2026-11-17T09:00:00Z", proxy: "orchestrator-benchmark" }],
      }),
  },
  {
    name: "out of step, interaction mode",
    command: cmd("film:measure"),
    env: { AGENTBROS_INTERACTION_MODE: "autonomous" },
  },
  { name: "control alias", command: cmd("film:status"), env: ENFORCE },
  { name: "control set in lease", command: cmd("feedback"), env: ENFORCE },
  { name: "paid without authority", command: cmd("generate:model"), env: ENFORCE },
  { name: "paid dry run", command: cmd("generate:model", " --dry-run"), env: ENFORCE },
  { name: "paid with authority", command: cmd("generate:model"), env: ENFORCE, lease: { paidAllowed: true } },
  { name: "paid out of step", command: cmd("generate:video"), env: ENFORCE },
  {
    name: "budget ceiling missing",
    command: cmd("generate:model"),
    env: ENFORCE,
    lease: { route: "footage", paidWhen: "budget-ceiling" },
  },
  {
    name: "budget ceiling present",
    command: cmd("generate:model"),
    env: ENFORCE,
    lease: { route: "footage", paidWhen: "budget-ceiling" },
    setup: (ws) => writeJson(path.join(ws.dir, "pipeline/operations.json"), { policy: { ceilingUsd: 5 } }),
  },
  { name: "expired", command: cmd("asset:import"), env: ENFORCE, lease: { expiresAt: "2026-01-01T00:00:00Z" } },
  {
    name: "stale",
    command: cmd("asset:import"),
    env: ENFORCE,
    setup: (ws) => writeJson(path.join(ws.dir, "pipeline/chain/script.json"), { sealed: true }),
  },
  {
    name: "unlocked out of step",
    command: cmd("film:measure"),
    env: ENFORCE,
    setup: (ws) =>
      writeFileSync(
        path.join(ws.dir, "pipeline/session/unlocks.jsonl"),
        `${JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 600_000).toISOString(), reason: "manual fix" })}\n`,
      ),
  },
  {
    name: "unlock never admits spend",
    command: cmd("generate:video"),
    env: ENFORCE,
    setup: (ws) =>
      writeFileSync(
        path.join(ws.dir, "pipeline/session/unlocks.jsonl"),
        `${JSON.stringify({ at: new Date(Date.now() - 60_000).toISOString(), until: new Date(Date.now() + 600_000).toISOString(), reason: "manual fix" })}\n`,
      ),
  },
  {
    name: "sibling alias allowed",
    command: cmd("python:check"),
    env: ENFORCE,
    lease: { allow: ["next", "python:audit"] },
  },
  { name: "sibling alias not allowed", command: cmd("python:check"), env: ENFORCE },
  { name: "nested admission", command: cmd("film:measure"), env: { ...ENFORCE, AGENTBROS_STEP_ADMITTED: "LEASEHASH" } },
  { name: "footage route", command: cmd("film:measure"), env: ENFORCE, lease: { route: "footage" } },
];

test("guard parity: the hook denies exactly what runScript's checkStep refuses, with the same reason", async (t) => {
  let refusals = 0;
  for (const testCase of CASES) {
    const ws = workspace();
    t.after(ws.cleanup);
    ws.lease(testCase.lease === "unreadable" ? {} : testCase.lease);
    testCase.setup?.(ws);
    const leaseHash = (await import("../src/lib/step-lease/lease")).readLease(ws.dir)!.hash;
    const env = hookEnv(
      Object.fromEntries(
        Object.entries(testCase.env ?? {}).map(([key, value]) => [key, value === "LEASEHASH" ? leaseHash : value]),
      ),
    );
    const call = guardLib.invocations(testCase.command)[0];
    const check = checkStep({
      rootDir: ws.root,
      project: PROJECT,
      entries: entriesForScript(guardLib.commandTable()[call.alias].script),
      dryRun: call.dryRun,
      via: "cli",
      env: { ...env },
      record: "none",
    });
    const result = await runHook(
      "claude",
      "guard",
      ws.payload("claude", "PreToolUse-Bash", { tool_input: { command: testCase.command } }),
      {
        env,
      },
    );
    const reason = (result.stdout?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)
      ?.permissionDecisionReason;
    if (check.verdict === "refuse") {
      refusals += 1;
      assert.equal(reason, check.message, `${testCase.name}: same refusal`);
      assert.equal((result.stdout!.hookSpecificOutput as { permissionDecision: string }).permissionDecision, "deny");
    } else assert.equal(reason, undefined, `${testCase.name}: runScript ${check.verdict}, the hook allows`);
  }
  assert.ok(refusals >= 10, `the matrix exercises refusals (${refusals})`);
});

test("guard: an unreadable lease allows (runScript, the authority, refuses it later)", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  writeFileSync(path.join(ws.dir, "pipeline/session/lease.json"), "{ not json");
  const result = await runHook("codex", "guard", ws.payload("codex", "PreToolUse-Bash"), { env: hookEnv(ENFORCE) });
  assert.deepEqual(result, {});
});

const control = (ws: Workspace, state: string, answer?: string) =>
  writeJson(path.join(ws.dir, "pipeline/session/control.json"), {
    v: 1,
    state,
    by: "user",
    channel: "console",
    at: "2026-11-17T09:00:00Z",
    ...(answer ? { answer } : {}),
    history: [],
  });

test("guard: a paused or stopped project refuses non-control commands at PreToolUse, whatever the step guard says", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  const run = (
    command: string,
    env = hookEnv({ AGENTBROS_STEP_GUARD: "off" }),
    harness: "claude" | "codex" = "claude",
  ) => runHook(harness, "guard", ws.payload(harness, "PreToolUse-Bash", { tool_input: { command } }), { env });
  assert.deepEqual(await run(cmd("render")), {}, "running");
  control(ws, "paused", "Hold on, I am reviewing.");
  const denied = await run(cmd("render"));
  const reason = (denied.stdout!.hookSpecificOutput as { permissionDecisionReason: string }).permissionDecisionReason;
  assert.match(
    reason,
    /^PAUSED: project demo-film is paused by the user since 2026-11-17T09:00:00Z \("Hold on, I am reviewing\."\)/,
  );
  assert.match(reason, /`pnpm render` is not a control command/);
  for (const alias of [
    "next",
    "film:next",
    "console:wait",
    "console:control",
    "console:card",
    "budget",
    "feedback",
    "memory",
  ])
    assert.deepEqual(await run(cmd(alias)), {}, `${alias} is a control command`);
  assert.deepEqual(await run("pnpm render"), {}, "no --project: runScript cannot tell either");
  assert.ok((await run(cmd("render"), hookEnv(), "codex")).stdout, "Codex too");
  control(ws, "stopped");
  assert.match(
    ((await run(cmd("film:measure"))).stdout!.hookSpecificOutput as { permissionDecisionReason: string })
      .permissionDecisionReason,
    /is stopped by the user/,
  );
  control(ws, "running");
  assert.deepEqual(await run(cmd("render")), {});
  // The real child process denies with JSON on stdout and exit 0.
  control(ws, "paused");
  const child = spawnHook(
    "codex",
    "guard",
    JSON.stringify(ws.payload("codex", "PreToolUse-Bash", { tool_input: { command: cmd("render") } })),
  );
  assert.equal(child.status, 0);
  assert.equal(JSON.parse(child.stdout).hookSpecificOutput.permissionDecision, "deny");
});

test("claude-step-guard.mjs is a shim over the guard role", (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  const input = { tool_name: "Bash", tool_input: { command: cmd("film:measure") }, cwd: ws.root };
  assert.match(shim.decide(input, { env: hookEnv(ENFORCE) }).deny, /not a tool of step material/);
  assert.deepEqual(shim.decide(input, { env: hookEnv({ AGENTBROS_STEP_GUARD: "warn" }) }), {});
  const shimFile = path.join(REPO, "scripts/hooks/claude-step-guard.mjs");
  const legacy = spawnSync(process.execPath, [shimFile], {
    input: JSON.stringify({ ...input, hook_event_name: "PreToolUse" }),
    encoding: "utf8",
    env: hookEnv(ENFORCE),
  });
  assert.equal(legacy.status, 0);
  assert.equal(JSON.parse(legacy.stdout).hookSpecificOutput.permissionDecision, "deny");
  const broken = spawnSync(process.execPath, [shimFile], { input: "{", encoding: "utf8", env: hookEnv(ENFORCE) });
  assert.equal(broken.status, 0);
  assert.equal(broken.stdout, "");
});

// --- Regressions from the WP-H review: the guard never denies what runScript admits. ---

const denies = async (ws: Workspace, command: string, env: NodeJS.ProcessEnv = hookEnv(ENFORCE), cwd?: string) => {
  const result = await runHook(
    "claude",
    "guard",
    ws.payload("claude", "PreToolUse-Bash", { tool_input: { command }, ...(cwd ? { cwd } : {}) }),
    {
      env,
    },
  );
  return (result.stdout?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)
    ?.permissionDecisionReason;
};

test("review 1: aliases whose scripts never reach runScript's guard are not judged", async (t) => {
  const table = guardLib.commandTable();
  assert.equal(table["review:ui"].guarded, false);
  assert.equal(table.delivery.guarded, false);
  assert.equal(table["film:measure"].guarded, true);
  for (const [alias, entry] of Object.entries(table) as [string, { script: string; guarded: boolean }][])
    assert.equal(entry.guarded, reachesGuard(entry.script), alias);
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  assert.equal(await denies(ws, cmd("review:ui")), undefined);
  assert.equal(await denies(ws, cmd("delivery", " --action check")), undefined);
  control(ws, "paused");
  assert.equal(await denies(ws, cmd("review:ui")), undefined, "not refused by runScript's pause either");
  assert.match((await denies(ws, cmd("film:measure")))!, /^PAUSED/);
});

test("review 2: --help and -h are never judged (guardStep returns early)", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  assert.equal(await denies(ws, cmd("film:measure", " --help")), undefined);
  assert.equal(await denies(ws, cmd("film:measure", " -h")), undefined);
  assert.ok(await denies(ws, cmd("film:measure")));
});

test("review 3: segments after a control command (unlock, next, budget, console:control) are not judged", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease({ allow: [...CONTROL_ALIASES, "asset:import", "generate:model"] }); // a real lease holds the control set
  for (const command of [
    `pnpm step:unlock --project ${PROJECT} --reason "fix" && ${cmd("film:measure")}`,
    `${cmd("next")} && ${cmd("film:measure")}`,
    `pnpm budget --project ${PROJECT} --ceiling-usd 5 --answer "yes" && ${cmd("generate:video")}`,
    `pnpm console:control --project ${PROJECT} --state running; ${cmd("film:measure")}`,
  ])
    assert.equal(await denies(ws, command), undefined, command);
  assert.ok(
    await denies(ws, `${cmd("film:measure")} && ${cmd("next")}`),
    "a segment before the control command is judged",
  );
});

test("review 4: operators inside quotes do not split; ambiguous lines are allowed; redirections are read", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  for (const command of [
    `git commit -m "a; ${cmd("film:measure")}"`,
    `echo 'x && ${cmd("film:measure")}'`,
    `echo "$(${cmd("film:measure")})"`,
    `(${cmd("film:measure")})`,
    `${cmd("film:measure")} "unterminated`,
    `cat <<EOF\n${cmd("film:measure")}\nEOF`,
  ])
    assert.equal(await denies(ws, command), undefined, command);
  assert.ok(await denies(ws, `${cmd("film:measure")} > out.log 2>&1`));
  assert.ok(await denies(ws, `${cmd("film:measure")} 2>/dev/null | tail -5`));
  assert.ok(await denies(ws, `pnpm film:measure --project "${PROJECT}"`), "quoted values are read");
});

test("review 5: VAR=value prefixes of the segment are honoured", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  assert.equal(await denies(ws, `AGENTBROS_STEP_GUARD=off ${cmd("film:measure")}`), undefined);
  assert.equal(await denies(ws, `env AGENTBROS_STEP_GUARD=warn ${cmd("film:measure")}`), undefined);
  assert.ok(await denies(ws, `AGENTBROS_STEP_GUARD=enforce ${cmd("film:measure")}`, hookEnv()));
  assert.equal(await denies(ws, `export AGENTBROS_STEP_GUARD=off && ${cmd("film:measure")}`), undefined);
  assert.equal(
    await denies(ws, `AGENTBROS_STEP_ADMITTED=${readLease(ws.dir)!.hash} ${cmd("film:measure")}`),
    undefined,
    "a nested admission",
  );
  control(ws, "paused");
  assert.ok(await denies(ws, `AGENTBROS_ACTOR=user ${cmd("render")}`), "setting the attribution is denied");
});

test("review 10: after cd elsewhere, or from a subdirectory for scripts/ paths, nothing is judged", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  assert.equal(await denies(ws, `cd /tmp && ${cmd("film:measure")}`), undefined);
  assert.equal(await denies(ws, `pushd ../other; ${cmd("film:measure")}`), undefined);
  assert.equal(await denies(ws, `pnpm -C ../other film:measure --project ${PROJECT}`), undefined);
  assert.ok(await denies(ws, `npx tsx scripts/film-measure.ts --project ${PROJECT}`));
  mkdirSync(path.join(ws.root, "src"), { recursive: true });
  assert.equal(
    await denies(
      ws,
      `npx tsx scripts/film-measure.ts --project ${PROJECT}`,
      hookEnv(ENFORCE),
      path.join(ws.root, "src"),
    ),
    undefined,
    "a relative script path from a subdirectory is not this checkout's script",
  );
});

// --- A refusal at PreToolUse writes the journal lines runScript writes for it (WP14 notifications). ---

const journal = (ws: Workspace): ConsoleEvent[] => {
  const file = path.join(ws.dir, "pipeline/events.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ConsoleEvent)
    : [];
};

test("refusals: a PAUSED denial appends runScript's cli.start and cli.end, and the notifier picks it up", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  control(ws, "paused", "Hold on.");
  const command = `FAL_KEY=sk-live-1 pnpm render --project ${PROJECT} --api-key sk-secret-2 --token=sk-secret-3`;
  assert.ok(await denies(ws, command, hookEnv()));
  const events = journal(ws);
  assert.deepEqual(
    events.map((event) => event.kind),
    ["cli.start", "cli.end"],
  );
  for (const event of events) assert.ok(ConsoleEventSchema.safeParse(event).success, JSON.stringify(event));
  const [start, end] = events as [ConsoleEvent, ConsoleEvent];
  assert.equal(start.runId, end.runId);
  assert.equal(end.ok, false);
  assert.equal(end.error, "PAUSED");
  assert.equal(end.alias, "render");
  assert.equal(end.project, PROJECT);
  assert.equal(end.channel, "hook");
  assert.equal(end.step, "material");
  assert.match(end.message!, /^PAUSED: project demo-film is paused/);
  assert.deepEqual(start.argv, ["--project", PROJECT, "--api-key", "<redacted>", "--token=<redacted>"]);
  const line = readFileSync(path.join(ws.dir, "pipeline/events.jsonl"), "utf8");
  for (const secret of ["sk-live-1", "sk-secret-2", "sk-secret-3"]) assert.ok(!line.includes(secret), secret);
  const notice = eventNotice(end, { pausedAt: "2026-11-17T09:00:00Z" });
  assert.equal(notice?.key, `paused:${PROJECT}:2026-11-17T09:00:00Z`);
  assert.equal(notice?.kind, "failure");
  // An admitted command writes nothing.
  assert.equal(await denies(ws, cmd("next"), hookEnv()), undefined);
  assert.equal(journal(ws).length, 2);
});

test("refusals: a step-lease denial appends cli.end VALIDATION with the step, as runScript does", async (t) => {
  const ws = workspace();
  t.after(ws.cleanup);
  ws.lease();
  assert.ok(await denies(ws, cmd("film:measure")));
  const end = journal(ws).at(-1)!;
  assert.equal(end.kind, "cli.end");
  assert.equal(end.error, "VALIDATION");
  assert.equal(end.alias, "film:measure");
  assert.equal(end.step, "material");
  assert.ok(ConsoleEventSchema.safeParse(end).success);
  assert.equal(eventNotice(end)?.kind, "failure");
});

test("refusals: no journal with AGENTBROS_EVENTS=off, without pipeline/, or when the write fails; the denial stands", async (t) => {
  const ws = workspace();
  t.after(() => {
    try {
      chmodSync(path.join(ws.dir, "pipeline"), 0o755);
    } catch {
      // removed
    }
    ws.cleanup();
  });
  control(ws, "paused");
  assert.ok(await denies(ws, cmd("render"), hookEnv({ AGENTBROS_EVENTS: "off" })));
  assert.equal(journal(ws).length, 0);
  chmodSync(path.join(ws.dir, "pipeline"), 0o555);
  assert.ok(await denies(ws, cmd("render"), hookEnv()), "an unwritable journal never fails the hook");
  chmodSync(path.join(ws.dir, "pipeline"), 0o755);
  assert.equal(journal(ws).length, 0);
  // A project directory without pipeline/: the pause cannot exist, so check the writer directly.
  rmSync(path.join(ws.dir, "pipeline"), { recursive: true });
  const { appendRefusal } = await import("../scripts/hooks/lib/journal.mjs" as string);
  const payload = { harness: "claude-code", sessionId: "s1" };
  const refusal = { project: PROJECT, code: "PAUSED", message: "PAUSED: x", alias: "render", args: [], payload };
  assert.equal(appendRefusal(ws.root, refusal, hookEnv()), false);
  assert.ok(!existsSync(path.join(ws.dir, "pipeline")), "pipeline/ is never created");
  assert.equal(appendRefusal(ws.root, { ...refusal, project: "no-such-project" }, hookEnv()), false);
});

test("refusals: the hook's redaction mirrors the journal's (redactArgv, scrubSecrets)", async () => {
  const hook = await import("../scripts/hooks/lib/journal.mjs" as string);
  const redact = await import("../src/lib/console/redact");
  for (const argv of [
    ["--project", "a", "--api-key", "k", "--answer", "my token words", "--token=x", "--auth", "--project"],
    ["--secret", "-abc", "x".repeat(700)],
  ])
    assert.deepEqual(hook.redactArgv(argv), redact.redactArgv(argv));
  for (const text of [
    'Invalid value "sk-1" for --token',
    "--api-key=sk-1 --password 'p w' --answer keep --token --next",
    "y".repeat(900),
  ]) {
    assert.equal(hook.scrubSecrets(text), redact.scrubSecrets(text));
    assert.equal(hook.boundString(text), redact.redactString(text));
  }
});

test("console secrets: the session token and the grant are denied to agents for every project, by any tool", async (t) => {
  assert.equal(guardLib.CONSOLE_SESSION_FILE, SESSION_FILE);
  assert.deepEqual(guardLib.CONSOLE_GRANT_ENVS, [GRANT_ENV, GRANT_AT_ENV]);
  const ws = workspace({ project: false });
  t.after(ws.cleanup);
  mkdirSync(path.join(ws.root, "out/console"), { recursive: true });
  writeFileSync(path.join(ws.root, SESSION_FILE), JSON.stringify({ v: 1, token: "a".repeat(64) }));
  const reason = (result: { stdout?: Record<string, unknown> }) =>
    (result.stdout?.hookSpecificOutput as { permissionDecisionReason?: string } | undefined)?.permissionDecisionReason;
  const shell = (command: string, harness: "claude" | "codex" = "claude") =>
    runHook(harness, "guard", ws.payload(harness, "PreToolUse-Bash", { tool_input: { command } }), { env: hookEnv() });
  const tool = (tool_name: string, tool_input: Record<string, unknown>) =>
    runHook("claude", "guard", ws.payload("claude", "PreToolUse-Bash", { tool_name, tool_input }), { env: hookEnv() });

  for (const command of [
    "cat out/console/session.json",
    "jq -r .token < ./out/console/session.json",
    "cd out/console && cat session.json",
    "AGENTBROS_CONSOLE_GRANT=abc pnpm recut:plan --project x --approve h --answer=ok --decision=d",
    "export AGENTBROS_CONSOLE_GRANT_AT=2026-11-17T00:00:00.000Z",
    "env | grep AGENTBROS_CONSOLE_GRANT",
    "AGENTBROS_ACTOR=user AGENTBROS_CHANNEL=console pnpm feedback --project x --answer=ok",
    "export AGENTBROS_CHANNEL=console",
    "env AGENTBROS_ACTOR=user pnpm console:control --project x --state running --answer=go",
    `node -e 'process.env.AGENTBROS_CHANNEL = "console"'`,
    "pnpm console --print-token",
    "pnpm review:ui --project x --print-token",
    "pnpm console --print-token=1 | cat",
    "npx tsx scripts/console.ts '--print-token'",
  ])
    assert.match(reason(await shell(command)) ?? "", /studio console/, command);
  for (const command of ["grep -rn AGENTBROS_ACTOR src", "echo $AGENTBROS_CHANNEL", "pnpm console --open"])
    assert.equal(reason(await shell(command)), undefined, command);
  assert.match(reason(await shell("pnpm console --print-token", "codex")) ?? "", /studio console/, "Codex too");
  assert.match(reason(await shell("cat out/console/session.json", "codex")) ?? "", /studio console/, "Codex too");
  for (const [name, input] of [
    ["Read", { file_path: path.join(ws.root, SESSION_FILE) }],
    ["Read", { file_path: SESSION_FILE }],
    ["Write", { file_path: path.join(ws.root, SESSION_FILE), content: "{}" }],
    ["Edit", { file_path: path.join(ws.root, SESSION_FILE), old_string: "a", new_string: "b" }],
    ["Grep", { pattern: "token", path: path.join(ws.root, "out/console") }],
    ["Read", { file_path: "/elsewhere/checkout/out/console/session.json" }],
  ] as const)
    assert.match(
      reason(await tool(name, input)) ?? "",
      /an agent never reads, copies or writes it/,
      `${name} ${JSON.stringify(input)}`,
    );
  // A project's inbox (decisions, the console's intents) is the server's to write.
  const intent = path.join(ws.root, "public/projects/demo-film/pipeline/inbox/intent/dec-1.json");
  assert.match(reason(await tool("Write", { file_path: intent, content: "{}" })) ?? "", /pipeline\/inbox/);
  assert.match(
    reason(
      await tool("Edit", { file_path: path.join(ws.root, "public/projects/demo-film/pipeline/inbox/dec-1.json") }),
    ) ?? "",
    /pipeline\/inbox/,
  );
  assert.match(
    reason(await shell("echo {} > public/projects/demo-film/pipeline/inbox/intent/dec-1.json")) ?? "",
    /pipeline\/inbox/,
  );
  assert.deepEqual(await tool("Read", { file_path: intent }), {}, "reading a decision record is fine");
  // Codex apply_patch (the documented payload, tests/fixtures/hooks/codex/PreToolUse-apply_patch.json): every file it
  // adds, updates, deletes or moves to is judged as a write.
  const patch = (body: string) =>
    runHook(
      "codex",
      "guard",
      ws.payload("codex", "PreToolUse-apply_patch", {
        tool_input: { command: `*** Begin Patch\n${body}\n*** End Patch\n` },
      }),
      { env: hookEnv() },
    );
  for (const body of [
    "*** Add File: out/console/session.json\n+{}",
    `*** Update File: ${path.join(ws.root, SESSION_FILE)}\n@@\n-a\n+b`,
    "*** Add File: public/projects/demo-film/pipeline/inbox/intent/dec-1.json\n+{}",
    "*** Delete File: public/projects/demo-film/pipeline/inbox/dec-1.json",
    "*** Update File: src/a.ts\n*** Move to: public/projects/demo-film/pipeline/inbox/dec-2.json\n@@\n-a\n+b",
    "*** Update File: src/a.ts\n@@\n-a\n+b\n*** Add File: public/projects/demo-film/pipeline/inbox/x.json\n+{}",
  ])
    assert.match(reason(await patch(body)) ?? "", /studio console|pipeline\/inbox/, body);
  assert.deepEqual(await patch("*** Update File: src/scenes/Hook.tsx\n@@\n-a\n+b"), {}, "an ordinary patch passes");
  // Everything else is untouched.
  assert.deepEqual(await tool("Read", { file_path: path.join(ws.root, "out/console/metrics.json") }), {});
  assert.deepEqual(await tool("Read", { file_path: path.join(ws.root, "pipeline/session/lease.json") }), {});
  assert.deepEqual(await shell("cat out/console/metrics.json"), {});
});
