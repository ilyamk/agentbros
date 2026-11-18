import { canonicalJson } from "./fal-openapi";
import { FalOperationError, fail, isObject } from "./fal-errors";

/**
 * The JSON Schema subset fal's OpenAPI 3.0 request and result schemas use (src/lib/providers/schemas/README.md).
 * Throws FalOperationError: INVALID_INPUT for a value that breaks the schema, UNSUPPORTED_OPERATION for an
 * unresolved reference. Pure: no I/O.
 */
export type JsonSchema = {
  $ref?: string;
  $defs?: Record<string, JsonSchema>;
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  if?: JsonSchema;
  then?: JsonSchema;
  else?: JsonSchema;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchema;
  prefixItems?: JsonSchema[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  multipleOf?: number;
  minProperties?: number;
  maxProperties?: number;
  nullable?: boolean;
  discriminator?: { propertyName: string; mapping?: Record<string, string> };
  default?: unknown;
  "x-fal"?: Record<string, number>;
  [key: string]: unknown;
};
export type SchemaComponents = Record<string, JsonSchema>;
/** ffprobe/asset metadata keyed by the exact reference URL. */
export type MediaMetadata = Record<
  string,
  { contentType?: string; bytes?: number; width?: number; height?: number; durationSec?: number; fps?: number }
>;

/** File limits fal states either inside `x-fal` or directly on the field; checked only against known media metadata. */
export const MEDIA_CONSTRAINT_KEYWORDS = Object.freeze([
  "min_file_size",
  "max_file_size",
  "min_width",
  "max_width",
  "min_height",
  "max_height",
  "min_duration",
  "max_duration",
  "min_fps",
  "max_fps",
  "min_pixels",
  "max_pixels",
  "min_area",
  "max_area",
  "min_aspect_ratio",
  "max_aspect_ratio",
]);
export const SUPPORTED_KEYWORDS: ReadonlySet<string> = new Set([
  "if",
  "then",
  "else",
  "$defs",
  "$ref",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "anyOf",
  "oneOf",
  "allOf",
  "enum",
  "const",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minProperties",
  "maxProperties",
  "nullable",
  "discriminator",
  "x-fal",
  ...MEDIA_CONSTRAINT_KEYWORDS,
]);
/** Documentation and UI hints: read by people and editors, never by validation. */
export const IGNORED_KEYWORDS: ReadonlySet<string> = new Set([
  "title",
  "description",
  "examples",
  "example",
  "default",
  "x-fal-order-properties",
  "_fal_ui_field",
  "field",
  "limit_description",
  "ui",
  "step",
  "deprecated",
  "readOnly",
  "writeOnly",
]);

export function resolveSchema(schema: JsonSchema, components: SchemaComponents): JsonSchema {
  if (!schema.$ref) return schema;
  const reference = components[schema.$ref.split("/").at(-1)!];
  if (!reference) throw new FalOperationError("UNSUPPORTED_OPERATION", `Unresolved schema reference ${schema.$ref}.`);
  return reference;
}

/** The branch a discriminator names, or undefined to fall back to plain anyOf/oneOf matching. */
function discriminated(schema: JsonSchema, value: unknown, components: SchemaComponents): JsonSchema | undefined {
  const discriminator = schema.discriminator;
  if (!discriminator || !isObject(value)) return undefined;
  const tag = value[discriminator.propertyName];
  if (typeof tag !== "string") return undefined;
  const target = discriminator.mapping?.[tag];
  const name = target ? target.split("/").at(-1)! : tag;
  const branch = (schema.oneOf ?? schema.anyOf ?? []).find((item) => item.$ref?.split("/").at(-1) === name);
  return branch ?? (target && components[name] ? components[name] : undefined);
}
function exclusiveBound(bound: number | boolean | undefined, inclusive: number | undefined): number | undefined {
  return typeof bound === "number" ? bound : bound === true ? inclusive : undefined;
}
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/i;
function checkFormat(format: string | undefined, value: string, at: string): void {
  if (format === "uri") {
    try {
      new URL(value);
    } catch {
      fail(`${at}: expected an absolute URI.`);
    }
  }
  if (format === "date-time" && (!ISO_DATE_TIME.test(value) || !Number.isFinite(Date.parse(value))))
    fail(`${at}: expected an ISO date-time.`);
  if (format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))))
    fail(`${at}: expected an ISO date.`);
}

