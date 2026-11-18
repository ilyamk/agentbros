/**
 * Stop's per-job cancel (RFC 0004 D12, §8, A9): only on the user's per-job request, only where the provider supports
 * it, settled only by the provider's own status, unavailable cancellations recorded and never faked; `job:cancel`'s
 * CLI contract; the console server's control and cancel endpoints over an injected CLI runner.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { loadOrCreateSessionToken } from "../src/lib/console/session";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { cancelJob, cancelSupport, jobSummary, type HiggsfieldCancelClient } from "../src/lib/jobs/cancel";
import { OperationStore } from "../src/lib/jobs/store";
import { runGenerationStep, type JobProvider } from "../src/lib/jobs/runner";
import { claimOperationWork } from "../src/lib/jobs/work-lease";
import { controlActions, type CliRunner } from "../src/lib/console/control-actions";
import { notImplementedActions } from "../src/lib/console/data";
import {
  ControlResponseSchema,
  JobCancelResponseSchema,
  type CliEnvelope,
  type ControlFile,
} from "../src/types/console";
import { USER_GRANT } from "./helpers/ceiling-grant";
import {
  makeRoot,
  postHeaders,
  raw,
  removeRoot,
  startTestServer,
  PROJECT as SERVER_PROJECT,
} from "./helpers/console-server";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const PROJECT = "demo-film";
const WORDS = "Cancel this one, please.";

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

function setup(t: TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-cancel-")));
  loadOrCreateSessionToken(root); // the console signs its spawns with this checkout's token (grant.ts)
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "public/projects", PROJECT);
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  const store = new OperationStore(PROJECT, { directory: path.join(dir, "pipeline") });
  store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  return { root, dir, store };
}

const submitted = (requestId: string): JobProvider => ({
  submit: async () => ({ requestId }),
  inspect: async () => ({ state: "queued" }),
});

async function submit(store: OperationStore, id: string, provider: string) {
  return runGenerationStep({
    store,
    operation: { operationId: id, provider, endpoint: "test/model", assetId: `asset-${id}`, quote: bound },
    input: { prompt: id },
    provider: submitted(`req-${id.replace(/\W/g, "")}`),
  });
}

/** A fake Higgsfield client: records calls; `status` answers what the test says the provider reports. */
function fakeHiggsfield(status: string, options: { refuse?: boolean } = {}) {
  const calls: string[] = [];
  const client: HiggsfieldCancelClient = {
    cancel: async (value: string) => {
      calls.push(`cancel ${value}`);
      if (options.refuse) throw new Error("HTTP 400: request is already processing");
      return {};
    },
    status: async (value: string) => {
      calls.push(`status ${value}`);
      return { status, request_id: value };
    },
  } as unknown as HiggsfieldCancelClient;
  return { client, calls };
}

test("a submitted Higgsfield job is cancelled only when the provider reports it canceled; no charge, released", async (t) => {
  const { dir, store } = setup(t);
  await submit(store, "op:hf", "higgsfield");
  const { client, calls } = fakeHiggsfield("canceled");
  const result = await cancelJob({ store, operationId: "op:hf", answer: WORDS, higgsfield: () => client });
  assert.equal(result.outcome, "cancelled");
  assert.deepEqual(calls, ["cancel req-ophf", "status req-ophf"]);
  const job = store.snapshot().jobs["op:hf"]!;
  assert.equal(job.state, "cancelled");
  assert.equal(job.reservedMicros, 0);
  assert.equal(job.release?.reason, "confirmed-no-charge");
  assert.equal(job.cancellation?.answer, WORDS);
  assert.equal(job.cancellation?.outcome, "cancelled");
  const ledger = readFileSync(path.join(dir, "pipeline/cost-ledger.jsonl"), "utf8");
  assert.match(ledger, /"operationId":"op:hf".*"actualUsd":0/);
});

