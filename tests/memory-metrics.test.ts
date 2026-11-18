import { USER_GRANT } from "./helpers/ceiling-grant";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { FILM_CHAIN } from "../src/lib/film/chain";
import { approveStep, openFilmProject, sealStep } from "../src/lib/film/state";
import { OperationStore } from "../src/lib/jobs/store";
import { loadMemory } from "../src/lib/memory";
import {
  draftEpisode,
  noteApproval,
  noteDelivered,
  noteMetric,
  noteRound,
  noteSensorFail,
  noteSpend,
  projectFromPaths,
  readMetrics,
} from "../src/lib/memory/capture";
import type { MemoryMetric } from "../src/types/memory";
import { toConceptApproved } from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const ID = "film";

/** A workspace with its own memory root: AGENTBROS_MEMORY_ROOT points at <workspace>/memory for this test only. */
function workspace(t: TestContext, playbook?: string) {
  const root = mkdtempSync(path.join(tmpdir(), "memory-metrics-"));
  const previous = process.env.AGENTBROS_MEMORY_ROOT;
  process.env.AGENTBROS_MEMORY_ROOT = path.join(root, "memory");
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_MEMORY_ROOT;
    else process.env.AGENTBROS_MEMORY_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const project = path.join(root, "public/projects", ID);
  mkdirSync(path.join(project, "pipeline"), { recursive: true });
  if (playbook)
    writeFileSync(
      path.join(project, "pipeline/playbook.json"),
      JSON.stringify({ version: 1, id: playbook, chosenAt: new Date().toISOString(), by: "user" }),
    );
  return { root, project, memory: path.join(root, "memory") };
}

const lines = (memory: string): MemoryMetric[] => {
  const file = path.join(memory, "metrics.jsonl");
  return existsSync(file)
    ? readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as MemoryMetric)
    : [];
};

