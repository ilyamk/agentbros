import path from "node:path";
import { CliErrorObject } from "../../cli";
import { cacheRoot } from "../../cache-dir";
import type { ResourceCandidate } from "../../../types/resources";
import { ResponseCache } from "../cache";
import { StockHttp, type QuotaReader, type QuotaState } from "./http";
import { pexels, pexelsQuota } from "./pexels";
import { pixabay, pixabayQuota } from "./pixabay";
import { rankCandidates, type RankedCandidate } from "./rank";
import { orientationFor, requiredSourceSize } from "./resolution";
import { unsplash, unsplashQuota } from "./unsplash";
import {
  STOCK_PROVIDER_IDS,
  StockFiltersSchema,
  type DownloadTarget,
  type StockAdapter,
  type StockContext,
  type StockFilters,
  type StockProviderId,
  type StockQuery,
} from "./types";

export * from "./types";
export { rankCandidates, type RankedCandidate } from "./rank";
export { requiredSourceSize, resolutionFit, frameSize } from "./resolution";

/** A new stock source is one adapter file and one row here (plus its key in setup/keys.ts). */
export const STOCK_ADAPTERS: Record<StockProviderId, StockAdapter> = { unsplash, pexels, pixabay };
const SETTINGS: Record<StockProviderId, { ttlMs: number; quota: QuotaReader; secretParams: string[] }> = {
  unsplash: { ttlMs: 6 * 60 * 60_000, quota: unsplashQuota, secretParams: ["client_id"] },
  pexels: { ttlMs: 6 * 60 * 60_000, quota: pexelsQuota, secretParams: [] },
  // Pixabay requires search results to be cached for 24 hours.
  pixabay: { ttlMs: 24 * 60 * 60_000, quota: pixabayQuota, secretParams: ["key"] },
};
/** Preference when several sources can answer: Unsplash's curation first for stills, Pexels first for clips. */
const AUTO_ORDER: Record<"image" | "video", StockProviderId[]> = {
  image: ["unsplash", "pexels", "pixabay"],
  video: ["pexels", "pixabay"],
};

export const isStockProvider = (id: string): id is StockProviderId =>
  (STOCK_PROVIDER_IDS as readonly string[]).includes(id);

export type StockSearchInput = {
  query: string;
  kind: "image" | "video";
  page?: number;
  limit?: number;
  filters?: StockFilters;
};
export type ProviderOutcome = {
  status: "ok" | "skipped" | "error";
  count?: number;
  code?: string;
  message?: string;
  notes?: string[];
  requests?: { network: number; cached: number };
  quota?: QuotaState;
};
export type StockSearchResult = {
  results: RankedCandidate[];
  providers: Partial<Record<StockProviderId, ProviderOutcome>>;
  required?: ReturnType<typeof requiredSourceSize>;
};

