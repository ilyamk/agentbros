import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import {
  modelRefreshSteps,
  refreshModels as refreshModelsImpl,
  modelRefreshChanges,
  retainFailedHiggsfieldPrices,
  type ModelRefreshSnapshot,
  type RefreshStep,
} from "../src/lib/models/models-refresh";
import { hfChoiceCatalog, choiceNow, floorPrice } from "./helpers/hf-choice-fixtures";

const refreshModels = (
  query: Parameters<typeof refreshModelsImpl>[0],
  dependencies: Parameters<typeof refreshModelsImpl>[1],
) => refreshModelsImpl(query, { writeSlotsDoc: () => {}, writeMatrix: () => {}, ...dependencies });

const base = hfChoiceCatalog().get("higgsfield-ai/soul/v2/standard")!;
const empty = (): ModelRefreshSnapshot => ({ entries: [], falPrices: [], hfPrices: [] });
const env = { FAL_KEY: "present", HIGGSFIELD_API_KEY: "present" };

test("refresh selects anonymous catalogues and credential-gated pricing without reading secrets", () => {
  const steps = modelRefreshSteps({}, {});
  assert.deepEqual(
    steps.filter((step) => step.enabled).map((step) => step.id),
    ["fal:sync", "fal:pricing", "hf:sync", "models:slots"],
  ); // fal page pricing is anonymous
  assert.equal(modelRefreshSteps({}, env).filter((step) => step.enabled).length, 7);
  assert.deepEqual(
    modelRefreshSteps({ provider: "higgsfield", resume: true }, env).map((step) => step.id),
    ["hf:sync", "hf:pricing", "models:slots"],
  );
  assert.ok(
    modelRefreshSteps({ resume: true }, env)
      .find((step) => step.id === "hf:sync")
      ?.args.includes("--resume"),
  );
  assert.ok(
    modelRefreshSteps({}, env)
      .find((step) => step.id === "fal:sync")
      ?.args.includes("verified"),
  );
});
test("dry-run lists local proposals: no calls or report writes", async () => {
  const fail = () => {
    throw new Error("must not run");
  };
  const result = await refreshModels({ dryRun: true }, { env, runStep: fail, snapshot: empty, writeReport: fail });
  assert.equal(result.ok, true);
  assert.equal(result.reportFile, null);
  assert.equal(result.steps.length, 7);
});
test("injected steps run sequentially and partial failures retain reports and metadata", async () => {
  const called: string[] = [];
  let snapshots = 0,
    report = "";
  const result = await refreshModels(
    { resume: true },
    {
      env,
      now: choiceNow,
      runStep: async (step: RefreshStep) => {
        called.push(step.id);
        if (step.id === "fal:pricing") throw new Error("secret must never escape");
        return { ok: true, metadata: { retained: step.id } };
      },
      snapshot: () => (++snapshots === 1 ? empty() : { ...empty(), entries: [base] }),
      compare: () => [],
      writeReport: (file, text) => {
        assert.equal(file, "out/qa/model-refresh/model-refresh.md");
        report = text;
      },
    },
  );
  assert.equal(result.ok, false);
  assert.deepEqual(called, [
    "fal:sync",
    "fal:pricing",
    "fal:pricing",
    "fal:historical",
    "hf:sync",
    "hf:pricing",
    "models:slots",
  ]);
  assert.equal(result.steps[5]?.metadata?.retained, "hf:pricing");
  assert.equal("newModels" in result && result.newModels[0]?.releasedOn, "2026-02-01");
  assert.match(report, /partial failure/);
  assert.match(report, /New models/);
  assert.doesNotMatch(JSON.stringify(result), /secret must/);
});
test("provider-declared partial pricing results fail umbrella while later steps still run", async () => {
  for (const metadata of [{ partial: true }, { failed: 2 }]) {
    let called = 0;
    const result = await refreshModels(
      {},
      {
        env,
        now: choiceNow,
        runStep: async () => ({ ok: ++called !== 1, metadata: called === 2 ? metadata : {} }),
        snapshot: empty,
        compare: () => [],
        writeReport: () => {},
      },
    );
    assert.equal(result.ok, false);
    assert.equal(called, 7);
    assert.equal(result.steps[1]?.ok, false);
  }
});
test("report covers release dates, retiring/gone, >1% price changes and active catalogue/estimate sales", async () => {
  const price = {
    ...floorPrice(base.endpoint),
    estimates: [{ input: {}, type: "estimate" as const, usd: 0.2, discountPercentage: 20, observedAt: "2026-11-15" }],
  };
  price.list = {
    ...price.list!,
    amount: 0.08,
    originalAmount: 0.1,
    discountPercentage: 20,
    discountExpiresAt: "2026-12-01",
  };
  const before = { ...empty(), hfPrices: [{ ...price, list: { ...price.list, amount: 0.1 } }] };
  const after = {
    ...empty(),
    entries: [
      base,
      { ...base, endpoint: "test/retiring", retiresAt: "2026-12-01" },
      { ...base, endpoint: "test/gone", status: "gone" as const },
    ],
    hfPrices: [price],
  };
  const changes = modelRefreshChanges(
    before,
    after,
    [
      {
        ok: true,
        metadata: {
          cataloguePricing: [
            { family: "catalogue-only", primary: { discount_percentage: 50, discount_expires_at: "2026-12-15" } },
          ],
        },
      },
    ],
    choiceNow,
  );
  assert.equal(changes.newModels[0]?.releasedOn, "2026-02-01");
  assert.equal(changes.retiring.length, 1);
  assert.equal(changes.gone.length, 1);
  assert.equal(changes.priceChanges.length, 1);
  assert.ok(Math.abs(changes.priceChanges[0]!.changePercent! + 20) < 1e-9);
  assert.deepEqual(
    new Set(changes.discounts.map((row) => row.kind)),
    new Set(["higgsfield-list", "higgsfield-estimate", "higgsfield-catalogue"]),
  );
  assert.ok(changes.discounts.every((row) => row.expiryKnown));
  let report = "",
    i = 0;
  const result = await refreshModels(
    { provider: "higgsfield" },
    {
      env,
      now: choiceNow,
      snapshot: () => (i++ ? after : before),
      runStep: async () => ({ ok: true }),
      compare: () => [],
      writeReport: (_, text) => {
        report = text;
      },
    },
  );
  assert.equal(result.ok, true);
  for (const section of [
    "New models",
    "Retiring",
    "Gone",
    "Price changes beyond 1%",
    "Discounts and sales",
    "Top savings",
    "Slot proposals",
  ])
    assert.ok(report.includes(section));
});
test("exact 1% changes are excluded and expired sales are excluded", () => {
  const first = floorPrice(base.endpoint, 1),
    second = floorPrice(base.endpoint, 1.01);
  second.list = { ...second.list!, discountPercentage: 20, discountExpiresAt: "2026-11-01" };
  const result = modelRefreshChanges(
    { ...empty(), hfPrices: [first] },
    { ...empty(), hfPrices: [second] },
    [],
    choiceNow,
  );
  assert.equal(result.priceChanges.length, 0);
  assert.equal(result.discounts.length, 0);
});
test("missing pricing credentials are skipped successfully and a false envelope fails a step", async () => {
  const result = await refreshModels(
    {},
    {
      env: {},
      now: choiceNow,
      runStep: async (step) => ({ ok: step.id !== "hf:sync" }),
      snapshot: empty,
      compare: () => [],
      writeReport: () => {},
    },
  );
  assert.equal(result.ok, false);
  assert.equal(result.steps.filter((step) => step.status === "skipped").length, 3);
});

