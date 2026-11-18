/**
 * The studio console's event journal (RFC 0004 D7, §6.1, §13 Journal row): cli.start/cli.end for every ending, written
 * before exit; redaction; rotation; AGENTBROS_EVENTS=off; a failing write never fails the command; under 2 ms (warn
 * only); agent.dispatch from film:brief; job.state from the job store; the reader API.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import * as contract from "../src/types/console";
import {
  aliasOf,
  appendEvent,
  beginCliRun,
  finishRotations,
  cliProgress,
  costFromMetadata,
  endCliRun,
  eventsEnabled,
  journalStats,
  projectTarget,
  recordJobState,
  relativeOutputs,
  resetCliRun,
  resetJournalStats,
  globalTarget,
  GLOBAL_EVENTS_FILE,
  EVENTS_FILE,
  EVENTS_ROTATE_BYTES,
} from "../src/lib/console/journal";
import * as redact from "../src/lib/console/redact";
import { redactArgv, redactData, redactString, scrubSecrets } from "../src/lib/console/redact";
import { ulid, ulidTime } from "../src/lib/console/ulid";
import { readEvents, readEventsAfter, readEventsFile, readRecentEvents } from "../src/lib/console/events-reader";
import { OperationStore } from "../src/lib/jobs/store";
import { USER_GRANT } from "./helpers/ceiling-grant";
import { consoleGrantEnv } from "../src/lib/console/grant";
import { loadOrCreateSessionToken } from "../src/lib/console/session";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FIXTURE = path.join(REPO, "tests/fixtures/console-journal/run.ts");
const ON = { AGENTBROS_EVENTS: "on" };

function workspace(t: TestContext, projects: string[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "console-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const id of projects) mkdirSync(path.join(root, "public/projects", id, "pipeline"), { recursive: true });
  mkdirSync(path.join(root, "public/projects"), { recursive: true });
  return root;
}

function run(root: string, file: string, args: string[], env: Record<string, string> = ON) {
  const result = spawnSync(process.execPath, [TSX, file, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, AGENTBROS_RUN_ID: "", npm_lifecycle_event: "", ...env },
  });
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, `one JSON line\n${result.stdout}\n${result.stderr}`);
  return { status: result.status, envelope: JSON.parse(lines[0]!) as Record<string, any>, stderr: result.stderr };
}

/** Every line of a journal, each one checked against the frozen contract. */
function lines(file: string): contract.ConsoleEvent[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => contract.ConsoleEventSchema.parse(JSON.parse(line)));
}
const projectEvents = (root: string, id: string) => lines(path.join(root, "public/projects", id, EVENTS_FILE));

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

test("the writer's dependency-free constants equal the frozen contract's", () => {
  assert.equal(EVENTS_FILE, contract.EVENTS_FILE);
  assert.equal(GLOBAL_EVENTS_FILE, contract.GLOBAL_EVENTS_FILE);
  assert.equal(EVENTS_ROTATE_BYTES, contract.EVENTS_ROTATE_BYTES);
  assert.equal(redact.EVENT_DATA_MAX_BYTES, contract.EVENT_DATA_MAX_BYTES);
  assert.equal(redact.REDACTED, contract.REDACTED);
  assert.equal(redact.REDACT_MAX_STRING, contract.REDACT_MAX_STRING);
  assert.equal(String(redact.REDACT_FLAG_PATTERN), String(contract.REDACT_FLAG_PATTERN));
  assert.equal(contract.CONSOLE_ENV.events, "AGENTBROS_EVENTS");
  assert.equal(contract.CONSOLE_ENV.runId, "AGENTBROS_RUN_ID");
});

