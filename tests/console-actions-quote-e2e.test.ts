/**
 * RFC 0004 A8, FR3, FR4 end to end on a real film: the narration and material quotes the projector derives at their
 * gates map to `film:approve --step <step> --answer=<words> --expect <outputs hash>` and apply through the console's
 * decision endpoint; nothing is reserved or spent (the agent's own CLI spends later, under normal admission). A quote
 * whose files or money changed after the user saw it is refused before any command runs.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { DecisionResponseSchema, type Decision } from "../src/types/console";
import { flagValue, planDecision } from "../src/lib/console/actions";
import { consoleActionsWith, createDecisionActions } from "../src/lib/console/apply";
import { notImplementedActions } from "../src/lib/console/data";
import { listDecisions } from "../src/lib/console/inbox";
import { createSpawnCli } from "../src/lib/console/spawn";
import { filmApproveArgv, musicRecordArgv, withAnswer } from "../src/lib/console/view/argv";
import { deriveWaiting } from "../src/lib/console/view/waiting";
import { nextAction } from "../src/lib/film/state";
import { OperationStore } from "../src/lib/jobs/store";
import { filmLeaseFor } from "../src/lib/step-lease/issue";
import { USER_GRANT } from "./helpers/ceiling-grant";
import { postHeaders, raw, startTestServer } from "./helpers/console-server";
import {
  FILM,
  filmProject,
  generatedItem,
  narrationDirection,
  ON,
  toMaterialGate,
  toNarrationGate,
  type ConsoleFilm,
} from "./helpers/console-film";

const POLICY = { ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 };
const store = (film: ConsoleFilm) => new OperationStore(FILM, { directory: film.pipeline });

async function quoteAt(film: ConsoleFilm, step: string): Promise<Decision> {
  const decision = (await deriveWaiting(film.root, FILM)).find((item) => item.step === step);
  assert.ok(decision, `the projector derives the ${step} decision`);
  assert.equal(decision.kind, "quote", JSON.stringify(decision));
  assert.ok(decision.expect && decision.quote?.quoteHash);
  return decision;
}

const actionsFor = (film: ConsoleFilm) =>
  createDecisionActions(film.root, {
    deriveWaiting,
    spawnCli: createSpawnCli({ env: ON, timeoutMs: 600_000 }),
    env: ON,
  });

/** Whether film:approve ever started in this project (its own journal line). */
const approveRan = (film: ConsoleFilm) =>
  existsSync(path.join(film.pipeline, "events.jsonl")) &&
  readFileSync(path.join(film.pipeline, "events.jsonl"), "utf8")
    .split("\n")
    .some((line) => line.includes('"cli.start"') && line.includes('"film:approve"'));

/** No job reserved or spent: no store at all, or one without jobs. */
const noJobs = (film: ConsoleFilm) => {
  if (!existsSync(path.join(film.pipeline, "operations.json"))) return;
  assert.deepEqual(Object.keys(store(film).snapshot().jobs), [], "the console reserved and spent nothing");
};
/** A 409 refusal: the decision is no longer what the user saw (superseded, or stale). */
const refused = (error: { status?: number; code?: string }) =>
  error.status === 409 && (error.code === "SUPERSEDED" || error.code === "STALE");

