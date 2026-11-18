import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { hfPricingCommand } from "../scripts/hf-pricing";
import { catalogEntry } from "./helpers/fal-temp-catalog";
import {
  higgsfieldScenarioInput,
  higgsfieldScenarioPricingFor,
  syncHiggsfieldScenarioEstimates,
  higgsfieldPricingFor,
  serialiseHiggsfieldPrices,
  summariseHiggsfieldUsage,
  type HiggsfieldFetch,
  type HiggsfieldScenarioEntry,
} from "../src/lib/models/hf-pricing";
import { scenariosForCategory } from "../src/lib/models/price-scenario-categories";
import { buildPriceMatrix, loadPriceScenarios } from "../src/lib/models/price-matrix";
import { loadModelSlots, slotModelPrice } from "../src/lib/models/model-slots";
import { higgsfieldSchemaSha256, resetProviderCatalogCache } from "../src/lib/models/fal-catalog";
import type { JsonSchema } from "../src/lib/providers/json-schema-validate";
import type { HiggsfieldPriceRecord } from "../src/types/higgsfield";

const now = new Date("2026-11-16T12:00:00Z");
const root = mkdtempSync(path.join(tmpdir(), "hf-scenarios-"));
process.once("exit", () => rmSync(root, { recursive: true, force: true }));
const schema: JsonSchema = JSON.parse(readFileSync("tests/fixtures/higgsfield/scenario-video.json", "utf8"));
const scenarios = loadPriceScenarios();
const slots = [{ id: "video.text-to-video", categories: ["text-to-video" as const] }];
const response = (body: unknown, status = 200, retry: string | null = null) => ({
  ok: status < 400,
  status,
  headers: { get: () => retry },
  json: async () => body,
});
function entry(inputSchema: JsonSchema = structuredClone(schema)): HiggsfieldScenarioEntry {
  return {
    ...catalogEntry("fal-ai/flux/schnell", {
      provider: "higgsfield",
      endpoint: "fixture/scenario-video",
      category: "text-to-video",
      outputs: { kinds: ["video"], fields: [] },
      inputs: Object.entries(inputSchema.properties ?? {}).map(([name, field]) => ({
        name,
        type: field.type as string,
        required: inputSchema.required?.includes(name) ?? false,
        ...(field.enum ? { enum: field.enum as (string | number | boolean | null)[] } : {}),
        ...(field.minimum !== undefined ? { min: field.minimum } : {}),
        ...(field.maximum !== undefined ? { max: field.maximum } : {}),
        ...(field.default !== undefined ? { default: field.default } : {}),
      })),
    }),
    inputSchema,
  };
}
const options = { apiKey: "fixture-id:fixture-secret", now, slots, previous: new Map<string, HiggsfieldPriceRecord>() };
const priceFetch: HiggsfieldFetch = async (_url, init) => {
  const input = JSON.parse(init.body!);
  return response({ type: "estimate", usd: input.resolution === "1080p" ? 0.3 : input.generate_audio ? 0.2 : 0.1 });
};
const only = (...ids: string[]) => ({
  ...scenarios,
  scenarios: scenarios.scenarios.filter((row) => ids.includes(row.id)),
});

test("category scenarios union every applicable slot once, preserving scenario order", () => {
  const mapped = scenariosForCategory(
    "text-to-video",
    [...slots, { ...slots[0]!, id: "video.reference-to-video" }],
    scenarios,
  );
  assert.deepEqual(
    mapped.map((row) => row.id),
    scenarios.scenarios.filter((row) => row.id.startsWith("10s-")).map((row) => row.id),
  );
  // A category no slot accepts is compared on the one-call scenario only (catalogue matrix contract).
  assert.deepEqual(
    scenariosForCategory("unknown", slots, scenarios).map((row) => row.id),
    ["1-call"],
  );
});

