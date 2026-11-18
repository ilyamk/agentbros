import { resolveProviderSnapshot } from "./fal-catalog";
import { canonicalJson } from "../providers/fal-openapi";
import { higgsfieldPricingFor, higgsfieldPriceRecordFor, type HiggsfieldPricingContext } from "./hf-pricing";
import {
  MAX_PRICING_EVIDENCE_BYTES,
  HiggsfieldPricingEvidenceSchema,
  higgsfieldPricingEvidenceDigest,
  higgsfieldPricingInputHash,
  type HiggsfieldPricingEvidenceV1,
  type HiggsfieldPricingPayloadV1,
} from "../../types/pricing-evidence";
import type { HiggsfieldPriceRecord } from "../../types/higgsfield";
import { findModel } from "./registry";
import { publicTariff } from "./public-tariffs";
import { falPriceFor } from "./fal-pricing";
import type { PricingDefinition } from "../../types/models";
import type { ClosedPricingDefinition } from "../../types/pricing-evidence";

/**
 * Sealed paid-admission evidence accepts only the closed pricing contract. Page-derived fal unit
 * interpretations (falUnit, fal-derived formulas, measured input-video seconds) are planning and
 * comparison prices: they never become sealed evidence, so paid use keeps needing an authorised bound.
 */
function sealable(pricing: PricingDefinition): ClosedPricingDefinition | undefined {
  if (
    pricing.falUnit ||
    pricing.kind === "fal-derived" ||
    (pricing.kind === "fixed" && pricing.quantity === "input-video-second")
  )
    return undefined;
  return pricing as ClosedPricingDefinition;
}
/**
 * True when the current fal price for this id is a planning interpretation that cannot be sealed:
 * a page-derived unit, or a registered operation priced only by the API-record fallback.
 * Paid admission treats such a quote as unknown (an authorised --max-cost-usd bound is required).
 */
export function planningOnlyFalPricing(id: string): boolean {
  if (publicTariff(id)) return false;
  const descriptor = findModel(id);
  // A curated registry price (not the API fallback) keeps priority over page-derived planning prices.
  if (
    descriptor &&
    descriptor.pricing.kind !== "unknown" &&
    sealable(descriptor.pricing) &&
    descriptor.source !== platformPricingSourceUrl(id)
  )
    return false;
  const candidates = [descriptor?.pricing, falPriceFor(id)?.pricing].filter(
    (pricing): pricing is PricingDefinition => pricing !== undefined,
  );
  if (candidates.some((pricing) => pricing.kind !== "unknown" && !sealable(pricing))) return true;
  return (
    descriptor !== undefined &&
    descriptor.source === platformPricingSourceUrl(id) &&
    descriptor.pricing.kind !== "unknown"
  );
}
function mustSeal(pricing: PricingDefinition): ClosedPricingDefinition {
  const closed = sealable(pricing);
  if (!closed) throw new Error("Trusted tariff pricing must use the closed sealed-evidence contract.");
  return closed;
}
import {
  PlatformPricingEvidenceSchema,
  PublicListPricingEvidenceSchema,
  platformPricingEvidenceDigest,
  platformPricingSourceUrl,
  pricingEvidenceDigest,
  type PlatformPricingEvidenceV1,
  type PlatformPricingPayloadV1,
  type PricingEvidenceV1,
  type PublicListPricingEvidenceV1,
  type PublicListPricingPayloadV1,
} from "../../types/pricing-evidence";

/** Internal creation authority is the private local publicTariff table, never caller metadata. */
export function createPublicListPricingEvidence(endpoint: string): PublicListPricingEvidenceV1 | undefined {
  const tariff = publicTariff(endpoint);
  if (!tariff) return undefined; // Unknown/manual and five legacy definitions have no full source evidence.
  const payload: PublicListPricingPayloadV1 = {
    kind: "public-list-tariff",
    version: 1,
    provider: "fal.ai",
    endpoint,
    model: endpoint,
    sourceUrl: tariff.evidence.source,
    observedAsOf: tariff.evidence.observedAsOf,
    currency: "USD",
    unit: tariff.evidence.unit,
    conditions: tariff.evidence.conditions,
    acceptance: tariff.evidence.acceptance,
    pricing: mustSeal(tariff.pricing),
  };
  const sha256 = pricingEvidenceDigest(payload);
  const descriptor = findModel(endpoint);
  if (
    !descriptor ||
    descriptor.source !== payload.sourceUrl ||
    pricingEvidenceDigest({ ...payload, pricing: mustSeal(descriptor.pricing) }) !== sha256
  )
    throw new Error("Current registered pricing differs from trusted public tariff descriptor.");
  return PublicListPricingEvidenceSchema.parse({ ...payload, sha256 });
}
/** Historical validation never refreshes rates or requires current operation availability. */
export function validatePublicListPricingEvidence(
  value: unknown,
  expected?: { endpoint: string; model?: string },
): PublicListPricingEvidenceV1 {
  const evidence = PublicListPricingEvidenceSchema.parse(value);
  if (expected && (evidence.endpoint !== expected.endpoint || evidence.model !== (expected.model ?? expected.endpoint)))
    throw new Error("Pricing evidence differs from original endpoint/model binding.");
  return evidence;
}
/**
 * New-operation coherence helper; Stage C must call it before reservation, not on historical resume.
 * Platform pricing API evidence is dispatched to assertCurrentPlatformPricingEvidence.
 */
