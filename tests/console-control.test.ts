/**
 * Studio console control (RFC 0004 D12, §13 Control, A9): `console:control` and control.json, runScript's `PAUSED`
 * refusal and its parity with the guard hook, control aliases still running, the step guard and the pause together
 * (§16), resume, stop listing in-flight paid jobs, and the soft pause (a submitted job completes and keeps its result).
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ControlFileSchema, ConsoleEventSchema, JobSummarySchema } from "../src/types/console";
import {
  lockControl,
  pauseMessage,
  readControlFile,
  readControlLenient,
  writeControl,
} from "../src/lib/console/control";
import { pauseVerdict } from "../src/lib/console/pause";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { consoleGrantEnv, GRANT_AT_ENV, GRANT_ENV } from "../src/lib/console/grant";
import { ALWAYS_ADMITTED, CONTROL_ALIASES } from "../src/lib/step-lease/lease";
import { ERROR_CODES } from "../src/lib/cli";
import { OperationStore } from "../src/lib/jobs/store";
import { runGenerationStep, type JobProvider } from "../src/lib/jobs/runner";
import { USER_GRANT } from "./helpers/ceiling-grant";
// @ts-expect-error plain Node hook without types
import * as guardLib from "../scripts/hooks/lib/guard.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const PROJECT = "demo-film";

function workspace(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-control-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects", PROJECT);
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify({ title: "Demo" }));
  return { root, dir };
}

function cli(root: string, script: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_NO_DOTENV: "1", AGENTBROS_STEP_ADMITTED: "" };
  delete base.HIGGSFIELD_API_KEY;
  delete base.FAL_KEY;
  delete base.AGENTBROS_CHANNEL;
  delete base.AGENTBROS_ACTOR;
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...base, ...env },
  });
  const line = run.stdout.trim().split("\n").at(-1) ?? "{}";
  return { status: run.status, json: JSON.parse(line) as Record<string, any> };
}

const controlArgs = (state: string, answer: string, extra: string[] = []) => [
  "--project",
  PROJECT,
  "--state",
  state,
  "--answer",
  answer,
  ...extra,
];
const control = (root: string, state: string, answer: string, extra: string[] = [], env: NodeJS.ProcessEnv = {}) =>
  cli(root, "scripts/console-control.ts", controlArgs(state, answer, extra), env);

/** What the console's spawn adds (control-actions.ts): the user on the console, signed for exactly this argv. */
function consoleEnv(root: string, args: string[]): NodeJS.ProcessEnv {
  loadOrCreateSessionToken(root);
  return { AGENTBROS_CHANNEL: "console", AGENTBROS_ACTOR: "user", ...consoleGrantEnv(root, PROJECT, args) };
}

/** A light non-control command (alias `projects`); the pause judges it before it reads its own flags. */
const listProjects = (root: string, env: NodeJS.ProcessEnv = {}) =>
  cli(root, "scripts/list-projects.ts", ["--project", PROJECT], env);

test("PAUSED is a CLI error code", () => {
  assert.ok((ERROR_CODES as readonly string[]).includes("PAUSED"));
});

