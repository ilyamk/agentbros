/**
 * The console's projector (RFC 0004 WP3, §13 "Projector"): views per route and chain status parse with the contract,
 * waiting decisions come from chain state (not the journal) with deterministic ids, steps match `film:status`,
 * durations and agent runs come from the journal, and the projector writes nothing.
 */
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ProjectViewSchema, ProjectsResponseSchema, type ConsoleEvent } from "../src/types/console";
import { scaffoldFilmProject } from "../src/lib/film/project";
import { approveStep, deriveChain, openFilmProject, sealStep, type FilmProject } from "../src/lib/film/state";
import { buildPool, pickIdeas, rankLatest } from "../src/lib/film/studio";
import { buildProjectView } from "../src/lib/console/view/build";
import { deriveWaiting } from "../src/lib/console/view/waiting";
import { outputsHash } from "../src/lib/console/view/film";
import { ANSWER_PLACEHOLDER } from "../src/lib/console/view/argv";
import { ProjectorDataSource } from "../src/lib/console/view/source";
import { skipDiscovery, writeBoards, writeReview, writeStrategy, writeTeams } from "./helpers/film-studio";

const REPO = path.resolve(import.meta.dirname, "..");
const FIXTURES = path.join(REPO, "tests/fixtures/film-chain");
const TSX = path.join(REPO, "node_modules/tsx/dist/cli.mjs");
const ID = "film";
const roots: string[] = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function film() {
  const root = mkdtempSync(path.join(tmpdir(), "console-projector-"));
  roots.push(root);
  const dir = path.join(root, "public/projects", ID);
  scaffoldFilmProject(dir, ID, []);
  const pipeline = path.join(dir, "pipeline");
  const project = (): FilmProject => openFilmProject(dir, { rootDir: root });
  const place = (...files: string[]) => {
    for (const file of files) copyFileSync(path.join(FIXTURES, file), path.join(pipeline, file));
  };
  const seal = (step: string) => sealStep(project(), step);
  const approve = (step: string, at?: string) => approveStep(project(), step, `yes to ${step}`, at);
  return { root, dir, pipeline, project, place, seal, approve };
}
type Film = ReturnType<typeof film>;

/** Intake, truth and reference closed; strategy approved; the idea pool reviewed; the concept sealed, awaiting the user. */
function toConceptGate(f: Film) {
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

const view = (f: { root: string }, now?: number) => {
  const built = buildProjectView(f.root, ID, now === undefined ? {} : { now });
  assert.ok(built, "a view");
  return ProjectViewSchema.parse(built);
};

let counter = 0;
const ulid = () => `01KA${String(++counter).padStart(22, "0")}`;
const line = (event: Partial<ConsoleEvent> & Pick<ConsoleEvent, "kind" | "at">) =>
  JSON.stringify({ v: 1, id: ulid(), project: ID, ...event }) + "\n";

function tree(root: string, prefix = ""): string[] {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) return [relative + "/", ...tree(root, relative)];
    const info = statSync(path.join(root, relative));
    return [`${relative} ${info.size} ${info.mtimeMs}`];
  });
}

