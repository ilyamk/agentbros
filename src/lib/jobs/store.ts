import path from "node:path";
import { assertCurrentPricingEvidence } from "../models/pricing-evidence";
import { PRICING } from "../pricing";
import { FAL_PLATFORM_PRICING_API } from "../../types/pricing-evidence";
import { CampaignBindingSchema } from "../../types/campaigns";
import { assertProductionAllocation, assertProductionSpend } from "../campaigns/production/guard";
import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  fsyncSync,
  existsSync,
  renameSync,
  unlinkSync,
  mkdirSync,
  lstatSync,
} from "node:fs";
import { pipelineDir } from "../pipeline/paths";
import { recordJobState } from "../console/journal";
import { pausedControl, submitPauseMessage } from "../console/control";
import { CliErrorObject } from "../cli";
import {
  MediaAcquisitionResultEvidenceSchema,
  BudgetPolicySchema,
  OperationDatabaseSchema,
  OperationInputSchema,
  BillingReceiptSchema,
  RealtimeLocalResultEvidenceSchema,
  StreamLocalResultEvidenceSchema,
  CeilingGrantSchema,
  type CeilingGrant,
  type BudgetPolicy,
  type OperationDatabase,
  type OperationInput,
  type GenerationJob,
  type JobStatus,
  type BillingReceipt,
  type ProviderUrls,
  type ProviderUpload,
  type PriceQuote,
} from "./types";
import { FAL_HTTP_STREAM_ENDPOINTS } from "../providers/transport-capabilities";
import { PolicyRefusal, policyPath, readPolicyFile } from "../autonomy/policy";
import type { PolicyRevision } from "../../types/policy";

export class BudgetError extends Error {
  constructor(
    public code:
      | "BUDGET_EXCEEDED"
      | "UNKNOWN_PRICE"
      | "CONFLICT"
      | "INVALID_TRANSITION"
      | "ATTEMPT_LIMIT"
      | "UNINITIALIZED"
      | "AUTHORITY_REQUIRED",
    message: string,
    /** Amounts behind a BUDGET_EXCEEDED refusal (USD); runScript passes them on as the error's details. */
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "BudgetError";
  }
}
const MICRO = 1_000_000;
/** Ceil liabilities and floor limits so rounding cannot create budget headroom. */
const liability = (usd: number) => Math.ceil(usd * MICRO - 1e-7);
const limit = (usd: number) => Math.floor(usd * MICRO + 1e-7);
const NEXT: Record<JobStatus, JobStatus[]> = {
  planned: ["reserved", "cancelled"],
  reserved: ["submitting", "cancelled"],
  submitting: ["queued", "running", "result-ready", "failed", "cancelled", "unknown"],
  queued: ["running", "result-ready", "failed", "cancelled", "unknown"],
  running: ["result-ready", "failed", "cancelled", "unknown"],
  "result-ready": ["downloading", "failed"],
  downloading: ["validated", "failed"],
  validated: ["published", "failed"],
  published: [],
  failed: ["downloading", "result-ready"],
  cancelled: [],
  unknown: ["queued", "running", "result-ready", "failed", "cancelled"],
};

function accounting(database: OperationDatabase) {
  let reserved = 0,
    settled = 0,
    production = 0,
    repair = 0;
  for (const job of Object.values(database.jobs)) {
    const actual = job.receipt
      ? liability(job.receipt.actualUsd) - job.refunds.reduce((sum, refund) => sum + limit(refund.refundUsd), 0)
      : 0;
    reserved += job.reservedMicros;
    settled += actual;
    if (job.repair) repair += job.reservedMicros + actual;
    else production += job.reservedMicros + actual;
  }
  return { reserved, settled, production, repair };
}
/** A micro-dollar amount for a message: cents when exact, otherwise up to six decimals, so tiny amounts never read $0.00. */
function usd(micros: number): string {
  const value = micros / MICRO;
  return micros % 10_000 === 0 ? `$${value.toFixed(2)}` : `$${value.toFixed(6).replace(/0+$/, "")}`;
}
/**
 * Every admission limit at once: the per-job limits, the ceilings and the production or repair allocation.
 * `amount` is the job's whole liability (per-job limits), `added` what admission adds to the totals.
 * Returns the most a new job could add now and, when this one does not fit, the first refusal with its numbers.
 */