test("console:control writes control.json with the user's words verbatim, history and the journal line", (t) => {
  const { root, dir } = workspace(t);
  const words = "Pause,  I want to look at scene 3 first.";
  const paused = control(root, "paused", words, ["--reason", "Review scene 3"], {
    AGENTBROS_EVENTS: "on",
    ...consoleEnv(root, controlArgs("paused", words, ["--reason", "Review scene 3"])),
  });
  assert.equal(paused.status, 0, JSON.stringify(paused.json));
  assert.equal(paused.json.ok, true);
  assert.equal(paused.json.metadata.previous, "running");
  assert.equal(paused.json.metadata.changed, true);
  const file = ControlFileSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "pipeline/session/control.json"), "utf8")),
  );
  assert.equal(file.state, "paused");
  assert.equal(file.answer, words);
  assert.equal(file.reason, "Review scene 3");
  assert.equal(file.channel, "console");
  assert.equal(file.by, "user");
  const { v: _v, history: _history, ...current } = file;
  assert.deepEqual(file.history.at(-1), current, "history ends with the current change");
  assert.equal(file.history.length, 1);
  assert.deepEqual(paused.json.metadata.control, file);
  const events = readFileSync(path.join(dir, "pipeline/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => ConsoleEventSchema.parse(JSON.parse(line)));
  const changed = events.find((event) => event.kind === "control.changed");
  assert.ok(changed, "control.changed journaled");
  assert.equal(changed!.actor, "user");
  assert.equal(changed!.channel, "console");
  assert.deepEqual(changed!.data, {
    state: "paused",
    previous: "running",
    answer: words,
    channel: "console",
    actor: "user",
    reason: "Review scene 3",
  });

  const resumed = control(root, "running", "Go on.");
  assert.equal(resumed.json.ok, true);
  const after = ControlFileSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "pipeline/session/control.json"), "utf8")),
  );
  assert.equal(after.state, "running");
  assert.equal(after.channel, "cli", "a CLI run outside the console");
  assert.deepEqual(
    after.history.map((entry) => entry.state),
    ["paused", "running"],
  );
});

test("console:control refuses an unknown project, a placeholder answer and a bad state", (t) => {
  const { root } = workspace(t);
  const unknown = cli(root, "scripts/console-control.ts", [
    "--project",
    "no-such",
    "--state",
    "paused",
    "--answer",
    "Pause.",
  ]);
  assert.equal(unknown.status, 1);
  assert.equal(unknown.json.error, "PROJECT_NOT_FOUND");
  const placeholder = control(root, "paused", "<the user's words>");
  assert.equal(placeholder.json.error, "INVALID_INPUT");
  const state = control(root, "frozen", "Pause.");
  assert.equal(state.json.error, "INVALID_INPUT");
  const missing = cli(root, "scripts/console-control.ts", ["--project", PROJECT, "--state", "paused"]);
  assert.equal(missing.json.ok, false);
});

test("a paused project refuses non-control commands with PAUSED, the hook's words, whatever the step guard says", (t) => {
  const { root, dir } = workspace(t);
  assert.notEqual(listProjects(root).json.error, "PAUSED", "running: the command itself decides");
  assert.equal(control(root, "paused", "Hold on, I am reviewing.").json.ok, true);
  for (const guard of ["off", "warn", "enforce"]) {
    const refused = listProjects(root, { AGENTBROS_STEP_GUARD: guard });
    assert.equal(refused.status, 1, guard);
    assert.equal(refused.json.ok, false);
    assert.equal(refused.json.error, "PAUSED", JSON.stringify(refused.json));
    assert.match(refused.json.message, /^PAUSED: project demo-film is paused by the user since /);
    assert.equal(refused.json.details.retry, false);
    assert.equal(refused.json.details.answer, "Hold on, I am reviewing.");
    // Parity with the guard hook at PreToolUse (scripts/hooks/lib/guard.mjs).
    const hook = guardLib.pauseRefusal(dir, { alias: "projects", aliases: ["projects"] });
    assert.equal(refused.json.message, hook);
  }
  // --help is never judged.
  assert.equal(cli(root, "scripts/list-projects.ts", ["--project", PROJECT, "--help"]).json.ok, true);
  // Control commands still run while paused.
  assert.equal(cli(root, "scripts/budget.ts", ["--project", PROJECT]).json.error === "PAUSED", false);
  assert.equal(cli(root, "scripts/memory.ts", ["--project", PROJECT, "--list"]).json.error === "PAUSED", false);
  const stopped = control(root, "stopped", "Stop everything.");
  assert.equal(stopped.json.ok, true);
  assert.deepEqual(stopped.json.metadata.runningJobs, []);
  assert.match(listProjects(root).json.message, /is stopped by the user/);
  // Resume restores work.
  assert.equal(control(root, "running", "Resume.").json.ok, true);
  assert.notEqual(listProjects(root).json.error, "PAUSED");
});

