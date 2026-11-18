import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  FAL_CATEGORIES,
  FalCatalogEntrySchema,
  FalCatalogFileSchema,
  FalDriftReportSchema,
  InputMediaSchema,
  normaliseFalCategory,
  OUTPUT_KINDS,
  TRUST_ORDER,
  type FalCatalogEntry,
  type FalCategory,
  type FalDriftReport,
  type FalPriceRecord,
  type FalVerifiedPin,
  type InputFieldSummary,
  type InputMedia,
  type OutputKind,
  type ProviderId,
  type TrustTier,
} from "../../types/fal-catalog";
import { HiggsfieldSchemaDocSchema, type HiggsfieldSchemaDoc } from "../../types/higgsfield";
import {
  apiModelSource,
  canonicalJson,
  openApiRoutes,
  snapshotFromOpenApi,
  type FalApiModel,
  type FalSchemaSnapshot,
} from "../providers/fal-openapi";
import operationSnapshots from "../providers/schemas/fal-operations.json";

/**
 * Whole-catalogue index (docs/fal-integration.md). Wave 0 holds the read API that other
 * streams code against; stream A adds sync, summaries and drift without changing these signatures.
 */
export const CATALOG_DIR = fileURLToPath(new URL("./fal-catalog", import.meta.url));
/** The index directory; AGENTBROS_FAL_CATALOG_DIR overrides it (tests use a temporary directory). */
export function catalogDir(): string {
  return process.env.AGENTBROS_FAL_CATALOG_DIR ?? CATALOG_DIR;
}
/** Repository-relative default; AGENTBROS_FAL_SCHEMA_CACHE overrides it (tests use a temporary directory). */
export function schemaCacheDir(): string {
  return process.env.AGENTBROS_FAL_SCHEMA_CACHE ?? path.resolve(".cache", "fal-schemas");
}

let memo: { dir: string; entries: Map<string, FalCatalogEntry> } | undefined;
/** Every tracked entry, keyed by endpoint. An absent directory is an empty catalogue. */
export function loadCatalog(dir = catalogDir()): ReadonlyMap<string, FalCatalogEntry> {
  if (memo?.dir === dir) return memo.entries;
  const entries = new Map<string, FalCatalogEntry>();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort()) {
      const file = FalCatalogFileSchema.parse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      for (const entry of file.entries) entries.set(entry.endpoint, entry);
    }
  }
  memo = { dir, entries };
  return entries;
}
/** Drops the memo after a sync writes new files in the same process. */
export function resetCatalogCache(): void {
  memo = undefined;
}
export function findCatalogEntry(endpoint: string, dir = catalogDir()): FalCatalogEntry | undefined {
  return loadCatalog(dir).get(endpoint);
}

export class SchemaNotCachedError extends Error {
  readonly code = "SCHEMA_NOT_CACHED";
  constructor(readonly endpoint: string) {
    super(`No cached schema for ${endpoint}. Run: pnpm fal:sync --schemas ${endpoint}`);
    this.name = "SchemaNotCachedError";
  }
}
/** Reads `<cache>/<sha>.json` and rejects bytes whose hash differs from the name. */
export function readCachedApiModel(sha256: string, cacheDir = schemaCacheDir()): FalApiModel | undefined {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid schema hash.");
  const file = path.join(cacheDir, `${sha256}.json`);
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  if (createHash("sha256").update(bytes).digest("hex") !== sha256)
    throw new Error(`Cached schema ${sha256} fails its hash check; re-run fal:sync --schemas.`);
  return JSON.parse(bytes.toString("utf8")) as FalApiModel;
}
// ---------------------------------------------------------------------------
// Provider-aware read API (docs/higgsfield.md). Every lookup is keyed by
// (provider, endpoint): the same endpoint ID can exist at fal and Higgsfield with different schemas.
// ---------------------------------------------------------------------------

