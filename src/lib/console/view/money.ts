/**
 * The money panel (RFC 0004 §6.2): the job store (`pipeline/operations.json`, read through `OperationStore`) for the
 * ceiling, reservations, receipts and jobs, plus `pipeline/cost-ledger.jsonl` rows no store job covers. An unknown
 * price is counted, never shown as free. Read-only.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { isSafeRelativePath, type JobSummary, type ProjectView, type ProviderSpend } from "../../../types/console";
import type { CostEntry } from "../../cli/cost-log";
import { cancelSupport } from "../../jobs/cancel";
import { OperationStore } from "../../jobs/store";
import type { GenerationJob, OperationDatabase } from "../../jobs/types";
import { locate, text, type ProjectPaths } from "./files";

export type Money = ProjectView["money"];

export type MoneyRead = {
  money: Money;
  /** `OperationStore.maxAdmissibleUsd()`: the most a new job could reserve now; null without a store. */
  maxAdmissibleUsd: number | null;
  advisories: string[];
};

const TERMINAL = new Set(["validated", "published", "failed", "cancelled"]);

/** The job store, or undefined when there is none; throws on a corrupt one (the caller turns it into an advisory). */
export function openStore(paths: ProjectPaths): { store: OperationStore; database: OperationDatabase } | undefined {
  const directory = path.join(paths.projectDir, "pipeline");
  if (!existsSync(path.join(directory, "operations.json"))) return undefined;
  const store = new OperationStore(paths.id, { directory });
  return { store, database: store.snapshot() };
}

/** USD actually settled on a job: its receipt less refunds; 0 without a receipt. */
export const jobCostUsd = (job: GenerationJob): number =>
  job.receipt ? Math.max(0, job.receipt.actualUsd - job.refunds.reduce((sum, refund) => sum + refund.refundUsd, 0)) : 0;

const priceKnown = (job: GenerationJob) => job.quote.confidence !== "user-bound";

export function readLedgerRows(paths: ProjectPaths): CostEntry[] {
  const file = path.join(paths.projectDir, "pipeline", "cost-ledger.jsonl");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows: CostEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as CostEntry;
      if (row && typeof row === "object") rows.push(row);
    } catch {
      // a torn line is skipped
    }
  }
  return rows;
}

/** The operation id a ledger row names: its `operationId` field, or `operationId=<id>` in older rows' notes. */
export function ledgerOperationId(row: CostEntry): string | undefined {
  if (typeof row.operationId === "string" && row.operationId) return row.operationId;
  const match = typeof row.notes === "string" ? /(?:^|\s)operationId=(\S+)/.exec(row.notes) : null;
  return match?.[1];
}

/** A ledger row the job store already counts (the store is budget authority; the ledger only feeds cost-report). */
const coveredByStore = (row: CostEntry, storeIds: Set<string>): boolean => {
  const id = ledgerOperationId(row);
  return id !== undefined && storeIds.has(id);
};

const ledgerUsd = (row: CostEntry): number | null =>
  typeof row.actualUsd === "number" ? row.actualUsd : typeof row.estimatedUsd === "number" ? row.estimatedUsd : null;

function summarise(job: GenerationJob, paths: ProjectPaths): JobSummary {
  const at = (states: string[]) => job.history.find((entry) => states.includes(entry.state))?.at;
  const finished = TERMINAL.has(job.state)
    ? [...job.history].reverse().find((e) => e.state === job.state)?.at
    : undefined;
  const output = job.publication?.output ? locate(paths, job.publication.output) : undefined;
  // Whether the user could cancel it now, and why not (D12, A9): the same rule job:cancel applies.
  const support = cancelSupport(job);
  return {
    id: job.operationId.slice(0, 128),
    provider: text(job.provider, 64) ?? "unknown",
    ...(text(job.endpoint, 256) ? { endpoint: text(job.endpoint, 256) } : {}),
    ...(text(job.stage, 64) ? { step: text(job.stage, 64) } : {}),
    state: job.state,
    reservedUsd: job.reservedMicros / 1_000_000,
    ...(job.receipt ? { costUsd: jobCostUsd(job) } : {}),
    priceKnown: priceKnown(job),
    ...(at(["submitting", "queued", "running"]) ? { submittedAt: at(["submitting", "queued", "running"]) } : {}),
    ...(finished ? { finishedAt: finished } : {}),
    ...(output?.root === "project" && isSafeRelativePath(output.path) ? { outputs: [output.path] } : {}),
    cancellable: support.cancellable,
    ...(support.reason ? { cancelReason: support.reason.slice(0, 240) } : {}),
  };
}