describe("film views", () => {
  test("an open intake gate: view parses, waiting decision from state with exact argv and binding", () => {
    const f = film();
    f.place("brief.json");
    f.seal("intake");
    const v = view(f);
    assert.equal(v.project.route, "film");
    assert.equal(v.current?.step, "intake");
    assert.equal(v.steps[0]!.status, "awaiting-gate");
    assert.equal(v.waiting.length, 1);
    const decision = v.waiting[0]!;
    assert.equal(decision.kind, "gate");
    assert.equal(decision.status, "pending");
    const brief = readFileSync(path.join(f.pipeline, "brief.json"));
    assert.deepEqual(decision.bindTo, [
      { path: "pipeline/brief.json", sha256: createHash("sha256").update(brief).digest("hex") },
    ]);
    const expect = outputsHash(deriveChain(f.project()).steps.find((s) => s.id === "intake")!.outputs);
    assert.deepEqual(decision.options?.[0]?.argv, [
      "pnpm",
      "film:approve",
      "--project",
      ID,
      "--step",
      "intake",
      "--answer",
      ANSWER_PLACEHOLDER,
      "--expect",
      expect,
    ]);
  });

  test("decision ids are deterministic, change with the material, and the decision goes once approved", async () => {
    const f = film();
    f.place("brief.json");
    f.seal("intake");
    const first = await deriveWaiting(f.root, ID);
    const again = await deriveWaiting(f.root, ID);
    assert.equal(first.length, 1);
    assert.deepEqual(
      again.map((d) => [d.id, d.createdAt]),
      first.map((d) => [d.id, d.createdAt]),
    );
    assert.deepEqual(
      view(f).waiting.map((d) => d.id),
      first.map((d) => d.id),
      "the view and deriveWaiting agree",
    );
    const brief = JSON.parse(readFileSync(path.join(f.pipeline, "brief.json"), "utf8"));
    writeFileSync(path.join(f.pipeline, "brief.json"), JSON.stringify({ ...brief, topic: "another topic" }));
    f.seal("intake");
    const changed = await deriveWaiting(f.root, ID);
    assert.equal(changed.length, 1);
    assert.notEqual(changed[0]!.id, first[0]!.id, "a changed brief is another decision");
    f.approve("intake");
    assert.deepEqual(
      (await deriveWaiting(f.root, ID)).filter((d) => d.step === "intake"),
      [],
    );
  });

  test("waiting comes from state, not the journal: a journal line neither adds nor removes a decision", async () => {
    const f = film();
    f.place("brief.json");
    f.seal("intake");
    const before = (await deriveWaiting(f.root, ID)).map((d) => d.id);
    writeFileSync(
      path.join(f.pipeline, "events.jsonl"),
      line({
        kind: "decision.applied",
        at: "2026-11-17T09:00:00.000Z",
        data: { decisionId: before[0]!, decisionKind: "gate", answer: "yes" },
      }),
    );
    assert.deepEqual(
      (await deriveWaiting(f.root, ID)).map((d) => d.id),
      before,
    );
    assert.deepEqual(await deriveWaiting(f.root, "missing-project"), []);
    assert.deepEqual(await deriveWaiting(f.root, "../etc"), []);
  });

  test("the concept gate is a choice of the three ideas, with the director's recommendation", () => {
    const f = film();
    toConceptGate(f);
    const v = view(f);
    assert.equal(v.current?.step, "concept");
    const decision = v.waiting.find((d) => d.step === "concept")!;
    assert.equal(decision.kind, "choice");
    assert.equal(decision.options?.at(-1)?.id, "changes");
    const ideas = decision.options!.filter((option) => option.id.startsWith("idea-"));
    assert.equal(ideas.length, 3);
    for (const option of ideas) {
      assert.deepEqual(option.argv.slice(0, 8), [
        "pnpm",
        "film:approve",
        "--project",
        ID,
        "--step",
        "concept",
        "--answer",
        ANSWER_PLACEHOLDER,
      ]);
      assert.equal(option.argv[8], "--expect");
      // The pick is real: each idea's argv names it, so film:approve records it as concept.json's selectedId.
      assert.deepEqual(option.argv.slice(10), ["--choice", option.id.slice("idea-".length)]);
    }
    assert.ok(decision.recommendation?.text.includes("Recommended"));
    assert.ok(decision.bindTo.some((b) => b.path === "pipeline/concept.json"));
    for (const row of v.steps.filter((s) => s.status === "done")) assert.ok(row.closedAt, `${row.id} has closedAt`);
  });

  test("the music shortlist is a choice per candidate that records it with the user's words", () => {
    const f = film();
    toConceptGate(f);
    f.approve("concept");
    mkdirSync(path.join(f.dir, "music"), { recursive: true });
    copyFileSync(path.join(FIXTURES, "track.wav"), path.join(f.dir, "music/track.wav"));
    f.place("music-shortlist.json");
    const decision = view(f).waiting.find((d) => d.step === "music")!;
    assert.equal(decision.kind, "choice");
    assert.deepEqual(
      decision.options?.map((o) => o.argv),
      ["stock-1", "stock-2"].map((candidate) => [
        "pnpm",
        "music",
        "--action",
        "record",
        "--project",
        ID,
        "--route",
        "free-stock",
        "--candidate",
        candidate,
        "--answer",
        ANSWER_PLACEHOLDER,
        "--reason",
        ANSWER_PLACEHOLDER,
      ]),
    );
  });

  test("steps and statuses match film:status (parity, RFC §16)", () => {
    const f = film();
    toConceptGate(f);
    const result = spawnSync(process.execPath, [TSX, path.join(REPO, "scripts/film-status.ts"), "--project", ID], {
      cwd: f.root,
      encoding: "utf8",
      env: { ...process.env, AGENTBROS_EVENTS: "off", AGENTBROS_CONSOLE: "off", AGENTBROS_HOOKS: "off" },
    });
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout.trim().split("\n").at(-1)!) as {
      metadata: { currentStep: string; steps: { id: string; status: string; reasons: string[] }[] };
    };
    const v = view(f);
    assert.deepEqual(
      v.steps.map((s) => [s.id, s.status, s.reasons]),
      status.metadata.steps.map((s) => [s.id, s.status, s.reasons]),
    );
    assert.equal(v.current?.step, status.metadata.currentStep);
  });

  test("durations and agent runs come from the journal; hooks join a dispatch and link child to parent", () => {
    const f = film();
    f.place("brief.json");
    // After the seal's wall-clock receipt, so the approval at minute 10 is the newest close.
    const t0 = Math.ceil(Date.now() / 60_000) * 60_000 + 60_000;
    const at = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();
    writeFileSync(
      path.join(f.pipeline, "events.jsonl"),
      [
        line({ kind: "cli.start", at: at(0), runId: "r1", alias: "film:brief", step: "intake" }),
        line({
          kind: "agent.dispatch",
          at: at(0),
          runId: "r1",
          step: "intake",
          agent: { name: "brief-collector", role: "owner" },
          data: { brief: "pipeline/briefs/intake.md" },
        }),
        line({ kind: "cli.end", at: at(0), runId: "r1", alias: "film:brief", ok: true, elapsedMs: 5 }),
        line({ kind: "agent.start", at: at(1), data: { agentId: "session-1", scope: "session" } }),
        line({
          kind: "agent.start",
          at: at(2),
          data: { agentId: "sub-1", agentType: "brief-collector", scope: "subagent" },
        }),
        line({
          kind: "agent.notification",
          at: at(2),
          data: { type: "agent-link", agentId: "sub-1", parentAgentId: "session-1", toolUseId: "t1" },
        }),
        line({ kind: "cli.start", at: at(3), runId: "r2", alias: "film:done", step: "intake" }),
        line({ kind: "agent.end", at: at(5), data: { agentId: "sub-1", durationMs: 180_000, outcome: "done" } }),
      ].join(""),
    );
    f.seal("intake");
    f.approve("intake", at(10));
    const v = view(f, t0 + 11 * 60_000);
    const intake = v.steps.find((s) => s.id === "intake")!;
    assert.equal(intake.startedAt, at(0));
    assert.equal(intake.closedAt, at(10));
    assert.equal(intake.durationMs, 10 * 60_000);
    const sub = v.agents.today.find((run) => run.id === "sub-1")!;
    assert.deepEqual([sub.status, sub.durationMs, sub.parentId, sub.step], ["done", 180_000, "session-1", "intake"]);
    assert.equal(sub.commands, 1, "film:done ran inside the subagent");
    assert.equal(
      v.agents.today.filter((run) => run.source === "dispatch").length,
      0,
      "the hook run took the dispatch's place",
    );
    assert.equal(v.agents.active?.id, "session-1");
  });

  test("a dispatch without hooks is a running run until its step closes", () => {
    const f = film();
    f.place("brief.json");
    const at = "2026-11-17T09:00:00.000Z";
    writeFileSync(
      path.join(f.pipeline, "events.jsonl"),
      line({
        kind: "agent.dispatch",
        at,
        runId: "r9",
        step: "intake",
        agent: { name: "brief-collector" },
        data: { brief: "pipeline/briefs/intake.md" },
      }),
    );
    let v = view(f, Date.parse(at) + 60_000);
    assert.equal(v.agents.active?.source, "dispatch");
    assert.equal(v.agents.active?.durationMs, 60_000);
    f.seal("intake");
    f.approve("intake");
    v = view(f, Date.parse(at) + 60_000);
    assert.equal(v.agents.active, undefined);
  });

  test("the projector writes nothing", async () => {
    const f = film();
    toConceptGate(f);
    const before = tree(f.root);
    view(f);
    await deriveWaiting(f.root, ID);
    const source = new ProjectorDataSource(f.root);
    await source.view(ID);
    await source.listProjects();
    assert.deepEqual(tree(f.root), before);
  });

  test("a 200-step-event project builds within the §4.4 budget (warn only)", () => {
    const f = film();
    toConceptGate(f);
    const steps = ["intake", "truth", "reference", "strategy", "ideas", "idea-review", "concept"];
    let text = "";
    for (let index = 0; index < 200; index++) {
      const at = new Date(Date.parse("2026-11-17T08:00:00.000Z") + index * 1000).toISOString();
      const step = steps[index % steps.length]!;
      text += line({ kind: "cli.start", at, runId: `run${index}`, alias: "film:done", step });
      text += line({ kind: "cli.end", at, runId: `run${index}`, alias: "film:done", step, ok: true, elapsedMs: 3 });
    }
    writeFileSync(path.join(f.pipeline, "events.jsonl"), text);
    view(f); // warm module caches
    const started = performance.now();
    view(f);
    const elapsed = performance.now() - started;
    if (elapsed > 300) console.warn(`console projector: view took ${Math.round(elapsed)} ms (budget 300 ms)`);
    assert.ok(elapsed < 10_000);
  });
});

