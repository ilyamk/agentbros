import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { CliErrorObject } from "../src/lib/cli";
import { COMMANDS } from "../src/mcp/catalog";
import { ensureProjectPolicy, FIRST_AUTOMATIC_CEILING_USD } from "../src/lib/jobs/initial-policy";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationStore, BudgetError } from "../src/lib/jobs/store";
import type { OperationInput } from "../src/lib/jobs/types";
import { USER_GRANT } from "./helpers/ceiling-grant";
const root = mkdtempSync(path.join(tmpdir(), "video-budget-"));
test.after(() => rmSync(root, { recursive: true, force: true }));
export function operation(id: string, cost = 1, repair = false): OperationInput {
  return {
    operationId: id,
    provider: "fixture",
    endpoint: "test/image",
    inputHash: `hash-${id}`,
    assetId: id,
    repair,
    quote: {
      currency: "USD",
      lowUsd: cost,
      expectedUsd: cost,
      highUsd: cost,
      bounded: true,
      source: "offline quote",
      asOf: "2026-10-11",
      confidence: "published-rate",
    },
  };
}
function setup(
  id: string,
  policy = { ceilingUsd: 10, maxJobUsd: 5, repairReserveFraction: 0.2, maxPaidAttemptsPerAsset: 2 },
) {
  const store = new OperationStore(id, { directory: path.join(root, id) });
  store.configure(policy, USER_GRANT);
  return store;
}
function errorCode(callback: () => unknown, code: BudgetError["code"]) {
  assert.throws(callback, (error: unknown) => error instanceof BudgetError && error.code === code);
}

test("bounded quote, per-job and separate repair allocation are mandatory", () => {
  const store = setup("bounds");
  errorCode(
    () =>
      store.reserveOperation({ ...operation("unknown"), quote: { ...operation("q").quote, bounded: false } } as never),
    "UNKNOWN_PRICE",
  );
  errorCode(
    () => store.reserveOperation({ ...operation("null"), quote: { ...operation("q").quote, highUsd: null } } as never),
    "UNKNOWN_PRICE",
  );
  errorCode(() => store.reserveOperation(operation("job-too-big", 6)), "BUDGET_EXCEEDED");
  store.reserveOperation(operation("base-one", 4));
  store.reserveOperation(operation("base-two", 4));
  errorCode(() => store.reserveOperation(operation("base-three", 0.01)), "BUDGET_EXCEEDED");
  store.reserveOperation(operation("repair", 2, true));
  errorCode(() => store.reserveOperation(operation("extra-repair", 0.01, true)), "BUDGET_EXCEEDED");
  assert.equal(store.summary().reservedUsd, 10);
  assert.equal(Object.keys(store.snapshot().jobs).length, 3);
});

test("idempotent operation IDs bind inputs and a price snapshot", () => {
  const store = setup("identity");
  const input = operation("same");
  const first = store.reserveOperation(input);
  assert.deepEqual(store.reserveOperation(input), first);
  assert.equal(store.summary().reservedUsd, 1);
  errorCode(() => store.reserveOperation({ ...input, inputHash: "changed" }), "CONFLICT");
  errorCode(() => store.reserveOperation({ ...input, quote: { ...input.quote, highUsd: 2 } }), "CONFLICT");
});

test("ambiguous submission, failure and cancellation retain liability", () => {
  const store = setup("ambiguous");
  store.reserveOperation(operation("first"));
  store.transitionJob("first", "submitting");
  store.transitionJob("first", "unknown", { error: "response lost" });
  assert.equal(store.summary().reservedUsd, 1);
  errorCode(() => store.reserveOperation({ ...operation("retry"), assetId: "first" }), "CONFLICT");
  errorCode(
    () => store.releaseReservation("first", { confirmationId: "bad", reason: "not-submitted", source: "caller" }),
    "CONFLICT",
  );
  store.transitionJob("first", "failed");
  assert.equal(store.summary().reservedUsd, 1);
  store.reserveOperation(operation("cancel"));
  store.transitionJob("cancel", "cancelled");
  assert.equal(store.summary().reservedUsd, 2);
  store.releaseReservation("cancel", {
    confirmationId: "local-cancel",
    reason: "not-submitted",
    source: "no-submit local evidence",
  });
  assert.equal(store.summary().reservedUsd, 1);
  store.releaseReservation("first", {
    confirmationId: "provider-no-charge",
    reason: "confirmed-no-charge",
    source: "verified provider record",
  });
  assert.equal(store.summary().reservedUsd, 0);
});

