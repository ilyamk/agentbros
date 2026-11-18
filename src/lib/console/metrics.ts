/**
 * Interaction metrics (RFC 0004 §12, A19, D20), derived locally from each project's journal, its decided decisions
 * (`pipeline/inbox/`), its job store and cost ledger, and the projector's views; nothing is sent anywhere.
 *
 * - Decisions: user decisions applied by the console (`channel: console`) and by the CLI's own decision commands with
 *   the user's words (film:approve, feedback, budget, film:policy, film:done --skip, recut:plan --approve); refusals by
 *   error code; time to decision from the inbox (`createdAt`, the gate's ready time, to `decidedAt`), per step too;
 *   decisions waiting now and since when (from the views, recomputed on every call).
 * - Rework: changes asked (`feedback`) per gate decided; rounds per step.
 * - Spend: per project from the money context (job store and ledger), per calendar month (UTC) from the store's
 *   receipts; unknown-priced items are counted beside every sum, never as 0. Wasted spend (§12): spend on outputs a
 *   later user rejection superseded ({@link wastedSpend}, wasted.ts).
 * - Agents: runs and time per agent and per step (`agentRuns`, hooks, dispatches and CLI runs).
 * - Verdicts: delivered projects with a recorded final verdict, mean score per playbook.
 *
 * Bounded (§4.4): only the last {@link METRICS_TAIL_BYTES} of each journal are read (`truncated` says when older
 * events were left out), at most {@link METRICS_INBOX_MAX} inbox files per project, and the result without the waiting
 * section is cached by the views' revisions ({@link MetricsCache}).
 */
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  EVENTS_FILE,
  INBOX_DIR,
  InboxDecisionFileSchema,
  METRICS_FILE,
  type ConsoleEvent,
  type InboxDecisionFile,
  type ProjectView,
} from "../../types/console";
import { parseEventLines } from "./events-reader";
import { ConsoleMetricsSchema, type ConsoleMetrics, type DurationStats } from "./metrics-schema";
import { agentRuns } from "./view/activity";
import { projectPaths, readJsonFile, type ProjectPaths } from "./view/files";
import { readMoney } from "./view/money";
import { readMoneyContext } from "./view/money-context";
import { CHANGE_CHOICES, wastedSpend, type WastedSpend } from "./wasted";

export { ConsoleMetricsSchema, type ConsoleMetrics } from "./metrics-schema";

/** Bytes read from the end of each project's journal. */
export const METRICS_TAIL_BYTES = 2 * 1024 * 1024;
/** Newest inbox files read per project. */
export const METRICS_INBOX_MAX = 500;
/** Calendar months of spend shown. */
export const METRICS_MONTHS = 6;

/** CLI commands that record a user's decision when they carry the user's words (D10). */
const DECISION_COMMANDS = new Set(["film:approve", "feedback", "budget", "film:policy", "film:done", "recut:plan"]);
/** Gates passed: approvals, the console's footage approval and skips. */
const GATE_COMMANDS = new Set(["film:approve", "recut:plan", "film:done"]);
/** Refusals worth counting from any command, not only decision commands. */
const REFUSAL_CODES = new Set(["PAUSED", "BUDGET_EXCEEDED"]);

// --- Reading ---

/** The journal's last `bytes`, whole lines only; `truncated` when the file is longer. */
export function readJournalTail(
  file: string,
  bytes: number = METRICS_TAIL_BYTES,
): { events: ConsoleEvent[]; truncated: boolean } {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    fd = openSync(file, "r");
    let read = 0;
    while (read < length) {
      const got = readSync(fd, buffer, read, length - read, start + read);
      if (got <= 0) break;
      read += got;
    }
    let text = buffer.subarray(0, read).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return { events: parseEventLines(text), truncated: start > 0 };
  } catch {
    return { events: [], truncated: false };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** The newest decided decisions of a project (inbox file names are ULIDs: sortable by time). */
export function readInboxDecisions(paths: ProjectPaths, max: number = METRICS_INBOX_MAX): InboxDecisionFile[] {
  let names: string[];
  try {
    names = readdirSync(path.join(paths.projectDir, INBOX_DIR)).filter((name) => /^[^.][^/]*\.json$/.test(name));
  } catch {
    return [];
  }
  return names
    .filter((name) => !name.includes(".refused-"))
    .sort()
    .slice(-max)
    .flatMap((name) => {
      const parsed = InboxDecisionFileSchema.safeParse(readJsonFile(path.join(paths.projectDir, INBOX_DIR, name)));
      return parsed.success ? [parsed.data] : [];
    });
}

// --- Arithmetic ---

/** Nearest-rank percentile of sorted values. */
function percentile(sorted: readonly number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

export function durationStats(values: readonly number[]): DurationStats {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  return { count: sorted.length, medianMs: percentile(sorted, 0.5), p90Ms: percentile(sorted, 0.9) };
}

const usd = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
const flag = (argv: readonly string[], name: string): string | undefined => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i]!.startsWith(`${name}=`)) return argv[i]!.slice(name.length + 1);
  }
  return undefined;
};
const has = (argv: readonly string[], name: string) =>
  argv.some((token) => token === name || token.startsWith(`${name}=`));

