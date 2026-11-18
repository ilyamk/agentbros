import "./helpers/fal-no-network";
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  HiggsfieldPricesFileSchema,
  HiggsfieldSchemaDocSchema,
  type HiggsfieldPriceRecord,
} from "../src/types/higgsfield";
import { FalCatalogFileSchema } from "../src/types/fal-catalog";
import { HF_SCHEMA_DIR, higgsfieldSchemaSha256, resetProviderCatalogCache } from "../src/lib/models/fal-catalog";
import { validateJsonSchema, type JsonSchema } from "../src/lib/providers/json-schema-validate";
import { PricingEvidenceSchema, pricingEvidenceMatchesQuote } from "../src/types/pricing-evidence";
import {
  createHiggsfieldPricingEvidence,
  assertCurrentHiggsfieldPricingEvidence,
} from "../src/lib/models/pricing-evidence";
import {
  estimateHiggsfield,
  fetchHiggsfieldUsage,
  higgsfieldPricingFor,
  higgsfieldPricesFromFixtures,
  minimalHiggsfieldInput,
  parseHiggsfieldPricing,
  reconcileHiggsfieldUsage,
  separateHiggsfieldDurationCosts,
  serialiseHiggsfieldPrices,
  syncHiggsfieldPrices,
  type HiggsfieldFetch,
} from "../src/lib/models/hf-pricing";
import { quote } from "../src/lib/pricing";
import { OperationInputSchema } from "../src/lib/jobs/types";
import { generationInputHash } from "../src/lib/jobs/runner";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { falNetworkAttempts } from "./helpers/fal-no-network";
import { prepareCommand } from "../src/mcp/bridge";
import { COMMANDS } from "../src/mcp/catalog";

const dir = mkdtempSync(path.join(tmpdir(), "hf-pricing-"));
process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
const fixture = JSON.parse(readFileSync("tests/fixtures/higgsfield/estimates.json", "utf8")) as {
  cases: {
    endpoint: string;
    input: Record<string, unknown>;
    status: number;
    response: { type?: string; pricing_description?: string };
  }[];
};
const catalogue: unknown = JSON.parse(readFileSync("tests/fixtures/higgsfield/catalog-models.json", "utf8"));
const fixtureResult = higgsfieldPricesFromFixtures(fixture, catalogue);
const records = new Map(fixtureResult.records.map((record) => [record.endpoint, record]));
const now = new Date("2026-11-15T12:00:00Z");
const soul = records.get("higgsfield-ai/soul/v2/standard")!;
const seedance = records.get("bytedance/seedance-2.5/text-to-video")!;
const response = (body: unknown, status = 200, retry: string | null = null) => ({
  ok: status < 400,
  status,
  headers: { get: () => retry },
  json: async () => body,
});
function price(record: HiggsfieldPriceRecord, input: Record<string, unknown> = record.estimates[0]!.input) {
  return higgsfieldPricingFor(record, input, { now });
}
function total(
  record: HiggsfieldPriceRecord,
  input?: Record<string, unknown>,
  context: Parameters<typeof higgsfieldPricingFor>[2] = { now },
) {
  const value = higgsfieldPricingFor(record, input ?? record.estimates[0]!.input, context);
  assert.equal(value.pricing.kind, "fixed");
  return value.pricing.kind === "fixed" ? value.pricing.usdPerUnit : NaN;
}
for (const [index, sample] of fixture.cases.entries()) {
  if (sample.response.type !== "description") continue;
  test(`description fixture ${index}: ${sample.endpoint}`, () => {
    const parsed = parseHiggsfieldPricing(sample.response.pricing_description!);
    if (sample.endpoint.includes("cinema-studio")) {
      assert.equal(parsed.tiers.length, 0);
      assert.match(parsed.unparsed!, /token-metered/);
      assert.ok(parsed.unparsed!.includes(sample.response.pricing_description!));
      return;
    }
    const expectedRates = sample.endpoint.includes("genjutsu-light")
      ? [0.0739, 0.1471, 0.2936]
      : sample.endpoint.includes("genjutsu/")
        ? [0.154, 0.3446, 0.8346]
        : sample.endpoint.includes("/v3.0/std")
          ? [0.0714]
          : sample.endpoint.includes("/v3.0/pro")
            ? [0.0962]
            : sample.endpoint.includes("/v4.0/")
              ? [0.1257, 0.1879]
              : [0.1177, 0.2647, 0.6518];
    assert.deepEqual(
      parsed.tiers.map((row) => row.usdPerUnit),
      expectedRates,
    );
    assert.ok(
      parsed.tiers.every(
        (row) => row.basis === (sample.endpoint.includes("genjutsu/") ? "source-second" : "output-second"),
      ),
    );
    assert.ok(
      parsed.tiers.every((row) => row.rounding === (sample.endpoint.includes("genjutsu/") ? "ceil-second" : null)),
    );
    if (sample.endpoint.includes("/v3.0/"))
      assert.equal(
        parsed.unparsed,
        "For explicit multi-shot requests, output duration is the sum of the shot durations.",
      );
    else assert.equal(parsed.unparsed, undefined);
  });
}

