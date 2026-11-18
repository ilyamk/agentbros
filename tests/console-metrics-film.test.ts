/**
 * RFC 0004 §12, A19 on a real film: wasted spend (spend on outputs a later user rejection superseded) from the job
 * store, the cost ledger and the console's own decisions. The film is an explainer driven by the chain: music paid
 * for, narration's quote approved in the console, take 1 billed and then rejected in the console, take 2 billed after.
 * Unknown prices are counted beside the sum, never as $0; spend no step can be tied to is reported, not counted.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { consoleActionsWith } from "../src/lib/console/apply";
import { notImplementedActions } from "../src/lib/console/data";
import type { ConsoleServer } from "../src/lib/console/server";
import { computeMetrics } from "../src/lib/console/metrics";
import { createSpawnCli } from "../src/lib/console/spawn";
import { buildProjectView } from "../src/lib/console/view";
import { deriveWaiting } from "../src/lib/console/view/waiting";
import { reopens, spendStep } from "../src/lib/console/wasted";
import { measureNarration, takeFileName } from "../src/lib/film/narration";
import { OperationStore } from "../src/lib/jobs/store";
import { DecisionResponseSchema } from "../src/types/console";
import { ScriptSchema } from "../src/types/pipeline";
import { USER_GRANT } from "./helpers/ceiling-grant";
import { postHeaders, raw, startTestServer } from "./helpers/console-server";
import { FILM, filmProject, ON, toNarrationGate, type ConsoleFilm } from "./helpers/console-film";

const iso = (ms: number) => new Date(ms).toISOString();

/** A paid job reserved, submitted and made (validated, its output on disk), not yet billed. */
function madeJob(store: OperationStore, id: string, stage: string, usd: number) {
  store.reserveOperation({
    operationId: id,
    provider: stage === "music" ? "fal" : "elevenlabs",
    endpoint: stage === "music" ? "fal-ai/stable-audio" : "eleven_v4",
    inputHash: `hash-${id}`,
    assetId: id,
    stage,
    repair: false,
    quote: {
      currency: "USD",
      lowUsd: usd,
      expectedUsd: usd,
      highUsd: usd,
      bounded: true,
      source: "offline quote",
      asOf: "2026-11-01",
      confidence: "published-rate",
    },
  });
  store.transitionJob(id, "submitting");
  store.transitionJob(id, "running", { providerRequestId: `req-${id}` });
  store.transitionJob(id, "result-ready", { result: { url: `https://provider.invalid/${id}` } });
  store.transitionJob(id, "downloading");
  store.transitionJob(id, "validated");
}

/** Billing reconciled with the provider's receipt at `at` (it may come after the user already rejected the output). */
const bill = (store: OperationStore, id: string, usd: number, at: number) =>
  store.reconcileBilling(id, {
    receiptId: `invoice-${id}`,
    actualUsd: usd,
    source: "fixture invoice",
    confirmedAt: iso(at),
  });

function billedJob(store: OperationStore, id: string, stage: string, usd: number, at: number) {
  madeJob(store, id, stage, usd);
  bill(store, id, usd, at);
}

/** ElevenLabs-shaped takes for every beat (mp3, take receipt, words), measured into narration.json. */
function makeTakes(film: ConsoleFilm, take: number) {
  const script = ScriptSchema.parse(JSON.parse(readFileSync(path.join(film.pipeline, "script.json"), "utf8")));
  mkdirSync(path.join(film.dir, "voiceover"), { recursive: true });
  for (const beat of script.beats) {
    const file = path.join(film.dir, "voiceover", takeFileName(beat.id, take));
    writeFileSync(file, `audio ${beat.id} take ${take}`);
    writeFileSync(`${file}.take.json`, JSON.stringify({ request: { text: beat.text } }));
    writeFileSync(
      file.replace(/\.mp3$/, ".words.json"),
      JSON.stringify({
        words: beat.text.split(/\s+/).map((text, index) => ({ text, start: index * 0.3, end: index * 0.3 + 0.25 })),
      }),
    );
  }
  assert.deepEqual(measureNarration({ root: film.root, projectId: FILM, measure: () => 4 }).problems, []);
}

/**
 * The user's decision exactly as the console makes it: POSTed to the decision endpoint of a running console server,
 * which signs the spawned CLI with its grant (only a verified grant attributes a run to the user and the console).
 */
async function decide(
  server: ConsoleServer,
  request: { decisionId: string; choice: string; answer: string; expect: string },
) {
  const res = await raw(server.port, {
    method: "POST",
    path: `/api/projects/${FILM}/decisions`,
    headers: postHeaders(server),
    body: JSON.stringify(request),
  });
  assert.equal(res.status, 200, res.text);
  return DecisionResponseSchema.parse(res.json());
}

async function waitingAt(film: ConsoleFilm, step: string) {
  const decision = (await deriveWaiting(film.root, FILM)).find((item) => item.step === step);
  assert.ok(decision, `a decision waits at ${step}`);
  return decision;
}

