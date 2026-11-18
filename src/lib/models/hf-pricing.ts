import { assertHiggsfieldPublicInput, redactHiggsfieldCredentials } from "../providers/higgsfield/client";
import { generationRequestBody } from "../jobs/request-body";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  HiggsfieldEstimateSchema,
  HiggsfieldListPriceSchema,
  HiggsfieldPriceRecordSchema,
  HiggsfieldPricesFileSchema,
  type HiggsfieldEstimate,
  type HiggsfieldPriceRecord,
  type HiggsfieldPriceTier,
} from "../../types/higgsfield";
import type { PricingDefinition } from "../../types/models";
import type { MediaMetadata, JsonSchema } from "../providers/json-schema-validate";
import { exampleFromSchema, resolveSchema, validateJsonSchema } from "../providers/json-schema-validate";
import { FalOperationError, isObject } from "../providers/fal-errors";
import { canonicalJson } from "../providers/fal-openapi";
import { CliErrorObject } from "../cli";
import { resolveProviderSnapshot } from "./fal-catalog";
import type { FalCatalogEntry } from "../../types/fal-catalog";
import type { ModelReferenceSetting, ModelSlot } from "../../types/model-slots";
import type { PriceScenarios } from "../../types/price-matrix";
import { loadModelSlots } from "./model-slots-loader";
import { scenariosForCategory } from "./price-scenario-categories";
import { checkModelConstraints } from "./model-constraints";

export const HF_CATALOG_PRICING_URL = "https://dash.higgsfield.ai/api/v2/catalog-models/?page_size=100";
export const HF_PRICES_FILE = fileURLToPath(new URL("./hf-prices.json", import.meta.url));
export function hfPricesPath(): string {
  return process.env.AGENTBROS_HF_PRICES ?? HF_PRICES_FILE;
}
export function loadHiggsfieldPrices(file = hfPricesPath()): ReadonlyMap<string, HiggsfieldPriceRecord> {
  const data = HiggsfieldPricesFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  return new Map(data.prices.map((record) => [record.endpoint, record]));
}
export function serialiseHiggsfieldPrices(records: readonly HiggsfieldPriceRecord[], syncedAt: string | null): string {
  return `${JSON.stringify(HiggsfieldPricesFileSchema.parse({ version: 1, syncedAt, prices: [...records].sort((a, b) => a.endpoint.localeCompare(b.endpoint)) }), null, 1)}\n`;
}

// Only answers obtained by this process's injected transport may supplement tracked prices.
const requestEstimates = new Map<string, HiggsfieldEstimate>();
const estimateKey = (endpoint: string, input: Record<string, unknown>) => `${endpoint}:${canonicalJson(input)}`;
export function higgsfieldPriceRecordFor(
  endpoint: string,
  input: Record<string, unknown>,
  file?: string,
): HiggsfieldPriceRecord | undefined {
  const current = loadHiggsfieldPrices(file).get(endpoint);
  const estimate = requestEstimates.get(estimateKey(endpoint, input));
  if (!estimate || Date.parse(estimate.observedAt) < Date.parse(current?.observedAsOf ?? "1970-01-01")) return current;
  const { unparsed: _unparsed, ...stored } = current ?? {};
  return {
    ...stored,
    endpoint,
    list: current?.list ?? null,
    estimates: [structuredClone(estimate)],
    observedAsOf: estimate.observedAt.slice(0, 10),
    ...(estimate.pricingDescription ? parseHiggsfieldPricing(estimate.pricingDescription) : { tiers: [] }),
  };
}

const MULTI_SHOT_OUTPUT = "For explicit multi-shot requests, output duration is the sum of the shot durations.";
const MULTI_SHOT_SOURCE = "Multi-shot requests use the sum of the specified shot durations.";
const OUTPUT_TOTAL = "Total price = selected rate × output duration in seconds.";
const INPUT_NOT_ADDED = "Input video duration is not added to the billed duration.";
const RATE = String.raw`(?:\d+p|[24]K): \$\d+(?:\.\d+)?`;
const RATES = `${RATE}(?:; ${RATE})*`;

/** Only the measured description grammar is accepted; arbitrary dollar amounts are not rates. */
export function parseHiggsfieldPricing(description: string): { tiers: HiggsfieldPriceTier[]; unparsed?: string } {
  const unknown = (reason: string) => ({ tiers: [], unparsed: `${reason}: ${description}` });
  if (description.startsWith("Token-metered pricing."))
    return unknown(
      "token-metered; output pixel dimensions are not specified by the recorded resolution/aspect-ratio enums",
    );
  if (description.startsWith("Per 1M tokens:")) return unknown("token-metered; actual token usage is required");
  const tiersFrom = (
    rates: string,
    options: Partial<HiggsfieldPriceTier> = {},
    condition?: string,
  ): HiggsfieldPriceTier[] =>
    rates.split("; ").map((part) => {
      const [resolution, amount] = part.split(": $");
      return {
        when: { resolution: resolution!, ...(condition ? { $videoInput: condition } : {}) },
        usdPerUnit: Number(amount),
        basis: "output-second",
        rounding: null,
        ...options,
      };
    });
  const finish = (tiers: HiggsfieldPriceTier[], unparsed?: string) =>
    new Set(tiers.map((tier) => canonicalJson(tier.when))).size !== tiers.length
      ? unknown("Duplicate pricing conditions")
      : { tiers, ...(unparsed ? { unparsed } : {}) };
  const conditional = new RegExp(
    `^Standard self-serve rates in USD per second of generated video\\.\\n\\n- Without video input: (${RATES})\\.\\n- With video input: (${RATES})\\.\\n\\n([\\s\\S]+)$`,
    "u",
  ).exec(description);
  if (conditional) {
    const suffix = `${OUTPUT_TOTAL} ${INPUT_NOT_ADDED}`;
    if (
      ![suffix, `${suffix} Image or audio references alone use the rate without video input.`].includes(conditional[3]!)
    )
      return unknown("Unrecognised conditional billing");
    return finish([...tiersFrom(conditional[1]!, {}, "absent"), ...tiersFrom(conditional[2]!, {}, "present")]);
  }
  const restyle =
    /^Roughly costs \$(\d+(?:\.\d+)?) per second at 480p, \$(\d+(?:\.\d+)?) per second at 720p, or \$(\d+(?:\.\d+)?) per second at 1080p\.$/u.exec(
      description,
    );
  // Recorded Restyle docs specify source seconds, rounded up after trimming to 30 seconds.
  if (restyle)
    return finish(
      ["480p", "720p", "1080p"].map((resolution, index) => ({
        when: { resolution },
        usdPerUnit: Number(restyle[index + 1]),
        basis: "source-second",
        rounding: "ceil-second",
        capSeconds: 30,
        approximate: true,
      })),
    );
  if (
    description ===
    "2K output costs $0.13 per generated second. The first five reference images are included; each additional reference image costs $0.08. Rates shown are before any applicable customer discount."
  )
    return finish([
      {
        when: { resolution: "2K" },
        usdPerUnit: 0.13,
        basis: "output-second",
        rounding: null,
        extras: [{ field: "image_urls", includedCount: 5, usdPerExtra: 0.08 }],
      },
    ]);
  const light = /^Price per second \(output\): ((?:\d+p — \$\d+(?:\.\d+)?)(?:; \d+p — \$\d+(?:\.\d+)?)*)\.$/u.exec(
    description,
  );
  if (light) return finish(tiersFrom(light[1]!.replaceAll(" — $", ": $")));
  const standard = new RegExp(
    `^Standard self-serve rates in USD per video second: (${RATES})\\. ([\\s\\S]+)$`,
    "u",
  ).exec(description);
  if (!standard) return unknown("Unrecognised pricing description");
  const body = standard[2]!;
  const outputSuffixes = [
    OUTPUT_TOTAL,
    `${OUTPUT_TOTAL} ${MULTI_SHOT_OUTPUT}`,
    `${OUTPUT_TOTAL} ${INPUT_NOT_ADDED} ${MULTI_SHOT_OUTPUT}`,
    "Total price = selected rate × requested extension duration in seconds. The duration of the existing input video is not added to the billed duration.",
  ];
  if (outputSuffixes.includes(body))
    return finish(tiersFrom(standard[1]!), body.endsWith(MULTI_SHOT_OUTPUT) ? MULTI_SHOT_OUTPUT : undefined);
  if (
    body ===
      "Billed duration is the source video duration rounded up to a whole second. Total price = selected rate × billed duration in seconds." ||
    body ===
      "The edited video duration is determined from the primary input video and rounded up to a whole second. Total price = selected rate × that duration in seconds; input duration is not added again."
  )
    return finish(tiersFrom(standard[1]!, { basis: "source-second", rounding: "ceil-second" }));
  if (
    body ===
    "Billed duration is the motion-reference video duration rounded to the nearest whole second. Total price = selected rate × billed duration in seconds."
  )
    return finish(tiersFrom(standard[1]!, { basis: "source-second", rounding: "nearest-second" }));
  const capped =
    /^Billed duration is the source video duration rounded to the nearest whole second, capped at (15|10) seconds\. Multi-shot requests use the sum of the specified shot durations\. Total price = selected rate × billed duration in seconds; input duration is not added again\.$/u.exec(
      body,
    );
  if (capped)
    return finish(
      tiersFrom(standard[1]!, { basis: "source-second", rounding: "nearest-second", capSeconds: Number(capped[1]) }),
      MULTI_SHOT_SOURCE,
    );
  return unknown("Unrecognised billing conditions");
}

