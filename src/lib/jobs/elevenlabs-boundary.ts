import { createHash, randomUUID } from "node:crypto";
import { ensureProjectPolicy } from "./initial-policy";
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import { OperationStore } from "./store";
import { resolveOperationIdentity } from "./identity";
import { synchronousPaidRequest } from "./synchronous";
import { inspectAsset } from "../assets/inspect";
import { quote } from "../pricing";
import { CliErrorObject, requireProject } from "../cli";
import type { PriceQuote } from "./types";

export type AudioPaidContext = {
  projectId?: string;
  operationId?: string;
  assetId?: string;
  maxCostUsd?: number;
  /** Inject a configured store for embedding/tests; production CLIs infer it from projectId. */
  store?: OperationStore;
  /** Told the durable operation id before the request, so a cost-ledger row can name the job the store already counts. */
  onOperationId?: (operationId: string) => void;
};
export function inferAudioProject(file: string): string | undefined {
  const relative = path.relative(path.resolve("public/projects"), path.resolve(file));
  const [id, ...rest] = relative.split(path.sep);
  return rest.length && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id!) ? id : undefined;
}
/** Shared financial boundary for every ElevenLabs POST, independent of caller retries. */
export async function executeElevenLabsRequest(options: {
  endpoint: string;
  model: string;
  identity: Record<string, unknown>;
  anchor: string;
  units?: number;
  paid?: AudioPaidContext;
  perform: () => Promise<Response>;
}): Promise<Response> {
  const paid = options.paid ?? {};
  const projectId = paid.store?.projectId ?? paid.projectId ?? inferAudioProject(options.anchor);
  if (!projectId)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Paid audio requires --project or a project-local output/input path for durable budget tracking.",
    });
  if (!paid.store) requireProject(projectId);
  const store = paid.store ?? new OperationStore(projectId);
  ensureProjectPolicy(store, projectId);
  const identity = {
    ...options.identity,
    destination: path.resolve(options.anchor),
  };
  const { operationId, existing: previous } = resolveOperationIdentity({
    input: identity,
    store,
    operationId: paid.operationId,
    provider: "elevenlabs",
    endpoint: options.endpoint,
    assetId: paid.assetId ?? path.resolve(options.anchor),
    id: (hash) => `elevenlabs:${createHash("sha256").update(`${options.endpoint}:${hash}`).digest("hex").slice(0, 40)}`,
  });
  paid.onOperationId?.(operationId);
  const estimate = quote({ model: options.model, units: options.units });
  let bounded: PriceQuote | undefined = previous?.quote;
  if (paid.maxCostUsd !== undefined && (!Number.isFinite(paid.maxCostUsd) || paid.maxCostUsd <= 0))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Audio --max-cost-usd must be positive and finite.",
    });
  if (
    !bounded &&
    estimate.bounded &&
    estimate.highUsd !== null &&
    estimate.lowUsd !== null &&
    estimate.expectedUsd !== null
  ) {
    if (paid.maxCostUsd !== undefined && estimate.highUsd > paid.maxCostUsd)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Audio quote exceeds explicit operation bound.",
      });
    bounded = {
      ...estimate,
      bounded: true,
      lowUsd: estimate.lowUsd,
      expectedUsd: estimate.expectedUsd,
      highUsd: estimate.highUsd,
      confidence: estimate.confidence === "unknown" ? "conservative-bound" : estimate.confidence,
      notes: estimate.notes ? [estimate.notes] : [],
    };
  }
  if (!bounded && paid.maxCostUsd !== undefined)
    bounded = {
      currency: "USD",
      lowUsd: 0,
      expectedUsd: paid.maxCostUsd,
      highUsd: paid.maxCostUsd,
      bounded: true,
      providerEnforced: false,
      confidence: "user-bound",
      source: "Explicit audio planning bound; not a provider billing cap",
      asOf: new Date().toISOString(),
      model: options.model,
    };
  if (!bounded)
    throw new CliErrorObject({
      code: "VALIDATION",
      message: "Unknown audio price requires --max-cost-usd; no POST submitted.",
    });
  return synchronousPaidRequest({
    store,
    identity,
    operation: {
      operationId,
      provider: "elevenlabs",
      endpoint: options.endpoint,
      assetId: paid.assetId ?? path.resolve(options.anchor),
      stage: "audio",
      quote: bounded,
    },
    perform: options.perform,
  });
}
export const audioFileIdentity = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** Validate and atomically publish actual provider audio; a bad body never overwrites an existing take. */
export function saveGeneratedAudio(output: string, bytes: Uint8Array): void {
  mkdirSync(path.dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
    const metadata = inspectAsset(temporary);
    if (metadata.kind !== "audio" || !metadata.media.hasAudio)
      throw new CliErrorObject({
        code: "VALIDATION",
        message: "Provider response does not contain valid generated audio.",
      });
    renameSync(temporary, output);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