test("parser refuses unknown grammar, partial matches, duplicate resolutions and conflicting billing bases", () => {
  for (const text of [
    "480p: $1",
    "Rates per minute: 480p: $1",
    "Price per second (output): 480p — $1.00; garbage.",
    "Price per second (output): 480p — $1; 480p — $2.",
    "Standard self-serve rates in USD per video second: 720p: $1. Total price = selected rate × billed duration in seconds.",
  ])
    assert.equal(parseHiggsfieldPricing(text).tiers.length, 0, text);
});

test("request estimates match input exactly and four images are one request", () => {
  assert.equal(total(soul, soul.estimates[1]!.input), 0.004);
  assert.equal(price(soul, { ...soul.estimates[0]!.input, num_images: 2 }).pricing.kind, "unknown");
  assert.equal(price(soul, { prompt: "different prompt" }).pricing.kind, "unknown");
  assert.equal(total(soul, soul.estimates[0]!.input, { defaults: { num_images: 4 }, now }), 0.004);
});

test("resolution defaults, explicit durations, measured source seconds and ceil rounding", () => {
  assert.equal(total(seedance, { duration: 5 }, { defaults: { resolution: "720p" }, now }), 5 * 0.2647);
  assert.equal(price(seedance, { duration: 5 }).pricing.kind, "unknown");
  assert.equal(price(seedance, { resolution: "480p" }).pricing.kind, "unknown");
  const genjutsu = records.get("higgsfield/genjutsu/motion-transfer/v1.0")!;
  const input = genjutsu.estimates[0]!.input;
  assert.equal(
    total(genjutsu, { ...input, duration: 99 }, { now, media: { [String(input.video_url)]: { durationSec: 4.01 } } }),
    5 * 0.154,
  );
  assert.equal(
    price(genjutsu, { ...input, duration: 10 }).pricing.kind,
    "unknown",
    "source basis cannot use requested output duration",
  );
  const light = records.get("higgsfield/genjutsu-light/motion-transfer/v1.0")!;
  assert.equal(
    total(light, input, { now, videoInput: true, media: { [String(input.video_url)]: { durationSec: 4.25 } } }),
    5 * 0.0739,
  );
});

test("image tiers multiply count; floors and token-metered descriptions never bound prices", () => {
  const images = {
    ...soul,
    estimates: [],
    tiers: [{ when: {}, usdPerUnit: 0.1, basis: "image" as const, rounding: null }],
  };
  assert.equal(total(images, { num_images: 4 }), 0.4);
  assert.equal(price(images, { num_images: 1.5 }).pricing.kind, "unknown");
  assert.equal(price({ ...seedance, tiers: [], estimates: [] }, {}).pricing.kind, "unknown");
  assert.equal(price(records.get("higgsfield/cinema-studio/4.0")!).pricing.kind, "unknown");
});

test("discount reserves full amount on unknown/near expiry or stale records and estimates", () => {
  const pixverse = records.get("pixverse/v6/text-to-video")!;
  const fresh = { ...pixverse, list: { ...pixverse.list!, discountExpiresAt: "2026-11-16T00:00:00Z" } };
  assert.equal(total(fresh), 0.255);
  for (const expiry of [null, "2026-11-15T12:59:59Z", "2026-11-14T00:00:00Z"])
    assert.equal(total({ ...fresh, list: { ...fresh.list!, discountExpiresAt: expiry } }), 0.3);
  assert.equal(total({ ...fresh, observedAsOf: "2026-11-07" }), 0.3);
  assert.equal(
    total({ ...fresh, estimates: fresh.estimates.map((row) => ({ ...row, observedAt: "2026-11-07" })) }),
    0.3,
  );
  const nonFloor = {
    ...fresh,
    list: { ...fresh.list!, qualifier: null, amount: 0.255, unit: "request", originalAmount: 0.4 },
  };
  assert.equal(total(nonFloor, undefined, { now: new Date("2026-11-17") }), (0.255 * 0.4) / 0.255);
  const evidence = createHiggsfieldPricingEvidence(fresh, fresh.estimates[0]!.input, { now })!;
  assert.equal(evidence.discountedUsd, 0.255);
  assert.equal(evidence.undiscountedUsd, 0.3);
});

