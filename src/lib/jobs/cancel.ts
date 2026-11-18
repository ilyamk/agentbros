/**
 * The user's per-job cancel after a stop (RFC 0004 D12): which paid jobs are still in flight, whether each one can be
 * cancelled, and the cancel itself through the job store. Only a real cancellation counts:
 *
 * - a job not yet submitted (`planned`, `reserved`) is cancelled locally and its reservation released (no request
 *   exists, so nothing was charged);
 * - a submitted Higgsfield job is cancelled through the provider's cancel call, then its status is read: only a
 *   provider `canceled` status moves the job to `cancelled` and releases the reservation as a confirmed no-charge;
 *   an accepted call that the status does not yet show is recorded as `requested` (the next resume settles it);
 * - every other provider (fal: its adapter has no cancel call; stream, realtime and synchronous jobs) and every job
 *   past the provider's work is `unavailable`, recorded on the job, never faked.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { JobSummary } from "../../types/console";
import { HiggsfieldRequestStatusSchema } from "../../types/higgsfield";
import type { HiggsfieldClient } from "../providers/higgsfield/client";
import { OperationStore } from "./store";
import type { GenerationJob } from "./types";
import { claimOperationWork } from "./work-lease";

/** States a stop lists: the job holds a reservation and the provider has not finished it (or not yet received it). */
export const IN_FLIGHT_STATES: readonly GenerationJob["state"][] = [
  "planned",
  "reserved",
  "submitting",
  "queued",
  "running",
  "unknown",
];

export type CancelSupport = { cancellable: boolean; local?: boolean; reason?: string };

/** Whether the job can be cancelled now, and why not. */
export function cancelSupport(job: GenerationJob): CancelSupport {
  if (job.state === "planned" || job.state === "reserved")
    return job.paidAttempts === 0
      ? { cancellable: true, local: true }
      : { cancellable: false, reason: "an earlier submit may have charged; reconcile it with budget first" };
  if (job.state === "submitting" || (job.state === "unknown" && !job.providerRequestId))
    return { cancellable: false, reason: "the submit's outcome is unknown; reconcile it before cancelling" };
  if (!["queued", "running", "unknown"].includes(job.state))
    return { cancellable: false, reason: `the job is ${job.state}: the provider's work is done or the job is closed` };
  if (job.provider === "higgsfield") return { cancellable: true };
  if (job.provider === "fal")
    return { cancellable: false, reason: "the fal job adapter has no cancel call; the job runs to completion" };
  return { cancellable: false, reason: `provider ${job.provider} offers no cancellation for this job` };
}

const MICRO = 1_000_000;

/** One job as the console lists it (JobSummarySchema). */
export function jobSummary(job: GenerationJob): JobSummary {
  const submitted = job.history.find((entry) => entry.state === "submitting")?.at;
  const finished = ["published", "failed", "cancelled"].includes(job.state) ? job.updatedAt : undefined;
  const support = cancelSupport(job);
  return {
    id: job.operationId,
    provider: job.provider,
    endpoint: job.endpoint.slice(0, 256),
    ...(job.stage ? { step: job.stage.slice(0, 64) } : {}),
    state: job.state,
    reservedUsd: job.reservedMicros / MICRO,
    ...(job.receipt ? { costUsd: job.receipt.actualUsd } : {}),
    priceKnown: job.quote.confidence !== "user-bound",
    ...(submitted ? { submittedAt: submitted } : {}),
    ...(finished ? { finishedAt: finished } : {}),
    // From the job's current state only: a recorded outcome is history, not a verdict on what is possible now.
    cancellable: support.cancellable,
    ...(support.reason ? { cancelReason: support.reason.slice(0, 240) } : {}),
  };
}

/** The project's in-flight paid jobs (none without an operation store); `omitted`: ids too long for a JobSummary. */
export function inFlightJobs(projectDir: string): { jobs: JobSummary[]; omitted: string[] } {
  const directory = path.join(projectDir, "pipeline");
  if (!existsSync(path.join(directory, "operations.json"))) return { jobs: [], omitted: [] };
  const store = new OperationStore(path.basename(projectDir), { directory });
  const inFlight = Object.values(store.snapshot().jobs).filter((job) => IN_FLIGHT_STATES.includes(job.state));
  // JobSummarySchema caps an id at 128 characters: longer ones are named, never silently dropped.
  return {
    jobs: inFlight.filter((job) => job.operationId.length <= 128).map(jobSummary),
    omitted: inFlight.filter((job) => job.operationId.length > 128).map((job) => job.operationId),
  };
}

export type CancelOutcome = "cancelled" | "requested" | "unavailable" | "refused" | "busy";

export type CancelResult = { outcome: CancelOutcome; message: string; job: GenerationJob };

export type HiggsfieldCancelClient = Pick<HiggsfieldClient, "cancel" | "status">;

/**
 * Cancels one job on the user's words. `higgsfield` builds the provider client only when a Higgsfield job needs it
 * (tests inject a fake). Holds the operation's work lease, so a live worker on the same job means `busy`.
 */
