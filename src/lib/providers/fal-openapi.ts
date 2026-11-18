import { createHash } from "node:crypto";

/**
 * Converts one fal Platform API model object (GET /v1/models?endpoint_id=X&expand=openapi-3.0)
 * into the request/result schema pair the validator reads. Pure: no I/O.
 */
export type JsonSchema = Record<string, unknown>;
export type FalApiModel = {
  endpoint_id: string;
  metadata?: {
    category?: string;
    display_name?: string;
    status?: string;
    kind?: string;
    tags?: string[];
    [key: string]: unknown;
  };
  openapi?: {
    paths?: Record<
      string,
      Record<
        string,
        {
          requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
          responses?: Record<string, { content?: Record<string, { schema?: JsonSchema }> }>;
        }
      >
    >;
    components?: { schemas?: Record<string, JsonSchema> };
  };
  retires_at?: string | null;
  replacement?: string | null;
};
/** Same shape as an entry of providers/schemas/fal-operations.json, minus legacy routing. */
export type FalSchemaSnapshot = {
  endpoint: string;
  schemaStatus: "verified" | "discovered";
  schemaSource: string;
  asOf: string;
  sha256: string;
  input: JsonSchema;
  output: JsonSchema;
  schemas: Record<string, JsonSchema>;
};

/** Canonical bytes: sorted keys, no whitespace. The cache file holds exactly these bytes. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sort(value));
}
function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sort((value as Record<string, unknown>)[key])]),
    );
  return value;
}
export function apiModelSha256(model: FalApiModel): string {
  return createHash("sha256").update(canonicalJson(model)).digest("hex");
}
export function apiModelSource(endpoint: string): string {
  return `https://api.fal.ai/v1/models?endpoint_id=${encodeURIComponent(endpoint)}&expand=openapi-3.0`;
}

const json = (body: { content?: Record<string, { schema?: JsonSchema }> } | undefined) =>
  body?.content?.["application/json"]?.schema;

/**
 * The submit path is a POST whose body is the input, and its sibling `<path>/requests/{request_id}`
 * GET 200 is the output (QueueStatus is not). The path is the app's internal route and often differs
 * from the public endpoint ID (25 of 54 recorded fixtures), so it is matched by shape, not by name.
 * Status and result must therefore be polled through the `status_url`/`response_url` the submit returns.
 */
export function openApiRoutes(model: FalApiModel): { submitPath: string; resultPath: string } | undefined {
  const paths = model.openapi?.paths ?? {};
  const submits = Object.keys(paths).filter(
    (p) => json(paths[p]?.post?.requestBody) && paths[`${p}/requests/{request_id}`]?.get,
  );
  return submits.length === 1
    ? { submitPath: submits[0]!, resultPath: `${submits[0]}/requests/{request_id}` }
    : undefined;
}
export function snapshotFromOpenApi(
  model: FalApiModel,
  asOf: string,
  sha256 = apiModelSha256(model),
): FalSchemaSnapshot {
  const endpoint = model.endpoint_id;
  const routes = openApiRoutes(model);
  const paths = model.openapi?.paths ?? {};
  const input = routes && json(paths[routes.submitPath]?.post?.requestBody);
  const output = routes && json(paths[routes.resultPath]?.get?.responses?.["200"]);
  if (!input || !output)
    throw new Error(
      `OpenAPI for ${endpoint} lacks exactly one queue submit body with a result schema (realtime or schema-less endpoint).`,
    );
  return {
    endpoint,
    schemaStatus: "discovered",
    schemaSource: apiModelSource(endpoint),
    asOf,
    sha256,
    input,
    output,
    schemas: model.openapi?.components?.schemas ?? {},
  };
}
