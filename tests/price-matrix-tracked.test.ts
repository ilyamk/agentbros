import "./helpers/tracked-prices";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  buildPriceMatrix,
  currentPriceMatrix,
  loadPriceScenarios,
  PRICE_GAPS_FILE,
  PRICE_MATRIX_FILE,
} from "../src/lib/models/price-matrix";
import { loadModelSlots, MODEL_SLOTS_FILE, slotCatalogs } from "../src/lib/models/model-slots";
import { PriceMatrixSchema } from "../src/types/price-matrix";
import { FAL_HISTORICAL_FILE, loadFalHistoricalPrices } from "../src/lib/models/fal-historical-pricing";

process.env.AGENTBROS_FAL_PRICES = path.resolve(import.meta.dirname, "../src/lib/models/fal-prices.json");
const now = new Date("2026-11-15T00:00:00Z");
const slots = loadModelSlots(MODEL_SLOTS_FILE),
  catalogs = slotCatalogs();
test("all image/video slots offer an active budget candidate with real schema, tier acceptance and docs evidence", () => {
  for (const slot of slots.slots.filter((slot) => /^(image|video)\./.test(slot.id))) {
    const budget = slot.candidates.filter(
      (c) => c.status === "active" && (c.class === "budget" || c.alsoClasses?.includes("budget")),
    );
    assert.ok(budget.length, slot.id);
    for (const candidate of budget) {
      const entry = catalogs[candidate.provider]?.get(candidate.endpoint);
      assert.equal(entry?.status, "active", candidate.endpoint);
      assert.ok(entry?.schema);
      assert.ok(
        entry.tier === "verified" || candidate.unverifiedAccepted || candidate.evidence.some((e) => e.kind === "owner"),
      );
      assert.ok(candidate.evidence.some((e) => e.kind === "docs"));
      assert.ok(candidate.why);
    }
  }
});
test("every slot names scenarios and the tracked deterministic matrix cannot regress unknown coverage", () => {
  const scenarios = loadPriceScenarios();
  for (const slot of slots.slots) assert.ok(scenarios.slots[slot.id]?.length, slot.id);
  const matrix = currentPriceMatrix(slots, catalogs, now, undefined, loadFalHistoricalPrices(FAL_HISTORICAL_FILE));
  const tracked = PriceMatrixSchema.parse(JSON.parse(readFileSync(PRICE_MATRIX_FILE, "utf8")));
  assert.deepEqual(tracked, matrix);
  assert.equal(
    readFileSync(PRICE_MATRIX_FILE, "utf8"),
    `${JSON.stringify(matrix, null, 2)}\n`,
    "scenarioCell extraction retains the tracked bytes",
  );
  const cells = matrix.rows.flatMap((row) => Object.values(row.scenarioPrices));
  assert.ok(cells.filter((cell) => cell.kind === "unknown").length <= 76); // Offline page tariff parsing reduces the unknown baseline.
  for (const cell of cells)
    if (cell.kind === "unknown") assert.ok(cell.reason);
    else {
      assert.ok(cell.source);
      assert.ok(cell.observedAsOf);
    }
  assert.equal(
    matrix.rows.length,
    slots.slots.reduce((count, slot) => count + slot.candidates.length, 0),
  );
  // The six-argument public builder is deterministic and does not load a price/history file.
  const unknown = {
    kind: "unknown" as const,
    usd: null,
    unitPrice: null,
    unit: null,
    asOf: null,
    evidenceKind: "none",
    basis: null,
    label: "fixture missing tariff",
  };
  assert.deepEqual(
    buildPriceMatrix(slots, {}, () => unknown, new Map(), new Map(), now),
    buildPriceMatrix(slots, {}, () => unknown, new Map(), new Map(), now),
  );
});
test("refresh packaging, apply regex and bot route cover every generated matrix data path", () => {
  const workflow = readFileSync(path.resolve(import.meta.dirname, "../.github/workflows/models-refresh.yml"), "utf8");
  assert.match(workflow, /paths='src\/lib\/models /);
  assert.ok(workflow.includes("src/lib/models/[A-Za-z0-9._/-]+\\.json"));
  assert.ok(workflow.includes("out/qa/model-prices/price-gaps.md"));
  assert.equal(workflow.includes("--include='docs/verification/"), false);
  assert.match(PRICE_GAPS_FILE.replaceAll("\\", "/"), /\/out\/qa\/model-prices\/price-gaps\.md$/);
  for (const name of [
    "price-matrix-catalog/fal-text-to-image.json",
    "price-matrix.json",
    "price-scenarios.json",
    "fal-historical-prices.json",
  ])
    assert.match(`src/lib/models/${name}`, /^src\/lib\/models\/[A-Za-z0-9._/-]+\.json$/);
});