describe("other routes and degraded files", () => {
  test("a project.json project is the timeline route with its render step", () => {
    const root = mkdtempSync(path.join(tmpdir(), "console-projector-"));
    roots.push(root);
    const dir = path.join(root, "public/projects", ID);
    mkdirSync(path.join(dir, "pipeline"), { recursive: true });
    writeFileSync(path.join(dir, "project.json"), JSON.stringify({ title: "Demo", formats: ["vertical"] }));
    const v = view({ root });
    assert.equal(v.project.route, "timeline");
    assert.equal(v.project.title, "Demo");
    assert.deepEqual(v.project.formats, ["vertical"]);
    assert.equal(v.current?.step, "render");
    writeFileSync(path.join(dir, "pipeline/recipe.json"), "{}");
    assert.equal(view({ root }).project.route, "recipe");
  });

  test("a campaign container gets the minimal view; a footage project with broken goals degrades", () => {
    const root = mkdtempSync(path.join(tmpdir(), "console-projector-"));
    roots.push(root);
    const campaign = path.join(root, "public/projects", ID);
    mkdirSync(path.join(campaign, "pipeline/campaign-production"), { recursive: true });
    writeFileSync(
      path.join(campaign, "pipeline/campaign-production/owner.json"),
      JSON.stringify({ version: 1, campaignId: ID }),
    );
    const v = view({ root });
    assert.equal(v.project.route, "campaign");
    assert.ok(v.advisories.some((line) => line.startsWith("Minimal view")));

    const footage = path.join(root, "public/projects/rec");
    mkdirSync(path.join(footage, "pipeline"), { recursive: true });
    writeFileSync(path.join(footage, "pipeline/footage-goals.json"), "{ not json");
    const f = ProjectViewSchema.parse(buildProjectView(root, "rec"));
    assert.equal(f.project.route, "footage");
    assert.ok(
      f.advisories.some((line) => line.startsWith("footage:")),
      f.advisories.join("\n"),
    );
  });

  test("corrupt control, store, registry, policy and card files never throw: each degrades with an advisory", () => {
    const f = film();
    f.place("brief.json");
    f.seal("intake");
    mkdirSync(path.join(f.pipeline, "session"), { recursive: true });
    mkdirSync(path.join(f.pipeline, "cards"), { recursive: true });
    writeFileSync(path.join(f.pipeline, "session/control.json"), "{ broken");
    writeFileSync(path.join(f.pipeline, "operations.json"), '{"version":1}');
    writeFileSync(path.join(f.pipeline, "asset-registry.json"), '{"assets":[{}]}');
    writeFileSync(path.join(f.pipeline, "policy.json"), "[]");
    writeFileSync(path.join(f.pipeline, "cards/bad.json"), "{}");
    writeFileSync(
      path.join(f.pipeline, "cost-ledger.jsonl"),
      'torn\n{"ts":"2026-11-17T00:00:00Z","service":"x","model":"m","estimatedUsd":null}\n',
    );
    writeFileSync(path.join(f.pipeline, "events.jsonl"), "garbage\n{}\n");
    const v = view(f);
    assert.equal(v.control.state, "running");
    assert.equal(v.money.unknownPriced, 1, "an unpriced ledger row is unknown, not free");
    for (const prefix of ["control:", "money:", "assets:", "cards:"])
      assert.ok(
        v.advisories.some((line) => line.startsWith(prefix)),
        `${prefix} advisory in ${v.advisories.join(" | ")}`,
      );
    // An unreadable policy stops the chain itself (nextAction says so): no gate is offered, the stop is told, and the
    // current step is the one the next action names, so step and command agree.
    assert.equal(v.autonomy.mode, "interactive");
    assert.deepEqual(v.waiting, []);
    assert.ok(v.advisories.some((line) => line.includes("policy cannot be read")));
    assert.equal(v.current?.step, "present-best");
    rmSync(path.join(f.pipeline, "policy.json"));
    assert.equal(view(f).waiting.length, 1, "the gate is derived once the policy is gone");
  });

  test("agent cards: pending ones become card-answer decisions; expired ones are left out", () => {
    const f = film();
    f.place("brief.json");
    mkdirSync(path.join(f.pipeline, "cards"), { recursive: true });
    const card = (id: string, extra: Record<string, unknown>) =>
      writeFileSync(
        path.join(f.pipeline, "cards", `${id}.json`),
        JSON.stringify({
          v: 1,
          id,
          project: ID,
          createdAt: "2026-11-17T09:00:00Z",
          kind: "choice",
          title: `Card ${id}`,
          from: { agent: "design-director" },
          options: [
            { id: "a", label: "A" },
            { id: "b", label: "B" },
          ],
          expectsAnswer: true,
          ...extra,
        }),
      );
    card("c1", {});
    card("c2", { expiresAt: "2026-11-17T09:30:00Z" });
    card("c3", { answer: { choice: "a", at: "2026-11-17T09:10:00Z" } });
    const v = view(f, Date.parse("2026-11-17T10:00:00Z"));
    assert.deepEqual(
      v.cards.map((c) => c.id),
      ["c1", "c3"],
    );
    const decisions = v.waiting.filter((d) => d.kind === "card-answer");
    assert.deepEqual(
      decisions.map((d) => [d.cardId, d.bindTo[0]?.path]),
      [["c1", "pipeline/cards/c1.json"]],
    );
    assert.ok(v.advisories.some((line) => line.includes("expired")));
  });
});