test("scenario payloads include duration, resolution, aspect and both audio states; infeasible 480p skips without a call", async () => {
  const payloads: Record<string, unknown>[] = [];
  const result = await syncHiggsfieldScenarioEstimates(
    [entry()],
    scenarios,
    async (url, init) => {
      assert.equal(url, "https://api.higgsfield.ai/estimate/fixture/scenario-video");
      assert.equal(init.headers.Authorization, "Key fixture-id:fixture-secret");
      assert.equal(init.method, "POST");
      payloads.push(JSON.parse(init.body!));
      return priceFetch(url, init);
    },
    options,
  );
  assert.equal(result.requests, 4);
  assert.equal(result.partial, false);
  assert.deepEqual(result.perScenario["10s-480p"], { success: 0, skip: 1, fail: 0 });
  assert.match(result.results.find((row) => row.scenario === "10s-480p")!.reason!, /unsupported resolution/);
  for (const payload of payloads) {
    assert.equal(payload.duration, 10);
    assert.equal(payload.aspect_ratio, "16:9");
    assert.equal(payload.prompt, "a red fox in snow");
  }
  assert.deepEqual(
    new Set(payloads.map((row) => `${row.resolution}/${row.generate_audio}`)),
    new Set(["720p/false", "720p/true", "1080p/false", "1080p/true"]),
  );
  assert.equal(result.records[0]!.estimates.length, 4);
});

test("sync estimates hit the real slot and matrix lookup exactly at 720p, 1080p and 720p audio when defaults establish the full input", async () => {
  const model = entry();
  const result = await syncHiggsfieldScenarioEstimates([model], scenarios, priceFetch, options);
  const file = path.join(root, "lookup-prices.json");
  writeFileSync(file, serialiseHiggsfieldPrices(result.records, "2026-11-16"));
  const previousPath = process.env.AGENTBROS_HF_PRICES;
  process.env.AGENTBROS_HF_PRICES = file;
  try {
    const table = loadModelSlots();
    const slot = table.slots[0]!;
    Object.assign(slot, {
      id: slots[0]!.id,
      categories: slots[0]!.categories,
      inputs: [],
      outputs: ["video"],
      candidates: [
        {
          provider: "higgsfield",
          endpoint: model.endpoint,
          status: "active",
          class: "hero",
          order: 1,
          why: "fixture",
          addedAt: "2026-11-16",
          evidence: [],
        },
      ],
    });
    const matrix = buildPriceMatrix(
      { ...table, slots: [slot] },
      { higgsfield: new Map([[model.endpoint, model]]) },
      new Map(),
      new Map(result.records.map((row) => [row.endpoint, row])),
      new Map(),
      now,
    );
    for (const [id, usd] of [
      ["10s-720p", 0.1],
      ["10s-1080p", 0.3],
      ["10s-720p-audio", 0.2],
    ] as const) {
      const setting = scenarios.scenarios.find((row) => row.id === id)!.setting;
      const price = slotModelPrice(model, setting, undefined, now);
      assert.equal(price.kind, "exact");
      assert.equal(price.usd, usd);
      assert.equal(matrix.rows[0]!.scenarioPrices[id]!.kind, "exact");
      assert.equal(matrix.rows[0]!.scenarioPrices[id]!.usd, usd);
    }
  } finally {
    process.env.AGENTBROS_HF_PRICES = previousPath;
  }
});

test("required prompt without a default stays part of exact identity: shared helper hits, current discovery projection needs the handoff", async () => {
  const noDefault = structuredClone(schema);
  delete noDefault.properties!.prompt!.default;
  const model = entry(noDefault),
    selected = only("10s-720p");
  const result = await syncHiggsfieldScenarioEstimates([model], selected, priceFetch, options);
  const record = result.records[0]!,
    setting = selected.scenarios[0]!.setting;
  const input = higgsfieldScenarioInput(model, setting, {});
  assert.ok(higgsfieldPricingFor(record, input, { now }).estimate);
  assert.ok(higgsfieldScenarioPricingFor(record, model, setting, now)?.estimate);
  assert.equal(
    higgsfieldPricingFor(
      record,
      { duration: 10, resolution: "720p", aspect_ratio: "16:9", generate_audio: false },
      { now },
    ).pricing.kind,
    "unknown",
  );
  assert.equal(
    higgsfieldPricingFor(record, { ...input, prompt: "different content" }, { now }).pricing.kind,
    "unknown",
  );
  assert.equal(
    higgsfieldScenarioPricingFor(
      { ...record, estimates: [{ ...record.estimates[0]!, input: { ...input, prompt: "different content" } }] },
      model,
      setting,
      now,
    ),
    undefined,
  );
});