function admission(
  database: OperationDatabase,
  policyBudget: { ceilingUsd: number; maxJobUsd: number } | undefined,
  amount: number,
  added: number,
  repair: boolean,
): { maxMicros: number; refusal?: BudgetError } {
  const totals = accounting(database);
  const cap = limit(database.policy.ceilingUsd);
  const committed = totals.settled + totals.reserved;
  const fraction = database.policy.repairReserveFraction;
  const repairAllocation = Math.floor(cap * fraction);
  const allocation = repair ? repairAllocation : cap - repairAllocation;
  const used = repair ? totals.repair : totals.production;
  const perJob = limit(database.policy.maxJobUsd);
  const rooms = [perJob, cap - committed, allocation - used];
  if (policyBudget) rooms.push(limit(policyBudget.maxJobUsd), limit(policyBudget.ceilingUsd) - committed);
  const maxMicros = Math.max(0, Math.min(...rooms));
  const refuse = (message: string) => ({
    maxMicros,
    refusal: new BudgetError("BUDGET_EXCEEDED", `${message} At most ${usd(maxMicros)} can be admitted now.`, {
      requestedUsd: added / MICRO,
      ceilingUsd: cap / MICRO,
      committedUsd: committed / MICRO,
      allocation: repair ? "repair" : "production",
      allocationUsd: allocation / MICRO,
      allocationUsedUsd: used / MICRO,
      repairReserveFraction: fraction,
      maxAdmissibleUsd: maxMicros / MICRO,
    }),
  });
  const percent = `${Number((fraction * 100).toFixed(4))}%`;
  const already = (micros: number) => (micros > 0 ? `, ${usd(micros)} already committed` : "");
  if (amount > perJob) return refuse(`Per-job limit exceeded: the limit is ${usd(perJob)}; requested ${usd(amount)}.`);
  if (committed + added > cap)
    return refuse(
      `Project ceiling exceeded: the ceiling is ${usd(cap)}${already(committed)}; requested ${usd(added)}.`,
    );
  if (policyBudget && amount > limit(policyBudget.maxJobUsd))
    return refuse(
      `The project policy's per-job limit is exceeded: the limit is ${usd(limit(policyBudget.maxJobUsd))}; requested ${usd(amount)}.`,
    );
  if (policyBudget && committed + added > limit(policyBudget.ceilingUsd))
    return refuse(
      `The project policy's ceiling is exceeded: the ceiling is ${usd(limit(policyBudget.ceilingUsd))}${already(committed)}; requested ${usd(added)}.`,
    );
  if (used + added > allocation)
    return refuse(
      repair
        ? `Repair allocation is ${usd(allocation)} (${percent} repair reserve of ceiling ${usd(cap)})${already(used)}; requested ${usd(added)}.`
        : `Production allocation is ${usd(allocation)} (ceiling ${usd(cap)} minus ${percent} repair reserve)${already(used)}; requested ${usd(added)}.`,
    );
  return { maxMicros };
}
/** A paid attempt was made, and neither a receipt nor a release has settled it. */
const awaitsReceipt = (job: GenerationJob) => job.paidAttempts > 0 && !job.receipt && !job.release;
/** The most a new job could reserve in a database under its policy (and an autonomy policy budget), in USD. */
export function maxAdmissibleUsdFor(
  database: OperationDatabase,
  policyBudget?: { ceilingUsd: number; maxJobUsd: number },
  repair = false,
): number {
  return admission(database, policyBudget, 0, 0, repair).maxMicros / MICRO;
}
/** Reserved plus settled USD of a database, the liability the ceiling binds; read without opening a store. */
export function committedSpendUsd(database: OperationDatabase): number {
  const totals = accounting(database);
  return (totals.reserved + totals.settled) / MICRO;
}
function identity(job: GenerationJob | ReturnType<typeof OperationInputSchema.parse>) {
  return JSON.stringify([
    job.provider,
    job.endpoint,
    job.inputHash,
    job.assetId,
    job.stage,
    job.repair,
    job.quote,
    job.publication ?? null,
    job.preparedInputHash ?? null,
    job.canonicalInput ?? null,
    job.quotedRequestBody ?? null,
  ]);
}
export function reservationUsd(quote: Pick<PriceQuote, "highUsd" | "pricingEvidence">): number {
  const evidence = quote.pricingEvidence;
  // A dated sale may expire while preparation or recovery is pending. Always reserve the full rate.
  return Math.max(
    quote.highUsd,
    evidence?.provider === "higgsfield" && evidence.record.list?.discountExpiresAt ? evidence.undiscountedUsd : 0,
  );
}

/** How a new ceiling relates to the current one, compared in micros so rounding cannot hide a raise. */
export function ceilingChange(previousUsd: number | null, nextUsd: number): "first" | "raise" | "same" | "lower" {
  if (previousUsd === null) return "first";
  const before = limit(previousUsd),
    after = limit(nextUsd);
  return after > before ? "raise" : after === before ? "same" : "lower";
}
/** Whether this change needs the user's words (or another recorded authority): any raise, or a first ceiling above zero. */
export function ceilingNeedsGrant(previousUsd: number | null, nextUsd: number): boolean {
  const change = ceilingChange(previousUsd, nextUsd);
  return change === "raise" || (change === "first" && limit(nextUsd) > 0);
}
export function ceilingAuthorityMessage(
  projectId: string,
  previousUsd: number | null,
  nextUsd: number | string,
): string {
  const what =
    previousUsd === null
      ? `Setting the first spend ceiling to USD ${nextUsd}`
      : `Raising the spend ceiling from USD ${previousUsd} to USD ${nextUsd}`;
  return `${what} needs the user's own words. Ask the user how much they authorise for project ${projectId}, then run pnpm budget --project ${projectId} --ceiling-usd ${nextUsd} --answer "<the user's words>". Lowering the ceiling needs no answer.`;
}