/** Rebuild derived tiers offline; preserve estimates, dates and catalogue observations. */
export function reparseHiggsfieldPrices(records: readonly HiggsfieldPriceRecord[]): HiggsfieldPriceRecord[] {
  return records.map((record) => {
    const { tiers: _tiers, unparsed: _unparsed, ...stored } = record;
    const description = [...record.estimates]
      .reverse()
      .find((estimate) => estimate.pricingDescription)?.pricingDescription;
    return HiggsfieldPriceRecordSchema.parse({
      ...stored,
      ...(description
        ? parseHiggsfieldPricing(description)
        : {
            tiers: [],
            ...(!record.estimates.some((estimate) => estimate.type === "estimate")
              ? {
                  unparsed:
                    record.endpoint === "v1/custom-references"
                      ? "training; no estimate route"
                      : "No stored estimate answer; next sync is required.",
                }
              : {}),
          }),
    });
  });
}

export type HiggsfieldPricingContext = {
  defaults?: Record<string, unknown>;
  media?: MediaMetadata;
  videoInput?: boolean;
  now?: Date;
};
export type HiggsfieldPrice = {
  pricing: PricingDefinition;
  source: string;
  observedAsOf: string;
  discountedUsd?: number;
  undiscountedUsd?: number;
  discountApplied?: boolean;
  estimate?: HiggsfieldEstimate;
  tier?: HiggsfieldPriceTier;
};
export function higgsfieldPricingSource(
  endpoint: string,
  kind: "higgsfield-estimate" | "higgsfield-list" = "higgsfield-estimate",
): string {
  return kind === "higgsfield-estimate" ? `https://api.higgsfield.ai/estimate/${endpoint}` : HF_CATALOG_PRICING_URL;
}
function reserveAmount(
  record: HiggsfieldPriceRecord,
  discounted: number,
  undiscounted: number,
  observedAt: string,
  now: Date,
): { discountedUsd: number; undiscountedUsd: number; discountApplied: boolean; amount: number } {
  const expiry = record.list?.discountExpiresAt;
  const fresh =
    now.valueOf() - Date.parse(observedAt) <= 7 * 86_400_000 &&
    now.valueOf() - Date.parse(record.observedAsOf) <= 7 * 86_400_000;
  const discountApplied =
    undiscounted > discounted &&
    fresh &&
    expiry !== null &&
    expiry !== undefined &&
    Date.parse(expiry) >= now.valueOf() + 3_600_000;
  return {
    discountedUsd: discounted,
    undiscountedUsd: undiscounted,
    discountApplied,
    amount: discountApplied ? discounted : undiscounted,
  };
}
function undiscountedAmount(
  record: HiggsfieldPriceRecord,
  discounted: number,
  discountUsd = 0,
  discountPercentage = 0,
): number {
  const amounts = [discounted + discountUsd];
  for (const percentage of [discountPercentage, record.list?.discountPercentage ?? 0]) {
    if (percentage > 0) amounts.push(percentage < 100 ? discounted / (1 - percentage / 100) : Infinity);
  }
  const list = record.list;
  // Only use the sale ratio: catalogue original amounts may be per second/image or family floors.
  if (list?.originalAmount !== null && list?.originalAmount !== undefined && list.originalAmount > list.amount)
    amounts.push(list.amount > 0 ? (discounted * list.originalAmount) / list.amount : Infinity);
  return Math.max(discounted, ...amounts);
}
/** Request totals deliberately use quantity=request, including estimates obtained with num_images > 1. */
export function higgsfieldPricingFor(
  record: HiggsfieldPriceRecord,
  input: Record<string, unknown>,
  context: HiggsfieldPricingContext = {},
): HiggsfieldPrice {
  const base = { source: higgsfieldPricingSource(record.endpoint), observedAsOf: record.observedAsOf };
  const unknown = (reason: string): HiggsfieldPrice => ({ ...base, pricing: { kind: "unknown", reason } });
  const now = context.now ?? new Date();
  const normalise = (value: Record<string, unknown>) => canonicalJson({ ...context.defaults, ...value });
  const estimate = [...record.estimates]
    .reverse()
    .find((row) => row.type === "estimate" && row.usd !== undefined && normalise(row.input) === normalise(input));
  if (estimate) {
    const discounted = estimate.usd!;
    const undiscounted = undiscountedAmount(record, discounted, estimate.discountUsd, estimate.discountPercentage);
    const amounts = reserveAmount(record, discounted, undiscounted, estimate.observedAt, now);
    return {
      ...base,
      ...amounts,
      estimate,
      pricing:
        amounts.amount > 0 && Number.isFinite(amounts.amount)
          ? { kind: "fixed", usdPerUnit: amounts.amount, quantity: "request" }
          : { kind: "unknown", reason: "Unreviewed zero or invalid request estimate." },
    };
  }
  if (record.unparsed && ![MULTI_SHOT_OUTPUT, MULTI_SHOT_SOURCE].includes(record.unparsed))
    return unknown(record.unparsed);
  const effective = { ...context.defaults, ...input };
  const videoUrls = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(videoUrls);
    if (!isObject(value)) return [];
    return Object.entries(value).flatMap(([key, field]) =>
      /video.*_urls?$/.test(key)
        ? (Array.isArray(field) ? field : [field]).filter(
            (url): url is string => typeof url === "string" && url.length > 0,
          )
        : videoUrls(field),
    );
  };
  const videos = videoUrls(effective);
  const matching = record.tiers.filter((row) =>
    Object.entries(row.when).every(([key, value]) =>
      key === "$videoInput"
        ? value === (videos.length ? "present" : "absent")
        : !key.startsWith("$") && String(effective[key]) === value,
    ),
  );
  if (matching.length !== 1)
    return unknown("No exact pricing tier or matching request estimate; catalogue from prices are floors only.");
  const tier = matching[0]!;
  let quantity: unknown =
    tier.basis === "request" ? 1 : tier.basis === "image" ? (effective.num_images ?? 1) : effective.duration;
  const multiShot =
    effective.multi_shots === true ||
    (effective.multi_prompt != null && (!Array.isArray(effective.multi_prompt) || effective.multi_prompt.length > 0));
  if (effective.multi_shots !== undefined && typeof effective.multi_shots !== "boolean")
    return unknown("Unsupported multi-shot enabled flag.");
  if (multiShot) {
    const shots = effective.multi_prompt;
    const properties = resolveProviderSnapshot("higgsfield", record.endpoint)?.input.properties;
    if (
      !isObject(properties) ||
      !properties.multi_shots ||
      !properties.multi_prompt ||
      effective.multi_shots !== true ||
      !record.unparsed ||
      !Array.isArray(shots) ||
      !shots.length ||
      !shots.every(
        (shot) =>
          isObject(shot) && typeof shot.duration === "number" && Number.isFinite(shot.duration) && shot.duration > 0,
      )
    )
      return unknown("Multi-shot billing requires supported multi_shots and multi_prompt[].duration fields.");
    quantity = shots.reduce((sum, shot) => sum + Number(shot.duration), 0);
  } else if (
    Object.keys(input).some((key) => /shot|multi_prompt/.test(key) && !["multi_shots", "multi_prompt"].includes(key))
  )
    return unknown("Unsupported multi-shot input fields.");
  // Catalogue: ‘Uses the first 15 seconds of the source video and preserves source audio.’
  const lightSource =
    record.endpoint === "higgsfield/genjutsu-light/motion-transfer/v1.0" && tier.basis === "output-second";
  if (!multiShot && (tier.basis === "source-second" || lightSource)) {
    const primary =
      typeof effective.video_url === "string"
        ? effective.video_url
        : Array.isArray(effective.video_urls)
          ? effective.video_urls[0]
          : videos.length === 1
            ? videos[0]
            : undefined;
    quantity = typeof primary === "string" ? context.media?.[primary]?.durationSec : undefined;
  }
  if (
    typeof quantity !== "number" ||
    !Number.isFinite(quantity) ||
    quantity <= 0 ||
    (tier.basis === "image" && !Number.isInteger(quantity))
  )
    return unknown("Positive explicit duration or measured source duration/count required.");
  // tests/fixtures/higgsfield/docs/models_seedance-2-5_video-edit.md: Usage notes pad to 4s.
  // The same recorded docs directory's models_genjutsu_{motion-transfer,object-swap,restyle}.md trim to 30s.
  // Their /estimate pricing descriptions bill prepared source seconds, rounded upwards.
  const prepared =
    tier.basis === "source-second" && record.endpoint === "bytedance/seedance-2.5/video-edit"
      ? Math.max(4, quantity)
      : tier.basis === "source-second" &&
          /^higgsfield\/genjutsu\/(motion-transfer|object-swap|restyle)\/v1\.0$/.test(record.endpoint)
        ? Math.min(quantity, 30)
        : quantity;
  const seconds = lightSource ? Math.min(prepared, 15) : prepared;
  const rounded =
    lightSource || tier.rounding === "ceil-second"
      ? Math.ceil(seconds)
      : tier.rounding === "nearest-second"
        ? Math.round(seconds)
        : seconds;
  const count = tier.capSeconds === undefined ? rounded : Math.min(rounded, tier.capSeconds);
  let extraUsd = 0;
  for (const extra of tier.extras ?? []) {
    const value = effective[extra.field];
    if (value !== undefined && !Array.isArray(value)) return unknown(`Array count required for ${extra.field}.`);
    extraUsd += Math.max(0, (value?.length ?? 0) - extra.includedCount) * extra.usdPerExtra;
  }
  // Approximate published rates reserve 25% above the calculated amount, including extras.
  const discounted = (tier.usdPerUnit * count + extraUsd) * (tier.approximate ? 1.25 : 1);
  const undiscounted = undiscountedAmount(record, discounted);
  const amounts = reserveAmount(record, discounted, undiscounted, record.observedAsOf, now);
  return {
    ...base,
    ...amounts,
    tier,
    pricing:
      amounts.amount > 0 && Number.isFinite(amounts.amount)
        ? { kind: "fixed", usdPerUnit: amounts.amount, quantity: "request" }
        : { kind: "unknown", reason: "Unreviewed zero or invalid tier rate." },
  };
}
export function higgsfieldPriceFor(
  endpoint: string,
  input: Record<string, unknown>,
  context?: HiggsfieldPricingContext,
  file?: string,
): HiggsfieldPrice | undefined {
  const record = higgsfieldPriceRecordFor(endpoint, input, file);
  return record && higgsfieldPricingFor(record, input, context);
}