test("ulids are valid, unique and monotonic within a process", () => {
  const ids = Array.from({ length: 500 }, () => ulid(1_763_370_000_000));
  for (const id of ids) assert.ok(contract.ConsoleIdSchema.safeParse(id).success && /^[0-7][0-9A-Z]{25}$/.test(id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual([...ids].sort(), ids);
  assert.equal(ulidTime(ulid(1_763_370_123_456)), 1_763_370_123_456);
});

// ---------------------------------------------------------------------------
// Redaction (§6.1)
// ---------------------------------------------------------------------------

test("redaction: secret-like flags in both forms, long strings with length and hash, --answer kept", () => {
  const long = "x".repeat(2000);
  const out = redactArgv([
    "--project",
    "demo",
    "--api-key",
    "sk-123",
    "--fal-token=abc",
    "--password",
    "--next-flag",
    "--AUTH",
    "bearer",
    "--answer",
    "Yes, approve script B with my token secret",
    "--note",
    long,
  ]);
  assert.deepEqual(out.slice(0, 11), [
    "--project",
    "demo",
    "--api-key",
    "<redacted>",
    "--fal-token=<redacted>",
    "--password",
    "--next-flag",
    "--AUTH",
    "<redacted>",
    "--answer",
    "Yes, approve script B with my token secret",
  ]);
  assert.equal(out[12]!.length, 512);
  assert.match(out[12]!, /…\[2000 chars, sha256 [a-f0-9]{64}\]$/);
  assert.equal(redactString("short"), "short");
  // A secret value that starts with "-" is still a value; only an exact --flag form is not.
  assert.deepEqual(redactArgv(["--token", "-abc123", "--api-key", "--project", "p", "--secret", "-x"]), [
    "--token",
    "<redacted>",
    "--api-key",
    "--project",
    "p",
    "--secret",
    "<redacted>",
  ]);
  // The one scrubber for free text (messages, errors, progress), same name rule.
  assert.equal(scrubSecrets("Unknown argument: --api-key=sk-123"), "Unknown argument: --api-key=<redacted>");
  assert.equal(
    scrubSecrets('Invalid value "sk-9" for --token. Allowed: a'),
    'Invalid value "<redacted>" for --token. Allowed: a',
  );
  assert.equal(scrubSecrets("retry with --fal-key sk-1 now"), "retry with --fal-key <redacted> now");
  assert.equal(scrubSecrets('x --auth "q w" y'), "x --auth <redacted> y");
  assert.equal(scrubSecrets('--answer "keep my words" --mode ok'), '--answer "keep my words" --mode ok');
  assert.equal(scrubSecrets("--token --project x"), "--token --project x");
  assert.equal(redactData({ note: "failed: --api-key=sk-2" }).note, "failed: --api-key=<redacted>");
  assert.equal(redactArgv(Array.from({ length: 300 }, (_, i) => `a${i}`)).length, 256);
  const data = redactData({ apiKey: "s3cret", nested: { authHeader: "x", ok: 1 }, big: "y".repeat(20_000) });
  assert.equal(data.apiKey, "<redacted>");
  assert.deepEqual(data.nested, { authHeader: "<redacted>", ok: 1 });
  assert.ok(Buffer.byteLength(JSON.stringify(data)) <= contract.EVENT_DATA_MAX_BYTES);
  const huge = redactData({
    brief: "a/b.md",
    ...Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "z".repeat(500)])),
  });
  assert.equal(huge.brief, "a/b.md", "small required fields survive the bound");
  assert.equal(huge.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= contract.EVENT_DATA_MAX_BYTES);
});

// ---------------------------------------------------------------------------
// cli.* from real processes
// ---------------------------------------------------------------------------

test("cli.start and cli.end for success, CliErrorObject, unknown errors and BUDGET_EXCEEDED, written before exit", (t) => {
  const root = workspace(t, ["demo"]);
  const cases = [
    { mode: "ok", ok: true, status: 0 },
    { mode: "cli-error", ok: false, status: 1, error: "VALIDATION", message: "fixture refusal" },
    { mode: "error", ok: false, status: 1, error: "INTERNAL", message: "fixture crash" },
    { mode: "budget", ok: false, status: 1, error: "BUDGET_EXCEEDED", message: "over the ceiling" },
  ];
  for (const item of cases) {
    const result = run(root, FIXTURE, ["--project", "demo", "--mode", item.mode, "--api-key", "sk-live"]);
    assert.equal(result.status, item.status);
    assert.equal(result.envelope.ok, item.ok);
  }
  const events = projectEvents(root, "demo");
  assert.equal(events.length, cases.length * 2);
  cases.forEach((item, index) => {
    const [start, end] = [events[index * 2]!, events[index * 2 + 1]!];
    assert.equal(start.kind, "cli.start");
    assert.equal(end.kind, "cli.end");
    assert.equal(start.runId, end.runId, "the pair shares a run id");
    assert.equal(start.project, "demo");
    assert.equal(start.alias, "run", "a script outside package.json falls back to its file name");
    assert.deepEqual(start.argv, ["--project", "demo", "--mode", item.mode, "--api-key", "<redacted>"]);
    assert.equal(start.actor, "agent");
    assert.equal(start.channel, "cli");
    assert.equal(end.ok, item.ok);
    assert.equal(end.error, item.error);
    if (item.message) assert.equal(end.message, item.message);
    assert.ok(typeof end.elapsedMs === "number");
    if (item.ok) {
      assert.deepEqual(
        end.outputs,
        ["pipeline/out.json", "out/elsewhere.mp4"],
        "project-relative, else repository-relative",
      );
      assert.equal(end.costUsd, 0.25);
    }
  });
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
});

