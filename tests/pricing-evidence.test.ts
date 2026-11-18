import assert from "node:assert/strict";
import test from "node:test";
import {
  ClosedPricingDefinitionSchema,
  PublicListPricingEvidenceSchema,
  pricingEvidenceDigest,
  type PublicListPricingPayloadV1,
} from "../src/types/pricing-evidence";
import {
  createPublicListPricingEvidence,
  validatePublicListPricingEvidence,
  assertCurrentPublicListPricingEvidence,
} from "../src/lib/models/pricing-evidence";
import { publicTariff } from "../src/lib/models/public-tariffs";
import { listModels } from "../src/lib/models/registry";
import { generationInputHash } from "../src/lib/jobs/runner";
import { PriceQuoteSchema, GenerationJobSchema } from "../src/lib/jobs/types";
const endpoint = "fal-ai/kling-video/v3/standard/image-to-video";
function evidence() {
  return createPublicListPricingEvidence(endpoint)!;
}
function payload() {
  const { sha256: _hash, ...value } = evidence();
  return value;
}
function withDigest(value: PublicListPricingPayloadV1) {
  return { ...value, sha256: pricingEvidenceDigest(value) };
}
function quote() {
  const e = evidence();
  return {
    currency: "USD" as const,
    lowUsd: 0.63,
    expectedUsd: 0.63,
    highUsd: 0.63,
    bounded: true as const,
    source: e.sourceUrl,
    asOf: e.observedAsOf,
    confidence: "published-rate" as const,
    providerEnforced: false,
    model: endpoint,
    basis: e.pricing.kind,
    pricingEvidence: e,
  };
}
function job() {
  return {
    operationId: "evidence",
    provider: "fal.ai",
    endpoint,
    inputHash: "input",
    assetId: "asset",
    quote: quote(),
    repair: false,
    state: "reserved",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    reservedMicros: 630000,
    paidAttempts: 0,
    history: [],
    refunds: [],
  };
}