const number = z.preprocess(
  (value) => (typeof value === "string" && value.trim() ? Number(value) : value),
  z.number().finite().nonnegative(),
);
const EstimateAnswerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("estimate"),
      usd: number,
      credits: number.optional(),
      discount: z.object({ usd: number, percentage: number }).passthrough().nullable().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("description"), pricing_description: z.string().min(1) }).passthrough(),
]);
export function higgsfieldEstimateFromAnswer(
  input: Record<string, unknown>,
  answer: unknown,
  observedAt: string,
): HiggsfieldEstimate {
  const row = EstimateAnswerSchema.parse(answer);
  return HiggsfieldEstimateSchema.parse({
    input,
    type: row.type,
    observedAt,
    ...(row.type === "description"
      ? { pricingDescription: row.pricing_description }
      : {
          usd: row.usd,
          ...(row.credits !== undefined ? { credits: row.credits } : {}),
          ...(row.discount ? { discountUsd: row.discount.usd, discountPercentage: row.discount.percentage } : {}),
        }),
  });
}
/** Two observations can diagnose a fixed charge or a slope, but never authorise extrapolation. */
export function separateHiggsfieldDurationCosts(
  estimates: readonly HiggsfieldEstimate[],
): { fixedUsd: number; usdPerSecond: number } | undefined {
  const rows = estimates.filter(
    (row) => row.type === "estimate" && row.usd !== undefined && typeof row.input.duration === "number",
  );
  for (const first of rows)
    for (const second of rows) {
      const { duration: a, ...aRest } = first.input,
        { duration: b, ...bRest } = second.input;
      if (typeof a !== "number" || typeof b !== "number" || b <= a || canonicalJson(aRest) !== canonicalJson(bRest))
        continue;
      const slope = (second.usd! - first.usd!) / (b - a),
        fixed = first.usd! - slope * a;
      if (slope >= 0 && fixed >= -1e-9) return { fixedUsd: Math.max(0, fixed), usdPerSecond: slope };
    }
  return undefined;
}

