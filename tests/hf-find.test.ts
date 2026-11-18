import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultFindProvider, findFalEndpoints, loadModelCuration } from "../src/lib/models/fal-find";
import { FalFindCandidateSchema, providerOf } from "../src/types/fal-catalog";
import { hfChoiceCatalog, choiceNow, tierPrice, floorPrice } from "./helpers/hf-choice-fixtures";
import { loadProviderCatalog, writeCatalog, resetCatalogCache } from "../src/lib/models/fal-catalog";
import { resetFalPricesCache } from "../src/lib/models/fal-pricing";
import { scaffoldFalEndpoint } from "../src/lib/models/fal-scaffold";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";

useTempFalCatalog([]);
const hf = hfChoiceCatalog(),
  now = choiceNow;
const options = { catalog: hf, now, env: {}, hfPrices: new Map() };
const motion = "higgsfield/genjutsu/motion-transfer/v1.0";
const swap = "higgsfield/genjutsu/object-swap/v1.0";
const golden: [string, string][] = [
  ["вставить героя в клип, вертикально, дёшево", swap],
  ["заменить человека в видео", swap],
  ["put my character into this movie clip, vertical, cheap", swap],
  ["character swap", swap],
  ["motion transfer", motion],
  ["restyle a video", "higgsfield/genjutsu/restyle/v1.0"],
  ["стилизовать видео", "higgsfield/genjutsu/restyle/v1.0"],
  ["swap an object", "higgsfield/genjutsu/object-swap/v1.0"],
  ["заменить предмет в видео", "higgsfield/genjutsu/object-swap/v1.0"],
  ["make a fashion influencer photo", "higgsfield-ai/soul/v2/standard"],
  ["AI influencer photo", "higgsfield-ai/soul/v2/standard"],
  ["фото персонажа", "higgsfield-ai/soul/v2/standard"],
  ["ad creative", "higgsfield/ads-studio/v1.0"],
  ["product shot", "higgsfield/ads-studio/v1.0"],
  ["marketing image", "higgsfield/ads-studio/v1.0"],
  ["рекламный креатив", "higgsfield/ads-studio/v1.0"],
  ["cinematic multi-shot", "higgsfield/cinema-studio/4.0"],
  ["кинематографическое многокадровое видео", "higgsfield/cinema-studio/4.0"],
];
for (const [task, expected] of golden)
  test(`Higgsfield golden: ${task}`, () => {
    const rows = findFalEndpoints({ provider: "any", task }, options);
    assert.equal(rows[0]?.endpoint, expected);
    for (const row of rows) {
      FalFindCandidateSchema.parse(row);
      assert.equal(row.provider, "higgsfield");
      assert.ok(row.nextCommands.some((command) => command.includes("--provider higgsfield")));
    }
  });