test("trusted factory snapshots all twenty-one public definitions verbatim and leaves five legacy definitions absent", () => {
  const snapshots = listModels()
    .map((model) => [model.id, createPublicListPricingEvidence(model.id)] as const)
    .filter(([, value]) => value !== undefined);
  assert.equal(snapshots.length, 21);
  assert.equal(listModels().filter((model) => model.pricing.kind !== "unknown").length, 26);
  for (const [id, value] of snapshots) {
    const tariff = publicTariff(id)!;
    assert.deepEqual(value!.pricing, tariff.pricing);
    assert.equal(value!.sourceUrl, tariff.evidence.source);
    assert.equal(value!.observedAsOf, tariff.evidence.observedAsOf);
    assert.equal(value!.unit, tariff.evidence.unit);
    assert.equal(value!.conditions, tariff.evidence.conditions);
    assert.equal(value!.acceptance, "not-run");
    assert.deepEqual(assertCurrentPublicListPricingEvidence(value, id), value);
  }
  for (const id of [
    "fal-ai/flux-2-pro",
    "fal-ai/kling-video/v3/pro/image-to-video",
    "bytedance/seedance-2.5/reference-to-video",
    "openai/gpt-image-2.5/sunburst/text-to-image",
    "google/nano-banana-2.1",
    "missing",
    "fal-ai/flux-2",
  ])
    assert.equal(createPublicListPricingEvidence(id), undefined);
  const clone = evidence();
  clone.conditions = "changed";
  assert.notEqual(evidence().conditions, "changed");
});
test("closed full pricing union preserves optional categories and refuses unsupported dimensions and rates", () => {
  const valid = [
    { kind: "unknown", reason: "not published" },
    { kind: "free" },
    { kind: "fixed", usdPerUnit: 0.007 },
    { kind: "fixed", usdPerUnit: 0.14, quantity: "generated-second" },
    {
      kind: "range",
      lowUsdPerUnit: 1,
      expectedUsdPerUnit: 2,
      highUsdPerUnit: 3,
      audioRates: { off: 1, on: 2, voice: 3 },
    },
    { kind: "tokens", ratesPerMillion: { textInput: 1, imageInput: 2, imageOutput: 3 }, forecastMargin: 0.2 },
    { kind: "megapixels", firstUsd: 1, extraUsd: 2, inputExtraUsd: 3 },
    {
      kind: "video-tokens",
      usdPerThousand: 0.02,
      videoReferenceMultiplier: 0.6,
      forecastMargin: 0.05,
      resolutionRates: { "720p": 0.02 },
      acceptsVideoReferences: true,
    },
  ];
  for (const value of valid) {
    assert.deepEqual(ClosedPricingDefinitionSchema.parse(value), value);
    assert.equal(ClosedPricingDefinitionSchema.safeParse({ ...value, secret: "extra" }).success, false);
  }
  const invalid = [
    { kind: "fixed", usdPerUnit: -1 },
    { kind: "fixed", usdPerUnit: NaN },
    { kind: "fixed", usdPerUnit: Infinity },
    { kind: "fixed", usdPerUnit: Number.MAX_VALUE },
    { kind: "fixed", usdPerUnit: 1, quantity: "source-second" },
    { kind: "range", lowUsdPerUnit: 3, expectedUsdPerUnit: 2, highUsdPerUnit: 1 },
    {
      kind: "range",
      lowUsdPerUnit: 1,
      expectedUsdPerUnit: 2,
      highUsdPerUnit: 3,
      audioRates: { off: 1, on: 2, voice: 3, cached: 0 },
    },
    { kind: "tokens", ratesPerMillion: { textInput: 1, imageInput: 2 }, forecastMargin: 0.2 },
    {
      kind: "tokens",
      ratesPerMillion: { textInput: 1, imageInput: 2, imageOutput: 3, unknown: 4 },
      forecastMargin: 0.2,
    },
    { kind: "tokens", ratesPerMillion: { textInput: 1, imageInput: 2, imageOutput: 3 }, forecastMargin: 2 },
    {
      kind: "video-tokens",
      usdPerThousand: 0.02,
      videoReferenceMultiplier: 0.6,
      forecastMargin: 0.05,
      resolutionRates: { "4k": 0.02 },
    },
    { kind: "new-price" },
  ];
  for (const value of invalid)
    assert.equal(ClosedPricingDefinitionSchema.safeParse(value).success, false, JSON.stringify(value));
});
test("canonical digest matches generation convention and every recorded semantic field binds", () => {
  const p = payload();
  assert.equal(pricingEvidenceDigest(p), generationInputHash(p));
  const reversed = Object.fromEntries(Object.entries(p).reverse()) as PublicListPricingPayloadV1;
  assert.equal(pricingEvidenceDigest(reversed), evidence().sha256);
  const changes = [
    { unit: "different unit" },
    { conditions: "different conditions" },
    { observedAsOf: "2026-10-10" },
    { pricing: { kind: "range" as const, lowUsdPerUnit: 1, expectedUsdPerUnit: 2, highUsdPerUnit: 3 } },
    { endpoint: "retired/operation", model: "retired/operation", sourceUrl: "https://fal.ai/models/retired/operation" },
  ];
  for (const change of changes) {
    const changed = { ...p, ...change };
    assert.notEqual(pricingEvidenceDigest(changed), evidence().sha256);
    assert.equal(PublicListPricingEvidenceSchema.safeParse({ ...changed, sha256: evidence().sha256 }).success, false);
    const saved = withDigest(changed);
    assert.deepEqual(validatePublicListPricingEvidence(saved), saved);
    assert.throws(() => assertCurrentPublicListPricingEvidence(saved, changed.endpoint), /trusted current/);
  }
});
test("strict v1 identity, calendar, URL and UTF-8 cap reject malformed/executable evidence without invoking getters", () => {
  for (const change of [
    { version: 2 },
    { currency: "EUR" },
    { provider: "other" },
    { acceptance: "live" },
    { observedAsOf: "2026-02-30" },
    { observedAsOf: "2025-02-29" },
    { sourceUrl: `https://fal.ai/models/${endpoint}?extra=1` },
    { sourceUrl: `https://fal.ai/models/${endpoint}#fragment` },
    { sourceUrl: `https://user@fal.ai/models/${endpoint}` },
    { endpoint: "a/../b" },
    { endpoint: "a/%2e%2e/b" },
    { model: "other/model" },
    { unit: "" },
    { conditions: "" },
    { unit: "x".repeat(201) },
    { conditions: "x".repeat(8193) },
    { sha256: "A".repeat(64) },
    { executable: "shell" },
  ])
    assert.equal(PublicListPricingEvidenceSchema.safeParse({ ...evidence(), ...change }).success, false);
  assert.doesNotThrow(() => withDigest({ ...payload(), observedAsOf: "2024-02-29" }));
  assert.throws(
    () =>
      pricingEvidenceDigest({
        ...payload(),
        conditions: "漢".repeat(8192),
        pricing: { kind: "unknown", reason: "漢".repeat(8192) },
      }),
    /32 KiB/,
  );
  let invoked = false;
  const accessor = { ...evidence() };
  Object.defineProperty(accessor, "conditions", {
    enumerable: true,
    get: () => {
      invoked = true;
      return "fake";
    },
  });
  assert.equal(PublicListPricingEvidenceSchema.safeParse(accessor).success, false);
  assert.equal(invoked, false);
  for (const value of [
    { ...evidence(), unit: undefined },
    { ...evidence(), pricing: new Date() },
    { ...evidence(), extra: () => {} },
    { ...evidence(), pricing: [1, 2] },
    { ...evidence(), [Symbol("extra")]: true },
  ])
    assert.equal(PublicListPricingEvidenceSchema.safeParse(value).success, false);
  const circular: any = { ...evidence() };
  circular.pricing = circular;
  assert.equal(PublicListPricingEvidenceSchema.safeParse(circular).success, false);
});
test("optional quote crossbinding also validates persisted GenerationJob while absent legacy parse bytes stay identical", () => {
  assert.deepEqual(PriceQuoteSchema.parse(quote()), quote());
  assert.deepEqual(GenerationJobSchema.parse(job()), job());
  for (const mutation of [
    { model: "other/model" },
    { source: "different" },
    { asOf: "2026-10-10" },
    { basis: "fixed" },
    { confidence: "user-bound" },
    { pricingEvidence: { ...evidence(), conditions: "tampered" } },
  ]) {
    const changed = { ...quote(), ...mutation };
    assert.equal(PriceQuoteSchema.safeParse(changed).success, false);
    assert.equal(GenerationJobSchema.safeParse({ ...job(), quote: changed }).success, false);
  }
  assert.throws(() => validatePublicListPricingEvidence(evidence(), { endpoint: "other/model" }), /binding/);
  const legacy = {
    currency: "USD",
    lowUsd: 0.1,
    expectedUsd: 0.1,
    highUsd: 0.1,
    bounded: true,
    source: "legacy",
    asOf: "2026-01-01T00:00:00.000Z",
    confidence: "user-bound",
    providerEnforced: false,
  };
  assert.equal(JSON.stringify(PriceQuoteSchema.parse(legacy)), JSON.stringify(legacy));
  assert.deepEqual(PriceQuoteSchema.parse({ ...legacy, arbitraryLegacyExtension: true }), legacy); // Existing whole-quote strip behavior unchanged.
  assert.equal("pricingEvidence" in PriceQuoteSchema.parse(legacy), false);
  const old = withDigest({
    ...payload(),
    observedAsOf: "2020-01-01",
    conditions: "Historical observation",
    pricing: { kind: "fixed", usdPerUnit: 0.01 },
  });
  assert.equal(
    PriceQuoteSchema.safeParse({ ...quote(), asOf: old.observedAsOf, basis: "fixed", pricingEvidence: old }).success,
    true,
  );
  assert.throws(() => assertCurrentPublicListPricingEvidence(old, endpoint), /trusted current/);
});

