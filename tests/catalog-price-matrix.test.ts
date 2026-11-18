import "./helpers/tracked-prices";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { catalogEntry } from "./helpers/fal-temp-catalog";
import { loadModelSlots, MODEL_SLOTS_FILE, slotCatalogs } from "../src/lib/models/model-slots";
import { FAL_HISTORICAL_FILE, loadFalHistoricalPrices } from "../src/lib/models/fal-historical-pricing";
import { HF_PRICES_FILE, loadHiggsfieldPrices } from "../src/lib/models/hf-pricing";
import { modelChoicePrice } from "../src/lib/models/model-choice-price";
import {
  buildCatalogPriceMatrix,
  currentPriceMatrix,
  loadCatalogPriceMatrices,
  loadPriceScenarios,
  normalisePriceGapReason,
  PRICE_GAPS_FILE,
  PRICE_MATRIX_CATALOG_DIR,
  renderPriceGaps,
  scenarioCell,
  serialiseCatalogPriceMatrix,
  updateCatalogPriceMatrices,
} from "../src/lib/models/price-matrix";
import { scenariosForCategory } from "../src/lib/models/price-scenario-categories";
import { rankModelPrices } from "../src/lib/models/models-compare";
import { CatalogPriceMatrixSchema } from "../src/types/price-matrix";
import type { ModelChoicePrice } from "../src/types/fal-catalog";
import { modelRefreshSteps, refreshModels, retainFailedHiggsfieldPrices } from "../src/lib/models/models-refresh";
import { floorPrice, tierPrice } from "./helpers/hf-choice-fixtures";

const now = new Date("2026-11-15T00:00:00Z");
const scenarios = loadPriceScenarios();
const missing: ModelChoicePrice = {
  kind: "unknown",
  label: "fixture missing price",
  usd: null,
  unitPrice: null,
  unit: null,
  asOf: null,
  evidenceKind: "none",
  basis: null,
};
function fixture() {
  const slots = loadModelSlots();
  slots.slots = [{ ...slots.slots[0]!, id: "fixture.image", categories: ["text-to-image"], candidates: [] }];
  const definitions = { ...scenarios, slots: { "fixture.image": ["1-image-2mp", "1-image-1mp"] } };
  const a = catalogEntry("fal-ai/flux/schnell", {
    endpoint: "fixture/a",
    category: "text-to-image",
    lastSeen: "2026-11-14",
    schema: null,
    price: null,
    tier: "discovered",
    inputs: [],
  });
  const b = { ...a, endpoint: "fixture/b", provider: "higgsfield" as const };
  const c = { ...a, endpoint: "fixture/utility", category: "unknown" as const };
  const catalogs = {
    fal: new Map([
      [c.endpoint, c],
      [a.endpoint, a],
      ["fixture/gone", { ...a, endpoint: "fixture/gone", status: "gone" as const }],
    ]),
    higgsfield: new Map([[b.endpoint, b]]),
  };
  const historical = new Map([
    [a.endpoint, { endpoint: a.endpoint, usdPerCall: 0.2, currency: "USD" as const, observedAsOf: "2026-11-15" }],
  ]);
  const sources = { prices: () => missing, hfPrices: new Map(), historical };
  const matrices = buildCatalogPriceMatrix(catalogs, sources, definitions, slots, now);
  return { slots, definitions, catalogs, sources, matrices, a };
}

