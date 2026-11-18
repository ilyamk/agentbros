import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { estimateFalUnitPrice, loadFalUnitSemantics, parseFalPricingSection } from "../src/lib/models/fal-docs-pricing";
import {
  comparePrices,
  pageContradictsApiRate,
  pricingContext,
  pricingFromRecord,
  resetFalPricesCache,
  serialiseFalPrices,
} from "../src/lib/models/fal-pricing";
import { catalogEntry } from "./helpers/fal-temp-catalog";
import { resetCatalogCache, writeCatalog } from "../src/lib/models/fal-catalog";
import { FalCatalogEntrySchema, type FalCatalogEntry, type FalPriceRecord } from "../src/types/fal-catalog";
import { modelChoicePrice } from "../src/lib/models/model-choice-price";
import { quote } from "../src/lib/pricing";
import { planningOnlyFalPricing } from "../src/lib/models/pricing-evidence";
import { executeFalOperation } from "../src/lib/jobs/execution";

const date = "2026-11-16";
const fixture = (name: string) => readFileSync(`tests/fixtures/fal-docs-pricing/${name}.txt`, "utf8");
const row = (name: string, endpoint = `test/${name}`) => parseFalPricingSection(fixture(name), endpoint, date)!;
const api = (endpoint: string, unit: string, unitPrice: number): FalPriceRecord => ({
  endpoint,
  unit,
  unitPrice,
  observedAsOf: date,
  currency: "USD",
  source: "platform-pricing-api",
});
const entry = (
  name: string,
  category: FalCatalogEntry["category"] = "video-to-video",
  inputs: FalCatalogEntry["inputs"] = [],
): FalCatalogEntry =>
  FalCatalogEntrySchema.parse({
    endpoint: `test/${name}`,
    category,
    displayName: name,
    status: "active",
    firstSeen: date,
    lastSeen: date,
    schema: null,
    inputs,
    outputs: { kinds: ["video"], fields: ["video"] },
    transport: "queue",
    price: null,
    tier: "discovered",
  });
const context = pricingContext(entry("example"));
const dir = mkdtempSync(path.join(tmpdir(), "fal-unit-price-"));
process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
const cases = [
  { name: "kling-o3-edit", unit: "seconds", rate: 0.14, entry: entry("kling-o3-edit") },
  { name: "seedvr-video", unit: "megapixels", rate: 0.001, entry: entry("seedvr-video") },
  {
    name: "frames",
    unit: "30 frames",
    rate: 0.02,
    entry: entry("frames", "video-to-video", [
      { name: "frames_per_second", type: "number", required: false, default: 30 },
    ]),
  },
  { name: "input-video", unit: "seconds", rate: 0.1, entry: entry("input-video") },
  { name: "image", unit: "units", rate: 0.04, entry: entry("image", "text-to-image") },
  { name: "image-mp", unit: "megapixels", rate: 0.03, entry: entry("image-mp", "text-to-image") },
  { name: "request", unit: "units", rate: 0.1, entry: entry("request", "unknown") },
  { name: "characters", unit: "1000 characters", rate: 0.05, entry: entry("characters", "text-to-speech") },
  { name: "sync-lipsync-v3", unit: "minutes", rate: 8, entry: entry("sync-lipsync-v3") },
  { name: "output-audio", unit: "seconds", rate: 0.02, entry: entry("output-audio", "text-to-audio") },
  { name: "resolution", unit: "seconds", rate: 0.05, entry: entry("resolution") },
  { name: "audio", unit: "seconds", rate: 0.05, entry: entry("audio") },
  { name: "ambiguous", unit: "units", rate: 0.1, entry: entry("ambiguous") },
  // FLUX-3 first-last-frame draft: the page bills $0.06/s at its only resolution, the API says $0.03; no resolution input.
  {
    name: "flux-3-draft",
    unit: "seconds",
    rate: 0.03,
    entry: entry("flux-3-draft", "image-to-video", [
      { name: "prompt", type: "string", required: true },
      { name: "duration", type: "integer", required: false, default: 5 },
    ]),
  },
];
writeCatalog(
  cases.map((item) => item.entry),
  path.join(dir, "catalogue"),
  { syncedAt: date },
);
writeFileSync(
  path.join(dir, "prices.json"),
  serialiseFalPrices(
    cases.map((item) => api(item.entry.endpoint, item.unit, item.rate)),
    date,
  ),
);
writeFileSync(
  path.join(dir, "semantics.json"),
  JSON.stringify({ version: 1, syncedAt: date, records: cases.map((item) => row(item.name)) }),
);
process.env.AGENTBROS_FAL_CATALOG_DIR = path.join(dir, "catalogue");
process.env.AGENTBROS_FAL_PRICES = path.join(dir, "prices.json");
process.env.AGENTBROS_FAL_UNIT_SEMANTICS = path.join(dir, "semantics.json");
resetCatalogCache();
resetFalPricesCache();

