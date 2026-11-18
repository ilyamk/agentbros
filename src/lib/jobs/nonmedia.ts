import { remoteMediaAssetIds, verifyRemoteMedia } from "../assets/remote-media";
import { ensureProjectPolicy } from "./initial-policy";
import { createHiggsfieldClient } from "../providers/higgsfield/client";
import { createHiggsfieldTrainingProvider } from "./higgsfield-training";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { OperationStore, reservationUsd } from "./store";
import { runGenerationStep, generationInputHash } from "./runner";
import { resolveOperationIdentity } from "./identity";
import { createFalJobProvider, createFalRestQueue } from "./fal-provider";
import { requireProject, requireEnv, CliErrorObject } from "../cli";
import {
  createPublicListPricingEvidence,
  createPlatformPricingEvidence,
  planningOnlyFalPricing,
} from "../models/pricing-evidence";
import { quote } from "../pricing";
import { findModel } from "../models/registry";
import { findCatalogEntry, findProviderEntry } from "../models/fal-catalog";
import { falPriceFor } from "../models/fal-pricing";
import type { PriceQuote } from "./types";
import type { ExecutionOptions } from "./execution";
import { digest, publishNonMediaResult, verifyFalPublication } from "./model-artifacts";
export type NonMediaOptions = Omit<ExecutionOptions, "mediaKind"> & { kind: "training" | "voice" };
function priceFor(options: NonMediaOptions): PriceQuote | null {
  if (
    options.quoteInput?.provider === "higgsfield" &&
    generationInputHash(options.quoteInput.providerInput ?? {}) !== generationInputHash(options.input)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Higgsfield quote input must match the exact operation input.",
    });
  const isHiggsfield = options.providerId === "higgsfield" || options.quoteInput?.provider === "higgsfield";
  if (isHiggsfield && options.quoteInput?.provider !== "higgsfield")
    throw new CliErrorObject({ code: "VALIDATION", message: "Higgsfield training needs provider-bound quote input." });
  const descriptor = isHiggsfield ? undefined : findModel(options.endpoint);
  const expectedKind =
    descriptor?.operation === "create-voice"
      ? "voice"
      : descriptor?.operation === "training" ||
          (!descriptor &&
            (isHiggsfield ? findProviderEntry("higgsfield", options.endpoint) : findCatalogEntry(options.endpoint))
              ?.category === "training")
        ? "training"
        : undefined;
  if (options.model !== options.endpoint || expectedKind !== options.kind)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Fresh nonmedia pricing requires an exact registered endpoint/model and matching operation kind.",
    });
  const quantities = options.quoteInput;
  if (
    (quantities?.units !== undefined && quantities.units !== 1) ||
    (quantities?.multiplier !== undefined && quantities.multiplier !== 1) ||
    quantities?.durationSec !== undefined
  )
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message:
        "Nonmedia execution quotes exactly one physical operation; units and multiplier must be one and duration is not a generation count.",
    });
  const estimate = quote({ ...quantities, units: 1, multiplier: 1, model: options.endpoint });
  // Page-derived or API-fallback registry prices plan and compare only; paid admission needs an authorised bound.
  const planningOnly = options.quoteInput?.provider !== "higgsfield" && planningOnlyFalPricing(options.model);
  if (
    !planningOnly &&
    estimate.bounded &&
    estimate.highUsd !== null &&
    estimate.lowUsd !== null &&
    estimate.expectedUsd !== null
  ) {
    if (
      options.maxCostUsd !== undefined &&
      reservationUsd({ highUsd: estimate.highUsd, pricingEvidence: estimate.pricingEvidence }) > options.maxCostUsd
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Published quote exceeds the explicit per-operation bound.",
      });
    let pricingEvidence: PriceQuote["pricingEvidence"];
    try {
      pricingEvidence =
        options.quoteInput?.provider === "higgsfield"
          ? estimate.pricingEvidence
          : (createPublicListPricingEvidence(options.model) ?? createPlatformPricingEvidence(options.model));
    } catch (error) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Invalid trusted public tariff snapshot: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    if (
      options.quoteInput?.provider !== "higgsfield" &&
      !pricingEvidence &&
      !findModel(options.model) &&
      falPriceFor(options.model)?.origin === "platform-pricing-api"
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "API-derived bounded pricing requires trusted platform evidence.",
      });
    if (pricingEvidence && options.endpoint !== options.model)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Public tariff quote requires the exact endpoint/model binding.",
      });
    return {
      ...estimate,
      ...(pricingEvidence ? { pricingEvidence } : {}),
      lowUsd: estimate.lowUsd,
      expectedUsd: estimate.expectedUsd,
      highUsd: estimate.highUsd,
      bounded: true,
      confidence: estimate.confidence === "unknown" ? "conservative-bound" : estimate.confidence,
      notes: estimate.notes ? [estimate.notes] : [],
    };
  }
  if (options.maxCostUsd === undefined) return null;
  return {
    lowUsd: 0,
    expectedUsd: options.maxCostUsd,
    highUsd: options.maxCostUsd,
    currency: "USD",
    source: "Explicit CLI user planning bound (provider billing is not capped)",
    asOf: new Date().toISOString(),
    confidence: "user-bound",
    bounded: true,
    providerEnforced: false,
    model: options.model,
    notes: ["Unknown provider price; reconcile the actual receipt before releasing commitment."],
  };
}

