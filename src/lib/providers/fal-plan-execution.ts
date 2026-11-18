import curation from "../models/fal-curation.json";
import { loadCatalog, readCachedApiModel, resolveCatalogSnapshot, SchemaNotCachedError } from "../models/fal-catalog";
import { CliErrorObject } from "../cli";
import type { ExecutionOptions } from "../jobs/execution";
import type { FalOperationContext } from "../../types/generation";
import type { FalCatalogEntry } from "../../types/fal-catalog";
import {
  buildFalOperation,
  FalOperationError,
  requireExecutableFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "./fal-operations";
import { openApiRoutes } from "./fal-openapi";
import { resolveSchema } from "./json-schema-validate";
import { quoteInputForPlan } from "./fal-quote-input";
import { primaryKind } from "./fal-results";

type Role = "upscale" | "cutout" | "lipsync";
type Media = Partial<Record<"image" | "video" | "audio", string>>;

/** Explicit utility overrides require a verified, curated endpoint of the requested role. */
export function requireVerifiedFalRoleEndpoint(endpoint: string, role: Role, category?: string): FalCatalogEntry {
  const catalog = loadCatalog();
  const allowed = curation.entries
    .filter((item) => item.roles.includes(role))
    .map((item) => catalog.get(item.endpoint))
    .filter(
      (entry): entry is FalCatalogEntry => entry?.tier === "verified" && (!category || entry.category === category),
    )
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const entry = allowed.find((item) => item.endpoint === endpoint);
  if (!entry)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: `--endpoint requires a verified ${role} endpoint${category ? ` in ${category}` : ""}. Allowed: ${allowed.map((item) => item.endpoint).join(", ") || "(none)"}.`,
    });
  return entry;
}

/** Map scalar media inputs from the pinned schema, then prepare the same queue contract as generate:model. */
export function prepareFalRoleExecution(entry: FalCatalogEntry, media: Media, context?: FalOperationContext) {
  try {
    const schema = resolveCatalogSnapshot(entry.endpoint);
    if (!schema) throw new FalOperationError("SCHEMA_NOT_CACHED", `No cached schema for ${entry.endpoint}.`);
    const inputSchema = resolveSchema(schema.input, schema.schemas);
    const properties = inputSchema.properties ?? {};
    const input: Record<string, unknown> = {};
    for (const field of inputSchema.required ?? []) {
      const node = resolveSchema(properties[field] ?? {}, schema.schemas);
      if (node.default !== undefined) input[field] = structuredClone(node.default);
    }
    for (const [kind, url] of Object.entries(media)) {
      const fields = Object.entries(properties)
        .filter(([name, raw]) => {
          const node = resolveSchema(raw, schema.schemas);
          return node.type === "string" && (name === `${kind}_url` || node._fal_ui_field === kind);
        })
        .map(([name]) => name);
      const field = fields.includes(`${kind}_url`) ? `${kind}_url` : fields.length === 1 ? fields[0] : undefined;
      if (!field)
        throw new FalOperationError(
          "INVALID_INPUT",
          `${entry.endpoint} has no unambiguous ${kind} input field; inspect its schema with fal:models.`,
        );
      input[field] = url;
    }
    const plan = buildFalOperation({ endpoint: entry.endpoint, input, context });
    requireExecutableFalOperation(plan);
    const snapshot = resolveFalSnapshotForPlan(plan);
    const apiModel = entry.schema ? readCachedApiModel(entry.schema.sha256) : undefined;
    const queuePath = apiModel ? openApiRoutes(apiModel)?.submitPath.replace(/^\//, "") : undefined;
    const mediaKind = primaryKind(plan.outputKinds ?? []);
    if (!mediaKind) throw new FalOperationError("INVALID_INPUT", "Operation has no supported output kinds.");
    const options = {
      endpoint: plan.endpoint,
      model: plan.endpoint,
      input: plan.input,
      mediaKind,
      resultSchema: { schema: snapshot.output, components: snapshot.schemas },
      queuePath,
      quoteInput: quoteInputForPlan(plan, plan.input, context),
      validateResult: (result: Record<string, unknown>) => {
        validateFalOperationResult(plan.endpoint, result);
      },
    } satisfies Partial<ExecutionOptions>;
    return { plan, options };
  } catch (error) {
    if (error instanceof FalOperationError || error instanceof SchemaNotCachedError)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: error.message,
        details: {
          providerCode: error.code,
          ...(error.code === "SCHEMA_NOT_CACHED" ? { nextAction: `pnpm fal:sync --schemas ${entry.endpoint}` } : {}),
        },
      });
    throw error;
  }
}
