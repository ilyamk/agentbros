import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliErrorObject } from "../cli";
import {
  FalVerifiedFileSchema,
  type FalCatalogEntry,
  type FalDriftReport,
  type FalPriceRecord,
  type FalVerifiedFile,
} from "../../types/fal-catalog";
import { openApiRoutes, apiModelSource, type FalApiModel } from "../providers/fal-openapi";
import {
  buildCatalogEntry,
  cachedApiModelSha256,
  catalogDir,
  catalogTier,
  computeDrift,
  isFalEndpointId,
  loadCatalog,
  resetCatalogCache,
  schemaCacheDir,
  writeCachedApiModel,
  writeCatalog,
} from "./fal-catalog";

/**
 * fal:sync as a library (docs/fal-integration.md). Network is free, read-only GET
 * on the Platform API; `fetchImpl` is injectable and `fromFixtures` never touches the network.
 */
export const FAL_API_BASE = "https://api.fal.ai/v1";
export const VERIFIED_FILE = fileURLToPath(new URL("./fal-verified.json", import.meta.url));
export const DRIFT_REPORT_FILE = path.join("out", "qa", "model-refresh", "fal-catalog-drift.md");

export type FalSyncOptions = {
  /** Paginate the active listing. */
  catalog?: boolean;
  /** Fetch full OpenAPI for these endpoints, every pinned endpoint, or every known endpoint. */
  schemas?: string[] | "verified" | "all";
  /** Look up every indexed or pinned endpoint the listing missed; a 404 marks it gone. Needs `catalog`. */
  verifyKnown?: boolean;
  /** Fill null pins in fal-verified.json with the current catalogue hash. */
  pinVerified?: boolean;
  /** Offline: read `catalog-page.json` and `schemas/*.json` from this directory instead of the API. */
  fromFixtures?: string;
  dryRun?: boolean;
  outDir?: string;
  cacheDir?: string;
  verifiedFile?: string;
  /** Write the drift summary markdown to this path (not in a dry run). */
  reportFile?: string;
  now?: () => Date;
  /** Ignored: catalogue requests are anonymous (see networkSource). Kept for callers. */
  apiKey?: string;
  pageCap?: number;
  concurrency?: number;
  timeoutMs?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Dated Platform API price per endpoint (stream D); omitted: entries keep their previous price. */
  priceFor?: (endpoint: string) => FalPriceRecord | undefined;
  log?: (message: string) => void;
};

export type FalSyncResult = {
  drift: FalDriftReport;
  entries: number;
  byTier: Record<string, number>;
  written: string[];
  skipped: Array<{ endpoint: string; reason: string }>;
  notFound: string[];
  /** In the listing but 404 on direct lookup: kept active from the listing. */
  lookupMissing: string[];
  pinned: string[];
  pages: number;
  listed: number;
  schemasFetched: number;
  verified: { checked: number; found: string[]; gone: string[] };
  dryRun: boolean;
};