test("schema enums and ranges, sound controls, sample media and decimal MP are respected", () => {
  const sound = structuredClone(schema);
  delete sound.properties!.generate_audio;
  sound.properties!.sound = { type: "string", enum: ["on", "off"], default: "off" };
  sound.properties!.image_url = { type: "string" };
  sound.required!.push("image_url");
  const setting = scenarios.scenarios.find((row) => row.id === "10s-720p-audio")!.setting;
  assert.equal(higgsfieldScenarioInput(entry(sound), setting, { image: "https://samples.test/image.png" }).sound, "on");
  assert.throws(() => higgsfieldScenarioInput(entry(sound), setting, {}), /sample URL/);
  assert.throws(() => higgsfieldScenarioInput(entry(), { ...setting, durationSec: 11 }, {}), /unsupported duration/);
  assert.throws(() => higgsfieldScenarioInput(entry(), { images: 1, megapixels: 2 }, {}), /megapixels/);
  const image: JsonSchema = {
    type: "object",
    properties: {
      num_images: { type: "integer", minimum: 1, maximum: 2 },
      megapixels: { type: "integer", enum: [1, 2] },
    },
  };
  assert.deepEqual(higgsfieldScenarioInput(entry(image), { images: 1, megapixels: 2 }, {}), {
    num_images: 1,
    megapixels: 2,
  });
});

