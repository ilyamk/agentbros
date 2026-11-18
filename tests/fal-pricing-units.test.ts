import "./helpers/fal-no-network";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { falNetworkAttempts } from "./helpers/fal-no-network";
import {
  comparePrices,
  falPriceFor,
  FAL_PRICES_FILE,
  FAL_PRICING_BATCH,
  FalPricingSyncError,
  loadFalPrices,
  pricingContext,
  pricingFromRecord,
  type PricingContext,
  resetFalPricesCache,
  serialiseFalPrices,
  syncFalPrices,
} from "../src/lib/models/fal-pricing";
import { publicTariff } from "../src/lib/models/public-tariffs";
import {
  assertCurrentPricingEvidence,
  assertCurrentPublicListPricingEvidence,
  createPlatformPricingEvidence,
  createPublicListPricingEvidence,
} from "../src/lib/models/pricing-evidence";
import {
  PlatformPricingEvidenceSchema,
  PricingEvidenceSchema,
  platformPricingEvidenceDigest,
  pricingEvidenceMatchesQuote,
} from "../src/types/pricing-evidence";
import { quote } from "../src/lib/pricing";
import {
  FalCatalogEntrySchema,
  type FalCatalogEntry,
  type FalCategory,
  type FalPriceRecord,
} from "../src/types/fal-catalog";
import type { PricingDefinition } from "../src/types/models";
import { buildCatalogEntry, findCatalogEntry, resetCatalogCache, writeCatalog } from "../src/lib/models/fal-catalog";
import type { FalApiModel } from "../src/lib/providers/fal-openapi";

const FIXTURE = "tests/fixtures/fal-catalog/pricing.json";
const AS_OF = "2026-11-15";
type ApiRow = { endpoint_id: string; unit: string; unit_price: number; currency: string };
const apiRows = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { prices: ApiRow[] }).prices;
const asRecord = (row: ApiRow): FalPriceRecord => ({
  endpoint: row.endpoint_id,
  unitPrice: row.unit_price,
  unit: row.unit,
  currency: "USD",
  observedAsOf: AS_OF,
  source: "platform-pricing-api",
});
const fixtureRecords: FalPriceRecord[] = apiRows.map(asRecord);
const recordOf = (endpoint: string) => fixtureRecords.find((record) => record.endpoint === endpoint)!;