test("two-duration samples distinguish fixed and per-second components without extrapolating quotes", () => {
  for (const [a, b, fixed, slope] of [
    [1, 1, 1, 0],
    [0.5, 1, 0, 0.1],
    [0.7, 1.2, 0.2, 0.1],
  ]) {
    const estimates = [5, 10].map((duration, index) => ({
      input: { prompt: "x", duration },
      type: "estimate" as const,
      usd: index ? b : a,
      observedAt: "2026-11-15",
    }));
    const result = separateHiggsfieldDurationCosts(estimates)!;
    assert.ok(Math.abs(result.fixedUsd - fixed!) < 1e-9);
    assert.ok(Math.abs(result.usdPerSecond - slope!) < 1e-9);
    assert.equal(price({ ...soul, estimates }, { prompt: "x", duration: 15 }).pricing.kind, "unknown");
  }
});

test("minimal input uses defaults, required fields, enum values, public sample URLs and validates", () => {
  const schema = {
    type: "object",
    required: ["prompt", "video_url", "image_urls", "resolution", "duration"],
    properties: {
      prompt: { type: "string", minLength: 4 },
      video_url: { type: "string", format: "uri" },
      image_urls: { type: "array", items: { type: "string" }, minItems: 2 },
      resolution: { type: "string", enum: ["480p", "720p"], default: "720p" },
      duration: { type: "integer", minimum: 4 },
      num_images: { type: "integer", default: 1 },
    },
  };
  const input = minimalHiggsfieldInput(schema, {
    image: "https://samples.test/image.png",
    video: "https://samples.test/video.mp4",
  });
  assert.equal(input.resolution, "720p");
  assert.equal(input.duration, 4);
  assert.equal(input.num_images, 1);
  assert.deepEqual(input.image_urls, ["https://samples.test/image.png", "https://samples.test/image.png"]);
  assert.throws(() => minimalHiggsfieldInput(schema, {}), /sample URL/);
});

test("minimal input fills selected branches, nested allOf requirements and newly triggered conditions", () => {
  for (const enabled of [true, false]) {
    const schema: JsonSchema = {
      type: "object",
      properties: { enabled: { type: "boolean", default: enabled }, trigger: { type: "boolean", const: true } },
      allOf: [
        {
          if: { required: ["trigger"] },
          then: { required: ["result"], properties: { result: { type: "string", const: "ready" } } },
        },
        { if: {}, then: { required: ["trigger"] } },
        { properties: { prompt: { type: "string", const: "sibling" } } },
        { if: { required: ["trigger"] }, then: { required: ["prompt"] } },
      ],
      if: { properties: { enabled: { const: true } } },
      then: {
        required: ["image_urls"],
        properties: { image_urls: { type: "array", minItems: 2, items: { type: "string" } } },
      },
      else: {
        required: ["nested", "image_urls"],
        properties: {
          image_urls: { type: "array", minItems: 1, maxItems: 1, items: { type: "string" } },
          nested: {
            type: "object",
            required: ["flag"],
            properties: { flag: { const: true } },
            allOf: [
              {
                if: { properties: { flag: { const: true } } },
                then: { required: ["prompt"], properties: { prompt: { type: "string", const: "nested" } } },
              },
            ],
          },
        },
      },
    };
    const input = minimalHiggsfieldInput(schema, { image: "https://samples.test/image.png" });
    validateJsonSchema(schema, input, { components: {}, strict: false });
    assert.equal(input.result, "ready");
    assert.equal(input.prompt, "sibling");
    if (enabled) {
      assert.deepEqual(input.image_urls, ["https://samples.test/image.png", "https://samples.test/image.png"]);
      assert.equal(Object.hasOwn(input, "nested"), false);
      assert.throws(() => minimalHiggsfieldInput(schema, {}), /sample URL/);
    } else {
      assert.deepEqual(input.nested, { flag: true, prompt: "nested" });
      assert.deepEqual(input.image_urls, ["https://samples.test/image.png"]);
    }
  }
});

