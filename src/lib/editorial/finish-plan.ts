import { z } from "zod";
import { OperationDatabaseSchema, PriceQuoteSchema, type OperationDatabase } from "../jobs/types";
const TaskSchema = z
  .object({
    id: z.string().min(1),
    assetId: z.string().min(1),
    repair: z.boolean().default(false),
    reason: z.string().min(1),
    quote: PriceQuoteSchema.nullable(),
  })
  .strict();
export const FinishTasksSchema = z.array(TaskSchema).max(1000);
/** Read-only forecast: no reserve, submit, invoice inference or automatic reshoot. */
export function forecastToFinish(database: OperationDatabase, tasksInput: z.input<typeof FinishTasksSchema>) {
  const snapshot = OperationDatabaseSchema.parse(database),
    tasks = FinishTasksSchema.parse(tasksInput),
    jobs = Object.values(snapshot.jobs),
    seen = new Set<string>();
  if (
    tasks.some((task) => {
      if (seen.has(task.id)) return true;
      seen.add(task.id);
      return false;
    })
  )
    throw new Error("Duplicate finish task ID");
  const micros = (usd: number) => Math.ceil(usd * 1000000 - 1e-7),
    floor = (usd: number) => Math.floor(usd * 1000000 + 1e-7);
  let production = 0,
    repair = 0,
    expected = 0,
    high = 0,
    plannedProduction = 0;
  for (const job of jobs) {
    const actual = job.receipt
        ? micros(job.receipt.actualUsd) - job.refunds.reduce((sum, value) => sum + floor(value.refundUsd), 0)
        : 0,
      liability = job.reservedMicros + actual;
    if (job.repair) repair += liability;
    else production += liability;
  }
  const cap = floor(snapshot.policy.ceilingUsd),
    productionCap = Math.floor(cap * (1 - snapshot.policy.repairReserveFraction));
  const pending = jobs
    .filter((job) => !["published", "cancelled"].includes(job.state))
    .map((job) => ({
      operationId: job.operationId,
      state: job.state,
      assetId: job.assetId,
    }));
  const candidates = tasks.map((task) => {
    const reasons: string[] = [],
      bound = task.quote ? micros(task.quote.highUsd) : 0;
    if (!task.quote) reasons.push("Unknown quote: supply a verified quote or explicit bound");
    if (
      jobs.some(
        (job) =>
          job.assetId === task.assetId &&
          (!["published", "cancelled", "failed"].includes(job.state) ||
            (job.state === "failed" && job.reservedMicros > 0)),
      )
    )
      reasons.push("Existing operation must be resumed/reconciled first");
    if (
      jobs.filter((job) => job.assetId === task.assetId).reduce((sum, job) => sum + job.paidAttempts, 0) >=
      snapshot.policy.maxPaidAttemptsPerAsset
    )
      reasons.push("Paid attempt limit reached");
    if (task.quote && task.quote.highUsd > snapshot.policy.maxJobUsd) reasons.push("Per-job bound exceeded");
    if (production + repair + high + bound > cap) reasons.push("Project bound exceeded");

    if (!task.repair && production + plannedProduction + bound > productionCap)
      reasons.push("Production would consume protected repair reserve");
    if (task.quote) {
      high += bound;
      expected += micros(task.quote.expectedUsd);
      if (!task.repair) plannedProduction += bound;
    }
    return {
      ...task,
      eligible: reasons.length === 0,
      reasons,
      automatic: false as const,
    };
  });
  return {
    version: 1,
    projectId: snapshot.projectId,
    revision: snapshot.revision,
    estimatedRemainingExpectedUsd: tasks.some((task) => !task.quote) ? null : expected / 1000000,
    estimatedRemainingHighUsd: tasks.some((task) => !task.quote) ? null : high / 1000000,
    knownLiabilityUsd: (production + repair) / 1000000,
    availableUsd: Math.max(0, cap - production - repair) / 1000000,
    protectedRepairReserveUsd: (cap - productionCap) / 1000000,
    pending,
    candidates,
    readyToPlan: candidates.every((candidate) => candidate.eligible),
    billingActualsKnown: jobs.every((job) => job.paidAttempts === 0 || !!job.receipt || !!job.release),
    forecastOnly: true,
  };
}
