/**
 * fal-backed derivative steps (RFC 0003 §6.4, D7, WP5b): depth-video, pose-video, mask-video and audio-clean.
 * The request is built and quoted with the same library functions `generate:model` uses, and runs only through
 * the durable job runner (`executeFalOperation`), with budget admission, a stable operation id and resumable
 * publication. Nothing here calls a provider directly.
 */
import path from "node:path";
import { CliErrorObject } from "../../cli";
import { resolveImportedReferences } from "../../assets/provider-references";
import { existsSync } from "node:fs";
import { executeFalOperation } from "../../jobs/execution";
import { OperationStore } from "../../jobs/store";
import type { JobProvider } from "../../jobs/runner";
import { findCatalogEntry, readCachedApiModel } from "../../models/fal-catalog";
import { openApiRoutes } from "../../providers/fal-openapi";
import {
  FalOperationError,
  buildFalOperation,
  requireExecutableFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "../../providers/fal-operations";
import { quoteInputForPlan } from "../../providers/fal-quote-input";
import { FalEndpointRequestSchema, type FalEndpointRequest } from "../../../types/generation";
import type { AssetRecord } from "../../../types/assets";
import type { DerivationStep } from "../../../types/references";
import type { OutputKind } from "../../../types/fal-catalog";
import { BITEXACT, X264, type MediaKind, type MediaState } from "./ops";
import { DERIVATIVES_DIR, derivativeDigest } from "./storage";

export type FalStep = Extract<
  DerivationStep,
  { op: "depth-video" | "pose-video" | "mask-video" | "audio-clean"; engine: "fal" | "local" | "matte-onnx" }
>;

/**
 * Default endpoints, all in the tracked catalogue (src/lib/models/fal-catalog). audio-clean follows the
 * `clean-speech` use case's `audio.denoise` slot (model-use-cases.json, model-slots.json). mask-video takes
 * SAM 3 on video and EVF-SAM on a still.
 */
export const FAL_DEFAULT_ENDPOINTS = {
  "depth-video": "fal-ai/depth-anything-video",
  "pose-video": "fal-ai/dwpose/video",
  "mask-video": { video: "fal-ai/sam-3/video", image: "fal-ai/evf-sam" },
  "audio-clean": "fal-ai/deepfilternet3",
} as const;

/** Fixed, non-default provider inputs per default endpoint; an overriding endpoint gets only its media field and prompt. */
const FIXED_INPUT: Record<string, Record<string, unknown>> = {
  "fal-ai/depth-anything-video": { colormap: "grayscale" },
  "fal-ai/evf-sam": { mask_only: true },
  "fal-ai/deepfilternet3": { audio_format: "wav" },
};

export const isFalStep = (step: DerivationStep): step is FalStep => "engine" in step && step.engine === "fal";

const invalid = (message: string): never => {
  throw new CliErrorObject({ code: "INVALID_INPUT", message });
};

/** The operation id of a derivative's fal step: stable, so the same command resumes rather than resubmits. */
export const falOperationId = (derivativeId: string, index: number): string =>
  `refs-derive.${derivativeId}.step-${String(index + 1).padStart(2, "0")}`;

/** The durable job's stage and asset identity; generate:model needs the same --stage and --asset-id to address it. */
export const FAL_STAGE = "references";
export const falAssetId = (operationId: string): string => `refs-derive:${operationId}`;

/** Project-relative path of the published fal result: fixed, because publication intent is pinned to it. */
export const falOutputName = (index: number, kind: MediaKind): string =>
  `fal-step-${String(index + 1).padStart(2, "0")}.${kind === "image" ? "png" : kind === "video" ? "mp4" : "wav"}`;

/** What the step publishes; never inferred from the endpoint's output kinds (SAM lists image and video). */
export const falOutputKind = (step: FalStep, input: MediaState): Extract<OutputKind, "image" | "video" | "audio"> =>
  step.op === "audio-clean" ? "audio" : step.op === "mask-video" && input.kind === "image" ? "image" : "video";

/** The catalogued endpoint for a step: an explicit `endpoint` must exist in the tracked catalogue. */
export function falEndpointFor(step: FalStep, input: MediaState): string {
  const fallback = FAL_DEFAULT_ENDPOINTS[step.op];
  const endpoint =
    ("endpoint" in step && step.endpoint) ||
    (typeof fallback === "string" ? fallback : fallback[input.kind === "image" ? "image" : "video"]);
  const entry = findCatalogEntry(endpoint);
  if (!entry)
    invalid(`${step.op}: ${endpoint} is not in the tracked fal catalogue; pick a catalogued endpoint (pnpm fal:find).`);
  if (entry!.status !== "active") invalid(`${step.op}: ${endpoint} is ${entry!.status} in the catalogue.`);
  const kind = falOutputKind(step, input);
  if (!entry!.outputs.kinds.includes(kind))
    invalid(`${step.op}: ${endpoint} returns ${entry!.outputs.kinds.join(", ")}, not ${kind}.`);
  return endpoint;
}

/** The provider input field that takes the step's media: the required catalogue input of that media kind. */
function mediaField(endpoint: string, kind: MediaKind): string {
  const entry = findCatalogEntry(endpoint)!;
  const field =
    entry.inputs.find((input) => input.required && input.media === kind) ??
    entry.inputs.find((input) => input.media === kind && /_url$/.test(input.name));
  if (!field) return invalid(`${endpoint} takes no ${kind} input.`);
  return field.name;
}

/**
 * The generation request `generate:model --request` accepts: the input asset as `asset://sha256/<hash>`, so the
 * same bytes are inlined and pinned by the operation's input hash.
 */
export function falRequest(step: FalStep, input: MediaState, asset: AssetRecord): FalEndpointRequest {
  const endpoint = falEndpointFor(step, input);
  const entry = findCatalogEntry(endpoint)!;
  const fixed = "endpoint" in step && step.endpoint ? {} : (FIXED_INPUT[endpoint] ?? {});
  const prompt =
    step.op === "mask-video" && step.prompt
      ? entry.inputs.some((field) => field.name === "prompt")
        ? { prompt: step.prompt }
        : invalid(`${endpoint} has no prompt input.`)
      : {};
  return FalEndpointRequestSchema.parse({
    endpoint,
    input: { [mediaField(endpoint, input.kind)]: `asset://sha256/${asset.hash}`, ...fixed, ...prompt },
  });
}

export type FalCallOptions = {
  /** The user approved this spend; agents pass it only after the user's yes. */
  confirmSpend?: boolean;
  /** User planning bound for an unknown price; it does not cap provider billing. */
  maxCostUsd?: number;
  /** Test seams: a fake transport and fetch. Production builds the REST queue from FAL_KEY. */
  provider?: JobProvider;
  fetch?: typeof fetch;
};

export type FalStepPlan = {
  index: number;
  op: FalStep["op"];
  endpoint: string;
  request: FalEndpointRequest;
  requestSha256: string;
  operationId: string;
  /** Repository-relative output the durable job publishes to. */
  output: string;
  mediaKind: "image" | "video" | "audio";
  schema: "cached" | "not-cached";
  pricing: "bounded" | "unknown";
  quote: unknown;
  maxAdmissibleUsd?: number | null;
  /** True when the quote is bounded (or a positive bound was given) and the schema validates the request offline. */
  executable: boolean;
  /** Existing durable job state for this operation, when one exists. */
  job: string | null;
  nextAction?: string;
  /** The same job checked through the generate:model CLI (offline); request.json exists once run has submitted. */
  generateModel: string;
};

type Prepared = {
  plan: ReturnType<typeof buildFalOperation>;
  resolved: ReturnType<typeof resolveImportedReferences>;
  queuePath?: string;
  resultSchema: { schema: unknown; components: unknown };
};

/** Same order as generate:model: resolve imported references, validate against the pinned schema, routes, quote input. */
function prepare(request: FalEndpointRequest, projectId: string, rootDir: string): Prepared {
  const resolved = resolveImportedReferences(request, projectId, rootDir);
  const plan = buildFalOperation(resolved.request);
  const snapshot = resolveFalSnapshotForPlan(plan);
  const entry = findCatalogEntry(plan.endpoint);
  const apiModel = entry?.schema ? readCachedApiModel(entry.schema.sha256) : undefined;
  const queuePath = apiModel ? openApiRoutes(apiModel)?.submitPath.replace(/^\//, "") : undefined;
  return { plan, resolved, queuePath, resultSchema: { schema: snapshot.output, components: snapshot.schemas } };
}

const falError = (error: unknown): never => {
  if (error instanceof FalOperationError)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: error.message,
      details: { providerCode: error.code },
    });
  throw error;
};