export type HiggsfieldFetch = (
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;
export type HiggsfieldNetworkOptions = {
  apiKey?: string;
  maxRetries?: number;
  maxWaitMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
};
export async function higgsfieldPricingRequest(
  fetchImpl: HiggsfieldFetch,
  url: string,
  input: Record<string, unknown> | undefined,
  options: HiggsfieldNetworkOptions = {},
  publicRequest = false,
): Promise<unknown> {
  if (input) assertHiggsfieldPublicInput(input);
  const target = new URL(url);
  if (
    target.protocol !== "https:" ||
    target.origin !== (publicRequest ? "https://dash.higgsfield.ai" : "https://api.higgsfield.ai")
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Untrusted Higgsfield pricing URL." });
  const key = options.apiKey ?? process.env.HIGGSFIELD_API_KEY;
  const colon = key?.indexOf(":") ?? -1;
  if (!publicRequest && (!key || colon <= 0 || colon === key.length - 1))
    throw new CliErrorObject({
      code: "MISSING_API_KEY",
      message: "HIGGSFIELD_API_KEY must contain an id and secret separated by a colon.",
    });
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    let status = 0,
      retry: string | null = null;
    try {
      const response = await fetchImpl(url, {
        method: input ? "POST" : "GET",
        headers: {
          Accept: "application/json",
          ...(!publicRequest ? { Authorization: `Key ${key!.slice(0, colon)}:${key!.slice(colon + 1)}` } : {}),
          ...(input ? { "Content-Type": "application/json" } : {}),
        },
        ...(input ? { body: generationRequestBody(input) } : {}),
        signal: controller.signal,
      });
      status = response.status;
      retry = response.headers.get("retry-after");
      if (response.ok) return await response.json();
      if (status !== 429 && status < 500) {
        let detail = "";
        if (status === 400) {
          const body: unknown = await response.json().catch(() => undefined);
          if (isObject(body) && body.detail !== undefined)
            detail = ` ${typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail)}`;
          if (key) detail = String(redactHiggsfieldCredentials(detail, key));
        }
        throw new CliErrorObject({
          code: status === 401 || status === 403 ? "MISSING_API_KEY" : "VALIDATION",
          message: `Higgsfield pricing HTTP ${status}.${detail}`,
        });
      }
    } catch (error) {
      if (error instanceof CliErrorObject) throw error;
      // Never echo provider errors: a fetch implementation can include credentials in its error text.
    } finally {
      clearTimeout(timer);
    }
    const seconds = retry === null ? NaN : Number(retry);
    const retryMs = Number.isFinite(seconds)
      ? seconds * 1000
      : retry
        ? Math.max(0, Date.parse(retry) - (options.now ?? new Date()).valueOf())
        : NaN;
    const wait = Number.isFinite(retryMs) ? Math.max(0, retryMs) : Math.min(30_000, 1000 * 2 ** attempt);
    if (attempt >= (options.maxRetries ?? 3) || wait > (options.maxWaitMs ?? 60_000))
      throw new CliErrorObject({
        code: status === 429 ? "RATE_LIMIT" : "NETWORK",
        message: `Higgsfield pricing request failed (HTTP ${status || "unavailable"}).`,
        ...(status === 429 ? { retryAfterMs: wait } : {}),
      });
    await sleep(wait);
  }
}
export async function estimateHiggsfield(
  endpoint: string,
  input: Record<string, unknown>,
  fetchImpl: HiggsfieldFetch,
  options: HiggsfieldNetworkOptions = {},
): Promise<HiggsfieldEstimate> {
  if (
    !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(endpoint) ||
    endpoint.split("/").some((part) => part === ".." || part === ".")
  )
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Invalid Higgsfield endpoint." });
  const exactInput = structuredClone(input);
  const estimate = higgsfieldEstimateFromAnswer(
    exactInput,
    await higgsfieldPricingRequest(fetchImpl, higgsfieldPricingSource(endpoint), exactInput, options),
    (options.now ?? new Date()).toISOString(),
  );
  requestEstimates.set(estimateKey(endpoint, exactInput), structuredClone(estimate));
  return estimate;
}

export type SampleMedia = { image?: string; video?: string; audio?: string };
export type HiggsfieldPricingEndpoint = { endpoint: string; family?: string; schema?: JsonSchema };
export const HIGGSFIELD_PRICING_SIBLINGS: Readonly<Record<string, string>> = {
  "higgsfield/genjutsu-light/motion-transfer/v1.0": "higgsfield/genjutsu/motion-transfer/v1.0",
  "higgsfield/ai-influencer": "higgsfield-ai/soul/v2/standard",
};
const PROMPT_ONLY_ENDPOINTS = new Set(["kling-video/v4.0/text-to-video", "kling-video/v4.0-flash/text-to-video"]);
export function minimalHiggsfieldInput(schema: JsonSchema, samples: SampleMedia): Record<string, unknown> {
  const normalise = (node: JsonSchema, recursive = true): JsonSchema => {
    const { allOf, ...base } = node;
    const merged = { ...base };
    for (const child of allOf ?? []) {
      const part = normalise(child, recursive);
      if (part.properties) merged.properties = { ...merged.properties, ...part.properties };
      if (part.required) merged.required = [...new Set([...(merged.required ?? []), ...part.required])];
    }
    if (!recursive) return merged;
    if (merged.properties)
      merged.properties = Object.fromEntries(
        Object.entries(merged.properties).map(([key, field]) => [key, normalise(field)]),
      );
    if (merged.items) merged.items = normalise(merged.items);
    if (merged.anyOf) merged.anyOf = merged.anyOf.map((child) => normalise(child));
    if (merged.oneOf) merged.oneOf = merged.oneOf.map((child) => normalise(child));
    return merged;
  };
  const components = Object.fromEntries(
    Object.entries((schema.$defs ?? {}) as Record<string, JsonSchema>).map(([key, value]) => [key, normalise(value)]),
  );
  const buildSchema = normalise(schema);
  const placeholders: Record<string, unknown> = {};
  const visit = (node: JsonSchema) => {
    for (const [name, field] of Object.entries(node.properties ?? {})) {
      const kind = /video/.test(name)
        ? "video"
        : /audio/.test(name)
          ? "audio"
          : /image/.test(name)
            ? "image"
            : undefined;
      if (kind && /_urls?$/.test(name)) {
        const url = samples[kind];
        if (url) {
          const parsed = new URL(url);
          if (!["http:", "https:"].includes(parsed.protocol))
            throw new Error("Sample media URLs must be public HTTP(S).");
          placeholders[name] = name.endsWith("urls")
            ? Array.from({ length: Math.max(1, field.minItems ?? 1) }, () => url)
            : url;
        }
      }
      visit(field);
    }
    if (node.items) visit(node.items);
    for (const child of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) visit(child);
  };
  visit(buildSchema);
  for (const definition of Object.values(components)) visit(definition);
  const input = exampleFromSchema(buildSchema, components, { placeholders }) as Record<string, unknown>;
  // A null default means "absent": the server rejects an explicit null (soul/standard seed, 2026-11-15).
  for (const [name, field] of Object.entries(buildSchema.properties ?? {}))
    if (input[name] === undefined && field.default !== undefined && field.default !== null)
      input[name] = structuredClone(field.default);
  const fillRequirements = (
    node: JsonSchema,
    value: unknown,
    inherited: Record<string, JsonSchema> = {},
    depth = 0,
  ): void => {
    if (depth > 20) return;
    node = resolveSchema(node, schema.$defs ?? {});
    const properties = { ...inherited };
    for (const [name, field] of Object.entries(normalise(node, false).properties ?? {}))
      properties[name] = { ...properties[name], ...field };
    if (isObject(value)) {
      const required = node.required ?? [];
      const missing = required.filter((name) => !Object.hasOwn(value, name));
      visit({ properties });
      Object.assign(
        value,
        exampleFromSchema(normalise({ type: "object", properties, required: missing }), components, { placeholders }),
      );
      for (const [name, field] of Object.entries(properties))
        if (Object.hasOwn(value, name)) fillRequirements(field, value[name], {}, depth + 1);
    }
    if (Array.isArray(value) && node.items) for (const item of value) fillRequirements(node.items, item, {}, depth + 1);
    for (const child of node.allOf ?? []) fillRequirements(child, value, properties, depth + 1);
    if (node.if) {
      // Prefer a reference branch we can populate over a fallback needing an unavailable sample.
      if (
        isObject(value) &&
        node.if.required?.length &&
        node.if.required.every((name) => Object.hasOwn(value, name) || placeholders[name] !== undefined)
      ) {
        for (const name of node.if.required)
          if (!Object.hasOwn(value, name)) value[name] = structuredClone(placeholders[name]);
      }
      let condition = true;
      try {
        validateJsonSchema(node.if, value, { components: schema.$defs ?? {}, strict: false });
      } catch (error) {
        if (!(error instanceof FalOperationError) || error.code !== "INVALID_INPUT") throw error;
        condition = false;
      }
      const branch = condition ? node.then : node.else;
      if (branch) fillRequirements(branch, value, properties, depth + 1);
    }
  };
  // A filled requirement can change a condition elsewhere in the schema.
  for (let pass = 0; pass < 8; pass++) {
    const before = canonicalJson(input);
    fillRequirements(schema, input);
    if (canonicalJson(input) === before) break;
  }
  // Do not allow private placeholder media URLs into estimates, including nested training images.
  const checkMedia = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(checkMedia);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [name, field] of Object.entries(value)) {
      if (
        /_urls?$/.test(name) &&
        /image|video|audio/.test(name) &&
        field != null &&
        (!Array.isArray(field) || field.length)
      ) {
        if (placeholders[name] === undefined) throw new Error(`A public sample URL is required for ${name}.`);
      }
      checkMedia(field);
    }
  };
  checkMedia(input);
  validateJsonSchema(schema, input, { components, strict: false });
  return input;
}
const CatalogSchema = z
  .object({
    results: z.array(
      z
        .object({
          slug: z.string(),
          entry_points: z.array(z.object({ mode_id: z.string() })).optional(),
          pricing: z
            .object({
              primary: z
                .object({
                  amount: number,
                  original_amount: number.nullable(),
                  unit: z.string(),
                  qualifier: z.string().nullable(),
                  currency: z.literal("USD"),
                  discount_percentage: number.nullable(),
                  discount_expires_at: z.string().nullable(),
                  discount_after_expiry_percentage: number.nullable(),
                  discount_after_expiry_expires_at: z.string().nullable(),
                })
                .nullable(),
            })
            .optional(),
        })
        .passthrough(),
    ),
    next: z.string().nullable().optional(),
  })
  .passthrough();