export function assertCurrentPublicListPricingEvidence(value: unknown, endpoint: string): PricingEvidenceV1 {
  if (typeof value === "object" && value !== null && "provider" in value && value.provider === "higgsfield")
    return assertCurrentHiggsfieldPricingEvidence(value, endpoint);
  if (isPlatformEvidence(value)) return assertCurrentPlatformPricingEvidence(value, endpoint);
  const evidence = validatePublicListPricingEvidence(value, { endpoint });
  const trusted = createPublicListPricingEvidence(endpoint);
  if (!trusted || evidence.sha256 !== trusted.sha256)
    throw new Error("Pricing evidence differs from trusted current public tariff.");
  return evidence;
}
/** Either kind, checked against today's trusted local source. */
export const assertCurrentPricingEvidence = assertCurrentPublicListPricingEvidence;

function isPlatformEvidence(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "platform-pricing-api";
}
/**
 * Evidence for an API-derived quote, built only from the tracked fal-prices.json record.
 * Undefined when quote() would not use the record: a reviewed public tariff exists, the endpoint
 * is in the tracked registry (its explicit price, or unknown, stands), or the unit cannot be bounded.
 */
export function createPlatformPricingEvidence(endpoint: string, file?: string): PlatformPricingEvidenceV1 | undefined {
  if (publicTariff(endpoint) || findModel(endpoint)) return undefined;
  const price = falPriceFor(endpoint, file);
  if (
    !price?.record ||
    price.origin !== "platform-pricing-api" ||
    price.pricing.kind === "unknown" ||
    price.pricing.kind === "free"
  )
    return undefined;
  const sealed = sealable(price.pricing);
  if (!sealed) return undefined;
  const payload: PlatformPricingPayloadV1 = {
    kind: "platform-pricing-api",
    version: 1,
    provider: "fal.ai",
    endpoint,
    model: endpoint,
    source: platformPricingSourceUrl(endpoint),
    observedAsOf: price.observedAsOf,
    currency: "USD",
    unit: price.record.unit,
    unitPrice: price.record.unitPrice,
    acceptance: "not-run",
    pricing: sealed,
  };
  return PlatformPricingEvidenceSchema.parse({ ...payload, sha256: platformPricingEvidenceDigest(payload) });
}
export function validatePlatformPricingEvidence(
  value: unknown,
  expected?: { endpoint: string; model?: string },
): PlatformPricingEvidenceV1 {
  const evidence = PlatformPricingEvidenceSchema.parse(value);
  if (expected && (evidence.endpoint !== expected.endpoint || evidence.model !== (expected.model ?? expected.endpoint)))
    throw new Error("Pricing evidence differs from original endpoint/model binding.");
  return evidence;
}
/** Accepts platform evidence only when it equals evidence rebuilt from the tracked record today. */
export function assertCurrentPlatformPricingEvidence(
  value: unknown,
  endpoint: string,
  file?: string,
): PlatformPricingEvidenceV1 {
  const evidence = validatePlatformPricingEvidence(value, { endpoint });
  const trusted = createPlatformPricingEvidence(endpoint, file);
  if (!trusted || evidence.sha256 !== trusted.sha256)
    throw new Error("Pricing evidence differs from trusted current platform pricing record.");
  return evidence;
}

// Oversized inline media stay in process; persisted evidence retains their exact request hash.
const issuedCompactEvidence = new Map<
  string,
  { input: Record<string, unknown>; context: HiggsfieldPricingContext; record: HiggsfieldPriceRecord }
