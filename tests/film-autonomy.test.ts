import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { USER_GRANT } from "./helpers/ceiling-grant";
import {
  ID,
  cli,
  critique,
  setup,
  sha,
  toIntakeApproved,
  toMeasured,
  toMusicShortlist,
  writeCritique,
  type Film,
} from "./helpers/film-autonomy";
import { buildPool, pickIdeas, rankLatest } from "../src/lib/film/studio";
import { skipDiscovery, writeBoards, writeReview, writeStrategy, writeTeams } from "./helpers/film-studio";
import { currentPolicy, PolicyRefusal, revisePolicy } from "../src/lib/autonomy/policy";
import { OperationStore } from "../src/lib/jobs/store";
import { ProjectPolicySchema, DEFAULT_LIMITS } from "../src/types/policy";
import { approveStep, nextAction, PROXY_REFUSED } from "../src/lib/film/state";
import { activeHours, appendGuardEvent, guardCheck, readGuardEvents } from "../src/lib/film/guard";
import { guardDispatch } from "../src/lib/film/guard-cli";
import { readDecisions } from "../src/lib/film/decisions";
import { snapshotFilmVersion } from "../src/lib/film/versions";
import { FORBIDDEN_FOR_ALL, FORBIDDEN_UNDER_POLICY } from "../src/lib/film/chain";

const WORDS = "Go ahead on your own until the final cut, up to five dollars.";
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 17, 9, 0) + minutes * 60_000).toISOString();

function tempProject(t: test.TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "film-policy-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  return dir;
}

function quote(cost = 1, confidence: "published-rate" | "user-bound" = "published-rate") {
  return {
    currency: "USD" as const,
    lowUsd: cost,
    expectedUsd: cost,
    highUsd: cost,
    bounded: true as const,
    source: "fixture",
    asOf: "2026-10-11",
    confidence,
  };
}
const operation = (id: string, provider = "test", confidence?: "user-bound") => ({
  operationId: id,
  provider,
  endpoint: "test/image",
  assetId: id,
  inputHash: id,
  quote: quote(1, confidence),
});

// --- The policy file ---

test("the policy: v1 schema, revisions appended, widening needs the user's words, narrowing does not", (t) => {
  const dir = tempProject(t);
  assert.throws(() => revisePolicy(dir, "p", { autonomy: "autonomous" }, undefined), PolicyRefusal);
  assert.throws(() => revisePolicy(dir, "p", { autonomy: "autonomous" }, "<the user's words>"), PolicyRefusal);
  const first = revisePolicy(
    dir,
    "p",
    {
      autonomy: "autonomous",
      budget: { ceilingUsd: 5, allowedProviders: ["fal"] },
      autoPass: ["concept"],
      preAnswers: { musicRoute: "silence", silenceReason: "voice only" },
    },
    WORDS,
  );
  assert.equal(first.revision.revision, 1);
  assert.equal(first.revision.budget!.maxJobUsd, 5, "the per-job limit defaults to the ceiling");
  assert.equal(first.revision.budget!.allowUserBoundQuotes, false);
  assert.ok(first.widened.includes("autonomy autonomous"));
  assert.throws(() => revisePolicy(dir, "p", { budget: { ceilingUsd: 9 } }, undefined), /widens/);
  assert.throws(() => revisePolicy(dir, "p", { limits: { maxTotalRounds: 40 } }, undefined), /maxTotalRounds/);
  assert.throws(() => revisePolicy(dir, "p", { budget: { allowedProviders: ["fal", "x"] } }, undefined), /provider x/);
  const lowered = revisePolicy(dir, "p", { budget: { ceilingUsd: 3 }, limits: { maxTotalRounds: 10 } }, undefined);
  assert.equal(lowered.revision.grantedBy.answer, WORDS, "a narrowing keeps the grant it narrows");
  const file = ProjectPolicySchema.parse(JSON.parse(readFileSync(path.join(dir, "pipeline/policy.json"), "utf8")));
  assert.equal(file.revisions.length, 2);
  assert.equal(currentPolicy(dir)!.budget!.ceilingUsd, 3);
  assert.equal(DEFAULT_LIMITS.maxTotalRounds, 30);
  assert.equal(DEFAULT_LIMITS.maxStepRounds, 6);
  assert.equal(DEFAULT_LIMITS.maxReentries, 2);
  assert.equal(DEFAULT_LIMITS.maxActiveHours, 4);
});