test("the PAUSED message equals the hook's for lenient, odd and long control files", (t) => {
  const { dir } = workspace(t);
  const file = path.join(dir, "pipeline/session/control.json");
  mkdirSync(path.dirname(file), { recursive: true });
  const cases: Record<string, unknown>[] = [
    { v: 1, state: "paused", by: "user", channel: "console", at: "2026-11-17T09:00:00Z", history: [] },
    { v: 1, state: "stopped", by: "agent", at: "2026-11-17T09:00:00Z", reason: "lunch", extra: 1 },
    { v: 1, state: "paused", at: "2026-11-17T09:00:00Z", answer: `a\n\tb ${"x".repeat(400)}`, history: "bad" },
    { v: 1, state: "paused", at: "not a date" },
    { v: 2, state: "paused", at: "2026-11-17T09:00:00Z" },
    { v: 1, state: "running", at: "2026-11-17T09:00:00Z" },
  ];
  for (const value of cases) {
    writeFileSync(file, JSON.stringify(value));
    const hook = guardLib.pauseRefusal(dir, { alias: "render", aliases: ["render"] });
    const reading = readControlLenient(dir);
    const ours = reading && reading.state !== "running" ? pauseMessage(PROJECT, reading, "render") : undefined;
    assert.equal(ours, hook, JSON.stringify(value));
    const verdict = pauseVerdict({
      rootDir: path.dirname(path.dirname(path.dirname(dir))),
      argv: ["node", "x", "--project", PROJECT],
      aliases: ["render"],
    });
    assert.equal(verdict?.message, hook);
  }
  writeFileSync(file, "{ not json");
  assert.equal(readControlLenient(dir), undefined);
  assert.equal(guardLib.pauseRefusal(dir, { alias: "render", aliases: ["render"] }), undefined);
});

test("every control alias is admitted while paused, by runScript's verdict and by the hook", (t) => {
  const { root, dir } = workspace(t);
  writeControl(dir, { state: "paused", answer: "Pause.", channel: "cli" });
  for (const alias of CONTROL_ALIASES) {
    assert.equal(
      pauseVerdict({ rootDir: root, argv: ["node", "x", "--project", PROJECT], aliases: [alias] }),
      undefined,
      alias,
    );
    assert.equal(guardLib.pauseRefusal(dir, { alias, aliases: [alias] }), undefined, alias);
  }
  for (const alias of ["job:cancel", "console:control", "console:wait", "next"])
    assert.ok((ALWAYS_ADMITTED as readonly string[]).includes(alias), alias);
  // A script whose sibling alias is a control alias is admitted, as the step guard judges the script.
  assert.equal(
    pauseVerdict({ rootDir: root, argv: ["node", "x", "--project", PROJECT], aliases: ["render", "next"] }),
    undefined,
  );
  assert.ok(pauseVerdict({ rootDir: root, argv: ["node", "x", "--project", PROJECT], aliases: ["render"] }));
});

test("§16: the step lease and the pause together: the pause refuses first; control aliases pass both", (t) => {
  const { root, dir } = workspace(t);
  // An expired lease in enforce mode refuses a non-control command with VALIDATION when the project runs.
  const lease = {
    schemaVersion: 1,
    project: PROJECT,
    route: "film",
    step: "material",
    owner: "asset-planner",
    role: "orchestrator",
    lanes: [],
    allow: [...CONTROL_ALIASES],
    spending: [],
    paidAllowed: false,
    chainHash: "0".repeat(64),
    issuedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T01:00:00.000Z",
    issuedBy: "next",
  };
  mkdirSync(path.join(dir, "pipeline/session"), { recursive: true });
  writeFileSync(path.join(dir, "pipeline/session/lease.json"), JSON.stringify(lease));
  const enforce = { AGENTBROS_STEP_GUARD: "enforce" };
  const leaseRefusal = listProjects(root, enforce);
  assert.equal(leaseRefusal.json.error, "VALIDATION");
  assert.match(leaseRefusal.json.message, /^Step guard/);
  // console:control is always admitted by the expired lease, and pausing makes the pause the reason.
  assert.equal(control(root, "paused", "Pause.", [], enforce).json.ok, true);
  const paused = listProjects(root, enforce);
  assert.equal(paused.json.error, "PAUSED");
  // job:cancel passes the expired lease and the pause (it then fails on its own: no paid jobs here).
  const cancel = cli(
    root,
    "scripts/job-cancel.ts",
    ["--project", PROJECT, "--operation-id", "x:1", "--answer", "Cancel it."],
    enforce,
  );
  assert.equal(cancel.json.error, "INVALID_INPUT");
  assert.match(cancel.json.message, /no paid jobs/);
  // The hook agrees on both.
  assert.match(guardLib.pauseRefusal(dir, { alias: "projects", aliases: ["projects"] }), /^PAUSED/);
  assert.equal(guardLib.pauseRefusal(dir, { alias: "job:cancel", aliases: ["job:cancel"] }), undefined);
  assert.equal(control(root, "running", "Resume.", [], enforce).json.ok, true);
  assert.equal(listProjects(root, enforce).json.error, "VALIDATION", "back to the lease's own verdict");
});