const schema = {
  type: "object",
  required: ["prompt", "duration"],
  properties: {
    prompt: { type: "string" },
    duration: { type: "integer", minimum: 5, maximum: 15 },
    resolution: { type: "string", enum: ["480p", "720p"], default: "480p" },
  },
};
test("sync samples two durations and each resolution for numeric estimates, checkpoint resume skips done endpoints", async () => {
  const checkpointFile = path.join(dir, "checkpoint.jsonl");
  const calls: { endpoint: string; input: Record<string, unknown> }[] = [];
  const fetchImpl: HiggsfieldFetch = async (url, init) => {
    const input = JSON.parse(init.body!) as Record<string, unknown>;
    calls.push({ endpoint: url.split("/estimate/")[1]!, input });
    return response({ type: "estimate", usd: Number(input.duration) * 0.1 });
  };
  const opts = { apiKey: "id:secret:rest", now, catalogue, checkpointFile };
  const a = { endpoint: "test/model-a", schema },
    b = { endpoint: "test/model-b", schema };
  const first = await syncHiggsfieldPrices([a], fetchImpl, opts);
  assert.equal(calls.length, 4);
  assert.equal(first.records.length, 1);
  const second = await syncHiggsfieldPrices([b, a], fetchImpl, { ...opts, resume: true });
  assert.equal(calls.length, 8);
  assert.equal(second.records.length, 2);
  assert.ok(calls.slice(4).every((call) => call.endpoint === b.endpoint));
  assert.equal(readFileSync(checkpointFile, "utf8").trim().split("\n").length, 2);
  const bytes = serialiseHiggsfieldPrices(second.records, "2026-11-15");
  assert.equal(HiggsfieldPricesFileSchema.parse(JSON.parse(bytes)).prices.length, 2);
});

test("sync parses description tiers once per duration and attempts schema-less siblings; 400 is never retried", async () => {
  let calls = 0;
  const description = seedance.estimates[0]!.pricingDescription!;
  const result = await syncHiggsfieldPrices(
    [
      { endpoint: "test/model", schema },
      { endpoint: "kling-video/v3.0/std/text-to-video", schema },
      { endpoint: "kling-video/v4.0/text-to-video" },
    ],
    async (url) => {
      calls++;
      return url.includes("/v4.0/")
        ? response({ detail: "invalid" }, 400)
        : response({ type: "description", pricing_description: description });
    },
    { apiKey: "id:secret", now, catalogue, sleep: async () => {} },
  );
  assert.equal(calls, 5);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0]!.reason, /400/);
});