test("an accepted cancel the provider does not show yet is 'requested'; a refused one keeps the job and its money", async (t) => {
  const { store } = setup(t);
  await submit(store, "op:a", "higgsfield");
  await submit(store, "op:b", "higgsfield");
  const pending = await cancelJob({
    store,
    operationId: "op:a",
    answer: WORDS,
    higgsfield: () => fakeHiggsfield("in_progress").client,
  });
  assert.equal(pending.outcome, "requested");
  assert.equal(store.snapshot().jobs["op:a"]!.state, "queued", "unchanged until the provider says so");
  assert.equal(store.snapshot().jobs["op:a"]!.reservedMicros, 500_000);
  const refused = await cancelJob({
    store,
    operationId: "op:b",
    answer: WORDS,
    higgsfield: () => fakeHiggsfield("queued", { refuse: true }).client,
  });
  assert.equal(refused.outcome, "refused");
  assert.match(refused.message, /keeps running and its result will be kept/);
  assert.equal(store.snapshot().jobs["op:b"]!.state, "queued");
  assert.equal(store.snapshot().jobs["op:b"]!.cancellation?.outcome, "refused");
  const finished = await cancelJob({
    store,
    operationId: "op:a",
    answer: WORDS,
    higgsfield: () => fakeHiggsfield("completed").client,
  });
  assert.equal(finished.outcome, "refused", "finished first: nothing cancelled, the result is kept");
});

test("fal and finished jobs are marked unavailable, never faked; no provider call is made", async (t) => {
  const { store } = setup(t);
  await submit(store, "op:fal", "fal");
  let built = 0;
  const result = await cancelJob({
    store,
    operationId: "op:fal",
    answer: WORDS,
    higgsfield: () => {
      built++;
      return fakeHiggsfield("canceled").client;
    },
  });
  assert.equal(result.outcome, "unavailable");
  assert.match(result.message, /fal job adapter has no cancel call/);
  assert.equal(built, 0);
  const job = store.snapshot().jobs["op:fal"]!;
  assert.equal(job.state, "queued");
  assert.equal(job.reservedMicros, 500_000);
  assert.deepEqual(
    { outcome: job.cancellation?.outcome, answer: job.cancellation?.answer },
    { outcome: "unavailable", answer: WORDS },
  );
  assert.equal(cancelSupport(job).cancellable, false);
  // An ambiguous submit cannot be cancelled either.
  const unknown = { ...job, state: "unknown" as const, providerRequestId: undefined };
  assert.match(cancelSupport(unknown).reason!, /outcome is unknown/);
  assert.match(cancelSupport({ ...job, state: "result-ready" }).reason!, /result-ready/);
});

test("a reserved, unsubmitted job is cancelled locally and its reservation released; a busy job is not touched", async (t) => {
  const { store } = setup(t);
  store.reserveOperation({
    operationId: "op:reserved",
    provider: "fal",
    endpoint: "test/model",
    assetId: "asset-reserved",
    inputHash: "a".repeat(64),
    quote: bound,
  });
  await submit(store, "op:busy", "higgsfield");
  const release = claimOperationWork(store, "op:busy")!;
  const busy = await cancelJob({
    store,
    operationId: "op:busy",
    answer: WORDS,
    higgsfield: () => fakeHiggsfield("canceled").client,
  });
  assert.equal(busy.outcome, "busy");
  assert.equal(store.snapshot().jobs["op:busy"]!.cancellation, undefined);
  release();
  const local = await cancelJob({ store, operationId: "op:reserved", answer: WORDS });
  assert.equal(local.outcome, "cancelled");
  const job = store.snapshot().jobs["op:reserved"]!;
  assert.equal(job.state, "cancelled");
  assert.equal(job.reservedMicros, 0);
  assert.equal(job.release?.reason, "not-submitted");
  await assert.rejects(cancelJob({ store, operationId: "op:none", answer: WORDS }), /No paid job op:none/);
});

function cli(root: string, args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_NO_DOTENV: "1", AGENTBROS_STEP_ADMITTED: "" };
  delete env.HIGGSFIELD_API_KEY;
  delete env.FAL_KEY;
  const run = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/job-cancel.ts"), ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  return { status: run.status, json: JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as Record<string, any> };
}