function assertCwd(rootDir: string): void {
  if (path.resolve(rootDir) !== process.cwd())
    invalid(
      "fal steps run from the repository root: the durable job store and budget resolve from the working directory.",
    );
}

/** Relative to the working directory (the repository root), as executeFalOperation resolves outputs. */
const relativeOutput = (projectId: string, derivativeId: string, name: string) =>
  path.join("public/projects", projectId, DERIVATIVES_DIR, derivativeId, name);

/** Dry run: the validated request, quote and admission preview, offline and without writes. */
export async function planFalStep(
  projectId: string,
  derivativeId: string,
  index: number,
  step: FalStep,
  input: MediaState,
  asset: AssetRecord,
  rootDir: string,
  options: FalCallOptions = {},
): Promise<FalStepPlan> {
  assertCwd(rootDir);
  const request = falRequest(step, input, asset);
  const mediaKind = falOutputKind(step, input);
  const operationId = falOperationId(derivativeId, index);
  const output = relativeOutput(projectId, derivativeId, falOutputName(index, mediaKind));
  const base = {
    index,
    op: step.op,
    endpoint: request.endpoint,
    request,
    requestSha256: derivativeDigest(request),
    operationId,
    output,
    mediaKind,
    generateModel: `pnpm generate:model --request ${path.join(path.dirname(output), "request.json")} --output ${output} --project ${projectId} --operation-id ${operationId} --asset-id ${falAssetId(operationId)} --stage ${FAL_STAGE} --dry-run`,
  };
  let prepared: Prepared;
  try {
    prepared = prepare(request, projectId, rootDir);
  } catch (error) {
    if (error instanceof FalOperationError && error.code === "SCHEMA_NOT_CACHED")
      return {
        ...base,
        schema: "not-cached",
        pricing: "unknown",
        quote: null,
        executable: false,
        job: null,
        nextAction: `pnpm fal:sync --schemas ${request.endpoint}`,
      };
    return falError(error);
  }
  const preview = await executeFalOperation(
    executionOptions(projectId, prepared, output, operationId, mediaKind, options, true),
  );
  const metadata = preview.metadata as Record<string, unknown>;
  const pricing = metadata.pricing === "bounded" || (metadata.quote && !metadata.pricing) ? "bounded" : "unknown";
  return {
    ...base,
    schema: "cached",
    pricing,
    quote: metadata.quote ?? null,
    ...(metadata.maxAdmissibleUsd !== undefined
      ? { maxAdmissibleUsd: metadata.maxAdmissibleUsd as number | null }
      : {}),
    executable: prepared.plan.executable && metadata.quote !== null && metadata.quote !== undefined,
    job: jobState(projectId, operationId),
    ...(pricing === "unknown" && options.maxCostUsd === undefined
      ? { nextAction: "Unknown price: run needs an explicit --max-cost-usd planning bound the user authorised." }
      : {}),
  };
}