test("429 Retry-After and server failures use three total attempts and count every request", async () => {
  const waits: number[] = [];
  let calls = 0;
  const result = await syncHiggsfieldScenarioEstimates(
    [entry()],
    only("10s-720p"),
    async (url, init) => {
      calls++;
      return calls === 1 ? response({}, 429, "2") : calls === 2 ? response({}, 503) : priceFetch(url, init);
    },
    {
      ...options,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  );
  assert.equal(result.requests, 3);
  assert.equal(result.partial, false);
  assert.deepEqual(waits, [2000, 2000]);
  const failure = await syncHiggsfieldScenarioEstimates(
    [entry()],
    only("10s-720p"),
    async () => response({}, 429, "0"),
    { ...options, sleep: async () => {} },
  );
  assert.equal(failure.requests, 3);
  assert.equal(failure.partial, true);
  assert.deepEqual(failure.perScenario["10s-720p"], { success: 0, skip: 0, fail: 1 });
});

test("resume uses same-day schema/sample/scenario fingerprints, repairs a torn tail and retries failures", async () => {
  const checkpointFile = path.join(root, "resume.jsonl"),
    selected = only("10s-720p");
  const first = await syncHiggsfieldScenarioEstimates([entry()], selected, priceFetch, { ...options, checkpointFile });
  appendFileSync(checkpointFile, '{"torn":');
  const resumed = await syncHiggsfieldScenarioEstimates(
    [entry()],
    selected,
    async () => {
      throw new Error("must not call");
    },
    { ...options, checkpointFile, resume: true },
  );
  assert.equal(resumed.requests, 0);
  assert.equal(resumed.resumed, 1);
  assert.deepEqual(resumed.records, first.records);
  assert.ok(readFileSync(checkpointFile, "utf8").endsWith("\n"));
  const changed = structuredClone(schema);
  changed.properties!.duration!.minimum = 4;
  assert.equal(
    (
      await syncHiggsfieldScenarioEstimates([entry(changed)], selected, priceFetch, {
        ...options,
        checkpointFile,
        resume: true,
      })
    ).requests,
    1,
  );
  assert.equal(
    (
      await syncHiggsfieldScenarioEstimates([entry()], selected, priceFetch, {
        ...options,
        checkpointFile,
        resume: true,
        samples: { image: "https://samples.test/new.png" },
      })
    ).requests,
    1,
  );
  assert.equal(
    (
      await syncHiggsfieldScenarioEstimates([entry()], selected, priceFetch, {
        ...options,
        checkpointFile,
        resume: true,
        now: new Date("2026-11-17"),
      })
    ).requests,
    1,
  );
  const failureFile = path.join(root, "retry-failure.jsonl");
  await syncHiggsfieldScenarioEstimates([entry()], selected, async () => response({}, 400), {
    ...options,
    checkpointFile: failureFile,
  });
  assert.equal(
    (
      await syncHiggsfieldScenarioEstimates([entry()], selected, priceFetch, {
        ...options,
        checkpointFile: failureFile,
        resume: true,
      })
    ).requests,
    1,
  );
});

test("partial failure preserves old matching estimates and unselected endpoints, adding successful scenarios", async () => {
  const model = entry(),
    selected = only("10s-720p", "10s-1080p");
  const old: HiggsfieldPriceRecord = {
    endpoint: model.endpoint,
    observedAsOf: "2026-11-15",
    list: null,
    tiers: [],
    estimates: [
      {
        input: higgsfieldScenarioInput(model, selected.scenarios[0]!.setting, {}),
        type: "estimate",
        usd: 0.09,
        observedAt: "2026-11-15",
      },
    ],
  };
  const unrelated = { ...old, endpoint: "fixture/unselected" };
  const result = await syncHiggsfieldScenarioEstimates(
    [model],
    selected,
    async (url, init) =>
      JSON.parse(init.body!).resolution === "720p"
        ? response({ detail: "fixture-id:fixture-secret" }, 400)
        : priceFetch(url, init),
    {
      ...options,
      previous: new Map([
        [old.endpoint, old],
        [unrelated.endpoint, unrelated],
      ]),
    },
  );
  assert.equal(result.partial, true);
  assert.equal(result.requests, 2);
  assert.equal(result.records.find((row) => row.endpoint === old.endpoint)!.estimates.length, 2);
  assert.deepEqual(result.records.find((row) => row.endpoint === old.endpoint)!.estimates[0], old.estimates[0]);
  assert.equal(
    result.records.find((row) => row.endpoint === unrelated.endpoint),
    unrelated,
  );
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
});

test("workers default to concurrency two", async () => {
  let active = 0,
    peak = 0;
  const result = await syncHiggsfieldScenarioEstimates(
    [entry()],
    scenarios,
    async (url, init) => {
      active++;
      peak = Math.max(active, peak);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return priceFetch(url, init);
    },
    options,
  );
  assert.equal(peak, 2);
  assert.equal(result.requests, 4);
});

test("a partial description refresh preserves unmatched historical tiers and fresh matching conditions win", async () => {
  const model = entry();
  const old: HiggsfieldPriceRecord = {
    endpoint: model.endpoint,
    observedAsOf: "2026-11-15",
    list: null,
    estimates: [],
    tiers: [
      { when: { resolution: "720p" }, usdPerUnit: 0.01, basis: "output-second", rounding: null },
      { when: { resolution: "1080p" }, usdPerUnit: 0.02, basis: "output-second", rounding: null },
    ],
  };
  const result = await syncHiggsfieldScenarioEstimates(
    [model],
    only("10s-720p", "10s-1080p"),
    async (_url, init) =>
      JSON.parse(init.body!).resolution === "1080p"
        ? response({}, 400)
        : response({ type: "description", pricing_description: "Price per second (output): 720p — $0.03." }),
    { ...options, previous: new Map([[old.endpoint, old]]) },
  );
  assert.equal(result.partial, true);
  assert.deepEqual(
    result.records[0]!.tiers.map((tier) => [tier.when.resolution, tier.usdPerUnit]),
    [
      ["720p", 0.03],
      ["1080p", 0.02],
    ],
  );
  assert.equal(result.records[0]!.estimates[0]!.type, "description");
});

test("usage summary is read-only, date-filtered account analytics and validates unfamiliar shapes", async () => {
  const summary = await summariseHiggsfieldUsage(
    "2026-11-16",
    async (url, init) => {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, "/models/usage");
      assert.equal(init.method, "GET");
      assert.equal(init.body, undefined);
      assert.equal(parsed.searchParams.get("start"), "2026-11-16T00:00:00Z");
      return response({
        time_series: [
          {
            bucket: "2026-11-16T00:00:00",
            results: [{ model: "fixture/video", quantity: 2, unit_price: 0.1, cost: 0.2 }],
          },
          { bucket: "2026-11-15", results: [{ model: "fixture/old", quantity: 1, unit_price: 9, cost: 9 }] },
        ],
        total: 2,
        page: 1,
        limit: 100,
      });
    },
    options,
  );
  assert.equal(summary.costUsd, 0.2);
  assert.equal(summary.rows, 1);
  assert.equal(summary.authority, "analytics, not billing");
  await assert.rejects(summariseHiggsfieldUsage("2026-11-16", async () => response({ usage: [] }), options));
});