// --- Paid jobs: stop lists them; the soft pause lets a submitted job complete (A9). ---

const bound = {
  currency: "USD" as const,
  lowUsd: 0,
  expectedUsd: 0.5,
  highUsd: 0.5,
  bounded: true as const,
  confidence: "user-bound" as const,
  source: "offline bound",
  asOf: "2026-11-15",
};

function paidStore(dir: string) {
  const store = new OperationStore(PROJECT, { directory: path.join(dir, "pipeline") });
  store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  return store;
}

const operation = (id: string, provider = "fal") => ({
  operationId: id,
  provider,
  endpoint: "test/model",
  assetId: `asset-${id}`,
  quote: bound,
});

function fakeProvider(state: { completed: boolean }): JobProvider {
  return {
    submit: async () => ({ requestId: "req-1" }),
    inspect: async () =>
      state.completed ? { state: "completed", result: { url: "https://example.invalid/a.png" } } : { state: "running" },
  };
}

test("A9: pause refuses a new submit, but a submitted job completes while paused and keeps its result", async (t) => {
  const { root, dir } = workspace(t);
  const store = paidStore(dir);
  const progress = { completed: false };
  const input = { prompt: "a cat" };
  const first = await runGenerationStep({
    store,
    operation: operation("op:submitted"),
    input,
    provider: fakeProvider(progress),
  });
  assert.equal(first.state, "running");
  store.reserveOperation({ ...operation("op:fresh"), inputHash: "f".repeat(64) });

  assert.equal(control(root, "paused", "Pause, please.").json.ok, true);
  const argv = (...extra: string[]) => [
    "node",
    path.join(REPO, "scripts/generate-model.ts"),
    "--project",
    PROJECT,
    ...extra,
  ];
  const judge = (...extra: string[]) => pauseVerdict({ rootDir: root, argv: argv(...extra) });
  assert.equal(judge("--operation-id", "op:submitted"), undefined, "completing a submitted job is admitted");
  assert.equal(judge("--operation-id=op:submitted"), undefined);
  assert.match(
    judge()!.message,
    /^PAUSED: .*`pnpm generate:model` is not a control command/,
    "a new submit is refused",
  );
  assert.ok(judge("--operation-id", "op:fresh"), "a reserved, unsubmitted job would submit: refused");
  assert.ok(judge("--operation-id", "op:missing"), "an unknown job: refused");
  // The hook leaves --operation-id runs to runScript and denies the rest.
  assert.equal(
    guardLib.pauseRefusal(
      dir,
      guardLib.invocations(`pnpm generate:model --project ${PROJECT} --operation-id op:submitted`)[0],
    ),
    undefined,
  );
  assert.match(guardLib.pauseRefusal(dir, { alias: "generate:model", aliases: ["generate:model"] }), /^PAUSED/);

  // The worker (or its resume) still completes the job while paused: the store refuses only new reserves and submits.
  progress.completed = true;
  const published = await runGenerationStep({
    store,
    operation: operation("op:submitted"),
    input,
    provider: fakeProvider(progress),
    publish: async () => ({ file: "assets/a.png" }),
  });
  assert.equal(published.state, "published");
  assert.deepEqual((published.result as Record<string, unknown>).published, { file: "assets/a.png" });
  assert.equal(readControlLenient(dir)?.state, "paused", "still paused");
  assert.equal(
    judge("--operation-id", "op:submitted")?.message.startsWith("PAUSED"),
    true,
    "published: nothing left to complete",
  );
});

