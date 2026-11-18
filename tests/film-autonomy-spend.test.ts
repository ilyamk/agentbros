/** The guard's defaults by mode, film:revert as a re-entry, and paid material under the user's autonomous spend. */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { USER_GRANT } from "./helpers/ceiling-grant";
import { ID, cli, setup } from "./helpers/film-autonomy";
import { currentPolicy, effectiveLimits, PolicyRefusal, revisePolicy } from "../src/lib/autonomy/policy";
import { OperationStore } from "../src/lib/jobs/store";
import { DEFAULT_LIMITS, INTERACTIVE_LIMITS } from "../src/types/policy";
import { policyBasis, type AutonomyContext } from "../src/lib/film/autonomy";
import { appendDecision } from "../src/lib/film/decisions";
import { appendGuardEvent, guardCheck, guardUsage, readGuardEvents, recordSeal } from "../src/lib/film/guard";
import { spendApprovalEvents } from "../src/lib/film/state";
import { materialApproved } from "../src/lib/step-lease/issue";

const WORDS = "Go on by yourself; spend up to three dollars on generated shots.";
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 17, 9, 0) + minutes * 60_000).toISOString();

function tempProject(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "film-spend-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "proj");
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  return { root, dir };
}

// --- The guard's defaults by mode ---

test("limits by mode: interactive 60 rounds and 12 hours, autonomous 30 and 4; limits the user set win in both", (t) => {
  assert.equal(INTERACTIVE_LIMITS.maxTotalRounds, 60);
  assert.equal(INTERACTIVE_LIMITS.maxActiveHours, 12);
  assert.equal(INTERACTIVE_LIMITS.maxStepRounds, DEFAULT_LIMITS.maxStepRounds);
  assert.equal(INTERACTIVE_LIMITS.maxReentries, DEFAULT_LIMITS.maxReentries);
  assert.equal(INTERACTIVE_LIMITS.maxProviderSpendUsd, undefined, "spend unchanged");
  assert.equal(DEFAULT_LIMITS.maxTotalRounds, 30);
  assert.equal(DEFAULT_LIMITS.maxActiveHours, 4);
  assert.deepEqual(effectiveLimits(undefined), INTERACTIVE_LIMITS, "no policy: interactive");

  const { dir } = tempProject(t);
  revisePolicy(dir, "p", { limits: { maxTotalRounds: 2 } }, "Two rounds.");
  const interactive = effectiveLimits(currentPolicy(dir));
  assert.equal(interactive.maxTotalRounds, 2, "an explicit limit wins");
  assert.equal(interactive.maxActiveHours, 12, "an unset limit keeps the interactive default");
  assert.deepEqual(currentPolicy(dir)!.limits, { maxTotalRounds: 2 }, "only what the user set is stored");

  revisePolicy(dir, "p", { autonomy: "autonomous" }, WORDS);
  const autonomous = effectiveLimits(currentPolicy(dir));
  assert.equal(autonomous.maxTotalRounds, 2);
  assert.equal(autonomous.maxActiveHours, 4, "autonomous: the tighter default");
  revisePolicy(dir, "p", { limits: { maxActiveHours: 8 } }, "Eight hours.");
  assert.equal(effectiveLimits(currentPolicy(dir)).maxActiveHours, 8);

  // Back to interactive narrows what runs without asking: no words needed, though the default hours grow.
  const back = revisePolicy(dir, "p", { autonomy: "interactive" }, undefined);
  assert.deepEqual(back.widened, []);
  assert.equal(effectiveLimits(back.revision).maxActiveHours, 8, "the user's own limit still wins");
});

test("the hour limit: an interactive project runs to 12 active hours, an autonomous one stops at 4", (t) => {
  const seal = (dir: string, hours: number) => {
    for (let minutes = 0; minutes <= hours * 60; minutes += 20)
      appendGuardEvent(dir, { kind: "seal", step: "intake", at: at(minutes) });
  };
  const interactive = tempProject(t);
  seal(interactive.dir, 5);
  assert.deepEqual(guardCheck(interactive.dir).crossed, [], "five hours fit the interactive default");
  const autonomous = tempProject(t);
  revisePolicy(autonomous.dir, "p", { autonomy: "autonomous" }, WORDS);
  seal(autonomous.dir, 5);
  assert.equal(guardCheck(autonomous.dir).crossed[0]?.name, "maxActiveHours");
  const long = tempProject(t);
  seal(long.dir, 12);
  assert.equal(guardCheck(long.dir).crossed[0]?.name, "maxActiveHours");
});

test("film:next on the footage route reads the same mode defaults", (t) => {
  const { dir } = tempProject(t);
  for (let round = 0; round < 40; round++)
    appendGuardEvent(dir, { kind: "dispatch", step: `s${round}`, role: "owner", key: `k${round}`, at: at(round) });
  assert.deepEqual(guardCheck(dir).crossed, [], "40 rounds fit the interactive 60");
  revisePolicy(dir, "p", { autonomy: "autonomous" }, WORDS);
  assert.equal(guardCheck(dir).crossed[0]?.name, "maxTotalRounds");
});