>();
export function createHiggsfieldPricingEvidence(
  record: HiggsfieldPriceRecord,
  input: Record<string, unknown>,
  context: HiggsfieldPricingContext = {},
  kind: "higgsfield-estimate" | "higgsfield-list" = "higgsfield-estimate",
  canonicalLocale: string | null = new Intl.Collator().resolvedOptions().locale,
): HiggsfieldPricingEvidenceV1 | undefined {
  if (kind === "higgsfield-list") return createHiggsfieldListPricingEvidence(record, canonicalLocale);
  const price = higgsfieldPricingFor(record, input, context);
  if (price.pricing.kind === "unknown" || price.discountedUsd === undefined || price.undiscountedUsd === undefined)
    return undefined;
  const sealed = sealable(price.pricing);
  if (!sealed) return undefined;
  const media = Object.fromEntries(
    Object.entries(context.media ?? {}).map(([url, value]) => [
      url,
      value.durationSec === undefined ? {} : { durationSec: value.durationSec },
    ]),
  );
  const compact = Buffer.byteLength(canonicalJson({ input, media, record }), "utf8") > MAX_PRICING_EVIDENCE_BYTES / 2;
  const payload: HiggsfieldPricingPayloadV1 = {
    kind,
    version: 1,
    provider: "higgsfield",
    endpoint: record.endpoint,
    model: record.endpoint,
    ...(canonicalLocale === null ? {} : { canonicalLocale }),
    source: price.source,
    observedAsOf: record.observedAsOf,
    currency: "USD",
    acceptance: "not-run",
    pricing: sealed,
    discountedUsd: price.discountedUsd,
    undiscountedUsd: price.undiscountedUsd,
    discountApplied: price.discountApplied ?? false,
    inputHash: higgsfieldPricingInputHash(input, canonicalLocale ?? undefined),
    ...(compact ? {} : { input }),
    defaults: context.defaults ?? {},
    media: compact ? {} : media,
    videoInput: context.videoInput ?? false,
    record: compact
      ? { ...record, estimates: record.estimates.map((estimate) => ({ ...estimate, input: {} })) }
      : record,
  };
  const evidence = HiggsfieldPricingEvidenceSchema.parse({
    ...payload,
    sha256: higgsfieldPricingEvidenceDigest(payload),
  });
  if (compact) issuedCompactEvidence.set(evidence.sha256, structuredClone({ input, context, record }));
  return evidence;
}
export function validateHiggsfieldPricingEvidence(
  value: unknown,
  expected?: { endpoint: string; model?: string },
): HiggsfieldPricingEvidenceV1 {
  const evidence = HiggsfieldPricingEvidenceSchema.parse(value);
  if (expected && (evidence.endpoint !== expected.endpoint || evidence.model !== (expected.model ?? expected.endpoint)))
    throw new Error("Higgsfield evidence differs from endpoint/model.");
  return evidence;
}
export function assertCurrentHiggsfieldPricingEvidence(
  value: unknown,
  endpoint: string,
  file?: string,
): HiggsfieldPricingEvidenceV1 {
  const evidence = validateHiggsfieldPricingEvidence(value, { endpoint });
  if (evidence.kind === "higgsfield-list")
    throw new Error("Higgsfield catalogue floors cannot authorise a reservation.");
  const issued = evidence.input === undefined ? issuedCompactEvidence.get(evidence.sha256) : undefined;
  if (evidence.input === undefined && !issued)
    throw new Error("Compact Higgsfield evidence requires an exact request issued in this process before admission.");
  const input = issued?.input ?? evidence.input!;
  const record = higgsfieldPriceRecordFor(endpoint, input, file);
  if (!record || canonicalJson(record) !== canonicalJson(issued?.record ?? evidence.record))
    throw new Error("Higgsfield evidence differs from the current tracked price record.");
  const properties = resolveProviderSnapshot("higgsfield", endpoint)?.input.properties ?? {};
  const defaults = Object.fromEntries(
    Object.entries(properties)
      .filter(([, field]) => field.default !== undefined)
      .map(([key, field]) => [key, field.default]),
  );
  if (canonicalJson(evidence.defaults) !== canonicalJson(defaults))
    throw new Error("Higgsfield pricing defaults differ from the current provider schema.");
  const trusted = createHiggsfieldPricingEvidence(
    record,
    input,
    issued
      ? { ...issued.context, now: undefined }
      : { defaults: evidence.defaults, media: evidence.media, videoInput: evidence.videoInput },
    evidence.kind,
    evidence.canonicalLocale ?? null,
  );
  if (!trusted || trusted.sha256 !== evidence.sha256)
    throw new Error("Higgsfield price or discount is no longer valid for reservation.");
  return evidence;
}

/** Catalogue evidence describes a comparison floor, never a request reservation. */
export function createHiggsfieldListPricingEvidence(
  record: HiggsfieldPriceRecord,
  canonicalLocale: string | null = new Intl.Collator().resolvedOptions().locale,
): HiggsfieldPricingEvidenceV1 | undefined {
  if (!record.list) return undefined;
  const list = record.list;
  const undiscounted =
    list.originalAmount ??
    (list.discountPercentage && list.discountPercentage < 100
      ? list.amount / (1 - list.discountPercentage / 100)
      : list.amount);
  const payload: HiggsfieldPricingPayloadV1 = {
    kind: "higgsfield-list",
    version: 1,
    provider: "higgsfield",
    endpoint: record.endpoint,
    model: record.endpoint,
    ...(canonicalLocale === null ? {} : { canonicalLocale }),
    source: "https://dash.higgsfield.ai/api/v2/catalog-models/?page_size=100",
    observedAsOf: record.observedAsOf,
    currency: "USD",
    acceptance: "not-run",
    pricing: { kind: "unknown", reason: "Catalogue list amount is a comparison floor, not a request price." },
    discountedUsd: list.amount,
    undiscountedUsd: Math.max(list.amount, undiscounted),
    discountApplied: false,
    inputHash: higgsfieldPricingInputHash({}),
    input: {},
    defaults: {},
    media: {},
    videoInput: false,
    record,
  };
  return HiggsfieldPricingEvidenceSchema.parse({ ...payload, sha256: higgsfieldPricingEvidenceDigest(payload) });
}
