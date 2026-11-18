import { generationRequestBody } from "./request-body";
import { canonicalRequestBody } from "./request-body";
import { paidInputIdentity } from "./identity";
export { generationRequestBody } from "./request-body";
import { CliErrorObject } from "../cli";
import { createHash } from "node:crypto";
import { claimOperationWork } from "./work-lease";
import { OperationStore, BudgetError } from "./store";
import {
  ProviderUrlsSchema,
  QueueRouteSchema,
  type GenerationJob,
  type OperationInput,
  type ProviderUrls,
  type ProviderUpload,
} from "./types";

export interface JobProvider {
  /** Only providers that guarantee byte-identical idempotency may recover a lost submit response. */
  idempotentSubmit?: boolean;
  prepareInput?(
    input: Record<string, unknown>,
    context: { uploads: ProviderUpload[]; persistUpload: (upload: ProviderUpload) => void },
  ): Promise<Record<string, unknown>>;
  /** No automatic retry: a lost response may still have created a paid job. */
  submit(
    endpoint: string,
    input: Record<string, unknown>,
    context?: { operationId: string; body?: string },
  ): Promise<{ requestId: string; providerUrls?: ProviderUrls }>;
  /** `context` holds what the job stored at submit: the queue URLs the provider returned, and the OpenAPI route the caller supplied. */
  inspect(
    endpoint: string,
    requestId: string,
    context?: { providerUrls?: ProviderUrls; queueRoute?: string },
  ): Promise<
    | { state: "queued" | "running" }
    | { state: "completed"; result: Record<string, unknown> }
    | { state: "failed"; message: string; refunded?: boolean }
  >;
}
export type Publisher = (result: Record<string, unknown>, job: GenerationJob) => Promise<Record<string, unknown>>;

export const generationInputHash = (input: Record<string, unknown>): string =>
  createHash("sha256").update(generationRequestBody(input)).digest("hex");