type Lookup = { status: "found"; model: FalApiModel } | { status: "missing" };
type Source = {
  listing(): Promise<{ models: FalApiModel[]; pages: number }>;
  lookup(endpoint: string, withSchema: boolean): Promise<Lookup>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Retry-After as seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function networkSource(fetchImpl: typeof fetch, options: FalSyncOptions): Source {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxRetries = options.maxRetries ?? 4;
  const sleep = options.sleep ?? defaultSleep;
  const headers: Record<string, string> = { Accept: "application/json" };
  // The model catalogue is public. With an Authorization header fal answers lookups with `metadata: null`
  // (observed 2026-11-15), which loses category and name, so catalogue requests are always anonymous.
  const getJson = async (url: URL): Promise<{ status: number; body?: unknown }> => {
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await fetchImpl(url.href, { headers, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        const timedOut = controller.signal.aborted;
        if (attempt < maxRetries) {
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
          continue;
        }
        throw new CliErrorObject({
          code: timedOut ? "TIMEOUT" : "NETWORK",
          message: `GET ${url.pathname}${url.search} failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      clearTimeout(timer);
      if (response.status === 404) return { status: 404 };
      if (response.ok) return { status: response.status, body: await response.json() };
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const wait = retryAfterMs(response.headers.get("retry-after")) ?? Math.min(30_000, 1000 * 2 ** attempt);
        options.log?.(`HTTP ${response.status}; retrying in ${Math.round(wait)} ms`);
        await sleep(Math.min(wait, 120_000));
        continue;
      }
      if (response.status === 429)
        throw new CliErrorObject({
          code: "RATE_LIMIT",
          message: "fal Platform API rate limit persists.",
          retryAfterMs: retryAfterMs(response.headers.get("retry-after")) ?? 60_000,
        });
      throw new CliErrorObject({
        code: "NETWORK",
        message: `GET ${url.pathname}${url.search} answered HTTP ${response.status}.`,
      });
    }
  };
  return {
    async listing() {
      const models: FalApiModel[] = [];
      const cap = options.pageCap ?? 40;
      let cursor: string | undefined;
      for (let page = 1; page <= cap; page++) {
        const url = new URL(`${FAL_API_BASE}/models`);
        url.searchParams.set("limit", "100");
        url.searchParams.set("status", "active");
        if (cursor) url.searchParams.set("cursor", cursor);
        const { body } = await getJson(url);
        const data = body as { models?: FalApiModel[]; has_more?: boolean; next_cursor?: string | null };
        models.push(...(data.models ?? []));
        options.log?.(`listing page ${page}: ${models.length} models`);
        if (!data.has_more) return { models, pages: page };
        if (!data.next_cursor)
          throw new CliErrorObject({ code: "VALIDATION", message: "Listing says has_more but gives no next_cursor." });
        cursor = data.next_cursor;
      }
      throw new CliErrorObject({
        code: "VALIDATION",
        message: `Listing exceeded the ${cap}-page cap; nothing was written.`,
      });
    },
    async lookup(endpoint, withSchema) {
      const url = new URL(`${FAL_API_BASE}/models`);
      url.searchParams.set("endpoint_id", endpoint);
      if (withSchema) url.searchParams.set("expand", "openapi-3.0");
      const result = await getJson(url);
      const model = (result.body as { models?: FalApiModel[] } | undefined)?.models?.find(
        (item) => item.endpoint_id === endpoint,
      );
      return result.status === 404 || !model ? { status: "missing" } : { status: "found", model };
    },
  };
}

/** Recorded responses: `catalog-page.json` (the listing) and `schemas/*.json` (lookups with openapi). */
function fixtureSource(dir: string): Source {
  const schemas = new Map<string, FalApiModel>();
  const schemaDir = path.join(dir, "schemas");
  if (existsSync(schemaDir)) {
    for (const name of readdirSync(schemaDir)
      .filter((file) => file.endsWith(".json"))
      .sort()) {
      const model = JSON.parse(readFileSync(path.join(schemaDir, name), "utf8")) as FalApiModel;
      schemas.set(model.endpoint_id, model);
    }
  }
  return {
    async listing() {
      const page = path.join(dir, "catalog-page.json");
      if (!existsSync(page)) throw new CliErrorObject({ code: "FILE_NOT_FOUND", message: `${page} is missing.` });
      return { models: (JSON.parse(readFileSync(page, "utf8")) as { models?: FalApiModel[] }).models ?? [], pages: 1 };
    },
    async lookup(endpoint, withSchema) {
      const model = schemas.get(endpoint);
      if (!model) return { status: "missing" };
      if (withSchema) return { status: "found", model };
      const { openapi: _openapi, ...rest } = model;
      return { status: "found", model: rest };
    },
  };
}

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

export function readVerifiedFile(file = VERIFIED_FILE): FalVerifiedFile {
  return existsSync(file)
    ? FalVerifiedFileSchema.parse(JSON.parse(readFileSync(file, "utf8")))
    : { version: 1, pins: {} };
}

export async function runFalSync(
  options: FalSyncOptions,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<FalSyncResult> {
  if (!options.catalog && !options.schemas && !options.verifyKnown && !options.pinVerified)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "Pass --catalog, --schemas, --tier verified, --all, --verify-known or --pin-verified.",
    });
  if (options.verifyKnown && !options.catalog)
    throw new CliErrorObject({
      code: "INVALID_INPUT",
      message: "--verify-known checks what the listing missed; add --catalog.",
    });
  if (Array.isArray(options.schemas)) {
    const invalid = options.schemas.filter((id) => !isFalEndpointId(id));
    if (invalid.length)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: `Not endpoint IDs: ${invalid.join(", ")}` });
  }
  const now = (options.now ?? (() => new Date()))();
  const today = now.toISOString().slice(0, 10);
  const outDir = options.outDir ?? catalogDir();
  const cacheDir = options.cacheDir ?? schemaCacheDir();
  const verifiedFile = options.verifiedFile ?? VERIFIED_FILE;
  const dryRun = !!options.dryRun;
  const log = options.log ?? (() => {});
  const source = options.fromFixtures ? fixtureSource(options.fromFixtures) : networkSource(fetchImpl, options);
  const concurrency = Math.min(4, Math.max(1, options.concurrency ?? 4));

  resetCatalogCache();
  const previous = new Map(loadCatalog(outDir));
  resetCatalogCache();
  const verified = readVerifiedFile(verifiedFile);
  const skipped: FalSyncResult["skipped"] = [];

  // 1. Listing.
  const listed = new Map<string, FalApiModel>();
  let pages = 0;
  if (options.catalog) {
    const listing = await source.listing();
    pages = listing.pages;
    for (const model of listing.models) {
      if (!isFalEndpointId(model?.endpoint_id)) {
        skipped.push({ endpoint: String(model?.endpoint_id), reason: "not a valid endpoint ID" });
        continue;
      }
      listed.set(model.endpoint_id, model);
    }
  }

  // 2. Direct lookups: schemas requested, plus verify-known for what the listing missed.
  const known = new Set([...previous.keys(), ...listed.keys()]);
  const schemaTargets =
    options.schemas === "verified"
      ? Object.keys(verified.pins)
      : options.schemas === "all"
        ? [...known].filter((id) => previous.get(id)?.status !== "gone")
        : (options.schemas ?? []);
  const schemaSet = new Set(schemaTargets);
  const verifyTargets = options.verifyKnown
    ? [...new Set([...previous.keys(), ...Object.keys(verified.pins)])].filter(
        (id) => !listed.has(id) && !schemaSet.has(id),
      )
    : [];
  const verifySet = new Set(verifyTargets);
  const targets = [
    ...[...schemaSet].map((id) => [id, true] as const),
    ...verifyTargets.map((id) => [id, false] as const),
  ].sort(([a], [b]) => a.localeCompare(b));
  log(`${targets.length} lookups (${schemaSet.size} with schema)`);
  const lookups = new Map<string, Lookup>();
  await mapLimited(targets, concurrency, async ([id, withSchema]) => {
    lookups.set(id, await source.lookup(id, withSchema));
  });

  // 3. Entries.
  const priceFor = options.priceFor;
  const next = new Map<string, FalCatalogEntry>();
  const notFound: string[] = [];
  const lookupMissing: string[] = [];
  const found: string[] = [];
  const gone: string[] = [];
  let schemasFetched = 0;
  for (const id of [...new Set([...previous.keys(), ...listed.keys(), ...lookups.keys()])].sort()) {
    const old = previous.get(id);
    const lookup = lookups.get(id);
    if (lookup?.status === "missing" && !listed.has(id)) {
      // Only a direct 404 for something the listing missed marks an entry gone; one never indexed is just reported.
      if (old) {
        next.set(id, { ...old, status: "gone" });
        gone.push(id);
      } else notFound.push(id);
      continue;
    }
    // Listed but 404 on lookup (seen in the wild): keep it active from the listing, with its previous schema.
    if (lookup?.status === "missing") lookupMissing.push(id);
    const model =
      lookup?.status === "found"
        ? { ...listed.get(id), ...lookup.model, metadata: { ...listed.get(id)?.metadata, ...lookup.model.metadata } }
        : listed.get(id);
    if (!model) {
      if (old) next.set(id, old);
      continue;
    }
    if (lookup?.status === "found" && verifySet.has(id)) found.push(id);
    try {
      let schema: FalCatalogEntry["schema"] | undefined;
      if (model.openapi && openApiRoutes(model)) {
        const sha = dryRun ? cachedApiModelSha256(model) : writeCachedApiModel(model, cacheDir);
        schema = { sha256: sha, asOf: today, source: apiModelSource(id), cached: !dryRun };
        schemasFetched++;
      }
      next.set(
        id,
        buildCatalogEntry(model, {
          today,
          previous: old,
          verifiedPins: verified.pins,
          priceFor,
          ...(schema ? { schema } : {}),
        }),
      );
    } catch (error) {
      skipped.push({ endpoint: id, reason: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      if (old) next.set(id, old);
    }
  }

  // Kept entries follow pin edits too.
  for (const [id, item] of next) {
    const tier = catalogTier(id, item.schema, item.price, verified.pins);
    if (tier !== item.tier) next.set(id, { ...item, tier });
  }

  // 4. Pins.
  const pinned: string[] = [];
  let pins = verified.pins;
  if (options.pinVerified) {
    pins = { ...verified.pins };
    for (const [endpoint, pin] of Object.entries(verified.pins)) {
      const sha = next.get(endpoint)?.schema?.sha256;
      if (pin.catalogSha256 === null && sha) {
        pins[endpoint] = { ...pin, catalogSha256: sha };
        pinned.push(endpoint);
      }
    }
  }

  const drift = computeDrift(previous.values(), next.values(), { generatedAt: now.toISOString() });
  const written: string[] = [];
  if (!dryRun) {
    // Without a listing only looked-up entries (and pin-driven tiers) can change: rewrite just those
    // category files, so the rest keep their bytes and their previous syncedAt.
    const only = options.catalog ? undefined : changedCategories(previous, next);
    written.push(...writeCatalog(next.values(), outDir, { syncedAt: today, ...(only ? { only } : {}) }));
    resetCatalogCache();
    if (pinned.length) {
      writeFileSync(
        verifiedFile,
        `${JSON.stringify(FalVerifiedFileSchema.parse({ version: 1, pins: Object.fromEntries(Object.entries(pins).sort(([a], [b]) => a.localeCompare(b))) }), null, 2)}\n`,
      );
      written.push(verifiedFile);
    }
    if (options.reportFile) {
      mkdirSync(path.dirname(options.reportFile), { recursive: true });
      writeFileSync(
        options.reportFile,
        driftMarkdown(drift, { entries: next.size, listed: listed.size, skipped, notFound, lookupMissing }),
      );
      written.push(options.reportFile);
    }
  }
  const byTier: Record<string, number> = {};
  for (const entry of next.values()) byTier[entry.tier] = (byTier[entry.tier] ?? 0) + 1;
  return {
    drift,
    entries: next.size,
    byTier,
    written,
    skipped,
    notFound,
    lookupMissing,
    pinned,
    pages,
    listed: listed.size,
    schemasFetched,
    verified: { checked: verifyTargets.length, found, gone },
    dryRun,
  };
}

/** Categories whose entry set or any entry differs between two catalogues (both sides of a move count). */
function changedCategories(
  previous: ReadonlyMap<string, FalCatalogEntry>,
  next: ReadonlyMap<string, FalCatalogEntry>,
): Set<FalCatalogEntry["category"]> {
  const changed = new Set<FalCatalogEntry["category"]>();
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    const before = previous.get(id);
    const after = next.get(id);
    if (before && after && JSON.stringify(before) === JSON.stringify(after)) continue;
    if (before) changed.add(before.category);
    if (after) changed.add(after.category);
  }
  return changed;
}

/** Ephemeral summary of the last sync, separate from the catalogue source data. */
export function driftMarkdown(
  drift: FalDriftReport,
  counts: {
    entries: number;
    listed: number;
    skipped: FalSyncResult["skipped"];
    notFound: string[];
    lookupMissing?: string[];
  },
): string {
  const list = (items: string[]) => (items.length ? items.map((item) => `- ${item}`).join("\n") : "- none");
  return [
    "# fal catalogue drift",
    "",
    `Generated by \`pnpm fal:sync --report\` at ${drift.generatedAt}. Index: ${counts.entries} entries; listing: ${counts.listed}. Plan: [fal integration](../fal-integration.md).`,
    "",
    `## Added (${drift.added.length})`,
    "",
    list(drift.added),
    "",
    `## Gone (${drift.gone.length})`,
    "",
    list(drift.gone),
    "",
    `## Schema changed (${drift.schemaChanged.length})`,
    "",
    list(drift.schemaChanged.map((item) => `${item.endpoint}: ${item.from.slice(0, 12)} → ${item.to.slice(0, 12)}`)),
    "",
    `## Retiring (${drift.retiring.length})`,
    "",
    list(
      drift.retiring.map(
        (item) => `${item.endpoint}: ${item.retiresAt}${item.replacement ? ` → ${item.replacement}` : ""}`,
      ),
    ),
    "",
    `## Demoted (${drift.demoted.length})`,
    "",
    list(drift.demoted.map((item) => `${item.endpoint}: ${item.from} → ${item.to} (${item.reason})`)),
    "",
    `## Price drift (${drift.priceDrift.length})`,
    "",
    list(drift.priceDrift.map((item) => `${item.endpoint}: tracked ${item.tracked}, observed ${item.observed}`)),
    "",
    `## Skipped (${counts.skipped.length}) and not found (${counts.notFound.length + (counts.lookupMissing?.length ?? 0)})`,
    "",
    list([
      ...counts.skipped.map((item) => `${item.endpoint}: ${item.reason}`),
      ...counts.notFound.map((id) => `${id}: 404 on lookup, never indexed`),
      ...(counts.lookupMissing ?? []).map((id) => `${id}: listed, but 404 on lookup`),
    ]),
    "",
  ].join("\n");
}
