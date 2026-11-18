import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  falDocsPricingChanged,
  parseFalPricingSection,
  syncFalDocsPricing,
  type FalDocsFetch,
} from "../src/lib/models/fal-docs-pricing";
import { FalUnitSemanticsFileSchema, FalUnitSemanticsSchema } from "../src/types/fal-unit-semantics";

const fixture = (name: string) => readFileSync(`tests/fixtures/fal-docs-pricing/${name}.txt`, "utf8");
const endpoint = "test/model",
  now = new Date("2026-11-16T12:00:00Z");
const response = (body: string, status = 200, retry: string | null = null) => ({
  ok: status === 200,
  status,
  headers: { get: () => retry },
  text: async () => body,
});

test("Pricing fixtures identify explicit units, cross-check totals and ignore the GPU footer", () => {
  const expected = {
    "kling-o3-edit": "generated-second",
    "seedvr-video": "video-megapixel",
    "sync-lipsync-v3": "input-audio-minute",
    image: "output-image",
    "image-mp": "output-megapixel",
    frames: "frames",
    request: "request",
    characters: "input-kilo-characters",
    resolution: "generated-second",
    audio: "generated-second",
    "input-video": "input-video-second",
    "output-audio": "output-audio-second",
    ambiguous: "ambiguous",
    mismatch: "ambiguous",
  };
  for (const [name, meaning] of Object.entries(expected)) {
    const markdown = fixture(name),
      row = parseFalPricingSection(markdown, endpoint)!;
    assert.equal(row.meaning, meaning, name);
    assert.doesNotMatch(row.evidence.quote, /4\.50|999/);
    assert.notEqual(row.unitPrice, 4.5);
    assert.deepEqual(row, parseFalPricingSection(markdown, endpoint), "pure parser is independent of the clock");
  }
  assert.equal(parseFalPricingSection(fixture("seedvr-video"), endpoint)!.example!.usd, 0.25);
  assert.equal(parseFalPricingSection(fixture("frames"), endpoint)!.framesPerUnit, 30);
  assert.match(parseFalPricingSection(fixture("mismatch"), endpoint)!.reason!, /Example total/);
  assert.deepEqual(parseFalPricingSection(fixture("resolution"), endpoint)!.tiers, [
    { when: { resolution: "720p" }, usdPerUnit: 0.05 },
    { when: { resolution: "1080p" }, usdPerUnit: 0.1 },
  ]);
  assert.deepEqual(parseFalPricingSection(fixture("audio"), endpoint)!.tiers, [
    { when: { generateAudio: false }, usdPerUnit: 0.05 },
    { when: { generateAudio: true }, usdPerUnit: 0.07 },
  ]);
});

test("only the Pricing heading is read, and unclear monetary prose never supplies a tariff", () => {
  assert.equal(parseFalPricingSection("## API\n$1 per image", endpoint), null);
  assert.equal(parseFalPricingSection("## Pricing\nServerless GPUs $4.50/h", endpoint), null);
  assert.equal(parseFalPricingSection("## Pricing\nContact us for pricing", endpoint)!.meaning, "ambiguous");
  assert.equal(
    parseFalPricingSection("## Pricing\n$0.1 per image plus $2 per request", endpoint)!.meaning,
    "ambiguous",
  );
  assert.equal(parseFalPricingSection("## Pricing\n$0 per image", endpoint)!.meaning, "ambiguous");
  for (const text of [
    "$1,000 per request",
    "$1e3 per request",
    "$1.000,00 per request",
    "$1 per minute of generated audio",
    "$0.05 per second at 720p plus $2 per request",
    "$0.05 per second at 720p plus $1,000 per request",
    "$0.05 per second at 720p without audio, $0.1 per second at 1080p with audio.",
    "$0.02 per 0 frames",
  ])
    assert.equal(parseFalPricingSection(`## Pricing\n${text}`, endpoint)!.meaning, "ambiguous", text);
  assert.equal(
    parseFalPricingSection("## Pricing\n$0.1 per image. Serverless GPUs cost $4.50/h.", endpoint)!.unitPrice,
    0.1,
  );
});

test("unit-semantics contracts are strict and require frame counts, finite positive tariffs and dates", () => {
  const row = parseFalPricingSection(fixture("frames"), endpoint)!;
  assert.equal(FalUnitSemanticsSchema.safeParse({ ...row, framesPerUnit: undefined }).success, false);
  assert.equal(FalUnitSemanticsSchema.safeParse({ ...row, extra: true }).success, false);
  assert.equal(FalUnitSemanticsSchema.safeParse({ ...row, unitPrice: Infinity }).success, false);
  assert.equal(
    FalUnitSemanticsSchema.safeParse({ ...row, evidence: { ...row.evidence, observedAsOf: "yesterday" } }).success,
    false,
  );
  assert.equal(
    FalUnitSemanticsFileSchema.safeParse({ version: 1, syncedAt: null, records: [row, row] }).success,
    false,
  );
});