test("default provider depends only on injected key presence", () => {
  assert.equal(defaultFindProvider({}), "fal");
  assert.equal(defaultFindProvider({ HIGGSFIELD_API_KEY: "" }), "fal");
  assert.equal(defaultFindProvider({ HIGGSFIELD_API_KEY: "present" }), "any");
  assert.equal(findFalEndpoints({ task: "character swap" }, options).length, 0);
  assert.equal(
    findFalEndpoints({ task: "character swap" }, { ...options, env: { HIGGSFIELD_API_KEY: "present" } })[0]?.provider,
    "higgsfield",
  );
});
test("floors and unknowns never admit max-usd or outrank exact prices as cheap", () => {
  const base = hf.get("bytedance/seedance-2.5/text-to-video")!;
  const exact = { ...base, endpoint: "test/exact", family: undefined, releasedOn: undefined };
  const floor = { ...exact, endpoint: "test/floor" },
    unknown = { ...exact, endpoint: "test/unknown" };
  const catalog = new Map([floor, unknown, exact].map((entry) => [entry.endpoint, entry]));
  const hfPrices = new Map([
    [exact.endpoint, tierPrice(exact.endpoint)],
    [floor.endpoint, floorPrice(floor.endpoint)],
  ]);
  const found = findFalEndpoints({ provider: "any", durationSec: 5, resolution: "720p" }, { catalog, hfPrices, now });
  assert.equal(found[0]?.endpoint, exact.endpoint);
  assert.equal(found[0]?.price.usd, 0.5);
  assert.equal(found.find((row) => row.endpoint === floor.endpoint)?.price.label, "from $0.001 (floor)");
  assert.equal(found.find((row) => row.endpoint === unknown.endpoint)?.price.usd, null);
  assert.deepEqual(
    findFalEndpoints(
      { provider: "any", durationSec: 5, resolution: "720p", maxUsd: 0.6 },
      { catalog, hfPrices, now },
    ).map((row) => row.endpoint),
    [exact.endpoint],
  );
});
test("recency ranks within family, fal firstSeen is not a release date, exclusivity needs curation", () => {
  const base = hf.get("higgsfield-ai/soul/v2/standard")!;
  const old = { ...base, endpoint: "test/old", releasedOn: "2025-01-01" },
    newer = { ...base, endpoint: "test/new", releasedOn: "2026-01-01" };
  const find = (entries: (typeof base)[]) =>
    findFalEndpoints(
      { provider: "any" },
      { ...options, catalog: new Map(entries.map((entry, i) => [String(i), entry])) },
    );
  assert.equal(find([old, newer])[0]?.endpoint, newer.endpoint);
  assert.deepEqual(find([newer, old]), find([old, newer]));
  const fal = {
    ...newer,
    provider: "fal" as const,
    endpoint: "test/fal",
    releasedOn: undefined,
    firstSeen: "2026-11-15",
  };
  assert.equal(find([fal])[0]?.releasedOn, null);
  assert.equal(find([{ ...old, exclusive: true }])[0]?.score, find([{ ...old, exclusive: false }])[0]?.score);
});
test("provider keys preserve collisions and equivalents show both prices and schema warning", () => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-find-price-"));
  const previous = process.env.AGENTBROS_FAL_PRICES;
  try {
    const entry = hf.get("bytedance/seedance-2.5/text-to-video")!;
    const endpoint = "test/equivalent";
    // An unregistered endpoint exercises the dated Platform API tariff, without registry overrides.
    const f = { ...entry, endpoint, provider: "fal" as const },
      h = { ...entry, endpoint };
    const file = path.join(root, "prices.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        syncedAt: null,
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
    process.env.AGENTBROS_FAL_PRICES = file;
    resetFalPricesCache();
    // quote() resolves the category from the temporary index.
    writeCatalog([f], process.env.AGENTBROS_FAL_CATALOG_DIR!);
    resetCatalogCache();
    const rows = findFalEndpoints(
      { provider: "any", resolution: "720p", durationSec: 5 },
      {
        ...options,
        catalog: new Map([
          ["fal", f],
          ["hf", h],
        ]),
        hfPrices: new Map([[endpoint, tierPrice(endpoint)]]),
      },
    );
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.provider)), new Set(["fal", "higgsfield"]));
    assert.equal(rows[0]?.equivalents?.cheaper, "higgsfield");
    assert.equal(rows[0]?.equivalents?.members.length, 2);
    assert.match(rows[0]!.equivalents!.note, /Schemas differ/);
    const changed = {
      ...h,
      inputs: h.inputs.map((field) => (field.name === "generate_audio" ? { ...field, default: false } : field)),
    };
    const mismatched = findFalEndpoints(
      { provider: "any", resolution: "720p", durationSec: 5 },
      {
        ...options,
        catalog: new Map([
          ["fal", f],
          ["hf", changed],
        ]),
        hfPrices: new Map([[endpoint, tierPrice(endpoint)]]),
      },
    );
    assert.equal(mismatched[0]?.equivalents?.savingUsd, null);
  } finally {
    if (previous === undefined) delete process.env.AGENTBROS_FAL_PRICES;
    else process.env.AGENTBROS_FAL_PRICES = previous;
    resetFalPricesCache();
    rmSync(root, { recursive: true, force: true });
  }
});

test("curation is tuple-keyed, dated, catalogue-grounded and covers requested roles", () => {
  const curation = loadModelCuration();
  for (const row of [...curation.values()].filter((row) => providerOf(row) === "higgsfield")) {
    assert.equal(hf.get(row.endpoint)?.category, row.category);
    assert.equal(row.reviewedAt, "2026-11-15");
    assert.ok(row.source);
    assert.ok(row.notes);
  }
  const endpoint = "bytedance/seedance-2.5/reference-to-video";
  assert.ok(curation.has(`fal:${endpoint}`));
  assert.ok(curation.has(`higgsfield:${endpoint}`));
  assert.match(
    curation.get("higgsfield:higgsfield/genjutsu-light/motion-transfer/v1.0")!.notes,
    /Catalogue-only.*no schema.*discovered.*estimate/,
  );
});
test("catalogue-only Light is opt-in and never scaffolded with a sibling schema", () => {
  const entry = hf.get("higgsfield/genjutsu-light/motion-transfer/v1.0")!;
  const catalog = new Map([[entry.endpoint, entry]]);
  assert.equal(
    findFalEndpoints({ provider: "higgsfield", task: "motion transfer" }, { ...options, catalog }).length,
    0,
  );
  const found = findFalEndpoints(
    { provider: "higgsfield", task: "motion transfer", includeSchemaless: true },
    { ...options, catalog },
  );
  assert.match(found[0]!.warnings.join(" "), /no schema/);
  assert.match(
    scaffoldFalEndpoint(entry.endpoint, { provider: "higgsfield" }).nextAction!,
    /hf:quote.*provider-estimate/,
  );
});
test("Higgsfield scaffold writes provider identity and the provider-specific schema", () => {
  const endpoint = "bytedance/seedance-2.5/reference-to-video";
  const scaffold = scaffoldFalEndpoint(endpoint, { provider: "higgsfield" });
  assert.equal(scaffold.request.provider, "higgsfield");
  assert.equal(scaffold.hints.duration?.type, "integer");
  assert.ok(loadProviderCatalog("higgsfield").has(endpoint));
});