export const HF_CATALOG_DIR = fileURLToPath(new URL("./hf-catalog", import.meta.url));
export const HF_SCHEMA_DIR = fileURLToPath(new URL("../providers/schemas/higgsfield", import.meta.url));
/** AGENTBROS_HF_CATALOG_DIR overrides it (tests use a temporary directory). */
export function hfCatalogDir(): string {
  return process.env.AGENTBROS_HF_CATALOG_DIR ?? HF_CATALOG_DIR;
}
/** Tracked Higgsfield schema docs; AGENTBROS_HF_SCHEMA_DIR overrides it. */
export function hfSchemaDir(): string {
  return process.env.AGENTBROS_HF_SCHEMA_DIR ?? HF_SCHEMA_DIR;
}
export function catalogDirFor(provider: ProviderId): string {
  return provider === "fal" ? catalogDir() : hfCatalogDir();
}

const providerMemo = new Map<string, Map<string, FalCatalogEntry>>();
/** One provider's index, keyed by endpoint. fal delegates to loadCatalog (its memo and its env override). */
export function loadProviderCatalog(
  provider: ProviderId,
  dir = catalogDirFor(provider),
): ReadonlyMap<string, FalCatalogEntry> {
  if (provider === "fal") return loadCatalog(dir);
  const key = `${provider}\0${dir}`;
  const cached = providerMemo.get(key);
  if (cached) return cached;
  const entries = new Map<string, FalCatalogEntry>();
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .sort()) {
      const file = FalCatalogFileSchema.parse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      if ((file.provider ?? "fal") !== provider)
        throw new Error(`${name} belongs to ${file.provider ?? "fal"}, not ${provider}.`);
      for (const entry of file.entries) entries.set(entry.endpoint, entry);
    }
  }
  providerMemo.set(key, entries);
  return entries;
}
export function resetProviderCatalogCache(): void {
  providerMemo.clear();
  resetCatalogCache();
}
export function findProviderEntry(provider: ProviderId, endpoint: string, dir?: string): FalCatalogEntry | undefined {
  return loadProviderCatalog(provider, dir ?? catalogDirFor(provider)).get(endpoint);
}

/** Reads `<dir>/<sha>.json` and rejects a doc whose schema hash differs from the name. */
export function readHiggsfieldSchemaDoc(sha256: string, dir = hfSchemaDir()): HiggsfieldSchemaDoc | undefined {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid schema hash.");
  const file = path.join(dir, `${sha256}.json`);
  if (!existsSync(file)) return undefined;
  const doc = HiggsfieldSchemaDocSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  if (higgsfieldSchemaSha256(doc.schema) !== sha256)
    throw new Error(`Higgsfield schema ${sha256} fails its hash check; re-run hf:sync.`);
  return doc;
}
/** Hash of a Higgsfield input schema: sha256 of its canonical JSON. */
export function higgsfieldSchemaSha256(schema: unknown): string {
  return createHash("sha256").update(canonicalJson(schema)).digest("hex");
}

/**
 * The shape of every Higgsfield completed status (GET /requests/{id}/status), as an output schema
 * so the shared result extraction and catalogue summaries work unchanged.
 */
export const HIGGSFIELD_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    images: { type: "array", items: { $ref: "#/components/schemas/HiggsfieldImage" } },
    video: { $ref: "#/components/schemas/HiggsfieldVideo" },
    audio: { $ref: "#/components/schemas/HiggsfieldAudio" },
    audios: { type: "array", items: { $ref: "#/components/schemas/HiggsfieldAudio" } },
  },
} as const;
const HIGGSFIELD_OUTPUT_COMPONENTS = {
  HiggsfieldImage: {
    type: "object",
    properties: { url: { type: "string" }, content_type: { type: "string" } },
    required: ["url"],
  },
  HiggsfieldVideo: {
    type: "object",
    properties: { url: { type: "string" }, content_type: { type: "string" } },
    required: ["url"],
  },
  HiggsfieldAudio: {
    type: "object",
    properties: { url: { type: "string" }, content_type: { type: "string" } },
    required: ["url"],
  },
} as const;
export function snapshotFromHiggsfieldDoc(
  doc: HiggsfieldSchemaDoc,
  sha256 = higgsfieldSchemaSha256(doc.schema),
): FalSchemaSnapshot {
  return {
    endpoint: doc.endpoint,
    schemaStatus: "discovered",
    schemaSource: doc.docsUrl ?? "https://docs.higgsfield.ai/docs/models.md",
    asOf: doc.asOf,
    sha256,
    input: doc.schema as FalSchemaSnapshot["input"],
    output: HIGGSFIELD_OUTPUT_SCHEMA as unknown as FalSchemaSnapshot["output"],
    schemas: {
      ...HIGGSFIELD_OUTPUT_COMPONENTS,
      ...(isObject(doc.schema.$defs) ? doc.schema.$defs : {}),
    } as unknown as FalSchemaSnapshot["schemas"],
  };
}
/** Request/result schemas of (provider, endpoint); undefined when it is not indexed or has no schema. */
export function resolveProviderSnapshot(
  provider: ProviderId,
  endpoint: string,
  options: { dir?: string; cacheDir?: string; schemaDir?: string } = {},
): FalSchemaSnapshot | undefined {
  if (provider === "fal") return resolveCatalogSnapshot(endpoint, options);
  const entry = findProviderEntry(provider, endpoint, options.dir);
  if (!entry?.schema) return undefined;
  const doc = readHiggsfieldSchemaDoc(entry.schema.sha256, options.schemaDir);
  if (!doc) throw new SchemaNotCachedError(endpoint);
  return snapshotFromHiggsfieldDoc({ ...doc, endpoint, docsUrl: entry.docsUrl ?? doc.docsUrl }, entry.schema.sha256);
}