test("cli.end never carries a secret from an error message", (t) => {
  const root = workspace(t, ["demo"]);
  const result = run(root, FIXTURE, ["--project", "demo", "--mode", "ok", "--fal-token=sk-leak-123"]);
  assert.equal(result.envelope.error, "INVALID_INPUT");
  const end = projectEvents(root, "demo").find((event) => event.kind === "cli.end")!;
  assert.equal(end.ok, false);
  assert.ok(!JSON.stringify(projectEvents(root, "demo")).includes("sk-leak-123"), JSON.stringify(end));
  assert.match(end.message ?? "", /--fal-token=<redacted>/);
});

test("cli.end records the real outcome when the envelope cannot be serialised or stdout fails", async (t) => {
  const root = workspace(t, ["demo"]);
  const bigint = run(root, FIXTURE, ["--project", "demo", "--mode", "bigint"]);
  assert.equal(bigint.status, 1);
  assert.equal(bigint.envelope.error, "INTERNAL");
  let ends = projectEvents(root, "demo").filter((event) => event.kind === "cli.end");
  assert.deepEqual(
    ends.map((event) => [event.ok, event.error]),
    [[false, "INTERNAL"]],
    "one cli.end, the failure the caller saw",
  );
  // stdout closed before the envelope is written (EPIPE): the run exits non-zero and the journal says it failed.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, [TSX, FIXTURE, "--project", "demo", "--mode", "slow"], {
    cwd: root,
    env: { ...process.env, ...ON, AGENTBROS_RUN_ID: "" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.destroy();
  const status = await new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  assert.notEqual(status, 0);
  ends = projectEvents(root, "demo").filter((event) => event.kind === "cli.end");
  assert.equal(ends.length, 2);
  assert.equal(ends[1]!.ok, false);
  assert.equal(ends[1]!.error, "INTERNAL");
  assert.match(ends[1]!.message ?? "", /stdout write failed/);
});

test("actor and channel: the user on the console only with a verified grant; the step from an unexpired lease; children nest by run id", (t) => {
  const root = workspace(t, ["demo"]);
  const session = path.join(root, "public/projects/demo/pipeline/session");
  mkdirSync(session, { recursive: true });
  writeFileSync(
    path.join(session, "lease.json"),
    JSON.stringify({ step: "build", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }),
  );
  loadOrCreateSessionToken(root);
  const args = ["--project", "demo", "--mode", "spawn"];
  run(root, FIXTURE, args, {
    ...ON,
    AGENTBROS_ACTOR: "user",
    AGENTBROS_CHANNEL: "console",
    AGENTBROS_STEP_GUARD: "off",
    ...consoleGrantEnv(root, "demo", args),
  });
  const events = projectEvents(root, "demo");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["cli.start", "cli.start", "cli.end", "cli.end"],
  );
  const [parent, child] = [events[0]!, events[1]!];
  assert.equal(child.parentRunId, parent.runId);
  assert.equal(parent.parentRunId, undefined);
  assert.equal(events[2]!.runId, child.runId);
  assert.equal(events[3]!.runId, parent.runId);
  for (const event of events) assert.equal(event.step, "build");
  // The grant is the parent's alone: a child inherits the env words but not the grant, so it is the agent's.
  for (const event of [parent, events[3]!]) {
    assert.equal(event.actor, "user");
    assert.equal(event.channel, "console");
  }
  for (const event of [child, events[2]!]) {
    assert.equal(event.actor, "agent");
    assert.equal(event.channel, "cli");
  }
  assert.deepEqual(child.data?.claimed, { actor: "user", channel: "console" });
  assert.equal(parent.data?.claimed, undefined);
});

