import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { CliErrorObject } from "../../cli";
import { ResponseCache, cacheKey } from "../cache";
import { readResourceResponseWithHeaders, ResourceHttpError, resourceJson } from "../http";

export type QuotaState = { remaining: number; limit?: number; resetAt: number; observedAt: number };
/** Reads a provider's rate-limit headers; each provider words its reset differently. */
export type QuotaReader = (headers: Headers, nowMs: number) => QuotaState | undefined;

const QuotaFileSchema = z
  .object({
    remaining: z.number(),
    limit: z.number().optional(),
    resetAt: z.number(),
    observedAt: z.number(),
  })
  .strict();

const header = (headers: Headers, name: string) => {
  const value = headers.get(name);
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value) : undefined;
};
export const quotaHeaders = { header };

/**
 * Metadata transport for one stock provider: response cache (credential parameters never enter keys or disk),
 * remembered rate-limit state that refuses a request it knows would be rejected, and request accounting.
 */
export class StockHttp {
  readonly stats = { network: 0, cached: 0 };
  private quota?: QuotaState;
  constructor(
    private readonly options: {
      provider: string;
      fetch: typeof fetch;
      cache: ResponseCache;
      readQuota: QuotaReader;
      nowMs: () => number;
      secretParams?: readonly string[];
      quotaFile?: string;
    },
  ) {
    this.quota = this.load();
  }
  get quotaState(): QuotaState | undefined {
    return this.quota && { ...this.quota };
  }
  private load(): QuotaState | undefined {
    const file = this.options.quotaFile;
    if (!file || !existsSync(file)) return undefined;
    try {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) return undefined;
      return QuotaFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
    } catch {
      return undefined;
    }
  }
  private remember(state: QuotaState | undefined) {
    if (!state) return;
    this.quota = state;
    const file = this.options.quotaFile;
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    } catch {
      /* Quota memory is advisory; the provider still enforces its own limit. */
    }
  }
  private limited(retryAfterMs: number): CliErrorObject {
    return new CliErrorObject({
      code: "RATE_LIMIT",
      message: `${this.options.provider} rate limit reached; retry after ${Math.ceil(retryAfterMs / 1000)} s.`,
      retryAfterMs,
      details: { provider: this.options.provider, quota: this.quota },
    });
  }
  /** Throws RATE_LIMIT without a request when the last response said the window is spent. */
  assertQuota() {
    const now = this.options.nowMs();
    if (this.quota && this.quota.remaining <= 0 && this.quota.resetAt > now)
      throw this.limited(this.quota.resetAt - now);
  }
  async json(
    url: string,
    options: { headers?: Record<string, string>; fresh?: boolean } = {},
  ): Promise<Record<string, any>> {
    const key = cacheKey(url, this.options.secretParams ?? []);
    let loaded = false;
    const value = await this.options.cache.through(
      key,
      async () => {
        loaded = true;
        this.assertQuota();
        this.stats.network++;
        try {
          const response = await readResourceResponseWithHeaders(this.options.fetch, url, {
            headers: options.headers,
            maxBytes: 4 * 1024 * 1024,
            timeoutMs: 30_000,
          });
          this.remember(this.options.readQuota(response.headers, this.options.nowMs()));
          const parsed = resourceJson(response.body);
          if (!parsed || typeof parsed !== "object")
            throw new CliErrorObject({ code: "VALIDATION", message: "Stock metadata must be JSON." });
          return Array.isArray(parsed) ? { items: parsed } : (parsed as Record<string, unknown>);
        } catch (error) {
          if (error instanceof ResourceHttpError && error.headers) {
            const state = this.options.readQuota(error.headers, this.options.nowMs());
            this.remember(state);
            if (error.status === 429 || (error.status === 403 && state && state.remaining <= 0))
              throw this.limited(
                error.retryAfterMs ??
                  Math.max(1000, (state?.resetAt ?? this.options.nowMs() + 60_000) - this.options.nowMs()),
              );
            if (error.status === 401)
              throw new CliErrorObject({
                code: "INVALID_INPUT",
                message: `${this.options.provider} rejected the access key (401). Check the key in .env.`,
                details: { httpStatus: 401 },
              });
          }
          throw error;
        }
      },
      { fresh: options.fresh },
    );
    if (!loaded) this.stats.cached++;
    return value;
  }
}