describe("data source", () => {
  test("revisions start at 0, increment on change, and views are cached by revision", async () => {
    const f = film();
    f.place("brief.json");
    f.seal("intake");
    const source = new ProjectorDataSource(f.root);
    assert.equal(source.revision(ID), 0);
    const first = await source.view(ID);
    assert.equal(first?.revision, 0);
    assert.equal(await source.view(ID), first, "cached");
    writeFileSync(path.join(f.pipeline, "note.json"), "{}");
    assert.equal(source.revision(ID), 1);
    const second = await source.view(ID);
    assert.equal(second?.revision, 1);
    assert.notEqual(second, first);
    assert.equal(await source.view("missing"), undefined);
    const home = ProjectsResponseSchema.parse(await source.listProjects());
    assert.deepEqual(
      home.projects.map((p) => [p.id, p.route, p.step, p.waiting]),
      [[ID, "film", "intake", 1]],
    );
    assert.equal(home.waiting.length, 1);
    assert.equal(home.monthSpentUsd, 0);
  });

  test("a watched project reports file changes and journal lines within 1 s (FR1)", async () => {
    const f = film();
    f.place("brief.json");
    const source = new ProjectorDataSource(f.root);
    const changes: { type: string; revision: number; at: number }[] = [];
    const stop = source.watch(ID, (change) =>
      changes.push({ type: change.type, revision: change.revision, at: performance.now() }),
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const start = performance.now();
      writeFileSync(
        path.join(f.pipeline, "events.jsonl"),
        line({ kind: "cli.start", at: "2026-11-17T09:00:00.000Z", runId: "x", alias: "film:next" }),
      );
      const deadline = Date.now() + 1500;
      while (!changes.some((c) => c.type === "view.changed") && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      const changed = changes.find((c) => c.type === "view.changed");
      assert.ok(changed, "view.changed arrived");
      assert.ok(changed.at - start < 1000);
      assert.ok(
        changes.some((c) => c.type === "event"),
        "the journal line arrived as an event",
      );
      assert.equal(source.revision(ID), changed.revision);
      assert.equal((await source.view(ID))?.revision, changed.revision);
    } finally {
      stop();
      source.close();
    }
  });
});