test("env words alone (AGENTBROS_ACTOR=user, AGENTBROS_CHANNEL=console) are claims, never attribution", (t) => {
  const root = workspace(t, ["demo"]);
  loadOrCreateSessionToken(root);
  run(root, FIXTURE, ["--project", "demo", "--mode", "ok"], {
    ...ON,
    AGENTBROS_ACTOR: "user",
    AGENTBROS_CHANNEL: "console",
    // A grant for another argv does not count.
    ...consoleGrantEnv(root, "demo", ["--project", "demo", "--mode", "fail"]),
  });
  const [start, end] = projectEvents(root, "demo");
  for (const event of [start!, end!]) {
    assert.equal(event.actor, "agent");
    assert.equal(event.channel, "cli");
  }
  assert.deepEqual(start!.data?.claimed, { actor: "user", channel: "console" });
  // Unprivileged channels are taken as they are.
  run(root, FIXTURE, ["--project", "demo", "--mode", "ok"], { ...ON, AGENTBROS_CHANNEL: "mcp" });
  const mcp = projectEvents(root, "demo").at(-1)!;
  assert.equal(mcp.channel, "mcp");
  assert.equal(mcp.actor, "agent");
});

test("cli.progress is throttled to one line per two seconds", (t) => {
  const root = workspace(t, ["demo"]);
  run(root, FIXTURE, ["--project", "demo", "--mode", "progress"]);
  const progress = projectEvents(root, "demo").filter((event) => event.kind === "cli.progress");
  assert.equal(progress.length, 1);
  assert.equal(progress[0]!.data?.text, "step 0");
});

test("no project directory is created: an unknown project writes nothing, a removed one is not recreated", (t) => {
  const root = workspace(t);
  const result = run(root, FIXTURE, ["--project", "ghost", "--mode", "ok"]);
  assert.equal(result.status, 0);
  assert.equal(existsSync(path.join(root, "public/projects/ghost")), false);
  assert.equal(existsSync(path.join(root, GLOBAL_EVENTS_FILE)), false, "only the listed aliases use the global file");
  // A project without pipeline/ (a template project) is not journaled: the journal creates no folder in a project.
  mkdirSync(path.join(root, "public/projects/template"));
  assert.equal(run(root, FIXTURE, ["--project", "template", "--mode", "ok"]).status, 0);
  assert.deepEqual(readdirSync(path.join(root, "public/projects/template")), []);
  // A project removed during the run: cli.end is dropped, never written into a recreated folder.
  mkdirSync(path.join(root, "public/projects/gone/pipeline"), { recursive: true });
  resetCliRun();
  const runInfo = beginCliRun({
    argv: ["node", FIXTURE, "--project", "gone"],
    env: { ...ON },
    rootDir: root,
  });
  assert.ok(runInfo);
  rmSync(path.join(root, "public/projects/gone"), { recursive: true });
  endCliRun({ ok: true, elapsedMs: 1, outputs: [] });
  assert.equal(existsSync(path.join(root, "public/projects/gone")), false);
});

test("AGENTBROS_EVENTS=off writes nothing and sets no run id", (t) => {
  const root = workspace(t, ["demo"]);
  run(root, FIXTURE, ["--project", "demo", "--mode", "ok"], { AGENTBROS_EVENTS: "off" });
  assert.equal(existsSync(path.join(root, "public/projects/demo", EVENTS_FILE)), false);
  const env: NodeJS.ProcessEnv = { AGENTBROS_EVENTS: "off" };
  assert.equal(beginCliRun({ argv: ["node", FIXTURE, "--project", "demo"], env, rootDir: root }), undefined);
  assert.equal(env.AGENTBROS_RUN_ID, undefined);
  assert.equal(eventsEnabled({}), true, "on unless switched off");
  for (const value of ["off", "0", "false", "OFF"]) assert.equal(eventsEnabled({ AGENTBROS_EVENTS: value }), false);
});

test("a journal write that fails never fails the command", (t) => {
  const root = workspace(t, ["demo"]);
  mkdirSync(path.join(root, "public/projects/demo", EVENTS_FILE), { recursive: true }); // events.jsonl is a folder
  const result = run(root, FIXTURE, ["--project", "demo", "--mode", "ok"]);
  assert.equal(result.status, 0);
  assert.equal(result.envelope.ok, true);
  resetJournalStats();
  const target = projectTarget(root, "demo")!;
  assert.equal(appendEvent(target, sample()), false);
  assert.equal(journalStats().errors, 1);
  assert.match(journalStats().lastError ?? "", /not a regular file/);
});

