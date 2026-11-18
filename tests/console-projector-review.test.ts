/**
 * Regressions from the WP3 projector review (RFC 0004): spend counted once (ledger rows naming a store job), memoised
 * hashes and probes across view builds, renders and film code picked up while watched, the current step agreeing
 * with its command, a real idea choice (film:approve --choice), one money context for the view and deriveWaiting,
 * the month's unknown-priced items, footage stops and repaired options.
 */
import { USER_GRANT } from "./helpers/ceiling-grant";
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConceptSchema } from "../src/types/creative";
import { ProjectViewSchema, type ProjectsResponse } from "../src/types/console";
import { revisePolicy } from "../src/lib/autonomy/policy";
import { logCost } from "../src/lib/cli/cost-log";
import { FileMemo } from "../src/lib/file-memo";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { approveStep, deriveChain, openFilmProject, sealStep, type FilmProject } from "../src/lib/film/state";
import { buildPool, pickIdeas, rankLatest } from "../src/lib/film/studio";
import { sha256File, STEP, type FootageNext } from "../src/lib/footage/next";
import { OperationStore } from "../src/lib/jobs/store";
import { executeElevenLabsRequest } from "../src/lib/jobs/elevenlabs-boundary";
import type { PriceQuote } from "../src/lib/jobs/types";
import { buildProjectView } from "../src/lib/console/view/build";
import { cleanOptions } from "../src/lib/console/view/decision";
import {
  FEEDBACK_FILE_PLACEHOLDER,
  feedbackFileArgv,
  feedbackFileFor,
  memoryChangesArgv,
  withAnswer,
} from "../src/lib/console/view/argv";
import { projectPaths } from "../src/lib/console/view/files";
import { readFilm } from "../src/lib/console/view/film";
import { footageSteps } from "../src/lib/console/view/footage";
import { ledgerOperationId, readMoney } from "../src/lib/console/view/money";
import { readMoneyContext } from "../src/lib/console/view/money-context";
import { ProjectorDataSource } from "../src/lib/console/view/source";
import { deriveWaiting } from "../src/lib/console/view/waiting";
import type { ConsoleChange } from "../src/lib/console/data";
import { skipDiscovery, writeBoards, writeReview, writeStrategy, writeTeams } from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const ID = "film";
const OFF = { AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" };
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const tempRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "console-review-"));
  roots.push(root);
  return root;
};

function film() {
  const root = tempRoot();
  const dir = path.join(root, "public/projects", ID);
  scaffoldFilmProject(dir, ID, []);
  const pipeline = path.join(dir, "pipeline");
  const project = (): FilmProject => openFilmProject(dir, { rootDir: root });
  const place = (...files: string[]) => {
    for (const file of files) copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file));
  };
  const seal = (step: string) => sealStep(project(), step);
  const approve = (step: string) => approveStep(project(), step, `yes to ${step}`);
  return { root, dir, pipeline, project, place, seal, approve, paths: projectPaths(root, ID) };
}

function toConceptGate(f: ReturnType<typeof film>) {
  f.place("brief.json");
  f.seal("intake");
  f.approve("intake");
  f.place("product-truth.json");
  f.seal("truth");
  f.place("film-targets.json");
  f.seal("reference");
  writeStrategy(f.dir);
  f.seal("strategy");
  f.approve("strategy");
  skipDiscovery(f.dir);
  writeTeams(f.dir, 1);
  f.seal("ideas");
  buildPool(f.dir, ID, "ideas");
  f.seal("idea-review");
  writeReview(f.dir, "ideas", 1, () => 4);
  rankLatest(f.dir, "ideas");
  pickIdeas(f.dir);
  writeBoards(f.dir);
  f.seal("concept");
}

const quote = (usd: number): PriceQuote => ({
  currency: "USD",
  bounded: true,
  lowUsd: usd,
  expectedUsd: usd,
  highUsd: usd,
  source: "test list price",
  asOf: "2026-11-01",
  confidence: "published-rate",
  model: "elevenlabs:music",
});