test("every evidenced meaning maps to the intended fixed or derived quantity; absent semantics preserves the old gate", () => {
  assert.equal(loadFalUnitSemantics().size, cases.length);
  for (const item of cases) {
    const definition = pricingFromRecord(
      api(item.entry.endpoint, item.unit, item.rate),
      pricingContext(item.entry),
      row(item.name),
    );
    // An ambiguous page adds nothing: the API unit table decides, exactly as without page semantics.
    if (item.name === "ambiguous") {
      assert.deepEqual(
        definition,
        pricingFromRecord(api(item.entry.endpoint, item.unit, item.rate), pricingContext(item.entry)),
        item.name,
      );
      continue;
    }
    assert.equal(
      definition.kind,
      ["seedvr-video", "frames"].includes(item.name)
        ? "fal-derived"
        : item.name === "image-mp"
          ? "megapixels"
          : "fixed",
      item.name,
    );
  }
  assert.equal(pricingFromRecord(api("test/image", "units", 0.04), context).kind, "unknown");
  assert.equal(pricingFromRecord(api("test/image", "compute seconds", 0.04), context, row("image")).kind, "unknown");
  assert.equal(pricingFromRecord(api("test/image", "images", 0), context, row("image")).kind, "unknown");
  // Realtime transport ignores page semantics and keeps the API unit table's own verdict.
  assert.deepEqual(
    pricingFromRecord(api("test/image", "images", 0.04), { ...context, transport: "realtime" }, row("image")),
    pricingFromRecord(api("test/image", "images", 0.04), { ...context, transport: "realtime" }),
  );
  assert.equal(pricingFromRecord(api("test/frames", "60 frames", 0.04), context, row("frames")).kind, "unknown");
  assert.equal(pricingFromRecord(api("test/other", "units", 0.04), context, row("image")).kind, "unknown");
});

test("quotes use the evidenced quantities for images, MP, frames, characters, input/output audio and request", () => {
  const examples = [
    { model: "test/image", units: 3, expected: 0.12 },
    { model: "test/image-mp", width: 2000, height: 1000, expected: 0.06 },
    { model: "test/request", durationSec: 50, expected: 0.1 },
    { model: "test/characters", inputCharacters: 1500, expected: 0.1 },
    { model: "test/sync-lipsync-v3", inputAudioSec: 90, expected: 12 },
    { model: "test/output-audio", durationSec: 5, expected: 0.1 },
    { model: "test/frames", durationSec: 10, expected: 0.2 },
  ];
  for (const example of examples) {
    const result = quote(example);
    assert.equal(result.highUsd, example.expected, example.model);
    assert.match(result.notes!, /llms\.txt/);
    assert.match(result.notes!, /observed 2026-11-16/);
  }
  assert.equal(quote({ model: "test/ambiguous" }).bounded, false);
  assert.equal(quote({ model: "test/output-audio" }).bounded, false);
  assert.equal(quote({ model: "test/sync-lipsync-v3" }).bounded, false);
  assert.equal(quote({ model: "test/frames", durationSec: 10 }).approximate, true);
  assert.match(quote({ model: "test/frames", durationSec: 10 }).notes!, /30 fps.*schema default fps/);
});

test("input video seconds are measured separately from generated duration; missing input stays unknown", () => {
  const price = quote({ model: "test/input-video", durationSec: 99, inputVideoDurationSec: 5 });
  assert.equal(price.highUsd, 0.5);
  assert.match(price.notes!, /5 input video seconds/);
  assert.equal(quote({ model: "test/input-video", durationSec: 5 }).bounded, false);
  assert.equal(modelChoicePrice(entry("input-video"), { inputVideoDurationSec: 5, durationSec: 99 }).usd, 0.5);
});