test("project-less runs of playbook, film:init and project:new go to out/console/events.jsonl", (t) => {
  const root = workspace(t);
  const playbook = run(root, path.join(REPO, "scripts/playbook.ts"), ["--list"], {
    ...ON,
    npm_lifecycle_event: "playbook",
  });
  assert.equal(playbook.status, 0, playbook.envelope.message);
  const init = run(root, path.join(REPO, "scripts/film-init.ts"), ["--project", "fresh"]);
  assert.equal(init.status, 0, init.envelope.message);
  const global = lines(path.join(root, GLOBAL_EVENTS_FILE));
  assert.deepEqual(
    global.map((event) => [event.kind, event.alias]),
    [
      ["cli.start", "playbook"],
      ["cli.end", "playbook"],
      ["cli.start", "film:init"],
      ["cli.end", "film:init"],
    ],
  );
  assert.equal(global[2]!.project, "fresh");
  assert.ok(
    global[3]!.outputs?.every((output) => output.startsWith("public/projects/fresh/")),
    "repository-relative",
  );
  assert.deepEqual(projectEvents(root, "fresh"), [], "the run started before its project existed");
  assert.deepEqual(
    readRecentEvents(root, { limit: 2 }).map((event) => event.kind),
    ["cli.start", "cli.end"],
  );
});

test("film:brief writes agent.dispatch with role, step, lane and the project-relative brief", (t) => {
  const root = workspace(t);
  assert.equal(run(root, path.join(REPO, "scripts/film-init.ts"), ["--project", "handoff"]).status, 0);
  copyFileSync(
    path.join(REPO, "tests/fixtures/film-chain/brief.json"),
    path.join(root, "public/projects/handoff/pipeline/brief.json"),
  );
  const brief = run(root, path.join(REPO, "scripts/film-brief.ts"), ["--project", "handoff", "--step", "intake"], {
    ...ON,
    AGENTBROS_MEMORY_ROOT: path.join(root, "memory"),
    AGENTBROS_LOCAL_DOWNLOADS: "never",
  });
  assert.equal(brief.status, 0, brief.envelope.message);
  const events = projectEvents(root, "handoff");
  assert.deepEqual(
    events.map((event) => event.kind),
    ["cli.start", "agent.dispatch", "cli.end"],
  );
  const dispatch = events[1]!;
  assert.equal(dispatch.step, "intake");
  assert.equal(dispatch.agent?.name, "brief-collector");
  assert.equal(dispatch.agent?.role, "owner");
  assert.equal(dispatch.runId, events[0]!.runId, "tied to the film:brief run");
  assert.equal(dispatch.alias, "film:brief");
  assert.equal(`public/projects/handoff/${String(dispatch.data?.brief)}`, brief.envelope.outputs[0]);
});