test("job:cancel: CLI contract, one job per call, the user's words required, runs while stopped", async (t) => {
  const { root, dir, store } = setup(t);
  await submit(store, "op:fal", "fal");
  await submit(store, "op:hf", "higgsfield"); // before the stop: the store submits nothing while stopped
  mkdirSync(path.join(dir, "pipeline/session"), { recursive: true });
  const control: ControlFile = {
    v: 1,
    state: "stopped",
    by: "user",
    channel: "console",
    at: "2026-11-17T09:00:00Z",
    answer: "Stop everything.",
    history: [
      { state: "stopped", by: "user", channel: "console", at: "2026-11-17T09:00:00Z", answer: "Stop everything." },
    ],
  };
  writeFileSync(path.join(dir, "pipeline/session/control.json"), JSON.stringify(control));
  const unavailable = cli(root, ["--project", PROJECT, "--operation-id", "op:fal", "--answer", WORDS]);
  assert.equal(unavailable.status, 0, JSON.stringify(unavailable.json));
  assert.equal(unavailable.json.metadata.outcome, "unavailable");
  assert.equal(unavailable.json.metadata.job.cancellable, false);
  assert.equal(unavailable.json.metadata.job.id, "op:fal");
  const unknown = cli(root, ["--project", PROJECT, "--operation-id", "op:none", "--answer", WORDS]);
  assert.equal(unknown.json.error, "INVALID_INPUT");
  assert.equal(unknown.json.details.unknownJob, true);
  assert.equal(
    cli(root, ["--project", PROJECT, "--operation-id", "op:fal", "--answer", "TODO"]).json.error,
    "INVALID_INPUT",
  );
  assert.equal(
    cli(root, ["--project", "nope", "--operation-id", "op:fal", "--answer", WORDS]).json.error,
    "PROJECT_NOT_FOUND",
  );
  assert.equal(
    cli(root, ["--project", PROJECT, "--operation-id", "../x", "--answer", WORDS]).json.error,
    "INVALID_INPUT",
  );
  // A submitted Higgsfield job without a key fails before any provider call and records nothing.
  const noKey = cli(root, ["--project", PROJECT, "--operation-id", "op:hf", "--answer", WORDS]);
  assert.equal(noKey.json.ok, false);
  assert.equal(store.snapshot().jobs["op:hf"]!.cancellation, undefined);
  assert.equal(store.snapshot().jobs["op:hf"]!.state, "queued");
  assert.ok(existsSync(path.join(dir, "pipeline/operations.json")));
});

// --- Server: POST /control and POST /jobs/:jobId/cancel over an injected runner (no CLI is spawned). ---

const CONTROL: ControlFile = {
  v: 1,
  state: "stopped",
  by: "user",
  channel: "console",
  at: "2026-11-17T09:00:00.000Z",
  answer: "Stop.",
  history: [{ state: "stopped", by: "user", channel: "console", at: "2026-11-17T09:00:00.000Z", answer: "Stop." }],
};
const JOB = {
  id: "op:hf",
  provider: "higgsfield",
  state: "queued",
  reservedUsd: 0.5,
  priceKnown: true,
  cancellable: true,
};

