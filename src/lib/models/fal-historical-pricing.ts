import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HistoricalPriceSchema, HistoricalPricesFileSchema, type HistoricalPrice } from "../../types/price-matrix";
import type { FalCatalogEntry } from "../../types/fal-catalog";
import type { ModelSlotsFile } from "../../types/model-slots";
import { isEndpointSuccessor } from "./model-slots-refresh";
export type HistoricalFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export const FAL_HISTORICAL_URL = "https://api.fal.ai/v1/models/pricing/estimate";
export const FAL_HISTORICAL_FILE = fileURLToPath(new URL("./fal-historical-prices.json", import.meta.url));
export function falHistoricalPricesPath(): string {
  return process.env.AGENTBROS_FAL_HISTORICAL_PRICES ?? FAL_HISTORICAL_FILE;
}
export function loadFalHistoricalPrices(file = falHistoricalPricesPath()): ReadonlyMap<string, HistoricalPrice> {
  // fal answers 0 for an endpoint without usage history: that is "no data", never a free price.
  return new Map(
    HistoricalPricesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")))
      .records.filter((row) => row.usdPerCall > 0)
      .map((row) => [row.endpoint, row]),
  );
}
export function historicalEndpoints(
  slots: ModelSlotsFile,
  catalog: ReadonlyMap<string, FalCatalogEntry>,
  all = false,
): string[] {
  const listed = slots.slots.flatMap((slot) =>
    slot.candidates.filter((c) => c.provider === "fal" && c.status !== "retired").map((c) => c.endpoint),
  );
  return [
    ...new Set(
      all
        ? [...catalog.values()].filter((row) => row.status === "active").map((row) => row.endpoint)
        : [
            ...listed,
            ...[...catalog.values()]
              .filter(
                (row) =>
                  row.status === "active" && listed.some((endpoint) => isEndpointSuccessor(endpoint, row.endpoint)),
              )
              .map((row) => row.endpoint),
          ],
    ),
  ].sort();
}
const AnswerSchema = z.object({
  estimate_type: z.literal("historical_api_price"),
  total_cost: z.number().finite().nonnegative(),
  currency: z.literal("USD"),
});
const CheckpointSchema = z.object({ date: z.iso.date(), endpoint: z.string(), record: HistoricalPriceSchema });
/** Free historical estimates, one endpoint per request: a multi-endpoint answer contains only a total. */
export async function syncFalHistoricalPrices(
  endpoints: readonly string[],
  fetchImpl: HistoricalFetch,
  options: {
    apiKey: string;
    now: Date;
    checkpointFile?: string;
    resume?: boolean;
    previous?: ReadonlyMap<string, HistoricalPrice>;
    sleep?: (ms: number) => Promise<void>;
    deadlineMs?: number;
    clock?: () => number;
  },
) {
  const date = options.now.toISOString().slice(0, 10),
    records = new Map(options.previous),
    completed = new Map<string, HistoricalPrice>();
  const failed: { endpoint: string; reason: string }[] = [];
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (options.resume && options.checkpointFile && existsSync(options.checkpointFile)) {
    const contents = readFileSync(options.checkpointFile, "utf8"),
      complete = contents.slice(0, contents.lastIndexOf("\n") + 1);
    if (contents !== complete) truncateSync(options.checkpointFile, Buffer.byteLength(complete));
    for (const line of complete.split("\n").filter(Boolean)) {
      const row = CheckpointSchema.parse(JSON.parse(line));
      if (row.date === date) completed.set(row.endpoint, row.record);
    }
  }
  if (!options.apiKey) throw new Error("FAL_KEY is required for historical pricing");
  // Stalest first (never observed, then oldest observedAsOf): a time-boxed daily run rotates through the whole catalogue.
  const previous = options.previous,
    clock = options.clock ?? Date.now;
  const queue = [...new Set(endpoints)].sort(
    (a, b) =>
      (previous?.get(a)?.observedAsOf ?? "").localeCompare(previous?.get(b)?.observedAsOf ?? "") || a.localeCompare(b),
  );
  let cursor = 0,
    requests = 0,
    timedOut = false;
  await Promise.all(
    Array.from({ length: Math.min(2, queue.length) }, async () => {
      while (cursor < queue.length) {
        const endpoint = queue[cursor++]!;
        const cached = completed.get(endpoint);
        if (cached) {
          records.set(endpoint, cached);
          continue;
        }
        if (options.deadlineMs !== undefined && clock() >= options.deadlineMs) {
          timedOut = true;
          cursor = queue.length;
          break;
        }
        try {
          let record: HistoricalPrice | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            requests++;
            const response = await fetchImpl(FAL_HISTORICAL_URL, {
              method: "POST",
              headers: { Authorization: `Key ${options.apiKey}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                estimate_type: "historical_api_price",
                endpoints: { [endpoint]: { call_quantity: 1 } },
              }),
              signal: AbortSignal.timeout(30000),
            });
            if (response.status === 429) {
              if (attempt === 2) throw new Error("rate_limited");
              const retry = response.headers.get("retry-after");
              const delay =
                retry && Number.isFinite(Number(retry))
                  ? Number(retry) * 1000
                  : retry && Number.isFinite(Date.parse(retry))
                    ? Date.parse(retry) - options.now.valueOf()
                    : 1000 * 2 ** attempt;
              await sleep(Math.min(60000, Math.max(1000, delay)));
              continue;
            }
            if (!response.ok) throw new Error(`Historical pricing HTTP ${response.status}`);
            const answer = AnswerSchema.parse(await response.json());
            record = { endpoint, usdPerCall: answer.total_cost, currency: "USD", observedAsOf: date };
            break;
          }
          if (!record) throw new Error("No historical estimate returned");
          records.set(endpoint, record);
          if (options.checkpointFile) {
            mkdirSync(path.dirname(options.checkpointFile), { recursive: true });
            appendFileSync(options.checkpointFile, `${JSON.stringify({ date, endpoint, record })}\n`);
          }
        } catch {
          // Provider bodies and transport errors can contain credentials. Never echo either.
          failed.push({
            endpoint,
            reason:
              "Historical estimate failed (network, rate_limited or invalid response); previous evidence retained",
          });
        }
      }
    }),
  );
  return {
    version: 1 as const,
    timedOut,
    syncedAt: failed.length || timedOut ? null : date,
    records: [...records.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    partial: failed.length > 0 || timedOut,
    failed: failed.sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    requests,
  };
}