// A temporary catalogue built from the recorded schemas (category, transport, input fields), plus one
// synthetic speech-to-text entry: the fixture has no minutes-priced transcription endpoint.
const dir = mkdtempSync(path.join(tmpdir(), "fal-pricing-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const fixtureRoot = "tests/fixtures/fal-catalog";
const manifest = JSON.parse(readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8")) as {
  endpoints: Record<string, { sha256: string }>;
};
const entries: FalCatalogEntry[] = apiRows.map((row) =>
  buildCatalogEntry(
    JSON.parse(
      readFileSync(path.join(fixtureRoot, "schemas", `${manifest.endpoints[row.endpoint_id]!.sha256}.json`), "utf8"),
    ) as FalApiModel,
    { today: AS_OF, verifiedPins: {} },
  ),
);
const STT = "test/minutes/speech-to-text";
const recognise = entries.find((entry) => entry.endpoint === "mureka/api/song/recognize")!;
entries.push(
  FalCatalogEntrySchema.parse({ ...recognise, endpoint: STT, category: "speech-to-text", routing: undefined }),
);
const UNCATALOGUED = "test/priced/not-catalogued";
const catalogue = path.join(dir, "catalog");
writeCatalog(entries, catalogue, { syncedAt: AS_OF });
process.env.AGENTBROS_FAL_CATALOG_DIR = catalogue;
resetCatalogCache();
const pricesFile = path.join(dir, "fal-prices.json");
writeFileSync(
  pricesFile,
  serialiseFalPrices(
    [
      ...fixtureRecords,
      { ...recordOf("fal-ai/sync-lipsync"), endpoint: STT, unitPrice: 0.006 },
      { ...recordOf("fal-ai/nano-banana"), endpoint: UNCATALOGUED },
    ],
    AS_OF,
  ),
);
process.env.AGENTBROS_FAL_PRICES = pricesFile;
resetFalPricesCache();
const contextOf = (endpoint: string) => pricingContext(findCatalogEntry(endpoint)!);
const converted = (endpoint: string) => pricingFromRecord(recordOf(endpoint), contextOf(endpoint));
const reasonOf = (definition: PricingDefinition) =>
  definition.kind === "unknown"
    ? definition.reason
    : assert.fail(`expected unknown, got ${JSON.stringify(definition)}`);

test("tracked fal-prices.json is valid (real sync, keyed by endpoint)", () => {
  const tracked = loadFalPrices(FAL_PRICES_FILE);
  for (const [endpoint, record] of tracked) assert.equal(record.endpoint, endpoint);
  resetFalPricesCache();
});

test("every fixture record maps by unit and catalogue category, as the gated unit table says", () => {
  const fixed = (quantity: string) => (endpoint: string) =>
    assert.deepEqual(
      converted(endpoint),
      { kind: "fixed", usdPerUnit: recordOf(endpoint).unitPrice, quantity },
      endpoint,
    );
  const unknown = (pattern: RegExp) => (endpoint: string) =>
    assert.match(reasonOf(converted(endpoint)), pattern, endpoint);
  const expected: Record<string, (endpoint: string) => void> = {
    "bytedance/seedream/v5/lite/edit": fixed("output"),
    "fal-ai/nano-banana": fixed("output"),
    "meshy/v7/image-to-3d": fixed("request"),
    "meshy/v7/text-to-3d": fixed("request"),
    "meshy/t2.5/text-to-3d": fixed("request"),
    "fal-ai/meshy/rigging/multi-animation": fixed("request"),
    "fal-ai/kling-video/v2.6/pro/text-to-video": fixed("generated-second"),
    "fal-ai/kling-video/v3/pro/text-to-video": fixed("generated-second"),
    "fal-ai/pixverse/c1/transition": fixed("generated-second"),
    "vast/eden-live-14b-video": fixed("generated-second"),
    "fal-ai/elevenlabs/tts/turbo-v2.5": fixed("input-kilo-characters"),
    "fal-ai/minimax/preview/speech-2.5-hd": fixed("input-kilo-characters"),
    "fal-ai/flux/schnell": (endpoint) =>
      assert.deepEqual(converted(endpoint), { kind: "megapixels", firstUsd: 0.003, extraUsd: 0.003, inputExtraUsd: 0 }),
    "fal-ai/flux/srpo": (endpoint) => assert.equal(converted(endpoint).kind, "megapixels"),
    // The cases the first version under-reserved:
    "blackforestlabs/flux-3/klein/base/trainer": unknown(/training bills by steps/),
    "fal-ai/ltx-2.3-22b/distilled/audio-to-video": unknown(/megapixels in category audio-to-video/),
    "mureka/api/generate/speech": unknown(/output minutes not forecastable/),
    "fal-ai/sa2va/4b/video": unknown(/seconds in category vision/),
    "kotoba-technologies/kotoba-sts/v1/realtime_voice": unknown(/realtime session seconds/),
    "xai/grok-voice/realtime": unknown(/realtime session seconds/),
    "fal-ai/sync-lipsync": unknown(/output minutes not forecastable in category video-to-video/),
    "fal-ai/ace-step/audio-outpaint": unknown(/seconds in category audio-to-audio/),
    "vast/eden-live-5b-game": unknown(/seconds in category worlds/),
    "fal-ai/ltx-video-13b-distilled/image-to-video": unknown(/no output-count field/),
    "fal-ai/hunyuan-3d/v3.1/rapid/text-to-3d": unknown(/no output-count field/),
    "hyper3d/rigging": unknown(/no output-count field/),
    "mureka/v8/generate/song": unknown(/no output-count field/),
    "topaz/sdr-to-hdr/video": unknown(/no output-count field/),
    "fal-ai/stable-audio-3/small/music/base/audio-outpainting": unknown(/category audio-to-audio/),
    "mureka/v9.5/generate/soundtrack": unknown(/category video-to-audio/),
    "fal-ai/sam-audio/visual-separate": unknown(/category video-to-audio/),
    "fal-ai/moondream3-preview/detect": unknown(/category vision/),
    "openrouter/router/decisions": unknown(/category text-to-text/),
    "openrouter/router/audio": unknown(/category unknown/),
    "bria/fibo-edit/edit/structured_instruction": unknown(/category text-to-json/),
    "bria/fibo-lite/generate/structured_prompt": unknown(/category text-to-json/),
    "mureka/api/files/upload": unknown(/category unknown/),
    "mureka/api/generate/lyrics": unknown(/category text-to-text/),
    "mureka/api/song/recognize": unknown(/category audio-to-text/),
  };
  for (const record of fixtureRecords) {
    if (["1000 tokens", "compute seconds", "credits"].includes(record.unit)) {
      assert.match(reasonOf(converted(record.endpoint)), new RegExp(`'${record.unit}'`));
      continue;
    }
    const check = expected[record.endpoint];
    assert.ok(check, `${record.endpoint} (${record.unit}) has no expectation`);
    check(record.endpoint);
  }
  assert.deepEqual(falPriceFor(STT)!.pricing, { kind: "fixed", usdPerUnit: 0.006, quantity: "input-audio-minute" });
  const ctx = (
    category: FalCategory,
    inputFields: string[] = [],
    transport: PricingContext["transport"] = "queue",
  ): PricingContext => ({ category, inputFields, transport });
  assert.deepEqual(pricingFromRecord({ unit: "units", unitPrice: 0.02 }, ctx("text-to-image", ["num_images"])), {
    kind: "fixed",
    usdPerUnit: 0.02,
    quantity: "output",
  });
  assert.deepEqual(pricingFromRecord({ unit: "generations", unitPrice: 0.02 }, ctx("text-to-video", ["num_outputs"])), {
    kind: "fixed",
    usdPerUnit: 0.02,
    quantity: "output",
  });
  assert.deepEqual(pricingFromRecord({ unit: "requests", unitPrice: 0.02 }, ctx("text-to-image")), {
    kind: "fixed",
    usdPerUnit: 0.02,
    quantity: "request",
  });
  assert.match(
    reasonOf(pricingFromRecord({ unit: "images", unitPrice: 0.02 }, ctx("training", ["num_images"], "training"))),
    /training/,
  );
  assert.match(
    reasonOf(pricingFromRecord({ unit: "seconds", unitPrice: 0.02 }, ctx("text-to-video", [], "realtime"))),
    /realtime/,
  );
  assert.match(
    reasonOf(pricingFromRecord({ unit: "1000 characters", unitPrice: 0.02 }, ctx("text-to-text"))),
    /category text-to-text/,
  );
  assert.match(
    reasonOf(pricingFromRecord({ unit: "images", unitPrice: 0.02 })),
    /no catalogue entry/,
    "no context is never bounded",
  );
  assert.match(
    reasonOf(pricingFromRecord({ unit: "hours of GPU", unitPrice: 2 }, ctx("text-to-image"))),
    /hours of GPU/,
  );
  assert.equal(
    pricingFromRecord({ unit: "images", unitPrice: 0 }, ctx("text-to-image")).kind,
    "unknown",
    "an unreviewed API zero is not free",
  );
  assert.equal(
    falPriceFor(UNCATALOGUED)!.pricing.kind,
    "unknown",
    "a priced endpoint without a catalogue entry stays unknown",
  );
});

test("precedence: reviewed public tariff, then API record, then nothing", () => {
  const kling = "fal-ai/kling-video/v3/pro/text-to-video";
  const reviewed = falPriceFor(kling)!;
  assert.equal(reviewed.origin, "public-tariff");
  assert.deepEqual(reviewed.pricing, publicTariff(kling)!.pricing);
  const api = falPriceFor("fal-ai/nano-banana")!;
  assert.equal(api.origin, "platform-pricing-api");
  assert.equal(api.source, "https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/nano-banana");
  assert.equal(api.observedAsOf, AS_OF);
  assert.equal(falPriceFor("nobody/has-this"), undefined);
});

test("quote: each quantity kind, and a missing quantity is unbounded, never zero", () => {
  const nano = quote({ model: "fal-ai/nano-banana" });
  assert.equal(nano.bounded, true);
  assert.equal(nano.highUsd, 0.0398);
  assert.equal(nano.confidence, "published-rate");
  assert.equal(nano.source, "https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/nano-banana");
  assert.equal(nano.asOf, AS_OF);
  assert.equal(quote({ model: "fal-ai/nano-banana", units: 4 }).highUsd, 0.1592);
  assert.equal(
    quote({ model: "fal-ai/nano-banana", durationSec: 5 }).highUsd,
    0.0398,
    "output count never comes from a duration",
  );
  assert.equal(quote({ model: "fal-ai/nano-banana", units: null }).bounded, false);

  const mesh = "meshy/v7/text-to-3d"; // generations without an output-count field: per request
  assert.equal(quote({ model: mesh }).highUsd, 0.8);
  assert.equal(
    quote({ model: mesh, units: 7, multiplier: 3 }).highUsd,
    2.4,
    "one per request; multiplier counts requests",
  );

  const tts = "fal-ai/elevenlabs/tts/turbo-v2.5";
  const noChars = quote({ model: tts });
  assert.equal(noChars.bounded, false);
  assert.equal(noChars.highUsd, null);
  assert.equal(noChars.confidence, "unknown");
  assert.equal(quote({ model: tts, inputCharacters: 2001 }).highUsd, 0.15);
  assert.equal(quote({ model: tts, inputCharacters: 0 }).highUsd, 0.05, "at least one thousand-character unit");

  assert.equal(quote({ model: STT }).bounded, false);
  assert.equal(quote({ model: STT, inputAudioSec: 0 }).bounded, false);
  const minutes = quote({ model: STT, inputAudioSec: 90 });
  assert.equal(minutes.highUsd, 0.009);
  assert.match(minutes.notes ?? "", /sec\w* \/ 60/);
  assert.equal(
    quote({ model: "fal-ai/sync-lipsync", inputAudioSec: 90 }).bounded,
    false,
    "lipsync minutes are not input audio minutes",
  );

  const video = "fal-ai/kling-video/v2.6/pro/text-to-video";
  assert.equal(quote({ model: video }).bounded, false, "no explicit output duration");
  assert.equal(quote({ model: video, durationSec: 5 }).highUsd, 0.35);
  assert.throws(() => quote({ model: video, durationSec: 5, units: 4 }), /match explicit output duration/);

  const flux = "fal-ai/flux/schnell";
  assert.equal(quote({ model: flux }).bounded, false, "output dimensions required");
  const mp = quote({ model: flux, width: 1024, height: 1024 });
  assert.equal(mp.highUsd, 0.006);
  assert.equal(mp.lowUsd, 0.003);
  assert.equal(mp.confidence, "published-rate");
  assert.match(mp.notes ?? "", /input-megapixel surcharge is not evidenced/);

  for (const unknown of [
    "nvidia/nemotron-3-nano-omni",
    "fal-ai/wizper",
    "hitem3d/hi3d/image-to-3d",
    "nobody/has-this",
    UNCATALOGUED,
    "blackforestlabs/flux-3/klein/base/trainer",
    "fal-ai/sa2va/4b/video",
    "xai/grok-voice/realtime",
    "mureka/api/generate/speech",
  ]) {
    const result = quote({ model: unknown });
    assert.equal(result.bounded, false, unknown);
    assert.equal(result.highUsd, null);
    assert.equal(result.confidence, "unknown");
  }
  assert.equal(
    quote({ model: "fal-ai/nano-banana", units: 0 }).bounded,
    false,
    "a zero commitment is not quoted as free",
  );
  assert.equal(
    quote({ model: "fal-ai/pixverse/c1/transition", durationSec: 0.01 }).highUsd,
    0.0001,
    "sub-cent amounts round up, never to zero",
  );
  const ltx = quote({ model: "fal-ai/ltx-2.3-22b/distilled/audio-to-video", width: 1024, height: 1024 });
  assert.equal(ltx.bounded, false, "video megapixels span frames; one frame is not the bill");
});

test("tracked registry endpoints and legacy keys quote exactly as before, whatever the API says", () => {
  const kling = "fal-ai/kling-video/v3/pro/text-to-video"; // fixture lists 0.14; reviewed range stands.
  const reviewed = quote({ model: kling, durationSec: 5 });
  assert.equal(reviewed.basis, "range");
  assert.equal(reviewed.source, `https://fal.ai/models/${kling}`);
  assert.deepEqual([reviewed.lowUsd, reviewed.expectedUsd, reviewed.highUsd], [0.56, 0.84, 0.98]);
  const legacy = quote({ model: "fal:flux-schnell", units: 2 });
  assert.equal(legacy.highUsd, 0.006);
  assert.equal(legacy.basis, "fixed");
});

test("drift: reported when the API leaves the reviewed definition; never applied", () => {
  const kling = "fal-ai/kling-video/v3/pro/text-to-video";
  // The 2026-11-15 fixture lists 0.14, inside the reviewed 0.112–0.196 range: no drift.
  assert.deepEqual(comparePrices(publicTariff, [recordOf(kling)]), []);
  const high = comparePrices(publicTariff, [{ ...recordOf(kling), unitPrice: 0.2 }]);
  assert.equal(high.length, 1);
  assert.equal(high[0]!.endpoint, kling);
  assert.match(high[0]!.observed, /outside reviewed range \[0\.112, 0\.196\]/);
  assert.equal(comparePrices(publicTariff, [{ ...recordOf(kling), unitPrice: 0.1 }]).length, 1);
  assert.equal(publicTariff(kling)!.pricing.kind, "range", "drift leaves the reviewed tariff untouched");

  const turbo = "fal-ai/kling-video/v3/turbo/pro/text-to-video";
  const record = (unitPrice: number, unit = "seconds"): FalPriceRecord => ({
    endpoint: turbo,
    unitPrice,
    unit,
    currency: "USD",
    observedAsOf: AS_OF,
    source: "platform-pricing-api",
  });
  assert.deepEqual(comparePrices(publicTariff, [record(0.14)]), []);
  assert.match(comparePrices(publicTariff, [record(0.15)])[0]!.observed, /differs from reviewed 0\.14/);
  assert.match(comparePrices(publicTariff, [record(0.14, "images")])[0]!.observed, /unit mismatch/);
  const gpt = "openai/gpt-image-2.5/flare/edit";
  assert.match(
    comparePrices(publicTariff, [{ ...record(0.03, "images"), endpoint: gpt }])[0]!.observed,
    /unit mismatch/,
  );
  assert.deepEqual(
    comparePrices(publicTariff, [{ ...record(0.005, "1000 tokens"), endpoint: gpt }]),
    [],
    "0.005 per 1000 = 5 per million text input",
  );
  const seedance = "bytedance/seedance-2.5/text-to-video";
  assert.deepEqual(comparePrices(publicTariff, [{ ...record(0.0214, "1000 tokens"), endpoint: seedance }]), []);
  assert.match(
    comparePrices(publicTariff, [{ ...record(0.0214, "seconds"), endpoint: seedance }])[0]!.observed,
    /unit mismatch/,
  );
  assert.deepEqual(
    comparePrices({ [turbo]: { kind: "fixed", usdPerUnit: 0.14, quantity: "generated-second" } }, [record(0.14)]),
    [],
    "a plain record of definitions works too",
  );
  assert.deepEqual(
    comparePrices(
      publicTariff,
      fixtureRecords.filter((row) => !publicTariff(row.endpoint)),
    ),
    [],
    "no reviewed tariff, nothing to drift from",
  );
});

test("platform evidence: created from the tracked record only, digest-bound, tamper rejected", () => {
  const endpoint = "fal-ai/nano-banana";
  const evidence = createPlatformPricingEvidence(endpoint)!;
  assert.equal(evidence.kind, "platform-pricing-api");
  assert.equal(evidence.provider, "fal.ai");
  assert.equal(evidence.source, "https://api.fal.ai/v1/models/pricing?endpoint_id=fal-ai/nano-banana");
  assert.equal(evidence.observedAsOf, AS_OF);
  assert.equal(evidence.unitPrice, 0.0398);
  assert.equal(evidence.acceptance, "not-run");
  const { sha256, ...payload } = evidence;
  assert.equal(platformPricingEvidenceDigest(payload), sha256);
  assert.deepEqual(PricingEvidenceSchema.parse(evidence), evidence);
  assert.deepEqual(assertCurrentPricingEvidence(evidence, endpoint), evidence);
  assert.deepEqual(
    assertCurrentPublicListPricingEvidence(evidence, endpoint),
    evidence,
    "the store's trust check dispatches on kind",
  );

  const q = quote({ model: endpoint });
  assert.equal(
    pricingEvidenceMatchesQuote({ ...q, pricingEvidence: evidence } as Parameters<
      typeof pricingEvidenceMatchesQuote
    >[0]),
    true,
  );
  assert.equal(
    pricingEvidenceMatchesQuote({ ...q, source: "elsewhere", pricingEvidence: evidence } as Parameters<
      typeof pricingEvidenceMatchesQuote
    >[0]),
    false,
  );

  assert.throws(() => PlatformPricingEvidenceSchema.parse({ ...evidence, unitPrice: 0.01 }), /digest mismatch/);
  const cheaper = {
    ...payload,
    unitPrice: 0.01,
    pricing: { kind: "fixed", usdPerUnit: 0.01, quantity: "output" },
  } as typeof payload;
  const forged = { ...cheaper, sha256: platformPricingEvidenceDigest(cheaper) };
  assert.ok(PlatformPricingEvidenceSchema.safeParse(forged).success, "self-consistent forgery parses");
  assert.throws(() => assertCurrentPricingEvidence(forged, endpoint), /trusted current platform pricing record/);
  assert.throws(() => assertCurrentPricingEvidence(evidence, "fal-ai/flux/schnell"), /binding/);
  const wrongSource = { ...payload, source: "https://example.com/price" };
  assert.throws(() => platformPricingEvidenceDigest(wrongSource as typeof payload), /exact pricing API URL/);

  assert.equal(
    createPlatformPricingEvidence("fal-ai/kling-video/v3/pro/text-to-video"),
    undefined,
    "a reviewed tariff wins",
  );
  assert.equal(createPlatformPricingEvidence("fal-ai/wizper"), undefined, "unknown units carry no evidence");
  assert.equal(createPlatformPricingEvidence("nobody/has-this"), undefined);
  const publicEvidence = createPublicListPricingEvidence("fal-ai/kling-video/v3/pro/text-to-video")!;
  assert.deepEqual(
    assertCurrentPublicListPricingEvidence(publicEvidence, publicEvidence.endpoint),
    publicEvidence,
    "public-list evidence path unchanged",
  );
});

type Call = { url: URL; headers: Record<string, string> };
function fakeApi(
  rows: ApiRow[],
  options: { pageSize?: number; rateLimitFirst?: number; retryAfter?: string | null; notFound?: string[] } = {},
) {
  const calls: Call[] = [];
  let limited = options.rateLimitFirst ?? 0;
  const fetchImpl = async (url: string, init: { headers: Record<string, string> }) => {
    const parsed = new URL(url);
    calls.push({ url: parsed, headers: init.headers });
    if (limited > 0) {
      limited--;
      return {
        ok: false,
        status: 429,
        headers: { get: (name: string) => (name === "retry-after" ? (options.retryAfter ?? null) : null) },
        json: async () => ({}),
        text: async () => "slow down",
      };
    }
    const wanted = new Set(parsed.searchParams.getAll("endpoint_id"));
    if (options.notFound?.some((id) => wanted.has(id))) {
      const body = { error: { type: "not_found", message: "Endpoint(s) not found" } };
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }
    const matching = rows.filter((row) => wanted.has(row.endpoint_id));
    const size = options.pageSize ?? 1000;
    const start = Number(parsed.searchParams.get("cursor") ?? 0);
    const page = matching.slice(start, start + size);
    const more = start + size < matching.length;
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ prices: page, has_more: more, next_cursor: more ? String(start + size) : null }),
      text: async () => "",
    };
  };
  return { calls, fetchImpl };
}