test("video MP uses frame count and scenario dimensions, with explicit fps assumptions and approximate evidence", () => {
  const parameters = { durationSec: 10, resolution: "1080p", aspect: "16:9" };
  const choice = modelChoicePrice(entry("seedvr-video"), parameters);
  assert.equal(choice.kind, "approximate");
  assert.equal(choice.usd, 0.4977);
  assert.match(choice.label, /1920 × 1080.*24 fps × 10 seconds.*assumed 24 fps.*1e6/);
  assert.match(choice.label, /width × height × frames/);
  const result = quote({ model: "test/seedvr-video", durationSec: 10, width: 1920, height: 1080 });
  assert.equal(result.highUsd, 0.4977);
  assert.equal(result.approximate, true);
  assert.equal(quote({ model: "test/seedvr-video", durationSec: 10 }).bounded, false);
  assert.equal(modelChoicePrice(entry("seedvr-video"), { durationSec: 10 }).kind, "unknown");
  const portrait = modelChoicePrice(entry("seedvr-video"), { ...parameters, aspect: "9:16" });
  assert.equal(portrait.usd, choice.usd);
});

test("resolution and audio tiers match explicitly; drift plans at the higher rate, marks approximate and reports both", () => {
  assert.equal(quote({ model: "test/resolution", durationSec: 10, resolution: "1080p" }).highUsd, 1);
  assert.equal(quote({ model: "test/resolution", durationSec: 10 }).bounded, false);
  assert.equal(quote({ model: "test/audio", durationSec: 10, generateAudio: true }).highUsd, 0.7);
  assert.equal(quote({ model: "test/audio", durationSec: 10, generateAudio: false }).highUsd, 0.5);
  assert.equal(quote({ model: "test/audio", durationSec: 10 }).bounded, false);
  const drift = quote({ model: "test/kling-o3-edit", durationSec: 5 });
  // Page $0.168/s above the API's $0.14/s: planning uses the higher rate (2026-11-17; formerly the API rate).
  assert.equal(drift.highUsd, 0.84);
  assert.equal(drift.approximate, true);
  assert.match(drift.notes!, /page \$0\.168, API \$0\.14; higher rate used for planning/);
  assert.deepEqual(drift.priceDrift, { pageUsdPerUnit: 0.168, apiUsdPerUnit: 0.14, used: 0.168 });
  assert.equal(modelChoicePrice(entry("kling-o3-edit"), { durationSec: 5 }).kind, "approximate");
  assert.equal(
    comparePrices(
      {},
      [api("test/kling-o3-edit", "seconds", 0.14)],
      new Map([["test/kling-o3-edit", row("kling-o3-edit")]]),
    ).length,
    1,
  );
  const formula = estimateFalUnitPrice(row("frames"), 0.02, { durationSec: 10 });
  assert.ok("formula" in formula);
  assert.match(formula.formula, /assumed 24 fps/);
  assert.equal(formula.usd, 0.16);
});