test("the job store writes job.state on every transition, after the commit, and only on a change", (t) => {
  const root = workspace(t, ["jobs"]);
  const directory = path.join(root, "public/projects/jobs/pipeline");
  const previous = process.env.AGENTBROS_EVENTS;
  const cwd = process.cwd();
  process.env.AGENTBROS_EVENTS = "on";
  process.chdir(root); // the store and the journal resolve projects against the working directory, as CLIs do
  t.after(() => {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.AGENTBROS_EVENTS;
    else process.env.AGENTBROS_EVENTS = previous;
  });
  resetCliRun();
  const store = new OperationStore("jobs");
  assert.equal(realpathSync(path.dirname(store.file)), realpathSync(directory));
  store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  const quote = {
    currency: "USD" as const,
    lowUsd: 1,
    expectedUsd: 1,
    highUsd: 1,
    bounded: true as const,
    source: "fixture",
    asOf: "2026-10-11",
    confidence: "published-rate" as const,
  };
  const operation = {
    operationId: "one",
    provider: "test",
    endpoint: "test/image",
    assetId: "one",
    inputHash: "one",
    quote,
  };
  store.reserveOperation(operation);
  store.reserveOperation(operation); // idempotent: no second line
  store.transitionJob("one", "submitting");
  store.transitionJob("one", "queued", { providerRequestId: "provider-id" });
  store.transitionJob("one", "queued", { providerRequestId: "provider-id" }); // same state: no line
  assert.throws(() => store.transitionJob("one", "published"), /Cannot transition/); // refused: no line
  store.transitionJob("one", "result-ready", { result: { ok: true } });
  store.reconcileBilling("one", {
    receiptId: "r-1",
    actualUsd: 0.8,
    source: "fixture",
    confirmedAt: new Date().toISOString(),
  } as never);
  const events = lines(path.join(directory, "events.jsonl"));
  assert.deepEqual(
    events.map((event) => event.data?.state),
    ["reserved", "submitting", "queued", "result-ready", "result-ready"],
  );
  for (const event of events) {
    assert.equal(event.kind, "job.state");
    assert.equal(event.project, "jobs");
    assert.equal(event.data?.jobId, "one");
    assert.equal(event.data?.provider, "test");
    assert.equal(event.data?.endpoint, "test/image");
  }
  assert.equal(events[0]!.data?.reservedUsd, 1);
  assert.equal(events.at(-1)!.costUsd, 0.8);
  assert.equal(events.at(-1)!.data?.reservedUsd, 0);
  // A journal that cannot be written never fails the store.
  rmSync(path.join(directory, "events.jsonl"));
  mkdirSync(path.join(directory, "events.jsonl"));
  assert.doesNotThrow(() => store.transitionJob("one", "downloading"));
  assert.equal(recordJobState(path.join(root, "missing"), "jobs", { operationId: "x", state: "reserved" }), false);
});

test("job.state is journaled only into the project's own pipeline: stores kept elsewhere stay silent", (t) => {
  const root = workspace(t, ["real"]);
  const previous = process.env.AGENTBROS_EVENTS;
  const cwd = process.cwd();
  process.env.AGENTBROS_EVENTS = "on";
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    if (previous === undefined) delete process.env.AGENTBROS_EVENTS;
    else process.env.AGENTBROS_EVENTS = previous;
  });
  resetCliRun();
  // A media-fetch style budget (`media-<id>`), a bench store and a fixture directory: none is a project's pipeline.
  for (const [id, directory] of [
    ["media-real", path.join(root, "public/projects/real/pipeline/media-budget")],
    ["bench", path.join(root, "bench-run")],
    ["real", path.join(root, "fixtures/pipeline")],
  ] as const) {
    mkdirSync(directory, { recursive: true });
    const store = new OperationStore(id, { directory });
    store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
    store.reserveOperation({
      operationId: "x",
      provider: "test",
      endpoint: "test/image",
      assetId: "x",
      inputHash: "x",
      quote: {
        currency: "USD",
        lowUsd: 1,
        expectedUsd: 1,
        highUsd: 1,
        bounded: true,
        source: "fixture",
        asOf: "2026-10-11",
        confidence: "published-rate",
      },
    });
    assert.equal(existsSync(path.join(directory, "events.jsonl")), false, id);
  }
  assert.equal(existsSync(path.join(root, "public/projects/real/pipeline/events.jsonl")), false);
});

// ---------------------------------------------------------------------------
// In-process writer: rotation, outputs, cost, alias, timing
// ---------------------------------------------------------------------------

function sample(overrides: Partial<contract.ConsoleEvent> = {}): contract.ConsoleEvent {
  return {
    v: 1,
    id: ulid(),
    at: new Date().toISOString(),
    project: "demo",
    kind: "cli.end",
    runId: ulid(),
    alias: "film:next",
    ok: true,
    elapsedMs: 3,
    ...overrides,
  };
}