describe("money", () => {
  test("a ledger row naming a store job (operationId field or notes) is not counted twice", () => {
    const f = film();
    const store = new OperationStore(ID, { directory: f.pipeline });
    store.configure({ ceilingUsd: 5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    for (const id of ["fal:op-1", "elevenlabs:op-2"])
      store.reserveOperation({
        operationId: id,
        provider: id.split(":")[0]!,
        endpoint: "music",
        inputHash: id,
        assetId: id,
        quote: quote(0.5),
      });
    const ts = new Date().toISOString();
    const row = (extra: Record<string, unknown>) =>
      JSON.stringify({ ts, projectId: ID, service: "s", model: "m", units: 1, unitName: "request", ...extra });
    writeFileSync(
      path.join(f.pipeline, "cost-ledger.jsonl"),
      [
        row({ estimatedUsd: 0.5, notes: "endpoint=fal-ai/music operationId=fal:op-1" }),
        row({ estimatedUsd: 0.5, operationId: "elevenlabs:op-2", provider: "elevenlabs" }),
        row({ estimatedUsd: 0.25, notes: "manual" }),
      ].join("\n") + "\n",
    );
    const { money } = readMoney(f.paths);
    assert.equal(money.spentUsd, 0.25, "only the row no store job covers");
    assert.equal(money.reservedUsd, 1);
    assert.equal(
      ledgerOperationId({
        ts,
        projectId: ID,
        service: "s",
        model: "m",
        units: 1,
        unitName: "request",
        estimatedUsd: 0,
        notes: "a operationId=x:y b",
      }),
      "x:y",
    );
  });

  test("an ElevenLabs request tells its caller the durable operation id the store counts", async () => {
    const root = tempRoot();
    const directory = path.join(root, "pipeline");
    mkdirSync(directory);
    const store = new OperationStore("p", { directory });
    store.configure({ ceilingUsd: 5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    let seen: string | undefined;
    await executeElevenLabsRequest({
      endpoint: "music",
      model: "elevenlabs:music",
      identity: { prompt: "calm" },
      anchor: path.join(root, "take.mp3"),
      units: 10,
      paid: { store, onOperationId: (id) => (seen = id) },
      perform: async () => new Response("ok"),
    });
    assert.ok(seen);
    assert.deepEqual(Object.keys(store.snapshot().jobs), [seen], "the id a ledger row carries is the store's job");
  });

  test("logCost writes the durable job's operationId and provider", () => {
    const root = tempRoot();
    mkdirSync(path.join(root, "public/projects/p/pipeline"), { recursive: true });
    const cwd = process.cwd();
    process.chdir(root);
    try {
      logCost({
        projectId: "p",
        service: "ElevenLabs",
        provider: "elevenlabs",
        operationId: "elevenlabs:abc",
        model: "elevenlabs:music",
        units: 10,
        unitName: "second",
      });
    } finally {
      process.chdir(cwd);
    }
    const written = JSON.parse(readFileSync(path.join(root, "public/projects/p/pipeline/cost-ledger.jsonl"), "utf8"));
    assert.deepEqual([written.operationId, written.provider], ["elevenlabs:abc", "elevenlabs"]);
  });

  test("the view and deriveWaiting share one money context: the policy's ceiling when the store has none", async () => {
    const f = film();
    toConceptGate(f);
    revisePolicy(f.dir, ID, { budget: { ceilingUsd: 7 } }, "Seven dollars at most.");
    const context = readMoneyContext(f.paths);
    assert.equal(context.quote.ceilingUsd, 7);
    const v = ProjectViewSchema.parse(buildProjectView(f.root, ID));
    assert.equal(v.money.ceilingUsd, 7);
    assert.deepEqual(await deriveWaiting(f.root, ID), v.waiting);
  });

  test("the month's spend is not shown as complete while an item has an unknown price", async () => {
    const f = film();
    f.place("brief.json");
    const source = new ProjectorDataSource(f.root);
    const ts = new Date().toISOString();
    writeFileSync(
      path.join(f.pipeline, "cost-ledger.jsonl"),
      JSON.stringify({
        ts,
        projectId: ID,
        service: "s",
        model: "m",
        units: 1,
        unitName: "request",
        estimatedUsd: 0.5,
      }) + "\n",
    );
    let home: ProjectsResponse = await source.listProjects();
    assert.equal(home.monthSpentUsd, 0.5);
    assert.equal(source.monthUnknownPriced, 0);
    writeFileSync(
      path.join(f.pipeline, "cost-ledger.jsonl"),
      JSON.stringify({
        ts,
        projectId: ID,
        service: "s",
        model: "m",
        units: 1,
        unitName: "request",
        estimatedUsd: null,
      }) + "\n",
      { flag: "a" },
    );
    home = await source.listProjects();
    assert.equal(home.monthSpentUsd, undefined, "a partial total is not shown as the month's spend");
    assert.equal(source.monthUnknownPriced, 1);
    source.close();
  });

  test("an unbilled user-bound job counts as unknown only in its own month", async () => {
    const f = film();
    f.place("brief.json");
    const store = new OperationStore(ID, { directory: f.pipeline });
    store.configure({ ceilingUsd: 5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    store.reserveOperation({
      operationId: "elevenlabs:old",
      provider: "elevenlabs",
      endpoint: "music",
      inputHash: "old",
      assetId: "old",
      quote: { ...quote(1), confidence: "user-bound" },
    });
    assert.equal(readMoney(f.paths).money.unknownPriced, 1, "the project's view counts it");
    const now = Date.now();
    assert.equal(readMoney(f.paths, { since: now + 60_000 }).money.unknownPriced, 0, "another month does not");
    const source = new ProjectorDataSource(f.root, { now: () => now + 40 * 24 * 3600_000 });
    assert.equal((await source.listProjects()).monthSpentUsd, 0, "last month's job does not hide this month's total");
    source.close();
  });
});

describe("memoised hashes and probes", () => {
  test("FileMemo recomputes only when path, size, mtime or inode change", () => {
    const root = tempRoot();
    const file = path.join(root, "a.bin");
    writeFileSync(file, "aaaa");
    const memo = new FileMemo<number>();
    let calls = 0;
    const compute = () => ++calls;
    assert.equal(memo.get(file, compute), 1);
    assert.equal(memo.get(file, compute), 1, "unchanged: memoised");
    const T = 1_700_000_000; // whole seconds: utimes cannot restore a sub-millisecond mtime exactly
    utimesSync(file, T, T);
    assert.equal(memo.get(file, compute), 2, "mtime changed: recomputed");
    writeFileSync(file, "bbbb");
    utimesSync(file, T, T);
    assert.equal(memo.get(file, compute), 2, "same size and mtime: still memoised");
    writeFileSync(file, "bbbbb");
    assert.equal(memo.get(file, compute), 3, "size changed: recomputed");
    assert.equal(memo.get(path.join(root, "missing"), compute), 4, "a missing file is never cached");
    assert.equal(memo.get(path.join(root, "missing"), compute), 5);
  });

  test("footage's recording hash is memoised by the file's identity, not re-read on every rebuild", () => {
    const root = tempRoot();
    const file = path.join(root, "take.mp4");
    const T = 1_700_000_000;
    writeFileSync(file, "one!");
    utimesSync(file, T, T);
    const first = sha256File(file);
    writeFileSync(file, "two!");
    utimesSync(file, T, T);
    assert.equal(sha256File(file), first, "not re-read while size, mtime and inode are unchanged");
    utimesSync(file, T, T + 5);
    assert.notEqual(sha256File(file), first, "a changed mtime hashes again");
  });

  test("a film's hashes are kept across view builds: an unchanged file is not read again", () => {
    const f = film();
    const T = 1_700_000_000;
    f.place("brief.json");
    const brief = path.join(f.pipeline, "brief.json");
    utimesSync(brief, T, T);
    f.seal("intake");
    assert.equal(readFilm(f.paths).chain.steps.find((s) => s.id === "intake")?.status, "awaiting-gate");
    // Rewrite brief.json with the same size, mtime and inode: a memoised hash does not see it; a fresh read would.
    const text = readFileSync(brief, "utf8");
    const index = text.indexOf('": "') + 4; // the first character of a string value, never a key
    writeFileSync(brief, text.slice(0, index) + (text[index] === "a" ? "b" : "a") + text.slice(index + 1));
    utimesSync(brief, T, T);
    assert.equal(readFilm(f.paths).chain.steps.find((s) => s.id === "intake")?.status, "awaiting-gate");
    const fresh = deriveChain(f.project()).steps.find((s) => s.id === "intake")?.status;
    assert.notEqual(fresh, "awaiting-gate", "without the memo the change is seen (the memo was what kept it)");
  });
});

describe("watching", () => {
  const options = { debounceMs: 20, maxWaitMs: 60, pollMs: 250 };
  const waitFor = async (changes: ConsoleChange[], from: number, ms = 2500) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (changes.slice(from).some((change) => change.type === "view.changed")) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };

  test("out/<id>/ and src/projects/<id>/ created after subscribing still push view.changed (FR1)", async () => {
    const f = film();
    f.place("brief.json");
    const source = new ProjectorDataSource(f.root, options);
    const changes: ConsoleChange[] = [];
    const stop = source.watch(ID, (change) => changes.push(change));
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      let mark = changes.length;
      mkdirSync(path.join(f.root, "out", ID), { recursive: true });
      writeFileSync(path.join(f.root, "out", ID, "film.mp4"), "render");
      assert.ok(await waitFor(changes, mark), "the first render is pushed");
      const revision = source.revision(ID);
      await new Promise((resolve) => setTimeout(resolve, 150));
      mark = changes.length;
      writeFileSync(path.join(f.root, "out", ID, "film.mp4"), "render, again");
      assert.ok(await waitFor(changes, mark), "the render folder is now watched");
      assert.ok(source.revision(ID) > revision);
      mark = changes.length;
      mkdirSync(path.join(f.root, "src/projects", ID), { recursive: true });
      writeFileSync(path.join(f.root, "src/projects", ID, "Film.tsx"), "export {};");
      assert.ok(await waitFor(changes, mark), "the film's code is watched (render staleness)");
    } finally {
      stop();
      source.close();
    }
  });

  test("while watched, a read that finds a changed fingerprint bumps and pushes", async () => {
    const f = film();
    f.place("brief.json");
    // A watch so slow it never fires in this test: only the read's fingerprint can see the change.
    const source = new ProjectorDataSource(f.root, { debounceMs: 60_000, maxWaitMs: 60_000, pollMs: 60_000 });
    const changes: ConsoleChange[] = [];
    const stop = source.watch(ID, (change) => changes.push(change));
    try {
      const before = source.revision(ID);
      f.place("product-truth.json");
      assert.equal(source.revision(ID), before + 1);
      assert.ok(changes.some((change) => change.type === "view.changed" && change.revision === before + 1));
    } finally {
      stop();
      source.close();
    }
  });
});

describe("ask for changes", () => {
  const run = (root: string, script: string, args: string[]) =>
    spawnSync(process.execPath, [TSX, path.join(REPO, "scripts", script), ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...OFF },
    });

  test("after a render: the feedback file the console writes reopens the owning step", () => {
    const f = film();
    toConceptGate(f);
    mkdirSync(path.join(f.root, "out", ID), { recursive: true });
    writeFileSync(path.join(f.root, "out", ID, "film.mp4"), "the film the user watched");
    const decision = buildProjectView(f.root, ID)!.waiting.find((d) => d.step === "concept")!;
    const option = decision.options!.find((o) => o.id === "changes")!;
    assert.deepEqual(option.argv, feedbackFileArgv(ID));
    const file = path.join(f.root, "feedback-input.json");
    writeFileSync(file, JSON.stringify(feedbackFileFor("concept", "Make the idea about the night shift instead.")));
    const argv = option.argv.map((token) => (token === FEEDBACK_FILE_PLACEHOLDER ? file : token));
    const result = run(f.root, "feedback.ts", argv.slice(2));
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const ideas = deriveChain(f.project()).steps.find((s) => s.id === "ideas");
    assert.notEqual(ideas?.status, "done", "the idea pool is reopened by the user's feedback");
  });

  test("before any render: the user's words are kept as a decision in the memory", () => {
    const f = film();
    toConceptGate(f);
    const decision = buildProjectView(f.root, ID)!.waiting.find((d) => d.step === "concept")!;
    const option = decision.options!.find((o) => o.id === "changes")!;
    assert.deepEqual(option.argv, memoryChangesArgv(ID, "concept"));
    const result = run(f.root, "memory.ts", withAnswer(option.argv, "Warmer, and about people, please.").slice(2));
    assert.equal(result.status, 0, result.stderr + result.stdout);
  });
});

describe("the chain", () => {
  test("film:approve --choice records the user's idea as concept.json's selectedId; an unknown id changes nothing", () => {
    const f = film();
    toConceptGate(f);
    const conceptFile = path.join(f.pipeline, "concept.json");
    const concept = ConceptSchema.parse(JSON.parse(readFileSync(conceptFile, "utf8")));
    const other = concept.candidates.find((candidate) => candidate.id !== concept.selectedId)!.id;
    const run = (...args: string[]) =>
      spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/film-approve.ts"), ...args], {
        cwd: f.root,
        encoding: "utf8",
        env: { ...process.env, ...OFF },
      });
    const before = readFileSync(conceptFile, "utf8");
    const refused = run("--project", ID, "--step", "concept", "--answer", "The fourth one, please.", "--choice", "zz");
    assert.notEqual(refused.status, 0);
    assert.equal(readFileSync(conceptFile, "utf8"), before, "a refused choice leaves concept.json as it was");

    const result = run("--project", ID, "--step", "concept", "--answer", `Let's make ${other}.`, "--choice", other);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout.trim().split("\n").at(-1)!).metadata.selectedId, other);
    assert.equal(ConceptSchema.parse(JSON.parse(readFileSync(conceptFile, "utf8"))).selectedId, other);
    assert.equal(deriveChain(f.project()).steps.find((s) => s.id === "concept")?.status, "done");
  });

  test("the current step is the step of the next command", () => {
    const f = film();
    toConceptGate(f);
    const v = ProjectViewSchema.parse(buildProjectView(f.root, ID));
    assert.equal(v.current?.step, "concept");
    assert.ok(v.current?.next.argv.includes("concept") || v.current?.next.argv.length === 0);
  });

  test("a footage stop is shown blocked, not running", () => {
    const next = { action: "stop", step: STEP.source[0], why: "The source cannot be read." } as unknown as FootageNext;
    const row = footageSteps(next, new Map(), Date.now()).find((step) => step.id === STEP.source[0]);
    assert.equal(row?.status, "blocked");
  });

  test("options with a clashing id get a suffix; a repeated option is kept once", () => {
    const issues: string[] = [];
    const options = cleanOptions(
      [
        { id: "a", label: "", argv: ["pnpm", "x"] },
        { id: "a", label: "A again", argv: ["pnpm", "x"] },
        { id: "a", label: "Other", argv: ["pnpm", "y"] },
        { id: "b", label: "None", argv: [] },
      ],
      (issue) => issues.push(issue),
    );
    assert.deepEqual(
      options.map((option) => [option.id, option.label]),
      [
        ["a", "a"],
        ["a-2", "Other"],
      ],
    );
    assert.equal(issues.length, 4);
  });
});