test("stop lists the in-flight paid jobs with their reservations and whether each can be cancelled", async (t) => {
  const { root, dir } = workspace(t);
  const store = paidStore(dir);
  await runGenerationStep({
    store,
    operation: operation("op:fal"),
    input: { prompt: "a" },
    provider: fakeProvider({ completed: false }),
  });
  await runGenerationStep({
    store,
    operation: operation("op:hf", "higgsfield"),
    input: { prompt: "b" },
    provider: { ...fakeProvider({ completed: false }), submit: async () => ({ requestId: "req-hf" }) },
  });
  store.reserveOperation({ ...operation("op:reserved"), inputHash: "e".repeat(64) });
  await runGenerationStep({
    store,
    operation: operation("op:done"),
    input: { prompt: "c" },
    provider: fakeProvider({ completed: true }),
    publish: async () => ({}),
  });
  const stopped = control(root, "stopped", "Stop everything.");
  assert.equal(stopped.json.ok, true);
  const jobs = (stopped.json.metadata.runningJobs as unknown[]).map((job) => JobSummarySchema.parse(job));
  const byId = Object.fromEntries(jobs.map((job) => [job.id, job]));
  assert.deepEqual(Object.keys(byId).sort(), ["op:fal", "op:hf", "op:reserved"]);
  assert.equal(byId["op:fal"]!.reservedUsd, 0.5);
  assert.equal(byId["op:fal"]!.cancellable, false, "the fal adapter has no cancel call");
  assert.equal(byId["op:hf"]!.cancellable, true);
  assert.equal(byId["op:reserved"]!.cancellable, true, "not submitted: a local cancel");
  assert.equal(byId["op:fal"]!.priceKnown, false, "a user-bound quote is an unknown price");
  // Stop applies the same refusal; nothing was cancelled by the stop itself.
  assert.equal(listProjects(root).json.error, "PAUSED");
  assert.equal(store.snapshot().jobs["op:hf"]!.state, "running");
});

// --- Review regressions (spending while paused, policy). ---

test("repeated or short --project and repeated --operation-id cannot slip past the pause (runScript and hook)", async (t) => {
  const { root, dir } = workspace(t);
  mkdirSync(path.join(root, "public/projects/decoy/pipeline"), { recursive: true });
  const store = paidStore(dir);
  const progress = { completed: false };
  await runGenerationStep({
    store,
    operation: operation("op:submitted"),
    input: { a: 1 },
    provider: fakeProvider(progress),
  });
  writeControl(dir, { state: "paused", answer: "Pause.", channel: "cli" });
  for (const args of [
    ["--project", "decoy", "--project", PROJECT],
    ["--project=decoy", `--project=${PROJECT}`],
    ["-p", PROJECT],
    [`-p=${PROJECT}`],
  ]) {
    const refused = cli(root, "scripts/list-projects.ts", args);
    assert.equal(refused.json.error, "PAUSED", args.join(" "));
  }
  const model = path.join(REPO, "scripts/generate-model.ts");
  const judge = (...extra: string[]) => pauseVerdict({ rootDir: root, argv: ["node", model, ...extra] });
  assert.equal(judge("--project", PROJECT, "--operation-id", "op:submitted"), undefined, "the one submitted job");
  assert.ok(judge("--project", PROJECT, "--operation-id", "op:submitted", "--operation-id", "op:fresh"), "repeated id");
  assert.ok(judge("--project", "decoy", "--project", PROJECT, "--operation-id", "op:submitted"), "two projects");
  // Scripts that derive ids from --operation-id (<id>:<unit>) are not exempt.
  for (const script of ["scripts/generate-voiceover.ts", "scripts/align-captions.ts"])
    assert.ok(
      pauseVerdict({
        rootDir: root,
        argv: ["node", path.join(REPO, script), "--project", PROJECT, "--operation-id", "op:submitted"],
      }),
      script,
    );
  const verdict = judge("--project", PROJECT);
  assert.equal(verdict!.details.completeSubmittedJob, undefined, "the refusal suggests no way around it");
  assert.match(verdict!.message, /Only the user resumes; never run console:control yourself\.$/);
  // The hook: the same allowlist, every named project, a single id.
  const { COMPLETION_SCRIPTS } = await import("../src/lib/console/control");
  assert.deepEqual(guardLib.COMPLETION_SCRIPTS, [...COMPLETION_SCRIPTS]);
  const hookCall = (command: string) => guardLib.invocations(command)[0];
  const deny = (command: string) => guardLib.pauseRefusal(dir, hookCall(command));
  assert.equal(deny(`pnpm generate:model --project ${PROJECT} --operation-id op:submitted`), undefined);
  assert.match(deny(`pnpm generate:model --project ${PROJECT} --operation-id a --operation-id b`), /^PAUSED/);
  assert.match(deny(`pnpm generate:voiceover --project ${PROJECT} --operation-id op:submitted`), /^PAUSED/);
  assert.deepEqual(hookCall(`pnpm render --project decoy -p ${PROJECT}`).projects, ["decoy", PROJECT]);
  const decided = guardLib.decide(
    { tool: { kind: "shell", command: `pnpm render --project decoy --project ${PROJECT}` }, cwd: root },
    { root, env: { ...process.env, AGENTBROS_STEP_GUARD: "off" } },
  );
  assert.match(decided.deny, /^PAUSED: project demo-film/);
});