test("rotation renames to a .rotating file, compresses it once settled, and loses no line", (t) => {
  const root = workspace(t, ["demo"]);
  const target = projectTarget(root, "demo")!;
  const directory = path.dirname(target.file);
  const written: string[] = [];
  const write = () => {
    const event = sample();
    written.push(event.id);
    assert.equal(appendEvent(target, event, { rotateBytes: 2_000 }), true);
  };
  for (let i = 0; i < 30; i++) write();
  const rotating = () =>
    readdirSync(directory)
      .filter((name) => name.endsWith(".rotating"))
      .sort();
  const archives = () =>
    readdirSync(directory)
      .filter((name) => /^events\.\d+\.jsonl\.gz$/.test(name))
      .sort((a, b) => Number(a.split(".")[1]) - Number(b.split(".")[1]));
  assert.ok(rotating().length >= 2, "renamed, not compressed on the write path while fresh");
  assert.deepEqual(archives(), []);
  // A late writer that opened the old file before the rename still lands its line in the .rotating file.
  const late = sample();
  appendFileSync(path.join(directory, rotating()[0]!), `${JSON.stringify(late)}\n`);
  // Readers see rotated-but-uncompressed lines before the live file.
  const page = readEventsFile(target.file, { limit: 1000 });
  assert.deepEqual(new Set(page.events.map((event) => event.id)), new Set([...written, late.id]));
  // Too fresh: nothing is compressed yet.
  assert.equal(finishRotations(directory), 0);
  assert.equal(finishRotations(directory, { settleMs: 0 }) >= 2, true);
  assert.deepEqual(rotating(), []);
  assert.equal(archives()[0], "events.1.jsonl.gz");
  const recovered = [
    ...archives().flatMap((name) =>
      gunzipSync(readFileSync(path.join(directory, name)))
        .toString("utf8")
        .trim()
        .split("\n"),
    ),
    ...readFileSync(target.file, "utf8").trim().split("\n"),
  ].map((line) => (JSON.parse(line) as { id: string }).id);
  assert.deepEqual(new Set(recovered), new Set([...written, late.id]));
  assert.equal(recovered.length, written.length + 1);
  // A rotation that cannot be compressed keeps its data and leaves no partial archive.
  const broken = path.join(directory, `events.${ulid()}.1.rotating`);
  mkdirSync(broken);
  const before = archives();
  assert.equal(finishRotations(directory, { settleMs: 0 }), 0);
  assert.ok(existsSync(broken));
  assert.deepEqual(archives(), before);
});

test("outputs, cost and alias helpers", () => {
  const root = path.resolve("/tmp/root-x");
  const base = path.join(root, "public/projects/demo");
  assert.deepEqual(
    relativeOutputs(
      ["public/projects/demo/a.json", "out/demo/b.mp4", path.join(base, "c.md"), "/elsewhere/d", 3],
      root,
      base,
    ),
    ["a.json", "out/demo/b.mp4", "c.md"],
  );
  assert.equal(costFromMetadata({ costUsd: 1.5 }), 1.5);
  assert.equal(costFromMetadata({ billing: { actualUsd: 0.04 } }), 0.04);
  assert.equal(costFromMetadata({ receipt: { costUsd: 0.2 } }), 0.2);
  assert.equal(costFromMetadata({ quote: { expectedUsd: 3 } }), undefined, "a quote is not a cost");
  assert.equal(costFromMetadata({ costUsd: -1 }), undefined);
  const script = path.join(REPO, "scripts/film-brief.ts");
  assert.equal(aliasOf(script, {}), "film:brief");
  assert.equal(aliasOf(script, { npm_lifecycle_event: "test" }), "film:brief", "an inherited lifecycle is not trusted");
  assert.equal(aliasOf(path.join(REPO, "scripts/create-project.ts"), {}), "project:new");
  assert.equal(aliasOf(undefined, {}), "unknown");
});

test("cli.progress and cli.end in process: throttle, one cli.end per run, global target for listed aliases", (t) => {
  const root = workspace(t, ["demo"]);
  resetCliRun();
  const env: NodeJS.ProcessEnv = { ...ON, AGENTBROS_RUN_ID: "parent-run" };
  const started = beginCliRun({
    argv: ["node", path.join(REPO, "scripts/film-next.ts"), "--project", "demo"],
    env,
    rootDir: root,
    now: 1_000_000,
  });
  assert.ok(started);
  assert.equal(started.parentRunId, "parent-run");
  assert.equal(env.AGENTBROS_RUN_ID, started.runId, "children inherit this run");
  cliProgress("rendering %d", [1], 1_000_100);
  cliProgress("rendering 2", [], 1_001_000);
  cliProgress("rendering 3", [], 1_002_200);
  endCliRun({ ok: false, error: "TIMEOUT", message: "slow", elapsedMs: 5 }, 1_003_000);
  endCliRun({ ok: true, elapsedMs: 6 }, 1_004_000);
  const events = projectEvents(root, "demo");
  assert.deepEqual(
    events.map((event) => [event.kind, event.data?.text ?? event.error ?? ""]),
    [
      ["cli.start", ""],
      ["cli.progress", "rendering 1"],
      ["cli.progress", "rendering 3"],
      ["cli.end", "TIMEOUT"],
    ],
  );
  assert.equal(events[0]!.alias, "film:next");
  resetCliRun();
  const global = beginCliRun({
    argv: ["node", path.join(REPO, "scripts/playbook.ts"), "--match", "x"],
    env: { ...ON },
    rootDir: root,
  });
  assert.equal(global?.target.file, globalTarget(root).file);
  resetCliRun();
});