/** UTC month starts, newest first: this month and the `count - 1` before it. */
export function monthStarts(now: number, count: number = METRICS_MONTHS): { month: string; start: number }[] {
  const date = new Date(now);
  return Array.from({ length: count }, (_, index) => {
    const start = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - index, 1);
    const at = new Date(start);
    return { month: `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`, start };
  });
}

// --- One project ---

type CliDecision = {
  alias: string;
  step?: string;
  channel: "console" | "cli";
  ok: boolean;
  error?: string;
  /** When the command ended (its `cli.end`). */
  at?: string;
};

/** CLI runs (start and end paired by run id) of commands that record a user's decision. */
export function cliDecisions(events: readonly ConsoleEvent[]): CliDecision[] {
  const starts = new Map<string, ConsoleEvent>();
  const out: CliDecision[] = [];
  for (const event of events) {
    if (event.kind === "cli.start" && event.runId) starts.set(event.runId, event);
    if (event.kind !== "cli.end" || !event.runId) continue;
    const start = starts.get(event.runId);
    const alias = start?.alias ?? event.alias;
    const argv = start?.argv ?? [];
    if (!alias || !DECISION_COMMANDS.has(alias)) continue;
    const words = has(argv, "--answer") || (alias === "film:done" && has(argv, "--skip"));
    if (!words || (alias === "recut:plan" && !has(argv, "--approve"))) continue;
    const step = flag(argv, "--step") ?? event.step ?? start?.step;
    out.push({
      alias,
      ...(step ? { step: step.slice(0, 64) } : {}),
      channel: (start?.channel ?? event.channel) === "console" ? "console" : "cli",
      ok: event.ok === true,
      ...(event.error ? { error: event.error } : {}),
      ...(event.at ? { at: event.at } : {}),
    });
  }
  return out;
}

type StepAcc = { decided: number; rounds: number; refused: number; waits: number[]; agentMs: number };
type Acc = {
  decided: number;
  console: number;
  cli: number;
  refused: number;
  waits: number[];
  reopened: number;
  gates: number;
  refusals: Map<string, number>;
  steps: Map<string, StepAcc>;
  agents: Map<string, { runs: number; totalMs: number }>;
  runs: number;
  agentMs: number;
  truncated: boolean;
  scores: Map<string, number[]>;
  delivered: number;
  withVerdict: number;
  months: Map<string, { spentUsd: number; unknownPriced: number; unreadable: number }>;
  spentUsd: number;
  reservedUsd: number;
  unknownPriced: number;
  /** Projects whose job store or ledger could not be read: their spend is unknown, never $0. */
  unreadable: number;
  wasted: WastedSpend;
};

const stepOf = (acc: Acc, step: string): StepAcc => {
  let entry = acc.steps.get(step);
  if (!entry) acc.steps.set(step, (entry = { decided: 0, rounds: 0, refused: 0, waits: [], agentMs: 0 }));
  return entry;
};
const bump = (map: Map<string, number>, key: string, by = 1) => map.set(key, (map.get(key) ?? 0) + by);