test("CLI --check-usage exposes usageBefore before estimates with injected fetch and dry-run writes nothing", async () => {
  const model = entry(),
    sha = higgsfieldSchemaSha256(schema);
  const catalogue = path.join(root, "catalogue"),
    schemas = path.join(root, "schemas");
  mkdirSync(catalogue);
  mkdirSync(schemas);
  const { inputSchema: _schema, ...catalogued } = model;
  writeFileSync(
    path.join(catalogue, "text-to-video.json"),
    JSON.stringify({
      version: 1,
      provider: "higgsfield",
      category: "text-to-video",
      syncedAt: "2026-11-16",
      entries: [{ ...catalogued, schema: { ...catalogued.schema, sha256: sha } }],
    }),
  );
  writeFileSync(
    path.join(schemas, `${sha}.json`),
    JSON.stringify({ version: 1, endpoint: model.endpoint, title: "fixture", asOf: "2026-11-16", schema }),
  );
  const table = loadModelSlots();
  Object.assign(table.slots[0]!, slots[0]);
  const slotsFile = path.join(root, "slots.json");
  writeFileSync(slotsFile, JSON.stringify(table));
  const names = [
    "AGENTBROS_HF_CATALOG_DIR",
    "AGENTBROS_HF_SCHEMA_DIR",
    "AGENTBROS_MODEL_SLOTS",
    "HIGGSFIELD_API_KEY",
  ] as const;
  const previous = names.map((name) => process.env[name]),
    argv = process.argv;
  Object.assign(process.env, {
    AGENTBROS_HF_CATALOG_DIR: catalogue,
    AGENTBROS_HF_SCHEMA_DIR: schemas,
    AGENTBROS_MODEL_SLOTS: slotsFile,
    HIGGSFIELD_API_KEY: options.apiKey,
  });
  process.argv = [
    process.execPath,
    "scripts/hf-pricing.ts",
    "--sync",
    "--scenarios",
    "--endpoints",
    model.endpoint,
    "--check-usage",
    "--as-of",
    "2026-11-16",
    "--dry-run",
  ];
  resetProviderCatalogCache();
  const calls: string[] = [],
    before = readFileSync(process.env.AGENTBROS_HF_PRICES!, "utf8");
  try {
    const result = await hfPricingCommand(async (url, init) => {
      calls.push(url);
      return url.includes("/models/usage")
        ? response({ time_series: [], total: 0, page: 1, limit: 100 })
        : priceFetch(url, init);
    });
    assert.ok("usageBefore" in result.metadata);
    assert.equal(result.metadata.usageBefore?.costUsd, 0);
    assert.equal(result.metadata.requests, 4);
    assert.match(calls[0]!, /\/models\/usage/);
    assert.deepEqual(result.outputs, []);
    assert.equal(readFileSync(process.env.AGENTBROS_HF_PRICES!, "utf8"), before);
  } finally {
    process.argv = argv;
    names.forEach((name, index) => {
      if (previous[index] === undefined) delete process.env[name];
      else process.env[name] = previous[index];
    });
    resetProviderCatalogCache();
  }
});

test("a fixed-output model without resolution/aspect controls is priced natively; duration stays strict", () => {
  const fixed = structuredClone(schema);
  delete fixed.properties!.resolution;
  delete fixed.properties!.aspect_ratio;
  fixed.required = (fixed.required ?? []).filter((name) => !["resolution", "aspect_ratio"].includes(name));
  const input = higgsfieldScenarioInput(entry(fixed), { durationSec: 10, resolution: "1080p" }, {});
  assert.equal(input.duration, 10);
  assert.equal("resolution" in input, false);
  assert.equal("aspect_ratio" in input, false);
  const noDuration = structuredClone(schema);
  delete noDuration.properties!.duration;
  noDuration.required = (noDuration.required ?? []).filter((name) => name !== "duration");
  assert.throws(
    () => higgsfieldScenarioInput(entry(noDuration), { durationSec: 10 }, {}),
    /No schema control for requested duration|unsupported duration/,
  ); // either way, never silently priced at another length
});