/**
 * Request/result schemas for a catalogue endpoint, from the hash-pinned cache.
 * Undefined when the endpoint is not in the index or has no schema (realtime, schema-less);
 * SchemaNotCachedError when the index names a schema the cache lacks.
 */
export function resolveCatalogSnapshot(
  endpoint: string,
  options: { dir?: string; cacheDir?: string } = {},
): FalSchemaSnapshot | undefined {
  const entry = findCatalogEntry(endpoint, options.dir);
  if (!entry?.schema) return undefined;
  const model = readCachedApiModel(entry.schema.sha256, options.cacheDir);
  if (!model) throw new SchemaNotCachedError(endpoint);
  return snapshotFromOpenApi(model, String(entry.schema.asOf), entry.schema.sha256);
}

// ---------------------------------------------------------------------------
// Stream A: summaries, entries, drift and writers (pure apart from the two writers)
// ---------------------------------------------------------------------------

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value);
const MAX_ENUM = 64;

/** Resolve local references and allOf wrappers for catalogue summaries; cycles resolve to {}. */
function deref(schema: unknown, components: Record<string, Schema>, seen = new Set<string>(), depth = 0): Schema {
  if (!isObject(schema) || depth > 50) return {};
  let resolved = schema;
  if (typeof schema.$ref === "string") {
    const name = schema.$ref.split("/").at(-1)!;
    if (seen.has(name) || !components[name]) return {};
    seen = new Set([...seen, name]);
    const { $ref: _ref, ...rest } = schema;
    resolved = { ...deref(components[name], components, seen, depth + 1), ...rest };
  }
  if (!Array.isArray(resolved.allOf)) return resolved;
  const { allOf, ...rest } = resolved;
  const parts = [...allOf.map((part) => deref(part, components, new Set(seen), depth + 1)), rest];
  return parts.reduce<Schema>(
    (merged, part) => ({
      ...merged,
      ...part,
      ...(isObject(merged.properties) || isObject(part.properties)
        ? {
            properties: {
              ...(isObject(merged.properties) ? merged.properties : {}),
              ...(isObject(part.properties) ? part.properties : {}),
            },
          }
        : {}),
    }),
    {},
  );
}
const refName = (schema: unknown): string | undefined =>
  isObject(schema) && typeof schema.$ref === "string" ? schema.$ref.split("/").pop() : undefined;