test("registry uses fixture API prices for all five verified operations without a public tariff", () => {
  const endpoints = [
    "fal-ai/kling-video/v3/pro/motion-control",
    "fal-ai/kling-video/v3/standard/motion-control",
    "fal-ai/kling-video/o3/pro/video-to-video/edit",
    "fal-ai/kling-video/o3/standard/video-to-video/edit",
    "fal-ai/flux-2/flash/edit",
  ];
  const catalogue = path.join(dir, "registry-catalogue"),
    prices = path.join(dir, "registry-prices.json"),
    semantics = path.join(dir, "registry-semantics.json");
  writeCatalog(
    endpoints.map((endpoint) => ({
      ...entry("registry"),
      endpoint,
      category: endpoint.includes("flux") ? "image-to-image" : "video-to-video",
    })),
    catalogue,
    { syncedAt: date },
  );
  writeFileSync(
    prices,
    serialiseFalPrices(
      endpoints.map((endpoint) => api(endpoint, endpoint.includes("flux") ? "units" : "seconds", 0.1)),
      date,
    ),
  );
  writeFileSync(
    semantics,
    JSON.stringify({
      version: 1,
      syncedAt: date,
      records: endpoints.map((endpoint) =>
        endpoint.includes("flux") ? row("image", endpoint) : row("input-video", endpoint),
      ),
    }),
  );
  const code = `import assert from 'node:assert/strict'; import { findModel } from './src/lib/models/registry.ts'; import { quote } from './src/lib/pricing.ts'; for (const endpoint of ${JSON.stringify(endpoints)}) { assert.equal(findModel(endpoint).pricing.kind, 'fixed', endpoint); assert.equal(quote({model:endpoint,inputVideoDurationSec:5}).highUsd, endpoint.includes('flux') ? .1 : .5); }`;
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTBROS_FAL_CATALOG_DIR: catalogue,
      AGENTBROS_FAL_PRICES: prices,
      AGENTBROS_FAL_UNIT_SEMANTICS: semantics,
    },
  });
  assert.equal(child.status, 0, child.stderr);
  // Empty semantics preserves API unit gates while the new registry fallback retains API provenance.
  writeFileSync(
    prices,
    serialiseFalPrices(
      endpoints.map((endpoint) => api(endpoint, endpoint.includes("flux") ? "megapixels" : "seconds", 0.1)),
      date,
    ),
  );
  writeFileSync(semantics, JSON.stringify({ version: 1, syncedAt: null, records: [] }));
  const rawCode = `import assert from 'node:assert/strict'; import { findModel } from './src/lib/models/registry.ts'; import { quote } from './src/lib/pricing.ts'; import { findCatalogEntry } from './src/lib/models/fal-catalog.ts'; import { modelChoicePrice } from './src/lib/models/model-choice-price.ts'; for (const endpoint of ${JSON.stringify(endpoints)}) { const result=quote({model:endpoint,...(endpoint.includes('flux') ? {units:1} : {durationSec:5}),width:1000,height:1000}); assert.equal(result.highUsd,endpoint.includes('flux') ? .1 : .5); assert.match(result.source,/api.fal.ai/); assert.equal(result.asOf,'2026-11-16'); assert.match(findModel(endpoint).source,/api.fal.ai/); const choice=modelChoicePrice(findCatalogEntry(endpoint),{durationSec:5,megapixels:1}); assert.equal(choice.evidenceKind,'platform-pricing-api'); assert.equal(choice.asOf,'2026-11-16'); }`;
  const rawChild = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", rawCode], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTBROS_FAL_CATALOG_DIR: catalogue,
      AGENTBROS_FAL_PRICES: prices,
      AGENTBROS_FAL_UNIT_SEMANTICS: semantics,
    },
  });
  assert.equal(rawChild.status, 0, rawChild.stderr);
  // Paid admission: API-fallback registry prices and page-derived units are planning-only and never sealed.
  writeFileSync(
    prices,
    serialiseFalPrices(
      endpoints.map((endpoint) => api(endpoint, endpoint.includes("flux") ? "units" : "seconds", 0.1)),
      date,
    ),
  );
  writeFileSync(
    semantics,
    JSON.stringify({
      version: 1,
      syncedAt: date,
      records: endpoints.map((endpoint) =>
        endpoint.includes("flux") ? row("image", endpoint) : row("input-video", endpoint),
      ),
    }),
  );
  const paidCode = `import assert from 'node:assert/strict'; import { planningOnlyFalPricing, createPlatformPricingEvidence, createPublicListPricingEvidence } from './src/lib/models/pricing-evidence.ts'; for (const endpoint of ${JSON.stringify(endpoints)}) { assert.equal(planningOnlyFalPricing(endpoint), true, endpoint); assert.equal(createPlatformPricingEvidence(endpoint), undefined, endpoint); assert.equal(createPublicListPricingEvidence(endpoint), undefined, endpoint); } assert.equal(planningOnlyFalPricing('openai/gpt-image-2.5/flare/text-to-image'), false);`;
  const paidChild = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", paidCode], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTBROS_FAL_CATALOG_DIR: catalogue,
      AGENTBROS_FAL_PRICES: prices,
      AGENTBROS_FAL_UNIT_SEMANTICS: semantics,
    },
  });
  assert.equal(paidChild.status, 0, paidChild.stderr);
});

test("docs CLI emits one JSON line without a key, using an empty --changed scope and no network", () => {
  const priceFile = path.join(dir, "cli-prices.json"),
    semanticsFile = path.join(dir, "cli-semantics.json");
  writeFileSync(priceFile, serialiseFalPrices([api("test/image", "units", 0.04)], date));
  writeFileSync(
    semanticsFile,
    JSON.stringify({
      version: 1,
      syncedAt: date,
      records: [{ ...row("image"), apiSnapshot: { unit: "units", unitPrice: 0.04 } }],
    }),
  );
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/fal-pricing.ts",
      "--docs",
      "--endpoints",
      "test/image",
      "--changed",
      "--dry-run",
      "--as-of",
      date,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        FAL_KEY: "",
        AGENTBROS_FAL_PRICES: priceFile,
        AGENTBROS_FAL_UNIT_SEMANTICS: semanticsFile,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.mode, "docs");
  assert.equal(result.metadata.requests, 0);
});

