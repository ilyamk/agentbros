import "./helpers/fal-no-network";
import { test } from "node:test";
import assert from "node:assert/strict";
import { syncFalPrices } from "../src/lib/models/fal-pricing";
import { syncFalHistoricalPrices, type HistoricalFetch } from "../src/lib/models/fal-historical-pricing";
import type { HistoricalPrice } from "../src/types/price-matrix";

const now = new Date("2026-11-16T12:00:00Z");

test("list sync: stalest batches first, and a reached time box keeps completed batches as partial", async () => {
  const endpoints = Array.from({ length: 80 }, (_, i) => `t/m${String(i).padStart(2, "0")}`);
  const requested: string[][] = [];
  const fetchImpl = async (url: string) => {
    const ids = new URL(url).searchParams.getAll("endpoint_id");
    requested.push(ids);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        prices: ids.map((id) => ({ endpoint_id: id, unit: "images", unit_price: 0.01, currency: "USD" })),
        has_more: false,
        next_cursor: null,
      }),
      text: async () => "",
    };
  };
  // m40..m79 have never been observed; m00..m39 were observed yesterday, so the second half goes first.
  const staleness = new Map(endpoints.slice(0, 40).map((id) => [id, "2026-11-15"]));
  let time = 0;
  const result = await syncFalPrices(endpoints, fetchImpl as never, {
    apiKey: "k",
    now,
    partial: true,
    staleness,
    deadlineMs: 1,
    clock: () => time++,
  });
  assert.equal(requested.length, 1);
  assert.deepEqual(requested[0], endpoints.slice(40));
  assert.equal(result.partial, true);
  assert.equal(result.records.length, 40);
  await assert.rejects(
    syncFalPrices(endpoints, fetchImpl as never, { apiKey: "k", now, deadlineMs: 0, clock: () => 1 }),
    /Time budget reached/,
  );
});

test("historical sync: stalest first; a reached time box stops new requests and keeps previous evidence", async () => {
  const previous = new Map<string, HistoricalPrice>([
    ["t/fresh", { endpoint: "t/fresh", usdPerCall: 0.5, currency: "USD", observedAsOf: "2026-11-15" }],
    ["t/old", { endpoint: "t/old", usdPerCall: 0.2, currency: "USD", observedAsOf: "2026-10-01" }],
  ]);
  const asked: string[] = [];
  const fetchImpl: HistoricalFetch = async (_url, init) => {
    asked.push(...Object.keys(JSON.parse(String(init.body)).endpoints));
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ total_cost: 0.3, currency: "USD", estimate_type: "historical_api_price" }),
    } as never;
  };
  let calls = 0;
  const result = await syncFalHistoricalPrices(["t/fresh", "t/old", "t/new"], fetchImpl, {
    apiKey: "k",
    now,
    previous,
    deadlineMs: 2,
    clock: () => calls++,
    sleep: async () => {},
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.partial, true);
  assert.equal(result.syncedAt, null);
  assert.ok(asked.length >= 1 && asked.length < 3, JSON.stringify(asked));
  assert.equal(asked[0], "t/new", "never-observed endpoints go first");
  assert.ok(!asked.includes("t/fresh"), "the freshest endpoint is the one left for the next run");
  assert.equal(result.records.find((r) => r.endpoint === "t/fresh")?.usdPerCall, 0.5);
});