test("category mapping unions slot scenarios in scenario-file order, with one-call fallback", () => {
  const f = fixture();
  assert.deepEqual(
    scenariosForCategory("text-to-image", f.slots, f.definitions).map((s) => s.id),
    ["1-image-1mp", "1-image-2mp"],
  );
  assert.deepEqual(
    scenariosForCategory("unknown", f.slots, f.definitions).map((s) => s.id),
    ["1-call"],
  );
});
test("catalogue matrix includes each active entry once, is iteration-independent and dates the newest evidence", () => {
  const f = fixture();
  assert.equal(f.matrices.flatMap((file) => file.rows).length, 3);
  assert.deepEqual(
    f.matrices,
    buildCatalogPriceMatrix(
      { ...f.catalogs, fal: new Map([...f.catalogs.fal].reverse()) },
      f.sources,
      f.definitions,
      f.slots,
      new Date("2030-01-01"),
    ),
  );
  assert.equal(
    f.matrices.find((file) => file.category === "text-to-image" && file.provider === "fal")!.generatedAt,
    "2026-11-15",
  );
  for (const file of f.matrices) {
    assert.deepEqual(CatalogPriceMatrixSchema.parse(JSON.parse(serialiseCatalogPriceMatrix(file))), file);
    for (const row of file.rows)
      for (const cell of Object.values(row.scenarioPrices)) {
        if (cell.kind === "unknown") {
          assert.ok(cell.reason);
          assert.equal(cell.usd, null);
        } else {
          assert.ok(cell.source);
          assert.ok(cell.observedAsOf);
        }
      }
  }
  assert.equal(
    scenarioCell(undefined, "fal", scenarios.scenarios[0]!, f.sources).reason,
    "Endpoint missing from catalogue",
  );
  const noReason = structuredClone(f.matrices.find((file) => file.provider === "higgsfield")!);
  delete Object.values(noReason.rows[0]!.scenarioPrices)[0]!.reason;
  assert.equal(CatalogPriceMatrixSchema.safeParse(noReason).success, false);
});
test("catalogue discounts use source-date snapshots even after the freshness window expires", () => {
  const f = fixture(),
    entry = f.catalogs.higgsfield.values().next().value!;
  const record = tierPrice(entry.endpoint);
  record.tiers = [{ when: {}, usdPerUnit: 0.05, basis: "image", rounding: null }];
  record.list = {
    ...floorPrice(entry.endpoint).list!,
    amount: 0.05,
    originalAmount: 0.1,
    discountPercentage: 50,
    discountExpiresAt: "2026-12-01",
  };
  const sources = { ...f.sources, hfPrices: new Map([[entry.endpoint, record]]) };
  const early = buildCatalogPriceMatrix(f.catalogs, sources, f.definitions, f.slots, now);
  const late = buildCatalogPriceMatrix(f.catalogs, sources, f.definitions, f.slots, new Date("2026-11-24"));
  assert.deepEqual(early, late);
  const row = early.find((file) => file.provider === "higgsfield")!.rows[0]!;
  assert.equal(row.scenarioPrices["1-image-1mp"]!.usd, 0.05);
});
test("catalogue writer checks complete shard set, prunes obsolete shards and reports exact bytes", () => {
  const f = fixture(),
    directory = mkdtempSync(path.join(tmpdir(), "catalog-matrix-"));
  try {
    assert.equal(updateCatalogPriceMatrices(f.matrices, true, directory).current, false);
    const result = updateCatalogPriceMatrices(f.matrices, false, directory);
    assert.equal(
      result.bytes,
      f.matrices.reduce((bytes, file) => bytes + Buffer.byteLength(serialiseCatalogPriceMatrix(file)), 0),
    );
    assert.deepEqual(loadCatalogPriceMatrices(directory), f.matrices);
    assert.equal(updateCatalogPriceMatrices(f.matrices, true, directory).current, true);
    writeFileSync(path.join(directory, "obsolete.json"), "{}");
    assert.equal(updateCatalogPriceMatrices(f.matrices, true, directory).current, false);
    updateCatalogPriceMatrices(f.matrices, false, directory);
    assert.equal(readdirSync(directory).includes("obsolete.json"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("ranking sorts USD with unknowns last, filters kinds/provider/slot and never budgets a floor", () => {
  const f = fixture();
  f.slots.slots[0]!.candidates = [
    {
      provider: "fal",
      endpoint: f.a.endpoint,
      status: "active",
      class: "hero",
      order: 1,
      why: "fixture",
      addedAt: "2026-11-15",
      evidence: [],
    },
  ];
  const options = { matrices: f.matrices, slots: f.slots, scenarios: f.definitions };
  let result = rankModelPrices({ scenario: "1-image-1mp" }, options);
  assert.deepEqual(
    result.rows.map((row) => row.kind),
    ["typical", "unknown"],
  );
  const hf = f.matrices.find((file) => file.provider === "higgsfield")!.rows[0]!;
  hf.scenarioPrices["1-image-1mp"] = { kind: "floor", usd: 0.01, source: "fixture", observedAsOf: "2026-11-15" };
  result = rankModelPrices({ scenario: "1-image-1mp" }, options);
  assert.deepEqual(
    result.rows.map((row) => row.usd),
    [0.01, 0.2],
  );
  assert.deepEqual(
    rankModelPrices({ scenario: "1-image-1mp", maxUsd: 0.3 }, options).rows.map((row) => row.kind),
    ["typical"],
  );
  assert.equal(
    rankModelPrices({ scenario: "1-image-1mp", provider: "higgsfield", kind: ["typical"] }, options).total,
    0,
  );
  assert.equal(rankModelPrices({ scenario: "1-image-1mp", slot: "fixture.image" }, options).total, 1);
  assert.equal(rankModelPrices({ scenario: "1-image-1mp", category: "unknown" }, options).total, 0);
  assert.equal(rankModelPrices({ scenario: "1-image-1mp", limit: 1 }, options).rows.length, 1);
  assert.throws(() => rankModelPrices({ scenario: "typo" }, options), /Unknown scenario/);
  assert.throws(() => rankModelPrices({ scenario: "1-image-1mp", slot: "typo" }, options), /Unknown slot/);
});
test("gaps doc keeps a previous baseline across idempotent writes, then reports real deltas", () => {
  const f = fixture(),
    matrix = { version: 1 as const, rows: [] };
  const first = renderPriceGaps(matrix, f.matrices, f.catalogs);
  assert.equal(renderPriceGaps(matrix, f.matrices, f.catalogs, first), first);
  const hf = f.matrices.find((file) => file.provider === "higgsfield")!.rows[0]!;
  hf.scenarioPrices["1-image-1mp"] = { kind: "exact", usd: 0.1, source: "fixture", observedAsOf: "2026-11-15" };
  const next = renderPriceGaps(matrix, f.matrices, f.catalogs, first);
  assert.match(next, /\| catalogue \| 0 \| 0 \| \+1 \| 0 \| 0 \| 0 \| -1 \|/);
  assert.equal(renderPriceGaps(matrix, f.matrices, f.catalogs, next), next);
  assert.equal(
    normalisePriceGapReason("Unknown price; unsupported resolution 480p; https://example.test/a"),
    "unsupported resolution #p",
  );
});

test("slots source validation never reads ignored diagnostic reports", () => {
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const exists = fs.existsSync; fs.existsSync = function(file) { if (String(file).endsWith('price-gaps.md')) return true; return exists.call(this, file); };
    const read = fs.readFileSync;
    fs.readFileSync = function(file, ...args) { if (String(file).endsWith('price-gaps.md')) throw Error('Ignored diagnostics must not be read during source validation'); return read.call(this, file, ...args); };
    syncBuiltinESMExports(); process.argv = ['node', 'models-slots.ts', '--check-doc'];
    await import('./scripts/models-slots.ts');`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", code], {
    cwd: path.resolve(import.meta.dirname, ".."),
    encoding: "utf8",
    timeout: 300_000,
  });
  const result = JSON.parse(child.stdout);
  // Freshness is a source-data decision; an ignored report must not affect it.
  if (result.ok) assert.equal(child.status, 0, child.stderr);
  else {
    assert.equal(child.status, 1);
    assert.equal(result.error, "VALIDATION");
    assert.match(result.message, /^Stale model slots docs or price matrices;/);
  }
  assert.equal((child.stdout + child.stderr).includes("Ignored diagnostics must not be read"), false);
});

test("tracked catalogue shards and gaps equal fresh builds; unknown coverage cannot exceed the baseline", () => {
  process.env.AGENTBROS_FAL_PRICES = path.resolve(import.meta.dirname, "../src/lib/models/fal-prices.json");
  const slots = loadModelSlots(MODEL_SLOTS_FILE),
    catalogs = slotCatalogs();
  const hfPrices = loadHiggsfieldPrices(HF_PRICES_FILE),
    historical = loadFalHistoricalPrices(FAL_HISTORICAL_FILE);
  const prices = (entry: Parameters<typeof modelChoicePrice>[0], setting: Parameters<typeof modelChoicePrice>[1]) =>
    modelChoicePrice(entry, setting, { now, hfPrices });
  const built = buildCatalogPriceMatrix(catalogs, { prices, hfPrices, historical }, scenarios, slots, now);
  assert.deepEqual(loadCatalogPriceMatrices(PRICE_MATRIX_CATALOG_DIR), built);
  assert.equal(updateCatalogPriceMatrices(built, true, PRICE_MATRIX_CATALOG_DIR).current, true);
  assert.ok(
    built
      .flatMap((file) => file.rows)
      .flatMap((row) => Object.values(row.scenarioPrices))
      .filter((cell) => cell.kind === "unknown").length <= 5631,
  ); // 2026-11-16: +121 cells where the model page tariff contradicts the API unit price (false exact prices removed)
  const bytes = updateCatalogPriceMatrices(built, true, PRICE_MATRIX_CATALOG_DIR).bytes;
  assert.ok(bytes < 3_000_000, `${bytes} bytes exceeds catalogue target`);
  for (const provider of ["fal", "higgsfield"] as const)
    assert.equal(
      built.filter((file) => file.provider === provider).flatMap((file) => file.rows).length,
      [...catalogs[provider]!.values()].filter((entry) => entry.status === "active").length,
    );
  const previous = renderPriceGaps(currentPriceMatrix(slots, catalogs, now, prices, historical), built, catalogs);
  assert.equal(
    renderPriceGaps(currentPriceMatrix(slots, catalogs, now, prices, historical), built, catalogs, previous),
    previous,
  );
});
test("ranking CLI emits one JSON envelope, sorted prices, without network or writes", () => {
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/models-prices.ts",
      "--scenario",
      "1-image-1mp",
      "--provider",
      "fal",
      "--limit",
      "10000",
    ],
    {
      cwd: path.resolve(import.meta.dirname, ".."),
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        AGENTBROS_MODEL_SLOTS: MODEL_SLOTS_FILE,
        AGENTBROS_PRICE_MATRIX_CATALOG_DIR: PRICE_MATRIX_CATALOG_DIR,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(typeof result.elapsedMs, "number");
  assert.ok(result.metadata.rows.length > 100);
  let previous = -Infinity;
  for (const row of result.metadata.rows) {
    const usd = row.kind === "unknown" ? Infinity : row.usd;
    assert.ok(usd >= previous);
    previous = usd;
    assert.ok(row.source);
    assert.ok(row.label);
  }
});
test("daily refresh plans all catalogue price sources, retains failed prices and ends with doc generation", async () => {
  const plan = modelRefreshSteps({}, { FAL_KEY: "fixture", HIGGSFIELD_API_KEY: "fixture" });
  assert.deepEqual(
    plan.filter((step) => step.id === "fal:pricing").map((step) => step.args),
    [
      ["--sync", "--resume", "--partial", "--budget-minutes", "75"],
      ["--docs", "--changed", "--resume"],
    ],
  );
  assert.deepEqual(plan.find((step) => step.id === "fal:historical")!.args, [
    "--historical",
    "--all",
    "--resume",
    "--budget-minutes",
    "120",
  ]);
  assert.ok(plan.find((step) => step.id === "hf:pricing")!.args.includes("--scenarios"));
  assert.deepEqual(plan.at(-1)?.args, ["--write-doc"]);
  const called: string[] = [];
  const result = await refreshModels(
    {},
    {
      now,
      env: {},
      snapshot: () => ({ entries: [], falPrices: [], hfPrices: [] }),
      slots: () => fixture().slots,
      compare: () => [],
      writeSlotsDoc: () => {
        called.push("inline-doc");
      },
      writeMatrix: () => {},
      writeReport: () => {},
      runStep: async (step) => {
        called.push(step.id);
        return { ok: true };
      },
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(called.slice(-2), ["inline-doc", "models:slots"]);
  const old = floorPrice("fixture/hf"),
    failed = { ...old, list: null };
  assert.deepEqual(retainFailedHiggsfieldPrices([old], [failed], [old.endpoint]), [old]);
});

test("video-to-video scenarios price the source length with tracked per-source-second Higgsfield tiers", () => {
  const catalogs = slotCatalogs();
  const hfPrices = loadHiggsfieldPrices();
  const scenario = scenarios.scenarios.find((s) => s.id === "10s-720p")!;
  const sources = { prices: new Map(), hfPrices, historical: new Map(), now: new Date("2026-11-16T00:00:00Z") };
  for (const [endpoint, usd] of [
    ["higgsfield/genjutsu/motion-transfer/v1.0", 3.446],
    ["kling-video/o3/video-edit", 0.945],
    ["higgsfield/genjutsu-light/motion-transfer/v1.0", 1.471],
  ] as const) {
    const cell = scenarioCell(catalogs.higgsfield!.get(endpoint), "higgsfield", scenario, sources as never);
    assert.equal(cell.kind, "exact", `${endpoint}: ${JSON.stringify(cell)}`);
    assert.ok(Math.abs(cell.usd! - usd) < 1e-6, `${endpoint}: ${cell.usd}`);
  }
});
