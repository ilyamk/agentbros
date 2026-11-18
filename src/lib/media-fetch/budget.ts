import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OperationStore } from "../jobs/store";
import { paidInputIdentity } from "../jobs/identity";
import type { MediaFetchJob, MediaFetchItem, MediaProvider } from "../../types/media-fetch";
import { rapidCredits } from "./providers";
import { scopedPath, atomicJson, lock } from "./storage";
import { MediaFetchError } from "./errors";
export const QuotaSchema = z
  .object({
    schemaVersion: z.literal(1),
    authorised: z.literal(true),
    periodStart: z.string().datetime(),
    periodEnd: z.string().datetime(),
    remainingCredits: z.number().int().nonnegative(),
    reservations: z.record(z.string(), z.number().int().nonnegative()).default({}),
  })
  .strict();
export function quotaReservation(root: string, operationId: string, url: string, dry = false): boolean {
  const file = scopedPath(root, path.join(root, ".cache/media-fetch/rapidapi-quota.json"));
  if (!existsSync(file)) return false;
  const release = dry ? () => {} : lock(`${file}.lock`);
  try {
    const quota = QuotaSchema.parse(JSON.parse(readFileSync(file, "utf8"))),
      now = Date.now();
    if (now < Date.parse(quota.periodStart) || now >= Date.parse(quota.periodEnd)) return false;
    if (Object.hasOwn(quota.reservations, operationId)) return true;
    const credits = rapidCredits(url),
      reserved = Object.values(quota.reservations).reduce((a, b) => a + b, 0);
    if (reserved + credits > quota.remainingCredits) return false;
    if (!dry) {
      quota.reservations[operationId] = credits;
      atomicJson(file, quota);
    }
    return true;
  } finally {
    release();
  }
}
export function operationStore(job: MediaFetchJob): OperationStore {
  return job.options.project
    ? new OperationStore(job.options.project)
    : new OperationStore(`media-${job.id}`, { directory: path.join(job.directory, "budget") });
}
export function admit(
  root: string,
  job: MediaFetchJob,
  item: MediaFetchItem,
  provider: MediaProvider,
  input: Record<string, unknown>,
): { store?: OperationStore; free: boolean } {
  const id = item.operationId!;
  if (provider === "rapidapi" && quotaReservation(root, id, item.resolvedUrl ?? item.url)) return { free: true };
  const store = operationStore(job);
  if (existsSync(store.file) && store.snapshot().jobs[id]) {
    paidInputIdentity(input, store.snapshot().jobs[id]);
    return { store, free: false };
  }
  const per = job.options.maxCostUsd,
    total = job.options.maxTotalCostUsd;
  if (!per || !total)
    throw new MediaFetchError(
      "BUDGET_REQUIRED",
      "External requests require an authorised quota or positive operation and batch bounds.",
      "Configure RapidAPI quota, or supply --max-cost-usd and --max-total-cost-usd with a project budget.",
    );
  if (provider === "apify-easyapi") {
    const pricingFile = scopedPath(root, path.join(root, ".cache/media-fetch/pricing.json"));
    if (!existsSync(pricingFile))
      throw new MediaFetchError(
        "PRICING_REQUIRED",
        "Fresh Apify pricing evidence is required.",
        "Run media:fetch --refresh-pricing before authorising downloads.",
      );
    const evidence = JSON.parse(readFileSync(pricingFile, "utf8")) as {
      provider: string;
      asOf: string;
      actorStartUsd?: number;
      resultUsd?: number;
    }[];
    const current = evidence.find((x) => x.provider === provider);
    if (
      !current ||
      Date.now() - Date.parse(current.asOf) > 86400000 ||
      !Number.isFinite(current.actorStartUsd) ||
      !Number.isFinite(current.resultUsd)
    )
      throw new MediaFetchError(
        "PRICING_REQUIRED",
        "Actor pricing evidence is stale or incomplete.",
        "Run media:fetch --refresh-pricing.",
      );
    if (per < current.actorStartUsd! + current.resultUsd!)
      throw new MediaFetchError(
        "BUDGET_EXCEEDED",
        "Operation bound is below the known startup plus one result charge.",
        "Increase the authorised operation bound, allowing for platform usage.",
      );
  }
  if (!job.options.project && !existsSync(store.file))
    store.configure(
      { ceilingUsd: total, maxJobUsd: per, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 3 },
      { by: "operation-bounds", source: `media:fetch --max-total-cost-usd ${total} --max-cost-usd ${per}` },
    );
  const old = existsSync(store.file) ? store.snapshot().jobs[id] : undefined;
  if (!old) {
    const committed = Object.values(store.snapshot().jobs)
      .filter((x) => x.operationId.startsWith(`media-${job.id}-`))
      .reduce((sum, x) => sum + x.quote.highUsd, 0);
    job.committedUsd = committed;
    if (committed + per > total + 1e-9)
      throw new MediaFetchError(
        "BUDGET_EXCEEDED",
        "Batch acquisition bound exhausted.",
        "Increase the authorised bound in a new job, or reuse existing results.",
      );
    store.reserveOperation({
      operationId: id,
      provider,
      endpoint: provider === "rapidapi" ? "coder2077/download" : provider,
      assetId: `${job.id}-${job.items.indexOf(item)}`,
      ...paidInputIdentity(input),
      quote: {
        currency: "USD",
        lowUsd: 0,
        expectedUsd: per,
        highUsd: per,
        bounded: true,
        source: "explicit media:fetch user bound; not a provider billing cap",
        asOf: new Date().toISOString(),
        confidence: "user-bound",
        providerEnforced: false,
      },
      stage: "media-fetch",
    });
    job.committedUsd += per;
  }
  return { store, free: false };
}
