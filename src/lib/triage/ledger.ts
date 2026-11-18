import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../cli";
import { SpendRecordSchema, type SpendRecord, type TriageConfig, type Usage, type JudgeSlot } from "../../types/triage";

export function ledgerPath(root = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(root, env.TRIAGE_LEDGER ?? ".cache/triage/ledger.jsonl");
}

export function readLedger(file: string): SpendRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => SpendRecordSchema.parse(JSON.parse(line)));
}

export function charged(
  records: SpendRecord[],
): { reservation: Extract<SpendRecord, { event: "reserve" }>; costUsd: number }[] {
  const reservations = new Map<string, Extract<SpendRecord, { event: "reserve" }>>();
  const settled = new Map<string, number>();
  for (const record of records) {
    if (record.event === "reserve") {
      if (reservations.has(record.id))
        throw new CliErrorObject({ code: "VALIDATION", message: "Duplicate triage ledger reservation." });
      reservations.set(record.id, record);
    } else {
      if (!reservations.has(record.id) || settled.has(record.id))
        throw new CliErrorObject({ code: "VALIDATION", message: "Invalid triage ledger settlement." });
      settled.set(record.id, record.costUsd);
    }
  }
  return [...reservations.values()].map((reservation) => ({
    reservation,
    costUsd: settled.get(reservation.id) ?? reservation.costUsd,
  }));
}

export function monthTotal(records: SpendRecord[], date = new Date()): number {
  return charged(records)
    .filter(({ reservation }) => reservation.at.slice(0, 7) === date.toISOString().slice(0, 7))
    .reduce((sum, record) => sum + record.costUsd, 0);
}

export function checkCaps(
  config: TriageConfig,
  records: SpendRecord[],
  runId: string,
  nextCostUsd: number,
  date = new Date(),
  prIdentity?: string,
): void {
  if (config.monthlyCapUsd === null)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Triage monthlyCapUsd is undecided (null); the maintainer must set it before triage can run.",
    });
  const runTotal = charged(records)
    .filter(({ reservation }) =>
      prIdentity
        ? reservation.prIdentity === prIdentity || (!reservation.prIdentity && reservation.scope !== "audit")
        : reservation.runId === runId,
    )
    .reduce((sum, record) => sum + record.costUsd, 0);
  if (
    !Number.isFinite(nextCostUsd) ||
    nextCostUsd < 0 ||
    runTotal + nextCostUsd > config.perPrCapUsd ||
    monthTotal(records, date) + nextCostUsd > config.monthlyCapUsd
  ) {
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Triage spend cap would be exceeded; skip paid judging and apply triage:needs-human.",
      details: {
        labels: ["triage:needs-human"],
        runTotalUsd: runTotal,
        monthTotalUsd: monthTotal(records, date),
        nextCostUsd,
      },
    });
  }
}

function locked<T>(file: string, fn: () => T): T {
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  try {
    mkdirSync(lock);
  } catch {
    throw new CliErrorObject({
      code: "VALIDATION",
      message:
        "Triage ledger is locked; another call or an interrupted writer needs attention. Do not resubmit an ambiguous paid call.",
    });
  }
  try {
    return fn();
  } finally {
    rmdirSync(lock);
  }
}

export function reserveSpend(
  file: string,
  config: TriageConfig,
  runId: string,
  slot: JudgeSlot,
  costUsd: number,
  date = new Date(),
  prIdentity?: string,
  scope: "pr" | "audit" = "pr",
): string {
  return locked(file, () => {
    checkCaps(config, readLedger(file), runId, costUsd, date, prIdentity);
    const record: SpendRecord = {
      event: "reserve",
      id: randomUUID(),
      runId,
      scope,
      ...(prIdentity ? { prIdentity } : {}),
      label: slot.label,
      provider: slot.provider,
      model: slot.model,
      at: date.toISOString(),
      costUsd,
    };
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    return record.id;
  });
}

export function settleSpend(file: string, id: string, costUsd: number, usage: Usage): void {
  locked(file, () => {
    const records = readLedger(file);
    if (
      !records.some((record) => record.event === "reserve" && record.id === id) ||
      records.some((record) => record.event === "settle" && record.id === id)
    )
      throw new CliErrorObject({ code: "VALIDATION", message: "Cannot settle this triage reservation." });
    const record = SpendRecordSchema.parse({ event: "settle", id, at: new Date().toISOString(), costUsd, usage });
    appendFileSync(file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  });
}