test("A8: the narration quote is approved through the endpoint as film:approve with the hash; nothing is spent", async (t) => {
  const film = filmProject(t);
  toNarrationGate(film, 0.25);
  store(film).configure(POLICY, USER_GRANT);
  const pending = await quoteAt(film, "narration");
  const beats = narrationDirection(film, 0.25).beats.length;
  // FR4: amount, provider, endpoint, admission and the budget after, from the direction and the job store.
  assert.deepEqual(
    {
      amount: pending.quote!.amountUsd,
      provider: pending.quote!.provider,
      endpoint: pending.quote!.endpoint,
      ceiling: pending.quote!.ceilingUsd,
      after: pending.quote!.budgetAfterUsd,
    },
    { amount: 0.25 * beats, provider: "elevenlabs", endpoint: "eleven_v4", ceiling: 5, after: 5 - 0.25 * beats },
  );
  assert.equal(typeof pending.quote!.maxAdmissibleUsd, "number");
  const approve = pending.options!.find((option) => option.id === "approve")!;
  assert.equal(approve.consequential, true);
  const expect = flagValue(approve.argv, "--expect");
  assert.ok(expect, "the derived approval carries the outputs hash");
  assert.deepEqual(approve.argv, filmApproveArgv(FILM, "narration", expect));
  // The action table: a film quote is film:approve at its step, the words one token, the hash the derived one.
  const words = "-h yes, this voice, up to the quoted amount.";
  const plan = planDecision({
    project: FILM,
    route: "film",
    decision: pending,
    request: { decisionId: pending.id, choice: "approve", answer: words, expect: pending.expect },
    expects: { approve: expect },
  });
  assert.equal(plan.action, "quote");

  const server = await startTestServer(film.root, {
    actions: consoleActionsWith(film.root, notImplementedActions, {
      deriveWaiting,
      spawnCli: createSpawnCli({ env: ON, timeoutMs: 600_000 }),
      env: ON,
    }),
  });
  t.after(() => server.close());
  const res = await raw(server.port, {
    method: "POST",
    path: `/api/projects/${FILM}/decisions`,
    headers: postHeaders(server),
    body: JSON.stringify({ decisionId: pending.id, choice: "approve", answer: words, expect: pending.expect }),
  });
  assert.equal(res.status, 200, res.text);
  const reply = DecisionResponseSchema.parse(res.json());
  assert.equal(reply.decision.status, "applied", JSON.stringify(reply.decision.result));
  const argv = ["pnpm", "film:approve", "--project", FILM, "--step", "narration", `--answer=${words}`];
  assert.deepEqual(reply.decision.argv, [...argv, "--expect", expect]);
  assert.deepEqual(reply.decision.quote, pending.quote, "the record keeps the quote the user approved");
  // film:approve recorded the user's words from the console.
  const approvals = JSON.parse(readFileSync(path.join(film.pipeline, "approvals/narration.json"), "utf8"));
  assert.equal(approvals.events.at(-1).answer, words);
  assert.equal(approvals.events.at(-1).channel, "console");
  // Spend happens only later through the agent's own CLI: the step now asks for the takes, with paid authority.
  noJobs(film);
  assert.match(film.status("narration").reasons.join(), /generate:voiceover --directed/);
  const next = nextAction(film.project());
  assert.equal(next.step, "narration");
  assert.equal(filmLeaseFor(film.project(), next, "film:next")!.paidAllowed, true);
  assert.equal(listDecisions(film.root, FILM).decisions[0]!.status, "applied");
});

