import snapshots from "./schemas/fal-operations.json";
import { hasLocalFalTransport } from "./transport-capabilities";
import { FalOperationError, fail, isObject } from "./fal-errors";
import { resolveSchema, validateJsonSchema, validateMediaConstraints, type JsonSchema } from "./json-schema-validate";
import { applyFalGuards, falGuardContext, type FalGuardInfo } from "./fal-guards/all";
import {
  findCatalogEntry,
  resolveCatalogSnapshot,
  findProviderEntry,
  resolveProviderSnapshot,
  SchemaNotCachedError,
} from "../models/fal-catalog";
import type { FalCatalogEntry, OutputKind, ProviderId } from "../../types/fal-catalog";
import {
  FalEndpointRequestSchema,
  FalOperationRequestSchema,
  type FalAnyRequest,
  type FalOperationPlan,
  type FalTransport,
} from "../../types/generation";

export { FalOperationError } from "./fal-errors";
export type { FalOperationErrorCode } from "./fal-errors";

type Snapshot = {
  family: string;
  variant: string;
  operation: string;
  endpoint: string;
  region: string;
  transport: FalTransport;
  schemaStatus: string;
  schemaSource: string;
  asOf: string;
  sha256: string;
  input: JsonSchema;
  output: JsonSchema;
  schemas: Record<string, JsonSchema>;
};
const adapters = snapshots as unknown as Snapshot[];

/** Category of a tracked snapshot that has no catalogue entry yet, by its legacy operation. */
const LEGACY_CATEGORY: Readonly<Record<string, string>> = Object.freeze({
  "text-to-image": "text-to-image",
  edit: "image-to-image",
  outpaint: "image-to-image",
  realtime: "text-to-image",
  "text-to-video": "text-to-video",
  "image-to-video": "image-to-video",
  "reference-to-video": "image-to-video",
  complete: "text-to-video",
  "motion-control": "video-to-video",
  "video-to-video/reference": "video-to-video",
  "video-to-video/edit": "video-to-video",
  train: "training",
  "train-edit": "training",
  "create-voice": "training",
});
function legacyOutputKinds(snapshot: Snapshot): OutputKind[] {
  if (snapshot.transport === "training") return ["weights"];
  if (snapshot.family === "kling-voice") return ["json"];
  return ["kling-v3", "kling-o3", "seedance-2.5"].includes(snapshot.family) ? ["video"] : ["image"];
}