function cli(root: string, env: NodeJS.ProcessEnv, script: string, ...args: string[]) {
  const result = spawnSync(process.execPath, [TSX, path.join(REPO, script), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  const line = result.stdout.trim().split("\n").at(-1) ?? "{}";
  return {
    status: result.status,
    stderr: result.stderr,
    json: JSON.parse(line) as { ok: boolean; error?: string; metadata: Record<string, unknown> },
  };
}

test("noteMetric appends a line with the project's playbook and today's time", (t) => {
  const w = workspace(t, "product-promo");
  assert.equal(noteMetric({ project: ID, step: "intake", event: "approved" }, w.root), undefined);
  const [line] = lines(w.memory);
  assert.equal(line!.event, "approved");
  assert.equal(line!.playbook, "product-promo");
  assert.equal(line!.step, "intake");
  assert.ok(Date.parse(line!.at) <= Date.now());
  assert.equal(noteMetric({ project: ID, event: "sensor-fail", detail: "x".repeat(400) }, w.root), undefined);
  assert.equal(lines(w.memory)[1]!.detail!.length, 200, "detail is cut to the schema's 200 characters");
});

test("noteMetric never throws: an unwritable memory root or an invalid line comes back as a warning", (t) => {
  const w = workspace(t);
  const file = path.join(w.root, "not-a-folder");
  writeFileSync(file, "");
  process.env.AGENTBROS_MEMORY_ROOT = path.join(file, "memory");
  assert.match(
    noteMetric({ project: ID, event: "approved" }, w.root) ?? "",
    /^memory: the approved metric was not recorded/,
  );
  assert.match(
    noteDelivered(ID, 1, ["vertical"], "a".repeat(64), w.root) ?? "",
    /delivered metric was not recorded.*episode was not drafted/,
  );
  process.env.AGENTBROS_MEMORY_ROOT = w.memory;
  assert.match(noteMetric({ project: "Not Valid", event: "approved" }, w.root) ?? "", /not recorded/);
});

test("approval, round, sensor-fail and spend helpers write the right lines; a proxy decision writes none", (t) => {
  const w = workspace(t);
  assert.equal(noteApproval(ID, "intake", { proxy: true }, w.root), undefined);
  assert.equal(lines(w.memory).length, 0, "a benchmark proxy is not the user's approval");
  noteApproval(ID, "concept", {}, w.root);
  noteRound(ID, "look", "public/projects/film/pipeline/critique/look-round-3.json", w.root);
  noteRound(ID, "idea-review", undefined, w.root);
  noteSensorFail(ID, "film:measure", ["sync", "loudness"], { step: "measure" }, w.root);
  noteSpend(ID, 1.25, "op-1", "r-1", w.root);
  assert.deepEqual(
    lines(w.memory).map(({ event, step, value, detail }) => ({ event, step, value, detail })),
    [
      { event: "approved", step: "concept", value: undefined, detail: undefined },
      { event: "round", step: "look", value: 3, detail: undefined },
      { event: "round", step: "idea-review", value: 0, detail: undefined },
      { event: "sensor-fail", step: "measure", value: 2, detail: "film:measure: sync, loudness" },
      { event: "spend", step: undefined, value: 1.25, detail: "operation op-1 receipt r-1" },
    ],
  );
  assert.deepEqual(readMetrics("other", w.root), []);
  // A removed project's lines stop counting: a new project under the same id starts after the tombstone.
  noteMetric({ project: "reused", event: "approved", step: "brief" }, w.root);
  noteMetric({ project: "reused", event: "removed" }, w.root);
  noteMetric({ project: "reused", event: "round", step: "critic", value: 1 }, w.root);
  assert.deepEqual(
    readMetrics("reused", w.root).map((metric) => metric.event),
    ["round"],
  );
});

test("projectFromPaths finds an existing project under public/projects, src/projects or out", (t) => {
  const w = workspace(t);
  assert.equal(projectFromPaths([undefined, "public/projects/film/props.json"], w.root), ID);
  assert.equal(projectFromPaths([path.join(w.root, "src/projects/film/index.ts")], w.root), ID);
  assert.equal(projectFromPaths(["out/film/film.mp4"], w.root), ID);
  assert.equal(projectFromPaths(["out/qa/x.mp4", "src/index.ts", "public/projects/missing/p.json"], w.root), undefined);
});

test("a production-ready delivery records delivered and drafts one measured episode, never a second", (t) => {
  const w = workspace(t, "product-promo");
  const store = new OperationStore(ID, { directory: path.join(w.project, "pipeline") });
  store.configure({ ceilingUsd: 10, maxJobUsd: 5, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 }, USER_GRANT);
  store.reserveOperation({
    operationId: "one",
    provider: "fixture",
    endpoint: "test/image",
    inputHash: "hash-one",
    assetId: "one",
    repair: false,
    quote: {
      currency: "USD",
      lowUsd: 1,
      expectedUsd: 1,
      highUsd: 1,
      bounded: true,
      source: "offline quote",
      asOf: "2026-10-11",
      confidence: "published-rate",
    },
  });
  store.transitionJob("one", "submitting");
  store.reconcileBilling("one", {
    receiptId: "invoice-1",
    actualUsd: 0.75,
    source: "fixture invoice",
    confirmedAt: new Date().toISOString(),
  });
  noteRound(ID, "idea-review", "pipeline/creative-review/ideas-round-2.json", w.root);
  noteRound(ID, "look", "pipeline/critique/look-round-1.json", w.root);
  noteApproval(ID, "concept", {}, w.root);

  assert.equal(noteDelivered(ID, 2, ["vertical", "square"], "a".repeat(64), w.root), undefined);
  const delivered = lines(w.memory).at(-1)!;
  assert.deepEqual(
    [delivered.event, delivered.value, delivered.detail, delivered.playbook],
    ["delivered", 2, `formats: vertical, square; snapshot ${"a".repeat(16)}`, "product-promo"],
  );
  const episodes = loadMemory(w.root).entries.filter((entry) => entry.type === "episode");
  assert.equal(episodes.length, 1);
  const [episode] = episodes;
  assert.equal(
    episode!.summary,
    "Product promo delivered in vertical, square: 3 review rounds, 1 approval, $0.75 settled spend",
  );
  assert.deepEqual(episode!.scope.playbooks, ["product-promo"]);
  assert.equal(episode!.scope.project, ID);
  assert.equal(episode!.source.kind, "measured");
  assert.match((episode!.source as { evidence: string }).evidence, /pnpm delivery --action check/);
  assert.match(episode!.body, /idea-review 2, look 1/);

  assert.equal(
    noteDelivered(ID, 2, ["vertical", "square"], "a".repeat(64), w.root),
    undefined,
    "the same snapshot checked again",
  );
  assert.equal(
    lines(w.memory).filter((line) => line.event === "delivered").length,
    1,
    "one delivered line per snapshot",
  );
  assert.equal(noteDelivered(ID, 2, ["vertical", "square"], "b".repeat(64), w.root), undefined);
  assert.equal(draftEpisode(ID, w.root), undefined);
  assert.equal(
    loadMemory(w.root).entries.filter((entry) => entry.type === "episode").length,
    1,
    "one episode per project",
  );
  assert.equal(lines(w.memory).filter((line) => line.event === "delivered").length, 2);
});

test("an episode without a binding or a budget still drafts from the metrics", (t) => {
  const w = workspace(t);
  noteSpend(ID, 0.5, "op-2", "r-2", w.root);
  const episode = draftEpisode(ID, w.root);
  assert.equal(episode?.summary, "Unbound film delivered: 0 review rounds, 0 approvals, $0.50 settled spend");
});

function film(t: TestContext) {
  const w = workspace(t);
  rmSync(w.project, { recursive: true, force: true });
  const env = { AGENTBROS_MEMORY_ROOT: w.memory };
  assert.equal(cli(w.root, env, "scripts/film-init.ts", "--project", ID).status, 0);
  copyFileSync(path.join(FIXTURES, "brief.json"), path.join(w.project, "pipeline/brief.json"));
  return { ...w, env };
}

test("film:done on a step without a critic records no round, and film:approve records approved with its step", (t) => {
  const f = film(t);
  assert.equal(cli(f.root, f.env, "scripts/film-done.ts", "--project", ID, "--step", "intake").status, 0);
  assert.deepEqual(lines(f.memory), []);
  const approve = cli(f.root, f.env, "scripts/film-approve.ts", "--project", ID, "--step", "intake", "--answer", "yes");
  assert.equal(approve.status, 0, approve.stderr);
  assert.equal(approve.json.metadata["memoryWarning"], undefined);
  assert.deepEqual(
    lines(f.memory).map(({ event, project, step }) => ({ event, project, step })),
    [{ event: "approved", project: ID, step: "intake" }],
  );
});

test("film:approve stays ok when memory cannot be written, with the warning on stderr and in metadata", (t) => {
  const f = film(t);
  assert.equal(cli(f.root, f.env, "scripts/film-done.ts", "--project", ID, "--step", "intake").status, 0);
  const blocker = path.join(f.root, "blocker");
  writeFileSync(blocker, "");
  const approve = cli(
    f.root,
    { AGENTBROS_MEMORY_ROOT: path.join(blocker, "memory") },
    "scripts/film-approve.ts",
    "--project",
    ID,
    "--step",
    "intake",
    "--answer",
    "yes",
  );
  assert.equal(approve.status, 0, approve.stderr);
  assert.equal(approve.json.ok, true);
  assert.match(String(approve.json.metadata["memoryWarning"]), /approved metric was not recorded/);
  assert.match(approve.stderr, /approved metric was not recorded/);
});

test("budget --receipt records a settled charge once; the same receipt again records nothing", (t) => {
  const f = film(t);
  const store = new OperationStore(ID, { directory: path.join(f.project, "pipeline") });
  store.configure({ ceilingUsd: 10, maxJobUsd: 5, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 2 }, USER_GRANT);
  store.reserveOperation({
    operationId: "one",
    provider: "fixture",
    endpoint: "test/image",
    inputHash: "hash-one",
    assetId: "one",
    repair: false,
    quote: {
      currency: "USD",
      lowUsd: 1,
      expectedUsd: 1,
      highUsd: 1,
      bounded: true,
      source: "offline quote",
      asOf: "2026-10-11",
      confidence: "published-rate",
    },
  });
  store.transitionJob("one", "submitting");
  const receipt = path.join(f.root, "receipt.json");
  writeFileSync(
    receipt,
    JSON.stringify({
      receiptId: "invoice-1",
      actualUsd: 0.4,
      source: "fixture invoice",
      confirmedAt: new Date().toISOString(),
    }),
  );
  for (let run = 0; run < 2; run++) {
    const result = cli(
      f.root,
      f.env,
      "scripts/budget.ts",
      "--project",
      ID,
      "--operation-id",
      "one",
      "--receipt",
      receipt,
    );
    assert.equal(result.status, 0, result.stderr);
  }
  assert.deepEqual(
    lines(f.memory).map(({ event, value, detail }) => ({ event, value, detail })),
    [{ event: "spend", value: 0.4, detail: "operation one receipt invoice-1" }],
  );
});

test("film:done on a creative-review step records round with the rounds its review used", (t) => {
  const f = film(t);
  const project = () => openFilmProject(f.project, { rootDir: f.root });
  const studio = {
    dir: f.project,
    seal: (id: string) => sealStep(project(), id),
    approve: (id: string) => approveStep(project(), id, `yes to ${id}`),
  };
  for (const [file, step] of [
    ["brief.json", "intake"],
    ["product-truth.json", "truth"],
    ["film-targets.json", "reference"],
  ] as const) {
    copyFileSync(path.join(FIXTURES, file), path.join(f.project, "pipeline", file));
    studio.seal(step);
    if (step === "intake") studio.approve(step);
  }
  toConceptApproved(studio, ID);
  const done = cli(f.root, f.env, "scripts/film-done.ts", "--project", ID, "--step", "idea-review");
  assert.equal(done.status, 0, JSON.stringify(done.json));
  assert.deepEqual(
    lines(f.memory).map(({ event, step, value }) => ({ event, step, value })),
    [{ event: "round", step: "idea-review", value: 1 }],
  );
});

test("the build step passes the project to motion:check, which accepts --project", () => {
  const build = FILM_CHAIN.find((step) => step.id === "build")!;
  assert.ok(
    JSON.stringify(build.commands).includes('"project":"{id}"'),
    "motion:check in the build step names the project",
  );
  const help = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/motion-check.ts"), "--help"], {
    encoding: "utf8",
  });
  assert.match(`${help.stdout}${help.stderr}`, /--project/);
});