/** The non-null branches of anyOf/oneOf, each dereferenced; a plain schema is its own single branch. */
function branches(schema: unknown, components: Record<string, Schema>): Schema[] {
  const resolved = deref(schema, components);
  const union = (resolved.anyOf ?? resolved.oneOf) as unknown[] | undefined;
  if (!Array.isArray(union)) return [resolved];
  return union.map((item) => deref(item, components)).filter((item) => item.type !== "null");
}
function typeName(schema: Schema): string {
  if (Array.isArray(schema.type)) return (schema.type as string[]).filter((t) => t !== "null").join("|") || "null";
  if (typeof schema.type === "string") return schema.type;
  if (isObject(schema.properties)) return "object";
  if (Array.isArray(schema.enum)) return typeof schema.enum[0] === "number" ? "number" : "string";
  return "unknown";
}
const finite = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Media an input field takes: an explicit `_fal_ui_field` hint, then the field name's words. */
const INPUT_MEDIA_WORDS: ReadonlyArray<[RegExp, InputMedia]> = [
  [/(^|_)(data|zip|archive|dataset)(_|$)/, "file"],
  [/(^|_)(video|videos|clip)(_|$)/, "video"],
  [/(^|_)(audio|audios|voice|speech|song|music|sound|wav|mp3)(_|$)/, "audio"],
  [/(^|_)(image|images|img|frame|mask|photo|picture|texture|face)(_|$)/, "image"],
  [/(^|_)(mesh|model|glb|gltf|obj|3d)(_|$)/, "model3d"],
];
/** Only string fields (or arrays of strings) named `*_url`, `*_urls` or `image`/`video`/`audio` carry media; `num_images` does not. */
function inputMedia(name: string, schema: Schema, item: Schema | undefined, types: string[]): InputMedia | undefined {
  const hint = schema._fal_ui_field ?? item?._fal_ui_field;
  if (typeof hint === "string" && (InputMediaSchema.options as readonly string[]).includes(hint))
    return hint as InputMedia;
  const stringy = types.includes("string") || (types.includes("array") && item?.type === "string");
  if (!stringy || (!/(^|_)urls?$/.test(name) && !/^(image|video|audio)s?$/.test(name))) return undefined;
  for (const [pattern, media] of INPUT_MEDIA_WORDS) if (pattern.test(name)) return media;
  const xfal = (schema["x-fal"] ?? item?.["x-fal"]) as Schema | undefined;
  if (isObject(xfal)) {
    if ("min_fps" in xfal || "max_fps" in xfal) return "video";
    if ("min_width" in xfal || "max_width" in xfal || "max_pixels" in xfal) return "image";
    if ("max_duration" in xfal || "min_duration" in xfal) return "audio";
  }
  return "file";
}

/** One compact row per top-level request field: type, required, enum (≤64), bounds, default and media. */
export function summariseInputs(snapshot: FalSchemaSnapshot): InputFieldSummary[] {
  const components = { ...snapshot.schemas, ...(isObject(snapshot.input.$defs) ? snapshot.input.$defs : {}) } as Record<
    string,
    Schema
  >;
  const input = deref(snapshot.input, components);
  const properties: Schema = { ...(isObject(input.properties) ? input.properties : {}) };
  const collectConditional = (node: Schema, depth = 0): void => {
    if (depth > 50) return;
    for (const key of ["if", "then", "else"]) {
      const branch = node[key];
      if (!isObject(branch)) continue;
      if (isObject(branch.properties))
        for (const [name, field] of Object.entries(branch.properties)) properties[name] ??= field;
      collectConditional(branch, depth + 1);
    }
  };
  collectConditional(input);
  const required = new Set(Array.isArray(input.required) ? (input.required as string[]) : []);
  return Object.keys(properties)
    .sort()
    .map((name) => {
      const raw = deref(properties[name], components);
      const options = branches(properties[name], components);
      const arrayBranch = options.find((option) => option.type === "array");
      const item = arrayBranch ? deref(arrayBranch.items, components) : undefined;
      const types = [...new Set(options.map(typeName))];
      const enumValues = options.flatMap((option) => (Array.isArray(option.enum) ? option.enum : []));
      const primary = options[0] ?? raw;
      const min =
        finite(primary.minimum) ??
        finite(primary.exclusiveMinimum) ??
        finite(primary.minItems) ??
        finite(primary.minLength);
      const max =
        finite(primary.maximum) ??
        finite(primary.exclusiveMaximum) ??
        finite(primary.maxItems) ??
        finite(primary.maxLength);
      const media = inputMedia(name, primary, item, types);
      const summary: InputFieldSummary = { name, type: types.join("|") || "unknown", required: required.has(name) };
      if (
        enumValues.length &&
        enumValues.length <= MAX_ENUM &&
        enumValues.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value))
      )
        summary.enum = enumValues as InputFieldSummary["enum"];
      if (min !== undefined) summary.min = min;
      if (max !== undefined) summary.max = max;
      if (raw.default !== undefined) summary.default = raw.default;
      if (media) summary.media = media;
      if (arrayBranch) summary.array = true;
      return summary;
    });
}