test("settlement facts replace estimate; excess charges are recorded and block new work", () => {
  const store = setup("invoice", { ceilingUsd: 2, maxJobUsd: 2, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 });
  store.reserveOperation(operation("one", 1));
  store.transitionJob("one", "submitting");
  const receipt = {
    receiptId: "invoice-1",
    actualUsd: 3,
    source: "fixture invoice",
    confirmedAt: new Date().toISOString(),
  };
  store.reconcileBilling("one", receipt);
  store.reconcileBilling("one", receipt);
  assert.equal(store.summary().settledUsd, 3);
  assert.equal(store.summary().reservedUsd, 0);
  assert.equal(store.summary().overBudget, true);
  errorCode(() => store.reserveOperation(operation("two", 0.01)), "BUDGET_EXCEEDED");
  errorCode(() => store.reconcileBilling("one", { ...receipt, actualUsd: 1 }), "CONFLICT");
  errorCode(
    () => store.releaseReservation("one", { confirmationId: "forget", reason: "confirmed-no-charge", source: "fake" }),
    "CONFLICT",
  );
  const refund = {
    receiptId: "refund-1",
    refundUsd: 2,
    source: "confirmed refund",
    confirmedAt: new Date().toISOString(),
  };
  store.recordRefund("one", refund);
  store.recordRefund("one", refund);
  assert.equal(store.summary().settledUsd, 1);
  assert.equal(store.summary().overBudget, false);
  errorCode(() => store.recordRefund("one", { ...refund, receiptId: "too-much", refundUsd: 2 }), "CONFLICT");
});

test("paid attempt limit includes reserved promises and cannot be reset by failures", () => {
  const store = setup("attempts");
  store.reserveOperation(operation("one"));
  store.transitionJob("one", "submitting");
  store.transitionJob("one", "failed");
  store.reserveOperation({ ...operation("two"), assetId: "one" });
  errorCode(() => store.reserveOperation({ ...operation("three"), assetId: "one" }), "ATTEMPT_LIMIT");
  store.transitionJob("two", "submitting");
  store.transitionJob("two", "failed");
  errorCode(() => store.reserveOperation({ ...operation("four"), assetId: "one" }), "ATTEMPT_LIMIT");
});
test("billing cannot reuse a refund receipt and refusal preserves committed state", () => {
  const store = setup("refund-receipt");
  for (const id of ["one", "two"]) {
    store.reserveOperation(operation(id));
    store.transitionJob(id, "submitting");
  }
  const confirmedAt = new Date().toISOString();
  store.reconcileBilling("one", { receiptId: "original-bill", actualUsd: 1, source: "fixture", confirmedAt });
  store.recordRefund("one", { receiptId: "refund", refundUsd: 1, source: "fixture", confirmedAt });
  const before = store.snapshot(),
    summary = store.summary();
  errorCode(
    () => store.reconcileBilling("two", { receiptId: "refund", actualUsd: 1, source: "fixture", confirmedAt }),
    "CONFLICT",
  );
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(store.summary(), summary);
});

test("rounding never creates headroom and lowering policy rejects existing exposure", () => {
  const store = setup("round", {
    ceilingUsd: 0.000003,
    maxJobUsd: 0.000003,
    repairReserveFraction: 0,
    maxPaidAttemptsPerAsset: 2,
  });
  store.reserveOperation(operation("one", 0.0000011));
  assert.equal(store.summary().reservedUsd, 0.000002);
  errorCode(() => store.reserveOperation(operation("two", 0.0000011)), "BUDGET_EXCEEDED");
  errorCode(() => store.configure({ ceilingUsd: 0.000001, maxJobUsd: 1 }, USER_GRANT), "BUDGET_EXCEEDED");
});