test("estimate transport retries transient errors and honours Retry-After without exposing credentials", async () => {
  const waits: number[] = [];
  let calls = 0;
  const estimate = await estimateHiggsfield(
    soul.endpoint,
    { prompt: "x" },
    async (_url, init) => {
      assert.equal(init.headers.Authorization, "Key id:secret:with:colons");
      calls++;
      return calls === 1
        ? response({}, 429, "2")
        : calls === 2
          ? response({}, 503)
          : response({ type: "estimate", usd: "0.004", discount: null });
    },
    {
      apiKey: "id:secret:with:colons",
      now,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(estimate.usd, 0.004);
  assert.deepEqual(waits, [2000, 2000]);
  await assert.rejects(
    estimateHiggsfield(
      soul.endpoint,
      {},
      async () => {
        throw new Error("secret:value");
      },
      { apiKey: "id:key", maxRetries: 0 },
    ),
    (error) => !String(error).includes("secret:value"),
  );
});

test("Higgsfield evidence round-trips, binds quote fields, rejects tampering and changed current records", (t) => {
  const catalogDir = path.join(dir, "evidence-catalog"),
    schemaDir = path.join(dir, "evidence-schemas");
  mkdirSync(catalogDir);
  mkdirSync(schemaDir);
  const previous = { catalog: process.env.AGENTBROS_HF_CATALOG_DIR, schema: process.env.AGENTBROS_HF_SCHEMA_DIR };
  t.after(() => {
    if (previous.catalog === undefined) delete process.env.AGENTBROS_HF_CATALOG_DIR;
    else process.env.AGENTBROS_HF_CATALOG_DIR = previous.catalog;
    if (previous.schema === undefined) delete process.env.AGENTBROS_HF_SCHEMA_DIR;
    else process.env.AGENTBROS_HF_SCHEMA_DIR = previous.schema;
    resetProviderCatalogCache();
  });
  process.env.AGENTBROS_HF_CATALOG_DIR = catalogDir;
  process.env.AGENTBROS_HF_SCHEMA_DIR = schemaDir;
  const doc = HiggsfieldSchemaDocSchema.parse({
    version: 1,
    endpoint: soul.endpoint,
    title: "Soul fixture",
    schema: { type: "object", properties: { num_images: { type: "integer", default: 1 } } },
    asOf: "2026-11-15",
  });
  const sha256 = higgsfieldSchemaSha256(doc.schema);
  writeFileSync(path.join(schemaDir, `${sha256}.json`), JSON.stringify(doc));
  writeFileSync(
    path.join(catalogDir, "text-to-image.json"),
    JSON.stringify(
      FalCatalogFileSchema.parse({
        version: 1,
        provider: "higgsfield",
        category: "text-to-image",
        syncedAt: doc.asOf,
        entries: [
          {
            provider: "higgsfield",
            endpoint: soul.endpoint,
            category: "text-to-image",
            displayName: doc.title,
            status: "active",
            firstSeen: doc.asOf,
            lastSeen: doc.asOf,
            schema: { sha256, asOf: doc.asOf, source: "https://docs.higgsfield.ai/docs/models.md", cached: true },
            inputs: [],
            outputs: { kinds: ["image"], fields: ["images"] },
            transport: "queue",
            price: null,
            tier: "discovered",
          },
        ],
      }),
    ),
  );
  resetProviderCatalogCache();
  const file = path.join(dir, "prices.json");
  writeFileSync(file, serialiseHiggsfieldPrices([soul], "2026-11-15"));
  const evidence = createHiggsfieldPricingEvidence(soul, soul.estimates[1]!.input, {
    now,
    defaults: { num_images: 1 },
  })!;
  assert.deepEqual(PricingEvidenceSchema.parse(JSON.parse(JSON.stringify(evidence))), evidence);
  assert.deepEqual(assertCurrentHiggsfieldPricingEvidence(evidence, soul.endpoint, file), evidence);
  assert.equal(
    pricingEvidenceMatchesQuote({
      model: soul.endpoint,
      source: evidence.source,
      asOf: evidence.observedAsOf,
      currency: "USD",
      basis: "fixed",
      confidence: "published-rate",
      lowUsd: 0.004,
      expectedUsd: 0.004,
      highUsd: 0.004,
      pricingEvidence: evidence,
    }),
    true,
  );
  assert.equal(PricingEvidenceSchema.safeParse({ ...evidence, discountedUsd: 0.001 }).success, false);
  const wrongDefaults = createHiggsfieldPricingEvidence(soul, soul.estimates[1]!.input, {
    now,
    defaults: { num_images: 2 },
  })!;
  assert.throws(() => assertCurrentHiggsfieldPricingEvidence(wrongDefaults, soul.endpoint, file), /defaults differ/);
  const listEvidence = createHiggsfieldPricingEvidence(soul, soul.estimates[0]!.input, { now }, "higgsfield-list")!;
  assert.equal(PricingEvidenceSchema.parse(listEvidence).kind, "higgsfield-list");
  writeFileSync(file, serialiseHiggsfieldPrices([{ ...soul, estimates: [] }], "2026-11-15"));
  assert.throws(() => assertCurrentHiggsfieldPricingEvidence(evidence, soul.endpoint, file), /current/);
});

test("shared quote hooks isolate provider/endpoint lookups and include evidence", () => {
  useTempFalCatalog([]);
  const file = path.join(dir, "hook-prices.json");
  const endpoint = "fal-ai/kling-video/v3/pro/text-to-video";
  const hf = { ...soul, endpoint };
  writeFileSync(file, serialiseHiggsfieldPrices([hf], "2026-11-15"));
  process.env.AGENTBROS_HF_PRICES = file;
  const plan = {
    provider: "higgsfield" as const,
    endpoint,
    family: "catalog",
    category: "text-to-image",
  } as Parameters<typeof quoteInputForPlan>[0];
  const quantities = quoteInputForPlan(plan, soul.estimates[0]!.input);
  const result = quote({ model: endpoint, ...quantities });
  assert.equal(result.highUsd, 0.004);
  assert.equal(result.pricingEvidence?.provider, "higgsfield");
  assert.notEqual(quote({ model: endpoint, durationSec: 5 }).highUsd, 0.004);
  delete process.env.AGENTBROS_HF_PRICES;
});

test("usage reconciliation groups model/day, isolates providers, flags estimates and unresolved costs", async () => {
  const usage = await fetchHiggsfieldUsage(
    async (url) => {
      assert.equal(new URL(url).searchParams.get("expand"), null);
      return response({
        time_series: [
          {
            bucket: "2026-11-15T08:00:00",
            results: [
              {
                model: soul.endpoint,
                unit: "generation",
                quantity: "4",
                unit_price: "0.1",
                cost: "0.4",
                currency: "USD",
                auth_method: null,
              },
            ],
          },
        ],
        total: 1,
        page: 1,
        limit: 100,
      });
    },
    { apiKey: "id:key" },
  );
  const row = { model: soul.endpoint, ts: "2026-11-15T05:00:00Z", units: 1, estimatedUsd: 0.1 };
  const result = reconcileHiggsfieldUsage(usage, [
    { ...row, provider: "higgsfield" },
    { ...row, service: "higgsfield", actualUsd: 0.2 },
    { ...row, provider: "fal", actualUsd: 9 },
  ]);
  assert.equal(result.authority, "analytics, not billing");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0]!.estimated, 1);
  assert.ok(Math.abs(result.rows[0]!.differenceUsd! - 0.1) < 1e-9);
  assert.equal(
    reconcileHiggsfieldUsage(usage, [{ ...row, provider: "higgsfield", estimatedUsd: null }]).rows[0]!.differenceUsd,
    null,
  );
});

