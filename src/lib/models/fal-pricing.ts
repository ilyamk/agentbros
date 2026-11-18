import type { FalUnitSemantics } from "../../types/fal-unit-semantics";
import { falPagePriceDrift, falSemanticsAgree, loadFalUnitSemantics } from "./fal-docs-pricing";
import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  FalPriceRecordSchema,
  type FalCatalogEntry,
  type FalCategory,
  type FalDriftReport,
  type FalPriceRecord,
} from "../../types/fal-catalog";
import type { FixedQuantity, PricingDefinition } from "../../types/models";
import { platformPricingSourceUrl, FAL_PLATFORM_PRICING_API } from "../../types/pricing-evidence";
import { publicTariff, type PublicTariff } from "./public-tariffs";
import { findCatalogEntry } from "./fal-catalog";

/**
 * fal Platform pricing API records (docs/fal-integration.md, "Prices").
 * Records are list prices, not account prices or invoices. A reviewed public tariff
 * always wins; a record never overwrites one, it only shows up as drift.
 */
export const FAL_PRICES_FILE = fileURLToPath(new URL("./fal-prices.json", import.meta.url));
/** AGENTBROS_FAL_PRICES points at another file (tests, dry runs); the tracked file otherwise. */
export function falPricesPath(): string {
  return process.env.AGENTBROS_FAL_PRICES ?? FAL_PRICES_FILE;
}

export const FalPricesFileSchema = z
  .object({
    version: z.literal(1),
    syncedAt: z.union([z.iso.date(), z.iso.datetime()]).nullable(),
    prices: z.array(FalPriceRecordSchema),
  })
  .strict()
  .superRefine((file, ctx) => {
    const ids = file.prices.map((record) => record.endpoint);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({ code: "custom", path: ["prices"], message: "Duplicate endpoint." });
    if (ids.join("\n") !== [...ids].sort().join("\n"))
      ctx.addIssue({ code: "custom", path: ["prices"], message: "Prices must be sorted by endpoint." });
  });
export type FalPricesFile = z.infer<typeof FalPricesFileSchema>;

let memo: { file: string; records: Map<string, FalPriceRecord> } | undefined;
/** Every tracked record keyed by endpoint, validated; memoised per file path. */
export function loadFalPrices(file = falPricesPath()): ReadonlyMap<string, FalPriceRecord> {
  if (memo?.file === file) return memo.records;
  const parsed = FalPricesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const records = new Map(parsed.prices.map((record) => [record.endpoint, Object.freeze(record)]));
  memo = { file, records };
  return records;
}
export function resetFalPricesCache(): void {
  memo = undefined;
}
export function findFalPriceRecord(endpoint: string, file?: string): FalPriceRecord | undefined {
  return loadFalPrices(file).get(endpoint);
}

/** Units that count outputs or requests, before the category gate. */
const COUNT_UNITS = new Set([
  "images",
  "image",
  "audios",
  "audio",
  "generations",
  "generation",
  "units",
  "unit",
  "requests",
  "request",
]);
/** Categories whose result is generated media: only there does a count of outputs bound the bill. */
export const OUTPUT_CATEGORIES: ReadonlySet<FalCategory> = new Set<FalCategory>([
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "audio-to-video",
  "text-to-audio",
  "text-to-speech",
  "image-to-3d",
  "text-to-3d",
  "3d-to-3d",
]);
export const GENERATED_SECOND_CATEGORIES: ReadonlySet<FalCategory> = new Set<FalCategory>([
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "audio-to-video",
  "text-to-audio",
  "text-to-speech",
  "video-to-audio",
]);
export const MEGAPIXEL_CATEGORIES: ReadonlySet<FalCategory> = new Set<FalCategory>(["text-to-image", "image-to-image"]);
export const CHARACTER_CATEGORIES: ReadonlySet<FalCategory> = new Set<FalCategory>([
  "text-to-speech",
  "speech-to-speech",
]);
export const INPUT_MINUTE_CATEGORIES: ReadonlySet<FalCategory> = new Set<FalCategory>([
  "speech-to-text",
  "audio-to-text",
]);
/** Input fields that let the caller set how many outputs one request makes. */
export const COUNT_FIELDS: ReadonlySet<string> = new Set(["num_images", "num_outputs", "num_generations"]);

