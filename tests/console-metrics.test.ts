/**
 * Interaction metrics (RFC 0004 §12, A19, WP12): decisions by channel, refusals, time to decision from the inbox,
 * rounds and rework per step, spend per project and per month with unknown prices beside the sums (never as 0), agent
 * time, verdict capture, the bounded journal tail, the revision cache and `out/console/metrics.json`.
 */
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { METRICS_FILE, ProjectViewSchema, type ConsoleEvent, type ProjectView } from "../src/types/console";
import {
  cliDecisions,
  computeMetrics,
  ConsoleMetricsSchema,
  durationStats,
  MetricsCache,
  monthStarts,
  readJournalTail,
} from "../src/lib/console/metrics";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const emptyView = JSON.parse(readFileSync("tests/fixtures/console/view-empty.json", "utf8")) as ProjectView;

function scratch(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "console-metrics-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

let seq = 0;
const ulid = () => `01KA7Z${String(++seq).padStart(20, "0")}`;

function event(project: string, kind: ConsoleEvent["kind"], fields: Partial<ConsoleEvent> = {}): ConsoleEvent {
  return { v: 1, id: ulid(), at: "2026-11-17T10:00:00Z", project, kind, ...fields } as ConsoleEvent;
}

/** A CLI run: start (with argv) and end, paired by run id. */
function run(
  project: string,
  alias: string,
  argv: string[],
  end: { ok: boolean; error?: string; channel?: "console" | "cli" },
): ConsoleEvent[] {
  const runId = `run-${++seq}`;
  const channel = end.channel ?? "cli";
  return [
    event(project, "cli.start", { runId, alias, argv, channel, actor: channel === "console" ? "user" : "agent" }),
    event(project, "cli.end", {
      runId,
      alias,
      ok: end.ok,
      elapsedMs: 10,
      channel,
      ...(end.error ? { error: end.error } : {}),
    }),
  ];
}

function project(root: string, id: string, events: ConsoleEvent[], inbox: object[] = [], ledger: object[] = []) {
  const dir = path.join(root, "public/projects", id);
  mkdirSync(path.join(dir, "pipeline/inbox"), { recursive: true });
  writeFileSync(path.join(dir, "project.json"), JSON.stringify({ title: id }));
  writeFileSync(path.join(dir, "pipeline/events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  for (const decision of inbox)
    writeFileSync(
      path.join(dir, "pipeline/inbox", `${(decision as { id: string }).id}.json`),
      JSON.stringify(decision),
    );
  if (ledger.length)
    writeFileSync(path.join(dir, "pipeline/cost-ledger.jsonl"), ledger.map((row) => JSON.stringify(row)).join("\n"));
  return dir;
}

function decided(id: string, project: string, step: string, createdAt: string, decidedAt: string, extra = {}) {
  return {
    v: 1,
    id,
    project,
    kind: "gate",
    step,
    title: `Approve ${step}`,
    bindTo: [],
    answer: "Yes, go.",
    argv: ["pnpm", "film:approve", "--project", project, "--step", step, "--answer", "Yes, go."],
    actor: "user",
    channel: "console",
    status: "applied",
    createdAt,
    decidedAt,
    result: { ok: true, elapsedMs: 5 },
    ...extra,
  };
}

function view(id: string, over: Partial<ProjectView> = {}): ProjectView {
  return ProjectViewSchema.parse({
    ...structuredClone(emptyView),
    project: { ...emptyView.project, id, route: "film", playbook: "promo" },
    ...over,
  });
}

const pending = (projectId: string, createdAt: string) => ({
  v: 1,
  id: `dec-${projectId}-${createdAt.slice(11, 13)}`,
  project: projectId,
  kind: "gate",
  step: "look",
  title: "Approve the look",
  bindTo: [],
  status: "pending",
  createdAt,
});

test("durationStats and monthStarts: nearest-rank median and p90; UTC months newest first", () => {
  assert.deepEqual(durationStats([]), { count: 0 });
  assert.deepEqual(durationStats([5, 1, 3, 2, 4, 6, 7, 8, 9, 10]), { count: 10, medianMs: 5, p90Ms: 9 });
  assert.deepEqual(
    monthStarts(Date.parse("2026-01-10T00:00:00Z"), 3).map((m) => m.month),
    ["2026-01", "2025-12", "2025-11"],
  );
});

test("cliDecisions: only decision commands with the user's words count; channels come from the run", () => {
  const events = [
    ...run("p", "film:approve", ["--project", "p", "--step", "script", "--answer", "B"], {
      ok: true,
      channel: "console",
    }),
    ...run("p", "film:approve", ["--project", "p", "--step", "look", "--answer=yes"], { ok: true }),
    ...run("p", "budget", ["--project", "p"], { ok: true }), // a read, no words
    ...run("p", "film:next", ["--project", "p"], { ok: true }),
    ...run("p", "recut:plan", ["--transcript", "t.json", "--project-id", "x"], { ok: true }), // planning, not approval
    ...run("p", "recut:plan", ["--project", "p", "--approve", "a".repeat(64), "--answer=ok"], {
      ok: true,
      channel: "console",
    }),
    ...run("p", "film:done", ["--project", "p", "--step", "music", "--skip=no music"], { ok: true }),
  ];
  assert.deepEqual(
    cliDecisions(events).map((d) => [d.alias, d.step ?? null, d.channel]),
    [
      ["film:approve", "script", "console"],
      ["film:approve", "look", "cli"],
      ["recut:plan", null, "console"],
      ["film:done", "music", "cli"],
    ],
  );
});

test("computeMetrics: decisions, refusals, rework, time to decision, spend, agents and verdicts", (t) => {
  const root = scratch(t);
  project(
    root,
    "promo",
    [
      ...run("promo", "film:approve", ["--project", "promo", "--step", "script", "--answer", "B"], {
        ok: true,
        channel: "console",
      }),
      ...run("promo", "feedback", ["--project", "promo", "--step", "build", "--answer", "tighter"], { ok: true }),
      ...run("promo", "feedback", ["--project", "promo", "--step", "build", "--answer", "again"], {
        ok: true,
        channel: "console",
      }),
      ...run("promo", "film:approve", ["--project", "promo", "--step", "human", "--answer", "8/10"], { ok: true }),
      // A console refusal: the child's end is not counted, its decision.refused event is.
      ...run("promo", "film:approve", ["--project", "promo", "--step", "material", "--answer", "go"], {
        ok: false,
        error: "BUDGET_EXCEEDED",
        channel: "console",
      }),
      event("promo", "decision.refused", {
        step: "material",
        error: "BUDGET_EXCEEDED",
        channel: "console",
        actor: "user",
        data: { decisionId: "dec-x", decisionKind: "quote", answer: "go" },
      }),
      // An agent's command refused by the pause.
      ...run("promo", "generate:image", ["--project", "promo"], { ok: false, error: "PAUSED" }),
      event("promo", "agent.start", { step: "build", data: { agentId: "a1", agentType: "motion-engineer" } }),
      event("promo", "agent.end", {
        step: "build",
        at: "2026-11-17T10:30:00Z",
        data: { agentId: "a1", durationMs: 30 * 60_000, outcome: "done" },
      }),
    ],
    [
      decided("dec-01", "promo", "script", "2026-11-17T09:00:00Z", "2026-11-17T09:10:00Z"),
      decided("dec-02", "promo", "look", "2026-11-17T09:00:00Z", "2026-11-17T09:02:00Z"),
      decided("dec-03", "promo", "human", "2026-11-17T09:00:00Z", "2026-11-17T09:30:00Z", {
        kind: "verdict",
        verdict: { score: 8 },
      }),
      decided("dec-04", "promo", "material", "2026-11-17T09:00:00Z", "2026-11-17T09:01:00Z", {
        status: "refused",
        result: { ok: false, error: "BUDGET_EXCEEDED", elapsedMs: 5 },
      }),
    ],
    [
      { ts: "2026-11-02T10:00:00Z", provider: "fal", actualUsd: 1.5 },
      { ts: "2026-10-20T10:00:00Z", provider: "fal", actualUsd: 2.25 },
      { ts: "2026-11-03T10:00:00Z", provider: "elevenlabs" }, // unknown price
    ],
  );
  project(root, "talk", [
    ...run("talk", "recut:plan", ["--project", "talk", "--approve", "a".repeat(64), "--answer=yes"], {
      ok: true,
      channel: "console",
    }),
  ]);
  const views = [
    view("promo", {
      waiting: [pending("promo", "2026-11-17T11:00:00Z")],
      qa: { findings: [], delivery: { ok: true, checkedAt: "2026-11-17T11:00:00Z" } },
      stepGuard: { violations: 2 },
    } as Partial<ProjectView>),
    view("talk", { waiting: [pending("talk", "2026-11-17T11:50:00Z")] } as Partial<ProjectView>),
  ];
  const metrics = computeMetrics({ rootDir: root, views, now: NOW });
  ConsoleMetricsSchema.parse(metrics);

  assert.equal(metrics.decisions.decided, 5);
  assert.equal(metrics.decisions.console, 3);
  assert.equal(metrics.decisions.cli, 2);
  assert.equal(metrics.decisions.consoleShare, 3 / 5);
  assert.equal(metrics.decisions.refused, 1, "one console refusal, counted once");
  assert.deepEqual(metrics.refusals, [
    { code: "STEP_GUARD", count: 2 },
    { code: "BUDGET_EXCEEDED", count: 1 },
    { code: "PAUSED", count: 1 },
  ]);
  // Inbox: applied decisions only (10, 2 and 30 minutes); the refused one is not a time to decision.
  assert.deepEqual(metrics.decisions.timeToDecision, { count: 3, medianMs: 10 * 60_000, p90Ms: 30 * 60_000 });
  assert.deepEqual(metrics.decisions.waiting, { count: 2, oldestMs: 60 * 60_000, medianMs: 10 * 60_000 });
  assert.deepEqual(metrics.rework, { reopened: 2, gates: 3, rate: 2 / 3 });
  const build = metrics.steps.find((step) => step.step === "build")!;
  assert.equal(build.rounds, 2);
  assert.equal(build.agentMs, 30 * 60_000);
  assert.equal(metrics.steps.find((step) => step.step === "material")!.refused, 1);

  assert.equal(metrics.spend.spentUsd, 3.75);
  assert.equal(metrics.spend.unknownPriced, 1, "an unknown price is counted beside the sum, never as 0");
  assert.deepEqual(metrics.spend.months.slice(0, 2), [
    { month: "2026-11", spentUsd: 1.5, unknownPriced: 1, unreadable: 0 },
    { month: "2026-10", spentUsd: 2.25, unknownPriced: 0, unreadable: 0 },
  ]);
  assert.equal(metrics.spend.months.length, 6);

  assert.deepEqual(metrics.agents.byAgent, [{ name: "motion-engineer", runs: 1, totalMs: 30 * 60_000 }]);
  assert.deepEqual(metrics.verdicts, {
    delivered: 1,
    withVerdict: 1,
    byPlaybook: [{ playbook: "promo", count: 1, meanScore: 8 }],
  });
  assert.deepEqual(
    metrics.projects.map((row) => [row.project, row.decided, row.waiting, row.refused, row.unknownPriced]),
    [
      ["promo", 4, 1, 1, 1],
      ["talk", 1, 1, 0, 0],
    ],
  );
  assert.equal(metrics.truncated, false);
});

test("readJournalTail reads only the end of a long journal, whole lines, and says so", (t) => {
  const root = scratch(t);
  const file = path.join(root, "events.jsonl");
  const lines: ConsoleEvent[] = [];
  for (let i = 0; i < 200; i++)
    lines.push(...run("p", "feedback", ["--project", "p", "--step", `s${i}`, "--answer", "x"], { ok: true }));
  writeFileSync(file, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  const whole = readJournalTail(file, 10 * 1024 * 1024);
  assert.equal(whole.truncated, false);
  assert.equal(whole.events.length, 400);
  const tail = readJournalTail(file, 4096);
  assert.equal(tail.truncated, true);
  assert.ok(tail.events.length > 0 && tail.events.length < 400);
  assert.equal(tail.events.at(-1)!.id, lines.at(-1)!.id, "the newest event is kept");
  assert.deepEqual(readJournalTail(path.join(root, "missing.jsonl")), { events: [], truncated: false });
});

test("MetricsCache: recomputes on a revision change only, refreshes waiting each call, writes metrics.json", (t) => {
  const root = scratch(t);
  const dir = project(root, "promo", [
    ...run("promo", "film:approve", ["--project", "promo", "--step", "script", "--answer", "B"], { ok: true }),
  ]);
  const cache = new MetricsCache(root);
  const views = [
    view("promo", { revision: 1, waiting: [pending("promo", "2026-11-17T11:00:00Z")] } as Partial<ProjectView>),
  ];
  const first = cache.get(views, NOW);
  assert.equal(first.decisions.decided, 1);
  assert.equal(first.decisions.waiting.oldestMs, 60 * 60_000);
  assert.ok(existsSync(path.join(root, METRICS_FILE)), "metrics.json under the given root");
  assert.equal(ConsoleMetricsSchema.parse(JSON.parse(readFileSync(path.join(root, METRICS_FILE), "utf8"))).revision, 1);

  appendFileSync(
    path.join(dir, "pipeline/events.jsonl"),
    run("promo", "film:approve", ["--project", "promo", "--step", "look", "--answer", "C"], { ok: true })
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  const cached = cache.get(views, NOW + 60_000);
  assert.equal(cached.decisions.decided, 1, "same revision: the cached figures");
  assert.equal(cached.decisions.waiting.oldestMs, 61 * 60_000, "waiting follows the clock");
  const fresh = cache.get([{ ...views[0]!, revision: 2 }], NOW + 60_000);
  assert.equal(fresh.decisions.decided, 2);
});

test("computeMetrics degrades: no journal, corrupt inbox files and no ledger give zeros, not errors", (t) => {
  const root = scratch(t);
  const dir = path.join(root, "public/projects/bare");
  mkdirSync(path.join(dir, "pipeline/inbox"), { recursive: true });
  writeFileSync(path.join(dir, "pipeline/inbox/broken.json"), "{not json");
  const metrics = computeMetrics({ rootDir: root, views: [view("bare")], now: NOW });
  assert.equal(metrics.decisions.decided, 0);
  assert.deepEqual(metrics.decisions.timeToDecision, { count: 0 });
  assert.equal(metrics.decisions.consoleShare, undefined);
  assert.equal(metrics.rework.rate, undefined);
  assert.equal(metrics.spend.spentUsd, 0);
});

test("an unreadable job store makes spend unknown, never $0; a project without one is not unreadable", (t) => {
  const root = scratch(t);
  const broken = project(root, "broken", []);
  writeFileSync(path.join(broken, "pipeline/operations.json"), "{torn");
  project(root, "fine", [], [], [{ ts: "2026-11-02T10:00:00Z", provider: "fal", actualUsd: 1 }]);
  const metrics = computeMetrics({ rootDir: root, views: [view("broken"), view("fine")], now: NOW });
  ConsoleMetricsSchema.parse(metrics);
  assert.equal(metrics.spend.unreadable, 1);
  assert.equal(metrics.spend.months[0]!.unreadable, 1);
  assert.deepEqual(
    metrics.projects.map((row) => [row.project, row.spendUnreadable]),
    [
      ["broken", true],
      ["fine", false],
    ],
  );
  assert.equal(metrics.spend.spentUsd, 1, "the readable project's spend is still summed");

  // A cost ledger that exists but cannot be read is unknown spend too (here: a folder where the file should be).
  const ledgerless = project(root, "ledgerless", []);
  mkdirSync(path.join(ledgerless, "pipeline/cost-ledger.jsonl"));
  const again = computeMetrics({ rootDir: root, views: [view("ledgerless")], now: NOW });
  assert.equal(again.projects[0]!.spendUnreadable, true);
});

test("MetricsCache recomputes when the month changes, even at the same revisions", (t) => {
  const root = scratch(t);
  project(root, "promo", [], [], [{ ts: "2026-11-30T23:00:00Z", provider: "fal", actualUsd: 2 }]);
  const cache = new MetricsCache(root, { write: false });
  const views = [view("promo", { revision: 3 } as Partial<ProjectView>)];
  const november = cache.get(views, Date.parse("2026-11-30T23:30:00Z"));
  assert.equal(november.spend.months[0]!.month, "2026-11");
  const december = cache.get(views, Date.parse("2026-12-01T00:30:00Z"));
  assert.deepEqual(
    december.spend.months.slice(0, 2).map((row) => [row.month, row.spentUsd]),
    [
      ["2026-12", 0],
      ["2026-11", 2],
    ],
  );
});