test("sync: batches of 40, Key auth, cursor pagination, USD only, dated records", async () => {
  const api = fakeApi(
    [...apiRows, { endpoint_id: "eu/priced-in-euro", unit: "images", unit_price: 1, currency: "EUR" }],
    { pageSize: 7 },
  );
  const endpoints = [...apiRows.map((row) => row.endpoint_id), "eu/priced-in-euro", "nobody/has-this"];
  const result = await syncFalPrices(endpoints, api.fetchImpl, {
    apiKey: "test-key",
    now: new Date("2026-11-15T12:00:00Z"),
    sleep: async () => {},
  });
  assert.equal(result.records.length, apiRows.length);
  assert.ok(
    result.records.every((record) => record.observedAsOf === AS_OF && record.source === "platform-pricing-api"),
  );
  assert.deepEqual(
    result.records.map((record) => record.endpoint),
    [...result.records.map((record) => record.endpoint)].sort(),
  );
  assert.deepEqual(result.skipped, [{ endpoint: "eu/priced-in-euro", reason: "currency EUR is not USD" }]);
  assert.deepEqual(result.unpriced, ["nobody/has-this"]);
  assert.deepEqual(result.notFound, []);
  assert.ok(api.calls.every((call) => call.headers.Authorization === "Key test-key"));
  assert.ok(api.calls.every((call) => call.url.origin + call.url.pathname === "https://api.fal.ai/v1/models/pricing"));
  assert.ok(api.calls.every((call) => call.url.searchParams.getAll("endpoint_id").length <= 40));
  assert.ok(
    api.calls.some((call) => call.url.searchParams.has("cursor")),
    "followed a cursor",
  );
  const batches = new Set(api.calls.map((call) => call.url.searchParams.getAll("endpoint_id").join(",")));
  assert.equal(batches.size, Math.ceil(endpoints.length / 40));
  assert.equal(falNetworkAttempts.length, 0);
});

