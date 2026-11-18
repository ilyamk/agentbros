import { remoteMediaAssetIds, verifyRemoteMedia, type RemoteMediaIo } from "../assets/remote-media";
import { ensureProjectPolicy, projectMaxAdmissibleUsd } from "./initial-policy";
import type { RemoteMediaBinding } from "../../types/remote-media";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { runGenerationStep, generationInputHash, type JobProvider } from "./runner";
import { resolveOperationIdentity } from "./identity";
import { OperationStore, reservationUsd } from "./store";
import type { PriceQuote, GenerationJob } from "./types";
import type { PagePriceDrift } from "../../types/models";
import { validateVideoForecastEvidence } from "./seedance-forecast";
import {
  createPublicListPricingEvidence,
  createPlatformPricingEvidence,
  planningOnlyFalPricing,
} from "../models/pricing-evidence";
import { quote, type QuoteInput } from "../pricing";
import { findModel } from "../models/registry";
import { resolveFalQuantities } from "../providers/fal-quote-input";
import { falPriceFor } from "../models/fal-pricing";
import { CliErrorObject, emitProgress, requireProject, requireEnv, assertPathWithin } from "../cli";
import { createFalJobProvider, createFalRestQueue, validQueueRoute } from "./fal-provider";
import { importAsset, hashFile } from "../assets/registry";
import { inspectAsset } from "../assets/inspect";
import {
  extractArtifacts,
  artifactExtension,
  type ExtractedArtifacts,
  type ExtractedFile,
  type ResultSchema,
} from "../providers/fal-results";
import {
  digest,
  immutableWrite,
  trustedArtifactUrl,
  validateSafeTensors,
  verifyFalPublication,
} from "./model-artifacts";
import { createHiggsfieldClient } from "../providers/higgsfield/client";
import { createHiggsfieldJobProvider } from "./higgsfield-provider";
import { HIGGSFIELD_OUTPUT_SCHEMA } from "../models/fal-catalog";
import { pipelineDir, projectDir } from "../pipeline/paths";
import { genjutsuMode } from "../model-preparation/profiles";
import { preparationAdmission } from "../model-preparation/approval";
import { recordPreparationResult } from "../model-preparation/results";
import { recordPackOutput } from "../references/packs/outputs";
import { jobSubmitted, noPackWarning } from "../references/packs/enforcement";
import type { ReferencePackBinding } from "../../types/reference-pack-binding";
import type { ModelPreparationBinding } from "../../types/model-preparation-binding";
import type { OutputKind, ProviderId } from "../../types/fal-catalog";
export const PAID_CLI_SPECS = [
  {
    name: "dry-run",
    type: "boolean",
    description: "Validate plan/quote offline without reservation, writes or API calls",
  },
  { name: "operation-id", description: "Stable operation ID to submit or resume" },
  {
    name: "max-cost-usd",
    type: "number",
    description: "Explicit user planning bound for unknown prices; does not cap provider billing",
  },
] as const;
export interface ExecutionOptions {
  referenceAssetIds?: string[];
  projectId?: string;
  endpoint: string;
  model: string;
  input: Record<string, unknown>;
  output: string;
  /** What the operation publishes: media and file kinds are downloaded to `output`; `text`/`json` become a result manifest. */
  mediaKind: OutputKind;
  stage?: string;
  /** The endpoint's output schema; guides result extraction when known. */
  resultSchema?: ResultSchema;
  /** The endpoint's OpenAPI submit path without its leading slash (`openApiRoutes(model).submitPath`): the status/result route when the submit returns no queue URLs. */
  queuePath?: string;
  assetId?: string;
  operationId?: string;
  forecastEvidence?: PriceQuote["forecastEvidence"];
  maxCostUsd?: number;
  dryRun?: boolean;
  force?: boolean;
  quoteInput?: Omit<QuoteInput, "model">;
  providerId?: ProviderId;
  higgsfieldEstimateBody?: string;
  modelPreparation?: ModelPreparationBinding;
  /** The reference pack generate:model verified for this request (RFC 0003); published outputs are linked to it. */
  referencePack?: ReferencePackBinding;
  /** generate:model ran the full reference-pack gate itself (admission.ts); skip the no-pack rule here. */
  referencePackGated?: boolean;
  remoteMedia?: RemoteMediaBinding[];
  remoteMediaIo?: RemoteMediaIo;
  provider?: JobProvider;
  fetch?: typeof fetch;
  validateResult?: (result: Record<string, unknown>) => void;
}
function validateBound(options: ExecutionOptions): void {
  if (options.modelPreparation && !genjutsuMode(options.endpoint, options.providerId ?? "fal"))
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Genjutsu preparation cannot authorise another provider or model.",
    });
  if (options.maxCostUsd !== undefined && (!Number.isFinite(options.maxCostUsd) || options.maxCostUsd <= 0))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--max-cost-usd must be positive and finite." });
  if (options.higgsfieldEstimateBody !== undefined && options.providerId !== "higgsfield")
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Prepared estimate bodies are Higgsfield-only." });
}
function priceFor(options: ExecutionOptions): PriceQuote | null {
  const pricingInput =
    options.higgsfieldEstimateBody === undefined
      ? options.input
      : (JSON.parse(options.higgsfieldEstimateBody) as Record<string, unknown>);
  if (
    options.quoteInput?.provider === "higgsfield" &&
    generationInputHash(options.quoteInput.providerInput ?? {}) !== generationInputHash(pricingInput)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Higgsfield quote input must match the exact prepared operation input.",
    });
  // A Higgsfield operation never takes a fal price for a shared endpoint ID: without a Higgsfield quote input, only an explicit bound admits it.
  if (options.providerId === "higgsfield" && options.quoteInput?.provider !== "higgsfield") {
    if (options.maxCostUsd === undefined) return null;
    return {
      forecastEvidence: options.forecastEvidence,
      lowUsd: 0,
      expectedUsd: options.maxCostUsd,
      highUsd: options.maxCostUsd,
      currency: "USD",
      source: "Explicit Higgsfield user planning bound (unknown price)",
      asOf: new Date().toISOString(),
      confidence: "user-bound",
      bounded: true,
      providerEnforced: false,
      model: options.model,
      notes: ["Unknown Higgsfield price; reconcile billing."],
    };
  }
  const isGeneratedSeconds = (id: string) => {
    return [findModel(id)?.pricing, falPriceFor(id)?.pricing].some(
      (pricing) => pricing?.kind === "fixed" && pricing.quantity === "generated-second" && !pricing.falUnit,
    );
  }; // page-derived seconds are planning-only
  if (
    options.quoteInput?.provider !== "higgsfield" &&
    (isGeneratedSeconds(options.endpoint) || isGeneratedSeconds(options.model))
  ) {
    if (options.model !== options.endpoint || !["video", "audio"].includes(options.mediaKind))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Generated-second pricing requires the same exact model/media endpoint.",
      });
    const quantities = options.quoteInput;
    const { durationSec: seconds, sampleCount } = resolveFalQuantities(options.endpoint, options.input);
    if (sampleCount === null ? quantities?.units !== null : (quantities?.multiplier ?? 1) !== sampleCount)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message:
          "Generated-second multiplier must match the endpoint sample count; unknown counts require an unbounded quote.",
      });
    if (
      quantities?.durationSec !== undefined &&
      (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 || quantities.durationSec !== seconds)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Quoted generated seconds must match the explicit positive provider input duration.",
      });
    if (
      quantities?.units !== undefined &&
      quantities.units !== null &&
      (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0 || quantities.units !== seconds)
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Generated-second units must match the explicit provider input duration.",
      });
  }
  const estimate = quote({ ...options.quoteInput, model: options.model });
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
    if (options.quoteInput?.provider === "higgsfield" && !pricingEvidence)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Higgsfield bounded pricing requires trusted evidence.",
      });
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
    // Drift is planning-only report data, never part of a frozen operation quote.
    const published = { ...estimate };
    delete published.priceDrift;
    return {
      ...published,
      ...(pricingEvidence ? { pricingEvidence } : {}),
      providerEnforced: false,
      forecastEvidence: options.forecastEvidence,
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
    forecastEvidence: options.forecastEvidence,
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
/**
 * Dry-run only: the most the project's budget would admit for a new production job now (`maxAdmissibleUsd`),
 * from its store or its brief's first policy; omitted without a readable project. Writes nothing.
 */
function previewAdmissible(projectId: string | undefined): { maxAdmissibleUsd?: number | null } {
  if (!projectId) return {};
  try {
    if (!existsSync(projectDir(projectId))) return {};
    return { maxAdmissibleUsd: projectMaxAdmissibleUsd(new OperationStore(projectId), projectId) };
  } catch {
    return {};
  }
}
/**
 * Dry-run only: known page/API price drift for this request (`priceDrift`: both per-unit rates and the higher one
 * planning used). Report data; admission still follows priceFor (planning-only prices need --max-cost-usd).
 */
function previewDrift(options: ExecutionOptions): { priceDrift?: PagePriceDrift } {
  if (options.providerId === "higgsfield" || options.quoteInput?.provider === "higgsfield") return {};
  try {
    const drift = quote({ ...options.quoteInput, model: options.model }).priceDrift;
    return drift ? { priceDrift: drift } : {};
  } catch {
    return {};
  }
}
const MEDIA_KINDS = new Set<OutputKind>(["image", "video", "audio"]);
/** The fields older image/video/audio results used; kept first so existing operations publish the same files. */
function legacyMediaUrls(result: Record<string, unknown>, kind: OutputKind): string[] {
  const rows = kind === "image" ? (result.images ?? [result.image ?? result.output]) : [result[kind] ?? result.output];
  const parsed = Array.isArray(rows)
    ? rows.flatMap((row) =>
        row && typeof row === "object" && typeof (row as { url?: unknown }).url === "string"
          ? [(row as { url: string }).url]
          : [],
      )
    : [];
  const fallback = result[`${kind}_url`] ?? result.url;
  return parsed.length ? parsed : typeof fallback === "string" ? [fallback] : [];
}
const unique = (files: ExtractedFile[]) =>
  files.filter((file, index) => files.findIndex((other) => other.url === file.url) === index);
/** The source URLs to download for a media or file kind; every result URL has already passed the trusted-host check. */
function sourcesFor(
  result: Record<string, unknown>,
  extracted: ExtractedArtifacts,
  kind: OutputKind,
  output: string,
  provider: string,
): string[] {
  let found: string[];
  if (MEDIA_KINDS.has(kind)) {
    const legacy = legacyMediaUrls(result, kind);
    found =
      provider !== "higgsfield" && legacy.length
        ? legacy
        : unique(extracted.files.filter((file) => file.kind === kind)).map((file) => file.url);
  } else {
    const candidates = unique(extracted.files.filter((file) => file.kind === kind));
    const extension = path.extname(output).toLowerCase();
    const matching = extension ? candidates.filter((file) => artifactExtension(file) === extension) : [];
    found = (matching.length ? matching : candidates).map((file) => file.url);
  }
  if (!found.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: MEDIA_KINDS.has(kind)
        ? "Generation result contains no media URLs."
        : `Generation result contains no ${kind} files.`,
    });
  for (const value of found) {
    try {
      trustedArtifactUrl(value, provider);
    } catch {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Result URL must use a trusted provider media HTTPS host.",
      });
    }
  }
  return found;
}
/** Checks a downloaded non-media file by kind; returns whether the asset registry can inspect and import it. */
function validateFileKind(file: string, kind: OutputKind): boolean {
  const extension = path.extname(file).toLowerCase();
  if (kind === "model3d") {
    if (extension !== ".glb" && extension !== ".gltf") return false;
    const inspected = inspectAsset(file, { nonMedia: true });
    if (inspected.kind !== "model3d")
      throw new CliErrorObject({ code: "VALIDATION", message: `Expected model3d, received ${inspected.kind}` });
    return true;
  }
  if (kind === "weights" && extension === ".safetensors") {
    try {
      validateSafeTensors(readFileSync(file));
    } catch (error) {
      throw new CliErrorObject({ code: "VALIDATION", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return false;
}
/** text/json results: an immutable manifest of the result's fields and file list, no download. */
function publishResultManifest(
  projectId: string,
  options: ExecutionOptions,
  extracted: ExtractedArtifacts,
  job: GenerationJob,
): Record<string, unknown> {
  if (!Object.keys(extracted.data).length && !extracted.files.length)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: `Generation result contains no ${options.mediaKind} fields.`,
    });
  const manifest = {
    version: 1,
    kind: options.mediaKind,
    provider: job.provider,
    endpoint: job.endpoint,
    model: options.model,
    operationId: job.operationId,
    providerRequestId: job.providerRequestId ?? null,
    inputHash: job.inputHash,
    data: extracted.data,
    files: extracted.files.filter((entry) => entry.trusted).map(({ trusted: _trusted, ...entry }) => entry),
    untrustedUrls: extracted.untrustedUrls,
  };
  const file = path.resolve(pipelineDir(projectId), "model-results", `${job.operationId}.json`);
  assertPathWithin(path.resolve(projectDir(projectId)), file);
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    immutableWrite(file, bytes);
  } catch (error) {
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: `Result manifest exists with different content: ${path.relative(process.cwd(), file)} (${error instanceof Error ? error.message : String(error)})`,
    });
  }
  return {
    outputs: [path.relative(process.cwd(), file)],
    hashes: [digest(bytes)],
    assetIds: [],
    ...(job.provider === "higgsfield" && job.result?.expires_at !== undefined
      ? { expires_at: job.result.expires_at }
      : {}),
  };
}
async function download(url: string, request: typeof fetch): Promise<Buffer> {
  const response = await request(url, { redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!response.ok || !response.body)
    throw new CliErrorObject({ code: "NETWORK", message: `Media download failed: HTTP ${response.status}` });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > 512 * 1024 * 1024)
        throw new CliErrorObject({ code: "VALIDATION", message: "Download exceeds 512 MiB limit." });
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  }
  if (!bytes) throw new CliErrorObject({ code: "VALIDATION", message: "Downloaded media is empty." });
  return Buffer.concat(chunks);
}
function outputPaths(output: string, count: number): string[] {
  const parsed = path.parse(output);
  return Array.from({ length: count }, (_, index) =>
    index === 0 ? output : path.join(parsed.dir, `${parsed.name}-${index + 1}${parsed.ext}`),
  );
}
/** One queue/status/publication step. Reinvoke with the same arguments to resume. */
export async function executeFalOperation(
  options: ExecutionOptions,
): Promise<{ outputs: string[]; metadata: Record<string, unknown> }> {
  validateBound(options);
  const requestedProvider = options.providerId === "higgsfield" ? "higgsfield" : "fal.ai";
  if (options.forecastEvidence) validateVideoForecastEvidence(options.forecastEvidence);
  const output = path.resolve(options.output);
  const { inputHash, operationId, existing } = resolveOperationIdentity({
    input: options.input,
    projectId: options.projectId,
    operationId: options.operationId,
    endpoint: options.endpoint,
    provider: requestedProvider,
    assetId: options.assetId ?? output,
    id: (hash) =>
      `${options.providerId ?? "fal"}:${createHash("sha256").update(`${options.endpoint}:${hash}:${output}`).digest("hex").slice(0, 40)}`,
  });
  if (
    options.forecastEvidence &&
    (options.forecastEvidence.forecast.endpoint !== options.endpoint ||
      options.model !== options.endpoint ||
      options.forecastEvidence.forecast.inputSha256 !== inputHash)
  )
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Forecast endpoint/provider-input pins differ from the execution request.",
    });
  const quantities = options.quoteInput;
  if (options.forecastEvidence && quantities && (quantities.width !== undefined || quantities.height !== undefined)) {
    const forecast = options.forecastEvidence.forecast;
    const referencedSeconds = forecast.videoReferences.reduce((sum, reference) => sum + reference.durationSec, 0);
    if (
      options.input.draft === true ||
      options.input.task === "editing" ||
      options.input.duration === "auto" ||
      Number(options.input.duration) !== forecast.output.durationSec ||
      options.input.resolution !== forecast.output.resolution
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Operation is not eligible for supplied fixed-duration quote quantities.",
      });
    if (
      quantities.width !== forecast.output.width ||
      quantities.height !== forecast.output.height ||
      quantities.durationSec !== forecast.output.durationSec ||
      quantities.resolution !== forecast.output.resolution ||
      (quantities.inputVideoDurationSec ?? 0) !== referencedSeconds ||
      (quantities.units ?? 1) !== 1 ||
      (quantities.multiplier ?? 1) !== 1
    )
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Quote quantities differ from the pinned video forecast.",
      });
  }
  // RFC 0003 D8 for every fal paid submission: reference inputs on a profiled endpoint without a pack warn on stderr
  // (default) or are refused under AGENTBROS_REFERENCE_PACKS=enforce. Genjutsu preparations (validateBound) and
  // submitted jobs keep their own identity.
  if (!options.referencePack && !options.referencePackGated && !options.modelPreparation && !jobSubmitted(existing)) {
    const warning = noPackWarning({
      provider: options.providerId ?? "fal",
      endpoint: options.endpoint,
      input: options.input,
    });
    if (warning) emitProgress(warning);
  }
  const packWarnings: string[] = [];
  // Resolved from the process's current directory, not the project: callers pass public/projects/<id>/... from the repository root.
  let modelPreparation = options.modelPreparation;
  let referencePack = options.referencePack;
  let remoteMedia = options.remoteMedia ?? existing?.publication?.remoteMedia;
  if (remoteMedia?.length && (existing?.provider ?? requestedProvider) !== "higgsfield")
    throw new CliErrorObject({ code: "VALIDATION", message: "Remote media bindings are Higgsfield-only." });
  let referenceAssetIds = [...new Set(options.referenceAssetIds ?? [])].sort();
  const publication = {
    output,
    kind: options.mediaKind,
    model: options.model,
    referenceAssetIds,
    ...(modelPreparation ? { modelPreparation } : {}),
    ...(referencePack ? { referencePack } : {}),
    ...(remoteMedia?.length ? { remoteMedia } : {}),
  };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(operationId))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid operation ID." });
  const preview = () => {
    const quoted = existing?.quote ?? priceFor(options);
    const preparation = genjutsuMode(options.endpoint, options.providerId ?? "fal")
      ? preparationAdmission(options.projectId, modelPreparation, options.endpoint, options.input)
      : undefined;
    const previewRemote = remoteMedia ?? preparation?.remoteMedia;
    if (previewRemote?.length) {
      if (!options.projectId)
        throw new CliErrorObject({ code: "INVALID_INPUT", message: "Remote media requires --project." });
      remoteMediaAssetIds(options.projectId, previewRemote, options.input);
    }
    return {
      outputs: [],
      metadata: {
        dryRun: true,
        operationId,
        endpoint: options.endpoint,
        input: options.input,
        provider: options.providerId ?? "fal",
        quote: quoted,
        pricing: quoted ? "bounded" : "unknown",
        validation: { valid: true },
        ...(preparation ? { preparation } : {}),
        ...(previewRemote?.length
          ? { remoteMedia: { bindings: previewRemote, recheckBeforeSubmit: true, providerFetchVerified: false } }
          : {}),
        ...(quoted ? {} : { nextAction: "Unknown price requires an explicit --max-cost-usd planning bound." }),
        ...previewAdmissible(options.projectId),
        ...(existing ? {} : previewDrift(options)),
        executable: quoted !== null && (!preparation || preparation.ready),
        output: options.output,
      },
    };
  };
  if (options.dryRun && !existing) return preview();
  if (!options.projectId)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Paid generation requires --project for durable budget tracking.",
    });
  requireProject(options.projectId);
  const projectId = options.projectId;
  const store = new OperationStore(projectId);
  if (existing?.publication?.modelPreparation) {
    const saved = existing.publication.modelPreparation;
    if (modelPreparation && generationInputHash(modelPreparation) !== generationInputHash(saved))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Preparation binding differs from the original durable job.",
      });
    modelPreparation = saved;
    publication.modelPreparation = saved;
  }
  // A resumed job keeps the pack it was submitted with; a historical job without one keeps its identity.
  if (existing) {
    const saved = existing.publication?.referencePack;
    if (referencePack && saved && generationInputHash(referencePack) !== generationInputHash(saved))
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Reference pack binding differs from the original durable job.",
      });
    referencePack = saved;
    if (saved) publication.referencePack = saved;
    else delete publication.referencePack;
  }
  if (
    genjutsuMode(
      options.endpoint,
      existing?.provider === "higgsfield" ? "higgsfield" : (options.providerId ?? "fal"),
    ) &&
    (!existing || modelPreparation)
  ) {
    const admission = preparationAdmission(projectId, modelPreparation, options.endpoint, options.input);
    if (!admission.ready)
      throw new CliErrorObject({
        code: "STAGE_INCOMPLETE",
        message: admission.blockers.join(" "),
        details: { nextAction: "pnpm model:prepare --project PROJECT --action check --id PREPARATION" },
      });
    referenceAssetIds = admission.referenceAssetIds!;
    publication.referenceAssetIds = referenceAssetIds;
    if (admission.remoteMedia?.length) {
      if (
        remoteMedia &&
        generationInputHash({ remoteMedia }) !== generationInputHash({ remoteMedia: admission.remoteMedia })
      )
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Remote media differs from the approved preparation.",
        });
      remoteMedia = admission.remoteMedia;
      publication.remoteMedia = remoteMedia;
    }
  }
  if (remoteMedia?.length) {
    referenceAssetIds = [
      ...new Set([...referenceAssetIds, ...remoteMediaAssetIds(projectId, remoteMedia, options.input)]),
    ].sort();
    publication.referenceAssetIds = referenceAssetIds;
  }
  if (existing) {
    if (existing.quote.forecastEvidence) {
      const saved = validateVideoForecastEvidence(existing.quote.forecastEvidence);
      if (saved.forecast.endpoint !== existing.endpoint || saved.forecast.inputSha256 !== existing.inputHash)
        throw new CliErrorObject({
          code: "VALIDATION",
          message: "Stored forecast endpoint/provider-input pins differ from the original job.",
        });
    }
    if (options.forecastEvidence && options.forecastEvidence.sha256 !== existing.quote.forecastEvidence?.sha256)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Forecast digest differs from the original operation; use a new operation ID for a new forecast.",
      });
    // Do not consult today's tariff before validating a frozen operation. Store
    // identity is checked again atomically by the runner before any provider call.
    const expectedIdentity = {
      provider: options.providerId === undefined ? existing.provider : requestedProvider,
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
    if (generationInputHash(originalIdentity) !== generationInputHash(expectedIdentity)) {
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Operation ID is already bound to different inputs or publication identity.",
      });
    }
    const canRecover =
      existing.requestBody !== undefined &&
      (options.provider ? options.provider.idempotentSubmit : existing.provider === "higgsfield");
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
  if (options.dryRun) return preview();
  const quoted = existing?.quote ?? priceFor(options);
  if (!quoted && !existing)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Unknown price requires an explicit --max-cost-usd planning bound.",
    });
  if (existsSync(options.output) && !options.force && !existing)
    throw new CliErrorObject({
      code: "FILE_EXISTS",
      message: "Output exists; use --force or resume its original operation.",
    });
  const remoteMaySubmit =
    !existing ||
    (!existing.providerRequestId &&
      !existing.release &&
      !existing.receipt &&
      (existing.state === "reserved" ||
        ((options.provider?.idempotentSubmit ?? existing.provider === "higgsfield") &&
          existing.requestBody !== undefined &&
          ["submitting", "unknown"].includes(existing.state))));
  if (remoteMedia?.length && remoteMaySubmit)
    await verifyRemoteMedia(projectId, remoteMedia, process.cwd(), options.remoteMediaIo);
  ensureProjectPolicy(store, projectId);
  // Only after validation and budget preparation may production instantiate transport.
  const queueRoute =
    options.queuePath === undefined ? undefined : validQueueRoute(options.queuePath.replace(/^\//, ""));
  if (options.queuePath !== undefined && !queueRoute)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "queuePath must be an OpenAPI submit path such as fal-ai/meshy/v7/image-to-3d.",
    });
  const providerId = existing?.provider ?? requestedProvider;
  const provider =
    options.provider ??
    (providerId === "higgsfield"
      ? createHiggsfieldJobProvider(
          createHiggsfieldClient({ credentials: requireEnv("HIGGSFIELD_API_KEY"), fetch: options.fetch }),
          {
            projectId,
            expectedBody: existing?.requestBody ?? existing?.quotedRequestBody ?? options.higgsfieldEstimateBody,
          },
        )
      : createFalJobProvider(createFalRestQueue({ credentials: requireEnv("FAL_KEY"), fetch: options.fetch })));
  const preparedInputHash =
    existing?.preparedInputHash ??
    (options.higgsfieldEstimateBody === undefined
      ? undefined
      : createHash("sha256").update(options.higgsfieldEstimateBody).digest("hex"));
  const job = await runGenerationStep({
    store,
    input: options.input,
    operation: {
      operationId,
      provider: providerId,
      endpoint: options.endpoint,
      assetId: options.assetId ?? output,
      stage: options.stage ?? "assets",
      quote: existing?.quote ?? quoted!,
      publication,
      ...(preparedInputHash ? { preparedInputHash } : {}),
      quotedRequestBody: existing ? existing.quotedRequestBody : options.higgsfieldEstimateBody,
    },
    provider,
    ...(queueRoute ? { queueRoute } : {}),
    publish: async (result, operation) => {
      options.validateResult?.(result);
      const extracted = extractArtifacts(
        options.resultSchema ?? (providerId === "higgsfield" ? { schema: HIGGSFIELD_OUTPUT_SCHEMA } : undefined),
        result,
        providerId,
      );
      if (options.mediaKind === "text" || options.mediaKind === "json")
        return publishResultManifest(projectId, options, extracted, operation);
      const sources = sourcesFor(result, extracted, options.mediaKind, output, providerId);
      const outputs = outputPaths(output, sources.length);
      const hashes: string[] = [];
      const assetIds: string[] = [];
      for (const [index, target] of outputs.entries()) {
        const cacheRoot = path.resolve("public/projects", projectId, "pipeline/downloads");
        const cache = path.join(
          cacheRoot,
          `${createHash("sha256").update(operation.operationId).digest("hex")}-${index}${path.extname(target) || ".bin"}`,
        );
        assertPathWithin(path.resolve("public/projects", projectId), cache);
        mkdirSync(path.dirname(cache), { recursive: true });
        if (!existsSync(cache)) {
          const buffer = await download(sources[index]!, options.fetch ?? fetch);
          const tmp = `${cache}.${randomUUID()}.tmp`;
          try {
            writeFileSync(tmp, buffer, { flag: "wx" });
            renameSync(tmp, cache);
          } finally {
            if (existsSync(tmp)) unlinkSync(tmp);
          }
        }
        let importable = MEDIA_KINDS.has(options.mediaKind);
        try {
          if (importable) {
            const inspected = inspectAsset(cache);
            if (inspected.kind !== options.mediaKind)
              throw new CliErrorObject({
                code: "VALIDATION",
                message: `Expected ${options.mediaKind}, received ${inspected.kind}`,
              });
          } else importable = validateFileKind(cache, options.mediaKind);
        } catch (error) {
          unlinkSync(cache);
          throw error;
        }
        if (existsSync(target) && !options.force && hashFile(target) !== hashFile(cache))
          throw new CliErrorObject({
            code: "FILE_EXISTS",
            message: `Output exists with different media: ${target}. Use --force explicitly.`,
          });
        const imported = importable
          ? importAsset({
              nonMedia: !MEDIA_KINDS.has(options.mediaKind),
              projectId,
              sourceFile: cache,
              provenance: {
                origin: "provider",
                referenceAssetIds,
                tool: providerId,
                model: options.model,
                prompt: typeof options.input.prompt === "string" ? options.input.prompt : undefined,
                generationJobId: operation.operationId,
                ...(modelPreparation ? { modelPreparation } : {}),
                billing: { status: "unknown" },
              },
            })
          : undefined;
        if (
          modelPreparation &&
          generationInputHash(imported?.asset.provenance.modelPreparation ?? {}) !==
            generationInputHash(modelPreparation)
        )
          throw new CliErrorObject({
            code: "VALIDATION",
            message:
              "Identical result bytes already have different preparation provenance; reconcile the existing original.",
          });
        mkdirSync(path.dirname(target), { recursive: true });
        const temporary = `${target}.${randomUUID()}.tmp`;
        try {
          writeFileSync(temporary, readFileSync(cache), { flag: "wx" });
          renameSync(temporary, target);
        } finally {
          if (existsSync(temporary)) unlinkSync(temporary);
        }
        hashes.push(hashFile(target));
        if (imported) assetIds.push(imported.asset.id);
        if (modelPreparation && imported)
          recordPreparationResult(projectId, modelPreparation, operation.operationId, target, imported.asset.id);
        // Best-effort: the output is written and paid for; a pack changed or deleted since submit only warns.
        if (referencePack && imported)
          try {
            recordPackOutput(projectId, referencePack, operation.operationId, target, imported.asset.id);
          } catch (error) {
            const warning = `Output ${path.relative(process.cwd(), target)} was not recorded in pack ${referencePack.id}'s outputs.json: ${error instanceof Error ? error.message : String(error)}`;
            packWarnings.push(warning);
            emitProgress(warning);
          }
      }
      return {
        outputs: outputs.map((file) => path.relative(process.cwd(), file)),
        hashes,
        assetIds,
        ...(providerId === "higgsfield" && result.expires_at !== undefined ? { expires_at: result.expires_at } : {}),
        ...(extracted.untrustedUrls.length ? { untrustedUrls: extracted.untrustedUrls } : {}),
      };
    },
  });
  const published = job.result?.published as { outputs?: string[]; hashes?: string[]; assetIds?: string[] } | undefined;
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
      ...(job.error ? { error: job.error } : {}),
      budget: store.summary(),
      assetIds: published?.assetIds ?? [],
      ...(packWarnings.length ? { warnings: packWarnings } : {}),
      nextAction:
        job.state === "published"
          ? "reconcile-billing"
          : job.error?.includes("Idempotency-Key body mismatch") ||
              (job.state === "unknown" && providerId !== "higgsfield")
            ? "reconcile-provider-request"
            : "resume-same-operation",
    },
  };
}