test("the policy's budget binds OperationStore: no ceiling above its cap, no provider outside its list, no hand-bound quote", (t) => {
  const dir = tempProject(t);
  revisePolicy(
    dir,
    "p",
    { autonomy: "autonomous", budget: { ceilingUsd: 5, maxJobUsd: 2, allowedProviders: ["test"] } },
    WORDS,
  );
  const store = new OperationStore("p", { directory: path.join(dir, "pipeline") });
  assert.throws(
    () => store.configure({ ceilingUsd: 6, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT),
    (error: Error & { code?: string }) => error.code === "AUTHORITY_REQUIRED" && /policy's cap/.test(error.message),
  );
  assert.throws(
    () => store.configure({ ceilingUsd: 5, maxJobUsd: 3, repairReserveFraction: 0 }, USER_GRANT),
    (error: Error & { code?: string }) => error.code === "AUTHORITY_REQUIRED",
  );
  store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  assert.throws(
    () => store.reserveOperation(operation("elsewhere", "other")),
    (error: Error & { code?: string }) =>
      error.code === "AUTHORITY_REQUIRED" && /allowed providers/.test(error.message),
  );
  assert.throws(
    () => store.reserveOperation(operation("by-hand", "test", "user-bound")),
    (error: Error & { code?: string }) => error.code === "AUTHORITY_REQUIRED" && /hand-bound/.test(error.message),
  );
  store.reserveOperation(operation("one"));
  // A lowered policy binds a store whose own ceiling is higher.
  revisePolicy(dir, "p", { budget: { ceilingUsd: 1.5, maxJobUsd: 1.5 } }, undefined);
  assert.throws(
    () => store.reserveOperation(operation("two")),
    (error: Error & { code?: string }) => error.code === "BUDGET_EXCEEDED" && /policy's ceiling/.test(error.message),
  );
});

// --- Authority ---

function grant(film: Film, change: Parameters<typeof revisePolicy>[2]) {
  return revisePolicy(film.dir, ID, change, WORDS);
}

test("no policy passes the human verdict or the rights; a policy approval needs its ledger decision", (t) => {
  assert.deepEqual([...PROXY_REFUSED], ["human", "rights"]);
  const film = setup(t);
  grant(film, { autonomy: "autonomous", autoPass: ["concept", "script"] });
  for (const step of ["human", "rights"])
    assert.throws(
      () => approveStep(film.project(), step, "policy", undefined, { kind: "policy", reason: "x" }, undefined, "d-001"),
      /user's alone/,
    );
  film.place("brief.json");
  film.seal("intake");
  assert.throws(
    () => approveStep(film.project(), "intake", "policy", undefined, { kind: "policy", reason: "x" }),
    /ledger decision/,
  );
  const refused = cli(film.root, "scripts/film-approve.ts", "--project", ID, "--step", "intake", "--policy");
  assert.equal(refused.json.error, "STAGE_INCOMPLETE", "no pre-answer covers the brief: the user decides");
  const next = nextAction(film.project());
  assert.equal(next.action, "ask");
  assert.deepEqual(next.forbidden!.slice(0, 3), FORBIDDEN_UNDER_POLICY);
  assert.notDeepEqual(FORBIDDEN_UNDER_POLICY, FORBIDDEN_FOR_ALL);
});

function toConceptAwaiting(film: Film) {
  toIntakeApproved(film);
  writeStrategy(film.dir);
  film.seal("strategy");
  film.approve("strategy");
  skipDiscovery(film.dir);
  writeTeams(film.dir, 1);
  film.seal("ideas");
  buildPool(film.dir, ID, "ideas");
  film.seal("idea-review");
  writeReview(film.dir, "ideas", 1, () => 4);
  rankLatest(film.dir, "ideas");
  pickIdeas(film.dir);
  writeBoards(film.dir);
  film.seal("concept");
}

test("autoPass concept after a passing blind review runs film:approve --policy, with a ledger line; revert asks the user", (t) => {
  const film = setup(t);
  toConceptAwaiting(film);
  assert.equal(nextAction(film.project()).action, "ask", "interactive: the user picks the concept");
  grant(film, { autonomy: "autonomous", autoPass: ["concept"] });
  const next = nextAction(film.project());
  assert.equal(next.action, "run");
  assert.equal(next.step, "concept");
  const pool = sha(readFileSync(path.join(film.pipeline, "pools/ideas.json"), "utf8"));
  assert.deepEqual(next.commands, [`pnpm film:approve --project ${ID} --step concept --policy --expect ${pool}`]);

  const stale = cli(
    film.root,
    "scripts/film-approve.ts",
    "--project",
    ID,
    "--step",
    "concept",
    "--policy",
    "--expect",
    "0".repeat(64),
  );
  assert.equal(stale.json.error, "STAGE_INCOMPLETE", "a hash other than the judged pool is refused");
  assert.equal(readDecisions(film.dir).length, 0);
  assert.throws(
    () =>
      approveStep(
        film.project(),
        "concept",
        "policy",
        undefined,
        { kind: "policy", reason: "x", expect: "0".repeat(64) },
        undefined,
        "d-009",
      ),
    /changed since film:next/,
    "the library refuses a stale hash too, whoever calls it",
  );
  assert.throws(
    () =>
      approveStep(film.project(), "animatic", "policy", undefined, { kind: "policy", reason: "x" }, undefined, "d-009"),
    /does not cover|not in this film|has not|Waits/,
  );

  const approved = cli(
    film.root,
    "scripts/film-approve.ts",
    "--project",
    ID,
    "--step",
    "concept",
    "--policy",
    "--expect",
    pool,
  );
  assert.equal(approved.status, 0, JSON.stringify(approved.json));
  assert.equal(approved.json.metadata["countsAsUserApproval"], false);
  const [decision] = readDecisions(film.dir);
  assert.equal(decision!.kind, "judge");
  assert.equal(decision!.step, "concept");
  assert.equal(decision!.kind === "judge" && decision!.evidence["targetSha256"], pool);
  assert.equal(film.status("concept"), "done");
  assert.equal(nextAction(film.project()).step, "music");

  const reverted = cli(
    film.root,
    "scripts/film-revert.ts",
    "--project",
    ID,
    "--decision",
    decision!.id,
    "--answer",
    "No, I want to pick the idea myself.",
  );
  assert.equal(reverted.status, 0, JSON.stringify(reverted.json));
  assert.equal(film.status("concept"), "awaiting-gate");
  const asked = nextAction(film.project());
  assert.equal(asked.action, "ask", "a revoked decision is never taken again on the same artefacts");
  assert.equal(asked.step, "concept");
});

test("a pre-answered silence: the policy records the music, seals it and passes the gate; the human step lists the ledger", (t) => {
  const film = setup(t);
  toMusicShortlist(film);
  grant(film, {
    autonomy: "autonomous",
    preAnswers: { musicRoute: "silence", silenceReason: "The voice carries it." },
  });
  const record = nextAction(film.project());
  assert.equal(record.action, "run");
  assert.match(
    record.commands![0]!,
    /pnpm music --action record --project film --route silence --answer "policy \(pre-answer\): silence/,
  );
  const ran = cli(
    film.root,
    "scripts/music.ts",
    "--action",
    "record",
    "--project",
    ID,
    "--route",
    "silence",
    "--answer",
    "policy (pre-answer): silence: The voice carries it.",
    "--reason",
    "The voice carries it.",
    "--question",
    "Music, pre-answered in the policy the user granted (film:policy)",
  );
  assert.equal(ran.status, 0, JSON.stringify(ran.json));
  assert.equal(cli(film.root, "scripts/film-done.ts", "--project", ID, "--step", "music").status, 0);
  const approve = nextAction(film.project());
  assert.equal(approve.action, "run");
  assert.match(approve.commands![0]!, /film:approve --project film --step music --policy --expect [0-9a-f]{64}/);
  const expect = approve.commands![0]!.split(" ").at(-1)!;
  const done = cli(
    film.root,
    "scripts/film-approve.ts",
    "--project",
    ID,
    "--step",
    "music",
    "--policy",
    "--expect",
    expect,
  );
  assert.equal(done.status, 0, JSON.stringify(done.json));
  assert.equal(film.status("music"), "done");
  const [decision] = readDecisions(film.dir);
  assert.equal(decision!.kind, "preAnswer");
  assert.equal(decision!.kind === "preAnswer" && decision!.evidence["preAnswer"], "musicRoute=silence");
});

test("the human question lists the policy's decisions by step", (t) => {
  const film = setup(t);
  toMeasured(film);
  writeCritique(film, "round-1.json", critique(1, sha("render-1"), "approve-for-human"));
  grant(film, { autonomy: "autonomous", autoPass: ["concept"] });
  writeFileSync(
    path.join(film.pipeline, "decisions.jsonl"),
    `${JSON.stringify({ id: "d-001", step: "concept", kind: "judge", artefactHashes: {}, evidence: { judge: "creative-review/ideas-round-1.json" }, judgeVerdict: "idea-review round 1 passed", policyRevision: 1, at: at(0) })}\n`,
  );
  const ask = nextAction(film.project());
  assert.equal(ask.step, "human");
  assert.equal(ask.action, "ask");
  assert.match(ask.question!, /concept: d-001 judge \(idea-review round 1 passed/);
  assert.match(ask.question!, /film:revert/);
});

// --- The guard ---

test("the guard stops a dispatch at the total rounds, film:brief refuses, and a raise in the user's words resumes without resetting", (t) => {
  const film = setup(t);
  revisePolicy(film.dir, ID, { limits: { maxTotalRounds: 2 } }, "Two rounds for this test.");
  appendGuardEvent(film.dir, { kind: "dispatch", step: "intake", role: "owner", key: "a", at: at(0) });
  assert.equal(nextAction(film.project()).action, "dispatch", "one round of two: going on");
  appendGuardEvent(film.dir, { kind: "dispatch", step: "truth", role: "owner", key: "b", at: at(5) });
  const stop = nextAction(film.project());
  assert.equal(stop.action, "stop");
  assert.equal(stop.step, "present-best");
  assert.deepEqual(stop.limits, [{ name: "maxTotalRounds", used: 2, max: 2 }]);
  assert.match(stop.raise![0]!, /pnpm film:policy --project film --raise maxTotalRounds=\d+ --answer/);
  const brief = cli(film.root, "scripts/film-brief.ts", "--project", ID, "--step", "intake");
  assert.equal(brief.json.error, "STAGE_INCOMPLETE");
  assert.match(brief.json.message!, /maxTotalRounds 2\/2/);

  assert.equal(
    cli(film.root, "scripts/film-policy.ts", "--project", ID, "--raise", "maxTotalRounds=3").json.error,
    "VALIDATION",
  );
  const raised = cli(
    film.root,
    "scripts/film-policy.ts",
    "--project",
    ID,
    "--raise",
    "maxTotalRounds=3",
    "--answer",
    "Fine, one more round.",
  );
  assert.equal(raised.status, 0, JSON.stringify(raised.json));
  assert.equal(nextAction(film.project()).action, "dispatch");
  const dispatches = readGuardEvents(film.dir).filter((event) => event.kind === "dispatch");
  assert.equal(dispatches.length, 2, "raising appends, it never resets the counts");
  assert.ok(readGuardEvents(film.dir).some((event) => event.kind === "raise"));
});

test("a round limit lets the round in flight be sealed; a re-printed brief is not a new round", (t) => {
  const film = setup(t);
  revisePolicy(film.dir, ID, { limits: { maxTotalRounds: 1 } }, "One round.");
  guardDispatch(film.project(), "intake", "owner").commit();
  guardDispatch(film.project(), "intake", "owner").commit();
  assert.equal(readGuardEvents(film.dir).filter((event) => event.kind === "dispatch").length, 1);
  film.place("brief.json");
  assert.equal(nextAction(film.project()).action, "run", "film:done of the round in flight still runs");
});

test("re-entries and spend stop everything; idle gaps are not active time", (t) => {
  const film = setup(t);
  film.place("brief.json");
  film.seal("intake");
  for (const minutes of [0, 1, 2])
    appendGuardEvent(film.dir, { kind: "reentry", step: "music", source: "feedback fb-001", at: at(minutes) });
  const stop = nextAction(film.project());
  assert.equal(stop.action, "stop", "an ask is stopped too");
  assert.deepEqual(stop.limits, [{ name: "maxReentries", used: 3, max: 2, where: "music" }]);

  const spend = setup(t);
  revisePolicy(spend.dir, ID, { limits: { maxProviderSpendUsd: 0.5 } }, "Half a dollar at most.");
  const store = new OperationStore(ID, { directory: spend.pipeline });
  store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  store.reserveOperation(operation("one"));
  assert.equal(guardCheck(spend.dir).usage.providerSpendUsd, 1);
  const spent = nextAction(spend.project());
  assert.equal(spent.action, "stop");
  assert.equal(spent.limits![0]!.name, "maxProviderSpendUsd");
  assert.deepEqual(spent.spend, { usedUsd: 1, limitUsd: 0.5 });

  const events = [0, 10, 180, 200].map((minutes) => ({ kind: "seal" as const, step: "x", at: at(minutes) }));
  assert.equal(activeHours(events), 0.5, "10 + 20 minutes; the 170-minute gap is idle");
  const hours = setup(t);
  // No policy: interactive, so the 12-hour default (an autonomous policy stops at 4: film-autonomy-spend.test.ts).
  for (let minutes = 0; minutes <= 12 * 60; minutes += 20)
    appendGuardEvent(hours.dir, { kind: "seal", step: "intake", at: at(minutes) });
  assert.equal(nextAction(hours.project()).limits?.[0]?.name, "maxActiveHours");
});

test("the stop presents the best kept version, even after film.mp4 was overwritten by a worse one", (t) => {
  const film = setup(t);
  toMeasured(film, "render-1");
  const project = film.project();
  const filmFile = path.join(film.root, `out/${ID}/film.mp4`);
  snapshotFilmVersion(project, filmFile, { step: "measure" });
  writeCritique(film, "round-1.json", critique(1, sha("render-1"), "revise", 4));
  writeFileSync(filmFile, "render-2");
  snapshotFilmVersion(project, filmFile, { step: "measure" });
  writeCritique(film, "round-2.json", critique(2, sha("render-2"), "revise", 2));
  for (const minutes of [0, 1, 2]) appendGuardEvent(film.dir, { kind: "reentry", step: "build", at: at(minutes) });
  const stop = nextAction(film.project());
  assert.equal(stop.action, "stop");
  assert.equal(stop.best!.sha256, sha("render-1"));
  assert.equal(stop.best!.criticTotal, 28);
  assert.ok(existsSync(path.join(film.root, stop.best!.file)));
  assert.deepEqual(stop.show, [stop.best!.file]);
  rmSync(path.join(film.pipeline, "critique"), { recursive: true });
  assert.equal(nextAction(film.project()).action, "stop", "deleting critiques lowers no count");
});