export class StockClient {
  private readonly contexts = new Map<StockProviderId, StockContext>();
  constructor(
    private readonly options: {
      fetch: typeof fetch;
      credentials: Partial<Record<StockProviderId, string | undefined>>;
      now: () => string;
      nowMs?: () => number;
      /** false or a fetch override without a directory keeps cache and quota in memory. */
      cacheDir?: string | false;
      injectedFetch?: boolean;
    },
  ) {}
  configured(): StockProviderId[] {
    return STOCK_PROVIDER_IDS.filter((id) => Boolean(this.options.credentials[id]));
  }
  private directory(): string | undefined {
    if (this.options.cacheDir === false) return undefined;
    if (this.options.cacheDir) return this.options.cacheDir;
    return this.options.injectedFetch ? undefined : path.join(cacheRoot(), "stock");
  }
  context(provider: StockProviderId): StockContext {
    const existing = this.contexts.get(provider);
    if (existing) return existing;
    const settings = SETTINGS[provider];
    const nowMs = this.options.nowMs ?? Date.now;
    const root = this.directory();
    const http = new StockHttp({
      provider,
      fetch: this.options.fetch,
      cache: new ResponseCache({ ttlMs: settings.ttlMs, now: nowMs, directory: root && path.join(root, provider) }),
      readQuota: settings.quota,
      nowMs,
      secretParams: settings.secretParams,
      quotaFile: root && path.join(root, `${provider}-quota.json`),
    });
    const context: StockContext = {
      http,
      now: this.options.now,
      key: () => {
        const value = this.options.credentials[provider];
        if (!value)
          throw new CliErrorObject({
            code: "INVALID_INPUT",
            message: `Missing ${STOCK_ADAPTERS[provider].keyEnv}; add it to .env (see .env.example).`,
          });
        return value;
      },
    };
    this.contexts.set(provider, context);
    return context;
  }
  /** Query with format-derived orientation and minimum size, validated filters and bounded pagination. */
  static query(input: StockSearchInput): StockQuery {
    const filters = StockFiltersSchema.parse(input.filters ?? {});
    const page = input.page ?? 1,
      limit = input.limit ?? 10;
    if (!Number.isInteger(page) || page < 1 || page > 10_000 || !Number.isInteger(limit) || limit < 1 || limit > 50)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid stock pagination (page ≥ 1, limit 1..50)." });
    if (input.query.length > 1000)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "Stock query is too long." });
    if (!input.query.trim() && !filters.author && !filters.topic)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: "Stock search requires --query (or --author/--topic).",
      });
    if (filters.zoom && !filters.format)
      throw new CliErrorObject({ code: "INVALID_INPUT", message: "--zoom needs --format." });
    const query: StockQuery = { ...filters, query: input.query, kind: input.kind, page, limit };
    if (filters.format) {
      query.orientation ??= orientationFor(filters.format);
      const required = requiredSourceSize(filters.format, filters.zoom ?? 1).minimum;
      // A source of any aspect must reach the minimum on both axes to fill the frame.
      query.minWidth ??= required.width;
      query.minHeight ??= required.height;
    }
    return query;
  }
  async searchOne(provider: StockProviderId, input: StockSearchInput) {
    const adapter = STOCK_ADAPTERS[provider];
    if (!adapter.kinds.includes(input.kind))
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `${provider} does not cover ${input.kind}; covers ${adapter.kinds.join(", ")}.`,
      });
    return adapter.search(StockClient.query(input), this.context(provider));
  }
  /** One request per selected provider; a provider that fails is reported, not fatal. */
  async search(providers: readonly StockProviderId[] | "auto", input: StockSearchInput): Promise<StockSearchResult> {
    const query = StockClient.query(input);
    const wanted =
      providers === "auto"
        ? AUTO_ORDER[input.kind].filter((id) => this.options.credentials[id])
        : [...new Set(providers)];
    if (!wanted.length)
      throw new CliErrorObject({
        code: "INVALID_INPUT",
        message: `No stock provider key for ${input.kind}: set ${AUTO_ORDER[input.kind].map((id) => STOCK_ADAPTERS[id].keyEnv).join(" or ")} in .env.`,
      });
    const outcomes: Partial<Record<StockProviderId, ProviderOutcome>> = {};
    const found: ResourceCandidate[] = [];
    await Promise.all(
      wanted.map(async (provider) => {
        const adapter = STOCK_ADAPTERS[provider];
        if (!adapter.kinds.includes(input.kind)) {
          outcomes[provider] = { status: "skipped", message: `${provider} does not cover ${input.kind}.` };
          return;
        }
        if (!this.options.credentials[provider]) {
          outcomes[provider] = { status: "skipped", message: `Set ${adapter.keyEnv} to search ${provider}.` };
          return;
        }
        const context = this.context(provider);
        try {
          const result = await adapter.search(query, context);
          found.push(...result.candidates);
          outcomes[provider] = {
            status: "ok",
            count: result.candidates.length,
            notes: result.notes,
            requests: { ...context.http.stats },
            ...(context.http.quotaState ? { quota: context.http.quotaState } : {}),
          };
        } catch (error) {
          outcomes[provider] = {
            status: "error",
            code: error instanceof CliErrorObject ? error.code : "UNKNOWN",
            message: error instanceof Error ? error.message : String(error),
            ...(context.http.quotaState ? { quota: context.http.quotaState } : {}),
          };
        }
      }),
    );
    if (Object.values(outcomes).every((outcome) => outcome?.status !== "ok")) {
      const first =
        Object.values(outcomes).find((outcome) => outcome?.status === "error") ?? Object.values(outcomes)[0];
      if (first?.status === "skipped")
        throw new CliErrorObject({
          code: "INVALID_INPUT",
          message: Object.values(outcomes)
            .map((outcome) => outcome?.message)
            .join(" "),
          details: { providers: outcomes },
        });
      if (first)
        throw new CliErrorObject({
          code: (first.code as any) ?? "NETWORK",
          message: `Every stock provider failed: ${Object.entries(outcomes)
            .map(([id, outcome]) => `${id}: ${outcome?.message}`)
            .join("; ")}`,
          ...(first.quota && first.code === "RATE_LIMIT"
            ? { retryAfterMs: Math.max(0, first.quota.resetAt - (this.options.nowMs ?? Date.now)()) }
            : {}),
          details: { providers: outcomes },
        });
    }
    return {
      results: rankCandidates(found, query.query, query, wanted),
      providers: outcomes,
      ...(query.format ? { required: requiredSourceSize(query.format, query.zoom ?? 1) } : {}),
    };
  }
  inspect(candidate: ResourceCandidate) {
    const provider = candidate.provider as StockProviderId;
    return STOCK_ADAPTERS[provider].inspect(candidate, this.context(provider));
  }
  resolveDownload(candidate: ResourceCandidate, target: DownloadTarget | undefined) {
    return STOCK_ADAPTERS[candidate.provider as StockProviderId].resolveDownload(candidate, target);
  }
  async onAcquire(candidate: ResourceCandidate) {
    const provider = candidate.provider as StockProviderId;
    const adapter = STOCK_ADAPTERS[provider];
    return adapter.onAcquire ? adapter.onAcquire(candidate, this.context(provider)) : undefined;
  }
}