/** Publication manifest replaces arbitrary media output paths for training and voice IDs. */
export async function executeFalNonMedia(
  options: NonMediaOptions,
): Promise<{ outputs: string[]; metadata: Record<string, unknown> }> {
  if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--max-cost-usd must be positive and finite." });
  const providerId = options.providerId ?? (options.quoteInput?.provider === "higgsfield" ? "higgsfield" : "fal");
  const storedProvider = providerId === "higgsfield" ? "higgsfield" : "fal.ai";
  // Resolved from the process's current directory, not the project: callers pass public/projects/<id>/... from the repository root.
  const output = path.resolve(options.output);
  const publication = {
    output,
    kind: options.kind,
    model: options.model,
    referenceAssetIds: [...new Set(options.referenceAssetIds ?? [])].sort(),
  };
  const { operationId, inputHash, existing } = resolveOperationIdentity({
    input: options.input,
    projectId: options.projectId,
    operationId: options.operationId,
    endpoint: options.endpoint,
    provider: storedProvider,
    assetId: options.assetId ?? output,
    id: (hash) => `${providerId}:${digest(`${options.endpoint}:${hash}:${output}`).slice(0, 40)}`,
  });
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(operationId))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid operation ID." });
  const remoteMedia = options.remoteMedia ?? existing?.publication?.remoteMedia;
  if (remoteMedia?.length) {
    if (providerId !== "higgsfield" || !options.projectId)
      throw new CliErrorObject({ code: "VALIDATION", message: "Remote media requires a Higgsfield project." });
    Object.assign(publication, { remoteMedia });
    publication.referenceAssetIds = [
      ...new Set([
        ...publication.referenceAssetIds,
        ...remoteMediaAssetIds(options.projectId, remoteMedia, options.input),
      ]),
    ].sort();
  }
  if (existing) {
    const expectedIdentity = {
      provider: storedProvider,
      endpoint: options.endpoint,
      inputHash,
      assetId: options.assetId ?? output,
      stage: options.stage ?? "assets",
      repair: false,
      publication,
    };
    const originalIdentity = {
      provider: existing.provider,
      endpoint: existing.endpoint,
      inputHash: existing.inputHash,
      assetId: existing.assetId,
      stage: existing.stage ?? null,
      repair: existing.repair,
      publication: existing.publication ?? null,
    };
    if (generationInputHash(originalIdentity) !== generationInputHash(expectedIdentity))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Operation ID is already bound to different inputs or publication identity.",
      });
    const canRecover = existing.requestBody !== undefined && options.provider?.idempotentSubmit;
    const maySubmit =
      !existing.providerRequestId &&
      !existing.release &&
      !existing.receipt &&
      (existing.state === "reserved" || (canRecover && ["submitting", "unknown"].includes(existing.state)));
    const commitmentUsd = Math.max(
      existing.quote.highUsd,
      existing.reservedMicros / 1_000_000,
      maySubmit ? reservationUsd(existing.quote) : 0,
    );
    if (options.maxCostUsd !== undefined && commitmentUsd > options.maxCostUsd)
      throw new CliErrorObject({
        code: "VALIDATION",
        message:
          "Explicit bound is below the original operation commitment; existing liability cannot be lowered by resume.",
      });
  }
  if (options.dryRun) {
    const quoted = existing?.quote ?? priceFor(options);
    return {
      outputs: [],
      metadata: {
        dryRun: true,
        operationId,
        quote: quoted,
        executable: quoted !== null,
        kind: options.kind,
        publication: "immutable-project-manifest",
      },
    };
  }
  if (!options.projectId)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Paid generation requires --project." });
  requireProject(options.projectId);
  const projectId = options.projectId;
  const store = new OperationStore(projectId);
  const quoted = existing?.quote ?? priceFor(options);
  if (!quoted && !existing)
    throw new CliErrorObject({ code: "VALIDATION", message: "Unknown price requires explicit --max-cost-usd." });
  const remoteMaySubmit =
    !existing ||
    (!existing.providerRequestId &&
      !existing.release &&
      !existing.receipt &&
      (existing.state === "reserved" ||
        (options.provider?.idempotentSubmit &&
          existing.requestBody !== undefined &&
          ["submitting", "unknown"].includes(existing.state))));
  if (remoteMedia?.length && remoteMaySubmit)
    await verifyRemoteMedia(projectId, remoteMedia, process.cwd(), options.remoteMediaIo);
  ensureProjectPolicy(store, projectId);
  const provider =
    options.provider ??
    (providerId === "higgsfield"
      ? createHiggsfieldTrainingProvider(
          createHiggsfieldClient({ credentials: requireEnv("HIGGSFIELD_API_KEY"), fetch: options.fetch }),
        )
      : createFalJobProvider(createFalRestQueue({ credentials: requireEnv("FAL_KEY"), fetch: options.fetch })));
  const job = await runGenerationStep({
    store,
    input: options.input,
    operation: {
      operationId,
      provider: storedProvider,
      endpoint: options.endpoint,
      assetId: options.assetId ?? output,
      stage: options.stage ?? "assets",
      quote: existing?.quote ?? quoted!,
      publication,
    },
    provider,
    ...(options.queuePath ? { queueRoute: options.queuePath } : {}),
    publish: async (result, operation) => {
      options.validateResult?.(result);
      return publishNonMediaResult(
        projectId,
        options.kind,
        result,
        operation,
        options.fetch ?? fetch,
        findModel(options.endpoint) ? undefined : options.resultSchema,
      );
    },
  });
  const published = job.result?.published as
    | {
        outputs?: string[];
        hashes?: string[];
        artifacts?: { path: string; sha256: string }[];
        voiceId?: string;
        customReferenceId?: string;
      }
    | undefined;
  const outputs = job.state === "published" ? (published?.outputs ?? []) : [];
  if (job.state === "published") verifyFalPublication(published, { projectId, operationId });
  return {
    outputs,
    metadata: {
      operationId,
      state: job.state,
      providerRequestId: job.providerRequestId ?? null,
      quote: job.quote,
      billing: job.receipt ?? null,
      budget: store.summary(),
      kind: options.kind,
      ...(job.error ? { error: job.error } : {}),
      ...(job.state === "published" && published?.voiceId ? { voiceId: published.voiceId } : {}),
      ...(job.state === "published" && published?.customReferenceId
        ? { customReferenceId: published.customReferenceId }
        : {}),
      nextAction:
        job.state === "published"
          ? "reconcile-billing"
          : job.state === "unknown"
            ? "reconcile-provider-request"
            : "resume-same-operation",
    },
  };
}