test("repeats record nothing new: a round already counted, a spend receipt applied again", (t) => {
  const w = workspace(t);
  noteRound(ID, "look", "look-round-2.json", w.root);
  noteRound(ID, "look", "look-round-2.json", w.root);
  noteSpend(ID, 1, "op", "receipt", w.root);
  noteSpend(ID, 1, "op", "receipt", w.root);
  assert.deepEqual(
    lines(w.memory).map((line) => line.event),
    ["round", "spend"],
  );
  noteRound(ID, "look", "look-round-3.json", w.root);
  assert.equal(lines(w.memory).length, 3, "a later round is new");
});

test("concurrent identical receipts write one spend line", async (t) => {
  const w = workspace(t);
  const code = `import { noteSpend } from ${JSON.stringify(path.join(REPO, "src/lib/memory/capture.ts"))}; noteSpend("film", 2, "op", "same", ${JSON.stringify(w.root)})`;
  const runs = Array.from(
    { length: 4 },
    () =>
      new Promise<number | null>((resolve) =>
        spawn(process.execPath, [TSX, "-e", code], {
          env: { ...process.env, AGENTBROS_MEMORY_ROOT: w.memory },
          stdio: "ignore",
        }).on("exit", resolve),
      ),
  );
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
  assert.equal(lines(w.memory).length, 1);
});