function projectMetrics(acc: Acc, paths: ProjectPaths, view: ProjectView | undefined, now: number, tailBytes: number) {
  const { events, truncated } = readJournalTail(path.join(paths.projectDir, EVENTS_FILE), tailBytes);
  acc.truncated ||= truncated;
  let decided = 0;
  let refused = 0;
  const decisions = cliDecisions(events);

  for (const decision of decisions) {
    const step = decision.step ? stepOf(acc, decision.step) : undefined;
    if (!decision.ok) {
      // A console decision's refusal is its `decision.refused` event (below), not its child command's end.
      if (decision.channel === "console") continue;
      refused++;
      bump(acc.refusals, decision.error ?? "INTERNAL");
      if (step) step.refused++;
      continue;
    }
    decided++;
    if (decision.channel === "console") acc.console++;
    else acc.cli++;
    if (decision.alias === "feedback") {
      acc.reopened++;
      if (step) step.rounds++;
    } else if (GATE_COMMANDS.has(decision.alias)) {
      acc.gates++;
      if (step) step.decided++;
    }
  }
  for (const event of events) {
    if (event.kind === "decision.refused") {
      refused++;
      bump(acc.refusals, event.error ?? "REFUSED");
      if (event.step) stepOf(acc, event.step).refused++;
    } else if (event.kind === "cli.end" && event.ok === false && event.error && REFUSAL_CODES.has(event.error)) {
      const alias = event.alias ?? "";
      if (!DECISION_COMMANDS.has(alias)) bump(acc.refusals, event.error);
    }
  }
  const guard = view?.stepGuard?.violations ?? 0;
  if (guard) bump(acc.refusals, "STEP_GUARD", guard);

  let verdict = false;
  const inbox = readInboxDecisions(paths);
  for (const decision of inbox) {
    if (decision.status !== "applied" && decision.status !== "partial") continue;
    const decidedAt = Date.parse(decision.decidedAt ?? "");
    const created = Date.parse(decision.createdAt);
    if (Number.isFinite(decidedAt) && Number.isFinite(created)) {
      const wait = Math.max(0, decidedAt - created);
      acc.waits.push(wait);
      if (decision.step) stepOf(acc, decision.step).waits.push(wait);
    }
    // Changes asked before a render are kept in memory (view/argv.ts memoryChangesArgv): no decision command runs,
    // so the console's own record is the decision and the step's new round.
    if (decision.status === "applied" && decision.argv?.[1] === "memory" && CHANGE_CHOICES.has(decision.choice ?? "")) {
      decided++;
      acc.console++;
      acc.reopened++;
      if (decision.step) stepOf(acc, decision.step).rounds++;
    }
    if (decision.verdict) {
      verdict = true;
      const playbook = view?.project.playbook ?? "none";
      const list = acc.scores.get(playbook) ?? [];
      list.push(decision.verdict.score);
      acc.scores.set(playbook, list);
    }
  }
  // A verdict given on the command line (film:approve --step human) counts as recorded too.
  verdict ||= decisions.some((d) => d.ok && d.alias === "film:approve" && d.step === "human");
  if (view?.qa.delivery?.ok) {
    acc.delivered++;
    if (verdict) acc.withVerdict++;
  }

  for (const run of agentRuns(events, { now })) {
    const ms = run.durationMs ?? (run.status === "running" ? Math.max(0, now - Date.parse(run.startedAt)) : 0);
    acc.runs++;
    acc.agentMs += ms;
    const agent = acc.agents.get(run.name) ?? { runs: 0, totalMs: 0 };
    agent.runs++;
    agent.totalMs += ms;
    acc.agents.set(run.name, agent);
    if (run.step) stepOf(acc, run.step).agentMs += ms;
  }

  const context = readMoneyContext(paths);
  const money = context.money;
  const unreadable = moneyUnreadable(context.advisories) || ledgerUnreadable(paths.projectDir);
  if (unreadable) acc.unreadable++;
  acc.spentUsd += money.spentUsd;
  acc.reservedUsd += money.reservedUsd;
  acc.unknownPriced += money.unknownPriced;
  // Month k = spend since its start minus spend since the next month's start (the store's receipts, the ledger's ts).
  let later = { spentUsd: 0, unknownPriced: 0 };
  for (const { month, start } of monthStarts(now)) {
    let since: { spentUsd: number; unknownPriced: number };
    let monthUnreadable = unreadable;
    try {
      const read = readMoney(paths, { since: start });
      since = read.money;
      monthUnreadable ||= moneyUnreadable(read.advisories);
    } catch {
      since = later;
      monthUnreadable = true;
    }
    const row = acc.months.get(month) ?? { spentUsd: 0, unknownPriced: 0, unreadable: 0 };
    if (monthUnreadable) row.unreadable++;
    row.spentUsd += Math.max(0, since.spentUsd - later.spentUsd);
    row.unknownPriced += Math.max(0, since.unknownPriced - later.unknownPriced);
    acc.months.set(month, row);
    later = since;
  }

  let wasted: WastedSpend | undefined;
  try {
    wasted = wastedSpend(paths, {
      events,
      inbox,
      feedbackRuns: decisions.filter((d) => d.ok && d.alias === "feedback"),
      film: view?.project.route === "film",
    });
    acc.wasted.usd += wasted.usd;
    acc.wasted.items += wasted.items;
    acc.wasted.unknownPriced += wasted.unknownPriced;
    acc.wasted.unattributed += wasted.unattributed;
  } catch {
    // A corrupt job store: already counted in `unreadable`, so the wasted sum is unknown for it, not $0.
  }

  acc.decided += decided;
  acc.refused += refused;
  return {
    project: paths.id,
    ...(view ? { route: view.project.route } : {}),
    ...(view?.project.playbook ? { playbook: view.project.playbook } : {}),
    decided,
    waiting: view?.waiting.length ?? 0,
    refused,
    spentUsd: money.spentUsd,
    reservedUsd: money.reservedUsd,
    unknownPriced: money.unknownPriced,
    spendUnreadable: unreadable,
    ...(wasted ? { wastedUsd: wasted.usd, wastedUnknownPriced: wasted.unknownPriced } : {}),
    ...(money.ceilingUsd !== undefined ? { ceilingUsd: money.ceilingUsd } : {}),
    truncated,
  };
}