test("hf_quote MCP scopes request paths and rejects the network flag", () => {
  const definition = COMMANDS.find((command) => command.name === "hf_quote")!;
  const options = { root: dir, codeRoot: process.cwd(), allowPaid: false, timeoutMs: 1000 };
  assert.throws(() => prepareCommand(definition, { request: "../escape.json" }, options), /outside|escape/);
  assert.throws(() => prepareCommand(definition, { request: "request.json", "provider-estimate": true }, options));
});

test("offline hf:quote emits one envelope, keeps Soul request price and never contacts a provider", () => {
  const prices = path.join(dir, "cli-prices.json"),
    request = path.join(dir, "request.json");
  writeFileSync(prices, serialiseHiggsfieldPrices([soul], "2026-11-15"));
  writeFileSync(
    request,
    JSON.stringify({ provider: "higgsfield", endpoint: soul.endpoint, input: soul.estimates[1]!.input }),
  );
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/hf-quote.ts", "--request", request], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTBROS_HF_PRICES: prices,
      HIGGSFIELD_API_KEY: undefined,
      NODE_OPTIONS: "--import ./tests/helpers/fal-no-network.ts",
    },
  });
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const envelope = JSON.parse(child.stdout.trim()) as { ok: boolean; metadata: { quote: { highUsd: number } } };
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.quote.highUsd, 0.004);
  assert.equal(falNetworkAttempts.length, 0);
});

test("unknown description conditions have no tiers and cannot reserve a base-only amount", () => {
  const description =
    "Standard self-serve rates in USD per video second: 720p: $0.1. Total price = selected rate × output duration in seconds. Audio adds $1 per request.";
  assert.equal(parseHiggsfieldPricing(description).tiers.length, 0);
  assert.equal(
    price({ ...seedance, unparsed: "Audio adds $1 per request." }, { duration: 5, resolution: "720p" }).pricing.kind,
    "unknown",
  );
});

test("request evidence binds the input hash and exact quote amount", () => {
  const input = soul.estimates[0]!.input;
  const evidence = createHiggsfieldPricingEvidence(soul, input, { now })!;
  const operation = {
    operationId: "hf-quote-binding",
    provider: "higgsfield",
    endpoint: soul.endpoint,
    inputHash: generationInputHash(input),
    assetId: "test",
    quote: {
      model: soul.endpoint,
      lowUsd: 0.004,
      expectedUsd: 0.004,
      highUsd: 0.004,
      currency: "USD",
      source: evidence.source,
      asOf: evidence.observedAsOf,
      confidence: "published-rate",
      bounded: true,
      basis: "fixed",
      pricingEvidence: evidence,
    },
  };
  assert.equal(OperationInputSchema.safeParse(operation).success, true);
  assert.equal(
    OperationInputSchema.safeParse({ ...operation, inputHash: generationInputHash({ ...input, num_images: 8 }) })
      .success,
    false,
  );
  assert.equal(
    OperationInputSchema.safeParse({
      ...operation,
      quote: { ...operation.quote, lowUsd: 0.001, expectedUsd: 0.001, highUsd: 0.001 },
    }).success,
    false,
  );
  assert.throws(
    () => quote({ provider: "higgsfield", model: soul.endpoint, providerInput: input, multiplier: 3 }),
    /one physical request/,
  );
});