test("console server: control spawns console:control with the user's words; cancel spawns job:cancel per job", async (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const calls: { script: string; args: string[] }[] = [];
  const run: CliRunner = async (_root, script, args) => {
    calls.push({ script, args });
    const envelope: CliEnvelope =
      script === "console-control.ts"
        ? { ok: true, outputs: [], metadata: { control: CONTROL, runningJobs: [JOB] }, elapsedMs: 1 }
        : args.includes("op:none")
          ? { ok: false, error: "INVALID_INPUT", message: "No paid job op:none", details: { unknownJob: true } }
          : {
              ok: true,
              outputs: [],
              metadata: { outcome: "cancelled", job: { ...JOB, state: "cancelled" }, message: "done" },
              elapsedMs: 1,
            };
    return envelope;
  };
  const server = await startTestServer(root, { actions: { ...notImplementedActions, ...controlActions(root, run) } });
  t.after(() => server.close());
  const post = (target: string, body: unknown) =>
    raw(server.port, { method: "POST", path: target, headers: postHeaders(server), body: JSON.stringify(body) });

  const stop = await post(`/api/projects/${SERVER_PROJECT}/control`, {
    state: "stopped",
    answer: "Stop.",
    reason: "Wrong",
  });
  assert.equal(stop.status, 200, stop.text);
  const reply = ControlResponseSchema.parse(stop.json());
  assert.equal(reply.runningJobs?.[0]?.id, "op:hf");
  assert.deepEqual(calls[0], {
    script: "console-control.ts",
    args: ["--project", SERVER_PROJECT, "--state", "stopped", "--answer=Stop.", "--reason=Wrong"],
  });
  // Nothing is cancelled by the stop: cancel is a separate request per job.
  assert.equal(calls.length, 1);
  const cancel = await post(`/api/projects/${SERVER_PROJECT}/jobs/op:hf/cancel`, { answer: WORDS });
  assert.equal(cancel.status, 200, cancel.text);
  assert.equal(JobCancelResponseSchema.parse(cancel.json()).outcome, "cancelled");
  assert.deepEqual(calls[1], {
    script: "job-cancel.ts",
    args: ["--project", SERVER_PROJECT, "--operation-id", "op:hf", `--answer=${WORDS}`],
  });
  assert.equal((await post(`/api/projects/${SERVER_PROJECT}/jobs/op:none/cancel`, { answer: WORDS })).status, 404);
  assert.equal((await post(`/api/projects/${SERVER_PROJECT}/jobs/op:hf/cancel`, { answer: " " })).status, 400);
  assert.equal(
    (await post(`/api/projects/${SERVER_PROJECT}/jobs/op:hf/cancel`, { answer: WORDS, extra: 1 })).status,
    400,
  );
  assert.equal((await post(`/api/projects/${SERVER_PROJECT}/jobs/..%2Fx/cancel`, { answer: WORDS })).status, 400);
  assert.equal((await post(`/api/projects/nope/jobs/op:hf/cancel`, { answer: WORDS })).status, 404);
  assert.equal(calls.length, 3, "invalid requests spawn nothing");
});

test("console server: without a cancelJob action the endpoint answers 501", async (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const server = await startTestServer(root);
  t.after(() => server.close());
  const res = await raw(server.port, {
    method: "POST",
    path: `/api/projects/${SERVER_PROJECT}/jobs/op:hf/cancel`,
    headers: postHeaders(server),
    body: JSON.stringify({ answer: WORDS }),
  });
  assert.equal(res.status, 501);
});

test("console server: the real runner spawns console:control as the user from the console", async (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  loadOrCreateSessionToken(root); // a running console has its token: it signs the spawn (grant.ts)
  const actions = controlActions(root);
  const reply = await actions.control!(SERVER_PROJECT, { state: "paused", answer: "Pause, please." });
  assert.equal(reply.ok, true);
  assert.equal(reply.control.state, "paused");
  assert.equal(reply.control.channel, "console");
  assert.equal(reply.control.answer, "Pause, please.");
  // Without a token there is no grant: the same spawn is recorded as a CLI run, never as the console's.
  const unsigned = makeRoot();
  t.after(() => removeRoot(unsigned));
  const plain = await controlActions(unsigned).control!(SERVER_PROJECT, { state: "paused", answer: "Pause." });
  assert.equal(plain.control.channel, "cli");
  await assert.rejects(actions.control!("no-such-project", { state: "paused", answer: "Pause." }), /not found/);
});

test("an accepted cancel whose status read fails is still recorded as requested; the job keeps its reservation", async (t) => {
  const { store } = setup(t);
  await submit(store, "op:hf", "higgsfield");
  const client = {
    cancel: async () => ({}),
    status: async () => {
      throw new Error("network down");
    },
  } as unknown as HiggsfieldCancelClient;
  const result = await cancelJob({ store, operationId: "op:hf", answer: WORDS, higgsfield: () => client });
  assert.equal(result.outcome, "requested");
  assert.match(result.message, /network down/);
  const job = store.snapshot().jobs["op:hf"]!;
  assert.equal(job.state, "queued");
  assert.equal(job.reservedMicros, 500_000);
  assert.equal(job.cancellation?.outcome, "requested");
});

