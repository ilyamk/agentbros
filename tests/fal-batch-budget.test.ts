import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  batchStatus,
  deepMerge,
  fetchProviderEstimate,
  planBatch,
  providerEstimateBody,
  runBatch,
  type BatchExecutor,
} from "../src/lib/jobs/batch";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
import { generationInputHash } from "../src/lib/jobs/runner";
import { paidInputIdentity } from "../src/lib/jobs/identity";
import { OperationInputSchema, type PriceQuote } from "../src/lib/jobs/types";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { findCatalogEntry, resetCatalogCache } from "../src/lib/models/fal-catalog";
import { resetFalPricesCache, serialiseFalPrices } from "../src/lib/models/fal-pricing";
import { platformPricingEvidenceDigest } from "../src/types/pricing-evidence";
import type { FalBatchSpec, OutputKind } from "../src/types/fal-catalog";
import { USER_GRANT } from "./helpers/ceiling-grant";

const repo = path.resolve(import.meta.dirname, "..");
const endpoint = "vast/eden-live-14b-video";
const environment = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key, value]) => value !== undefined && !["FAL_KEY", "ELEVENLABS_API_KEY"].includes(key),
    ),
  ) as Record<string, string>;
async function fixture(fn: (f: { root: string; spec: FalBatchSpec; store: OperationStore }) => Promise<void>) {
  const old = process.cwd(),
    previous = {
      catalog: process.env.AGENTBROS_FAL_CATALOG_DIR,
      cache: process.env.AGENTBROS_FAL_SCHEMA_CACHE,
      prices: process.env.AGENTBROS_FAL_PRICES,
    };
  const root = mkdtempSync(path.join(tmpdir(), "fal-batch-"));
  useTempFalCatalog([
    {
      endpoint,
      patch: {
        outputs: { kinds: ["video"], fields: ["video"] },
        inputs: [{ name: "duration", type: "number", required: true }],
      },
    },
  ]);
  process.chdir(root);
  mkdirSync("public/projects/demo", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  const store = new OperationStore("demo");
  const spec: FalBatchSpec = {
    version: 1,
    batchId: "takes",
    endpoint,
    baseInput: { prompt: "Offline", duration: 5, nested: { left: 1, right: 2 }, items: [1, 2] },
    variations: [{ id: "a", inputPatch: { nested: { left: 3 }, items: [7] } }, { id: "b" }],
    outputDir: path.join(root, "output"),
    assetIdPrefix: "shot",
  };
  try {
    await fn({ root, spec, store });
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      AGENTBROS_FAL_CATALOG_DIR: previous.catalog,
      AGENTBROS_FAL_SCHEMA_CACHE: previous.cache,
      AGENTBROS_FAL_PRICES: previous.prices,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetCatalogCache();
    resetFalPricesCache();
  }
}
const priced = (highUsd = 1): PriceQuote => ({
  lowUsd: highUsd / 2,
  expectedUsd: highUsd * 0.75,
  highUsd,
  bounded: true,
  currency: "USD",
  source: "Offline fixture",
  asOf: "2026-11-15",
  confidence: "published-rate",
});
const fake =
  (quote: PriceQuote | null = priced()): BatchExecutor =>
  async ({ operation, dryRun }) => ({
    ok: true,
    metadata: {
      inputHash: generationInputHash(operation.request.input),
      quote,
      ...(dryRun ? { plan: { warnings: ["Fixture warning"] } } : { state: "queued" }),
    },
  });

test("batch expansion pins IDs, requests, catalogue output extensions and recursive merge", () =>
  fixture(async ({ spec }) => {
    const plan = planBatch(spec, { projectId: "demo" });
    assert.deepEqual(
      plan.operations.map((row) => [row.operationId, row.assetId, path.basename(row.output)]),
      [
        ["takes.a", "shot-a", "a.mp4"],
        ["takes.b", "shot-b", "b.mp4"],
      ],
    );
    assert.equal(OperationInputSchema.shape.operationId.safeParse(plan.operations[0]!.operationId).success, true);
    assert.deepEqual(plan.operations[0]!.request.input.nested, { left: 3, right: 2 });
    assert.deepEqual(plan.operations[0]!.request.input.items, [7]);
    assert.deepEqual(JSON.parse(readFileSync(plan.operations[0]!.requestFile, "utf8")), plan.operations[0]!.request);
    assert.match(plan.operations[0]!.requestFile, /pipeline\/batches\/takes\/a.request.json$/);
    assert.deepEqual(deepMerge({ a: [1], b: { c: 1 } }, { a: null, b: { d: 2 } }), { a: null, b: { c: 1, d: 2 } });
    assert.deepEqual(spec.baseInput.nested, { left: 1, right: 2 });
    assert.throws(() => deepMerge({}, JSON.parse('{"__proto__":{"polluted":true}}')), /Unsafe/);
    assert.throws(
      () => planBatch({ ...spec, variations: [{ id: "a" }, { id: "a" }] }, { projectId: "demo" }),
      /unique/,
    );
    for (const [kind, ext] of Object.entries({
      image: "png",
      audio: "wav",
      model3d: "glb",
      text: "json",
      json: "json",
      weights: "safetensors",
      file: "bin",
    })) {
      findCatalogEntry(endpoint)!.outputs.kinds = [kind as OutputKind];
      assert.equal(
        path.extname(planBatch({ ...spec, batchId: kind }, { projectId: "demo", write: false }).operations[0]!.output),
        `.${ext}`,
      );
    }
  }));

test("batch IDs are immutable across spec edits, revisions create new IDs, read-only planning never writes", () =>
  fixture(async ({ spec }) => {
    planBatch(spec, { projectId: "demo", write: false });
    assert.equal(existsSync("public/projects/demo/pipeline"), false);
    const plan = planBatch(spec, { projectId: "demo" });
    const before = readFileSync(plan.operations[0]!.requestFile);
    assert.deepEqual(planBatch(spec, { projectId: "demo" }), plan);
    for (const patch of [{ baseInput: { prompt: "Changed" } }, { maxCostUsdPerOp: 2 }, { variations: [{ id: "a" }] }])
      assert.throws(() => planBatch({ ...spec, ...patch }, { projectId: "demo" }), /Immutable/);
    assert.deepEqual(readFileSync(plan.operations[0]!.requestFile), before);
    assert.equal(
      planBatch({ ...spec, baseInput: { prompt: "Revision" } }, { projectId: "demo", revision: "v2" }).operations[0]!
        .operationId,
      "takes.v2.a",
    );
    assert.throws(
      () => planBatch(spec, { projectId: "demo", scopeRoot: path.resolve("public/projects/demo") }),
      /escapes/,
    );
  }));

test("V2 batch receipts resume reordered Unicode keys without rewriting frozen files", () =>
  fixture(async ({ spec, store }) => {
    store.configure({ ceilingUsd: 10, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    const firstSpec = { ...spec, baseInput: { ...spec.baseInput, "\u00e9": 1, "e\u0301": 2 } };
    const options = { projectId: "demo", store, executor: fake() };
    const first = await runBatch(firstSpec, options);
    assert.equal(first.verdict, "fits");
    const plan = planBatch(firstSpec, options),
      originalFiles = plan.operations.map((operation) => readFileSync(operation.requestFile, "utf8"));
    const receipts = plan.operations.map((operation) =>
      readFileSync(operation.requestFile.replace(/\.request\.json$/, ".binding.json"), "utf8"),
    );
    const reordered = { ...spec, baseInput: { "e\u0301": 2, "\u00e9": 1, ...spec.baseInput } };
    assert.equal((await runBatch(reordered, options)).verdict, "fits");
    const resubmittedPlan = planBatch(reordered, options);
    for (const [index, operation] of plan.operations.entries()) {
      assert.equal(readFileSync(operation.requestFile, "utf8"), originalFiles[index]);
      assert.equal(
        readFileSync(operation.requestFile.replace(/\.request\.json$/, ".binding.json"), "utf8"),
        receipts[index],
      );
      const freshInput = resubmittedPlan.operations[index]!.request.input;
      assert.notEqual(generationInputHash(freshInput), generationInputHash(operation.request.input));
      store.reserveOperation({
        operationId: operation.operationId,
        provider: "fal.ai",
        endpoint,
        assetId: operation.assetId,
        stage: "assets",
        ...paidInputIdentity(freshInput),
        quote: priced(),
        publication: { output: operation.output, kind: "video", model: endpoint, referenceAssetIds: [] },
      });
    }
    const resumed = await runBatch(reordered, {
      ...options,
      executor: async () => {
        throw Error("Historical quotes must not be recalculated");
      },
    });
    assert.equal(resumed.verdict, "fits");
  }));

test("aggregation compares ceiling, production reserve, max job, unknown bounds and attempt policy", () =>
  fixture(async ({ spec, store }) => {
    store.configure({ ceilingUsd: 10, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    const options = { projectId: "demo", executor: fake(), write: false };
    const fitting = await runBatch(spec, options);
    assert.equal(fitting.verdict, "fits");
    assert.deepEqual(fitting.quote, { low: 1, expected: 1.5, high: 2, bounded: true });
    assert.equal(fitting.unknownCount, 0);
    assert.deepEqual(fitting.warnings, ["Fixture warning"]);
    store.configure({ ceilingUsd: 1.5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    assert.equal((await runBatch(spec, options)).verdict, "exceeds-ceiling");
    store.configure({ ceilingUsd: 10, maxJobUsd: 0.9 }, USER_GRANT);
    assert.equal((await runBatch(spec, options)).verdict, "op-exceeds-max-job");
    store.configure({ ceilingUsd: 10, maxJobUsd: 10, repairReserveFraction: 0.9 }, USER_GRANT);
    assert.equal((await runBatch(spec, options)).verdict, "exceeds-ceiling");
    assert.equal((await runBatch(spec, { ...options, executor: fake(null) })).verdict, "unknown-price-needs-bound");
    store.configure({ ceilingUsd: 10, maxJobUsd: 10, repairReserveFraction: 0 }, USER_GRANT);
    const bounded = await runBatch({ ...spec, maxCostUsdPerOp: 2 }, { ...options, executor: fake(null) });
    assert.equal(bounded.verdict, "fits");
    assert.equal(bounded.unknownCount, 2);
    assert.equal(bounded.quote.high, 4);
    store.configure(
      { ceilingUsd: 10, maxJobUsd: 10, repairReserveFraction: 0, maxPaidAttemptsPerAsset: 1 },
      USER_GRANT,
    );
    store.reserveOperation({
      operationId: "previous",
      provider: "fal.ai",
      endpoint,
      assetId: "shot-a",
      inputHash: "old",
      quote: priced(),
    });
    const blocked = await runBatch(spec, options);
    assert.equal(blocked.verdict, "invalid");
    assert.match(blocked.errors[0]!.message, /attempt/);
    assert.equal(existsSync("public/projects/demo/pipeline/batches"), false);
  }));

test("execute requires a fitting forecast and an explicit sufficient total before sequential calls; stops at first failure", () =>
  fixture(async ({ spec, store }) => {
    store.configure({ ceilingUsd: 10, maxJobUsd: 10, repairReserveFraction: 0 }, USER_GRANT);
    const calls: string[] = [];
    const executor: BatchExecutor = async (execution) => {
      if (execution.dryRun) return fake()(execution);
      calls.push(execution.operation.operationId);
      return { ok: false, error: "injected" };
    };
    for (const maxTotalUsd of [undefined, 1, NaN])
      await assert.rejects(
        runBatch(spec, { projectId: "demo", write: false, executor, execute: true, maxTotalUsd }),
        /max-total-usd/,
      );
    assert.deepEqual(calls, []);
    const result = await runBatch(spec, { projectId: "demo", write: false, executor, execute: true, maxTotalUsd: 2 });
    assert.ok("failedOperationId" in result);
    assert.equal(result.failedOperationId, "takes.a");
    assert.deepEqual(calls, ["takes.a"]);
    store.configure({ ceilingUsd: 0.5, maxJobUsd: 10, repairReserveFraction: 0 }, USER_GRANT);
    await assert.rejects(
      runBatch(spec, { projectId: "demo", write: false, executor, execute: true, maxTotalUsd: 20 }),
      /exceeds-ceiling/,
    );
  }));

test("resume skips published operations, retains frozen quotes and counts only fresh commitments", () =>
  fixture(async ({ spec, store }) => {
    store.configure({ ceilingUsd: 2, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
    const plan = planBatch(spec, { projectId: "demo", write: false });
    const first = plan.operations[0]!;
    store.reserveOperation({
      operationId: first.operationId,
      provider: "fal.ai",
      endpoint,
      assetId: first.assetId,
      stage: "assets",
      inputHash: generationInputHash(first.request.input),
      quote: priced(),
      publication: { output: first.output, model: endpoint, kind: "video" },
    });
    mkdirSync(path.dirname(first.output), { recursive: true });
    writeFileSync(first.output, "offline");
    const { digest } = await import("../src/lib/jobs/model-artifacts");
    store.transitionJob(first.operationId, "submitting");
    store.transitionJob(first.operationId, "result-ready", {
      providerRequestId: "offline",
      result: { published: { outputs: [first.output], hashes: [digest("offline")] } },
    });
    for (const state of ["downloading", "validated", "published"] as const)
      store.transitionJob(first.operationId, state);
    const executed: string[] = [];
    const executor: BatchExecutor = async (execution) => {
      if (!execution.dryRun) executed.push(execution.operation.operationId);
      return fake()(execution);
    };
    const result = await runBatch(spec, { projectId: "demo", executor, write: false, execute: true, maxTotalUsd: 2 });
    assert.equal(result.verdict, "fits");
    assert.equal(result.incrementalHighUsd, 1);
    assert.deepEqual(executed, ["takes.b"]);
    assert.equal(result.results[0]!.skipped, true);
    assert.deepEqual(
      batchStatus(spec, { projectId: "demo" }).map((row) => row.job?.state ?? null),
      ["published", null],
    );
    assert.equal(
      (
        await runBatch(
          { ...spec, baseInput: { ...spec.baseInput, prompt: "changed" } },
          { projectId: "demo", write: false, executor },
        )
      ).verdict,
      "invalid",
    );
  }));

test("API generated seconds bind duration; trusted platform evidence reserves and rehashed tampering is rejected", () =>
  fixture(async ({ store }) => {
    const prices = path.resolve("prices.json");
    writeFileSync(
      prices,
      serialiseFalPrices(
        [
          {
            endpoint,
            unit: "seconds",
            unitPrice: 0.1,
            currency: "USD",
            observedAsOf: "2026-11-15",
            source: "platform-pricing-api",
          },
        ],
        "2026-11-15",
      ),
    );
    process.env.AGENTBROS_FAL_PRICES = prices;
    resetFalPricesCache();
    const options = {
      endpoint,
      model: endpoint,
      input: { duration: 5 },
      output: "output.mp4",
      mediaKind: "video" as const,
      quoteInput: { durationSec: 5, units: 5 },
      dryRun: true,
    };
    const result = await executeFalOperation(options);
    const quote = result.metadata.quote as PriceQuote;
    const evidence = quote.pricingEvidence!;
    assert.equal(evidence.kind, "platform-pricing-api");
    assert.equal(quote.highUsd, 0.5);
    if (evidence.kind !== "platform-pricing-api") assert.fail("Expected platform evidence");
    store.configure({ ceilingUsd: 5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    const operation = { operationId: "api", provider: "fal.ai", endpoint, inputHash: "offline", assetId: "api", quote };
    store.reserveOperation(operation);
    assert.deepEqual(store.snapshot().jobs.api.quote.pricingEvidence, evidence);
    const before = readFileSync(store.file);
    const { pricingEvidence: _missing, ...withoutEvidence } = quote;
    assert.throws(
      () => store.reserveOperation({ ...operation, operationId: "missing", quote: withoutEvidence }),
      /requires trusted platform evidence/,
    );
    const { sha256: _digest, ...payload } = evidence;
    const forgedPayload = {
      ...payload,
      unitPrice: 0.001,
      pricing: { kind: "fixed" as const, quantity: "generated-second" as const, usdPerUnit: 0.001 },
    };
    const forged = { ...forgedPayload, sha256: platformPricingEvidenceDigest(forgedPayload) };
    assert.throws(
      () =>
        store.reserveOperation({
          ...operation,
          operationId: "forged",
          assetId: "forged",
          quote: { ...quote, pricingEvidence: forged },
        }),
      /trusted current pricing evidence/,
    );
    assert.throws(
      () =>
        store.reserveOperation({
          ...operation,
          operationId: "corrupt",
          quote: { ...quote, pricingEvidence: { ...evidence, unitPrice: 10 } },
        }),
      /digest mismatch/,
    );
    assert.deepEqual(readFileSync(store.file), before);
    for (const mutation of [
      { input: { duration: 6 } },
      { quoteInput: { durationSec: 4 } },
      { quoteInput: { units: 1 } },
      { endpoint: "different/endpoint" },
      { mediaKind: "image" as const },
    ])
      await assert.rejects(executeFalOperation({ ...options, ...mutation }), /Generated-second|generated seconds/);
    const audio = await executeFalOperation({ ...options, mediaKind: "audio" });
    assert.equal((audio.metadata.quote as PriceQuote).highUsd, 0.5);
  }));

test("provider estimate has isolated unit-price body, injectable fetch, required key and never changes a bound", async () => {
  assert.deepEqual(providerEstimateBody({ [endpoint]: 10 }), {
    estimate_type: "unit_price",
    endpoints: { [endpoint]: { unit_quantity: 10 } },
  });
  await assert.rejects(fetchProviderEstimate({ [endpoint]: 1 }), /FAL_KEY/);
  let calls = 0;
  const result = await fetchProviderEstimate(
    { [endpoint]: 10 },
    {
      key: "offline",
      fetch: async (url, init) => {
        calls++;
        assert.equal(url, "https://api.fal.ai/v1/models/pricing/estimate");
        assert.equal(init?.method, "POST");
        assert.equal(init?.redirect, "error");
        assert.equal(new Headers(init?.headers).get("Authorization"), "Key offline");
        assert.deepEqual(JSON.parse(String(init?.body)), providerEstimateBody({ [endpoint]: 10 }));
        return Response.json({ total_price: 1 });
      },
    },
  );
  assert.equal(result.reservationBound, false);
  assert.equal(result.kind, "providerEstimate");
  assert.equal(calls, 1);
  await assert.rejects(
    fetchProviderEstimate({ [endpoint]: 1 }, { key: "offline", fetch: async () => new Response("", { status: 500 }) }),
    /HTTP 500/,
  );
});

test("real batch CLI dry-run emits one envelope and records per-op results without paid execution; forecast writes nothing", () =>
  fixture(async ({ root, spec }) => {
    const specFile = path.join(root, "batch.json");
    writeFileSync(specFile, JSON.stringify(spec));
    const cli = (script: string, args: string[]) => {
      const child = spawnSync(
        process.execPath,
        ["--import", path.join(repo, "node_modules/tsx/dist/loader.mjs"), path.join(repo, "scripts", script), ...args],
        { cwd: root, env: environment(), encoding: "utf8", timeout: 60000 },
      );
      assert.equal(child.status, 0, child.stderr + child.stdout);
      const lines = child.stdout.trimEnd().split("\n");
      assert.equal(lines.length, 1);
      return JSON.parse(lines[0]!);
    };
    const forecast = cli("budget.ts", ["--project", "demo", "--forecast", specFile]);
    assert.equal(forecast.ok, true);
    assert.equal(existsSync("public/projects/demo/pipeline"), false);
    const result = cli("fal-batch.ts", ["--project", "demo", "--spec", specFile, "--dry-run"]);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.batchId, "takes");
    // Stream E owns endpoint parsing in generate-model. Before its merge, failures must remain explicit.
    assert.equal(result.metadata.operations.length + result.metadata.errors.length, 2);
    assert.equal(result.metadata.verdict, result.metadata.errors.length ? "invalid" : "unknown-price-needs-bound");
    assert.equal(readdirSync("public/projects/demo/pipeline/batches/takes").length, 3);
    assert.equal(existsSync("public/projects/demo/pipeline/operations.json"), false);
  }));

test("known-price execution stays within dry-run highs even with a larger explicit per-op bound", () =>
  fixture(async ({ spec, store }) => {
    store.configure({ ceilingUsd: 100, maxJobUsd: 100, repairReserveFraction: 0 }, USER_GRANT);
    const bounds: (number | undefined)[] = [];
    const executor: BatchExecutor = async (execution) => {
      if (!execution.dryRun) bounds.push(execution.maxCostUsd);
      return fake()(execution);
    };
    await runBatch(
      { ...spec, maxCostUsdPerOp: 10 },
      { projectId: "demo", write: false, execute: true, maxTotalUsd: 2, executor },
    );
    assert.deepEqual(bounds, [1, 1]);
  }));

test("historical transformed inputs resume from identity receipts without current pricing or catalogue; published files are checked", () =>
  fixture(async ({ spec, store, root }) => {
    const single = { ...spec, variations: [{ id: "a" }] };
    const normalised = { duration: 5, prompt: "resolved immutable input" };
    const executor: BatchExecutor = async () => ({
      ok: true,
      metadata: { quote: priced(), inputHash: generationInputHash(normalised) },
    });
    const initial = await runBatch(single, { projectId: "demo", executor });
    const operation = initial.operations[0]!.operation;
    store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
    const output = path.join(root, "published.mp4");
    writeFileSync(output, "offline original");
    const { digest } = await import("../src/lib/jobs/model-artifacts");
    store.reserveOperation({
      operationId: operation.operationId,
      provider: "fal.ai",
      endpoint,
      assetId: operation.assetId,
      stage: "assets",
      inputHash: generationInputHash(normalised),
      quote: priced(),
      publication: { output: operation.output, kind: "video", model: endpoint },
    });
    store.transitionJob(operation.operationId, "submitting");
    store.transitionJob(operation.operationId, "result-ready", {
      providerRequestId: "offline",
      result: { published: { outputs: [output], hashes: [digest("offline original")] } },
    });
    for (const state of ["downloading", "validated", "published"] as const)
      store.transitionJob(operation.operationId, state);
    mkdirSync("empty-catalog");
    process.env.AGENTBROS_FAL_CATALOG_DIR = path.resolve("empty-catalog");
    resetCatalogCache();
    let calls = 0;
    const noRequote: BatchExecutor = async () => {
      calls++;
      throw new Error("Historical jobs must not be repriced");
    };
    assert.equal(batchStatus(single, { projectId: "demo" })[0]!.job?.state, "published");
    const resumed = await runBatch(single, { projectId: "demo", executor: noRequote, execute: true, maxTotalUsd: 1 });
    assert.equal(resumed.verdict, "fits");
    assert.equal(resumed.incrementalHighUsd, 0);
    assert.equal(calls, 0);
    writeFileSync(output, "tampered");
    await assert.rejects(
      runBatch(single, { projectId: "demo", executor: noRequote, execute: true, maxTotalUsd: 1 }),
      /Published output.*takes.a/,
    );
    assert.equal(calls, 0);
  }));

test("single-request quote CLI accepts the legacy form and writes no project files", () =>
  fixture(async ({ root }) => {
    const legacyEndpoint = "fal-ai/kling-video/v3/pro/text-to-video";
    useTempFalCatalog([{ endpoint: legacyEndpoint, patch: { outputs: { kinds: ["video"], fields: ["video"] } } }]);
    const request = path.join(root, "legacy.json");
    writeFileSync(
      request,
      JSON.stringify({
        family: "kling-v3",
        variant: "pro",
        operation: "text-to-video",
        input: { prompt: "Offline", duration: "5", generate_audio: false },
      }),
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repo, "node_modules/tsx/dist/loader.mjs"),
        path.join(repo, "scripts/fal-quote.ts"),
        "--project",
        "demo",
        "--request",
        request,
      ],
      { cwd: root, env: environment(), encoding: "utf8", timeout: 60000 },
    );
    assert.equal(child.status, 0, child.stderr + child.stdout);
    const result = JSON.parse(child.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.verdict, "fits");
    assert.equal(result.metadata.quote.high, 0.56);
    assert.equal(result.metadata.evidenceKind, "public-list-tariff");
    assert.ok(result.metadata.inputHash);
    assert.equal(result.metadata.quoteInput.durationSec, 5);
    assert.equal(existsSync("public/projects/demo/pipeline"), false);
  }));