test("A19: wasted spend on a real film counts take 1 (made, then rejected; billed later), not music or take 2", async (t) => {
  const film = filmProject(t);
  toNarrationGate(film, 0.25);
  const start = Date.now();
  const store = new OperationStore(FILM, { directory: film.pipeline });
  store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 }, USER_GRANT);
  // The music was bought before narration: a narration rejection never supersedes it.
  billedJob(store, "music-1", "music", 0.3, start - 120_000);

  // The user approves narration's quote in the console; the agent then makes take 1 (billed) and seals the takes.
  const server = await startTestServer(film.root, {
    actions: consoleActionsWith(film.root, notImplementedActions, {
      deriveWaiting,
      spawnCli: createSpawnCli({ env: ON, timeoutMs: 600_000 }),
      env: ON,
    }),
  });
  t.after(() => server.close());
  const quote = await waitingAt(film, "narration");
  assert.equal(quote.kind, "quote");
  const approved = await decide(server, {
    decisionId: quote.id,
    choice: "approve",
    answer: "Yes, this voice.",
    expect: quote.expect!,
  });
  assert.equal(approved.decision.status, "applied", JSON.stringify(approved.decision.result));
  madeJob(store, "take-1", "voiceover", 0.4);
  makeTakes(film, 1);
  film.seal("narration");
  // Ledger rows the store does not cover: a take re-run with no price (unknown) and an asset with no step (unattributed).
  writeFileSync(
    path.join(film.pipeline, "cost-ledger.jsonl"),
    [
      {
        ts: iso(start - 50_000),
        projectId: FILM,
        provider: "elevenlabs",
        stage: "voiceover",
        units: 1,
        actualUsd: null,
      },
      { ts: iso(start - 40_000), projectId: FILM, provider: "fal", stage: "assets", units: 1, actualUsd: 0.1 },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n",
  );

  // The user listens and asks for changes in the console: take 1 is superseded.
  const gate = await waitingAt(film, "narration");
  assert.equal(gate.kind, "gate", "the takes are approved by ear, no quote");
  const rejected = await decide(server, {
    decisionId: gate.id,
    choice: "changes",
    answer: "Too fast and too bright: softer, slower.",
    expect: gate.expect!,
  });
  assert.equal(rejected.decision.status, "applied", JSON.stringify(rejected.decision.result));
  // Take 1's receipt is reconciled only after the rejection: it was made before it, so it is still waste.
  bill(store, "take-1", 0.4, Date.now() + 500);
  // Take 2 is billed after the rejection: it is the answer to it, not waste.
  billedJob(store, "take-2", "voiceover", 0.4, Date.now() + 1000);

  const view = buildProjectView(film.root, FILM);
  assert.ok(view);
  assert.equal(view.project.route, "film");
  const metrics = computeMetrics({ rootDir: film.root, views: [view], now: Date.now() + 5000 });
  assert.deepEqual(metrics.spend.wasted, { usd: 0.4, items: 2, unknownPriced: 1, unattributed: 1 });
  const project = metrics.projects[0]!;
  assert.equal(project.wastedUsd, 0.4);
  assert.equal(project.wastedUnknownPriced, 1);
  // Spend itself: music, both takes and the priced ledger row; the unknown one is counted, never as $0.
  assert.equal(metrics.spend.spentUsd, 1.2);
  assert.equal(metrics.spend.unknownPriced, 1);
  // The console's decisions are counted too: the quote approved, and the changes asked at narration (kept in memory
  // before a render: no decision command runs, so the console's record is the decision and the step's new round).
  assert.deepEqual([metrics.decisions.decided, metrics.decisions.console], [2, 2], JSON.stringify(metrics.decisions));
  assert.deepEqual([metrics.rework.reopened, metrics.rework.gates], [1, 1]);
  assert.equal(metrics.steps.find((step) => step.step === "narration")?.rounds, 1);
});

test("wasted spend: a rejection reopens its step and every later film step, never an earlier one", () => {
  assert.equal(reopens("narration", "narration", true), true);
  assert.equal(reopens("script", "narration", true), true, "a new script remakes the takes");
  assert.equal(reopens("narration", "music", true), false);
  assert.equal(reopens("narration", "material", true), false, "a new voice never remakes generated shots");
  assert.equal(reopens("narration", "beat-sheet", true), true, "the beat sheet is timed to the voice");
  assert.equal(reopens("material", "build", true), true);
  assert.equal(reopens("build", "material", true), false);
  assert.equal(reopens("look", "narration", true), false);
  assert.equal(reopens("recut-plan", "recut-plan", false), true);
  assert.equal(reopens("script", "narration", false), false, "outside the film chain only the same step");
  assert.equal(spendStep({ journalStep: "material", stage: "voiceover" }), "material", "the leased step first");
  assert.equal(spendStep({ stage: "voiceover" }), "narration");
  assert.equal(spendStep({ stage: "material" }), "material");
  assert.equal(spendStep({ stage: "assets", output: "public/projects/f/voiceover/hook.mp3" }), "narration");
  assert.equal(spendStep({ stage: "assets" }), undefined);
});