/** What the catalogue says about an endpoint; the unit alone never bounds a price. */
export type PricingContext = {
  category: FalCategory;
  transport: FalCatalogEntry["transport"];
  inputFields: readonly string[];
  fps?: number;
};
export function pricingContext(entry: FalCatalogEntry): PricingContext {
  const fps = entry.inputs.find((input) => ["fps", "frames_per_second"].includes(input.name))?.default;
  return {
    category: entry.category,
    transport: entry.transport,
    inputFields: entry.inputs.map((input) => input.name),
    ...(typeof fps === "number" && Number.isFinite(fps) && fps > 0 ? { fps } : {}),
  };
}
function unknownFor(record: Pick<FalPriceRecord, "unit" | "unitPrice">, why: string): PricingDefinition {
  return { kind: "unknown", reason: `Priced ${record.unitPrice} USD per '${record.unit}': ${why}.` };
}
/** Positive tariff amounts on the page (before any example), none equal to the API unit price: the reason; otherwise undefined. */
export function pageContradictsApiRate(semantics: FalUnitSemantics, unitPrice: number): string | undefined {
  if (semantics.reason === "Page repeats the API unit") return undefined;
  const tariff = semantics.evidence.quote.split(/For example/i)[0]!;
  const amounts = [...tariff.matchAll(/\$\s?(\d+(?:\.\d+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((amount) => amount > 0);
  if (!amounts.length || amounts.some((amount) => Math.abs(amount - unitPrice) < 1e-9)) return undefined;
  return `model page tariff ($${amounts.slice(0, 4).join(", $")}) does not contain the API unit price $${unitPrice}; the API unit is not the billed rate`;
}
/**
 * The plan's unit table, gated by the endpoint's catalogue category, transport and input fields
 * (docs/fal-integration.md, "Prices"). A unit bounds a quote only where the category says the
 * counted quantity is what fal bills; everything else, and any endpoint without a catalogue entry,
 * is unknown, so it needs an authorised --max-cost-usd.
 */
export function pricingFromRecord(
  record: Pick<FalPriceRecord, "unit" | "unitPrice"> & Partial<Pick<FalPriceRecord, "endpoint">>,
  context?: PricingContext,
  semantics?: FalUnitSemantics,
): PricingDefinition {
  const unit = record.unit.trim().toLowerCase();
  if (!(record.unitPrice > 0)) return unknownFor(record, "an unreviewed zero is not treated as free");
  // An ambiguous or dimensionally incompatible page adds nothing; explicit scenario tariffs stay planning-only.
  if (
    semantics &&
    semantics.meaning !== "ambiguous" &&
    (!record.endpoint || record.endpoint === semantics.endpoint) &&
    context &&
    context.category !== "training" &&
    context.transport !== "realtime" &&
    falSemanticsAgree(unit, semantics)
  ) {
    // No resolution input: a page tariff by resolution can only describe this endpoint's own fixed output.
    const resolutionFixed =
      !context.inputFields.includes("resolution") && semantics.tiers?.some((tier) => tier.when.resolution)
        ? { resolutionFixed: true }
        : {};
    const fixed = (quantity: FixedQuantity): PricingDefinition => ({
      kind: "fixed",
      quantity,
      usdPerUnit: record.unitPrice,
      falUnit: semantics,
      ...resolutionFixed,
    });
    switch (semantics.meaning) {
      case "generated-second":
      case "output-audio-second":
        return fixed("generated-second");
      case "input-video-second":
        return fixed("input-video-second");
      case "output-image":
        return fixed("output");
      case "request":
        return fixed("request");
      case "input-kilo-characters":
        return fixed("input-kilo-characters");
      case "input-audio-minute":
        return fixed("input-audio-minute");
      case "output-megapixel":
        return {
          kind: "megapixels",
          firstUsd: record.unitPrice,
          extraUsd: record.unitPrice,
          inputExtraUsd: 0,
          falUnit: semantics,
        };
      case "frames":
      case "video-megapixel":
        return {
          kind: "fal-derived",
          usdPerUnit: record.unitPrice,
          falUnit: semantics,
          ...(context.fps !== undefined ? { fps: context.fps } : {}),
        };
    }
  }
  // A page stating its own tariff without the API unit price shows the API unit is not the billed rate
  // (e.g. a base $0.009/s against $0.099/s at 720p): never price from it, for planning or paid admission.
  const contradiction =
    semantics?.meaning === "ambiguous" ? pageContradictsApiRate(semantics, record.unitPrice) : undefined;
  if (contradiction) return unknownFor(record, contradiction);
  if (unit === "1000 tokens")
    return unknownFor(record, "no token forecast contract exists, so usage cannot be bounded");
  if (unit === "compute seconds") return unknownFor(record, "compute time cannot be forecast from the request");
  if (unit === "credits") return unknownFor(record, "credits per request are not published");
  const known =
    COUNT_UNITS.has(unit) ||
    ["seconds", "second", "megapixels", "megapixel", "1000 characters", "minutes", "minute"].includes(unit);
  if (!known) return unknownFor(record, "unrecognised unit; refusing to guess its quantity");
  if (!context)
    return unknownFor(record, "the endpoint has no catalogue entry, so its category cannot confirm the unit");
  const { category } = context;
  if (category === "training")
    return unknownFor(record, "training bills by steps or data, which the request does not bound");
  const fixed = (quantity: FixedQuantity): PricingDefinition => ({
    kind: "fixed",
    usdPerUnit: record.unitPrice,
    quantity,
  });
  const hasCount = context.inputFields.some((field) => COUNT_FIELDS.has(field));
  if (COUNT_UNITS.has(unit)) {
    if (!OUTPUT_CATEGORIES.has(category))
      return unknownFor(record, `a count of outputs or requests does not bound the bill in category ${category}`);
    if (unit === "requests" || unit === "request") return fixed("request");
    if (unit === "units" || unit === "unit")
      return hasCount
        ? fixed("output")
        : unknownFor(record, "'units' is undefined by the API and the input schema has no output-count field");
    if (unit === "generations" || unit === "generation") return fixed(hasCount ? "output" : "request");
    return fixed("output");
  }
  if (unit === "seconds" || unit === "second") {
    if (context.transport === "realtime") return unknownFor(record, "realtime session seconds cannot be forecast");
    return GENERATED_SECOND_CATEGORIES.has(category)
      ? fixed("generated-second")
      : unknownFor(record, `seconds in category ${category} are input or processing time, not generated seconds`);
  }
  if (unit === "megapixels" || unit === "megapixel") {
    return MEGAPIXEL_CATEGORIES.has(category)
      ? { kind: "megapixels", firstUsd: record.unitPrice, extraUsd: record.unitPrice, inputExtraUsd: 0 }
      : unknownFor(record, `megapixels in category ${category} span frames or inputs, not one output image`);
  }
  if (unit === "1000 characters")
    return CHARACTER_CATEGORIES.has(category)
      ? fixed("input-kilo-characters")
      : unknownFor(record, `characters in category ${category} are not the sent text`);
  return INPUT_MINUTE_CATEGORIES.has(category)
    ? fixed("input-audio-minute")
    : unknownFor(record, `output minutes not forecastable in category ${category}`);
}
/** Notes a quote carries for an API-derived definition: what is assumed, not evidenced. */
export function recordNotes(record: Pick<FalPriceRecord, "unit" | "unitPrice">): string {
  const unit = record.unit.trim().toLowerCase();
  const base = `fal pricing API list rate ${record.unitPrice} USD per '${record.unit}'; not an invoice.`;
  if (unit === "megapixels" || unit === "megapixel")
    return `${base} Output megapixels only: an input-megapixel surcharge is not evidenced by the API.`;
  if (unit === "minutes" || unit === "minute")
    return `${base} Exact minutes (input audio seconds / 60); the API does not say whether started minutes are billed whole.`;
  if (unit === "1000 characters") return `${base} ceil(characters / 1000) of the sent text, at least one.`;
  if (unit === "units" || unit === "unit")
    return `${base} 'units' is counted as outputs only because the input schema has an output-count field.`;
  if (unit === "requests" || unit === "request") return `${base} One per request; multiplier counts requests.`;
  return base;
}

export type FalPrice = {
  pricing: PricingDefinition;
  origin: "public-tariff" | "platform-pricing-api";
  source: string;
  observedAsOf: string;
  unit: string;
  notes?: string;
  record?: FalPriceRecord;
};
/**
 * Precedence: a reviewed public tariff, then the pricing API record gated by the endpoint's
 * catalogue entry (no entry: unknown), then nothing.
 */
export function falPriceFor(endpoint: string, file?: string, semantics = loadFalUnitSemantics()): FalPrice | undefined {
  const tariff = publicTariff(endpoint);
  if (tariff)
    return {
      pricing: tariff.pricing,
      origin: "public-tariff",
      source: tariff.evidence.source,
      observedAsOf: tariff.evidence.observedAsOf,
      unit: tariff.evidence.unit,
      notes: tariff.evidence.conditions,
    };
  const record = findFalPriceRecord(endpoint, file);
  if (!record) return undefined;
  const entry = findCatalogEntry(endpoint);
  return {
    pricing: pricingFromRecord(record, entry && pricingContext(entry), semantics.get(endpoint)),
    origin: "platform-pricing-api",
    source: platformPricingSourceUrl(endpoint),
    observedAsOf: String(record.observedAsOf).slice(0, 10),
    unit: record.unit,
    notes: recordNotes(record),
    record,
  };
}

type PriceDrift = FalDriftReport["priceDrift"][number];
const describe = (definition: PricingDefinition): string => JSON.stringify(definition);
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-9;
/** Why the API price disagrees with a reviewed definition, or undefined when it agrees. */
function driftReason(tracked: PricingDefinition, record: FalPriceRecord): string | undefined {
  const unit = record.unit.trim().toLowerCase();
  const price = record.unitPrice;
  switch (tracked.kind) {
    case "fal-derived":
      return tracked.falUnit ? falPagePriceDrift(tracked.falUnit, price) : undefined;
    case "unknown":
      return undefined; // Nothing reviewed to disagree with.
    case "free":
      return price > 0 ? "reviewed as free, API lists a positive price" : undefined;
    case "fixed": {
      if (!same(tracked.usdPerUnit, price)) return `rate ${price} differs from reviewed ${tracked.usdPerUnit}`;
      // Unit agreement only (the reviewed tariff already fixes the category): seconds vs per-second.
      const quantities: Partial<Record<FixedQuantity, readonly string[]>> = {
        "generated-second": ["seconds", "second"],
        "input-video-second": ["seconds", "second"],
        "input-kilo-characters": ["1000 characters"],
        "input-audio-minute": ["minutes", "minute"],
        request: ["requests", "request", "generations", "generation"],
        output: [...COUNT_UNITS],
      };
      if (tracked.quantity && !quantities[tracked.quantity]?.includes(unit))
        return `unit mismatch: reviewed quantity ${tracked.quantity}, API unit '${record.unit}'`;
      return undefined;
    }
    case "range":
      return price < tracked.lowUsdPerUnit - 1e-9 || price > tracked.highUsdPerUnit + 1e-9
        ? `rate ${price} outside reviewed range [${tracked.lowUsdPerUnit}, ${tracked.highUsdPerUnit}]`
        : undefined;
    case "megapixels":
      if (unit !== "megapixels") return `unit mismatch: reviewed per megapixel, API unit '${record.unit}'`;
      return same(tracked.firstUsd, price) || same(tracked.extraUsd, price)
        ? undefined
        : `rate ${price} matches neither reviewed first (${tracked.firstUsd}) nor extra (${tracked.extraUsd}) megapixel`;
    case "tokens": {
      if (unit !== "1000 tokens")
        return `unit mismatch: reviewed per million tokens by category, API unit '${record.unit}'`;
      const perMillion = price * 1000;
      return Object.values(tracked.ratesPerMillion).some((rate) => rate !== undefined && same(rate, perMillion))
        ? undefined
        : `unit mismatch: API ${perMillion} per million tokens matches no reviewed token category`;
    }
    case "video-tokens": {
      if (unit !== "1000 tokens") return `unit mismatch: reviewed per thousand video tokens, API unit '${record.unit}'`;
      const rates = [tracked.usdPerThousand, ...Object.values(tracked.resolutionRates ?? {})].filter(
        (rate): rate is number => rate !== undefined,
      );
      return rates.some((rate) => same(rate, price))
        ? undefined
        : `rate ${price} per thousand tokens matches no reviewed video-token rate (${rates.join(", ")})`;
    }
  }
}
/**
 * Drift between reviewed definitions and API records. Rows are a report only: drift never
 * overwrites a reviewed tariff, and quotes keep using the reviewed definition until a person
 * reviews the endpoint again.
 */
export function comparePrices(
  publicTariffs:
    | Readonly<Record<string, PricingDefinition | PublicTariff>>
    | ((endpoint: string) => PricingDefinition | PublicTariff | undefined),
  records: Iterable<FalPriceRecord>,
  semantics: ReadonlyMap<string, FalUnitSemantics> = loadFalUnitSemantics(),
): PriceDrift[] {
  const lookup =
    typeof publicTariffs === "function"
      ? publicTariffs
      : (endpoint: string) => (Object.hasOwn(publicTariffs, endpoint) ? publicTariffs[endpoint] : undefined);
  const rows: PriceDrift[] = [];
  for (const record of records) {
    const found = lookup(record.endpoint);
    const page = semantics.get(record.endpoint);
    const pageDrift =
      page && falSemanticsAgree(record.unit, page) ? falPagePriceDrift(page, record.unitPrice) : undefined;
    if (pageDrift)
      rows.push({
        endpoint: record.endpoint,
        tracked: `${page!.evidence.url} (${page!.evidence.observedAsOf}): ${page!.evidence.quote}`,
        observed: pageDrift,
      });
    if (!found) continue;
    const tracked = "pricing" in found ? found.pricing : found;
    const reason = driftReason(tracked, record);
    if (reason)
      rows.push({
        endpoint: record.endpoint,
        tracked: describe(tracked),
        observed: `${record.unitPrice} ${record.currency} per '${record.unit}' (${String(record.observedAsOf).slice(0, 10)}): ${reason}`,
      });
  }
  return rows.sort((a, b) => a.endpoint.localeCompare(b.endpoint));
}

export class FalPricingSyncError extends Error {
  constructor(
    readonly code: "MISSING_API_KEY" | "RATE_LIMIT" | "NETWORK" | "TIMEOUT" | "VALIDATION",
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "FalPricingSyncError";
  }
}
export type FalPricingSyncResult = {
  records: FalPriceRecord[];
  skipped: { endpoint: string; reason: string }[];
  /** Requested endpoints the API returned no price for. */
  unpriced: string[];
  /** Requested endpoints the pricing service explicitly returned as not found. */
  notFound: string[];
  requests: number;
  completedBatches?: number;
  totalBatches?: number;
  partial?: boolean;
  failure?: string;
};
type FetchLike = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;
export const FAL_PRICING_BATCH = 40;
const ApiPageSchema = z
  .object({
    prices: z.array(
      z
        .object({ endpoint_id: z.string(), unit_price: z.number(), unit: z.string(), currency: z.string() })
        .passthrough(),
    ),
    has_more: z.boolean().optional(),
    next_cursor: z.string().nullable().optional(),
  })
  .passthrough();
/** fetch() hides the socket error in `cause` (ECONNRESET, ENOTFOUND, UND_ERR_*): keep it in the report. */
function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const detail = cause?.code ?? cause?.message;
  return detail ? `${error.message} (${detail})` : error.message;
}
function retryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}
/**
 * Free read-only GET of list prices, batched by 40 endpoint IDs with cursor pagination.
 * Unknown IDs are isolated by halving failed batches (at most 2N - B nodes for N IDs in B batches).
 * 429 waits Retry-After (or exponential backoff) and retries a bounded number of times.
 */
export async function syncFalPrices(
  endpoints: readonly string[],
  fetchImpl: FetchLike,
  options: {
    now?: Date;
    apiKey?: string;
    timeoutMs?: number;
    maxRetries?: number;
    maxWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
    batchSize?: number;
    onProgress?: (done: number, total: number) => void;
    checkpointFile?: string;
    resume?: boolean;
    partial?: boolean;
    deadlineMs?: number;
    clock?: () => number;
    staleness?: ReadonlyMap<string, string>;
  } = {},
): Promise<FalPricingSyncResult> {
  const apiKey = options.apiKey ?? process.env.FAL_KEY;
  if (!apiKey) throw new FalPricingSyncError("MISSING_API_KEY", "FAL_KEY is required to read the fal pricing API.");
  const observedAsOf = (options.now ?? new Date()).toISOString().slice(0, 10);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxRetries = options.maxRetries ?? 6;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxWaitMs = options.maxWaitMs ?? 60_000;
  const batchSize = Math.min(FAL_PRICING_BATCH, Math.max(1, options.batchSize ?? FAL_PRICING_BATCH));
  // Stalest first (never observed, then oldest observedAsOf): a time-boxed daily run rotates through the whole catalogue.
  const staleness = options.staleness;
  const unique = [...new Set(endpoints)].sort((a, b) =>
    staleness
      ? (staleness.get(a) ?? "").localeCompare(staleness.get(b) ?? "") || a.localeCompare(b)
      : a.localeCompare(b),
  );
  const clock = options.clock ?? Date.now;
  const found = new Map<string, FalPriceRecord>();
  const skipped: FalPricingSyncResult["skipped"] = [];
  const notFound: string[] = [];
  let requests = 0;
  const checkpointSchema = z.object({
    date: z.string(),
    batch: z.array(z.string()),
    records: z.array(FalPriceRecordSchema),
    skipped: z.array(z.object({ endpoint: z.string(), reason: z.string() })),
    notFound: z.array(z.string()),
  });
  const checkpoints = new Map<string, z.infer<typeof checkpointSchema>>();
  if (options.resume && options.checkpointFile && existsSync(options.checkpointFile)) {
    const contents = readFileSync(options.checkpointFile, "utf8");
    const complete = contents.slice(0, contents.lastIndexOf("\n") + 1);
    if (complete.length !== contents.length) truncateSync(options.checkpointFile, Buffer.byteLength(complete));
    for (const line of complete.split("\n").filter(Boolean)) {
      const row = checkpointSchema.parse(JSON.parse(line));
      if (row.date === observedAsOf) checkpoints.set(JSON.stringify(row.batch), row);
    }
  }
  let completedBatches = 0;
  let failure: string | undefined;
  const get = async (url: string): Promise<z.infer<typeof ApiPageSchema> | undefined> => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Awaited<ReturnType<FetchLike>>;
      let status: number;
      let body = "";
      let json: unknown;
      let retryHeader: string | null;
      try {
        requests++;
        response = await fetchImpl(url, {
          headers: { Authorization: `Key ${apiKey}`, Accept: "application/json" },
          signal: controller.signal,
        });
        status = response.status;
        retryHeader = response.headers.get("retry-after");
        // The body is read under the same deadline: a stalled body must not hang the sync.
        if (response.ok)
          json = await response.json().catch((error: unknown) => {
            if (controller.signal.aborted) throw error;
            throw new FalPricingSyncError("VALIDATION", "Pricing API answered with non-JSON.");
          });
        else if (status !== 429) body = await response.text();
      } catch (error) {
        if (error instanceof FalPricingSyncError) throw error;
        const failure = controller.signal.aborted
          ? new FalPricingSyncError("TIMEOUT", `Pricing API did not answer within ${timeoutMs} ms.`)
          : new FalPricingSyncError("NETWORK", `Pricing API request failed: ${describeFetchError(error)}`);
        // A free, idempotent GET: transient failures are retried with backoff, then reported.
        if (attempt >= maxRetries) throw failure;
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }
      if (status === 429) {
        const wait = retryAfter(retryHeader, Date.now()) ?? 1000 * 2 ** attempt;
        if (attempt >= maxRetries || wait > maxWaitMs)
          throw new FalPricingSyncError("RATE_LIMIT", "Pricing API kept rate limiting.", wait);
        await sleep(wait);
        continue;
      }
      if (status >= 500 && attempt < maxRetries) {
        await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        continue;
      }
      if (status === 401 || status === 403)
        throw new FalPricingSyncError("MISSING_API_KEY", `Pricing API rejected the key (HTTP ${status}).`);
      if (!response.ok) {
        if (status === 404) {
          try {
            const missing = z.object({ error: z.object({ type: z.literal("not_found") }) }).safeParse(JSON.parse(body));
            if (missing.success) return undefined;
          } catch {
            /* Non-JSON errors keep the usual HTTP failure. */
          }
        }
        throw new FalPricingSyncError("NETWORK", `Pricing API HTTP ${status}: ${body.slice(0, 300)}`);
      }
      const page = ApiPageSchema.safeParse(json);
      if (!page.success)
        throw new FalPricingSyncError("VALIDATION", `Unexpected pricing API shape: ${page.error.message}`);
      return page.data;
    }
  };
  const syncBatch = async (batch: string[]): Promise<void> => {
    let cursor: string | null | undefined;
    const seen = new Set<string>();
    do {
      const params = new URLSearchParams();
      for (const endpoint of batch) params.append("endpoint_id", endpoint);
      if (cursor) params.set("cursor", cursor);
      const page = await get(`${FAL_PLATFORM_PRICING_API}?${params.toString()}`);
      if (!page) {
        if (batch.length === 1) {
          notFound.push(batch[0]!);
          return;
        }
        const middle = Math.floor(batch.length / 2);
        await syncBatch(batch.slice(0, middle));
        await syncBatch(batch.slice(middle));
        return;
      }
      for (const row of page.prices) {
        if (row.currency !== "USD") {
          skipped.push({ endpoint: row.endpoint_id, reason: `currency ${row.currency} is not USD` });
          continue;
        }
        const parsed = FalPriceRecordSchema.safeParse({
          endpoint: row.endpoint_id,
          unitPrice: row.unit_price,
          unit: row.unit,
          currency: "USD",
          observedAsOf,
          source: "platform-pricing-api",
        });
        if (!parsed.success) {
          skipped.push({
            endpoint: row.endpoint_id,
            reason: `invalid record: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
          });
          continue;
        }
        found.set(parsed.data.endpoint, parsed.data);
      }
      const next = page.has_more ? page.next_cursor : null;
      if (next && seen.has(next)) throw new FalPricingSyncError("VALIDATION", "Pricing API repeated a cursor.");
      if (next) seen.add(next);
      cursor = next;
    } while (cursor);
  };
  for (let index = 0; index < unique.length; index += batchSize) {
    const batch = unique.slice(index, index + batchSize);
    const cached = checkpoints.get(JSON.stringify(batch));
    const before = new Map(found),
      skippedStart = skipped.length,
      missingStart = notFound.length;
    if (cached) {
      for (const record of cached.records) found.set(record.endpoint, record);
      skipped.push(...cached.skipped);
      notFound.push(...cached.notFound);
    } else {
      if (options.deadlineMs !== undefined && clock() >= options.deadlineMs) {
        if (!options.partial)
          throw new FalPricingSyncError("TIMEOUT", "Time budget reached before the list price sync completed.");
        failure = "Time budget reached; remaining endpoints keep their previous evidence";
        break;
      }
      try {
        await syncBatch(batch);
      } catch (error) {
        found.clear();
        for (const [key, value] of before) found.set(key, value);
        skipped.length = skippedStart;
        notFound.length = missingStart;
        if (!options.partial) throw error;
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
      if (options.checkpointFile) {
        mkdirSync(path.dirname(options.checkpointFile), { recursive: true });
        appendFileSync(
          options.checkpointFile,
          `${JSON.stringify({ date: observedAsOf, batch, records: batch.flatMap((endpoint) => (found.has(endpoint) ? [found.get(endpoint)!] : [])), skipped: skipped.slice(skippedStart), notFound: notFound.slice(missingStart) })}\n`,
        );
      }
    }
    completedBatches++;
    options.onProgress?.(Math.min(index + batchSize, unique.length), unique.length);
  }
  const records = [...found.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  return {
    records,
    skipped,
    unpriced: unique.filter((endpoint) => !found.has(endpoint) && !skipped.some((row) => row.endpoint === endpoint)),
    notFound,
    requests,
    completedBatches,
    totalBatches: Math.ceil(unique.length / batchSize),
    partial: completedBatches < Math.ceil(unique.length / batchSize),
    ...(failure ? { failure } : {}),
  };
}
/** Tracked file bytes: sorted, validated, newline-terminated. */
export function serialiseFalPrices(records: readonly FalPriceRecord[], syncedAt: string | null): string {
  const file = FalPricesFileSchema.parse({
    version: 1,
    syncedAt,
    prices: [...records].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
  });
  return `${JSON.stringify(file, null, 1)}\n`;
}