/** One resumable step. Provider submits are durable and are never blindly retried. */
export async function runGenerationStep(options: {
  store: OperationStore;
  operation: Omit<OperationInput, "inputHash">;
  input: Record<string, unknown>;
  provider: JobProvider;
  publish?: Publisher;
  /** OpenAPI submit path, persisted with the job at submit; resumes use the stored one. */
  queueRoute?: string;
}): Promise<GenerationJob> {
  const { store, provider, input, publish } = options;
  // Checked before any reservation or submit: an invalid route must never make the
  // post-submit transition fail and lose the request ID.
  if (options.queueRoute !== undefined) QueueRouteSchema.parse(options.queueRoute);
  const stored = store.snapshot().jobs;
  const previous = Object.hasOwn(stored, options.operation.operationId)
    ? stored[options.operation.operationId]
    : undefined;
  // A resumed operation uses the original quote snapshot; tariff drift cannot
  // retroactively rewrite its commitment or break provider request ownership.
  let job = store.reserveOperation({
    ...options.operation,
    quote: previous?.quote ?? options.operation.quote,
    quotedRequestBody: previous ? previous.quotedRequestBody : options.operation.quotedRequestBody,
    ...(previous?.preparedInputHash ? { preparedInputHash: previous.preparedInputHash } : {}),
    ...paidInputIdentity(input, previous),
  });
  if (job.state === "published" || job.state === "cancelled") return job;
  const release = claimOperationWork(store, job.operationId);
  if (!release) return store.snapshot().jobs[job.operationId];
  try {
    if (
      job.state === "failed" &&
      (job.refundedFailure || (job.provider === "higgsfield" && job.release?.reason === "confirmed-no-charge"))
    )
      return store.confirmNoCharge(job.operationId, job.release?.source ?? `${job.provider} status: ${job.error}`);
    const recovering =
      provider.idempotentSubmit &&
      ["submitting", "unknown"].includes(job.state) &&
      !job.providerRequestId &&
      job.requestBody !== undefined;
    if (job.state === "reserved" || recovering) {
      job = store.admitSubmission(job.operationId);
      if (provider.idempotentSubmit && job.requestBody === undefined) {
        const prepared = provider.prepareInput
          ? await provider.prepareInput(input, {
              uploads: job.uploads ?? [],
              persistUpload: (upload) => {
                job = store.persistSubmission(job.operationId, { upload });
              },
            })
          : input;
        const locale =
          job.quote.pricingEvidence?.provider === "higgsfield"
            ? job.quote.pricingEvidence.canonicalLocale
            : job.canonicalInput?.legacyLocale;
        if (
          job.quotedRequestBody !== undefined &&
          canonicalRequestBody(JSON.parse(job.quotedRequestBody)) !== canonicalRequestBody(prepared)
        )
          throw new CliErrorObject({
            code: "VALIDATION",
            message: "Prepared Higgsfield input differs from the quoted body.",
          });
        const requestBody = job.quotedRequestBody ?? generationRequestBody(prepared, locale);
        if (job.preparedInputHash && createHash("sha256").update(requestBody).digest("hex") !== job.preparedInputHash)
          throw new CliErrorObject({
            code: "VALIDATION",
            message: "Prepared Higgsfield body differs from the estimated request.",
          });
        job = store.persistSubmission(job.operationId, { requestBody });
      }
      if (job.state === "reserved") {
        try {
          job = store.transitionJob(job.operationId, "submitting", {
            expectedState: "reserved",
          });
        } catch (error) {
          if (error instanceof BudgetError && error.code === "CONFLICT") return store.snapshot().jobs[job.operationId];
          throw error;
        }
      }
      let submitted: { requestId: string; providerUrls?: ProviderUrls };
      if (job.requestBody !== undefined) {
        canonicalRequestBody(JSON.parse(job.requestBody));
        const bodyHash = createHash("sha256").update(job.requestBody).digest("hex");
        if (
          (job.requestBodySha256 && bodyHash !== job.requestBodySha256) ||
          (job.preparedInputHash && bodyHash !== job.preparedInputHash)
        )
          throw new CliErrorObject({
            code: "VALIDATION",
            message: "Frozen Higgsfield body differs from the estimated request.",
          });
      } else if (job.preparedInputHash)
        throw new CliErrorObject({ code: "VALIDATION", message: "Frozen Higgsfield body is missing." });
      job = store.admitSubmission(job.operationId);
      try {
        submitted = await provider.submit(
          job.endpoint,
          job.requestBody !== undefined ? (JSON.parse(job.requestBody) as Record<string, unknown>) : input,
          { operationId: job.operationId, ...(job.requestBody !== undefined ? { body: job.requestBody } : {}) },
        );
        if (!submitted.requestId) throw new Error("Provider returned no request ID");
      } catch (error) {
        // https://docs.higgsfield.ai/docs/models/soul-id/create-character.md: HTTP 429 creates no charged request.
        if (
          job.provider === "higgsfield" &&
          job.endpoint === "v1/custom-references" &&
          error instanceof CliErrorObject &&
          error.code === "RATE_LIMIT" &&
          error.details?.httpStatus === 429
        ) {
          store.rejectHiggsfieldTrainingAdmission(job.operationId);
          throw error;
        }
        if (
          provider.idempotentSubmit &&
          error instanceof CliErrorObject &&
          error.code === "VALIDATION" &&
          /Idempotency-Key body mismatch/.test(error.message)
        )
          return store.transitionJob(job.operationId, "failed", {
            error: error.message,
            note: "Retain liability; reconcile the original idempotency key, never replace it automatically",
          });
        return store.transitionJob(job.operationId, "unknown", {
          error: error instanceof Error ? error.message : String(error),
          note: "Submit outcome is ambiguous; reservation retained",
        });
      }
      // The request ID is what proves ownership of the paid job: queue URLs that
      // do not validate are dropped (old endpoint-root polling) rather than risk losing it.
      const providerUrls = ProviderUrlsSchema.safeParse(submitted.providerUrls);
      job = store.transitionJob(job.operationId, "queued", {
        providerRequestId: submitted.requestId,
        ...(submitted.providerUrls && providerUrls.success ? { providerUrls: providerUrls.data } : {}),
        ...(options.queueRoute ? { queueRoute: options.queueRoute } : {}),
      });
    } else if (job.state === "submitting") {
      return store.transitionJob(job.operationId, "unknown", {
        note: "Restart after submit intent; reconcile provider before another attempt",
      });
    }
    if (job.state === "unknown" && !job.providerRequestId) return job;
    if (["unknown", "queued", "running"].includes(job.state)) {
      if (!job.providerRequestId) throw new BudgetError("CONFLICT", "Submitted operation has no provider request ID");
      const status = await provider.inspect(
        job.endpoint,
        job.providerRequestId,
        job.providerUrls || job.queueRoute
          ? {
              ...(job.providerUrls ? { providerUrls: job.providerUrls } : {}),
              ...(job.queueRoute ? { queueRoute: job.queueRoute } : {}),
            }
          : undefined,
      );
      if (status.state === "queued" || status.state === "running")
        return store.transitionJob(job.operationId, status.state);
      if (status.state === "failed") {
        job = store.transitionJob(job.operationId, "failed", {
          error: status.message,
          ...(status.refunded ? { refundedFailure: true as const } : {}),
        });
        return status.refunded
          ? store.confirmNoCharge(job.operationId, `${job.provider} status: ${status.message}`)
          : job;
      }
      if (status.state !== "completed") throw new Error("Unexpected provider status");
      job = store.transitionJob(job.operationId, "result-ready", {
        result: status.result,
      });
    }
    if (job.provider === "higgsfield" && job.result) store.recordProviderCost(job.operationId);
    if (job.state === "failed" && job.result && publish) job = store.transitionJob(job.operationId, "downloading");
    if (job.state === "result-ready" && publish) job = store.transitionJob(job.operationId, "downloading");
    if (job.state === "downloading" && publish) {
      try {
        const published = await publish(job.result!, job);
        job = store.transitionJob(job.operationId, "validated", {
          result: { ...job.result, published },
        });
      } catch (error) {
        return store.transitionJob(job.operationId, "failed", {
          error: error instanceof Error ? error.message : String(error),
          note: "Result retained; resume download without generation",
        });
      }
    }
    if (job.state === "validated") job = store.transitionJob(job.operationId, "published");
    return job;
  } finally {
    release();
  }
}