test("new priced Higgsfield reservations resume across locales with the original quoted bytes", () => {
  const directory = mkdtempSync(path.join(dir, "locale-")),
    script = path.join(directory, "resume.ts");
  const module = (file: string) => JSON.stringify(path.resolve(file));
  writeFileSync(path.join(directory, "record.json"), JSON.stringify(soul));
  writeFileSync(
    script,
    `
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { OperationStore } from ${module("src/lib/jobs/store.ts")};
import { paidInputIdentity } from ${module("src/lib/jobs/identity.ts")};
import { runGenerationStep } from ${module("src/lib/jobs/runner.ts")};
import { generationRequestBody } from ${module("src/lib/jobs/request-body.ts")};
import { createHiggsfieldPricingEvidence } from ${module("src/lib/models/pricing-evidence.ts")};
const directory = ${JSON.stringify(directory)};
const record = JSON.parse(readFileSync(directory + '/record.json', 'utf8'));
const input = { ...record.estimates[0].input, '\u00e4': 1, z: 2 };
record.estimates[0].input = input;
const store = new OperationStore('locale', { directory });
async function main() {
if (process.argv[2] === 'reserve') {
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, { by: 'user', answer: 'Test fixture: the user authorised this ceiling.' });
  const evidence = createHiggsfieldPricingEvidence(record, input, { now: new Date('2026-11-15T12:00:00Z') });
  const quote = { model: record.endpoint, lowUsd: 0.004, expectedUsd: 0.004, highUsd: 0.004, currency: 'USD', source: evidence.source, asOf: evidence.observedAsOf, confidence: 'published-rate', bounded: true, basis: 'fixed', pricingEvidence: evidence };
  // Seed a historical snapshot; this synthetic price record is not current admission authority.
  store.reserveOperation({ operationId: 'hf-locale', provider: 'higgsfield', endpoint: record.endpoint, assetId: 'test', ...paidInputIdentity(input), quote: { ...quote, pricingEvidence: undefined, confidence: 'user-bound' } });
  const snapshot = store.snapshot(); snapshot.jobs['hf-locale'].quote = quote;
  writeFileSync(store.file, JSON.stringify(snapshot));
  writeFileSync(directory + '/body.json', generationRequestBody(input));
} else {
  const previous = store.snapshot().jobs['hf-locale'];
  const evidence = previous.quote.pricingEvidence;
  assert.equal(evidence.canonicalLocale, 'en-US');
  assert.deepEqual(createHiggsfieldPricingEvidence(record, input, { now: new Date('2026-11-15T12:00:00Z') }, 'higgsfield-estimate', evidence.canonicalLocale), evidence);
  let calls = 0;
  const job = await runGenerationStep({ store, input, operation: previous, provider: { idempotentSubmit: true, prepareInput: async value => value, submit: async (_endpoint, _input, context) => { calls++; assert.equal(context.body, readFileSync(directory + '/body.json', 'utf8')); return { requestId: 'fixture' }; }, inspect: async () => ({ state: 'queued' }) } });
  assert.equal(job.inputHash, previous.inputHash); assert.equal(calls, 1);
}
}
void main();
`,
  );
  for (const [mode, locale] of [
    ["reserve", "en_US.UTF-8"],
    ["resume", "sv_SE.UTF-8"],
  ] as const) {
    const child = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), script, mode], {
      encoding: "utf8",
      timeout: 30000,
      env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, LANG: locale, LC_ALL: locale },
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
  }
});

test("checkpoint resume repairs interrupted tails and retries transient failures", async () => {
  const checkpointFile = path.join(dir, "interrupted-hf.jsonl");
  const opts = { apiKey: "id:key", now, catalogue, checkpointFile, maxRetries: 0 };
  const endpoints = [
    { endpoint: "test/interrupted-a", schema },
    { endpoint: "test/interrupted-b", schema },
  ];
  await syncHiggsfieldPrices(endpoints.slice(0, 1), async () => response({ type: "estimate", usd: "0.2" }), opts);
  appendFileSync(checkpointFile, '{"date":"2026-11-15","endp');
  let calls = 0;
  const result = await syncHiggsfieldPrices(
    endpoints,
    async () => {
      calls++;
      return response({}, 503);
    },
    { ...opts, resume: true },
  );
  assert.equal(calls, 1);
  assert.equal(result.failed.length, 1);
  const recovered = await syncHiggsfieldPrices(
    endpoints,
    async () => {
      calls++;
      return response({ type: "estimate", usd: "0.3" });
    },
    { ...opts, resume: true },
  );
  assert.equal(recovered.failed.length, 0);
  assert.equal(calls, 5);
  for (const line of readFileSync(checkpointFile, "utf8").trim().split("\n"))
    assert.doesNotThrow(() => JSON.parse(line));
});

