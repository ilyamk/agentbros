/**
 * fal Platform pricing API list prices: sync, show, offline fixtures.
 *
 * Usage:
 *   pnpm fal:pricing --sync [--endpoints a,b] [--dry-run]     # network, free GET; writes src/lib/models/fal-prices.json
 *   pnpm fal:pricing --from-fixtures FILE [--dry-run]         # offline: an API-shaped {prices:[…]} file
 *   pnpm fal:pricing --show ENDPOINT                          # record, converted definition, precedence source
 *
 * A reviewed public tariff always wins over the API price; disagreements are printed as drift and never
 * overwrite it. AGENTBROS_FAL_PRICES points the read/write at another file.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliErrorObject, emitProgress, parseArgs, runScript } from "../src/lib/cli";
import { findCatalogEntry, loadCatalog } from "../src/lib/models/fal-catalog";
import {
  comparePrices,
  falPriceFor,
  falPricesPath,
  FalPricingSyncError,
  loadFalPrices,
  pricingContext,
  pricingFromRecord,
  resetFalPricesCache,
  serialiseFalPrices,
  syncFalPrices,
  type FalPricingSyncResult,
} from "../src/lib/models/fal-pricing";
import { publicTariff } from "../src/lib/models/public-tariffs";
import { MODEL_REGISTRY } from "../src/lib/models/registry";
import { loadModelSlots } from "../src/lib/models/model-slots-loader";
import {
  falHistoricalPricesPath,
  historicalEndpoints,
  loadFalHistoricalPrices,
  syncFalHistoricalPrices,
} from "../src/lib/models/fal-historical-pricing";
import {
  falDocsPricingChanged,
  falUnitSemanticsPath,
  loadFalUnitSemantics,
  parseFalPricingSection,
  syncFalDocsPricing,
} from "../src/lib/models/fal-docs-pricing";
import { FalUnitSemanticsFileSchema } from "../src/types/fal-unit-semantics";
import { quote } from "../src/lib/pricing";

const SPECS = [
  {
    name: "docs",
    type: "boolean",
    description: "Read unit semantics from public model pages (free GET; no key needed)",
  },
  {
    name: "reparse",
    type: "boolean",
    description:
      "With --docs: re-parse every stored Pricing quote offline, retaining observation dates and API snapshots",
  },
  { name: "changed", type: "boolean", description: "Docs scope: only absent semantics or changed API unit/rate" },
  {
    name: "historical",
    type: "boolean",
    description: "Read typical historical per-call prices (free POST; one endpoint per request)",
  },
  {
    name: "slots",
    type: "boolean",
    description: "Historical/docs scope: slot candidates and catalogue successors (default)",
  },
  { name: "all", type: "boolean", description: "Historical/docs scope: whole active fal catalogue" },
  {
    name: "sync",
    type: "boolean",
    description: "Read list prices from the fal pricing API (network, free; needs FAL_KEY)",
  },
  {
    name: "from-fixtures",
    type: "string",
    description: "Offline: convert an API-shaped pricing file instead of the network",
  },
  {
    name: "show",
    type: "string",
    description: "Show one endpoint's record, converted definition and precedence source",
  },
  {
    name: "endpoints",
    type: "string",
    description:
      "Comma-separated endpoint IDs (historical default: slot candidates + successors; sync: catalogue + registry)",
  },
  { name: "resume", type: "boolean", description: "Resume completed batches from the dated checkpoint" },
  { name: "partial", type: "boolean", description: "Write completed batches even if a later batch fails" },
  {
    name: "budget-minutes",
    type: "number",
    description:
      "Time box for --sync/--historical: stop starting new requests after N minutes, write what completed (stalest endpoints go first)",
  },
  { name: "dry-run", type: "boolean", description: "Do not write the prices file" },
  { name: "as-of", type: "string", description: "Observation date YYYY-MM-DD (default: today)" },
] as const;

function toCliError(error: unknown): never {
  if (error instanceof FalPricingSyncError)
    throw new CliErrorObject({
      code: error.code,
      message: error.message,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
    });
  throw error;
}
function contextOf(endpoint: string) {
  const entry = findCatalogEntry(endpoint);
  return entry ? pricingContext(entry) : undefined;
}
function defaultEndpoints(): string[] {
  return [...new Set([...loadCatalog().keys(), ...Object.keys(MODEL_REGISTRY)])].sort();
}
/** A fetch over an API-shaped file: answers each request with the rows it names, one page. */
function fixtureFetch(file: string) {
  const page = JSON.parse(readFileSync(file, "utf8")) as { prices?: { endpoint_id: string }[] };
  if (!Array.isArray(page.prices))
    throw new CliErrorObject({ code: "VALIDATION", message: `${file} has no prices array.` });
  return {
    endpoints: page.prices.map((row) => row.endpoint_id),
    fetch: async (url: string) => {
      const wanted = new Set(new URL(url).searchParams.getAll("endpoint_id"));
      const prices = page.prices!.filter((row) => wanted.has(row.endpoint_id));
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ prices, has_more: false, next_cursor: null }),
        text: async () => "",
      };
    },
  };
}