/**
 * Output kind heuristics in one table, first match wins. `file` rows apply to file-like fields
 * (an object with `url`), `value` rows to everything else. Stream C extracts exact artifacts per result.
 */
const OUTPUT_RULES: ReadonlyArray<{ test: RegExp; kind: OutputKind; applies: "file" | "value" | "any" }> = [
  { test: /safetensors|(^|_)lora(_|$)|weights|checkpoint/, kind: "weights", applies: "file" },
  {
    test: /(^|_)(glb|gltf|mesh|obj|usdz|fbx|ply|3d)(_|$)|^model(_|s$|$)|^model_urls$|point_cloud|rigged|animation/,
    kind: "model3d",
    applies: "file",
  },
  {
    test: /(^|_)(images?|image_url|mask|masks|frames?|thumbnail|depth|normal|texture)(_|$)/,
    kind: "image",
    applies: "file",
  },
  { test: /(^|_)(videos?|clip)(_|$)/, kind: "video", applies: "file" },
  {
    test: /(^|_)(audios?|speech|voice|song|music|sound|soundtrack|vocals?|stems?|wav|mp3)(_|$)/,
    kind: "audio",
    applies: "file",
  },
  {
    test: /^(text|transcript|transcription|output|output_text|lyrics|content|answer|response|reasoning|caption|description|result)$/,
    kind: "text",
    applies: "value",
  },
  { test: /^(chunks|words|segments|utterances|sentences)$/, kind: "text", applies: "value" },
];
/** File schema names whose kind is evident: `Image`, `Video`, `Audio`, `File` ... */
const FILE_REF_KINDS: ReadonlyArray<[RegExp, OutputKind]> = [
  [/image/i, "image"],
  [/video/i, "video"],
  [/audio/i, "audio"],
];
/** Bookkeeping fields: never a deliverable. */
const IGNORED_OUTPUTS =
  /^(seed|seeds|timings|has_nsfw_concepts|nsfw_content_detected|prompt|revised_prompt|request_id|width|height|duration|fps|num_frames|status|error|logs|metrics|enable_safety_checker)$/;
const isFileSchema = (schema: Schema) => isObject(schema.properties) && "url" in schema.properties;

function fileKind(
  name: string,
  ref: string,
  file: Schema,
  components: Record<string, Schema>,
  exampleMime?: string,
): OutputKind {
  const byName = OUTPUT_RULES.find((rule) => rule.applies !== "value" && rule.test.test(name))?.kind;
  if (byName) return byName;
  const contentType = deref((file.properties as Schema).content_type, components);
  const mime =
    exampleMime ??
    ([contentType.default, ...branches(contentType, components).map((b) => b.default)].find(
      (value) => typeof value === "string",
    ) as string | undefined);
  return FILE_REF_KINDS.find(([pattern]) => pattern.test(ref) || pattern.test(mime ?? ""))?.[1] ?? "file";
}
export function summariseOutputs(snapshot: FalSchemaSnapshot): FalCatalogEntry["outputs"] {
  const components = snapshot.schemas as Record<string, Schema>;
  const output = deref(snapshot.output, components);
  const properties = isObject(output.properties) ? output.properties : {};
  const kinds = new Set<OutputKind>();
  const fields: string[] = [];
  const leftovers: string[] = [];
  for (const name of Object.keys(properties).sort()) {
    if (IGNORED_OUTPUTS.test(name)) continue;
    const field = isObject(properties[name]) ? properties[name] : {};
    const examples = Array.isArray(field.examples) ? field.examples : [];
    const exampleMime = examples
      .map((example) => (isObject(example) ? example.content_type : undefined))
      .find((value) => typeof value === "string") as string | undefined;
    const fileKinds = new Set<OutputKind>();
    let structured = false;
    for (const option of branches(properties[name], components)) {
      const array = option.type === "array";
      const item = array ? deref(option.items, components) : option;
      if (isFileSchema(item)) {
        const ref = refName(array ? option.items : option) ?? (typeof item.title === "string" ? item.title : "");
        fileKinds.add(fileKind(name, ref, item, components, exampleMime));
      } else if (
        array ||
        item.type === "object" ||
        isObject(item.properties) ||
        item.additionalProperties !== undefined
      )
        structured = true;
    }
    const kinds_ = fileKinds.size
      ? [...fileKinds]
      : [
          OUTPUT_RULES.find((rule) => rule.applies !== "file" && rule.test.test(name))?.kind ??
            (structured ? "json" : undefined),
        ].filter((kind): kind is OutputKind => !!kind);
    if (!kinds_.length) {
      leftovers.push(name);
      continue;
    }
    for (const kind of kinds_) kinds.add(kind);
    fields.push(name);
  }
  // Nothing recognisable (an empty or free-form output, plain ids and counters): the result is JSON.
  if (!kinds.size) {
    kinds.add("json");
    fields.push(...leftovers);
  }
  return { kinds: OUTPUT_KINDS.filter((kind) => kinds.has(kind)), fields };
}