test("docs CLI resumes a positive offline scope, writes semantics and reports page/API drift", () => {
  const priceFile = path.join(dir, "cli-positive-prices.json"),
    semanticsFile = path.join(dir, "cli-positive-semantics.json");
  const semantic = { ...row("kling-o3-edit"), apiSnapshot: { unit: "seconds", unitPrice: 0.14 } };
  writeFileSync(priceFile, serialiseFalPrices([api(semantic.endpoint, "seconds", 0.14)], date));
  writeFileSync(semanticsFile, JSON.stringify({ version: 1, syncedAt: null, records: [] }));
  const checkpoint = path.join(dir, ".cache/fal-docs-pricing", `${date}.jsonl`);
  mkdirSync(path.dirname(checkpoint), { recursive: true });
  writeFileSync(checkpoint, `${JSON.stringify({ date, endpoint: semantic.endpoint, record: semantic })}\n`);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.resolve("node_modules/tsx/dist/loader.mjs"),
      "--import",
      path.resolve("tests/helpers/fal-no-network.ts"),
      path.resolve("scripts/fal-pricing.ts"),
      "--docs",
      "--endpoints",
      semantic.endpoint,
      "--resume",
      "--as-of",
      date,
    ],
    {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        FAL_KEY: "",
        AGENTBROS_FAL_PRICES: priceFile,
        AGENTBROS_FAL_UNIT_SEMANTICS: semanticsFile,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.metadata.requests, 0);
  assert.equal(result.metadata.priceDrift.length, 1);
  assert.equal(loadFalUnitSemantics(semanticsFile).get(semantic.endpoint)!.unitPrice, 0.168);
});

test("incompatible page evidence cannot be bypassed by legacy discovery conversions; an ambiguous page leaves them as before", () => {
  const file = process.env.AGENTBROS_FAL_UNIT_SEMANTICS!,
    original = readFileSync(file, "utf8");
  try {
    const parsed = JSON.parse(original);
    parsed.records = parsed.records.map((record: { endpoint: string }) =>
      record.endpoint === "test/characters"
        ? row("ambiguous", record.endpoint)
        : record.endpoint === "test/sync-lipsync-v3"
          ? row("image", record.endpoint)
          : record,
    );
    writeFileSync(file, JSON.stringify(parsed));
    // Ambiguous page: same as no page at all (paid admission unchanged; discovery may still convert).
    const withPage = quote({ model: "test/characters", inputCharacters: 1000 });
    writeFileSync(
      file,
      JSON.stringify({
        ...parsed,
        records: parsed.records.filter((record: { endpoint: string }) => record.endpoint !== "test/characters"),
      }),
    );
    // The ambiguous fixture quote states a tariff without the API unit price, so it now refuses the API unit; otherwise it would equal no page.
    assert.equal(withPage.bounded, false);
    assert.equal(quote({ model: "test/characters", inputCharacters: 1000 }).bounded, true);
    writeFileSync(file, JSON.stringify(parsed));
    assert.equal(
      modelChoicePrice(
        entry("sync-lipsync-v3", "speech-to-text", [
          { name: "audio_url", type: "string", required: true, media: "audio" },
        ]),
        { inputAudioSec: 60 },
      ).kind,
      "unknown",
    );
  } finally {
    writeFileSync(file, original);
  }
});