export function higgsfieldCataloguePrices(
  data: unknown,
): Map<string, { family: string; list: HiggsfieldPriceRecord["list"] }> {
  const rows = CatalogSchema.parse(data);
  const prices = new Map<string, { family: string; list: HiggsfieldPriceRecord["list"] }>();
  for (const row of rows.results) {
    const p = row.pricing?.primary;
    const list = p
      ? HiggsfieldListPriceSchema.parse({
          amount: p.amount,
          originalAmount: p.original_amount,
          unit: p.unit,
          qualifier: p.qualifier,
          discountPercentage: p.discount_percentage,
          discountExpiresAt: p.discount_expires_at,
          discountAfterExpiryPercentage: p.discount_after_expiry_percentage,
          discountAfterExpiryExpiresAt: p.discount_after_expiry_expires_at,
        })
      : null;
    for (const entry of row.entry_points ?? []) prices.set(entry.mode_id, { family: row.slug, list });
    prices.set(row.slug, { family: row.slug, list });
  }
  return prices;
}
export type HiggsfieldPricingSyncResult = {
  records: HiggsfieldPriceRecord[];
  failed: { endpoint: string; reason: string }[];
  partial: boolean;
  parsed: number;
  unknown: number;
  discounted: number;
  diagnostics: Record<string, { fixedUsd: number; usdPerSecond: number }>;
};
const CheckpointSchema = z.object({
  date: z.string(),
  endpoint: z.string(),
  record: HiggsfieldPriceRecordSchema,
  failed: z.array(z.object({ endpoint: z.string(), reason: z.string() })),
  diagnostics: z.object({ fixedUsd: z.number(), usdPerSecond: z.number() }).optional(),
  retryable: z.boolean().optional(),
  inputKey: z.string().optional(),
});
export async function syncHiggsfieldPrices(
  endpoints: readonly HiggsfieldPricingEndpoint[],
  fetchImpl: HiggsfieldFetch,
  options: HiggsfieldNetworkOptions & {
    samples?: SampleMedia;
    catalogue?: unknown;
    checkpointFile?: string;
    resume?: boolean;
  } = {},
): Promise<HiggsfieldPricingSyncResult> {
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const records = new Map<string, HiggsfieldPriceRecord>();
  let partial = false;
  const failed: HiggsfieldPricingSyncResult["failed"] = [],
    diagnostics: HiggsfieldPricingSyncResult["diagnostics"] = {};
  const completed = new Map<string, z.infer<typeof CheckpointSchema>>();
  if (options.resume && options.checkpointFile && existsSync(options.checkpointFile)) {
    const contents = readFileSync(options.checkpointFile, "utf8");
    const complete = contents.slice(0, contents.lastIndexOf("\n") + 1);
    if (complete.length !== contents.length) truncateSync(options.checkpointFile, Buffer.byteLength(complete));
    for (const line of complete.split("\n").filter(Boolean)) {
      const row = CheckpointSchema.parse(JSON.parse(line));
      if (row.date === date) completed.set(row.endpoint, row);
    }
  }
  let catalogue = new Map<string, { family: string; list: HiggsfieldPriceRecord["list"] }>();
  let catalogueFailure: string | undefined;
  if (options.catalogue !== undefined) catalogue = higgsfieldCataloguePrices(options.catalogue);
  else {
    try {
      let url: string | null = HF_CATALOG_PRICING_URL;
      const seen = new Set<string>();
      while (url) {
        if (seen.has(url) || new URL(url).origin !== new URL(HF_CATALOG_PRICING_URL).origin)
          throw new Error("Invalid catalogue pagination.");
        seen.add(url);
        const data = await higgsfieldPricingRequest(fetchImpl, url, undefined, options, true);
        for (const [key, value] of higgsfieldCataloguePrices(data)) catalogue.set(key, value);
        const next: string | null | undefined = CatalogSchema.parse(data).next;
        url = next ? new URL(next, url).href : null;
      }
    } catch (error) {
      partial = true;
      catalogueFailure = `Catalogue fetch failed.${error instanceof CliErrorObject ? ` ${error.message}` : ""}`;
    }
  }
  const indexed = new Map(endpoints.map((entry) => [entry.endpoint, entry]));
  for (const entry of [...indexed.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint))) {
    const schema: JsonSchema | undefined = PROMPT_ONLY_ENDPOINTS.has(entry.endpoint)
      ? { type: "object", required: ["prompt"], properties: { prompt: { type: "string", const: "a red fox in snow" } } }
      : (entry.schema ?? indexed.get(HIGGSFIELD_PRICING_SIBLINGS[entry.endpoint] ?? "")?.schema);
    const inputKey = createHash("sha256")
      .update(canonicalJson({ samplingVersion: 2, schema: schema ?? null, samples: options.samples ?? {} }))
      .digest("hex");
    const info = catalogue.get(entry.endpoint) ?? (entry.family ? catalogue.get(entry.family) : undefined);
    const failures: HiggsfieldPricingSyncResult["failed"] = [];
    let retryable = Boolean(catalogueFailure && !info);
    if (catalogueFailure && !info) failures.push({ endpoint: entry.endpoint, reason: catalogueFailure });
    const cached = completed.get(entry.endpoint);
    if (cached && !cached.retryable && cached.inputKey === inputKey) {
      records.set(entry.endpoint, info ? { ...cached.record, ...info } : cached.record);
      failed.push(...failures, ...cached.failed);
      if (cached.diagnostics) diagnostics[entry.endpoint] = cached.diagnostics;
      continue;
    }
    const record: HiggsfieldPriceRecord = {
      endpoint: entry.endpoint,
      ...((info?.family ?? entry.family) ? { family: info?.family ?? entry.family } : {}),
      list: info?.list ?? null,
      tiers: [],
      estimates: [],
      observedAsOf: date,
    };
    try {
      if (entry.endpoint === "v1/custom-references") record.unparsed = "training; no estimate route";
      else {
        if (!schema) throw new Error("No schema or documented sibling schema available.");
        const input = minimalHiggsfieldInput(schema, options.samples ?? {});
        const duration = schema.properties?.duration;
        const allowed = duration?.enum
          ?.filter((value): value is number => typeof value === "number" && Number.isInteger(value))
          .sort((a, b) => a - b);
        const minimum = allowed?.[0] ?? duration?.minimum ?? 1;
        const second = allowed?.length
          ? allowed.includes(minimum + 5)
            ? minimum + 5
            : allowed.find((value) => value > minimum)
          : minimum + 5;
        const durations =
          duration?.type === "integer"
            ? [
                ...new Set(
                  [minimum, second].filter(
                    (value): value is number =>
                      value !== undefined && (duration.maximum === undefined || value <= duration.maximum),
                  ),
                ),
              ]
            : [undefined];
        const resolution = schema.properties?.resolution;
        const resolutions = resolution?.enum ?? [undefined];
        for (const seconds of durations) {
          for (const value of resolutions) {
            if (record.tiers.length && value !== resolutions[0]) break;
            const sample = {
              ...input,
              ...(seconds !== undefined ? { duration: seconds } : {}),
              ...(value !== undefined ? { resolution: value } : {}),
            };
            validateJsonSchema(schema, sample, {
              components: (schema.$defs ?? {}) as Record<string, JsonSchema>,
              strict: false,
            });
            const estimate = await estimateHiggsfield(entry.endpoint, sample, fetchImpl, options);
            record.estimates.push(estimate);
            if (estimate.pricingDescription) {
              const parsed = parseHiggsfieldPricing(estimate.pricingDescription);
              record.tiers = parsed.tiers;
              record.unparsed = parsed.unparsed;
            }
          }
        }
      }
    } catch (error) {
      retryable ||=
        !(error instanceof CliErrorObject) ||
        ["NETWORK", "TIMEOUT", "RATE_LIMIT", "MISSING_API_KEY"].includes(error.code);
      partial ||= retryable;
      failures.push({ endpoint: entry.endpoint, reason: error instanceof Error ? error.message : "Estimate failed." });
    }
    const diagnostic = separateHiggsfieldDurationCosts(record.estimates);
    if (diagnostic) diagnostics[entry.endpoint] = diagnostic;
    const checked = HiggsfieldPriceRecordSchema.parse(record);
    records.set(entry.endpoint, checked);
    failed.push(...failures);
    if (options.checkpointFile) {
      mkdirSync(path.dirname(options.checkpointFile), { recursive: true });
      appendFileSync(
        options.checkpointFile,
        `${JSON.stringify({ date, endpoint: entry.endpoint, record: checked, failed: failures, retryable, inputKey, ...(diagnostic ? { diagnostics: diagnostic } : {}) })}\n`,
      );
    }
  }
  const sorted = [...records.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const parsed = sorted.filter(
    (row) => row.tiers.length || row.estimates.some((estimate) => estimate.type === "estimate"),
  ).length;
  return {
    records: sorted,
    failed,
    partial,
    parsed,
    unknown: sorted.length - parsed,
    discounted: sorted.filter(
      (row) => row.list?.discountPercentage || row.estimates.some((estimate) => estimate.discountUsd),
    ).length,
    diagnostics,
  };
}