test("sample URLs are forwarded and failed refreshes preserve historical price evidence", () => {
  const step = modelRefreshSteps({ sampleVideo: "https://example.test/source.mp4" }, env).find(
    (step) => step.id === "hf:pricing",
  )!;
  assert.ok(step.args.includes("--sample-video"));
  assert.ok(step.args.includes("https://example.test/source.mp4"));
  const previous = {
    ...floorPrice(base.endpoint),
    tiers: [{ when: {}, usdPerUnit: 0.2, basis: "request" as const, rounding: null }],
    observedAsOf: "2026-11-01",
  };
  const failed = floorPrice(base.endpoint);
  const retained = retainFailedHiggsfieldPrices([previous], [failed], [base.endpoint]);
  assert.deepEqual(retained, [previous]);
  assert.equal(retained[0]?.observedAsOf, "2026-11-01");
  assert.deepEqual(retainFailedHiggsfieldPrices([previous], [failed], []), [failed]);
});
test("follow-on discounts remain visible between the two expiry dates", () => {
  const row = floorPrice(base.endpoint);
  row.list = {
    ...row.list!,
    discountPercentage: 50,
    discountExpiresAt: "2026-11-01",
    discountAfterExpiryPercentage: 20,
    discountAfterExpiryExpiresAt: "2026-12-01",
  };
  const result = modelRefreshChanges(
    empty(),
    { ...empty(), hfPrices: [row] },
    [
      {
        ok: true,
        metadata: {
          cataloguePricing: [
            {
              family: "follow-on",
              primary: {
                discount_percentage: 50,
                discount_expires_at: "2026-11-01",
                discount_after_expiry_percentage: 20,
                discount_after_expiry_expires_at: "2026-12-01",
              },
            },
          ],
        },
      },
    ],
    choiceNow,
  );
  assert.deepEqual(
    result.discounts.map((row) => row.percentage),
    [20, 20],
  );
  assert.ok(result.discounts.every((row) => row.kind.endsWith("after-expiry")));
});

test("historical step follows list pricing and generated matrix/doc rebuild without slot changes", async () => {
  const plan = modelRefreshSteps({}, env);
  assert.equal(plan[3]?.id, "fal:historical");
  assert.deepEqual(plan[3]?.args, ["--historical", "--all", "--resume", "--budget-minutes", "120"]);
  assert.match(modelRefreshSteps({}, {}).find((step) => step.id === "fal:historical")!.reason!, /FAL_KEY absent/);
  let docs = 0,
    matrices = 0;
  const result = await refreshModels(
    {},
    {
      env: {},
      now: choiceNow,
      snapshot: empty,
      compare: () => [],
      runStep: async () => ({ ok: true }),
      writeReport: () => {},
      writeSlotsDoc: () => {
        docs++;
      },
      writeMatrix: (matrix) => {
        matrices++;
        assert.equal(matrix.version, 1);
      },
    },
  );
  assert.equal(result.ok, true);
  assert.equal(docs, 1);
  assert.equal(matrices, 1);
});
