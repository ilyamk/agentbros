import { genjutsuMode, preparationProfile } from "../model-preparation/profiles";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { CliErrorObject } from "../cli";
import { resolveProviderSnapshot, SchemaNotCachedError, summariseInputs } from "./fal-catalog";
import type { ProviderId } from "../../types/fal-catalog";
import { findModelSchema } from "./registry";
import {
  exampleFromSchema,
  resolveSchema,
  validateJsonSchema,
  type JsonSchema,
  type SchemaComponents,
} from "../providers/json-schema-validate";
import { buildFalOperation } from "../providers/fal-operations";

/** Hash-checked cache first, then the bundled verified snapshot. */
export function falScaffoldSchema(endpoint: string, provider: ProviderId = "fal") {
  try {
    const cached = resolveProviderSnapshot(provider, endpoint);
    if (cached) return cached;
  } catch (error) {
    if (!(error instanceof SchemaNotCachedError)) throw error;
  }
  const tracked = provider === "fal" ? findModelSchema(endpoint) : undefined;
  if (tracked) return tracked;
  throw new SchemaNotCachedError(endpoint);
}
export type FalScaffoldResult = {
  request: { provider?: ProviderId; endpoint: string; input: Record<string, unknown> };
  hints: Record<
    string,
    {
      type?: string;
      enum?: unknown[];
      min?: number;
      max?: number;
      default?: unknown;
      media?: string;
      description?: string;
    }
  >;
  missing: string[];
  valid: boolean;
  errors: string[];
  nextAction?: string;
  preparation?: ReturnType<typeof preparationProfile>;
};
/** Dotted object patches, with no prototype access and JSON values kept intact. */
export function setFalScaffoldValue(input: Record<string, unknown>, assignment: string): void {
  const equal = assignment.indexOf("=");
  const keys = assignment.slice(0, equal).split(".");
  if (equal <= 0 || keys.some((key) => !key || ["__proto__", "prototype", "constructor"].includes(key)))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: `Invalid --set: ${assignment}` });
  let target = input;
  for (const key of keys.slice(0, -1)) {
    if (target[key] === undefined) target[key] = {};
    const value = target[key];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `--set parent ${key} must be an object.` });
    target = value as Record<string, unknown>;
  }
  const raw = assignment.slice(equal + 1);
  let value: unknown = raw;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Non-JSON assignments are literal strings. */
  }
  target[keys.at(-1)!] = value;
}
export function scaffoldFalEndpoint(
  endpoint: string,
  options: { set?: readonly string[]; provider?: ProviderId } = {},
): FalScaffoldResult {
  const request: FalScaffoldResult["request"] = {
    ...(options.provider ? { provider: options.provider } : {}),
    endpoint,
    input: {} as Record<string, unknown>,
  };
  const result: FalScaffoldResult = { request, hints: {}, missing: [], valid: false, errors: [] };
  const mode = genjutsuMode(endpoint, options.provider ?? "fal");
  if (mode) result.preparation = preparationProfile(mode);
  let snapshot;
  try {
    snapshot = falScaffoldSchema(endpoint, options.provider);
  } catch (error) {
    if (!(error instanceof SchemaNotCachedError)) throw error;
    return {
      ...result,
      errors: [error.code],
      nextAction:
        options.provider === "higgsfield"
          ? `No Higgsfield schema: wait for hf:sync; validate a separately prepared request with pnpm hf:quote --request REQUEST.json --provider-estimate`
          : `pnpm fal:sync --schemas ${endpoint}`,
    };
  }
  const components = snapshot.schemas as SchemaComponents;
  const placeholders: Record<string, unknown> = {};
  const media = new Map(
    summariseInputs({ ...snapshot, schemas: components, endpoint, schemaStatus: "discovered" }).map((field) => [
      field.name,
      field.media,
    ]),
  );
  const walk = (schema: JsonSchema, prefix = "", depth = 0): void => {
    if (depth > 20) return;
    const node = resolveSchema(schema, components);
    for (const [key, raw] of Object.entries(node.properties ?? {})) {
      const field = resolveSchema(raw, components),
        name = prefix ? `${prefix}.${key}` : key;
      const branch =
        field.anyOf?.find((item) => item.type !== "null") ?? field.oneOf?.find((item) => item.type !== "null");
      const typed = branch ? { ...resolveSchema(branch, components), ...field } : field;
      result.hints[name] = {
        type: typed.type,
        enum: typed.enum,
        min: typed.minimum ?? typed.minLength ?? typed.minItems,
        max: typed.maximum ?? typed.maxLength ?? typed.maxItems,
        default: typed.default,
        media: media.get(key),
        description: typeof typed.description === "string" ? typed.description.slice(0, 200) : undefined,
      };
      if (typed.type === "string" && typed.default === undefined && !typed.enum && !("const" in typed))
        placeholders[key] = `<FILL: ${key}>`;
      if (typed.type === "array" && typed.items) {
        const item = resolveSchema(typed.items, components);
        if (item.type === "string" && item.default === undefined && !item.enum)
          placeholders[key.endsWith("s") ? key.slice(0, -1) : key] = `<FILL: ${key}>`;
        walk(typed.items, `${name}[]`, depth + 1);
      }
      walk(typed, name, depth + 1);
    }
    for (const branch of [...(node.allOf ?? []), ...(node.anyOf ?? []), ...(node.oneOf ?? [])])
      walk(branch, prefix, depth + 1);
  };
  walk(snapshot.input);
  request.input = exampleFromSchema(snapshot.input, components, { placeholders }) as Record<string, unknown>;
  for (const assignment of options.set ?? []) setFalScaffoldValue(request.input, assignment);
  const missing = (value: unknown, at: string): void => {
    if (typeof value === "string" && value.includes("<FILL:")) result.missing.push(at);
    else if (value && typeof value === "object")
      for (const [key, child] of Object.entries(value)) missing(child, at ? `${at}.${key}` : key);
  };
  missing(request.input, "");
  try {
    validateJsonSchema(snapshot.input, request.input, { components, strict: true, at: "input" });
    buildFalOperation(request);
    result.valid = result.missing.length === 0;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  return result;
}
/** Explicit output only, canonically scoped to the workspace or OS temporary directory. */
export function writeFalScaffold(
  file: string,
  request: FalScaffoldResult["request"],
  options: { force?: boolean; root?: string } = {},
): string {
  const target = path.resolve(file);
  let ancestor = target;
  while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const canonical = path.resolve(realpathSync(ancestor), path.relative(ancestor, target));
  const inside = (root: string) => {
    const relative = path.relative(realpathSync(root), canonical);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  if (!inside(options.root ?? process.cwd()) && !inside(tmpdir()))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--out must be under the project workspace or a temporary path.",
    });
  try {
    writeFileSync(canonical, `${JSON.stringify(request, null, 2)}\n`, { flag: options.force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new CliErrorObject({ code: "FILE_EXISTS", message: `Refusing to overwrite ${file}; use --force.` });
    throw error;
  }
  return canonical;
}