test("film:approve of an already approved step records nothing more", (t) => {
  const f = film(t);
  assert.equal(cli(f.root, f.env, "scripts/film-done.ts", "--project", ID, "--step", "intake").status, 0);
  for (let run = 0; run < 2; run++)
    assert.equal(
      cli(f.root, f.env, "scripts/film-approve.ts", "--project", ID, "--step", "intake", "--answer", "yes").status,
      0,
    );
  assert.equal(lines(f.memory).filter((line) => line.event === "approved").length, 1);
});

test("under the test runner, noteMetric refuses the checkout's memory/ unless AGENTBROS_MEMORY_ROOT names it", (t) => {
  assert.ok(process.env.NODE_TEST_CONTEXT, "node:test sets NODE_TEST_CONTEXT in each test process");
  const previous = process.env.AGENTBROS_MEMORY_ROOT;
  delete process.env.AGENTBROS_MEMORY_ROOT;
  t.after(() => {
    if (previous !== undefined) process.env.AGENTBROS_MEMORY_ROOT = previous;
  });
  const before = existsSync(path.join(REPO, "memory/metrics.jsonl"))
    ? readFileSync(path.join(REPO, "memory/metrics.jsonl"), "utf8")
    : undefined;
  assert.match(
    noteMetric({ project: ID, event: "approved" }, REPO) ?? "",
    /a test may not write this checkout's memory/,
  );
  const after = existsSync(path.join(REPO, "memory/metrics.jsonl"))
    ? readFileSync(path.join(REPO, "memory/metrics.jsonl"), "utf8")
    : undefined;
  assert.equal(after, before);
});

test("concurrent deliveries of one project draft one episode, with an id that names the project", async (t) => {
  const w = workspace(t);
  noteSpend(ID, 1, "op", "r", w.root);
  const code = `import { draftEpisode } from ${JSON.stringify(path.join(REPO, "src/lib/memory/capture.ts"))}; draftEpisode("film", ${JSON.stringify(w.root)})`;
  const runs = Array.from(
    { length: 4 },
    () =>
      new Promise<number | null>((resolve) =>
        spawn(process.execPath, [TSX, "-e", code], {
          env: { ...process.env, AGENTBROS_MEMORY_ROOT: w.memory },
          stdio: "ignore",
        }).on("exit", resolve),
      ),
  );
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0]);
  const episodes = loadMemory(w.root).entries.filter((entry) => entry.type === "episode");
  assert.equal(episodes.length, 1);
  assert.match(episodes[0]!.id, /^episode-\d{8}-film$/);
});