function valid(
  schema: JsonSchema,
  value: unknown,
  components: SchemaComponents,
  at: string,
  strict: boolean,
  depth = 0,
): void {
  if (depth > 50) fail(`${at}: schema/input nesting limit exceeded.`);
  schema = resolveSchema(schema, components);
  if (schema.nullable === true && value === null) return;
  if (schema.anyOf || schema.oneOf) {
    const chosen = discriminated(schema, value, components);
    if (chosen) valid(chosen, value, components, at, strict, depth + 1);
    else {
      const branches = schema.anyOf ?? schema.oneOf!;
      let matches = 0;
      for (const branch of branches) {
        try {
          valid(branch, value, components, at, strict, depth + 1);
          matches++;
        } catch (error) {
          if (!(error instanceof FalOperationError) || error.code !== "INVALID_INPUT") throw error;
        }
      }
      if (matches === 0 || (schema.oneOf && matches !== 1))
        fail(`${at}: does not satisfy allowed schema alternatives.`);
    }
  }
  if (schema.if) {
    let condition = true;
    try {
      valid(schema.if, value, components, at, false, depth + 1);
    } catch (error) {
      if (!(error instanceof FalOperationError) || error.code !== "INVALID_INPUT") throw error;
      condition = false;
    }
    const branch = condition ? schema.then : schema.else;
    if (branch) valid(branch, value, components, at, false, depth + 1);
  }
  if (isObject(value))
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`${at}.${key}: required.`);
  if (schema.allOf) for (const branch of schema.allOf) valid(branch, value, components, at, strict, depth + 1);
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value)))
    fail(`${at}: expected one of ${schema.enum.join(", ")}.`);
  if ("const" in schema && !Object.is(schema.const, value)) fail(`${at}: expected ${String(schema.const)}.`);
  if (schema.type === "null" && value !== null) fail(`${at}: expected null.`);
  if (schema.type === "boolean" && typeof value !== "boolean") fail(`${at}: expected boolean.`);
  if (
    (schema.type === "number" || schema.type === "integer") &&
    (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value)))
  )
    fail(`${at}: expected finite ${schema.type}.`);
  if (typeof value === "number") {
    const exclusiveMinimum = exclusiveBound(schema.exclusiveMinimum, schema.minimum);
    const exclusiveMaximum = exclusiveBound(schema.exclusiveMaximum, schema.maximum);
    if (schema.minimum !== undefined && value < schema.minimum) fail(`${at}: below minimum ${schema.minimum}.`);
    if (schema.maximum !== undefined && value > schema.maximum) fail(`${at}: above maximum ${schema.maximum}.`);
    if (exclusiveMinimum !== undefined && value <= exclusiveMinimum) fail(`${at}: must exceed ${exclusiveMinimum}.`);
    if (exclusiveMaximum !== undefined && value >= exclusiveMaximum) fail(`${at}: must be below ${exclusiveMaximum}.`);
    if (
      schema.multipleOf !== undefined &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > 1e-8
    )
      fail(`${at}: must be a multiple of ${schema.multipleOf}.`);
  }
  if (schema.type === "string" && typeof value !== "string") fail(`${at}: expected string.`);
  if (typeof value === "string") {
    const length = Array.from(value).length;
    if (schema.minLength !== undefined && length < schema.minLength) fail(`${at}: string is too short.`);
    if (schema.maxLength !== undefined && length > schema.maxLength) fail(`${at}: string is too long.`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`${at}: string pattern mismatch.`);
    checkFormat(schema.format, value, at);
  }
  if (schema.type === "array" && !Array.isArray(value)) fail(`${at}: expected array.`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail(`${at}: too few items.`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`${at}: too many items.`);
    if (schema.uniqueItems === true && new Set(value.map((item) => canonicalJson(item))).size !== value.length)
      fail(`${at}: items must be unique.`);
    const prefix = schema.prefixItems ?? [];
    value.forEach((item, i) => {
      if (i < prefix.length) valid(prefix[i]!, item, components, `${at}[${i}]`, strict, depth + 1);
      else if (schema.items) valid(schema.items, item, components, `${at}[${i}]`, strict, depth + 1);
    });
  }
  if ((schema.type === "object" || schema.properties) && !isObject(value)) fail(`${at}: expected object.`);
  if (isObject(value) && (schema.type === "object" || schema.properties || schema.additionalProperties !== undefined)) {
    const count = Object.keys(value).length;
    if (schema.minProperties !== undefined && count < schema.minProperties) fail(`${at}: too few properties.`);
    if (schema.maxProperties !== undefined && count > schema.maxProperties) fail(`${at}: too many properties.`);
  }
  if (isObject(value) && (schema.type === "object" || schema.properties)) {
    for (const [key, item] of Object.entries(value)) {
      const property = schema.properties && Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
      if (property) valid(property, item, components, `${at}.${key}`, strict, depth + 1);
      else if (typeof schema.additionalProperties === "object")
        valid(schema.additionalProperties, item, components, `${at}.${key}`, strict, depth + 1);
      else if (schema.additionalProperties === false || (strict && schema.additionalProperties !== true))
        fail(`${at}.${key}: unsupported field.`);
    }
  }
}