const ENDPOINT_ID = /^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/;
export const isFalEndpointId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 200 && ENDPOINT_ID.test(value);
type Routing = NonNullable<FalCatalogEntry["routing"]>;
/** Legacy family routing of the original snapshot endpoints; the `/stream` routes are modes of their base endpoint. */
export const LEGACY_ROUTING: ReadonlyMap<string, Routing> = new Map(
  (
    operationSnapshots as Array<{
      endpoint: string;
      family: string;
      variant: string;
      operation: string;
      region: string;
    }>
  )
    .filter((row) => !row.endpoint.endsWith("/stream"))
    .map((row) => [
      row.endpoint,
      { family: row.family, variant: row.variant, operation: row.operation, region: row.region },
    ]),
);

export type CatalogEntryOptions = {
  /** Sync date (YYYY-MM-DD): lastSeen, firstSeen of a new entry, schema asOf. */
  today: string;
  previous?: FalCatalogEntry;
  verifiedPins: Readonly<Record<string, FalVerifiedPin>>;
  /** A dated Platform API price; when omitted, the previous entry's price is kept. */
  priceFor?: (endpoint: string) => FalPriceRecord | undefined;
  /** The hash of the bytes written to the schema cache (writeCachedApiModel); defaults to cachedApiModelSha256 with cached:false. */
  schema?: NonNullable<FalCatalogEntry["schema"]>;
};

/**
 * One index entry from a Platform API model object (listing or lookup). Without `openapi` the
 * previous entry's schema and summaries are kept; with `openapi` but no queue routes the endpoint
 * is schema-less (realtime) and non-executable. Never `live`; `gone` is set by sync, not here.
 */