/** The catalogue snapshot of a non-tracked endpoint, with errors mapped to FalOperationError. */
function catalogSnapshot(endpoint: string, entry: FalCatalogEntry, transport: FalTransport, region: string): Snapshot {
  let resolved;
  try {
    resolved = resolveCatalogSnapshot(endpoint);
  } catch (error) {
    if (error instanceof SchemaNotCachedError)
      throw new FalOperationError(
        "SCHEMA_NOT_CACHED",
        `No cached schema for ${endpoint}. Run: pnpm fal:sync --schemas ${endpoint}`,
      );
    throw new FalOperationError(
      "UNSUPPORTED_OPERATION",
      `${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!resolved)
    throw new FalOperationError("UNSUPPORTED_OPERATION", `${endpoint} has no request schema in the catalogue.`);
  return {
    family: "catalog",
    variant: "",
    operation: entry.category,
    endpoint,
    region,
    transport,
    schemaStatus: resolved.schemaStatus,
    schemaSource: resolved.schemaSource,
    asOf: resolved.asOf,
    sha256: resolved.sha256,
    input: resolved.input,
    output: resolved.output,
    schemas: resolved.schemas,
  };
}
/** Endpoint form: the tracked snapshot by exact endpoint, else the hash-pinned catalogue schema. */
function endpointSnapshot(
  endpoint: string,
  transport: FalTransport | undefined,
  region: string | undefined,
  provider: ProviderId = "fal",
): { snapshot: Snapshot; entry?: FalCatalogEntry } {
  if (provider === "higgsfield") {
    const entry = findProviderEntry(provider, endpoint);
    if (!entry || !["queue", "training"].includes(entry.transport))
      throw new FalOperationError("UNSUPPORTED_OPERATION", `${endpoint} has no Higgsfield queue/training adapter.`);
    if (entry.transport === "training" && endpoint !== "v1/custom-references")
      throw new FalOperationError("UNSUPPORTED_OPERATION", `${endpoint} has no Higgsfield training adapter.`);
    if (transport && transport !== entry.transport)
      throw new FalOperationError("UNSUPPORTED_OPERATION", `${endpoint} uses the ${entry.transport} transport.`);
    if (!entry.schema)
      return {
        entry,
        snapshot: {
          family: "catalog",
          variant: "",
          operation: entry.category,
          endpoint,
          region: region ?? "global",
          transport: entry.transport,
          schemaStatus: "unavailable",
          schemaSource: "Higgsfield catalogue: no documented schema",
          asOf: entry.lastSeen,
          sha256: "0".repeat(64),
          input: { type: "object", additionalProperties: true },
          output: { type: "object" },
          schemas: {},
        },
      };
    let resolved;
    try {
      resolved = resolveProviderSnapshot(provider, endpoint);
    } catch (error) {
      if (error instanceof SchemaNotCachedError)
        throw new FalOperationError("SCHEMA_NOT_CACHED", `No cached Higgsfield schema for ${endpoint}.`);
      throw error;
    }
    if (!resolved)
      throw new FalOperationError("UNSUPPORTED_OPERATION", `${endpoint} has no Higgsfield request schema.`);
    if (entry.transport === "training")
      resolved.output = {
        type: "object",
        required: ["id", "status"],
        properties: { id: { type: "string", minLength: 1 }, status: { const: "completed" } },
      };
    return {
      entry,
      snapshot: {
        ...resolved,
        family: "catalog",
        variant: "",
        operation: entry.category,
        endpoint,
        region: region ?? "global",
        transport: entry.transport,
      },
    };
  }
  const tracked = adapters.filter((entry) => entry.endpoint === endpoint);
  const entry = findCatalogEntry(endpoint);
  if (tracked.length) {
    const byTransport = tracked.filter((item) => !transport || item.transport === transport);
    if (!byTransport.length)
      throw new FalOperationError("UNSUPPORTED_OPERATION", `${endpoint} has no ${transport} transport.`);
    const snapshot = byTransport.find((item) => !region || item.region === region);
    if (!snapshot)
      throw new FalOperationError(
        "REGION_RESTRICTED",
        `Operation requires region ${byTransport.map((item) => item.region).join(", ")}.`,
      );
    if (snapshot.schemaStatus !== "verified")
      throw new FalOperationError("UNSUPPORTED_OPERATION", "No verified schema exists for the requested endpoint.");
    return { snapshot, entry };
  }
  if (!entry)
    throw new FalOperationError(
      "UNSUPPORTED_OPERATION",
      `${endpoint} is neither a tracked snapshot nor in the fal catalogue index (pnpm fal:sync --catalog).`,
    );
  if (!entry.schema || entry.transport === "realtime")
    throw new FalOperationError(
      "UNSUPPORTED_OPERATION",
      `${endpoint} has no queue request schema (${entry.transport}); it cannot be planned.`,
    );
  if (transport && transport !== entry.transport)
    throw new FalOperationError(
      "UNSUPPORTED_OPERATION",
      `${endpoint} uses the ${entry.transport} transport, not ${transport}.`,
    );
  return {
    snapshot: catalogSnapshot(endpoint, entry, entry.transport, region ?? entry.routing?.region ?? "global"),
    entry,
  };
}
function legacySnapshot(request: ReturnType<typeof FalOperationRequestSchema.parse>): {
  snapshot: Snapshot;
  variant: string;
  transport: FalTransport;
} {
  const variant =
    request.variant ??
    (["gpt-image-2.5", "gpt-image-2.6"].includes(request.family)
      ? "flare"
      : request.family === "flux-2"
        ? "dev"
        : request.family.startsWith("kling-") && request.family !== "kling-voice"
          ? "pro"
          : "default");
  const transport =
    request.transport ??
    (request.operation.startsWith("train") ? "training" : request.operation === "realtime" ? "realtime" : "queue");
  const candidates = adapters.filter(
    (entry) =>
      entry.family === request.family &&
      entry.variant === variant &&
      entry.operation === request.operation &&
      entry.transport === transport,
  );
  const snapshot = candidates.find((entry) => entry.region === request.region);
  if (!snapshot && candidates.length)
    throw new FalOperationError(
      "REGION_RESTRICTED",
      `Operation requires region ${candidates.map((entry) => entry.region).join(", ")}.`,
    );
  if (!snapshot || snapshot.schemaStatus !== "verified")
    throw new FalOperationError(
      "UNSUPPORTED_OPERATION",
      "No verified schema exists for the requested operation/variant/transport.",
    );
  return { snapshot, variant, transport };
}

export function listFalOperationAdapters() {
  return adapters.map(({ schemas, input, output, ...entry }) => ({
    ...entry,
    verification: { schema: true, localAdapter: hasLocalFalTransport(entry.endpoint, entry.transport), live: false },
    executable: hasLocalFalTransport(entry.endpoint, entry.transport),
    inputFields: Object.keys(resolveSchema(input, schemas).properties ?? {}),
  }));
}
// Inline media become public upload URLs before submit; URL length limits apply to those URLs.
function higgsfieldValidationInput(value: unknown, key = "input"): unknown {
  if (
    typeof value === "string" &&
    /_url$/.test(key) &&
    /^data:(?:image|audio|video)\/[\w.+-]+;base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    return "https://upload.invalid/reference";
  if (Array.isArray(value))
    return value.map((item) => higgsfieldValidationInput(item, key.endsWith("_urls") ? key.slice(0, -1) : key));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([name, field]) => [name, higgsfieldValidationInput(field, name)]),
    );
  return value;
}

/**
 * Validates a request in either form and returns its plan: strict schema validation, guard plugins
 * (fal-guards/), validation again, then media constraints.
 */
export function buildFalOperation(
  requestInput: FalAnyRequest,
  options: { allowUnvalidated?: boolean } = {},
): FalOperationPlan {
  let snapshot: Snapshot,
    entry: FalCatalogEntry | undefined,
    variant: string,
    operation: string,
    region: string,
    transport: FalTransport,
    rawInput: Record<string, unknown>;
  let context;
  let provider: ProviderId = "fal";
  if ("endpoint" in requestInput) {
    const request = FalEndpointRequestSchema.parse(requestInput);
    provider = request.provider ?? "fal";
    ({ snapshot, entry } = endpointSnapshot(request.endpoint, request.transport, request.region, provider));
    ({ variant, operation, region, transport } = snapshot);
    rawInput = request.input;
    context = request.context;
  } else {
    const request = FalOperationRequestSchema.parse(requestInput);
    ({ snapshot, variant, transport } = legacySnapshot(request));
    entry = findCatalogEntry(snapshot.endpoint);
    operation = request.operation;
    region = request.region;
    rawInput = request.input;
    context = request.context;
  }
  const components = snapshot.schemas;
  const category = entry?.category ?? LEGACY_CATEGORY[snapshot.operation] ?? "unknown";
  const input = structuredClone(rawInput);
  // https://docs.higgsfield.ai/docs/models/soul-id/create-character.md: public image URLs only; check before the URL length limit.
  if (
    provider === "higgsfield" &&
    snapshot.endpoint === "v1/custom-references" &&
    Array.isArray(input.input_images) &&
    input.input_images.some(
      (image) => isObject(image) && typeof image.image_url === "string" && !/^https?:\/\//.test(image.image_url),
    )
  )
    fail(
      "Soul ID training requires public HTTP(S) image_url values; local/imported/data references are not uploaded by the training adapter.",
    );
  validateJsonSchema(snapshot.input, provider === "higgsfield" ? higgsfieldValidationInput(input) : input, {
    components,
    at: "input",
    strict: true,
  });
  const schemaValidated = snapshot.schemaStatus !== "unavailable";
  const warnings: string[] = [];
  if (!schemaValidated)
    warnings.push(
      "No documented JSON Schema exists; offline schema validation is impossible. Execution requires --provider-estimate validation or explicit --allow-unvalidated.",
    );
  const info: FalGuardInfo = {
    provider,
    endpoint: snapshot.endpoint,
    family: snapshot.family,
    variant,
    operation: snapshot.operation,
    category,
    inputSchema: resolveSchema(snapshot.input, components),
    components,
  };
  applyFalGuards(input, { ...falGuardContext(context), provider }, warnings, info);
  validateJsonSchema(snapshot.input, provider === "higgsfield" ? higgsfieldValidationInput(input) : input, {
    components,
    at: "input",
    strict: true,
  });
  validateMediaConstraints(snapshot.input, input, { components, media: context?.media ?? {} });
  const gone = entry?.status === "gone";
  if (gone)
    warnings.push(
      `Endpoint ${snapshot.endpoint} is gone from the ${provider} catalogue${entry?.replacement ? `; replacement: ${entry.replacement}` : ""}; it cannot be executed.`,
    );
  else if (entry?.retiresAt)
    warnings.push(`Endpoint retires at ${entry.retiresAt}; replacement: ${entry.replacement ?? "none named"}.`);
  const executable =
    (provider === "higgsfield"
      ? ["queue", "training"].includes(transport) && (schemaValidated || options.allowUnvalidated === true)
      : hasLocalFalTransport(snapshot.endpoint, transport)) && !gone;
  if (transport === "stream")
    warnings.push(
      "Use the bounded HTTP stream adapter; interrupted requests never reconnect automatically and unknown billing remains reserved.",
    );
  if (transport === "realtime")
    warnings.push(
      "Use generate:realtime with one revision per bounded session, an explicit whole-session quote and frame/message/deadline limits; no provider ACK or reconnect is available.",
    );
  return {
    provider,
    family: snapshot.family,
    variant,
    operation,
    region,
    endpoint: snapshot.endpoint,
    transport,
    input,
    executable,
    verification: {
      schema: schemaValidated,
      localAdapter: provider === "higgsfield" ? ["queue", "training"].includes(transport) : executable,
      live: false,
    },
    schemaSource: snapshot.schemaSource,
    schemaAsOf: snapshot.asOf,
    schemaSha256: snapshot.sha256,
    warnings,
    category,
    tier: entry?.tier ?? "verified",
    outputKinds:
      provider === "higgsfield" && transport === "training"
        ? ["json"]
        : (entry?.outputs.kinds ?? legacyOutputKinds(snapshot)),
    ...(entry?.retiresAt ? { retiresAt: String(entry.retiresAt) } : {}),
    ...(entry?.replacement ? { replacement: entry.replacement } : {}),
  };
}
export function requireExecutableFalOperation(plan: FalOperationPlan): void {
  if (!plan.executable)
    throw new FalOperationError(
      "UNSUPPORTED_OPERATION",
      plan.transport === "queue" || plan.transport === "training"
        ? `${plan.endpoint} is not executable: ${plan.warnings.find((warning) => /gone|offline schema validation/.test(warning)) ?? "no local transport"}`
        : `${plan.transport} execution requires a dedicated session/stream adapter.`,
    );
}
/** Resolve the same tracked-or-cached schema used to build a plan. */
export function resolveFalSnapshotForPlan(
  plan: Pick<FalOperationPlan, "endpoint"> & Partial<Pick<FalOperationPlan, "transport" | "region" | "provider">>,
): Snapshot {
  return endpointSnapshot(plan.endpoint, plan.transport, plan.region, plan.provider).snapshot;
}
export function validateFalOperationResult(
  endpoint: string,
  result: unknown,
  provider: ProviderId = "fal",
): Record<string, unknown> {
  let snapshot =
    provider === "higgsfield"
      ? endpointSnapshot(endpoint, undefined, undefined, provider).snapshot
      : adapters.find((entry) => entry.endpoint === endpoint);
  if (!snapshot) {
    const entry = findCatalogEntry(endpoint);
    if (!entry?.schema) throw new FalOperationError("UNSUPPORTED_OPERATION", "Unknown result endpoint.");
    snapshot = catalogSnapshot(endpoint, entry, entry.transport, entry.routing?.region ?? "global");
  }
  validateJsonSchema(snapshot.output, result, { components: snapshot.schemas, at: "result", strict: false });
  if (!isObject(result)) fail("Provider result must be an object.");
  return structuredClone(result);
}