/**
 * Validates `value` against `schema`. Strict mode rejects any object field the schema does not declare
 * unless it allows extra fields (`additionalProperties: true` or a schema).
 */
export function validateJsonSchema(
  schema: JsonSchema,
  value: unknown,
  options: { components: SchemaComponents; at?: string; strict?: boolean },
): void {
  valid(schema, value, options.components, options.at ?? "input", options.strict ?? true);
}
function matches(schema: JsonSchema, value: unknown, components: SchemaComponents, at: string): boolean {
  try {
    valid(schema, value, components, at, true);
    return true;
  } catch (error) {
    if (!(error instanceof FalOperationError) || error.code !== "INVALID_INPUT") throw error;
    return false;
  }
}

const MEDIA_FIELDS = [
  ["file_size", "bytes"],
  ["width", "width"],
  ["height", "height"],
  ["duration", "durationSec"],
  ["fps", "fps"],
] as const;
/**
 * File limits (`x-fal` and the same keys on the field) against the metadata of the exact URL;
 * a URL without metadata is left to the provider. Follows the first matching anyOf branch.
 */
export function validateMediaConstraints(
  schema: JsonSchema,
  value: unknown,
  options: { components: SchemaComponents; media: MediaMetadata; at?: string },
): void {
  const { components, media } = options;
  const at = options.at ?? "input";
  schema = resolveSchema(schema, components);
  if (schema.anyOf)
    for (const branch of schema.anyOf) {
      if (matches(branch, value, components, at)) {
        validateMediaConstraints(branch, value, { components, media, at });
        break;
      }
    }
  const direct = Object.fromEntries(
    MEDIA_CONSTRAINT_KEYWORDS.filter((key) => typeof schema[key] === "number").map((key) => [
      key,
      schema[key] as number,
    ]),
  );
  const constraints: Record<string, number> | undefined =
    schema["x-fal"] || Object.keys(direct).length ? { ...schema["x-fal"], ...direct } : undefined;
  const info = typeof value === "string" ? media[value] : undefined;
  if (constraints && info) {
    for (const [field, property] of MEDIA_FIELDS) {
      const actual = info[property];
      if (
        actual !== undefined &&
        ((constraints[`min_${field}`] !== undefined && actual < constraints[`min_${field}`]!) ||
          (constraints[`max_${field}`] !== undefined && actual > constraints[`max_${field}`]!))
      )
        fail(`${at}: ${property} exceeds reference media constraints.`);
    }
    if (info.width && info.height) {
      const ratio = info.width / info.height;
      if (
        (constraints.min_aspect_ratio !== undefined && ratio < constraints.min_aspect_ratio) ||
        (constraints.max_aspect_ratio !== undefined && ratio > constraints.max_aspect_ratio)
      )
        fail(`${at}: reference aspect ratio exceeds constraints.`);
      const pixels = info.width * info.height;
      for (const field of ["pixels", "area"] as const) {
        if (
          (constraints[`min_${field}`] !== undefined && pixels < constraints[`min_${field}`]!) ||
          (constraints[`max_${field}`] !== undefined && pixels > constraints[`max_${field}`]!)
        )
          fail(`${at}: reference ${field} exceeds media constraints.`);
      }
    }
  }
  if (isObject(value))
    for (const [key, item] of Object.entries(value))
      if (schema.properties?.[key])
        validateMediaConstraints(schema.properties[key], item, { components, media, at: `${at}.${key}` });
  if (Array.isArray(value))
    value.forEach((item, i) => {
      const itemSchema = schema.prefixItems?.[i] ?? schema.items;
      if (itemSchema) validateMediaConstraints(itemSchema, item, { components, media, at: `${at}[${i}]` });
    });
}

/**
 * Keywords reachable from `schema` that the validator neither enforces nor deliberately ignores, sorted.
 * Values of `properties` are walked as schemas, never their names; opaque values (enum, const, default,
 * examples, discriminator, ui, x-fal) are not walked.
 */
export function unsupportedKeywords(schema: JsonSchema, components: SchemaComponents): string[] {
  const found = new Set<string>();
  const seen = new Set<JsonSchema>();
  const walk = (node: unknown): void => {
    if (!isObject(node) || seen.has(node as JsonSchema)) return;
    const item = node as JsonSchema;
    seen.add(item);
    for (const key of Object.keys(item)) if (!SUPPORTED_KEYWORDS.has(key) && !IGNORED_KEYWORDS.has(key)) found.add(key);
    if (item.$ref) {
      const target = components[item.$ref.split("/").at(-1)!];
      if (target) walk(target);
      else found.add(`$ref:${item.$ref}`);
    }
    for (const child of Object.values(item.$defs ?? {})) walk(child);
    for (const child of Object.values(item.properties ?? {})) walk(child);
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"] as const)
      for (const child of item[key] ?? []) walk(child);
    for (const key of ["if", "then", "else"] as const) walk(item[key]);
    walk(item.items);
    if (isObject(item.additionalProperties)) walk(item.additionalProperties);
  };
  walk(schema);
  return [...found].sort();
}