test("writing one line stays under 2 ms (benchmark, warn only)", (t) => {
  const root = workspace(t, ["demo"]);
  const target = projectTarget(root, "demo")!;
  appendEvent(target, sample());
  const runs = 300;
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i++) appendEvent(target, sample({ argv: ["--project", "demo", "--step", "build"] }));
  const meanMs = Number(process.hrtime.bigint() - started) / 1e6 / runs;
  t.diagnostic(`journal append: ${meanMs.toFixed(3)} ms per line`);
  if (meanMs > 2)
    process.stderr.write(`[console-journal] warning: ${meanMs.toFixed(2)} ms per journal line (budget 2 ms)\n`);
});

// ---------------------------------------------------------------------------
// Reader API (for WP2 and WP3)
// ---------------------------------------------------------------------------

test("readEvents pages by id, skips torn and garbage lines, and survives a rotated-away cursor", (t) => {
  const root = workspace(t, ["demo"]);
  const target = projectTarget(root, "demo")!;
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const event = sample();
    ids.push(event.id);
    appendEvent(target, event);
    if (i === 2) appendFileSync(target.file, 'garbage\n{"v":1,"id":"torn\n{"v":2}\n');
  }
  appendFileSync(target.file, '{"v":1,"id":"01KA'); // torn last line
  const first = readEvents(root, "demo", { limit: 2 });
  assert.deepEqual(
    first.events.map((event) => event.id),
    ids.slice(0, 2),
  );
  assert.equal(first.next, ids[1]);
  const second = readEvents(root, "demo", { since: first.next!, limit: 10 });
  assert.deepEqual(
    second.events.map((event) => event.id),
    ids.slice(2),
  );
  assert.equal(second.next, null);
  assert.equal(contract.EventsPageSchema.safeParse(second).success, true);
  assert.deepEqual(readEvents(root, "demo", { since: ids[4] }).events, []);
  // A cursor whose line is gone (rotated): everything sorting after it.
  writeFileSync(target.file, readFileSync(target.file, "utf8").split("\n").slice(3).join("\n"));
  assert.deepEqual(
    readEventsFile(target.file, { since: ids[1] }).events.map((event) => event.id),
    ids.slice(3),
  );
  assert.deepEqual(readEvents(root, "other").events, [], "no journal: an empty page");
  assert.throws(() => readEvents(root, "../escape"));
});

test("readEventsAfter tails by byte offset, waits for a torn line, and resets after rotation", (t) => {
  const root = workspace(t, ["demo"]);
  const target = projectTarget(root, "demo")!;
  assert.deepEqual(readEventsAfter(target.file).events, []);
  appendEvent(target, sample());
  appendEvent(target, sample());
  const first = readEventsAfter(target.file);
  assert.equal(first.events.length, 2);
  assert.equal(first.reset, false);
  const half = JSON.stringify(sample());
  appendFileSync(target.file, half.slice(0, 20));
  const waiting = readEventsAfter(target.file, first.cursor);
  assert.deepEqual(waiting.events, []);
  assert.equal(waiting.cursor.offset, first.cursor.offset);
  appendFileSync(target.file, `${half.slice(20)}\n`);
  const completed = readEventsAfter(target.file, waiting.cursor);
  assert.equal(completed.events.length, 1);
  // Rotation: a line written to the old file after the reader's cursor is still delivered, then the new file's.
  const missed = sample();
  appendFileSync(target.file, `${JSON.stringify(missed)}\n`);
  renameSync(target.file, path.join(path.dirname(target.file), `events.${ulid()}.1.rotating`));
  const fresh = sample();
  appendEvent(target, fresh);
  const rotated = readEventsAfter(target.file, completed.cursor);
  assert.equal(rotated.reset, true);
  assert.deepEqual(
    rotated.events.map((event) => event.id),
    [missed.id, fresh.id],
  );
});