test("minimal inputs and duration/resolution samples satisfy all 84 recorded workflow schemas", async () => {
  const root = "tests/fixtures/higgsfield/docs";
  let count = 0;
  for (const file of readdirSync(root)) {
    const section = readFileSync(path.join(root, file), "utf8").split("Complete JSON schema")[1];
    if (!section) continue;
    const block = section.match(/> ```json[^\n]*\n([\s\S]*?)\n> ```/);
    if (!block) continue;
    const schema = JSON.parse(
      block[1]!
        .split("\n")
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n"),
    ) as Parameters<typeof minimalHiggsfieldInput>[0];
    const samples = {
      image: "https://samples.test/image.png",
      video: "https://samples.test/video.mp4",
      audio: "https://samples.test/audio.wav",
    };
    assert.doesNotThrow(() => minimalHiggsfieldInput(schema, samples), file);
    const sampled: unknown[] = [];
    const synced = await syncHiggsfieldPrices(
      [{ endpoint: `test/fixture-${count}`, schema }],
      async (_url, init) => {
        const input = JSON.parse(init.body!) as Record<string, unknown>;
        if (schema.properties?.duration?.enum)
          assert.ok(schema.properties.duration.enum.includes(input.duration), file);
        sampled.push(input.duration);
        return response({ type: "estimate", usd: "1" });
      },
      { apiKey: "id:key", now, catalogue, samples },
    );
    assert.deepEqual(synced.failed, [], file);
    const duration = schema.properties?.duration;
    if (duration?.type === "integer" && duration.enum)
      assert.equal(
        sampled[0],
        Math.min(...duration.enum.filter((value): value is number => typeof value === "number")),
        file,
      );
    count++;
  }
  assert.equal(count, 84);
});

test("minimal inputs satisfy every tracked Higgsfield schema", () => {
  const files = readdirSync(HF_SCHEMA_DIR).filter((file) => file.endsWith(".json"));
  assert.ok(files.length > 0);
  for (const file of files) {
    const doc = HiggsfieldSchemaDocSchema.parse(JSON.parse(readFileSync(path.join(HF_SCHEMA_DIR, file), "utf8")));
    const schema = doc.schema as JsonSchema;
    const input = minimalHiggsfieldInput(schema, {
      image: "https://samples.test/image.png",
      video: "https://samples.test/video.mp4",
      audio: "https://samples.test/audio.wav",
    });
    assert.doesNotThrow(
      () => validateJsonSchema(schema, input, { components: schema.$defs ?? {}, strict: false }),
      `${file}: ${doc.endpoint}`,
    );
  }
});

test("original catalogue amounts restore per-unit rates without becoming request totals", () => {
  const record = {
    ...seedance,
    list: {
      ...seedance.list!,
      amount: 0.08,
      originalAmount: 0.1,
      discountPercentage: null,
      discountExpiresAt: null,
      qualifier: "exact",
    },
    estimates: [],
    tiers: [{ when: { resolution: "720p" }, usdPerUnit: 0.08, basis: "output-second" as const, rounding: null }],
  };
  assert.ok(Math.abs(total(record, { resolution: "720p", duration: 5 }) - 0.5) < 1e-9);
  const estimated = {
    ...record,
    estimates: [{ type: "estimate" as const, input: { duration: 5 }, usd: 0.4, observedAt: "2026-11-15" }],
  };
  assert.ok(Math.abs(total(estimated, { duration: 5 }) - 0.5) < 1e-9);
});

test("resume retries local input failures when sample options are corrected", async () => {
  const checkpointFile = path.join(dir, "corrected-sample.jsonl");
  const entry = {
    endpoint: "test/needs-video",
    schema: { type: "object", required: ["video_url"], properties: { video_url: { type: "string", format: "uri" } } },
  };
  const opts = { apiKey: "id:key", now, catalogue, checkpointFile };
  let calls = 0;
  const fetchImpl: HiggsfieldFetch = async () => {
    calls++;
    return response({ type: "estimate", usd: "0.2" });
  };
  assert.equal((await syncHiggsfieldPrices([entry], fetchImpl, opts)).failed.length, 1);
  assert.equal(calls, 0);
  assert.equal(
    (
      await syncHiggsfieldPrices([entry], fetchImpl, {
        ...opts,
        resume: true,
        samples: { video: "https://samples.test/video.mp4" },
      })
    ).failed.length,
    0,
  );
  assert.equal(calls, 1);
});

test("usage parser reads the recorded live time_series shape and sums the real live-test spend", async () => {
  const recorded = JSON.parse(readFileSync(new URL("./fixtures/higgsfield/usage.json", import.meta.url), "utf8")) as {
    response: unknown;
  };
  const usage = await fetchHiggsfieldUsage(async () => response(recorded.response), { apiKey: "id:key" });
  assert.deepEqual(
    usage.map((row) => row.model),
    ["higgsfield-ai/soul/v2/standard", "higgsfield/genjutsu-light/motion-transfer/v1.0", "internal/recast-mask"],
  );
  assert.equal(Math.round(usage.reduce((sum, row) => sum + row.cost, 0) * 10000) / 10000, 0.2987);
  assert.equal(
    reconcileHiggsfieldUsage(usage, []).rows.find((row) => row.model === "higgsfield-ai/soul/v2/standard")?.day,
    "2026-11-15",
  );
});