/**
 * A minimal value that satisfies `schema`: required fields only, valid defaults first, then the first
 * enum value, the first non-null alternative, and bounds-respecting numbers, strings and arrays.
 * `placeholders` override any field by name (e.g. `{ prompt: "…", image_url: "https://…" }`).
 * Used by tests and by fal:scaffold; callers still validate the result.
 */
export function exampleFromSchema(
  schema: JsonSchema,
  components: SchemaComponents,
  options: { placeholders?: Record<string, unknown> } = {},
): unknown {
  const placeholders = options.placeholders ?? {};
  const build = (node: JsonSchema, name: string | undefined, depth: number): unknown => {
    if (depth > 20) return null;
    node = resolveSchema(node, components);
    if (name !== undefined && Object.hasOwn(placeholders, name)) return structuredClone(placeholders[name]);
    if (node.default !== undefined && matches(node, node.default, components, "default"))
      return structuredClone(node.default);
    if ("const" in node) return node.const;
    if (node.enum?.length) return node.enum.find((item) => item !== null) ?? node.enum[0];
    const branches = node.oneOf ?? node.anyOf;
    if (branches?.length) {
      const mapping = Object.entries(node.discriminator?.mapping ?? {});
      if (node.discriminator && mapping.length) {
        const [tag, target] = mapping[0]!;
        const value = build({ $ref: target }, name, depth + 1);
        return isObject(value) ? { ...value, [node.discriminator.propertyName]: tag } : value;
      }
      const branch = branches.find((item) => resolveSchema(item, components).type !== "null") ?? branches[0]!;
      return build(branch, name, depth + 1);
    }
    if (node.allOf?.length)
      return Object.assign({}, ...node.allOf.map((item) => build(item, name, depth + 1)).filter(isObject));
    if (node.nullable && !node.type) return null;
    const type =
      node.type ??
      (node.properties || node.additionalProperties ? "object" : node.items || node.prefixItems ? "array" : undefined);
    if (type === "null") return null;
    if (type === "boolean") return false;
    if (type === "integer" || type === "number") return exampleNumber(node, type === "integer");
    if (type === "string") return exampleString(node, name);
    if (type === "array") {
      if (node.prefixItems) return node.prefixItems.map((item) => build(item, undefined, depth + 1));
      const count = Math.min(Math.max(node.minItems ?? 0, 1), node.maxItems ?? Infinity);
      const itemName = name?.endsWith("s") ? name.slice(0, -1) : name;
      return node.items
        ? Array.from({ length: count }, (_, i) => {
            const item = build(node.items!, itemName, depth + 1);
            return typeof item === "string" && count > 1 ? `${item}${i}` : item;
          })
        : [];
    }
    if (type === "object") {
      const value: Record<string, unknown> = {};
      for (const key of node.required ?? [])
        value[key] = node.properties?.[key] ? build(node.properties[key], key, depth + 1) : null;
      if (isObject(node.additionalProperties)) {
        for (let i = Object.keys(value).length; i < (node.minProperties ?? 0); i++)
          value[`key${i + 1}`] = build(node.additionalProperties, undefined, depth + 1);
      }
      return value;
    }
    return null;
  };
  return build(schema, undefined, 0);
}
function exampleNumber(node: JsonSchema, integer: boolean): number {
  const step = node.multipleOf ?? (integer ? 1 : undefined);
  const exclusiveMinimum = exclusiveBound(node.exclusiveMinimum, node.minimum);
  const exclusiveMaximum = exclusiveBound(node.exclusiveMaximum, node.maximum);
  let value = node.minimum ?? (exclusiveMinimum !== undefined ? exclusiveMinimum + (step ?? 1) : 1);
  const upper = node.maximum ?? exclusiveMaximum;
  if (exclusiveMinimum !== undefined && upper !== undefined && value >= upper) value = (exclusiveMinimum + upper) / 2;
  else if (upper !== undefined && value > upper) value = upper;
  if (step) value = Math.ceil(value / step - 1e-9) * step;
  if (exclusiveMinimum !== undefined && value <= exclusiveMinimum && step) value += step;
  return integer ? Math.round(value) : value;
}
function exampleString(node: JsonSchema, name: string | undefined): string {
  if (node.format === "uri" || name?.endsWith("_url")) return `https://example.com/${name ?? "file"}`;
  if (node.format === "date-time") return "2026-01-01T00:00:00Z";
  if (node.format === "date") return "2026-01-01";
  let value = "example";
  while (node.minLength !== undefined && Array.from(value).length < node.minLength) value += "x";
  return node.maxLength !== undefined ? Array.from(value).slice(0, node.maxLength).join("") : value;
}