test("the job store holds the pause at reserve and submit; submitted jobs still finish", async (t) => {
  const { dir } = workspace(t);
  const store = paidStore(dir);
  store.reserveOperation({ ...operation("op:reserved"), inputHash: "e".repeat(64) });
  const progress = { completed: false };
  await runGenerationStep({
    store,
    operation: operation("op:running"),
    input: { b: 1 },
    provider: fakeProvider(progress),
  });
  writeControl(dir, { state: "stopped", answer: "Stop.", channel: "console" });
  assert.throws(
    () => store.reserveOperation({ ...operation("op:new"), inputHash: "d".repeat(64) }),
    (error: Error & { code?: string }) => error.code === "PAUSED" && /no new paid job/.test(error.message),
  );
  // A batch already running reaches the submit of a reserved job: refused, the reservation stays to cancel.
  await assert.rejects(
    runGenerationStep({ store, operation: operation("op:fresh2"), input: { c: 1 }, provider: fakeProvider(progress) }),
    (error: Error & { code?: string }) => error.code === "PAUSED",
  );
  assert.throws(
    () => store.transitionJob("op:reserved", "submitting"),
    (error: Error & { code?: string }) => error.code === "PAUSED",
  );
  assert.equal(store.snapshot().jobs["op:reserved"]!.state, "reserved");
  progress.completed = true;
  const done = await runGenerationStep({
    store,
    operation: operation("op:running"),
    input: { b: 1 },
    provider: fakeProvider(progress),
    publish: async () => ({ file: "x.png" }),
  });
  assert.equal(done.state, "published", "an already-submitted job completes while stopped");
  writeControl(dir, { state: "running", answer: "Go.", channel: "console" });
  assert.equal(store.transitionJob("op:reserved", "submitting").state, "submitting");
  // Unreadable control: fail open.
  writeFileSync(path.join(dir, "pipeline/session/control.json"), "{ nope");
  assert.ok(store.reserveOperation({ ...operation("op:open"), inputHash: "c".repeat(64) }));
});

