/**
 * RFC 0004 acceptance gaps closed in the console (A9, A10/US14, H3): `policy` decisions (autonomy and budget ceiling)
 * planned per route, applied once per request id through the real `film:policy` and `budget`, journalled; the hooks
 * status and install endpoints; a non-cancellable job says why.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  DecisionRequestSchema,
  DecisionSchema,
  HooksInstallResponseSchema,
  HooksResponseSchema,
  type CliEnvelope,
  type DecisionRequest,
} from "../src/types/console";
import { createDecisionActions } from "../src/lib/console/apply";
import { controlActions, type CliRunner } from "../src/lib/console/control-actions";
import { notImplementedActions } from "../src/lib/console/data";
import { listDecisions, readInbox } from "../src/lib/console/inbox";
import { createSpawnCli, type SpawnRequest } from "../src/lib/console/spawn";
import { planPolicy } from "../src/lib/console/user-actions";
import { currentPolicy } from "../src/lib/autonomy/policy";
import { jobSummary } from "../src/lib/jobs/cancel";
import { OperationStore } from "../src/lib/jobs/store";
import type { GenerationJob } from "../src/lib/jobs/types";
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
const AT = "2026-11-17T10:00:00.000Z";
const OK: CliEnvelope = { ok: true, outputs: [], metadata: {}, elapsedMs: 5 };
const WORDS = "--yes: raise it to twelve dollars";

const policy = (
  change: DecisionRequest["policy"],
  extra: Partial<DecisionRequest> = {},
): DecisionRequest & {
  kind: "policy";
} => ({ kind: "policy", answer: WORDS, policy: change, ...extra }) as DecisionRequest & { kind: "policy" };

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    const e = error as { status?: number; code?: string };
    return `${e.status} ${e.code}`;
  }
};

function harness(
  options: { route?: string; storeCeiling?: number; answer?: (request: SpawnRequest) => CliEnvelope } = {},
) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-gaps-policy-")));
  mkdirSync(path.join(root, "public/projects", PROJECT, "pipeline"), { recursive: true });
  const calls: SpawnRequest[] = [];
  const actions = createDecisionActions(root, {
    deriveWaiting: async () => [],
    spawnCli: async (request) => {
      calls.push(request);
      return { envelope: options.answer?.(request) ?? OK, exitCode: 0 };
    },
    now: () => new Date(AT),
    routeOf: () => options.route ?? "film",
    stepExpects: () => undefined,
    storeCeilingOf: () => options.storeCeiling,
    env: { ...process.env, AGENTBROS_EVENTS: "on" },
  });
  return { root, calls, actions, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("contract: a policy request carries its change, and only a policy request does", () => {
  assert.equal(DecisionRequestSchema.safeParse({ kind: "policy", answer: "Yes." }).success, false);
  assert.equal(DecisionRequestSchema.safeParse({ kind: "policy", answer: "Yes.", policy: {} }).success, false);
  assert.equal(
    DecisionRequestSchema.safeParse({ kind: "rating", answer: "Yes.", policy: { ceilingUsd: 3 } }).success,
    false,
  );
  assert.equal(
    DecisionRequestSchema.safeParse({ kind: "policy", answer: "Yes.", policy: { ceilingUsd: -1 } }).success,
    false,
  );
  assert.equal(
    DecisionRequestSchema.safeParse({ kind: "policy", answer: "Yes.", policy: { autonomy: "autonomous" } }).success,
    true,
  );
});

test("policy plan: film:policy on a film, budget for another project's ceiling; the words one token", () => {
  const film = planPolicy(PROJECT, policy({ autonomy: "autonomous", ceilingUsd: 12 }), { route: "film" });
  assert.deepEqual(film.command, {
    alias: "film:policy",
    args: ["--project", PROJECT, "--autonomy", "autonomous", `--answer=${WORDS}`, "--ceiling-usd", "12"],
  });
  assert.equal(film.followUps, undefined);
  assert.deepEqual(film.decision.policy, { autonomy: "autonomous", ceilingUsd: 12 });
  assert.equal(film.decision.title, "Policy: autonomy autonomous, ceiling $12");

  const ceiling = planPolicy(PROJECT, policy({ ceilingUsd: 12 }), { route: "film", storeCeilingUsd: 10 });
  assert.deepEqual(ceiling.command.args, ["--project", PROJECT, `--answer=${WORDS}`, "--ceiling-usd", "12"]);
  assert.equal(ceiling.followUps, undefined, "film:policy raises the store's ceiling itself");

  // film:policy never lowers the job store's ceiling: a lower one also runs budget on the same words.
  const lower = planPolicy(PROJECT, policy({ ceilingUsd: 4 }), { route: "film", storeCeilingUsd: 10 });
  assert.equal(lower.command.alias, "film:policy");
  assert.deepEqual(lower.followUps, [
    { alias: "budget", args: ["--project", PROJECT, "--ceiling-usd", "4", `--answer=${WORDS}`] },
  ]);

  const footage = planPolicy(PROJECT, policy({ ceilingUsd: 3 }), { route: "footage" });
  assert.deepEqual(footage.command, {
    alias: "budget",
    args: ["--project", PROJECT, "--ceiling-usd", "3", `--answer=${WORDS}`],
  });
  assert.equal(
    planPolicy(PROJECT, policy({ autonomy: "interactive" }), { route: "footage" }).command.alias,
    "film:policy",
  );
  assert.equal(planPolicy(PROJECT, policy({ ceilingUsd: 2 }), { route: "timeline" }).command.alias, "budget");
  assert.throws(
    () => planPolicy(PROJECT, policy({ autonomy: "autonomous" }), { route: "timeline" }),
    /film or a recording/,
  );
  assert.throws(() => planPolicy(PROJECT, policy({ ceilingUsd: 2 }, { expect: "a".repeat(64) }), { route: "film" }));
});

test("policy decide: dry run spawns nothing; a request id applies once; a different amount is a new decision", async (t) => {
  const h = harness({ storeCeiling: 10 });
  t.after(h.done);
  const dry = await h.actions.decide(PROJECT, policy({ ceilingUsd: 12 }), { dryRun: true });
  assert.equal(dry.decision.status, "pending");
  assert.deepEqual(dry.decision.argv, [
    "pnpm",
    "film:policy",
    "--project",
    PROJECT,
    `--answer=${WORDS}`,
    "--ceiling-usd",
    "12",
  ]);
  assert.equal(h.calls.length, 0);

  const first = await h.actions.decide(PROJECT, policy({ ceilingUsd: 12 }, { requestId: "req-1" }));
  const again = await h.actions.decide(PROJECT, policy({ ceilingUsd: 12 }, { requestId: "req-1" }));
  assert.equal(first.ok, true);
  assert.equal(again.decision.id, first.decision.id);
  assert.equal(h.calls.length, 1, "the same request id runs once");
  assert.equal(
    await failure(h.actions.decide(PROJECT, policy({ ceilingUsd: 20 }, { requestId: "req-1" }))),
    "409 ALREADY_DECIDED",
  );
  // Without a request id, the same words with another amount are another decision, not a double click.
  await h.actions.decide(PROJECT, policy({ ceilingUsd: 15 }));
  await h.actions.decide(PROJECT, policy({ ceilingUsd: 16 }));
  assert.equal(h.calls.length, 3);
  const stored = readInbox(h.root, PROJECT, first.decision.id)!;
  assert.equal(stored.kind, "policy");
  assert.equal(stored.answer, WORDS);
  assert.deepEqual(stored.policy, { ceilingUsd: 12 });
  assert.equal(stored.channel, "console");
  const events = listDecisions(h.root, PROJECT).events.filter((event) => event.kind === "decision.applied");
  assert.equal(events.length, 3);
  assert.equal(events[0]!.data!.decisionKind, "policy");
  assert.equal(events[0]!.channel, "console");
});

test("policy decide: a refused CLI is shown verbatim; a failed follow-up leaves the decision partial", async (t) => {
  const refused = harness({
    answer: () => ({ ok: false, error: "VALIDATION", message: "autonomous needs a budget", elapsedMs: 1 }),
  });
  t.after(refused.done);
  const reply = await refused.actions.decide(PROJECT, policy({ autonomy: "autonomous" }));
  assert.equal(reply.ok, false);
  assert.equal(reply.decision.status, "refused");
  assert.equal(reply.decision.result?.message, "autonomous needs a budget");

  const partial = harness({
    storeCeiling: 10,
    answer: (request) =>
      request.alias === "budget" ? { ok: false, error: "VALIDATION", message: "below reserved", elapsedMs: 1 } : OK,
  });
  t.after(partial.done);
  const lowered = await partial.actions.decide(PROJECT, policy({ ceilingUsd: 1 }));
  assert.deepEqual(
    partial.calls.map((call) => call.alias),
    ["film:policy", "budget"],
  );
  assert.equal(lowered.ok, false);
  assert.equal(lowered.decision.status, "partial");
  assert.equal(DecisionSchema.parse(lowered.decision).kind, "policy");
});

test("policy decide end to end: the real film:policy and budget record the user's words from the console", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "avc-gaps-policy-real-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" };
  const init = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/film-init.ts"), "--project", "film"], {
    cwd: root,
    encoding: "utf8",
    env,
  });
  assert.equal(init.status, 0, init.stdout + init.stderr);
  const actions = createDecisionActions(root, { deriveWaiting: async () => [], spawnCli: createSpawnCli() });
  const raised = await actions.decide("film", {
    kind: "policy",
    answer: "Up to $12, please.",
    policy: { ceilingUsd: 12 },
  });
  assert.equal(raised.ok, true, JSON.stringify(raised.decision.result));
  const dir = path.join(root, "public/projects/film");
  assert.equal(currentPolicy(dir)?.budget?.ceilingUsd, 12);
  const store = () => new OperationStore("film", { directory: path.join(dir, "pipeline") });
  assert.equal(store().ceilingUsd(), 12, "film:policy installs the job store's ceiling on the same words");
  assert.match(readFileSync(path.join(dir, "pipeline/policy.json"), "utf8"), /Up to \$12, please\./);

  const lowered = await actions.decide("film", { kind: "policy", answer: "Back to $5.", policy: { ceilingUsd: 5 } });
  assert.equal(lowered.ok, true, JSON.stringify(lowered.decision.result));
  assert.equal(currentPolicy(dir)?.budget?.ceilingUsd, 5);
  assert.equal(store().ceilingUsd(), 5, "a lower ceiling reaches the job store through budget");
});

test("hooks: GET /api/hooks reports this checkout's status; install runs harness:setup --hooks --apply", async (t) => {
  const root = makeRoot();
  t.after(() => removeRoot(root));
  const calls: { script: string; args: string[] }[] = [];
  const run: CliRunner = async (_root, script, args) => {
    calls.push({ script, args });
    return {
      ok: true,
      outputs: [".claude/settings.local.json"],
      metadata: {
        mode: "hooks-apply",
        hooks: [{ next: "x".repeat(10_000) }],
        status: { claude: "installed", codex: "installed" },
        trust: ["Claude Code: accept the workspace trust dialog once."],
      },
      elapsedMs: 1,
    };
  };
  const server = await startTestServer(root, { actions: { ...notImplementedActions, ...controlActions(root, run) } });
  t.after(() => server.close());
  assert.equal((await raw(server.port, { path: "/api/hooks" })).status, 403, "the session is required");
  const read = await raw(server.port, { path: "/api/hooks", headers: { "x-console-token": server.token } });
  assert.equal(read.status, 200, read.text);
  const hooks = HooksResponseSchema.parse(read.json());
  assert.deepEqual(hooks.status, { claude: "missing", codex: "missing" });
  assert.equal(hooks.command, "pnpm harness:setup --hooks --apply");
  assert.deepEqual(
    hooks.plan.map((item) => [item.file, item.action]),
    [
      [".claude/settings.local.json", "write"],
      [".codex/hooks.json", "write"],
    ],
  );
  assert.equal(calls.length, 0, "reading the status runs nothing");

  const post = (body: string, headers: Record<string, string> = postHeaders(server)) =>
    raw(server.port, { method: "POST", path: "/api/hooks/install", headers, body });
  assert.equal((await post("{}", { "Content-Type": "application/json" })).status, 403, "CSRF header required");
  assert.equal((await post('{"apply":true}')).status, 400, "the body is empty");
  const install = await post("{}");
  assert.equal(install.status, 200, install.text);
  const reply = HooksInstallResponseSchema.parse(install.json());
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.status, { claude: "installed", codex: "installed" });
  assert.deepEqual(reply.trust, ["Claude Code: accept the workspace trust dialog once."]);
  assert.equal(reply.result?.metadata?.["hooks"], undefined, "the plan's file contents stay out of the reply");
  assert.deepEqual(calls, [{ script: "harness-setup.ts", args: ["--hooks", "--apply"] }]);

  const bare = await startTestServer(root);
  t.after(() => bare.close());
  const none = await raw(bare.port, {
    method: "POST",
    path: "/api/hooks/install",
    headers: postHeaders(bare),
    body: "{}",
  });
  assert.equal(none.status, 501);
  assert.equal(SERVER_PROJECT, PROJECT);
});

test("a job the provider cannot cancel now carries the reason (A9)", () => {
  const job = {
    operationId: "op:fal",
    provider: "fal",
    endpoint: "fal-ai/x",
    state: "queued",
    reservedMicros: 500_000,
    paidAttempts: 1,
    providerRequestId: "r1",
    quote: { confidence: "catalog" },
    history: [{ state: "submitting", at: AT }],
    updatedAt: AT,
  } as unknown as GenerationJob;
  const summary = jobSummary(job);
  assert.equal(summary.cancellable, false);
  assert.match(summary.cancelReason ?? "", /fal job adapter has no cancel call/);
  const local = jobSummary({ ...job, state: "reserved", paidAttempts: 0 } as GenerationJob);
  assert.equal(local.cancellable, true);
  assert.equal(local.cancelReason, undefined);
});