test("page scenario tariffs select resolution x audio, base + extras and exact clip durations", () => {
  const parse = (text: string) => parseFalPricingSection(`## Pricing\n${text}`, "test/scenario", date)!;
  const grid = parse(
    "Billing is calculated per second of video generated. Rates without audio / with audio are 720p: $0.050 / $0.065; 1080p: $0.095 / $0.120.",
  );
  const estimate = (semantics: typeof grid, durationSec: number, resolution?: string, generateAudio?: boolean) =>
    estimateFalUnitPrice(semantics, 0.05, { durationSec, resolution, generateAudio });
  assert.deepEqual(estimate(grid, 10, "480p", false), { reason: "no page tariff for 480p" });
  const on = estimate(grid, 10, "1080p", true),
    off = estimate(grid, 10, "720p", false);
  assert.ok("usd" in on && "usd" in off);
  assert.equal(on.usd, 1.2);
  assert.equal(on.approximate, true);
  assert.equal(off.usd, 0.5);
  assert.equal(off.approximate, false);
  assert.match(on.formula, /1080p, audio on/);
  const base = parse(
    "For 5s video your request will cost $0.35. For every additional second you will be charged $0.07.",
  );
  assert.ok("reason" in estimate(base, 4));
  const extended = estimate(base, 8);
  assert.ok("usd" in extended);
  assert.ok(Math.abs(extended.usd - 0.56) < 1e-9);
  assert.match(extended.formula, /extra seconds/);
  const clip = parse("For 5s video your request will cost $0.20 for 720p and $0.40 for 1080p.");
  assert.equal(pricingFromRecord(api("test/scenario", "video segments", 0.05), context, clip).kind, "fixed");
  const exactClip = estimate(clip, 5, "1080p");
  assert.ok("usd" in exactClip);
  assert.equal(exactClip.usd, 0.4);
  assert.equal(exactClip.approximate, true);
  assert.deepEqual(estimate(clip, 10, "1080p"), { reason: "No page clip tariff for exactly 10 seconds" });
  assert.deepEqual(estimate(clip, 5, "480p"), { reason: "no page tariff for 480p" });
  // Exercise the public planning paths, without touching tracked snapshots or admission rules.
  const originalPrices = readFileSync(process.env.AGENTBROS_FAL_PRICES!, "utf8"),
    originalSemantics = readFileSync(process.env.AGENTBROS_FAL_UNIT_SEMANTICS!, "utf8");
  const catalogue = process.env.AGENTBROS_FAL_CATALOG_DIR!;
  try {
    writeCatalog([entry("scenario")], catalogue, { syncedAt: date });
    resetCatalogCache();
    writeFileSync(process.env.AGENTBROS_FAL_PRICES!, serialiseFalPrices([api("test/scenario", "seconds", 0.05)], date));
    resetFalPricesCache();
    writeFileSync(
      process.env.AGENTBROS_FAL_UNIT_SEMANTICS!,
      JSON.stringify({ version: 1, syncedAt: date, records: [grid] }),
    );
    const choice = modelChoicePrice(entry("scenario"), { durationSec: 10, resolution: "1080p", generateAudio: true });
    assert.equal(choice.usd, 1.2);
    assert.equal(choice.kind, "approximate");
    assert.match(choice.label, /llms.txt[\s\S]*observed/);
    const rounded = { ...grid, roundUp: true };
    writeFileSync(
      process.env.AGENTBROS_FAL_UNIT_SEMANTICS!,
      JSON.stringify({ version: 1, syncedAt: date, records: [rounded] }),
    );
    assert.equal(
      modelChoicePrice(entry("scenario"), { durationSec: 10, resolution: "1080p", generateAudio: true }).basis,
      "request",
      "rounded bills must not be scaled linearly from matrix cells",
    );
    writeFileSync(
      process.env.AGENTBROS_FAL_UNIT_SEMANTICS!,
      JSON.stringify({ version: 1, syncedAt: date, records: [grid] }),
    );
    assert.equal(
      quote({ model: "test/scenario", durationSec: 10, resolution: "1080p", generateAudio: true }).highUsd,
      1.2,
    );
    assert.match(
      modelChoicePrice(entry("scenario"), { durationSec: 10, resolution: "480p" }).label,
      /no page tariff for 480p/,
    );
  } finally {
    writeFileSync(process.env.AGENTBROS_FAL_PRICES!, originalPrices);
    resetFalPricesCache();
    writeFileSync(process.env.AGENTBROS_FAL_UNIT_SEMANTICS!, originalSemantics);
    writeCatalog(
      cases.map((item) => item.entry),
      catalogue,
      { syncedAt: date },
    );
    resetCatalogCache();
  }
});