test("raising or first setting the ceiling needs the user's words; lowering is free and every change is recorded", () => {
  const store = new OperationStore("grant", { directory: path.join(root, "grant") });
  errorCode(() => store.configure({ ceilingUsd: 5, maxJobUsd: 5 }), "AUTHORITY_REQUIRED");
  assert.throws(
    () => store.configure({ ceilingUsd: 5, maxJobUsd: 5 }),
    /pnpm budget --project grant --ceiling-usd 5 --answer/,
  );
  assert.throws(() => store.configure({ ceilingUsd: 5, maxJobUsd: 5 }, { by: "user", answer: "   " }));
  assert.throws(
    () => store.configure({ ceilingUsd: 5, maxJobUsd: 5 }, { by: "user", answer: " <the user's words> " }),
    /placeholder/,
  );
  assert.equal(store.ceilingUsd(), null);
  store.configure({ ceilingUsd: 0, maxJobUsd: 0 });
  errorCode(() => store.configure({ ceilingUsd: 0.000001, maxJobUsd: 0 }), "AUTHORITY_REQUIRED");
  store.configure({ ceilingUsd: 5, maxJobUsd: 5 }, { by: "user", answer: "Spend up to five dollars." });
  store.configure({ ceilingUsd: 5, maxJobUsd: 2 });
  store.configure({ ceilingUsd: 3, maxJobUsd: 3 });
  errorCode(() => store.configure({ ceilingUsd: 3.5, maxJobUsd: 3 }), "AUTHORITY_REQUIRED");
  assert.equal(store.ceilingUsd(), 3);
  const events = store.snapshot().policyEvents!;
  assert.deepEqual(
    events.map((event) => [event.change, event.previousCeilingUsd, event.ceilingUsd, event.grant?.by ?? null]),
    [
      ["first", null, 0, null],
      ["raise", 0, 5, "user"],
      ["same", 5, 5, null],
      ["lower", 5, 3, null],
    ],
  );
  assert.equal(events[1].grant?.by === "user" && events[1].grant.answer, "Spend up to five dollars.");
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.at))));
});

test("a store written before policy events parses, and its first raise needs the user's words", () => {
  const directory = path.join(root, "legacy-events");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "operations.json"),
    JSON.stringify({
      version: 1,
      projectId: "legacy-events",
      revision: 1,
      policy: { ceilingUsd: 2, maxJobUsd: 2, repairReserveFraction: 0.15, maxPaidAttemptsPerAsset: 2 },
      jobs: {},
    }),
  );
  const store = new OperationStore("legacy-events", { directory });
  assert.equal(store.ceilingUsd(), 2);
  errorCode(() => store.configure({ ceilingUsd: 4, maxJobUsd: 4 }), "AUTHORITY_REQUIRED");
  store.configure({ ceilingUsd: 1, maxJobUsd: 1 });
  assert.equal(store.snapshot().policyEvents?.[0]?.change, "lower");
});

test("the MCP budget tool cannot carry the user's words, so it can never raise a ceiling", () => {
  const budget = COMMANDS.find((command) => command.name === "budget")!;
  assert.equal(budget.schema.safeParse({ project: "demo", "ceiling-usd": 1 }).success, true);
  assert.equal(budget.schema.safeParse({ project: "demo", "ceiling-usd": 1, answer: "yes" }).success, false);
});

test("a paid command's first ceiling comes from a numeric brief, capped, and a null brief authorises nothing", (t) => {
  const previous = process.cwd();
  const workspace = mkdtempSync(path.join(tmpdir(), "video-budget-brief-"));
  process.chdir(workspace);
  t.after(() => {
    process.chdir(previous);
    rmSync(workspace, { recursive: true, force: true });
  });
  for (const [id, budgetUsd] of [
    ["unset", null],
    ["generous", 50],
    ["small", 2],
  ] as const) {
    mkdirSync(`public/projects/${id}/pipeline`, { recursive: true });
    writeFileSync(`public/projects/${id}/pipeline/brief.json`, JSON.stringify({ budgetUsd }));
  }
  const unset = new OperationStore("unset");
  assert.throws(
    () => ensureProjectPolicy(unset, "unset"),
    (error: unknown) =>
      error instanceof CliErrorObject &&
      error.code === "VALIDATION" &&
      /authorises nothing/.test(error.message) &&
      /--answer/.test(error.message),
  );
  assert.equal(existsSync(unset.file), false);
  const generous = new OperationStore("generous");
  ensureProjectPolicy(generous, "generous");
  assert.equal(generous.ceilingUsd(), FIRST_AUTOMATIC_CEILING_USD);
  assert.equal(generous.snapshot().policyEvents?.[0]?.grant?.by, "brief");
  const small = new OperationStore("small");
  ensureProjectPolicy(small, "small");
  assert.equal(small.ceilingUsd(), 2);
  ensureProjectPolicy(small, "small");
  assert.equal(small.snapshot().policyEvents?.length, 1);
});