export function buildCatalogEntry(apiModel: FalApiModel, options: CatalogEntryOptions): FalCatalogEntry {
  const { previous, today } = options;
  const endpoint = apiModel.endpoint_id;
  const metadata = apiModel.metadata ?? {};
  const category =
    metadata.category === undefined && previous ? previous.category : normaliseFalCategory(metadata.category);
  let schema: FalCatalogEntry["schema"] = previous?.schema ?? null;
  let inputs = previous?.inputs ?? [];
  let outputs = previous?.outputs ?? { kinds: [], fields: [] };
  let schemaLess = false;
  if (apiModel.openapi) {
    if (openApiRoutes(apiModel)) {
      schema = options.schema ?? {
        sha256: cachedApiModelSha256(apiModel),
        asOf: today,
        source: apiModelSource(endpoint),
        cached: false,
      };
      const snapshot = snapshotFromOpenApi(apiModel, today, schema.sha256);
      inputs = summariseInputs(snapshot);
      outputs = summariseOutputs(snapshot);
    } else {
      schema = null;
      inputs = [];
      outputs = { kinds: [], fields: [] };
      schemaLess = true;
    }
  }
  const transport: FalCatalogEntry["transport"] =
    /realtime/i.test(endpoint) || schemaLess
      ? "realtime"
      : category === "training"
        ? "training"
        : previous?.transport && previous.transport !== "realtime"
          ? previous.transport
          : "queue";
  const observed = options.priceFor ? options.priceFor(endpoint) : undefined;
  const price: FalCatalogEntry["price"] = options.priceFor
    ? observed
      ? {
          unitPrice: observed.unitPrice,
          unit: observed.unit,
          currency: observed.currency,
          observedAsOf: observed.observedAsOf,
          source: observed.source,
        }
      : null
    : (previous?.price ?? null);
  const retiresAt = isoInstant(apiModel.retires_at);
  const replacement = isFalEndpointId(apiModel.replacement) ? apiModel.replacement : undefined;
  const routing = LEGACY_ROUTING.get(endpoint);
  const entry: FalCatalogEntry = {
    endpoint,
    category,
    displayName:
      typeof metadata.display_name === "string" ? metadata.display_name : (previous?.displayName ?? endpoint),
    status: metadata.status === "deprecated" ? "deprecated" : "active",
    ...(retiresAt ? { retiresAt } : {}),
    ...(replacement ? { replacement } : {}),
    firstSeen: previous?.firstSeen ?? today,
    lastSeen: today,
    schema,
    inputs,
    outputs,
    transport,
    price,
    tier: catalogTier(endpoint, schema, price, options.verifiedPins),
    ...(routing ? { routing } : {}),
    tags: Array.isArray(metadata.tags)
      ? metadata.tags.filter((tag): tag is string => typeof tag === "string")
      : (previous?.tags ?? []),
  };
  return FalCatalogEntrySchema.parse(entry);
}
/** A retirement date in any parseable form as an ISO instant; unreadable values are dropped. */
function isoInstant(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
/** verified: pinned with a matching (or not yet pinned) hash; priced: a dated price; else discovered. No schema is always discovered. */
export function catalogTier(
  endpoint: string,
  schema: FalCatalogEntry["schema"],
  price: FalCatalogEntry["price"],
  pins: Readonly<Record<string, FalVerifiedPin>>,
): TrustTier {
  if (!schema) return "discovered";
  const pin = pins[endpoint];
  if (pin && (pin.catalogSha256 === null || pin.catalogSha256 === schema.sha256)) return "verified";
  return price ? "priced" : "discovered";
}

function demotionReason(before: FalCatalogEntry, after: FalCatalogEntry): string {
  if (!after.schema) return "no schema";
  if (before.schema && before.schema.sha256 !== after.schema.sha256)
    return `schema hash changed ${before.schema.sha256.slice(0, 12)} → ${after.schema.sha256.slice(0, 12)}`;
  if (before.tier === "verified") return "verified pin missing or its hash differs";
  if (before.price && !after.price) return "price record gone";
  return "tier lowered";
}
/** What changed between two indexes. priceDrift is computed by models/fal-pricing.ts and passed through. */
export function computeDrift(
  previousEntries: Iterable<FalCatalogEntry>,
  nextEntries: Iterable<FalCatalogEntry>,
  options: { generatedAt?: string; priceDrift?: FalDriftReport["priceDrift"] } = {},
): FalDriftReport {
  const before = new Map([...previousEntries].map((entry) => [entry.endpoint, entry]));
  const report: FalDriftReport = {
    version: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    added: [],
    gone: [],
    schemaChanged: [],
    retiring: [],
    priceDrift: [...(options.priceDrift ?? [])],
    demoted: [],
  };
  for (const entry of [...nextEntries].sort((a, b) => a.endpoint.localeCompare(b.endpoint))) {
    const old = before.get(entry.endpoint);
    if (!old && entry.status !== "gone") report.added.push(entry.endpoint);
    if (entry.status === "gone" && old?.status !== "gone") report.gone.push(entry.endpoint);
    if (old?.schema && entry.schema && old.schema.sha256 !== entry.schema.sha256)
      report.schemaChanged.push({ endpoint: entry.endpoint, from: old.schema.sha256, to: entry.schema.sha256 });
    if (
      entry.retiresAt &&
      entry.status !== "gone" &&
      (old?.retiresAt !== entry.retiresAt || old?.replacement !== entry.replacement)
    )
      report.retiring.push({
        endpoint: entry.endpoint,
        retiresAt: entry.retiresAt,
        ...(entry.replacement ? { replacement: entry.replacement } : {}),
      });
    if (old && TRUST_ORDER[entry.tier] < TRUST_ORDER[old.tier])
      report.demoted.push({
        endpoint: entry.endpoint,
        from: old.tier,
        to: entry.tier,
        reason: demotionReason(old, entry),
      });
  }
  return FalDriftReportSchema.parse(report);
}

/**
 * Writes one `<category>.json` per category present (entries sorted by endpoint, validated) and removes
 * category files no longer needed. Only `<known category>.json` names inside `dir` are ever removed.
 * With `only`, files outside those categories are neither written nor removed (left byte-identical).
 */
export function writeCatalog(
  entries: Iterable<FalCatalogEntry>,
  dir: string,
  options: { syncedAt?: string; provider?: ProviderId; only?: ReadonlySet<FalCategory> } = {},
): string[] {
  const syncedAt = options.syncedAt ?? new Date().toISOString().slice(0, 10);
  const groups = new Map<FalCategory, FalCatalogEntry[]>();
  for (const entry of entries) groups.set(entry.category, [...(groups.get(entry.category) ?? []), entry]);
  const only = options.only;
  const files = [...groups]
    .filter(([category]) => !only || only.has(category))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, list]) =>
      FalCatalogFileSchema.parse({
        version: 1,
        ...(options.provider ? { provider: options.provider } : {}),
        category,
        syncedAt,
        entries: [...list].sort((a, b) => (a.endpoint < b.endpoint ? -1 : a.endpoint > b.endpoint ? 1 : 0)),
      }),
    );
  mkdirSync(dir, { recursive: true });
  const written: string[] = [];
  for (const file of files) {
    const target = path.join(dir, `${file.category}.json`);
    writeAtomic(target, `${JSON.stringify(file, null, 2)}\n`);
    written.push(target);
  }
  const keep = new Set(files.map((file) => `${file.category}.json`));
  for (const name of readdirSync(dir)) {
    const category = name.slice(0, -5) as FalCategory;
    if (
      !keep.has(name) &&
      name.endsWith(".json") &&
      (FAL_CATEGORIES as readonly string[]).includes(category) &&
      (!only || only.has(category))
    )
      rmSync(path.join(dir, name));
  }
  resetProviderCatalogCache();
  return written;
}
function writeAtomic(target: string, content: string | Buffer): void {
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, target);
}