test("sync: bisects poisoned batches, prices every good ID and bounds requests", async () => {
  const rows = Array.from({ length: 83 }, (_, index) => ({
    ...apiRows[0]!,
    endpoint_id: `test/model-${String(index).padStart(3, "0")}`,
  }));
  const endpoints = rows.map((row) => row.endpoint_id);
  const batches = Math.ceil(endpoints.length / FAL_PRICING_BATCH);
  for (const poisoned of [
    [endpoints[19]!],
    [endpoints[0]!, endpoints[39]!, endpoints[40]!, endpoints[82]!],
    endpoints,
  ]) {
    const api = fakeApi(rows, { notFound: poisoned });
    const result = await syncFalPrices([...endpoints, endpoints[0]!], api.fetchImpl, { apiKey: "k" });
    assert.deepEqual(
      result.records.map((record) => record.endpoint),
      endpoints.filter((id) => !poisoned.includes(id)),
    );
    assert.deepEqual(result.notFound, poisoned);
    assert.deepEqual(result.unpriced, poisoned);
    assert.equal(result.requests, api.calls.length);
    // Each failed non-singleton branches exactly twice; a full binary tree has 2N - 1 nodes.
    assert.ok(result.requests <= 2 * endpoints.length - batches);
    assert.ok(result.requests <= batches + 2 * poisoned.length * Math.ceil(Math.log2(FAL_PRICING_BATCH)));
    const requested = api.calls.map((call) => call.url.searchParams.getAll("endpoint_id").join(","));
    assert.equal(new Set(requested).size, requested.length, "no batch is retried on a not-found response");
    assert.ok(api.calls.every((call) => call.headers.Authorization === "Key k"));
  }
  assert.equal(falNetworkAttempts.length, 0);
});