test("promotions expire by inclusive date or exact timestamp, then use regular tariffs or become unknown", () => {
  const semantics = {
    ...row("resolution"),
    tiers: [{ when: { resolution: "720p" }, usdPerUnit: 0.025, validUntil: "2026-11-16", regularUsdPerUnit: 0.05 }],
  };
  const estimate = (now: string, record: Parameters<typeof estimateFalUnitPrice>[0] = semantics) =>
    estimateFalUnitPrice(record, 0.05, { durationSec: 10, resolution: "720p" }, undefined, new Date(now));
  const during = estimate("2026-11-16T23:59:59Z"),
    after = estimate("2026-11-17T00:00:00Z");
  assert.ok("usd" in during && "usd" in after);
  assert.equal(during.usd, 0.25);
  assert.equal(during.approximate, true);
  assert.equal(after.usd, 0.5);
  const datetime = { ...semantics, tiers: [{ ...semantics.tiers[0]!, validUntil: "2026-11-16T12:00:00Z" }] };
  const atExpiry = estimate("2026-11-16T12:00:00Z", datetime);
  assert.ok("usd" in atExpiry);
  assert.equal(atExpiry.usd, 0.5);
  const recordExpiry = {
    ...semantics,
    validUntil: "2026-11-16",
    regularUsdPerUnit: 0.05,
    tiers: [{ when: { resolution: "720p" }, usdPerUnit: 0.025 }],
  };
  const expiredRecord = estimate("2026-11-17T00:00:00Z", recordExpiry);
  assert.ok("usd" in expiredRecord);
  assert.equal(expiredRecord.usd, 0.5);
  const missing = { ...semantics, tiers: [{ ...semantics.tiers[0]!, regularUsdPerUnit: undefined }] };
  assert.deepEqual(estimate("2026-11-17T00:00:00Z", missing), {
    reason: "Expired page promotion has no regular tariff",
  });
});

test("offline reparse retains dates and API snapshots, processes every record and is idempotent", () => {
  const file = path.join(dir, "reparse.json");
  const records = [
    { ...row("resolution"), meaning: "ambiguous", apiSnapshot: { unit: "seconds", unitPrice: 0.05 } },
    { ...row("frames"), meaning: "ambiguous", apiSnapshot: { unit: "30 frames", unitPrice: 0.02 } },
  ];
  writeFileSync(file, JSON.stringify({ version: 1, syncedAt: date, records }));
  const run = () =>
    spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "--import",
        "./tests/helpers/fal-no-network.ts",
        "scripts/fal-pricing.ts",
        "--docs",
        "--reparse",
      ],
      { encoding: "utf8", env: { ...process.env, FAL_KEY: "", AGENTBROS_FAL_UNIT_SEMANTICS: file } },
    );
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(first.stdout).metadata.requests, 0);
  const written = readFileSync(file, "utf8"),
    result = JSON.parse(written);
  assert.deepEqual(
    result.records.map((record: { apiSnapshot: unknown }) => record.apiSnapshot),
    records.map((record) => record.apiSnapshot),
  );
  assert.deepEqual(
    result.records.map((record: { meaning: string }) => record.meaning),
    ["generated-second", "frames"],
  );
  assert.equal(result.syncedAt, date);
  assert.equal(result.records[0].evidence.observedAsOf, date);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(file, "utf8"), written);
});

test("Seedance curated token formula retains priority over page per-second approximations", () => {
  const endpoint = "bytedance/seedance-2.5/image-to-video";
  const code = `import assert from 'node:assert/strict'; import { findModel } from './src/lib/models/registry.ts'; import { quote } from './src/lib/pricing.ts'; import { modelChoicePrice } from './src/lib/models/model-choice-price.ts'; import { findCatalogEntry } from './src/lib/models/fal-catalog.ts'; assert.equal(findModel('${endpoint}').pricing.kind, 'video-tokens'); const choice=modelChoicePrice(findCatalogEntry('${endpoint}'),{durationSec:10,resolution:'720p',aspect:'16:9'}); assert.match(choice.label,/tokens/); assert.equal(choice.kind,'approximate'); assert.equal(quote({model:'${endpoint}',durationSec:10,resolution:'720p',width:1280,height:720}).basis,'video-tokens');`;
  const tracked = path.resolve("src/lib/models");
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
    encoding: "utf8",
    env: {
      ...process.env,
      AGENTBROS_FAL_CATALOG_DIR: path.join(tracked, "fal-catalog"),
      AGENTBROS_FAL_PRICES: path.join(tracked, "fal-prices.json"),
      AGENTBROS_FAL_UNIT_SEMANTICS: path.join(tracked, "fal-unit-semantics.json"),
    },
  });
  assert.equal(child.status, 0, child.stderr);
});