runScript(async () => {
  const args = parseArgs(SPECS);
  const budget = args["budget-minutes"];
  if (budget !== undefined && !(Number.isFinite(budget) && budget > 0))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--budget-minutes must be a positive number" });
  const deadlineMs = budget === undefined ? undefined : Date.now() + budget * 60_000;
  const modes = [
    args.docs,
    args.historical,
    args.sync,
    args["from-fixtures"] !== undefined,
    args.show !== undefined,
  ].filter(Boolean).length;
  if (modes !== 1)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Choose exactly one of --docs, --historical, --sync, --from-fixtures FILE, --show ENDPOINT.",
    });
  if (((args.slots || args.all) && !(args.historical || args.docs)) || (args.slots && args.all))
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--slots/--all require --historical or --docs and are mutually exclusive",
    });
  if (args.changed && !args.docs)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--changed requires --docs" });
  if (
    args.reparse &&
    (!args.docs || args.changed || args.resume || args.all || args.slots || args.endpoints || args["as-of"])
  )
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--reparse requires --docs and cannot select a scope, date or checkpoint",
    });
  if (args.endpoints && (args.slots || args.all))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--endpoints cannot be combined with --slots/--all" });
  if (args.docs) {
    if (args.reparse) {
      const file = falUnitSemanticsPath();
      const previous = FalUnitSemanticsFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
      const records = previous.records.map((record) => {
        const entry = findCatalogEntry(record.endpoint);
        const defaultMode = entry?.inputs.find((input) => ["mode", "rendering_speed"].includes(input.name))?.default;
        const parsed = parseFalPricingSection(
          `## Pricing\n${record.evidence.quote}`,
          record.endpoint,
          record.evidence.observedAsOf,
          { apiUnit: record.apiSnapshot?.unit, ...(typeof defaultMode === "string" ? { defaultMode } : {}) },
        );
        if (!parsed)
          throw new CliErrorObject({
            code: "VALIDATION",
            message: `Stored quote for ${record.endpoint} no longer contains a Pricing section`,
          });
        return { ...parsed, ...(record.apiSnapshot ? { apiSnapshot: record.apiSnapshot } : {}) };
      });
      const result = FalUnitSemanticsFileSchema.parse({ ...previous, records });
      if (!args["dry-run"]) writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      const counts = (rows: typeof records) =>
        Object.fromEntries(
          [...new Set(rows.map((row) => row.meaning))]
            .sort()
            .map((meaning) => [meaning, rows.filter((row) => row.meaning === meaning).length]),
        );
      return {
        outputs: args["dry-run"] ? [] : [path.relative(process.cwd(), file)],
        metadata: {
          mode: "docs-reparse",
          requests: 0,
          records: records.length,
          before: counts(previous.records),
          after: counts(records),
        },
      };
    }
    const now = args["as-of"] ? new Date(`${args["as-of"]}T00:00:00Z`) : new Date();
    if (!Number.isFinite(now.valueOf()))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid --as-of date" });
    const file = falUnitSemanticsPath(),
      previous = loadFalUnitSemantics(file),
      prices = loadFalPrices();
    const scope = args.endpoints
      ? args.endpoints
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : historicalEndpoints(loadModelSlots(), loadCatalog(), Boolean(args.all));
    const endpoints = args.changed
      ? scope.filter((endpoint) => falDocsPricingChanged(prices.get(endpoint), previous.get(endpoint)))
      : scope;
    const checkpointFile = path.resolve(".cache/fal-docs-pricing", `${now.toISOString().slice(0, 10)}.jsonl`);
    emitProgress(`Reading public pricing pages for ${endpoints.length} endpoints`);
    const defaultModes = new Map(
      endpoints.flatMap((endpoint) => {
        const mode = findCatalogEntry(endpoint)?.inputs.find((input) =>
          ["mode", "rendering_speed"].includes(input.name),
        )?.default;
        return typeof mode === "string" ? [[endpoint, mode] as const] : [];
      }),
    );
    const result = await syncFalDocsPricing(endpoints, (url, init) => fetch(url, init), {
      now,
      previous,
      prices,
      defaultModes,
      resume: Boolean(args.resume),
      ...(!args["dry-run"] ? { checkpointFile } : {}),
    });
    if (!args["dry-run"])
      writeFileSync(
        file,
        `${JSON.stringify({ version: result.version, syncedAt: result.syncedAt, records: result.records }, null, 2)}\n`,
      );
    return {
      outputs: args["dry-run"] ? [] : [path.relative(process.cwd(), file)],
      metadata: {
        mode: "docs",
        partial: result.partial,
        failed: result.failed,
        unpriced: result.unpriced,
        records: result.records.length,
        requests: result.requests,
        checkpointFile,
        syncedAt: result.syncedAt,
        priceDrift: comparePrices(
          () => undefined,
          prices.values(),
          new Map(result.records.map((row) => [row.endpoint, row])),
        ),
      },
    };
  }
  if (args.historical) {
    if (!process.env.FAL_KEY)
      throw new CliErrorObject({ code: "MISSING_API_KEY", message: "FAL_KEY is required for free historical pricing" });
    const now = args["as-of"] ? new Date(`${args["as-of"]}T00:00:00Z`) : new Date();
    if (!Number.isFinite(now.valueOf()))
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid --as-of date" });
    const endpoints = args.endpoints
      ? args.endpoints
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : historicalEndpoints(loadModelSlots(), loadCatalog(), Boolean(args.all));
    const file = falHistoricalPricesPath(),
      checkpointFile = path.resolve(".cache/fal-historical", `${now.toISOString().slice(0, 10)}.jsonl`);
    emitProgress(`Reading historical per-call prices for ${endpoints.length} endpoints`);
    const result = await syncFalHistoricalPrices(endpoints, (url, init) => fetch(url, init), {
      apiKey: process.env.FAL_KEY,
      now,
      previous: loadFalHistoricalPrices(file),
      resume: Boolean(args.resume),
      ...(deadlineMs !== undefined ? { deadlineMs } : {}),
      ...(!args["dry-run"] ? { checkpointFile } : {}),
    });
    if (!args["dry-run"])
      writeFileSync(
        file,
        `${JSON.stringify({ version: result.version, syncedAt: result.syncedAt, records: result.records }, null, 2)}\n`,
      );
    return {
      outputs: args["dry-run"] ? [] : [path.relative(process.cwd(), file)],
      metadata: {
        mode: "historical",
        timedOut: result.timedOut,
        partial: result.partial,
        failed: result.failed,
        records: result.records.length,
        requests: result.requests,
        checkpointFile,
        syncedAt: result.syncedAt,
      },
    };
  }
  const file = falPricesPath();

  if (args.show !== undefined) {
    const endpoint = args.show;
    const record = loadFalPrices(file).get(endpoint);
    const price = falPriceFor(endpoint, file);
    const tariff = publicTariff(endpoint);
    const tracked = MODEL_REGISTRY[endpoint];
    const quoteSource =
      tracked && (price?.origin !== "platform-pricing-api" || tracked.source !== price.source)
        ? "tracked-registry"
        : (price?.origin ?? "unknown");
    return {
      metadata: {
        endpoint,
        record: record ?? null,
        converted:
          price?.origin === "platform-pricing-api"
            ? price.pricing
            : record
              ? pricingFromRecord(record, contextOf(endpoint), loadFalUnitSemantics().get(endpoint))
              : null,
        catalogue: contextOf(endpoint) ?? null,
        precedence: {
          used: quoteSource,
          publicTariff: tariff ? tariff.pricing : null,
          trackedRegistry: tracked ? tracked.pricing : null,
        },
        drift: record ? comparePrices(publicTariff, [record]) : [],
        sampleQuote: quote({ model: endpoint }),
      },
    };
  }

  const asOf = args["as-of"] ? new Date(`${args["as-of"]}T00:00:00.000Z`) : new Date();
  if (!Number.isFinite(asOf.valueOf()))
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "--as-of must be YYYY-MM-DD." });
  const listed = args.endpoints
    ? args.endpoints
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : undefined;
  const checkpointFile = path.resolve(".cache/fal-pricing", `${asOf.toISOString().slice(0, 10)}.jsonl`);
  const checkpoint = {
    ...(args.sync && !args["dry-run"] ? { checkpointFile } : {}),
    resume: Boolean(args.resume),
    partial: Boolean(args.partial),
    ...(deadlineMs !== undefined
      ? {
          deadlineMs,
          staleness: new Map(
            [...loadFalPrices(falPricesPath()).values()].map((record) => [
              record.endpoint,
              String(record.observedAsOf),
            ]),
          ),
        }
      : {}),
  };
  let result: FalPricingSyncResult;
  let mode: string;
  if (args["from-fixtures"] !== undefined) {
    const fixture = fixtureFetch(path.resolve(args["from-fixtures"]));
    mode = "from-fixtures";
    result = await syncFalPrices(listed ?? fixture.endpoints, fixture.fetch, {
      now: asOf,
      apiKey: "offline-fixture",
      ...checkpoint,
    }).catch(toCliError);
  } else {
    mode = "sync";
    const endpoints = listed ?? defaultEndpoints();
    if (!process.env.FAL_KEY)
      throw new CliErrorObject({
        code: "MISSING_API_KEY",
        message: "FAL_KEY is required for --sync (a free read-only GET).",
      });
    emitProgress(`Reading list prices for ${endpoints.length} endpoints`);
    result = await syncFalPrices(endpoints, (url, init) => fetch(url, init), {
      now: asOf,
      ...checkpoint,
      onProgress: (done, total) => emitProgress(`Priced ${done}/${total} endpoints`),
    }).catch(toCliError);
  }
  const semantics = loadFalUnitSemantics();
  const drift = comparePrices(publicTariff, result.records, semantics);
  const units: Record<string, number> = {};
  for (const record of result.records) units[record.unit] = (units[record.unit] ?? 0) + 1;
  const outputs: string[] = [];
  if (!args["dry-run"]) {
    // A partial --endpoints sync merges into the tracked records rather than dropping the rest.
    const merged = new Map(listed || result.partial ? loadFalPrices(file) : []);
    for (const record of result.records) merged.set(record.endpoint, record);
    writeFileSync(
      file,
      serialiseFalPrices([...merged.values()], result.partial ? null : asOf.toISOString().slice(0, 10)),
    );
    resetFalPricesCache();
    outputs.push(path.relative(process.cwd(), file));
  }
  return {
    outputs,
    metadata: {
      mode,
      checkpointFile,
      partial: result.partial,
      completedBatches: result.completedBatches,
      totalBatches: result.totalBatches,
      syncedAt: result.partial
        ? {
            partial: result.records.length,
            completedBatches: result.completedBatches,
            totalBatches: result.totalBatches,
          }
        : asOf.toISOString().slice(0, 10),
      ...(result.failure ? { failure: result.failure } : {}),
      dryRun: Boolean(args["dry-run"]),
      file: path.relative(process.cwd(), file),
      records: result.records.length,
      units,
      unbounded: result.records.flatMap((record) => {
        const definition = pricingFromRecord(record, contextOf(record.endpoint), semantics.get(record.endpoint));
        return definition.kind === "unknown"
          ? [{ endpoint: record.endpoint, unit: record.unit, reason: definition.reason }]
          : [];
      }),
      skipped: result.skipped,
      unpriced: result.unpriced.length,
      notFound: result.notFound,
      requests: result.requests,
      priceDrift: drift,
    },
  };
});