export type HiggsfieldScenarioEntry = FalCatalogEntry & { inputSchema?: JsonSchema };

function scenarioSchema(entry: HiggsfieldScenarioEntry): JsonSchema | undefined {
  if (entry.inputSchema) return entry.inputSchema;
  if (PROMPT_ONLY_ENDPOINTS.has(entry.endpoint))
    return {
      type: "object",
      required: ["prompt"],
      properties: { prompt: { type: "string", const: "a red fox in snow" } },
    };
  return (
    resolveProviderSnapshot("higgsfield", entry.endpoint)?.input ??
    resolveProviderSnapshot("higgsfield", HIGGSFIELD_PRICING_SIBLINGS[entry.endpoint] ?? entry.endpoint)?.input
  );
}

/** Exact sample request, shared with discovery callers; never discard prompt or media from its identity. */
export function higgsfieldScenarioInput(
  entry: HiggsfieldScenarioEntry,
  setting: ModelReferenceSetting,
  samples: SampleMedia,
): Record<string, unknown> {
  const schema = scenarioSchema(entry);
  if (!schema) throw new Error("No schema or documented sibling schema available.");
  const checked = checkModelConstraints(entry, {
    categories: [],
    inputs: [],
    outputs: [],
    includeSchemaless: true,
    includeRetiring: true,
    durationSec: setting.durationSec,
    resolution: setting.resolution,
    aspect: setting.aspect,
  });
  if (checked.rejectedBecause.length) throw new Error(checked.rejectedBecause.join("; "));
  const properties: Record<string, JsonSchema> = {};
  const collect = (node: JsonSchema, depth = 0): void => {
    if (depth > 20) return;
    node = resolveSchema(node, schema.$defs ?? {});
    Object.assign(properties, node.properties);
    for (const child of node.allOf ?? []) collect(child, depth + 1);
  };
  collect(schema);
  const input = minimalHiggsfieldInput(schema, samples);
  const set = (names: string[], value: string | number | boolean, required = true): void => {
    const fields = names.filter((name) => properties[name]);
    if (!fields.length && required) throw new Error(`No schema control for requested ${names[0]}.`);
    for (const name of fields) {
      const field = resolveSchema(properties[name]!, schema.$defs ?? {});
      const actual =
        name === "music_length_ms" && typeof value === "number"
          ? value * 1000
          : name === "sound" && typeof value === "boolean"
            ? value
              ? "on"
              : "off"
            : value;
      const member = field.enum?.find(
        (item) =>
          String(item) === String(actual) ||
          (typeof actual === "number" && typeof item === "string" && Number.parseFloat(item) === actual),
      );
      input[name] = member ?? (field.type === "string" ? String(actual) : actual);
    }
  };
  if (setting.durationSec !== undefined)
    set(
      ["duration", "duration_seconds", "duration_sec", "duration_s", "seconds", "music_length_ms"],
      setting.durationSec,
    );
  // A model without a resolution/aspect control renders its own fixed output: price that native request
  // (checkModelConstraints already rejected a documented mismatch). Duration stays strict: a different
  // length is a different scenario.
  if (setting.resolution) set(["resolution", "output_resolution"], setting.resolution, false);
  if (setting.aspect) set(["aspect_ratio", "aspect"], setting.aspect, false);
  if (setting.generateAudio !== undefined) set(["generate_audio", "sound"], setting.generateAudio, false);
  if (setting.images !== undefined) set(["num_images", "num_outputs"], setting.images, setting.images !== 1);
  // A K-resolution or a sample URL does not establish decimal MP or measured source seconds.
  if (setting.megapixels !== undefined) set(["megapixels"], setting.megapixels);
  if (setting.inputMegapixels !== undefined) throw new Error("Measured sample input megapixels are unavailable.");
  if (setting.inputAudioSec !== undefined || setting.inputVideoDurationSec !== undefined)
    throw new Error("Measured sample source duration is unavailable.");
  if (setting.inputCharacters !== undefined) {
    const field = ["text", "script", "prompt"].find((name) => properties[name]);
    if (!field) throw new Error("No schema text control for requested inputCharacters.");
    input[field] = "a".repeat(setting.inputCharacters);
  }
  validateJsonSchema(schema, input, { components: schema.$defs ?? {}, strict: false });
  return input;
}

/** Discovery only: reconstruct a standard sample request, then require full exact-input equality. */
export function higgsfieldScenarioPricingFor(
  record: HiggsfieldPriceRecord,
  entry: HiggsfieldScenarioEntry,
  setting: ModelReferenceSetting,
  now?: Date,
): HiggsfieldPrice | undefined {
  if (record.endpoint !== entry.endpoint) return undefined;
  for (const estimate of [...record.estimates].reverse()) {
    if (estimate.type !== "estimate") continue;
    const samples: SampleMedia = {};
    const collect = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(collect);
        return;
      }
      if (!isObject(value)) return;
      for (const [name, field] of Object.entries(value)) {
        const kind = /video/.test(name)
          ? "video"
          : /audio/.test(name)
            ? "audio"
            : /image/.test(name)
              ? "image"
              : undefined;
        const url = Array.isArray(field) ? field[0] : field;
        if (kind && /_urls?$/.test(name) && typeof url === "string") samples[kind] ??= url;
        collect(field);
      }
    };
    collect(estimate.input);
    let input: Record<string, unknown>;
    try {
      input = higgsfieldScenarioInput(entry, setting, samples);
    } catch {
      continue;
    }
    if (canonicalJson(input) !== canonicalJson(estimate.input)) continue;
    return higgsfieldPricingFor(record, input, { now });
  }
  return undefined;
}