test("a page tariff that does not contain the API unit price makes the API unit unusable (planning and paid)", () => {
  const entry = catalogEntry("fal-ai/flux/schnell", {
    endpoint: "test/base-unit",
    category: "text-to-video",
    outputs: { kinds: ["video"], fields: [] },
    inputs: [
      { name: "prompt", type: "string", required: true },
      { name: "duration", type: "integer", required: false },
    ],
  });
  const page = (quote: string, reason = "No single explicit billable quantity or complete tariff") => ({
    endpoint: "test/base-unit",
    meaning: "ambiguous" as const,
    reason,
    evidence: { url: "https://fal.ai/models/test/base-unit/llms.txt", quote, observedAsOf: "2026-11-16" },
  });
  const record = { endpoint: "test/base-unit", unit: "seconds", unitPrice: 0.009 };
  const contradicted = pricingFromRecord(
    record,
    pricingContext(entry),
    page("For 720p, $0.099 per second without audio and $0.12 with audio."),
  );
  assert.equal(contradicted.kind, "unknown");
  assert.match((contradicted as { reason: string }).reason, /does not contain the API unit price \$0\.009/);
  assert.equal(
    pricingFromRecord(record, pricingContext(entry), page("$0.009 per second; audio is extra.")).kind,
    "fixed",
  );
  assert.equal(
    pricingFromRecord(record, pricingContext(entry), page("- **Price**: $0.5 per seconds", "Page repeats the API unit"))
      .kind,
    "fixed",
  );
  assert.equal(
    pageContradictsApiRate(
      page("Your request will cost $0.099 per second. For example, $0.009 is not a tariff."),
      0.009,
    ) !== undefined,
    true,
  );
});

test("FLUX-3 draft: 5 s plans at the higher page rate ($0.30), reports the drift, and stays planning-only", async () => {
  const drift = { pageUsdPerUnit: 0.06, apiUsdPerUnit: 0.03, used: 0.06 };
  const planned = quote({ model: "test/flux-3-draft", durationSec: 5 });
  assert.equal(planned.bounded, true, planned.notes ?? "");
  assert.equal(planned.highUsd, 0.3);
  assert.deepEqual(planned.priceDrift, drift);
  assert.match(planned.notes ?? "", /page \$0\.06, API \$0\.03; higher rate used for planning/);
  // The tracked page row for the real endpoint plans the same way.
  const tracked = (
    JSON.parse(readFileSync("src/lib/models/fal-unit-semantics.json", "utf8")) as {
      records: { endpoint: string }[];
    }
  ).records.find((row) => row.endpoint === "blackforestlabs/flux-3/first-last-frame-to-video/draft");
  const estimate = estimateFalUnitPrice(tracked as never, 0.03, { durationSec: 5, resolution: "720p" });
  assert.ok("usd" in estimate);
  assert.equal(estimate.usd, 0.3);
  assert.deepEqual(estimate.priceDrift, drift);
  // Planning-only: the dry-run shows the drift, but without --max-cost-usd there is still no admissible quote.
  assert.equal(planningOnlyFalPricing("test/flux-3-draft"), true);
  const preview = await executeFalOperation({
    endpoint: "test/flux-3-draft",
    model: "test/flux-3-draft",
    input: { prompt: "Fly", duration: 5 },
    output: path.join(dir, "flux-3-draft.mp4"),
    mediaKind: "video",
    quoteInput: { durationSec: 5 },
    dryRun: true,
  } as never);
  assert.deepEqual(preview.metadata.priceDrift, drift);
  assert.equal(preview.metadata.quote, null);
  assert.equal(preview.metadata.executable, false);
});

test("price drift is compared like for like: scenario tiers keep the page tariff, a single page rate takes the higher", () => {
  const records = (
    JSON.parse(readFileSync("src/lib/models/fal-unit-semantics.json", "utf8")) as {
      records: { endpoint: string }[];
    }
  ).records;
  const kling = records.find((row) => row.endpoint === "fal-ai/kling-video/o3/standard/image-to-video");
  // The page splits audio off/on ($0.084 / $0.112); the API's one $0.14 matches neither scenario.
  const off = estimateFalUnitPrice(kling as never, 0.14, { durationSec: 5, generateAudio: false });
  const on = estimateFalUnitPrice(kling as never, 0.14, { durationSec: 5, generateAudio: true });
  assert.ok("usd" in off && "usd" in on);
  assert.equal(Math.round(off.usd * 1e6) / 1e6, 0.42);
  assert.equal(Math.round(on.usd * 1e6) / 1e6, 0.56);
  assert.deepEqual(off.priceDrift, { pageUsdPerUnit: 0.084, apiUsdPerUnit: 0.14, used: 0.084 });
  // One page tier prices the same scenario as the API: the higher rate plans.
  const flux = records.find((row) => row.endpoint === "blackforestlabs/flux-3/first-last-frame-to-video/draft");
  const draft = estimateFalUnitPrice(flux as never, 0.03, { durationSec: 5, resolution: "720p" });
  assert.ok("usd" in draft);
  assert.equal(draft.priceDrift?.used, 0.06);
});
