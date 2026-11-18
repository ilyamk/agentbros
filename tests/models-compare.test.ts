import "./helpers/fal-no-network";
import test from "node:test";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { compareModels, MODEL_EQUIVALENTS } from "../src/lib/models/models-compare";
import { loadProviderCatalog, writeCatalog, resetCatalogCache } from "../src/lib/models/fal-catalog";
import { higgsfieldPricesFromFixtures } from "../src/lib/models/hf-pricing";
import { resetFalPricesCache } from "../src/lib/models/fal-pricing";
import { hfChoiceCatalog, choiceNow, tierPrice, floorPrice } from "./helpers/hf-choice-fixtures";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";

const temp = useTempFalCatalog([]),
  hf = hfChoiceCatalog();
const endpoint = "test/identical",
  base = hf.get("bytedance/seedance-2.5/text-to-video")!;
const f = { ...base, endpoint, provider: "fal" as const },
  h = { ...base, endpoint };
writeCatalog([f], temp.catalogDir);
resetCatalogCache();
const priceFile = path.join(temp.catalogDir, "..", "prices.json");
writeFileSync(
  priceFile,
  JSON.stringify({
    version: 1,
    syncedAt: "2026-11-15",
    prices: [
      {
        endpoint,
        unitPrice: 0.2,
        unit: "seconds",
        currency: "USD",
        observedAsOf: "2026-11-15",
        source: "platform-pricing-api",
      },
    ],
  }),
);
process.env.AGENTBROS_FAL_PRICES = priceFile;
resetFalPricesCache();
const options = {
  fal: new Map([[endpoint, f]]),
  higgsfield: new Map([[endpoint, h]]),
  hfPrices: new Map([[endpoint, tierPrice(endpoint)]]),
  now: choiceNow,
};
const parameters = { resolution: "720p", durationSec: 5 };

test("identical IDs compare exact per-unit and per-request prices with dated evidence", () => {
  const row = compareModels(parameters, options)[0]!;
  assert.equal(row.match, "identical-id");
  assert.equal(row.cheaper, "higgsfield");
  assert.equal(row.savingUsd, 0.5);
  assert.equal(row.savingPercent, 50);
  assert.deepEqual(
    row.members.map((member) => member.price.usd),
    [1, 0.5],
  );
  assert.deepEqual(
    row.members.map((member) => member.price.unitPrice),
    [0.2, 0.1],
  );
  assert.ok(row.members.every((member) => member.price.asOf === "2026-11-15" && member.price.evidenceKind));
  assert.match(row.note, /Schemas differ.*scaffold/);
});
test("floors and unknowns are retained without savings", () => {
  for (const hfPrices of [new Map([[endpoint, floorPrice(endpoint)]]), new Map()]) {
    const row = compareModels(parameters, { ...options, hfPrices })[0]!;
    assert.equal(row.savingUsd, null);
    assert.equal(row.savingPercent, null);
    assert.equal(row.cheaper, null);
  }
});
test("missing and unsupported parameters never produce savings", () => {
  for (const q of [
    {},
    { durationSec: 5 },
    { resolution: "4k", durationSec: 5 },
    { resolution: "720p", durationSec: 99 },
  ])
    assert.equal(compareModels(q, options)[0]?.savingUsd, null);
});
test("category and exact endpoint filters, no fuzzy equivalents", () => {
  assert.equal(compareModels({ ...parameters, category: "text-to-image" }, options).length, 0);
  assert.equal(compareModels({ ...parameters, endpoint }, options).length, 1);
  assert.equal(compareModels({ ...parameters, endpoint: "test" }, options).length, 0);
  const different = { ...h, endpoint: "test/similar" };
  assert.equal(
    compareModels(parameters, { ...options, higgsfield: new Map([[different.endpoint, different]]) }).length,
    0,
  );
});
test("every explicit cross-ID pair matches catalogue family, workflow and documented tier", () => {
  const fal = loadProviderCatalog("fal", path.resolve("src/lib/models/fal-catalog"));
  assert.equal(MODEL_EQUIVALENTS.length, 4);
  for (const pair of MODEL_EQUIVALENTS) {
    const a = fal.get(pair.fal),
      b = hf.get(pair.higgsfield);
    assert.ok(a && b, pair.family);
    assert.equal(a.category, b.category);
    assert.equal(pair.fal.split("/").at(-1), pair.higgsfield.split("/").at(-1));
    assert.equal(b.docsUrl, pair.source);
    assert.ok(pair.fal.includes("/pro/") === pair.higgsfield.includes("/pro/"));
  }
});
test("tie marks neither provider cheaper and differing audio defaults block savings", () => {
  const tied = compareModels(parameters, { ...options, hfPrices: new Map([[endpoint, tierPrice(endpoint, 0.2)]]) })[0]!;
  assert.equal(tied.cheaper, null);
  assert.equal(tied.savingUsd, 0);
  const altered = {
    ...h,
    inputs: h.inputs.map((field) => (field.name === "generate_audio" ? { ...field, default: false } : field)),
  };
  assert.equal(
    compareModels(parameters, { ...options, higgsfield: new Map([[endpoint, altered]]) })[0]?.savingUsd,
    null,
  );
});
test("offline comparison CLI returns one JSON envelope", () => {
  const root = mkdtempSync(path.join(tmpdir(), "model-compare-cli-"));
  try {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/models-compare.ts", "--endpoint", "missing/endpoint"],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        env: { ...process.env, HIGGSFIELD_API_KEY: "", FAL_KEY: "" },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.offline, true);
    assert.deepEqual(result.metadata.comparisons, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit Kling text pairs use evidenced fixed resolution and can compare exact request prices", () => {
  const fal = loadProviderCatalog("fal", path.resolve("src/lib/models/fal-catalog"));
  const endpoint = "kling-video/v3.0/std/text-to-video";
  const records = higgsfieldPricesFromFixtures(
    JSON.parse(readFileSync("tests/fixtures/higgsfield/estimates.json", "utf8")),
    JSON.parse(readFileSync("tests/fixtures/higgsfield/catalog-models.json", "utf8")),
  ).records;
  const rows = compareModels(
    { endpoint, resolution: "720p", durationSec: 5 },
    { fal, higgsfield: hf, hfPrices: new Map(records.map((row) => [row.endpoint, row])), now: choiceNow },
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.match, "explicit-table");
  assert.ok(rows[0]!.members.every((member) => member.price.usd !== null));
  assert.equal(rows[0]?.cheaper, "higgsfield");
  assert.ok(rows[0]!.savingUsd! > 0);
  const wrong = compareModels(
    { endpoint, resolution: "1080p", durationSec: 5 },
    { fal, higgsfield: hf, hfPrices: new Map([[endpoint, tierPrice(endpoint, 0.0714)]]), now: choiceNow },
  );
  assert.equal(wrong[0]?.savingUsd, null);
});