test("finite JSON rejects array-prototype impostors without changing plain/null/dense-array behavior or invoking getters", () => {
  const e = evidence();
  const exotic = (value: object) => Object.assign(Object.create(Array.prototype), value);
  const top = exotic(e),
    nested = { ...e, pricing: exotic(e.pricing) };
  assert.equal(Array.isArray(top), false);
  for (const value of [top, nested]) {
    const result = PublicListPricingEvidenceSchema.safeParse(value);
    assert.equal(result.success, false);
    if (!result.success)
      assert.ok(
        result.error.issues.some((issue) => /plain finite JSON/.test(issue.message)),
        "impostor rejected before closed-shape normalization",
      );
  }
  const plain = { ...e },
    nullTop = Object.assign(Object.create(null), e),
    nullNested = { ...e, pricing: Object.assign(Object.create(null), e.pricing) };
  for (const value of [plain, nullTop, nullNested]) assert.deepEqual(PublicListPricingEvidenceSchema.parse(value), e);
  for (const array of [[], [1, { finite: true }, null]]) {
    assert.equal(Array.isArray(array), true);
    const result = PublicListPricingEvidenceSchema.safeParse(array);
    assert.equal(result.success, false); // Closed evidence object cannot be an array, but finite-JSON arrays remain supported.
    if (!result.success)
      assert.equal(
        result.error.issues.some((issue) => /plain finite JSON/.test(issue.message)),
        false,
      );
  }
  let calls = 0;
  const getter = { ...e };
  Object.defineProperty(getter, "conditions", {
    enumerable: true,
    get: () => {
      calls++;
      return e.conditions;
    },
  });
  const exoticGetter = exotic(e);
  Object.defineProperty(exoticGetter, "conditions", {
    enumerable: true,
    get: () => {
      calls++;
      return e.conditions;
    },
  });
  for (const value of [getter, exoticGetter, { ...e, pricing: exoticGetter }])
    assert.equal(PublicListPricingEvidenceSchema.safeParse(value).success, false);
  assert.equal(calls, 0);
  for (const array of [new Array(2), Object.assign([1], { extra: 2 }), Object.setPrototypeOf([1], { exotic: true })]) {
    const result = PublicListPricingEvidenceSchema.safeParse(array);
    assert.equal(result.success, false);
    if (!result.success) assert.ok(result.error.issues.some((issue) => /plain finite JSON/.test(issue.message)));
  }
});