/** Local transaction adapter: policy, jobs and reservations always commit together. */
export class OperationStore {
  readonly file: string;
  readonly responseCacheDirectory: string;
  constructor(
    readonly projectId: string,
    options: { directory?: string; responseCacheDirectory?: string } = {},
  ) {
    // Validate ID even when tests/application choose an explicit storage directory.
    const directory = options.directory ?? pipelineDir(projectId);
    if (options.directory) pipelineDir(projectId);
    this.file = path.resolve(directory, "operations.json");
    this.responseCacheDirectory = options.responseCacheDirectory
      ? path.resolve(options.responseCacheDirectory)
      : options.directory
        ? path.resolve(directory, "private-responses")
        : path.resolve(".cache", "paid-responses", projectId);
  }
  private assertCampaignQuota(
    ceilingUsd: number,
    expected?: OperationDatabase["campaignAllocation"],
  ): OperationDatabase["campaignAllocation"] {
    const bindingFile = path.join(path.dirname(this.file), "campaign-binding.json");
    if (!existsSync(bindingFile)) {
      if (expected) throw new BudgetError("CONFLICT", "Assigned campaign binding is missing.");
      return;
    }
    if (lstatSync(bindingFile).isSymbolicLink())
      throw new BudgetError("CONFLICT", "Campaign binding cannot be a symlink.");
    const binding = CampaignBindingSchema.parse(JSON.parse(readFileSync(bindingFile, "utf8")));
    if (binding.version === 2) assertProductionAllocation(path.dirname(path.dirname(this.file)));
    if (binding.projectId !== this.projectId) throw new BudgetError("CONFLICT", "Campaign binding project differs.");
    if (expected && JSON.stringify(binding) !== JSON.stringify(expected))
      throw new BudgetError("CONFLICT", "Assigned campaign binding has changed.");
    if (liability(ceilingUsd) > limit(binding.quotaUsd))
      throw new BudgetError("BUDGET_EXCEEDED", "Project policy exceeds its assigned campaign quota.");
    return binding;
  }
  private read(): OperationDatabase | null {
    if (!existsSync(this.file)) return null;
    if (lstatSync(this.file).isSymbolicLink())
      throw new BudgetError("CONFLICT", "Operation store cannot be a symlink.");
    const database = OperationDatabaseSchema.parse(JSON.parse(readFileSync(this.file, "utf8")));
    if (database.projectId !== this.projectId)
      throw new BudgetError("CONFLICT", "Operation store project does not match.");
    this.assertCampaignQuota(database.policy.ceilingUsd, database.campaignAllocation);
    return database;
  }
  private lock(): () => void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const lock = `${this.file}.lock`;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lock, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID() }));
          fsyncSync(fd);
        } catch (error) {
          closeSync(fd);
          unlinkSync(lock);
          throw error;
        }
        return () => {
          closeSync(fd);
          unlinkSync(lock);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // Recovery has its own exclusive guard so two recovery processes cannot
        // both inspect the old lock and accidentally unlink a new live lock.
        const recoveryPath = `${lock}.recovery`;
        let recoveryFd: number;
        try {
          recoveryFd = openSync(recoveryPath, "wx", 0o600);
        } catch {
          throw new BudgetError(
            "CONFLICT",
            "Operation lock recovery is busy; retry or inspect an interrupted recovery guard.",
          );
        }
        let recovered = false;
        try {
          let owner: { pid: number };
          try {
            owner = JSON.parse(readFileSync(lock, "utf8"));
          } catch (readError) {
            if ((readError as NodeJS.ErrnoException).code === "ENOENT") {
              recovered = true;
            } else
              throw new BudgetError("CONFLICT", "Writer lock has no recoverable owner; inspect it before removal.");
          }
          if (!recovered) {
            if (!Number.isSafeInteger(owner!.pid) || owner!.pid <= 0)
              throw new BudgetError("CONFLICT", "Invalid writer lock owner.");
            try {
              process.kill(owner!.pid, 0);
            } catch (probe) {
              if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
                unlinkSync(lock);
                recovered = true;
              }
            }
          }
        } finally {
          closeSync(recoveryFd);
          unlinkSync(recoveryPath);
        }
        if (recovered) continue;
        throw new BudgetError("CONFLICT", "Operation store is busy; re-read and retry.");
      }
    }
    throw new BudgetError("CONFLICT", "Operation store lock changed during recovery.");
  }
  /**
   * `journal` (job-returning transactions only): whether this commit changed a job's state (or settled its billing),
   * so the console journal gets a `job.state` line after the commit (RFC 0004 §7). The journal never throws.
   */
  private transaction<T>(
    mutate: (database: OperationDatabase | null) => { database: OperationDatabase; result: T },
    journal?: boolean | ((result: T) => boolean),
  ): T {
    const result = this.commit(mutate);
    if (journal === true || (typeof journal === "function" && journal(result)))
      recordJobState(path.dirname(this.file), this.projectId, result as GenerationJob);
    return result;
  }
  private commit<T>(mutate: (database: OperationDatabase | null) => { database: OperationDatabase; result: T }): T {
    const unlock = this.lock();
    try {
      const current = this.read();
      const { database, result } = mutate(current);
      database.revision = (current?.revision ?? 0) + 1;
      const validated = OperationDatabaseSchema.parse(database);
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(validated, null, 2));
        fsyncSync(fd);
      } catch (error) {
        unlinkSync(temporary);
        throw error;
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(temporary, this.file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      const dirFd = openSync(path.dirname(this.file), "r");
      try {
        fsyncSync(dirFd);
      } finally {
        closeSync(dirFd);
      }
      return structuredClone(result);
    } finally {
      unlock();
    }
  }
  /**
   * The autonomy policy beside operations.json (pipeline/policy.json), when one exists. Its budget binds this store:
   * no ceiling or per-job limit above the policy's, no provider outside its list, and under autonomy no user-bound
   * quote unless the policy allows it. An unreadable policy fails closed.
   */
  private policy(): PolicyRevision | undefined {
    try {
      return readPolicyFile(policyPath(path.dirname(this.file)))?.revisions.at(-1);
    } catch (error) {
      if (error instanceof PolicyRefusal) throw new BudgetError("CONFLICT", error.message);
      throw error;
    }
  }
  private assertPolicyCeiling(ceilingUsd: number, maxJobUsd: number): void {
    const budget = this.policy()?.budget;
    if (!budget) return;
    const raise = `Raise the policy first, in the user's own words: pnpm film:policy --project ${this.projectId} --ceiling-usd <n> --answer "<the user's words>".`;
    if (limit(ceilingUsd) > limit(budget.ceilingUsd))
      throw new BudgetError(
        "AUTHORITY_REQUIRED",
        `The ceiling USD ${ceilingUsd} is above the project policy's cap of USD ${budget.ceilingUsd}. ${raise}`,
      );
    if (limit(maxJobUsd) > limit(budget.maxJobUsd))
      throw new BudgetError(
        "AUTHORITY_REQUIRED",
        `The per-job limit USD ${maxJobUsd} is above the project policy's USD ${budget.maxJobUsd}. ${raise}`,
      );
  }
  private assertPolicyOperation(
    operation: { provider: string; quote: { confidence: string } },
    policy = this.policy(),
  ): void {
    const budget = policy?.budget;
    if (!budget) return;
    if (!budget.allowedProviders.includes(operation.provider))
      throw new BudgetError(
        "AUTHORITY_REQUIRED",
        `Provider ${operation.provider} is not in the project policy's allowed providers (${budget.allowedProviders.join(", ") || "none"}). Adding one needs the user's words: pnpm film:policy --project ${this.projectId} --providers <list> --answer "<the user's words>".`,
      );
    if (policy.autonomy === "autonomous" && operation.quote.confidence === "user-bound" && !budget.allowUserBoundQuotes)
      throw new BudgetError(
        "AUTHORITY_REQUIRED",
        "The project policy runs autonomously and refuses a hand-bound (user-bound) quote: ask the user.",
      );
  }
  private admitPendingSubmission(database: OperationDatabase, job: GenerationJob): void {
    const policy = this.policy();
    this.assertPolicyOperation(job, policy);
    const amount = liability(reservationUsd(job.quote));
    const increase = Math.max(0, amount - job.reservedMicros);
    const { refusal } = admission(database, policy?.budget, amount, increase, job.repair);
    if (refusal) throw refusal;
    job.reservedMicros += increase;
  }
  /**
   * The pause at the submit point (RFC 0004 D12): while the user has the project paused or stopped, no new job is
   * reserved and no reserved job is submitted, even by a batch or workflow started before the pause. Jobs already
   * submitted still poll, download and publish. Reads `pipeline/session/control.json` beside this store; a missing or
   * unreadable file is running (fail open, as everywhere else).
   */
  private assertNotPaused(): void {
    const control = pausedControl(path.dirname(path.dirname(this.file)));
    if (control)
      throw new CliErrorObject({
        code: "PAUSED",
        message: submitPauseMessage(this.projectId, control),
        details: { project: this.projectId, state: control.state, at: control.at, retry: false },
      });
  }
  snapshot(): OperationDatabase {
    const database = this.read();
    if (!database) throw new BudgetError("UNINITIALIZED", "Configure a budget before reserving paid work.");
    return database;
  }
  /**
   * Install or change the durable policy. Lowering, keeping, or first setting a zero ceiling is free;
   * raising it, or first setting it above zero, needs a grant: the user's own words, or a recorded
   * upstream authority. Every call is appended to policyEvents.
   */
  configure(policyInput: BudgetPolicy, grantInput?: CeilingGrant): OperationDatabase {
    const policy = BudgetPolicySchema.parse(policyInput);
    const grant = grantInput === undefined ? undefined : CeilingGrantSchema.parse(grantInput);
    this.assertCampaignQuota(policy.ceilingUsd);
    this.assertPolicyCeiling(policy.ceilingUsd, policy.maxJobUsd);
    return this.transaction((existing) => {
      const database: OperationDatabase = existing ?? {
        version: 1 as const,
        projectId: this.projectId,
        revision: 0,
        policy,
        jobs: {},
      };
      const previous = existing ? existing.policy.ceilingUsd : null;
      const change = ceilingChange(previous, policy.ceilingUsd);
      if (ceilingNeedsGrant(previous, policy.ceilingUsd) && !grant)
        throw new BudgetError(
          "AUTHORITY_REQUIRED",
          ceilingAuthorityMessage(this.projectId, previous, policy.ceilingUsd),
        );
      const binding = this.assertCampaignQuota(policy.ceilingUsd, database.campaignAllocation);
      if (binding) database.campaignAllocation = binding;
      const totals = accounting(database);
      if (totals.reserved + totals.settled > limit(policy.ceilingUsd))
        throw new BudgetError("BUDGET_EXCEEDED", "New ceiling is below committed liability.");
      database.policy = policy;
      database.policyEvents = [
        ...(database.policyEvents ?? []),
        {
          at: new Date().toISOString(),
          previousCeilingUsd: previous,
          ceilingUsd: policy.ceilingUsd,
          change,
          ...(grant ? { grant } : {}),
        },
      ];
      return { database, result: database };
    });
  }
  /**
   * The most a new production (or repair) job could reserve now under every admission limit, read without a lock
   * or any write; null before any policy exists.
   */
  maxAdmissibleUsd(options: { repair?: boolean } = {}): number | null {
    const database = this.read();
    if (!database) return null;
    return maxAdmissibleUsdFor(database, this.policy()?.budget, options.repair === true);
  }
  /** The current durable ceiling, or null before any policy exists. */
  ceilingUsd(): number | null {
    return this.read()?.policy.ceilingUsd ?? null;
  }
  reserveOperation(input: OperationInput): GenerationJob {
    const parsed = OperationInputSchema.safeParse(input);
    if (!parsed.success)
      throw new BudgetError("UNKNOWN_PRICE", `A valid explicit bounded USD quote is required: ${parsed.error.message}`);
    const operation = parsed.data;
    if (!Object.hasOwn(this.read()?.jobs ?? {}, operation.operationId)) this.assertNotPaused();
    let created = false;
    return this.transaction(
      (database) => {
        if (!database) throw new BudgetError("UNINITIALIZED", "Configure a budget before reserving paid work.");
        const existing = Object.hasOwn(database.jobs, operation.operationId)
          ? database.jobs[operation.operationId]
          : undefined;
        if (existing) {
          if (identity(existing) !== identity(operation))
            throw new BudgetError("CONFLICT", "Operation ID is already bound to different inputs/quote.");
          return { database, result: existing };
        }
        assertProductionSpend(path.dirname(path.dirname(this.file)));
        this.assertPolicyOperation(operation);
        if (
          !operation.quote.pricingEvidence &&
          !Object.hasOwn(PRICING, operation.quote.model ?? "") &&
          operation.quote.source.startsWith(FAL_PLATFORM_PRICING_API) &&
          operation.quote.confidence !== "user-bound"
        )
          throw new BudgetError("UNKNOWN_PRICE", "API-derived bounded pricing requires trusted platform evidence.");
        if (operation.quote.pricingEvidence) {
          try {
            assertCurrentPricingEvidence(operation.quote.pricingEvidence, operation.endpoint);
          } catch (error) {
            throw new BudgetError(
              "UNKNOWN_PRICE",
              `New reservation requires trusted current pricing evidence: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        const amount = liability(reservationUsd(operation.quote));
        const { refusal } = admission(database, this.policy()?.budget, amount, amount, operation.repair);
        if (refusal) throw refusal;
        const peers = Object.values(database.jobs).filter((job) => job.assetId === operation.assetId);
        if (peers.some((job) => job.state === "unknown" || job.state === "submitting"))
          throw new BudgetError(
            "CONFLICT",
            "Resolve ambiguous submission before creating another paid attempt for this asset.",
          );
        const attempts = peers.reduce(
          (count, job) => count + job.paidAttempts + (job.state === "reserved" && !job.release && !job.receipt ? 1 : 0),
          0,
        );
        if (attempts >= database.policy.maxPaidAttemptsPerAsset)
          throw new BudgetError("ATTEMPT_LIMIT", "Paid attempt limit exceeded for this asset.");
        const now = new Date().toISOString();
        const job: GenerationJob = {
          ...operation,
          state: "reserved",
          reservedMicros: amount,
          paidAttempts: 0,
          createdAt: now,
          updatedAt: now,
          refunds: [],
          history: [
            { state: "planned", at: now },
            { state: "reserved", at: now },
          ],
        };
        database.jobs[job.operationId] = job;
        created = true;
        return { database, result: job };
      },
      () => created,
    );
  }
  /** Re-admit historical discounted liabilities atomically before any request-creating submit. */
  admitSubmission(id: string): GenerationJob {
    assertProductionSpend(path.dirname(path.dirname(this.file)));
    // Every caller is about to create a provider request (a first submit, or an idempotent resubmit of a job with a
    // saved body and no request ID): refused while paused. Completing a job that has a request ID never comes here.
    this.assertNotPaused();
    return this.transaction((database) => {
      const job = database && Object.hasOwn(database.jobs, id) ? database.jobs[id] : undefined;
      if (
        !database ||
        !job ||
        job.release ||
        job.receipt ||
        !["reserved", "submitting", "unknown"].includes(job.state) ||
        job.providerRequestId
      )
        throw new BudgetError(
          "CONFLICT",
          "Submission admission has already been reconciled/released or is no longer pending.",
        );
      this.admitPendingSubmission(database, job);
      return { database, result: job };
    });
  }
  persistSubmission(id: string, patch: { requestBody?: string; upload?: ProviderUpload }): GenerationJob {
    return this.transaction((database) => {
      const job = database?.jobs[id];
      if (!database || !job || job.state !== "reserved" || job.requestBody !== undefined)
        throw new BudgetError("CONFLICT", "Submission bytes can only be prepared once before submit.");
      if (patch.upload) {
        const previous = job.uploads?.find(
          (upload) =>
            upload.sourceSha256 === patch.upload!.sourceSha256 && upload.contentType === patch.upload!.contentType,
        );
        if (previous && JSON.stringify(previous) !== JSON.stringify(patch.upload))
          throw new BudgetError("CONFLICT", "Uploaded reference is immutable.");
        if (!previous) job.uploads = [...(job.uploads ?? []), patch.upload];
      }
      if (patch.requestBody !== undefined) {
        const body: unknown = JSON.parse(patch.requestBody);
        if (!body || typeof body !== "object" || Array.isArray(body))
          throw new BudgetError("CONFLICT", "Submission body must be a JSON object.");
        job.requestBody = patch.requestBody;
        job.requestBodySha256 = createHash("sha256").update(patch.requestBody).digest("hex");
      }
      job.updatedAt = new Date().toISOString();
      return { database, result: job };
    });
  }
  /** Soul ID capacity rejection proves no request was created; keep admission reserved for the same operation. */
  rejectHiggsfieldTrainingAdmission(id: string): GenerationJob {
    return this.transaction((database) => {
      const job = database && Object.hasOwn(database.jobs, id) ? database.jobs[id] : undefined;
      if (
        !database ||
        !job ||
        job.provider !== "higgsfield" ||
        job.endpoint !== "v1/custom-references" ||
        job.state !== "submitting" ||
        job.providerRequestId
      )
        throw new BudgetError("CONFLICT", "Only a rejected Soul ID submission can return to admission.");
      job.state = "reserved";
      job.paidAttempts = Math.max(0, job.paidAttempts - 1);
      job.updatedAt = new Date().toISOString();
      job.history.push({
        state: "reserved",
        at: job.updatedAt,
        note: "HTTP 429: no custom reference created; retry the same operation after Retry-After.",
      });
      return { database, result: job };
    }, true);
  }
  /** Provider-confirmed no-charge failure; replay also repairs an interrupted ledger write. */
  confirmNoCharge(id: string, source: string): GenerationJob {
    let job = this.snapshot().jobs[id];
    job = this.releaseReservation(id, {
      confirmationId: `${job.provider}:${job.providerRequestId ?? id}:no-charge`,
      reason: "confirmed-no-charge",
      source,
    });
    this.recordProviderCost(id);
    return job;
  }
  /** Called under the operation work lease; one ledger entry per completed/refunded request. */
  recordProviderCost(id: string): void {
    const job = this.snapshot().jobs[id];
    const ledger = path.join(path.dirname(this.file), "cost-ledger.jsonl");
    const rows = existsSync(ledger)
      ? readFileSync(ledger, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { operationId?: string })
      : [];
    const noCharge = job.release?.reason === "confirmed-no-charge";
    const assetId =
      job.provider === "higgsfield" && job.assetId === job.publication?.output && path.isAbsolute(job.assetId)
        ? path.relative(path.dirname(path.dirname(this.file)), job.assetId)
        : job.assetId;
    const ledgerAssetId =
      job.provider === "higgsfield" &&
      job.assetId === job.publication?.output &&
      (assetId === ".." || assetId.startsWith(`..${path.sep}`) || path.isAbsolute(assetId))
        ? path.basename(assetId)
        : assetId;
    const estimateNote =
      job.quote.confidence === "user-bound" ? "Admitted user planning bound" : "Admitted quote expected USD";
    if (!rows.some((row) => row.operationId === id))
      appendFileSync(
        ledger,
        `${JSON.stringify({ ts: job.updatedAt, projectId: this.projectId, operationId: id, provider: job.provider, service: job.provider, model: job.endpoint, stage: job.stage, assetId: ledgerAssetId, units: noCharge ? 0 : 1, unitName: "request", estimatedUsd: noCharge ? 0 : job.quote.expectedUsd, actualUsd: noCharge ? 0 : null, notes: job.release?.source ?? `${estimateNote}; source=${job.quote.source}; reconcile actual billing against this operation.` })}\n`,
      );
  }
  transitionJob(
    id: string,
    next: JobStatus,
    patch: {
      providerRequestId?: string;
      providerUrls?: ProviderUrls;
      queueRoute?: string;
      result?: Record<string, unknown>;
      error?: string;
      refundedFailure?: true;
      note?: string;
      expectedState?: JobStatus;
    } = {},
  ): GenerationJob {
    if (next === "submitting") this.assertNotPaused();
    let changed = false;
    return this.transaction(
      (database) => {
        if (!database) throw new BudgetError("UNINITIALIZED", "Operation store is not initialized.");
        const job = Object.hasOwn(database.jobs, id) ? database.jobs[id] : undefined;
        if (!job) throw new BudgetError("CONFLICT", "Unknown operation ID.");
        if (patch.expectedState && job.state !== patch.expectedState)
          throw new BudgetError("CONFLICT", "Operation state changed before claiming work.");
        if (next === "submitting") {
          assertProductionSpend(path.dirname(path.dirname(this.file)));
          this.admitPendingSubmission(database, job);
        }
        const urlsChanged =
          (!!patch.providerUrls &&
            !!job.providerUrls &&
            JSON.stringify(patch.providerUrls) !== JSON.stringify(job.providerUrls)) ||
          (!!patch.queueRoute && !!job.queueRoute && patch.queueRoute !== job.queueRoute);
        if (job.state === next) {
          if (patch.providerRequestId && job.providerRequestId && patch.providerRequestId !== job.providerRequestId)
            throw new BudgetError("CONFLICT", "Provider request ID is immutable.");
          if (urlsChanged) throw new BudgetError("CONFLICT", "Provider queue URLs are immutable.");
          return { database, result: job };
        }
        if (!NEXT[job.state].includes(next))
          throw new BudgetError("INVALID_TRANSITION", `Cannot transition ${job.state} to ${next}.`);
        if (patch.providerRequestId && job.providerRequestId && patch.providerRequestId !== job.providerRequestId)
          throw new BudgetError("CONFLICT", "Provider request ID is immutable.");
        if (job.state === "failed" && next === "downloading" && !job.result)
          throw new BudgetError("INVALID_TRANSITION", "Download retry requires the previously persisted result.");
        const localRealtimeResult =
          job.provider === "fal-realtime" &&
          job.endpoint === "fal-ai/flux-2/klein/realtime" &&
          ["result-ready", "downloading", "validated", "published"].includes(next) &&
          RealtimeLocalResultEvidenceSchema.safeParse(patch.result ?? job.result).success;
        const localStreamResult =
          job.provider === "fal-stream" &&
          FAL_HTTP_STREAM_ENDPOINTS.includes(job.endpoint) &&
          ["result-ready", "downloading", "validated", "published"].includes(next) &&
          StreamLocalResultEvidenceSchema.safeParse(patch.result ?? job.result).success;
        const localAcquisitionResult =
          job.provider === "rapidapi" &&
          job.endpoint === "coder2077/download" &&
          ["result-ready", "downloading", "validated", "published"].includes(next) &&
          MediaAcquisitionResultEvidenceSchema.safeParse(patch.result ?? job.result).success;
        if (
          ["queued", "running", "result-ready", "downloading", "validated", "published"].includes(next) &&
          !(patch.providerRequestId ?? job.providerRequestId) &&
          !localRealtimeResult &&
          !localStreamResult &&
          !localAcquisitionResult
        )
          throw new BudgetError(
            "INVALID_TRANSITION",
            "Submitted job requires a provider request ID or validated local transport result evidence.",
          );
        if (["downloading", "validated", "published"].includes(next) && !job.result && !patch.result)
          throw new BudgetError("INVALID_TRANSITION", "Result metadata is required before downloading/publishing.");
        if (next === "submitting") {
          if (job.release || job.receipt)
            throw new BudgetError("INVALID_TRANSITION", "Reservation has already been reconciled/released.");
          job.paidAttempts += 1;
        }
        if (urlsChanged) throw new BudgetError("CONFLICT", "Provider queue URLs are immutable.");
        if ((patch.providerUrls || patch.queueRoute) && !(patch.providerRequestId ?? job.providerRequestId))
          throw new BudgetError("INVALID_TRANSITION", "Provider queue URLs require a provider request ID.");
        if (patch.providerRequestId) job.providerRequestId = patch.providerRequestId;
        if (patch.providerUrls) job.providerUrls = patch.providerUrls;
        if (patch.queueRoute) job.queueRoute = patch.queueRoute;
        if (patch.result) job.result = patch.result;
        if (patch.refundedFailure) job.refundedFailure = true;
        if (patch.error) job.error = patch.error;
        else if (next !== "failed" && next !== "unknown") job.error = undefined;
        job.state = next;
        job.updatedAt = new Date().toISOString();
        job.history.push({
          state: next,
          at: job.updatedAt,
          ...((patch.note ?? patch.error) ? { note: patch.note ?? patch.error } : {}),
        });
        changed = true;
        return { database, result: job };
      },
      () => changed,
    );
  }
  reconcileBilling(id: string, input: BillingReceipt): GenerationJob {
    const receipt = BillingReceiptSchema.parse(input);
    let settled = false;
    return this.transaction(
      (database) => {
        if (!database) throw new BudgetError("UNINITIALIZED", "Operation store is not initialized.");
        const job = Object.hasOwn(database.jobs, id) ? database.jobs[id] : undefined;
        if (!job) throw new BudgetError("CONFLICT", "Unknown operation ID.");
        if (job.receipt) {
          if (JSON.stringify(job.receipt) !== JSON.stringify(receipt))
            throw new BudgetError("CONFLICT", "Billing already reconciled with a different receipt.");
        } else {
          if (job.paidAttempts === 0 || job.release)
            throw new BudgetError("CONFLICT", "Cannot settle unsubmitted or released operation.");
          if (
            Object.values(database.jobs).some(
              (peer) =>
                peer.receipt?.receiptId === receipt.receiptId ||
                peer.refunds.some((refund) => refund.receiptId === receipt.receiptId),
            )
          )
            throw new BudgetError("CONFLICT", "Billing receipt already applied to another operation.");
          job.receipt = receipt;
          job.reservedMicros = 0;
          job.updatedAt = new Date().toISOString();
          settled = true;
        }
        return { database, result: job };
      },
      () => settled,
    );
  }
  recordRefund(id: string, input: GenerationJob["refunds"][number]): GenerationJob {
    return this.transaction((database) => {
      if (!database) throw new BudgetError("UNINITIALIZED", "Operation store is not initialized.");
      const job = Object.hasOwn(database.jobs, id) ? database.jobs[id] : undefined;
      if (!job?.receipt) throw new BudgetError("CONFLICT", "Refund requires confirmed original billing.");
      const duplicate = job.refunds.find((refund) => refund.receiptId === input.receiptId);
      if (duplicate) {
        if (JSON.stringify(duplicate) !== JSON.stringify(input))
          throw new BudgetError("CONFLICT", "Refund receipt conflicts with recorded refund.");
        return { database, result: job };
      }
      if (
        Object.values(database.jobs).some(
          (peer) =>
            peer.receipt?.receiptId === input.receiptId ||
            peer.refunds.some((refund) => refund.receiptId === input.receiptId),
        )
      )
        throw new BudgetError("CONFLICT", "Receipt already applied.");
      if (
        job.refunds.reduce((total, refund) => total + liability(refund.refundUsd), 0) + liability(input.refundUsd) >
        liability(job.receipt.actualUsd)
      )
        throw new BudgetError("CONFLICT", "Refund exceeds confirmed billing.");
      job.refunds.push(input);
      job.updatedAt = new Date().toISOString();
      return { database, result: job };
    });
  }
  releaseReservation(id: string, confirmation: NonNullable<GenerationJob["release"]>): GenerationJob {
    return this.transaction((database) => {
      if (!database) throw new BudgetError("UNINITIALIZED", "Operation store is not initialized.");
      const job = Object.hasOwn(database.jobs, id) ? database.jobs[id] : undefined;
      if (!job) throw new BudgetError("CONFLICT", "Unknown operation ID.");
      if (job.receipt)
        throw new BudgetError("CONFLICT", "Confirmed billing cannot be erased by releasing a reservation.");
      if (confirmation.reason === "not-submitted" && job.paidAttempts !== 0)
        throw new BudgetError("CONFLICT", "Submission may have charged; confirmation of no charge is required.");
      if (job.release && JSON.stringify(job.release) !== JSON.stringify(confirmation))
        throw new BudgetError("CONFLICT", "Reservation already released with another confirmation.");
      job.release = confirmation;
      job.reservedMicros = 0;
      job.updatedAt = new Date().toISOString();
      return { database, result: job };
    });
  }
  /** Records the user's cancel request on the job (`job:cancel`); the state changes only through transitionJob. */
  recordCancellation(id: string, cancellation: NonNullable<GenerationJob["cancellation"]>): GenerationJob {
    return this.transaction((database) => {
      if (!database) throw new BudgetError("UNINITIALIZED", "Operation store is not initialized.");
      const job = Object.hasOwn(database.jobs, id) ? database.jobs[id] : undefined;
      if (!job) throw new BudgetError("CONFLICT", "Unknown operation ID.");
      job.cancellation = cancellation;
      job.updatedAt = new Date().toISOString();
      return { database, result: job };
    });
  }
  summary() {
    const database = this.snapshot();
    const totals = accounting(database);
    return {
      currency: "USD" as const,
      ceilingUsd: database.policy.ceilingUsd,
      reservedUsd: totals.reserved / MICRO,
      settledUsd: totals.settled / MICRO,
      availableUsd: Math.max(0, limit(database.policy.ceilingUsd) - totals.reserved - totals.settled) / MICRO,
      overBudget: totals.reserved + totals.settled > limit(database.policy.ceilingUsd),
      unreconciled: Object.values(database.jobs)
        .filter(awaitsReceipt)
        .map((job) => job.operationId),
    };
  }
  /**
   * Jobs that may have been charged (a paid attempt, no receipt, no release) with the amount each still reserves:
   * reserved, not spent. Read-only and lock-free; empty before any policy exists.
   */
  pendingReconciliation(): { operationId: string; endpoint: string; reservedUsd: number }[] {
    const database = this.read();
    if (!database) return [];
    return Object.values(database.jobs)
      .filter(awaitsReceipt)
      .map((job) => ({
        operationId: job.operationId,
        endpoint: job.endpoint,
        reservedUsd: job.reservedMicros / MICRO,
      }));
  }
}