/** readMoney reports an unreadable job store (or a failed read) as a `money:` advisory instead of throwing. */
const moneyUnreadable = (advisories: readonly string[]) => advisories.some((line) => line.startsWith("money:"));

/** The cost ledger exists but cannot be read (readLedgerRows reads that as no rows; here it is unknown spend). */
function ledgerUnreadable(projectDir: string): boolean {
  try {
    readFileSync(path.join(projectDir, "pipeline", "cost-ledger.jsonl"));
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

// --- All projects ---

export type MetricsInput = {
  rootDir: string;
  /** The views of the projects to measure (the data source's own, cached by revision). */
  views: readonly ProjectView[];
  now?: number;
  /** Cache key: the views' revisions. Default: their sum. */
  revision?: number;
  tailBytes?: number;
};

/** Decisions waiting now: count, the oldest and the median wait (depends on the clock, so never cached). */
export function waitingNow(views: readonly ProjectView[], now: number): ConsoleMetrics["decisions"]["waiting"] {
  const waits = views
    .flatMap((view) => view.waiting)
    .map((decision) => Math.max(0, now - Date.parse(decision.createdAt)))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (!waits.length) return { count: 0 };
  return { count: waits.length, oldestMs: waits.at(-1)!, medianMs: percentile(waits, 0.5) };
}

/** Every metric for the given projects (validated: a value out of range throws, which is a bug here). */
export function computeMetrics(input: MetricsInput): ConsoleMetrics {
  const now = input.now ?? Date.now();
  const rootDir = path.resolve(input.rootDir);
  const acc: Acc = {
    decided: 0,
    console: 0,
    cli: 0,
    refused: 0,
    waits: [],
    reopened: 0,
    gates: 0,
    refusals: new Map(),
    steps: new Map(),
    agents: new Map(),
    runs: 0,
    agentMs: 0,
    truncated: false,
    scores: new Map(),
    delivered: 0,
    withVerdict: 0,
    months: new Map(),
    spentUsd: 0,
    reservedUsd: 0,
    unknownPriced: 0,
    unreadable: 0,
    wasted: { usd: 0, items: 0, unknownPriced: 0, unattributed: 0 },
  };
  const projects = [...input.views]
    .sort((a, b) => a.project.id.localeCompare(b.project.id))
    .slice(0, 500)
    .map((view) =>
      projectMetrics(acc, projectPaths(rootDir, view.project.id), view, now, input.tailBytes ?? METRICS_TAIL_BYTES),
    );
  const sum = acc.console + acc.cli;
  const metrics: ConsoleMetrics = {
    v: 1,
    generatedAt: new Date(now).toISOString(),
    revision: input.revision ?? input.views.reduce((total, view) => total + view.revision, 0),
    truncated: acc.truncated,
    decisions: {
      decided: acc.decided,
      console: acc.console,
      cli: acc.cli,
      ...(sum ? { consoleShare: acc.console / sum } : {}),
      refused: acc.refused,
      timeToDecision: durationStats(acc.waits),
      waiting: waitingNow(input.views, now),
    },
    rework: {
      reopened: acc.reopened,
      gates: acc.gates,
      ...(acc.gates ? { rate: acc.reopened / acc.gates } : {}),
    },
    refusals: [...acc.refusals]
      .map(([code, count]) => ({ code: code.slice(0, 64), count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
      .slice(0, 32),
    steps: [...acc.steps]
      .map(([step, entry]) => ({
        step,
        decided: entry.decided,
        rounds: entry.rounds,
        refused: entry.refused,
        timeToDecision: durationStats(entry.waits),
        agentMs: entry.agentMs,
      }))
      .sort((a, b) => b.rounds - a.rounds || b.decided - a.decided || a.step.localeCompare(b.step))
      .slice(0, 200),
    spend: {
      spentUsd: usd(acc.spentUsd),
      reservedUsd: usd(acc.reservedUsd),
      unknownPriced: acc.unknownPriced,
      unreadable: acc.unreadable,
      wasted: { ...acc.wasted, usd: usd(acc.wasted.usd) },
      months: monthStarts(now).map(({ month }) => {
        const row = acc.months.get(month) ?? { spentUsd: 0, unknownPriced: 0, unreadable: 0 };
        return { month, spentUsd: usd(row.spentUsd), unknownPriced: row.unknownPriced, unreadable: row.unreadable };
      }),
    },
    agents: {
      runs: acc.runs,
      totalMs: acc.agentMs,
      byAgent: [...acc.agents]
        .map(([name, entry]) => ({ name: name.slice(0, 128), ...entry }))
        .sort((a, b) => b.totalMs - a.totalMs || a.name.localeCompare(b.name))
        .slice(0, 50),
    },
    verdicts: {
      delivered: acc.delivered,
      withVerdict: acc.withVerdict,
      byPlaybook: [...acc.scores]
        .map(([playbook, scores]) => ({
          playbook: playbook.slice(0, 64),
          count: scores.length,
          meanScore: Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100,
        }))
        .sort((a, b) => a.playbook.localeCompare(b.playbook))
        .slice(0, 50),
    },
    projects,
  };
  return ConsoleMetricsSchema.parse(metrics);
}

/**
 * Caches the metrics by the views' revisions: a recomputation only when a project changed; the waiting section and
 * the time are refreshed on every call. Writes `out/console/metrics.json` (best effort) after each recomputation.
 */
export class MetricsCache {
  private cached?: { key: string; metrics: ConsoleMetrics };
  constructor(
    readonly rootDir: string,
    private readonly options: { write?: boolean; tailBytes?: number } = {},
  ) {}

  get(views: readonly ProjectView[], now: number = Date.now()): ConsoleMetrics {
    // The month is part of the key: the spend per month moves with the calendar, not only with the revisions.
    const month = new Date(now).toISOString().slice(0, 7);
    const key = `${month}#${views
      .map((view) => `${view.project.id}:${view.revision}`)
      .sort()
      .join("|")}`;
    if (this.cached?.key !== key) {
      const metrics = computeMetrics({
        rootDir: this.rootDir,
        views,
        now,
        ...(this.options.tailBytes ? { tailBytes: this.options.tailBytes } : {}),
      });
      this.cached = { key, metrics };
      if (this.options.write !== false) writeMetricsFile(this.rootDir, metrics);
      return metrics;
    }
    const metrics = this.cached.metrics;
    return {
      ...metrics,
      generatedAt: new Date(now).toISOString(),
      decisions: { ...metrics.decisions, waiting: waitingNow(views, now) },
    };
  }
}

/** `out/console/metrics.json`, atomically; a failure is ignored (the metrics are derived, never the truth). */
export function writeMetricsFile(rootDir: string, metrics: ConsoleMetrics): boolean {
  try {
    const file = path.join(rootDir, METRICS_FILE);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(metrics, null, 2)}\n`);
    renameSync(temporary, file);
    return true;
  } catch {
    return false;
  }
}