const ScenarioResultSchema = z.object({
  endpoint: z.string(),
  scenario: z.string(),
  status: z.enum(["success", "skipped", "failed"]),
  reason: z.string().optional(),
  inputKey: z.string().optional(),
  estimate: HiggsfieldEstimateSchema.optional(),
});
const ScenarioCheckpointSchema = z.object({
  date: z.iso.date(),
  fingerprint: z.string(),
  result: ScenarioResultSchema,
});
export type HiggsfieldScenarioResult = z.infer<typeof ScenarioResultSchema>;
export type HiggsfieldScenarioSyncOptions = HiggsfieldNetworkOptions & {
  samples?: SampleMedia;
  checkpointFile?: string;
  resume?: boolean;
  concurrency?: number;
  slots?: readonly Pick<ModelSlot, "id" | "categories">[];
  previous?: ReadonlyMap<string, HiggsfieldPriceRecord>;
};

/** Free exact-request estimates. Failures and unselected endpoints retain all previous evidence. */
export async function syncHiggsfieldScenarioEstimates(
  entries: readonly HiggsfieldScenarioEntry[],
  scenarios: PriceScenarios,
  fetchImpl: HiggsfieldFetch,
  options: HiggsfieldScenarioSyncOptions = {},
) {
  const date = (options.now ?? new Date()).toISOString().slice(0, 10);
  const concurrency = options.concurrency ?? 2;
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new CliErrorObject({ code: "INVALID_INPUT", message: "Scenario concurrency must be a positive integer." });
  const records = new Map(options.previous ?? (existsSync(hfPricesPath()) ? loadHiggsfieldPrices() : []));
  const slots = options.slots ?? loadModelSlots().slots;
  const completed = new Map<string, z.infer<typeof ScenarioCheckpointSchema>>();
  const pair = (endpoint: string, scenario: string) => `${endpoint}\0${scenario}`;
  if (options.resume && options.checkpointFile && existsSync(options.checkpointFile)) {
    const contents = readFileSync(options.checkpointFile, "utf8");
    const complete = contents.slice(0, contents.lastIndexOf("\n") + 1);
    if (contents !== complete) truncateSync(options.checkpointFile, Buffer.byteLength(complete));
    for (const line of complete.split("\n").filter(Boolean)) {
      const row = ScenarioCheckpointSchema.parse(JSON.parse(line));
      if (row.date === date) completed.set(pair(row.result.endpoint, row.result.scenario), row);
    }
  }
  const queue = [...new Map(entries.map((entry) => [entry.endpoint, entry])).values()]
    .sort((a, b) => a.endpoint.localeCompare(b.endpoint))
    .flatMap((entry) =>
      scenariosForCategory(entry.category, slots, scenarios).map((scenario) => ({ entry, scenario })),
    );
  const results: HiggsfieldScenarioResult[] = [];
  let cursor = 0,
    requests = 0,
    resumed = 0;
  const countedFetch: HiggsfieldFetch = (url, init) => {
    requests++;
    return fetchImpl(url, init);
  };
  const merge = (entry: HiggsfieldScenarioEntry, estimate: HiggsfieldEstimate): void => {
    const previous = records.get(entry.endpoint);
    const estimates = new Map(previous?.estimates.map((row) => [estimateKey(entry.endpoint, row.input), row]));
    estimates.set(estimateKey(entry.endpoint, estimate.input), estimate);
    const parsed = estimate.pricingDescription ? parseHiggsfieldPricing(estimate.pricingDescription) : undefined;
    const tiers = new Map(previous?.tiers.map((tier) => [canonicalJson(tier.when), tier]));
    for (const tier of parsed?.tiers ?? []) tiers.set(canonicalJson(tier.when), tier);
    records.set(
      entry.endpoint,
      HiggsfieldPriceRecordSchema.parse({
        ...previous,
        endpoint: entry.endpoint,
        ...(entry.family ? { family: entry.family.slug } : {}),
        list: previous?.list ?? null,
        tiers: [...tiers.values()],
        ...(parsed ? { unparsed: parsed.unparsed } : {}),
        estimates: [...estimates.values()],
        observedAsOf: date,
      }),
    );
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (cursor < queue.length) {
        const { entry, scenario } = queue[cursor++]!;
        let schema: JsonSchema | undefined,
          schemaFailure = false;
        try {
          schema = scenarioSchema(entry);
        } catch {
          schemaFailure = true;
        }
        const fingerprint = createHash("sha256")
          .update(
            canonicalJson({
              samplingVersion: 1,
              schema: schema ?? null,
              samples: options.samples ?? {},
              setting: scenario.setting,
              inputs: entry.inputs,
              status: entry.status,
              category: entry.category,
            }),
          )
          .digest("hex");
        const cached = completed.get(pair(entry.endpoint, scenario.id));
        if (cached && cached.fingerprint === fingerprint && cached.result.status === "skipped" && !schemaFailure) {
          results.push(cached.result);
          resumed++;
          continue;
        }
        if (
          cached &&
          cached.fingerprint === fingerprint &&
          cached.result.status === "success" &&
          cached.result.estimate
        ) {
          merge(entry, cached.result.estimate);
          results.push(cached.result);
          resumed++;
          continue;
        }
        let result: HiggsfieldScenarioResult;
        let input: Record<string, unknown>;
        try {
          if (schemaFailure) throw new Error("Schema snapshot could not be read.");
          if (entry.category === "training") throw new Error("Training has no estimate route.");
          input = higgsfieldScenarioInput({ ...entry, inputSchema: schema }, scenario.setting, options.samples ?? {});
        } catch (error) {
          result = {
            endpoint: entry.endpoint,
            scenario: scenario.id,
            status: "skipped",
            reason:
              error instanceof FalOperationError
                ? "Scenario input does not satisfy the schema."
                : error instanceof Error
                  ? error.message
                  : "Scenario input unavailable.",
          };
          results.push(result);
          if (options.checkpointFile) {
            mkdirSync(path.dirname(options.checkpointFile), { recursive: true });
            appendFileSync(options.checkpointFile, `${JSON.stringify({ date, fingerprint, result })}\n`);
          }
          continue;
        }
        try {
          // maxRetries counts additional attempts: two retries are three total requests.
          const estimate = await estimateHiggsfield(entry.endpoint, input, countedFetch, {
            ...options,
            maxRetries: options.maxRetries ?? 2,
          });
          merge(entry, estimate);
          result = {
            endpoint: entry.endpoint,
            scenario: scenario.id,
            status: "success",
            inputKey: estimateKey(entry.endpoint, input),
            estimate,
          };
        } catch (error) {
          result = {
            endpoint: entry.endpoint,
            scenario: scenario.id,
            status: "failed",
            inputKey: estimateKey(entry.endpoint, input),
            reason: error instanceof CliErrorObject ? error.message : "Estimate answer failed validation.",
          };
        }
        results.push(result);
        if (options.checkpointFile) {
          mkdirSync(path.dirname(options.checkpointFile), { recursive: true });
          appendFileSync(options.checkpointFile, `${JSON.stringify({ date, fingerprint, result })}\n`);
        }
      }
    }),
  );
  results.sort((a, b) => a.endpoint.localeCompare(b.endpoint) || a.scenario.localeCompare(b.scenario));
  const perScenario = Object.fromEntries(
    scenarios.scenarios.map((scenario) => {
      const rows = results.filter((row) => row.scenario === scenario.id);
      return [
        scenario.id,
        {
          success: rows.filter((row) => row.status === "success").length,
          skip: rows.filter((row) => row.status === "skipped").length,
          fail: rows.filter((row) => row.status === "failed").length,
        },
      ];
    }),
  );
  const failed = results
    .filter((row) => row.status === "failed")
    .map((row) => ({ endpoint: row.endpoint, scenario: row.scenario, reason: row.reason! }));
  return {
    records: [...records.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint)),
    requests,
    resumed,
    perScenario,
    results,
    failed,
    partial: failed.length > 0,
  };
}