test("a CLI resume is journaled with its actor and channel and flagged for the console", (t) => {
  const { root, dir } = workspace(t);
  assert.equal(control(root, "paused", "Pause.", [], consoleEnv(root, controlArgs("paused", "Pause."))).json.ok, true);
  // Env words without the grant: still a CLI resume, journaled as the agent's with the claim kept.
  const resumed = control(root, "running", "Go on.", [], {
    AGENTBROS_EVENTS: "on",
    AGENTBROS_CHANNEL: "console",
    AGENTBROS_ACTOR: "user",
  });
  assert.equal(resumed.json.metadata.channel, "cli");
  assert.equal(resumed.json.metadata.actor, "agent");
  assert.match(resumed.json.metadata.notice, /Resumed from the CLI \(agent\)/);
  const file = ControlFileSchema.parse(
    JSON.parse(readFileSync(path.join(dir, "pipeline/session/control.json"), "utf8")),
  );
  assert.deepEqual(
    file.history.map((entry) => [entry.state, entry.channel]),
    [
      ["paused", "console"],
      ["running", "cli"],
    ],
  );
  const event = readFileSync(path.join(dir, "pipeline/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => ConsoleEventSchema.parse(JSON.parse(line)))
    .find((entry) => entry.kind === "control.changed");
  assert.equal(event!.actor, "agent");
  assert.equal(event!.channel, "cli");
  assert.equal(event!.data!.resumedViaCli, true);
  assert.equal(event!.data!.channel, "cli");
  assert.deepEqual(event!.data!.claimed, { actor: "user", channel: "console" });
  const start = readFileSync(path.join(dir, "pipeline/events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => ConsoleEventSchema.parse(JSON.parse(line)))
    .find((entry) => entry.kind === "cli.start");
  assert.equal(start!.actor, "agent");
  assert.deepEqual(start!.data!.claimed, { actor: "user", channel: "console" });
  // A stale grant (another argv) is no better than none.
  const forged = control(root, "paused", "Pause.", [], {
    ...consoleEnv(root, controlArgs("paused", "Something else.")),
  });
  assert.equal(forged.json.metadata.channel, "cli");
});

test("writeControl serialises writers with a lock and takes over a dead owner's lock", (t) => {
  const { dir } = workspace(t);
  const file = path.join(dir, "pipeline/session/control.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.lock`, "999999999"); // no such process
  writeControl(dir, { state: "paused", answer: "Pause.", channel: "cli" });
  assert.equal(existsSync(`${file}.lock`), false, "released after the write");
  const held = lockControl(file);
  assert.throws(() => lockControl(file, 50), /locked by process/);
  held();
  let inside = false;
  writeControl(dir, { state: "running", answer: "Go.", channel: "cli" }, () => {
    inside = existsSync(`${file}.lock`);
  });
  assert.equal(inside, true, "the journal runs while the lock is held");
  assert.equal(readControlFile(dir)!.history.length, 2);
});

test("a console grant lets the user's own decisions run while paused; a missing, forged, expired or reused one does not", (t) => {
  const { root, dir } = workspace(t);
  mkdirSync(path.join(root, "out/console"), { recursive: true });
  writeFileSync(path.join(root, "out/console/session.json"), JSON.stringify({ v: 1, token: "ab".repeat(32) }), {
    mode: 0o600,
  });
  writeControl(dir, { state: "paused", answer: "Pause.", channel: "console" });
  const args = ["--project", PROJECT, "--step", "brief", "--answer=Yes, approved."];
  const approve = (env: NodeJS.ProcessEnv, argv: string[] = args, now?: Date) =>
    pauseVerdict({ rootDir: root, argv: ["node", path.join(REPO, "scripts/film-approve.ts"), ...argv], env, now });
  const granted = consoleGrantEnv(root, PROJECT, args);
  assert.equal(approve(granted), undefined, "the console-granted film:approve applies");
  assert.match(approve({})!.message, /^PAUSED: .*`pnpm film:approve`/, "without a grant");
  assert.ok(approve({ AGENTBROS_ACTOR: "user", AGENTBROS_CHANNEL: "console" }), "env words alone are not a grant");
  assert.ok(approve({ ...granted, [GRANT_ENV]: "0".repeat(64) }), "forged");
  assert.ok(approve(consoleGrantEnv(root, PROJECT, args, new Date(Date.now() - 61_000))), "expired");
  assert.ok(approve(granted, [...args, "--force"]), "another argv");
  assert.ok(approve(consoleGrantEnv(root, "decoy", args)), "another project");
  assert.ok(approve({ ...granted, [GRANT_AT_ENV]: new Date().toISOString() }), "another issue time");
  // End to end through runScript (film:approve is not a control command; budget, feedback and memory are).
  const refused = cli(root, "scripts/film-approve.ts", args);
  assert.equal(refused.json.error, "PAUSED", JSON.stringify(refused.json));
  const admitted = cli(root, "scripts/film-approve.ts", args, consoleGrantEnv(root, PROJECT, args));
  assert.notEqual(admitted.json.error, "PAUSED", JSON.stringify(admitted.json));
});

// --- Re-verification regressions. ---

test("an ambiguous idempotent job (saved body, no request ID) is not resubmitted while paused", async (t) => {
  const { dir } = workspace(t);
  const store = paidStore(dir);
  let submits = 0;
  const lost: JobProvider = {
    idempotentSubmit: true,
    submit: async () => {
      submits++;
      throw new Error("acknowledgement lost");
    },
    inspect: async () => ({ state: "running" }),
  };
  const args = { store, operation: operation("op:lost"), input: { prompt: "hi" } };
  const first = await runGenerationStep({ ...args, provider: lost });
  assert.equal(first.providerRequestId, undefined);
  assert.notEqual(first.requestBody, undefined);
  writeControl(dir, { state: "paused", answer: "Pause.", channel: "console" });
  const ok: JobProvider = { ...lost, submit: async () => (submits++, { requestId: "req-new" }) };
  await assert.rejects(
    runGenerationStep({ ...args, provider: ok }),
    (error: Error & { code?: string }) => error.code === "PAUSED",
  );
  assert.equal(submits, 1, "no provider request while paused");
  assert.equal(store.snapshot().jobs["op:lost"]!.providerRequestId, undefined);
  writeControl(dir, { state: "running", answer: "Go.", channel: "console" });
  assert.equal((await runGenerationStep({ ...args, provider: ok })).providerRequestId, "req-new");
});

test("a differently cased or underscored --project cannot slip past a paused project", async (t) => {
  const { root, dir } = workspace(t);
  const upper = path.join(root, "public/projects/my_film");
  mkdirSync(path.join(upper, "pipeline"), { recursive: true });
  writeControl(dir, { state: "paused", answer: "Pause.", channel: "console" });
  writeControl(upper, { state: "stopped", answer: "Stop.", channel: "console" });
  const approve = (id: string) =>
    pauseVerdict({
      rootDir: root,
      argv: ["node", path.join(REPO, "scripts/film-approve.ts"), "--project", id],
      env: {},
    });
  for (const id of ["Demo-Film", "DEMO-FILM", "my_film", "My_Film"]) assert.ok(approve(id), id);
  assert.equal(cli(root, "scripts/film-approve.ts", ["--project", "Demo-Film"]).json.error, "PAUSED");
  assert.equal(cli(root, "scripts/film-approve.ts", ["--project=my_film"]).json.error, "PAUSED");
  assert.deepEqual(guardLib.pauseCandidates(["Demo-Film", "../x", "my_film"]), ["Demo-Film", "demo-film", "my_film"]);
  const { pauseCandidates } = await import("../src/lib/console/control");
  assert.deepEqual(
    pauseCandidates(["Demo-Film", "../x", "my_film"]),
    guardLib.pauseCandidates(["Demo-Film", "../x", "my_film"]),
  );
  for (const command of ["pnpm render --project Demo-Film", "pnpm render --project my_film"]) {
    const decided = guardLib.decide(
      { tool: { kind: "shell", command }, cwd: root },
      { root, env: { ...process.env, AGENTBROS_STEP_GUARD: "off" } },
    );
    assert.match(decided.deny ?? "", /^PAUSED: project /, command);
  }
});

test("a campaign run skips each paused child project with a PAUSED note", async (t) => {
  const { root, dir } = workspace(t);
  const { pausedChild } = await import("../src/lib/campaigns/production/execute");
  assert.equal(pausedChild(root, PROJECT), undefined);
  writeControl(dir, { state: "stopped", answer: "Stop.", channel: "console" });
  const skipped = pausedChild(root, PROJECT)!;
  assert.equal(skipped.blocked, true);
  assert.equal(skipped.reasonCode, "PAUSED");
  assert.match(skipped.message, /^PAUSED: project demo-film is stopped by the user/);
});