export async function cancelJob(options: {
  store: OperationStore;
  operationId: string;
  /** The user's words, verbatim. */
  answer: string;
  higgsfield?: () => HiggsfieldCancelClient;
  now?: () => Date;
}): Promise<CancelResult> {
  const { store, operationId, answer } = options;
  const now = options.now ?? (() => new Date());
  const jobs = store.snapshot().jobs;
  const found = Object.hasOwn(jobs, operationId) ? jobs[operationId] : undefined;
  if (!found) throw new UnknownJobError(operationId);
  const release = claimOperationWork(store, operationId);
  if (!release)
    return {
      outcome: "busy",
      message: "Another process is working on this job right now; try the cancel again in a moment.",
      job: found,
    };
  const record = (outcome: Exclude<CancelOutcome, "busy">, note: string) =>
    store.recordCancellation(operationId, { at: now().toISOString(), answer, outcome, note: note.slice(0, 2000) });
  try {
    let job = store.snapshot().jobs[operationId]!;
    const support = cancelSupport(job);
    if (!support.cancellable) {
      const message = `Job ${operationId} cannot be cancelled: ${support.reason}.`;
      return { outcome: "unavailable", message, job: record("unavailable", support.reason!) };
    }
    if (support.local) {
      const note = "cancelled before submit at the user's request";
      // Release first: a crash before the state change leaves a released reserved job, which can never submit
      // (admitSubmission refuses a released reservation); the reverse order could keep the money reserved forever.
      if (job.reservedMicros > 0)
        store.releaseReservation(operationId, {
          confirmationId: `local:${operationId}:not-submitted`,
          reason: "not-submitted",
          source: note,
        });
      job = store.transitionJob(operationId, "cancelled", { note, expectedState: job.state });
      return {
        outcome: "cancelled",
        message: `Job ${operationId} was not submitted; cancelled and its reservation released.`,
        job: record("cancelled", note),
      };
    }
    // Higgsfield, submitted: the provider decides.
    const client = options.higgsfield?.();
    if (!client) throw new Error("A Higgsfield client is required to cancel a Higgsfield job.");
    const requestId = job.providerRequestId!;
    try {
      await client.cancel(job.providerUrls?.cancel ?? requestId);
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        outcome: "refused",
        message: `Higgsfield refused to cancel job ${operationId} (${why}); it keeps running and its result will be kept.`,
        job: record("refused", `provider refused: ${why}`),
      };
    }
    // The provider accepted the cancel: record it now, so a failed status read below still leaves its trace.
    record("requested", "provider accepted the cancel; status not read yet");
    let status;
    try {
      status = HiggsfieldRequestStatusSchema.parse(await client.status(job.providerUrls?.status ?? requestId));
      if (status.request_id !== requestId) throw new Error("Higgsfield status belongs to a different request.");
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      return {
        outcome: "requested",
        message: `Higgsfield accepted the cancel of job ${operationId}; its status could not be read (${why}). The next resume settles it.`,
        job: record("requested", `provider accepted the cancel; status read failed: ${why}`),
      };
    }
    if (status.status === "canceled") {
      // Release first (the runner's own no-charge confirmation, so a resume after a crash repeats it idempotently),
      // then close the job; a failed release leaves the job open for the next resume to settle.
      try {
        store.confirmNoCharge(operationId, "higgsfield status: canceled");
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        return {
          outcome: "requested",
          message: `Higgsfield cancelled job ${operationId}, but its reservation could not be released yet (${why}); the next resume settles it.`,
          job: record("requested", `provider status: canceled; release failed: ${why}`),
        };
      }
      job = store.transitionJob(operationId, "cancelled", { note: "cancelled at the provider at the user's request" });
      return {
        outcome: "cancelled",
        message: `Job ${operationId} was cancelled by Higgsfield; no charge, reservation released.`,
        job: record("cancelled", "provider status: canceled"),
      };
    }
    if (status.status === "queued" || status.status === "in_progress")
      return {
        outcome: "requested",
        message: `Higgsfield accepted the cancel of job ${operationId} but still reports ${status.status}; the next resume settles it.`,
        job: record("requested", `provider status after cancel: ${status.status}`),
      };
    if (status.status !== "completed")
      return {
        outcome: "refused",
        message: `Job ${operationId} had already ended at Higgsfield (${status.status}); nothing was cancelled, and the next resume settles it.`,
        job: record("refused", `provider status after cancel: ${status.status}`),
      };
    return {
      outcome: "refused",
      message: `Job ${operationId} had already completed at Higgsfield; nothing was cancelled and its result is kept.`,
      job: record("refused", `provider status after cancel: ${status.status}`),
    };
  } finally {
    release();
  }
}

export class UnknownJobError extends Error {
  constructor(readonly operationId: string) {
    super(`No paid job ${operationId} in this project's operation store.`);
    this.name = "UnknownJobError";
  }
}