// --- film:revert is a re-entry ---

test("film:revert counts as a re-entry of the step, once; three on one step stop everything", (t) => {
  const film = setup(t);
  revisePolicy(film.dir, ID, { autonomy: "autonomous" }, WORDS);
  const decide = () =>
    appendDecision(film.dir, {
      step: "concept",
      kind: "judge",
      artefactHashes: {},
      evidence: { judge: "fixture" },
      judgeVerdict: "fixture",
      policyRevision: 1,
      at: at(0),
    });
  const revert = (id: string, words: string) => {
    const ran = cli(film.root, "scripts/film-revert.ts", "--project", ID, "--decision", id, "--answer", words);
    assert.equal(ran.status, 0, JSON.stringify(ran.json));
  };
  revert(decide().id, "No, I pick the idea.");
  assert.equal(guardUsage(film.dir).reentries["concept"], 1);
  assert.ok(readGuardEvents(film.dir).some((event) => event.kind === "reentry" && /film:revert/.test(event.source!)));
  // The re-seal after the revert is the same re-entry, not a second one.
  recordSeal(film.dir, "concept", true);
  assert.equal(guardUsage(film.dir).reentries["concept"], 1);
  revert(decide().id, "Not that one either.");
  revert(decide().id, "Still no.");
  const check = guardCheck(film.dir);
  assert.deepEqual(
    check.crossed.map(({ name, where, blocks }) => ({ name, where, blocks })),
    [{ name: "maxReentries", where: "concept", blocks: "all" }],
  );
});

// --- Paid material under spendUsd ---

type Item = { id: string; route: string; status: string; maxCostUsd?: number };
const generated = (id: string, maxCostUsd?: number): Item => ({
  id,
  route: "generated",
  status: "pending",
  ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
});

function materialContext(t: test.TestContext) {
  const { root, dir } = tempProject(t);
  const file = path.join(dir, "pipeline/material.json");
  const context: AutonomyContext = {
    projectDir: dir,
    rootDir: root,
    tokens: { dir: "proj" },
    steps: [{ id: "material", status: "awaiting-gate", outputs: {} }],
  };
  const plan = (...items: Item[]) =>
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, filmType: "generated", items }));
  const basis = () => policyBasis(context, "material");
  const store = () => new OperationStore("p", { directory: path.join(dir, "pipeline") });
  return { root, dir, file, plan, basis, store };
}

test("without spendUsd a paid plan asks the user; with it, paid material passes within the cap and the budget", (t) => {
  const m = materialContext(t);
  revisePolicy(m.dir, "p", { autonomy: "autonomous", autoPass: ["material-free"] }, WORDS);
  m.plan(generated("a", 1.5), generated("b", 1));
  assert.match(m.basis().refused!, /not free/, "unchanged: free only");

  assert.throws(() => revisePolicy(m.dir, "p", { spendUsd: 3 }, undefined), PolicyRefusal);
  revisePolicy(m.dir, "p", { spendUsd: 3 }, WORDS);
  assert.match(m.basis().refused!, /no durable budget/, "budget admission still applies");
  m.store().configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);

  const { basis } = m.basis();
  assert.equal(basis?.kind, "spend");
  assert.equal(basis?.amountUsd, 2.5);
  assert.equal(basis?.evidence["items"], "a=1.5,b=1");
  assert.equal(basis?.expect, createHash("sha256").update(readFileSync(m.file)).digest("hex"));

  m.plan(generated("a", 1.5), generated("b", 2.5));
  assert.match(m.basis().refused!, /past the USD 3/, "over the user's autonomous spend");
  m.plan(generated("a", 1.5), { id: "shoot", route: "recorded", status: "pending" });
  assert.match(m.basis().refused!, /shoot/, "a recording is the user's");
  m.plan(generated("a"));
  assert.match(m.basis().refused!, /without its bound/, "an unknown price is not free");
  m.plan({ id: "stock", route: "stock", status: "pending" });
  assert.match(m.basis().refused!, /stock/);
  m.plan(generated("a", 1), { id: "licence", route: "stock", status: "planned", maxCostUsd: 1 });
  assert.match(m.basis().refused!, /licence/, "a paid licence is bought outside admission: the user decides");

  revisePolicy(m.dir, "p", { spendUsd: 10 }, WORDS);
  m.plan(generated("big", 3));
  assert.match(m.basis().refused!, /per-job limit USD 2/);
  m.store().reserveOperation({
    operationId: "op-1",
    provider: "test",
    endpoint: "test/image",
    assetId: "x",
    inputHash: "x",
    quote: {
      currency: "USD",
      lowUsd: 2,
      expectedUsd: 2,
      highUsd: 2,
      bounded: true,
      source: "fixture",
      asOf: "2026-10-11",
      confidence: "published-rate",
    },
  });
  m.plan(generated("a", 2), generated("b", 2));
  assert.match(m.basis().refused!, /budget has USD 3 left/, "within the cap, past the durable budget's headroom");
});