/**
 * Listing state that changes without the model changing: per-account flags and site presentation.
 * Dropped before hashing so a pin is not demoted by a new thumbnail or by who asked.
 */
export const VOLATILE_METADATA = [
  "is_favorited",
  "pinned",
  "highlighted",
  "updated_at",
  "thumbnail_url",
  "thumbnail_animated_url",
] as const;
/**
 * The API model as cached: without VOLATILE_METADATA and without `retires_at`/`replacement`, which the
 * index entry carries, so an announced retirement is reported as retiring, not as a schema change.
 */
export function cacheableApiModel(model: FalApiModel): FalApiModel {
  const { retires_at: _retires, replacement: _replacement, ...rest } = model;
  if (!rest.metadata) return rest;
  const metadata = { ...rest.metadata };
  for (const key of VOLATILE_METADATA) delete metadata[key];
  return { ...rest, metadata };
}
/** Writes the canonical bytes to `<cache>/<sha256>.json` and returns that hash (readCachedApiModel reads it back). */
export function writeCachedApiModel(model: FalApiModel, cacheDir = schemaCacheDir()): string {
  const bytes = Buffer.from(canonicalJson(cacheableApiModel(model)), "utf8");
  const sha = createHash("sha256").update(bytes).digest("hex");
  mkdirSync(cacheDir, { recursive: true });
  const target = path.join(cacheDir, `${sha}.json`);
  if (!existsSync(target)) writeAtomic(target, bytes);
  return sha;
}
/** The canonical hash a model would be cached under, without writing. */
export function cachedApiModelSha256(model: FalApiModel): string {
  return createHash("sha256")
    .update(canonicalJson(cacheableApiModel(model)), "utf8")
    .digest("hex");
}
