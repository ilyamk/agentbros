import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  HF_CATALOG_PRICING_URL,
  higgsfieldCataloguePrices,
  loadHiggsfieldPrices,
  serialiseHiggsfieldPrices,
  syncHiggsfieldPrices,
} from "../src/lib/models/hf-pricing";
import { retainFailedHiggsfieldPrices } from "../src/lib/models/models-refresh";
import type { HiggsfieldPriceRecord } from "../src/types/higgsfield";

const catalogue: unknown = JSON.parse(readFileSync("tests/fixtures/higgsfield/catalog-models.json", "utf8"));
const endpoint = "alibaba/happy-horse/image-to-video";
const family = "happy-horse-1-0";
const entry = {
  endpoint,
  family,
  schema: {
    type: "object",
    properties: { duration: { type: "integer", minimum: 5, maximum: 10 } },
    required: ["duration"],
  },
};
const options = { apiKey: "offline-id:offline-secret", maxRetries: 0, now: new Date("2026-11-15T00:00:00Z") };

for (const laterPage of [false, true])
  test(`catalogue ${laterPage ? "pagination" : "HTTP 503"} failure retains list evidence and merges successful estimates`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "hf-catalogue-failure-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const previous: HiggsfieldPriceRecord = {
      endpoint,
      family,
      list: higgsfieldCataloguePrices(catalogue).get(family)!.list,
      tiers: [],
      estimates: [{ input: { duration: 5 }, type: "estimate", usd: 0.5, observedAt: "2026-11-14" }],
      observedAsOf: "2026-11-14",
    };
    assert.equal(previous.list?.amount, 0.14);
    let catalogueCalls = 0,
      estimateCalls = 0;
    const result = await syncHiggsfieldPrices(
      [entry],
      async (url, init) => {
        if (init.method === "GET") {
          catalogueCalls++;
          assert.equal(
            url,
            catalogueCalls === 1 ? HF_CATALOG_PRICING_URL : new URL("?page=2", HF_CATALOG_PRICING_URL).href,
          );
          if (laterPage && catalogueCalls === 1) return Response.json({ results: [], next: "?page=2" });
          return Response.json({ detail: "unavailable" }, { status: 503 });
        }
        estimateCalls++;
        const input = JSON.parse(init.body!) as { duration: number };
        return Response.json({ type: "estimate", usd: input.duration * 0.15 });
      },
      { ...options, checkpointFile: path.join(root, "checkpoint.jsonl") },
    );
    assert.equal(catalogueCalls, laterPage ? 2 : 1);
    assert.equal(estimateCalls, 2);
    assert.equal(result.partial, true);
    assert.deepEqual(
      result.failed.map((row) => row.endpoint),
      [endpoint],
    );
    assert.match(result.failed[0]!.reason, /catalogue.*503/i);
    const records = retainFailedHiggsfieldPrices(
      [previous],
      result.records,
      result.failed.map((row) => row.endpoint),
    );
    const file = path.join(root, "prices.json");
    writeFileSync(file, serialiseHiggsfieldPrices(records, result.partial ? null : "2026-11-15"));
    assert.equal((JSON.parse(readFileSync(file, "utf8")) as { syncedAt: string | null }).syncedAt, null);
    const saved = loadHiggsfieldPrices(file).get(endpoint)!;
    assert.deepEqual(saved.list, previous.list);
    assert.deepEqual(
      saved.estimates.map((row) => [row.input.duration, row.usd]),
      [
        [5, 0.75],
        [10, 1.5],
      ],
    );
    assert.ok(saved.estimates.every((row) => row.observedAt.startsWith("2026-11-15")));
  });

test("catalogue failure checkpoints remain retryable until list evidence is refreshed", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-catalogue-resume-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpointFile = path.join(root, "checkpoint.jsonl");
  await syncHiggsfieldPrices(
    [entry],
    async (_url, init) =>
      init.method === "GET" ? Response.json({}, { status: 503 }) : Response.json({ type: "estimate", usd: 1 }),
    { ...options, checkpointFile },
  );
  const resumed = await syncHiggsfieldPrices(
    [entry],
    async (_url, init) =>
      init.method === "GET" ? Response.json(catalogue) : Response.json({ type: "estimate", usd: 2 }),
    { ...options, checkpointFile, resume: true },
  );
  assert.equal(resumed.partial, false);
  assert.deepEqual(resumed.failed, []);
  assert.equal(resumed.records[0]!.list?.amount, 0.14);
  assert.ok(resumed.records[0]!.estimates.every((row) => row.usd === 2));
});

test("a complete catalogue with no matching price remains a successful refresh", async () => {
  const result = await syncHiggsfieldPrices(
    [entry],
    async (_url, init) =>
      init.method === "GET" ? Response.json({ results: [] }) : Response.json({ type: "estimate", usd: 1 }),
    options,
  );
  assert.equal(result.partial, false);
  assert.deepEqual(result.failed, []);
  assert.equal(result.records[0]!.list, null);
});

test("resume repairs a pre-fix null-list checkpoint using fresh catalogue evidence", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-catalogue-legacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpointFile = path.join(root, "checkpoint.jsonl");
  // The pre-fix failure wrote this same successful checkpoint with no list evidence.
  await syncHiggsfieldPrices([entry], async () => Response.json({ type: "estimate", usd: 1 }), {
    ...options,
    catalogue: { results: [] },
    checkpointFile,
  });
  const result = await syncHiggsfieldPrices(
    [entry],
    async (_url, init) => {
      assert.equal(init.method, "GET", "Completed estimate samples should be reused");
      return Response.json(catalogue);
    },
    { ...options, checkpointFile, resume: true },
  );
  assert.equal(result.partial, false);
  assert.deepEqual(result.failed, []);
  assert.equal(result.records[0]!.list?.amount, 0.14);
  assert.ok(result.records[0]!.estimates.every((row) => row.usd === 1));
});

test("catalogue failure is reported even when successful estimate checkpoints are reused", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-catalogue-cached-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const checkpointFile = path.join(root, "checkpoint.jsonl");
  await syncHiggsfieldPrices([entry], async () => Response.json({ type: "estimate", usd: 1 }), {
    ...options,
    catalogue,
    checkpointFile,
  });
  const result = await syncHiggsfieldPrices(
    [entry],
    async (_url, init) => {
      assert.equal(init.method, "GET", "Completed estimate samples should be reused");
      return Response.json({}, { status: 503 });
    },
    { ...options, checkpointFile, resume: true },
  );
  assert.equal(result.partial, true);
  assert.deepEqual(
    result.failed.map((row) => row.endpoint),
    [endpoint],
  );
  assert.equal(result.records[0]!.list?.amount, 0.14);
});