/** The durable job's state for this operation, read without creating the store. */
function jobState(projectId: string, operationId: string): string | null {
  const store = new OperationStore(projectId);
  return existsSync(store.file) ? (store.snapshot().jobs[operationId]?.state ?? null) : null;
}

function executionOptions(
  projectId: string,
  prepared: Prepared,
  output: string,
  operationId: string,
  mediaKind: FalStepPlan["mediaKind"],
  options: FalCallOptions,
  dryRun: boolean,
): Parameters<typeof executeFalOperation>[0] {
  const { plan, resolved } = prepared;
  return {
    providerId: "fal",
    projectId,
    endpoint: plan.endpoint,
    model: plan.endpoint,
    input: plan.input,
    output,
    mediaKind,
    resultSchema: prepared.resultSchema as never,
    queuePath: prepared.queuePath,
    referenceAssetIds: resolved.referenceAssetIds,
    operationId,
    maxCostUsd: options.maxCostUsd,
    dryRun,
    stage: FAL_STAGE,
    assetId: falAssetId(operationId),
    quoteInput: quoteInputForPlan(plan, plan.input, resolved.request.context),
    validateResult: (result) => {
      validateFalOperationResult(plan.endpoint, result, "fal");
    },
    ...(options.provider ? { provider: options.provider } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
}

export type FalStepRun =
  | {
      published: true;
      state: "published";
      output: string;
      providerAssetId: string;
      operationId: string;
      costUsd: number | null;
    }
  | { published: false; state: string; operationId: string; error?: string; nextAction?: string };

/**
 * One resumable step of the durable job. Refuses without the user's spend confirmation, and with an unknown
 * price and no bound, before any write. Published results are imported by the job runner with origin "provider".
 */
export async function runFalStep(
  projectId: string,
  plan: FalStepPlan,
  asset: AssetRecord,
  input: MediaState,
  step: FalStep,
  rootDir: string,
  options: FalCallOptions,
): Promise<FalStepRun> {
  assertCwd(rootDir);
  let prepared: Prepared;
  try {
    prepared = prepare(falRequest(step, input, asset), projectId, rootDir);
    requireExecutableFalOperation(prepared.plan);
  } catch (error) {
    return falError(error);
  }
  const result = await executeFalOperation(
    executionOptions(projectId, prepared, plan.output, plan.operationId, plan.mediaKind, options, false),
  );
  const metadata = result.metadata as {
    state: string;
    assetIds?: string[];
    billing?: { actualUsd?: number } | null;
    error?: string;
    nextAction?: string;
  };
  if (metadata.state !== "published")
    return {
      published: false,
      state: metadata.state,
      operationId: plan.operationId,
      ...(metadata.error ? { error: metadata.error } : {}),
      ...(metadata.nextAction ? { nextAction: metadata.nextAction } : {}),
    };
  const providerAssetId = metadata.assetIds?.[0];
  if (!result.outputs[0] || !providerAssetId)
    throw new CliErrorObject({ code: "VALIDATION", message: `fal step ${plan.operationId} published no asset.` });
  return {
    published: true,
    state: "published",
    output: path.resolve(result.outputs[0]),
    providerAssetId,
    operationId: plan.operationId,
    costUsd: typeof metadata.billing?.actualUsd === "number" ? metadata.billing.actualUsd : null,
  };
}

/**
 * ffmpeg arguments that seal a fal result into the derivative's media: the input's size, frame rate and frame
 * count for video (control videos match their target exactly), PNG for a still, PCM WAV for audio. The bytes then
 * differ from the provider original, which the registry keeps with origin "provider".
 */
export function conformFalArgs(kind: MediaKind, target: MediaState, input: string, output: string): string[] {
  const src = ["-protocol_whitelist", "file", "-i", input];
  if (kind === "audio") return [...src, "-map", "0:a:0", "-vn", "-c:a", "pcm_s16le", ...BITEXACT, output];
  const size = `scale=${target.width}:${target.height}:flags=bicubic,setsar=1`;
  if (kind === "image")
    return [
      ...src,
      "-map",
      "0:v:0",
      "-vf",
      `${size},format=rgb24`,
      "-frames:v",
      "1",
      "-c:v",
      "png",
      ...BITEXACT,
      output,
    ];
  const filter = target.fps ? `${size},fps=fps=${target.fps}` : size;
  return [
    ...src,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    filter,
    ...(target.frameCount ? ["-frames:v", String(target.frameCount)] : []),
    ...X264,
    ...BITEXACT,
    output,
  ];
}