test("a stop whose operation store cannot be read still stops, and says so", (t) => {
  const { root, dir } = setup(t);
  writeFileSync(path.join(dir, "pipeline/operations.json"), "{ broken");
  const env: NodeJS.ProcessEnv = { ...process.env, AGENTBROS_NO_DOTENV: "1", AGENTBROS_STEP_ADMITTED: "" };
  const run = spawnSync(
    process.execPath,
    [
      TSX,
      path.join(REPO, "scripts/console-control.ts"),
      "--project",
      PROJECT,
      "--state",
      "stopped",
      "--answer",
      "Stop.",
    ],
    { cwd: root, encoding: "utf8", env },
  );
  const json = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  assert.equal(json.ok, true);
  assert.equal(json.metadata.state, "stopped");
  assert.match(json.metadata.runningJobsError, /could not be listed/);
  assert.equal(json.metadata.runningJobs, undefined);
});

// --- Review regressions: money is never left reserved by a half-done cancel; cancellable follows the state. ---

test("a crash after the release leaves no reservation behind (local and Higgsfield), and a failed release is 'requested'", async (t) => {
  const { store } = setup(t);
  store.reserveOperation({
    operationId: "op:local",
    provider: "fal",
    endpoint: "test/model",
    assetId: "asset-local",
    inputHash: "b".repeat(64),
    quote: bound,
  });
  await submit(store, "op:hf", "higgsfield");
  const original = store.transitionJob.bind(store);
  store.transitionJob = ((id: string, next: string, patch?: object) => {
    if (next === "cancelled") throw new Error("crash before the state change");
    return original(id, next as never, patch as never);
  }) as typeof store.transitionJob;
  await assert.rejects(cancelJob({ store, operationId: "op:local", answer: WORDS }), /crash/);
  assert.equal(store.snapshot().jobs["op:local"]!.reservedMicros, 0, "released before the crash");
  await assert.rejects(
    cancelJob({ store, operationId: "op:hf", answer: WORDS, higgsfield: () => fakeHiggsfield("canceled").client }),
    /crash/,
  );
  const hf = store.snapshot().jobs["op:hf"]!;
  assert.equal(hf.reservedMicros, 0);
  assert.equal(hf.release?.source, "higgsfield status: canceled", "the runner's own confirmation: a resume repeats it");
  store.transitionJob = original;
  // A resume after the crash settles the job without a conflict.
  const resumed = await runGenerationStep({
    store,
    operation: {
      operationId: "op:hf",
      provider: "higgsfield",
      endpoint: "test/model",
      assetId: "asset-op:hf",
      quote: bound,
    },
    input: { prompt: "op:hf" },
    provider: {
      submit: async () => ({ requestId: "x" }),
      inspect: async () => ({ state: "failed", message: "canceled", refunded: true }),
    },
  });
  assert.equal(resumed.state, "failed");
  assert.equal(resumed.reservedMicros, 0);

  await submit(store, "op:hf2", "higgsfield");
  store.confirmNoCharge = () => {
    throw new Error("disk full");
  };
  const failed = await cancelJob({
    store,
    operationId: "op:hf2",
    answer: WORDS,
    higgsfield: () => fakeHiggsfield("canceled").client,
  });
  assert.equal(failed.outcome, "requested");
  assert.match(failed.message, /disk full/);
  assert.equal(store.snapshot().jobs["op:hf2"]!.state, "queued", "left for the next resume to settle");
});

test("cancellable follows the job's current state, not an earlier recorded outcome", async (t) => {
  const { store } = setup(t);
  await submit(store, "op:hf", "higgsfield");
  const job = store.snapshot().jobs["op:hf"]!;
  const stale = { ...job, cancellation: { at: job.updatedAt, answer: WORDS, outcome: "unavailable" as const } };
  assert.equal(jobSummary(stale).cancellable, true);
  assert.equal(jobSummary({ ...stale, state: "result-ready" }).cancellable, false);
});

test("console server: the user's words may start with a dash", async (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const reply = await controlActions(root).control!(SERVER_PROJECT, {
    state: "paused",
    answer: "-- hold on",
    reason: "-x",
  });
  assert.equal(reply.control.answer, "-- hold on");
  assert.equal(reply.control.reason, "-x");
});