test("FR3: the narration direction changed after the user saw the quote: refused, film:approve never runs", async (t) => {
  const film = filmProject(t);
  toNarrationGate(film, 0.25);
  const pending = await quoteAt(film, "narration");
  // The narrator-director raises the bound per take: the quote, its hash and the decision change.
  film.write("narrator-direction.json", narrationDirection(film, 0.5));
  film.seal("narration");
  const now = await quoteAt(film, "narration");
  assert.notEqual(now.quote!.quoteHash, pending.quote!.quoteHash);
  assert.notEqual(now.id, pending.id);

  const actions = actionsFor(film);
  await assert.rejects(
    actions.decide(FILM, { decisionId: pending.id, choice: "approve", answer: "Yes.", expect: pending.expect! }),
    refused,
  );
  // Sent with its kind and step (as the UI does), the console names the decision that replaced it and records it.
  await assert.rejects(
    actions.decide(FILM, {
      decisionId: pending.id,
      kind: "quote",
      step: "narration",
      choice: "approve",
      answer: "Yes.",
      expect: pending.expect!,
    }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "SUPERSEDED",
  );
  // The current decision with the stale `expect` is refused too.
  await assert.rejects(
    actions.decide(FILM, { decisionId: now.id, choice: "approve", answer: "Yes.", expect: pending.expect! }),
    (error: { status?: number; code?: string }) => error.status === 409 && error.code === "STALE",
  );
  assert.equal(approveRan(film), false);
  assert.equal(film.status("narration").status, "awaiting-gate");
  assert.equal(listDecisions(film.root, FILM).decisions[0]!.status, "superseded");
  noJobs(film);
});

test("FR4: only the money changed (a new ceiling): the quote hash binds it, so the old quote is refused", async (t) => {
  const film = filmProject(t);
  toNarrationGate(film, 0.25);
  store(film).configure(POLICY, USER_GRANT);
  const pending = await quoteAt(film, "narration");
  // Same files; the budget after the quote is not what the user saw.
  store(film).configure({ ...POLICY, ceilingUsd: 1 }, USER_GRANT);
  const now = await quoteAt(film, "narration");
  assert.deepEqual(now.bindTo, pending.bindTo, "no bound file changed");
  assert.notEqual(now.quote!.budgetAfterUsd, pending.quote!.budgetAfterUsd);
  assert.notEqual(now.expect, pending.expect);
  await assert.rejects(
    actionsFor(film).decide(FILM, {
      decisionId: pending.id,
      choice: "approve",
      answer: "Yes, at that cost.",
      expect: pending.expect!,
    }),
    refused,
  );
  assert.equal(approveRan(film), false);
  assert.equal(film.status("narration").status, "awaiting-gate");
  noJobs(film);
});

test("FR3 at the CLI: the direction changes between the server's check and the spawn; film:approve refuses the hash", async (t) => {
  const film = filmProject(t);
  toNarrationGate(film, 0.25);
  const pending = await quoteAt(film, "narration");
  const actions = createDecisionActions(film.root, {
    deriveWaiting: async () => [pending],
    spawnCli: async (request) => {
      writeFileSync(
        path.join(film.pipeline, "narrator-direction.json"),
        JSON.stringify(narrationDirection(film, 0.5), null, 2),
      );
      return createSpawnCli({ env: ON, timeoutMs: 600_000 })(request);
    },
    env: ON,
  });
  const result = await actions.decide(FILM, {
    decisionId: pending.id,
    choice: "approve",
    answer: "Yes.",
    expect: pending.expect!,
  });
  assert.equal(result.decision.status, "refused", JSON.stringify(result.decision.result));
  // The CLI's own refusal of the stale outputs hash (as for the script gate in A6), not a missing seal.
  assert.equal(result.decision.result!.error, "STAGE_INCOMPLETE", JSON.stringify(result.decision.result));
  assert.match(String(result.decision.result!.message), /expect|changed|hash/i, JSON.stringify(result.decision.result));
  assert.notEqual(film.status("narration").status, "done");
  assert.equal(film.status("narration").reasons.join().includes("generate:voiceover"), false, "not approved");
  noJobs(film);
});

test("A8: the material quote (one generated item) is approved the same way; nothing is generated", async (t) => {
  const film = filmProject(t);
  toMaterialGate(film, 1.5);
  const pending = await quoteAt(film, "material");
  assert.deepEqual(
    [pending.quote!.amountUsd, pending.quote!.provider, pending.quote!.endpoint],
    [1.5, "fal", "fal-ai/kling-video/v2"],
  );
  const expect = flagValue(pending.options!.find((option) => option.id === "approve")!.argv, "--expect")!;
  const words = "Yes to the hero shot at up to $1.50.";
  const result = await actionsFor(film).decide(FILM, {
    decisionId: pending.id,
    choice: "approve",
    answer: words,
    expect: pending.expect!,
  });
  assert.equal(result.decision.status, "applied", JSON.stringify(result.decision.result));
  assert.deepEqual(result.decision.argv, [
    "pnpm",
    "film:approve",
    "--project",
    FILM,
    "--step",
    "material",
    `--answer=${words}`,
    "--expect",
    expect,
  ]);
  noJobs(film);
  // A changed price bound is a new quote: the approved one cannot be replayed onto it.
  film.write("material.json", { schemaVersion: 1, filmType: "ai-video", items: [generatedItem(3)] });
  assert.notEqual(film.status("material").status, "done", "the material changed after the approval");
});

test("music is a pick, not a quote: the derived record argv runs with the user's words", () => {
  const argv = musicRecordArgv(FILM, "library", "calm-piano");
  assert.deepEqual(withAnswer(argv, "The piano one."), [
    "pnpm",
    "music",
    "--action",
    "record",
    "--project",
    FILM,
    "--route",
    "library",
    "--candidate",
    "calm-piano",
    "--answer",
    "The piano one.",
    "--reason",
    "The piano one.",
  ]);
  const decision: Decision = {
    v: 1,
    id: "music-pick",
    project: FILM,
    kind: "choice",
    step: "music",
    title: "Choose the music",
    bindTo: [],
    status: "pending",
    createdAt: "2026-11-17T10:00:00.000Z",
    options: [{ id: "calm-piano", label: "Calm piano", argv }],
  };
  const plan = planDecision({
    project: FILM,
    route: "film",
    decision,
    request: { decisionId: "music-pick", choice: "calm-piano", answer: "The piano one." },
  });
  assert.equal(plan.action, "record");
  assert.equal(plan.commands[0]!.alias, "music");
});