const SMALL_POLICY = { ceilingUsd: 0.2, maxJobUsd: 0.2, repairReserveFraction: 0.15, maxPaidAttemptsPerAsset: 2 };
test("an allocation refusal names the allocation, ceiling, reserve and request; maxAdmissibleUsd mirrors it", () => {
  const store = setup("allocation-numbers", SMALL_POLICY);
  assert.equal(store.maxAdmissibleUsd(), 0.17);
  assert.equal(store.maxAdmissibleUsd({ repair: true }), 0.03);
  assert.throws(
    () => store.reserveOperation(operation("too-much", 0.2)),
    (error: unknown) =>
      error instanceof BudgetError &&
      error.code === "BUDGET_EXCEEDED" &&
      error.message.startsWith(
        "Production allocation is $0.17 (ceiling $0.20 minus 15% repair reserve); requested $0.20.",
      ) &&
      error.details?.maxAdmissibleUsd === 0.17 &&
      error.details?.requestedUsd === 0.2,
  );
  store.reserveOperation(operation("first", 0.05));
  assert.equal(store.maxAdmissibleUsd(), 0.12);
  assert.throws(
    () => store.reserveOperation(operation("second", 0.13)),
    (error: unknown) =>
      error instanceof BudgetError && /\$0\.05 already committed/.test(error.message) && /\$0\.13/.test(error.message),
  );
  assert.throws(
    () => store.reserveOperation(operation("per-job", 0.3)),
    (error: unknown) =>
      error instanceof BudgetError && /Per-job limit .*\$0\.20.*requested \$0\.30/.test(error.message),
  );
  const unconfigured = new OperationStore("never-configured", { directory: path.join(root, "never") });
  assert.equal(unconfigured.maxAdmissibleUsd(), null);
  assert.equal(existsSync(path.join(root, "never")), false);
});

test("a budget refusal reaches the CLI as BUDGET_EXCEEDED with its amounts, not INTERNAL", (t) => {
  const workspace = mkdtempSync(path.join(tmpdir(), "video-budget-cli-"));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const directory = path.join(workspace, "pipeline");
  new OperationStore("cli-budget", { directory }).configure(SMALL_POLICY, USER_GRANT);
  const child = path.join(workspace, "reserve.ts");
  writeFileSync(
    child,
    [
      `import { runScript } from ${JSON.stringify(path.resolve("src/lib/cli/index.ts"))};`,
      `import { OperationStore } from ${JSON.stringify(path.resolve("src/lib/jobs/store.ts"))};`,
      `runScript(async () => {`,
      `  new OperationStore("cli-budget", { directory: ${JSON.stringify(directory)} }).reserveOperation(${JSON.stringify(operation("cli", 0.2))});`,
      `  return {};`,
      `});`,
    ].join("\n"),
  );
  const result = spawnSync(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), child], {
    cwd: workspace,
    encoding: "utf8",
    env: { PATH: process.env.PATH, AGENTBROS_NO_DOTENV: "1", AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT },
  });
  const lines = result.stdout.trim().split("\n");
  assert.ok(lines.length === 1 && lines[0], result.stderr);
  const envelope = JSON.parse(lines[0]!);
  assert.equal(result.status, 1);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error, "BUDGET_EXCEEDED");
  assert.match(
    envelope.message,
    /Production allocation is \$0\.17 \(ceiling \$0\.20 minus 15% repair reserve\); requested \$0\.20\./,
  );
  assert.equal(envelope.details?.maxAdmissibleUsd, 0.17);
});