/**
 * The project's money. `since` (ms) limits spend to receipts and ledger rows at or after it (the home page's month).
 */
export function readMoney(paths: ProjectPaths, options: { since?: number; ceilingUsd?: number } = {}): MoneyRead {
  const advisories: string[] = [];
  let opened: ReturnType<typeof openStore>;
  try {
    opened = openStore(paths);
  } catch (error) {
    advisories.push(`money: pipeline/operations.json cannot be read (${String((error as Error).message ?? error)}).`);
  }
  const jobs = opened ? Object.values(opened.database.jobs) : [];
  const storeIds = new Set(jobs.map((job) => job.operationId));
  const providers = new Map<string, ProviderSpend>();
  const provider = (name: string) => {
    const key = text(name, 64) ?? "unknown";
    let entry = providers.get(key);
    if (!entry) providers.set(key, (entry = { provider: key, spentUsd: 0, reservedUsd: 0, jobs: 0, unknownPriced: 0 }));
    return entry;
  };
  const inWindow = (iso: string | undefined) =>
    options.since === undefined || (iso !== undefined && Date.parse(iso) >= options.since);
  let spent = 0;
  let reserved = 0;
  let unknown = 0;
  for (const job of jobs) {
    const entry = provider(job.provider);
    const cost = inWindow(job.receipt?.confirmedAt) ? jobCostUsd(job) : 0;
    entry.jobs += 1;
    entry.spentUsd += cost;
    entry.reservedUsd += job.reservedMicros / 1_000_000;
    spent += cost;
    reserved += job.reservedMicros / 1_000_000;
    // Unknown until billed: a receipt settles the price, and the month counts only its own jobs.
    if (!priceKnown(job) && !job.receipt && inWindow(job.history[0]?.at)) {
      unknown += 1;
      entry.unknownPriced += 1;
    }
  }
  for (const row of readLedgerRows(paths)) {
    if (coveredByStore(row, storeIds)) continue;
    if (!inWindow(row.ts)) continue;
    const entry = provider(row.provider ?? row.service ?? "unknown");
    const usd = ledgerUsd(row);
    entry.jobs += 1;
    if (usd === null) {
      unknown += 1;
      entry.unknownPriced += 1;
    } else {
      entry.spentUsd += usd;
      spent += usd;
    }
  }
  let maxAdmissibleUsd: number | null = null;
  let ceilingUsd: number | undefined = options.ceilingUsd;
  if (opened) {
    try {
      ceilingUsd = opened.database.policy.ceilingUsd;
      maxAdmissibleUsd = opened.store.maxAdmissibleUsd();
    } catch {
      maxAdmissibleUsd = null;
    }
  }
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  return {
    money: {
      ...(ceilingUsd !== undefined ? { ceilingUsd } : {}),
      reservedUsd: round(reserved),
      spentUsd: round(spent),
      unknownPriced: unknown,
      byProvider: [...providers.values()]
        .map((entry) => ({ ...entry, spentUsd: round(entry.spentUsd), reservedUsd: round(entry.reservedUsd) }))
        .sort(
          (a, b) => b.spentUsd + b.reservedUsd - (a.spentUsd + a.reservedUsd) || a.provider.localeCompare(b.provider),
        )
        .slice(0, 64),
      jobs: jobs
        .map((job) => summarise(job, paths))
        .sort((a, b) => (b.submittedAt ?? "").localeCompare(a.submittedAt ?? "") || a.id.localeCompare(b.id))
        .slice(0, 1000),
    },
    maxAdmissibleUsd,
    advisories,
  };
}

export const emptyMoney = (): Money => ({ reservedUsd: 0, spentUsd: 0, unknownPriced: 0, byProvider: [], jobs: [] });
