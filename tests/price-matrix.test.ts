import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { catalogEntry } from "./helpers/fal-temp-catalog";
import { buildPriceMatrix, loadPriceScenarios, priceFromScenarios } from "../src/lib/models/price-matrix";
import {
  historicalEndpoints,
  loadFalHistoricalPrices,
  syncFalHistoricalPrices,
  type HistoricalFetch,
} from "../src/lib/models/fal-historical-pricing";
import { loadModelSlots, pickModel } from "../src/lib/models/model-slots";
import { checkModelConstraints } from "../src/lib/models/model-constraints";
import type { ModelChoicePrice } from "../src/types/fal-catalog";
import type { HistoricalPrice, PriceScenarios } from "../src/types/price-matrix";

const now = new Date("2026-11-15T00:00:00Z");
const price = (
  kind: ModelChoicePrice["kind"],
  usd: number | null,
  basis: string | null = "output",
): ModelChoicePrice => ({
  kind,
  usd,
  basis,
  label: "fixture tariff https://example.com/tariff",
  asOf: "2026-11-15",
  unitPrice: 0.01,
  unit: "images",
  evidenceKind: "fixture",
});
const historical = (endpoint: string): HistoricalPrice => ({
  endpoint,
  usdPerCall: 0.0554,
  currency: "USD",
  observedAsOf: "2026-11-15",
});
function fixture() {
  const file = loadModelSlots();
  const slot = file.slots[0]!;
  slot.id = "image.generate";
  slot.reference = { images: 1, megapixels: 1 };
  slot.candidates = [
    {
      provider: "fal",
      endpoint: "fixture/model",
      status: "active",
      class: "hero",
      order: 1,
      why: "fixture",
      addedAt: "2026-11-15",
      evidence: [{ kind: "owner", text: "fixture", source: "fixture", date: "2026-11-15" }],
    },
  ];
  const entry = catalogEntry("fal-ai/flux/schnell", {
    endpoint: "fixture/model",
    tier: "verified",
    category: "text-to-image",
    outputs: { kinds: ["image"], fields: [] },
  });
  return {
    file: { ...file, slots: [slot] },
    entry,
    catalogs: { fal: new Map([[entry.endpoint, entry]]) },
    histories: new Map([[entry.endpoint, historical(entry.endpoint)]]),
  };
}
test("matrix priority: exact, approximate tariff, reference estimate, historical, floor, unknown", () => {
  const f = fixture(),
    build = (p: ModelChoicePrice) =>
      buildPriceMatrix(f.file, f.catalogs, () => p, new Map(), f.histories, now).rows[0]!;
  assert.equal(build(price("exact", 0.02)).scenarioPrices["1-image-1mp"]!.kind, "exact");
  assert.equal(build(price("approximate", 0.03)).scenarioPrices["1-image-1mp"]!.usd, 0.03);
  f.file.slots[0]!.candidates[0]!.referenceEstimate = {
    usd: 0.04,
    per: "image",
    setting: "fixture",
    source: "https://example.com/reference",
    observedAsOf: "2026-11-15",
  };
  assert.equal(build(price("unknown", null)).scenarioPrices["1-image-1mp"]!.usd, 0.04);
  delete f.file.slots[0]!.candidates[0]!.referenceEstimate;
  const typical = build(price("floor", null));
  assert.equal(typical.scenarioPrices["1-image-1mp"]!.kind, "typical");
  assert.equal(typical.perCallTypicalUsd, 0.0554);
  f.histories.clear();
  assert.equal(build(price("floor", null)).scenarioPrices["1-image-1mp"]!.kind, "floor");
  assert.match(build(price("unknown", null)).scenarioPrices["1-image-1mp"]!.reason!, /fixture/);
  assert.deepEqual(build(price("exact", 0.02)), build(price("exact", 0.02)));
});
test("historical per-call values never become duration/character/audio prices", () => {
  const f = fixture();
  for (const [slot, id] of [
    ["video.text-to-video", "10s-720p"],
    ["audio.voiceover", "1000-chars"],
    ["text.transcribe", "60s-audio"],
  ]) {
    f.file.slots[0]!.id = slot!;
    f.entry.inputs = [
      { name: "duration", type: "number", required: false, min: 1, max: 30 },
      { name: "aspect_ratio", type: "string", required: false, enum: ["16:9"] },
    ];
    const row = buildPriceMatrix(f.file, f.catalogs, () => price("unknown", null), new Map(), f.histories, now)
      .rows[0]!;
    assert.equal(row.scenarioPrices[id!]!.usd, null);
    assert.equal(row.perCallTypicalUsd, 0.0554);
    assert.match(row.scenarioPrices[id!]!.reason!, /historical average per call cannot price/);
  }
});
test("scaling requires the same shape/audio/reference inputs and an evidenced linear unit; never scales typical or floors", () => {
  const f = fixture(),
    scenarios = loadPriceScenarios();
  f.file.slots[0]!.id = "video.text-to-video";
  f.entry.inputs = [
    { name: "duration", type: "number", required: false, min: 1, max: 30 },
    { name: "aspect_ratio", type: "string", required: false, enum: ["16:9", "9:16"] },
  ];
  const row = buildPriceMatrix(
    f.file,
    f.catalogs,
    () => price("approximate", 2, "generated-second"),
    new Map(),
    f.histories,
    now,
  ).rows[0]!;
  const setting = { durationSec: 5, resolution: "720p", aspect: "16:9", generateAudio: false };
  assert.equal(priceFromScenarios(row, setting, scenarios)?.usd, 1);
  assert.match(priceFromScenarios(row, setting, scenarios)!.formula!, /scenario 10s-720p scaled ×0.5/);
  assert.equal(priceFromScenarios(row, { ...setting, aspect: "9:16" }, scenarios), undefined);
  assert.equal(priceFromScenarios(row, { ...setting, inputVideoDurationSec: 2 }, scenarios), undefined);
  f.file.slots[0]!.id = "image.generate";
  f.entry.inputs = [];
  const typical = buildPriceMatrix(f.file, f.catalogs, () => price("unknown", null), new Map(), f.histories, now)
    .rows[0]!;
  assert.equal(priceFromScenarios(typical, { images: 2, megapixels: 1 }, scenarios), undefined);
  const chars: PriceScenarios = {
    version: 1,
    slots: {},
    scenarios: [{ id: "1000-chars", oneCall: false, description: "fixture", setting: { inputCharacters: 1000 } }],
  };
  const characterRow = {
    ...row,
    scenarioPrices: {
      "1000-chars": {
        usd: 0.08,
        kind: "exact" as const,
        source: "fixture",
        observedAsOf: "2026-11-15",
        linearUnit: "inputCharacters" as const,
      },
    },
  };
  assert.equal(priceFromScenarios(characterRow, { inputCharacters: 1001 }, chars)?.usd, 0.16);
  assert.equal(priceFromScenarios(characterRow, { inputCharacters: 500 }, chars)?.kind, "approximate");
});
test("picker uses typical one-image scenarios under max-usd and exposes alternatives' scenario prices", () => {
  const f = fixture();
  const matrix = buildPriceMatrix(f.file, f.catalogs, () => price("unknown", null), new Map(), f.histories, now);
  const result = pickModel(
    { slot: "image.generate", maxUsd: 0.1 },
    { slots: f.file, catalogs: f.catalogs, prices: () => price("unknown", null), priceMatrix: matrix, now },
  );
  assert.equal(result.pick?.price.kind, "typical");
  assert.match(result.pick!.warnings.join(";"), /typical historical average; dry-run quote is authoritative/);
  assert.equal(result.pick?.scenarioPrices["1-image-1mp"]?.usd, 0.0554);
  assert.equal(
    pickModel(
      { slot: "image.generate", images: 2, maxUsd: 0.1 },
      { slots: f.file, catalogs: f.catalogs, prices: () => price("unknown", null), priceMatrix: matrix, now },
    ).pick,
    null,
  );
});
test("a missing resolution control warns; an explicit incompatible enum still rejects", () => {
  const f = fixture(),
    query = { categories: [], inputs: [], outputs: [], resolution: "720p" };
  assert.deepEqual(checkModelConstraints(f.entry, query).rejectedBecause, []);
  assert.match(checkModelConstraints(f.entry, query).warnings.join(";"), /resolution fixed by variant/);
  f.entry.inputs = [{ name: "resolution", type: "string", required: false, enum: ["1080p"] }];
  assert.match(checkModelConstraints(f.entry, query).rejectedBecause.join(";"), /unsupported resolution/);
});
const answer = (status = 200, cost = 0.0554) => ({
  ok: status === 200,
  status,
  headers: { get: () => null },
  json: async () => ({ estimate_type: "historical_api_price", total_cost: cost, currency: "USD" }),
});
test("historical sync bounds concurrency to two, sends one endpoint per POST, retries 429 and resumes completed checkpoints", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "fal-history-")),
    checkpointFile = path.join(directory, "checkpoint.jsonl");
  try {
    let active = 0,
      maximum = 0,
      calls = 0;
    const delays: number[] = [];
    const fake: HistoricalFetch = async (_url, init) => {
      active++;
      maximum = Math.max(maximum, active);
      calls++;
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Authorization, "Key secret");
      const body = JSON.parse(init.body);
      assert.equal(Object.keys(body.endpoints).length, 1);
      assert.deepEqual(Object.values(body.endpoints), [{ call_quantity: 1 }]);
      const call = calls;
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return answer(call === 1 ? 429 : 200);
    };
    const result = await syncFalHistoricalPrices(["fixture/a", "fixture/b", "fixture/c"], fake, {
      apiKey: "secret",
      now,
      checkpointFile,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    assert.equal(result.records.length, 3);
    assert.equal(maximum, 2);
    assert.equal(result.requests, 4);
    assert.deepEqual(delays, [1000]);
    writeFileSync(checkpointFile, readFileSync(checkpointFile, "utf8") + '{"incomplete":');
    const resumed = await syncFalHistoricalPrices(
      ["fixture/a", "fixture/b", "fixture/c"],
      async () => {
        throw new Error("must resume");
      },
      { apiKey: "secret", now, checkpointFile, resume: true },
    );
    assert.equal(resumed.requests, 0);
    assert.deepEqual(resumed.records, result.records);
    assert.ok(readFileSync(checkpointFile, "utf8").endsWith("\n"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("partial sync retains failed/unselected previous records, redacts errors and only resumes today's success", async () => {
  const previous = new Map([
    ["fixture/failed", historical("fixture/failed")],
    ["fixture/unselected", historical("fixture/unselected")],
  ]);
  const result = await syncFalHistoricalPrices(
    ["fixture/new", "fixture/failed"],
    async (_url, init) => {
      if (init.body.includes("failed")) throw new Error("Key supersecret");
      return answer(200, 0.08);
    },
    { apiKey: "supersecret", now, previous },
  );
  assert.equal(result.partial, true);
  assert.equal(result.syncedAt, null);
  assert.equal(result.records.length, 3);
  assert.equal(result.records.find((r) => r.endpoint === "fixture/failed")?.usdPerCall, 0.0554);
  assert.doesNotMatch(JSON.stringify(result), /supersecret/);
});
test("historical scope includes candidates and successors but excludes retired entries unless all is requested", () => {
  const f = fixture();
  f.file.slots[0]!.candidates[0]!.endpoint = "fixture/model-1.0/edit";
  const entries = new Map(
    ["fixture/model-1.0/edit", "fixture/model-2.0/edit", "fixture/other"].map((endpoint) => [
      endpoint,
      { ...f.entry, endpoint },
    ]),
  );
  assert.deepEqual(historicalEndpoints(f.file, entries), ["fixture/model-1.0/edit", "fixture/model-2.0/edit"]);
  assert.equal(historicalEndpoints(f.file, entries, true).length, 3);
});

test("injected typical prices cannot bypass one-call applicability or become scalable exact tariffs", () => {
  const f = fixture();
  f.file.slots[0]!.id = "video.text-to-video";
  f.entry.inputs = [
    { name: "duration", type: "number", required: false, min: 1, max: 30 },
    { name: "aspect_ratio", type: "string", required: false, enum: ["16:9"] },
  ];
  const row = buildPriceMatrix(
    f.file,
    f.catalogs,
    () => price("typical", 0.0554, "generated-second"),
    new Map(),
    new Map(),
    now,
  ).rows[0]!;
  assert.equal(row.scenarioPrices["10s-720p"]!.kind, "unknown");
  assert.equal(row.scenarioPrices["10s-720p"]!.linearUnit, undefined);
});

test("Higgsfield output-second rounding, caps and extras never authorise linear scenario scaling", async () => {
  const { tierPrice } = await import("./helpers/hf-choice-fixtures");
  const f = fixture();
  f.file.slots[0]!.id = "video.text-to-video";
  f.file.slots[0]!.candidates[0]!.provider = "higgsfield";
  const entry = {
    ...f.entry,
    provider: "higgsfield" as const,
    category: "text-to-video" as const,
    inputs: [
      { name: "duration", type: "number", required: false, min: 1, max: 30 },
      { name: "aspect_ratio", type: "string", required: false, enum: ["16:9"] },
    ],
  };
  for (const patch of [
    { rounding: "ceil-second" as const },
    { capSeconds: 8 },
    { extras: [{ field: "image_urls", includedCount: 1, usdPerExtra: 0.1 }] },
  ]) {
    const record = tierPrice(entry.endpoint);
    Object.assign(record.tiers[0]!, patch);
    const row = buildPriceMatrix(
      f.file,
      { higgsfield: new Map([[entry.endpoint, entry]]) },
      () => price("unknown", null),
      new Map([[entry.endpoint, record]]),
      new Map(),
      now,
    ).rows[0]!;
    assert.equal(row.scenarioPrices["10s-720p"]!.kind, "exact");
    assert.equal(row.scenarioPrices["10s-720p"]!.linearUnit, undefined);
    assert.equal(
      priceFromScenarios(
        row,
        { durationSec: 5.5, resolution: "720p", aspect: "16:9", generateAudio: false },
        loadPriceScenarios(),
      ),
      undefined,
    );
  }
});

test("additional class availability preserves the hero, table uniqueness and requested-class selection", () => {
  const f = fixture();
  f.file.slots[0]!.candidates[0]!.alsoClasses = ["budget"];
  const result = pickModel(
    { slot: "image.generate", class: "budget" },
    { slots: f.file, catalogs: f.catalogs, prices: () => price("exact", 0.02), now },
  );
  assert.equal(result.pick?.class, "budget");
  assert.equal(f.file.slots[0]!.candidates[0]!.class, "hero");
});

test("a zero historical average means no usage history, never a free price", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hist-zero-")),
    file = path.join(dir, "h.json");
  try {
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        syncedAt: "2026-11-15",
        records: [
          { endpoint: "a/zero", usdPerCall: 0, currency: "USD", observedAsOf: "2026-11-15" },
          { endpoint: "b/real", usdPerCall: 0.05, currency: "USD", observedAsOf: "2026-11-15" },
        ],
      }),
    );
    const loaded = loadFalHistoricalPrices(file);
    assert.equal(loaded.has("a/zero"), false);
    assert.equal(loaded.get("b/real")?.usdPerCall, 0.05);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