test("sync: other 404 errors keep the HTTP failure instead of splitting", async () => {
  for (const body of [JSON.stringify({ error: { type: "other" } }), "not JSON"]) {
    let requests = 0;
    const fetchImpl = async () => {
      requests++;
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        json: async () => JSON.parse(body) as unknown,
        text: async () => body,
      };
    };
    await assert.rejects(
      syncFalPrices(["test/good", "test/poisoned"], fetchImpl, { apiKey: "k" }),
      (error: unknown) =>
        error instanceof FalPricingSyncError && error.code === "NETWORK" && error.message.includes("HTTP 404"),
    );
    assert.equal(requests, 1);
  }
});

test("sync: 429 honours Retry-After, then gives up with RATE_LIMIT; missing key fails first", async () => {
  const waits: number[] = [];
  const api = fakeApi(apiRows, { rateLimitFirst: 2, retryAfter: "3" });
  const result = await syncFalPrices(["fal-ai/nano-banana"], api.fetchImpl, {
    apiKey: "k",
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.deepEqual(waits, [3000, 3000]);
  assert.equal(result.records.length, 1);
  assert.equal(api.calls.length, 3);

  const backoff: number[] = [];
  const stuck = fakeApi(apiRows, { rateLimitFirst: 99 });
  await assert.rejects(
    syncFalPrices(["fal-ai/nano-banana"], stuck.fetchImpl, {
      apiKey: "k",
      maxRetries: 2,
      sleep: async (ms) => {
        backoff.push(ms);
      },
    }),
    (error: unknown) =>
      error instanceof FalPricingSyncError && error.code === "RATE_LIMIT" && error.retryAfterMs === 4000,
  );
  assert.deepEqual(backoff, [1000, 2000]);

  const none = fakeApi(apiRows);
  await assert.rejects(
    syncFalPrices(["fal-ai/nano-banana"], none.fetchImpl, {}),
    (error: unknown) => error instanceof FalPricingSyncError && error.code === "MISSING_API_KEY",
  );
  assert.equal(none.calls.length, 0);
});

test("sync: a stalled body times out and a long Retry-After fails at once instead of sleeping", async () => {
  const headers = { get: () => null };
  const stalled = (_url: string, init: { signal?: AbortSignal }) =>
    Promise.resolve({
      ok: true,
      status: 200,
      headers,
      text: async () => "",
      json: () =>
        new Promise<unknown>((_resolve, reject) =>
          init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    });
  await assert.rejects(
    syncFalPrices(["fal-ai/nano-banana"], stalled, { apiKey: "k", timeoutMs: 20 }),
    (error: unknown) => error instanceof FalPricingSyncError && error.code === "TIMEOUT",
  );

  const waits: number[] = [];
  const slow = fakeApi(apiRows, { rateLimitFirst: 1, retryAfter: "3600" });
  await assert.rejects(
    syncFalPrices(["fal-ai/nano-banana"], slow.fetchImpl, {
      apiKey: "k",
      sleep: async (ms) => {
        waits.push(ms);
      },
    }),
    (error: unknown) =>
      error instanceof FalPricingSyncError && error.code === "RATE_LIMIT" && error.retryAfterMs === 3_600_000,
  );
  assert.deepEqual(waits, []);
});

test("sync: transient network failures and 5xx are retried with backoff, then reported", async () => {
  const waits: number[] = [];
  const api = fakeApi(apiRows);
  let failures = 2;
  const flaky = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => {
    if (failures-- > 0) return Promise.reject(new TypeError("fetch failed"));
    return api.fetchImpl(url, init);
  };
  const result = await syncFalPrices(["fal-ai/nano-banana"], flaky, {
    apiKey: "k",
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  assert.equal(result.records.length, 1);
  assert.deepEqual(waits, [1000, 2000]);

  const down = () =>
    Promise.resolve({
      ok: false,
      status: 502,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => "bad gateway",
    });
  const backoff: number[] = [];
  await assert.rejects(
    syncFalPrices(["fal-ai/nano-banana"], down, {
      apiKey: "k",
      maxRetries: 2,
      sleep: async (ms) => {
        backoff.push(ms);
      },
    }),
    (error: unknown) =>
      error instanceof FalPricingSyncError && error.code === "NETWORK" && error.message.includes("HTTP 502"),
  );
  assert.deepEqual(backoff, [1000, 2000]);
});

test("CLI --from-fixtures --dry-run prints one JSON line and writes nothing", () => {
  const before = statSync(FAL_PRICES_FILE).mtimeMs;
  const run = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/fal-pricing.ts", "--from-fixtures", FIXTURE, "--dry-run", "--as-of", AS_OF],
    {
      encoding: "utf8",
      env: { ...process.env, AGENTBROS_FAL_PRICES: pricesFile, FAL_KEY: "" },
    },
  );
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  const result = JSON.parse(lines[0]!) as {
    ok: boolean;
    outputs: string[];
    metadata: {
      mode: string;
      records: number;
      priceDrift: unknown[];
      dryRun: boolean;
      units: Record<string, number>;
      notFound: string[];
    };
  };
  assert.equal(result.ok, true);
  assert.deepEqual(result.outputs, []);
  assert.equal(result.metadata.mode, "from-fixtures");
  assert.equal(result.metadata.dryRun, true);
  assert.equal(result.metadata.records, apiRows.length);
  assert.deepEqual(result.metadata.priceDrift, []);
  assert.deepEqual(result.metadata.notFound, []);
  assert.equal(statSync(FAL_PRICES_FILE).mtimeMs, before);

  const show = spawnSync(
    process.execPath,
    ["--import", "tsx", "scripts/fal-pricing.ts", "--show", "fal-ai/kling-video/v3/pro/text-to-video"],
    { encoding: "utf8", env: { ...process.env, AGENTBROS_FAL_PRICES: pricesFile, FAL_KEY: "" } },
  );
  const shown = JSON.parse(show.stdout.trim()) as {
    ok: boolean;
    metadata: { precedence: { used: string }; record: { unitPrice: number } };
  };
  assert.equal(shown.ok, true);
  assert.equal(shown.metadata.precedence.used, "tracked-registry");
  assert.equal(shown.metadata.record.unitPrice, 0.14);
});

test("sync checkpoint survives a later failed batch and resume skips every completed batch", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "fal-pricing-resume-"));
  try {
    const checkpointFile = path.join(directory, "2026-11-15.jsonl");
    const rows = Array.from({ length: 83 }, (_, index) => ({
      ...apiRows[0]!,
      endpoint_id: `test/resume-${String(index).padStart(3, "0")}`,
    }));
    const endpoints = rows.map((row) => row.endpoint_id);
    const first = fakeApi(rows);
    let batches = 0;
    await assert.rejects(
      syncFalPrices(
        endpoints,
        async (url, init) => {
          if (++batches === 2) throw new Error("offline simulated interruption");
          return first.fetchImpl(url, init);
        },
        { apiKey: "fake", now: new Date("2026-11-15"), checkpointFile, maxRetries: 0 },
      ),
      /simulated interruption/,
    );
    assert.equal(readFileSync(checkpointFile, "utf8").trim().split("\n").length, 1);
    const resumed = fakeApi(rows);
    const result = await syncFalPrices(endpoints, resumed.fetchImpl, {
      apiKey: "fake",
      now: new Date("2026-11-15"),
      checkpointFile,
      resume: true,
    });
    assert.equal(result.records.length, 83);
    assert.equal(result.completedBatches, 3);
    assert.equal(result.partial, false);
    assert.equal(resumed.calls.length, 2);
    assert.ok(
      resumed.calls.every((call) =>
        call.url.searchParams.getAll("endpoint_id").every((id) => !endpoints.slice(0, 40).includes(id)),
      ),
    );
    const completed = fakeApi(rows);
    assert.equal(
      (
        await syncFalPrices(endpoints, completed.fetchImpl, {
          apiKey: "fake",
          now: new Date("2026-11-15"),
          checkpointFile,
          resume: true,
        })
      ).records.length,
      83,
    );
    assert.equal(completed.calls.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("partial sync reports completed count, omits unfinished batches and keeps checkpoint observations", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "fal-pricing-partial-"));
  try {
    const checkpointFile = path.join(directory, "checkpoint.jsonl");
    const rows = Array.from({ length: 45 }, (_, index) => ({
      ...apiRows[0]!,
      endpoint_id: `test/partial-${String(index).padStart(3, "0")}`,
    }));
    const api = fakeApi(rows);
    let calls = 0;
    const result = await syncFalPrices(
      rows.map((row) => row.endpoint_id),
      async (url, init) => {
        if (++calls === 2) throw new Error("temporary outage");
        return api.fetchImpl(url, init);
      },
      { apiKey: "fake", now: new Date("2026-11-15"), checkpointFile, partial: true, maxRetries: 0 },
    );
    assert.equal(result.partial, true);
    assert.equal(result.completedBatches, 1);
    assert.equal(result.totalBatches, 2);
    assert.equal(result.records.length, 40);
    assert.match(result.failure!, /temporary outage/);
    assert.equal(readFileSync(checkpointFile, "utf8").trim().split("\n").length, 1);
    assert.equal(JSON.parse(serialiseFalPrices(result.records, null)).syncedAt, null);
    const stale = fakeApi(rows);
    await syncFalPrices(
      rows.map((row) => row.endpoint_id),
      stale.fetchImpl,
      { apiKey: "fake", now: new Date("2026-11-16"), checkpointFile, resume: true },
    );
    assert.equal(stale.calls.length, 2, "a different observation date must not use old batches");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fal resume repairs a truncated final checkpoint append and retains previous completed batches", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "fal-pricing-truncated-"));
  try {
    const checkpointFile = path.join(directory, "checkpoint.jsonl");
    const rows = [
      { ...apiRows[0]!, endpoint_id: "test/truncated-a" },
      { ...apiRows[0]!, endpoint_id: "test/truncated-b" },
    ];
    await syncFalPrices([rows[0]!.endpoint_id], fakeApi(rows).fetchImpl, {
      apiKey: "fake",
      now: new Date("2026-11-15"),
      checkpointFile,
      batchSize: 1,
    });
    appendFileSync(checkpointFile, '{"date":"2026-11-15","bat');
    const api = fakeApi(rows);
    const result = await syncFalPrices(
      rows.map((row) => row.endpoint_id),
      api.fetchImpl,
      { apiKey: "fake", now: new Date("2026-11-15"), checkpointFile, batchSize: 1, resume: true },
    );
    assert.equal(result.records.length, 2);
    assert.equal(api.calls.length, 1);
    for (const line of readFileSync(checkpointFile, "utf8").trim().split("\n"))
      assert.doesNotThrow(() => JSON.parse(line));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