test("the cap sums every autonomously approved item once, revoked ones too", (t) => {
  const m = materialContext(t);
  revisePolicy(m.dir, "p", { autonomy: "autonomous", spendUsd: 3 }, WORDS);
  m.store().configure({ ceilingUsd: 10, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
  const first = appendDecision(m.dir, {
    step: "material",
    kind: "spend",
    artefactHashes: { "proj/pipeline/material.json": "an earlier plan" },
    evidence: { judge: "material-spend", items: "a=1.5,b=1" },
    judgeVerdict: "fixture",
    amountUsd: 2.5,
    policyRevision: 1,
    at: at(0),
  });
  m.plan(generated("a", 1.5), generated("b", 1));
  assert.equal(m.basis().basis?.evidence["cumulativeUsd"], "2.5", "a re-approved item is not counted twice");
  m.plan(generated("c", 1));
  assert.match(m.basis().refused!, /reach USD 3.5/);
  appendDecision(m.dir, { kind: "revoked", revokes: first.id, step: "material", answer: "Undo it.", at: at(1) });
  assert.match(m.basis().refused!, /reach USD 3.5/, "a revert does not refund what may be bought");
  m.plan({ id: "free", route: "library", status: "planned" });
  assert.match(m.basis().refused!, /does not auto-pass material-free/);
});

test("spendUsd survives later revisions, and lowering or removing it needs no words", (t) => {
  const { dir } = tempProject(t);
  revisePolicy(dir, "p", { autonomy: "autonomous", spendUsd: 3 }, WORDS);
  revisePolicy(dir, "p", { limits: { maxTotalRounds: 40 } }, "Forty rounds.");
  assert.equal(currentPolicy(dir)!.spendUsd, 3);
  assert.equal(revisePolicy(dir, "p", { spendUsd: 1 }, undefined).revision.spendUsd, 1);
  assert.equal(revisePolicy(dir, "p", { spendUsd: 0 }, undefined).revision.spendUsd, undefined);
});

test("only the user's yes or a standing policy spend decision authorises material spending; a benchmark proxy never", (t) => {
  const film = setup(t);
  const relative = `public/projects/${ID}/pipeline/material.json`;
  writeFileSync(path.join(film.root, relative), JSON.stringify({ schemaVersion: 1, items: [] }));
  const hash = createHash("sha256")
    .update(readFileSync(path.join(film.root, relative)))
    .digest("hex");
  const approvals = (events: Record<string, unknown>[]) => {
    mkdirSync(path.join(film.pipeline, "approvals"), { recursive: true });
    writeFileSync(
      path.join(film.pipeline, "approvals/material.json"),
      JSON.stringify({ schemaVersion: 1, step: "material", events }),
    );
  };
  const event = (extra: Record<string, unknown>) => ({
    answer: "x",
    at: at(0),
    artefacts: { [relative]: hash },
    ...extra,
  });
  const decision = (kind: "spend" | "judge") =>
    appendDecision(film.dir, {
      step: "material",
      kind,
      artefactHashes: {},
      evidence: { judge: "fixture" },
      judgeVerdict: "fixture",
      policyRevision: 1,
      at: at(0),
    });
  approvals([event({ proxy: "orchestrator-benchmark", reason: "bench" })]);
  assert.equal(materialApproved(film.project()), false, "a benchmark proxy never authorises spending");
  const judged = decision("judge");
  approvals([event({ proxy: "user-policy", reason: "free", decisionId: judged.id })]);
  assert.equal(materialApproved(film.project()), false, "a material-free approval authorises no spending");
  const spend = decision("spend");
  approvals([event({ proxy: "user-policy", reason: "spend", decisionId: spend.id })]);
  assert.equal(materialApproved(film.project()), true);
  assert.equal(spendApprovalEvents(film.project(), "material").length, 1);
  appendDecision(film.dir, { kind: "revoked", revokes: spend.id, step: "material", answer: "No.", at: at(1) });
  assert.equal(materialApproved(film.project()), false, "film:revert withdraws the authority");
});

test("film:policy --spend-usd needs the user's words", (t) => {
  const film = setup(t);
  const refused = cli(film.root, "scripts/film-policy.ts", "--project", ID, "--spend-usd", "3");
  assert.equal(refused.json.error, "VALIDATION");
  const granted = cli(film.root, "scripts/film-policy.ts", "--project", ID, "--spend-usd", "3", "--answer", WORDS);
  assert.equal(granted.status, 0, JSON.stringify(granted.json));
  assert.equal(granted.json.metadata["revision"].spendUsd, 3);
  assert.ok(granted.json.metadata["widened"].includes("autonomous spend USD 3"));
});