export function higgsfieldPricesFromFixtures(estimates: unknown, catalogue: unknown): HiggsfieldPricingSyncResult {
  const fixture = z
    .object({
      recordedAt: z.iso.date(),
      cases: z.array(
        z.object({
          endpoint: z.string(),
          input: z.record(z.string(), z.unknown()),
          status: z.number(),
          response: z.unknown(),
        }),
      ),
    })
    .parse(estimates);
  const lists = higgsfieldCataloguePrices(catalogue);
  const records = new Map<string, HiggsfieldPriceRecord>();
  const failed: HiggsfieldPricingSyncResult["failed"] = [];
  for (const sample of fixture.cases) {
    const info = lists.get(sample.endpoint);
    const record = records.get(sample.endpoint) ?? {
      endpoint: sample.endpoint,
      ...(info?.family ? { family: info.family } : {}),
      list: info?.list ?? null,
      tiers: [],
      estimates: [],
      observedAsOf: fixture.recordedAt,
    };
    if (sample.status !== 200)
      failed.push({
        endpoint: sample.endpoint,
        reason: `Higgsfield pricing HTTP ${sample.status}.${sample.status === 400 && isObject(sample.response) && sample.response.detail !== undefined ? ` ${typeof sample.response.detail === "string" ? sample.response.detail : JSON.stringify(sample.response.detail)}` : ""}`,
      });
    else {
      const estimate = higgsfieldEstimateFromAnswer(sample.input, sample.response, fixture.recordedAt);
      record.estimates.push(estimate);
      if (estimate.pricingDescription) Object.assign(record, parseHiggsfieldPricing(estimate.pricingDescription));
    }
    records.set(sample.endpoint, HiggsfieldPriceRecordSchema.parse(record));
  }
  const sorted = [...records.values()].sort((a, b) => a.endpoint.localeCompare(b.endpoint));
  const parsed = sorted.filter(
    (row) => row.tiers.length || row.estimates.some((estimate) => estimate.type === "estimate"),
  ).length;
  return {
    records: sorted,
    failed,
    partial: fixture.cases.some((sample) => [401, 403, 429].includes(sample.status) || sample.status >= 500),
    parsed,
    unknown: sorted.length - parsed,
    discounted: sorted.filter(
      (row) => row.list?.discountPercentage || row.estimates.some((estimate) => estimate.discountUsd),
    ).length,
    diagnostics: Object.fromEntries(
      sorted.flatMap((record) => {
        const value = separateHiggsfieldDurationCosts(record.estimates);
        return value ? [[record.endpoint, value]] : [];
      }),
    ),
  };
}

/** One usage row: a model's quantity and cost in one time bucket (`bucket` is a naive UTC datetime, e.g. 2026-11-15T08:00:00). */
const UsageRowSchema = z
  .object({
    model: z.string().min(1),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2})?)?$/),
    quantity: number,
    unit_price: number,
    cost: number,
  })
  .passthrough();
export type HiggsfieldUsageRow = z.infer<typeof UsageRowSchema>;
export type HiggsfieldLedgerRow = {
  provider?: string;
  service?: string;
  model: string;
  ts: string;
  units: number | null;
  estimatedUsd: number | null;
  actualUsd?: number | null;
};
/** The live shape (recorded 2026-11-15, tests/fixtures/higgsfield/usage.json): `{time_series:[{bucket, results:[{model, quantity, unit_price, cost}]}], total, page, limit}`. */
const UsagePageSchema = z
  .object({
    time_series: z.array(
      z
        .object({ bucket: z.string().min(1), results: z.array(z.object({ model: z.string().min(1) }).passthrough()) })
        .passthrough(),
    ),
    total: z.number().int().nonnegative(),
    page: z.number().int().positive(),
    limit: z.number().int().positive(),
  })
  .passthrough();
/** Valid query values (live 422s): timeframe hour|day|week|month, expand time_series|summary|auth_method; start/end bound the window. */
export async function fetchHiggsfieldUsage(
  fetchImpl: HiggsfieldFetch,
  options: HiggsfieldNetworkOptions & { start?: string; end?: string } = {},
): Promise<HiggsfieldUsageRow[]> {
  const rows: HiggsfieldUsageRow[] = [];
  for (let page = 1; page <= 100; page++) {
    const params = new URLSearchParams({ limit: "100", page: String(page) });
    if (options.start) params.set("start", options.start);
    if (options.end) params.set("end", options.end);
    const answer = UsagePageSchema.parse(
      await higgsfieldPricingRequest(fetchImpl, `https://api.higgsfield.ai/models/usage?${params}`, undefined, options),
    );
    for (const bucket of answer.time_series)
      for (const result of bucket.results) rows.push(UsageRowSchema.parse({ ...result, date: bucket.bucket }));
    if (answer.time_series.length === 0 || page * answer.limit >= answer.total) break;
  }
  return rows;
}
/** Read-only before/after evidence; account analytics cannot prove attribution or final billing. */
export async function summariseHiggsfieldUsage(
  date: string,
  fetchImpl: HiggsfieldFetch,
  options: HiggsfieldNetworkOptions = {},
) {
  z.iso.date().parse(date);
  const rows = (
    await fetchHiggsfieldUsage(fetchImpl, { ...options, start: `${date}T00:00:00Z`, end: `${date}T23:59:59.999Z` })
  ).filter((row) => row.date.slice(0, 10) === date);
  const models = new Map<string, { model: string; costUsd: number; quantity: number }>();
  for (const row of rows) {
    const total = models.get(row.model) ?? { model: row.model, costUsd: 0, quantity: 0 };
    total.costUsd += row.cost;
    total.quantity += row.quantity;
    models.set(row.model, total);
  }
  return {
    date,
    authority: "analytics, not billing",
    scope: "Account-wide; concurrent activity and reporting delays prevent attribution to this run.",
    observedAt: (options.now ?? new Date()).toISOString(),
    costUsd: rows.reduce((sum, row) => sum + row.cost, 0),
    rows: rows.length,
    models: [...models.values()].sort((a, b) => a.model.localeCompare(b.model)),
  };
}
export function reconcileHiggsfieldUsage(
  usage: readonly HiggsfieldUsageRow[],
  ledger: readonly HiggsfieldLedgerRow[],
  options: { start?: string; end?: string } = {},
) {
  type Total = {
    model: string;
    day: string;
    usageUsd: number;
    usageQuantity: number;
    ledgerUsd: number;
    ledgerQuantity: number;
    unresolved: number;
    estimated: number;
  };
  const totals = new Map<string, Total>();
  const get = (model: string, day: string) => {
    const key = `${model}\0${day}`;
    if (!totals.has(key))
      totals.set(key, {
        model,
        day,
        usageUsd: 0,
        usageQuantity: 0,
        ledgerUsd: 0,
        ledgerQuantity: 0,
        unresolved: 0,
        estimated: 0,
      });
    return totals.get(key)!;
  };
  const included = (day: string) =>
    (!options.start || day >= options.start.slice(0, 10)) && (!options.end || day <= options.end.slice(0, 10));
  for (const value of usage) {
    const row = UsageRowSchema.parse(value),
      day = row.date.slice(0, 10);
    if (!included(day)) continue;
    const total = get(row.model, day);
    total.usageUsd += row.cost;
    total.usageQuantity += row.quantity;
  }
  for (const row of ledger) {
    if ((row.provider ?? row.service) !== "higgsfield") continue;
    const day = row.ts.slice(0, 10);
    if (!included(day)) continue;
    const total = get(row.model, day),
      cost = row.actualUsd ?? row.estimatedUsd;
    if (cost === null || cost === undefined) total.unresolved++;
    else {
      if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid ledger cost.");
      total.ledgerUsd += cost;
      if (row.actualUsd == null) total.estimated++;
    }
    total.ledgerQuantity += row.units ?? 0;
  }
  return {
    authority: "analytics, not billing",
    scope: "Account-wide provider usage compared with this project only; other projects can explain differences.",
    rows: [...totals.values()]
      .sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model))
      .map((row) => ({
        ...row,
        differenceUsd: row.unresolved ? null : row.usageUsd - row.ledgerUsd,
        differenceQuantity: row.usageQuantity - row.ledgerQuantity,
      })),
  };
}