test("same-day checkpoints resume endpoints, recover torn tails and expire on the next day", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fal-docs-checkpoint-"));
  try {
    const checkpointFile = path.join(dir, "checkpoint.jsonl");
    const fetchImpl: FalDocsFetch = async () => response(fixture("image"));
    const first = await syncFalDocsPricing(["test/b", "test/a", "test/a"], fetchImpl, { now, checkpointFile });
    assert.equal(first.requests, 2);
    assert.equal(first.partial, false);
    assert.deepEqual(
      first.records.map((row) => row.endpoint),
      ["test/a", "test/b"],
    );
    appendFileSync(checkpointFile, '{"torn":');
    const resumed = await syncFalDocsPricing(["test/a", "test/b"], async () => assert.fail("must resume"), {
      now,
      checkpointFile,
      resume: true,
    });
    assert.equal(resumed.requests, 0);
    assert.deepEqual(resumed.records, first.records);
    assert.ok(readFileSync(checkpointFile, "utf8").endsWith("\n"));
    const next = await syncFalDocsPricing(["test/a"], fetchImpl, {
      now: new Date("2026-11-17"),
      checkpointFile,
      resume: true,
    });
    assert.equal(next.requests, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("retry backoff is clamped, network failures retry three times, partial sync retains prior evidence", async () => {
  const old = parseFalPricingSection(fixture("request"), "test/fail", "2026-11-15")!;
  const sleeps: number[] = [];
  let attempts = 0;
  const result = await syncFalDocsPricing(
    ["test/retry", "test/fail", "test/none"],
    async (url) => {
      if (url.includes("test/fail")) throw new Error("private provider body");
      if (url.includes("test/none")) return response("## Usage\nNo tariff");
      return attempts++ < 2 ? response("", 429, attempts === 1 ? "999999" : "0") : response(fixture("image"));
    },
    {
      now,
      previous: new Map([[old.endpoint, old]]),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    },
  );
  assert.equal(result.partial, true);
  assert.equal(result.syncedAt, null);
  assert.equal(result.requests, 7);
  assert.deepEqual(
    result.failed.map((row) => row.endpoint),
    ["test/fail"],
  );
  assert.deepEqual(result.unpriced, ["test/none"]);
  assert.deepEqual(
    result.records.find((row) => row.endpoint === old.endpoint),
    old,
  );
  assert.ok(sleeps.includes(60000));
  assert.ok(sleeps.includes(1000));
  assert.doesNotMatch(JSON.stringify(result), /private provider body/);
});

test("default concurrency is two; API snapshots drive --changed and invalidate changed checkpoint rates", async () => {
  let active = 0,
    maximum = 0;
  const result = await syncFalDocsPricing(
    ["test/a", "test/b", "test/c"],
    async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return response(fixture("request"));
    },
    { now },
  );
  assert.equal(maximum, 2);
  assert.equal(result.requests, 3);
  const row = { ...result.records[0]!, apiSnapshot: { unit: "requests", unitPrice: 0.1 } };
  assert.equal(falDocsPricingChanged({ unit: "requests", unitPrice: 0.1 }, row), false);
  assert.equal(falDocsPricingChanged({ unit: "requests", unitPrice: 0.2 }, row), true);
  assert.equal(falDocsPricingChanged({ unit: "units", unitPrice: 0.1 }, row), true);
  assert.equal(falDocsPricingChanged({ unit: "requests", unitPrice: 0.1 }), true);
});

test("resume honours API snapshots and caches pages without Pricing even when API prices exist", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fal-docs-changed-"));
  try {
    const checkpointFile = path.join(dir, "checkpoint.jsonl");
    const price = {
      endpoint,
      unit: "images",
      unitPrice: 0.04,
      currency: "USD" as const,
      source: "platform-pricing-api" as const,
      observedAsOf: "2026-11-16",
    };
    const prices = new Map([[endpoint, price]]);
    const first = await syncFalDocsPricing([endpoint], async () => response(fixture("image")), {
      now,
      prices,
      checkpointFile,
    });
    assert.deepEqual(first.records[0]!.apiSnapshot, { unit: "images", unitPrice: 0.04 });
    assert.equal(
      (
        await syncFalDocsPricing([endpoint], async () => assert.fail("same price resumes"), {
          now,
          prices,
          checkpointFile,
          resume: true,
        })
      ).requests,
      0,
    );
    const changed = new Map([[endpoint, { ...price, unitPrice: 0.05 }]]);
    const next = await syncFalDocsPricing([endpoint], async () => response("## Usage\nNo Pricing"), {
      now,
      prices: changed,
      checkpointFile,
      resume: true,
    });
    assert.equal(next.requests, 1);
    assert.equal(next.records.length, 0);
    const absent = await syncFalDocsPricing([endpoint], async () => assert.fail("absent section resumes"), {
      now,
      prices: changed,
      checkpointFile,
      resume: true,
    });
    assert.equal(absent.requests, 0);
    assert.deepEqual(absent.unpriced, [endpoint]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
