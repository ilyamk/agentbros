import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildFalOperation, resolveFalSnapshotForPlan } from "../src/lib/providers/fal-operations";
import { providerUnitQuantity, quoteInputForPlan, resolveFalQuantities } from "../src/lib/providers/fal-quote-input";
import { quote } from "../src/lib/pricing";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { fetchProviderEstimate, runBatch, type BatchExecutor } from "../src/lib/jobs/batch";
import { digest } from "../src/lib/jobs/model-artifacts";
import { OperationStore } from "../src/lib/jobs/store";
import { generationInputHash } from "../src/lib/jobs/runner";
import {
  buildCatalogEntry,
  readCachedApiModel,
  summariseOutputs,
  loadCatalog,
  writeCatalog,
  writeCachedApiModel,
} from "../src/lib/models/fal-catalog";
import { resolveSchema } from "../src/lib/providers/json-schema-validate";
import { snapshotFromOpenApi } from "../src/lib/providers/fal-openapi";
import type { FalBatchSpec } from "../src/types/fal-catalog";
import { falFixtureManifest, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { USER_GRANT } from "./helpers/ceiling-grant";

const mirelo = "mirelo-ai/sfx2.0/video-to-audio";
const scribe = "fal-ai/elevenlabs/speech-to-text/scribe-v2";
const sfx = "elevenlabs/sound-effects/v3";
const kling = "fal-ai/kling-video/v3/pro/text-to-video";
const trainer = "blackforestlabs/flux-3/klein/base/trainer";
const chatterbox = "resemble-ai/chatterboxhd/speech-to-speech";
const dirs = useTempFalCatalog(
  [mirelo, scribe, sfx, kling, chatterbox, trainer].map((endpoint) => ({
    endpoint,
    patch: { outputs: { kinds: ["audio"], fields: ["audio"] } },
  })),
);
const prices = path.join(dirs.cacheDir, "review-prices.json");
writeFileSync(
  prices,
  JSON.stringify({
    version: 1,
    syncedAt: "2026-11-15",
    prices: [
      { endpoint: sfx, unit: "seconds", unitPrice: 0.07 },
      { endpoint: scribe, unit: "minutes", unitPrice: 0.06 },
      { endpoint: mirelo, unit: "seconds", unitPrice: 0.01 },
    ]
      .sort((a, b) => a.endpoint.localeCompare(b.endpoint))
      .map((row) => ({ ...row, currency: "USD", source: "platform-pricing-api", observedAsOf: "2026-11-15" })),
  }),
);
process.env.AGENTBROS_FAL_PRICES = prices;

function execution(plan: ReturnType<typeof buildFalOperation>, context?: Parameters<typeof quoteInputForPlan>[2]) {
  return {
    endpoint: plan.endpoint,
    model: plan.endpoint,
    input: plan.input,
    output: "offline.wav",
    mediaKind: "audio" as const,
    dryRun: true,
    quoteInput: quoteInputForPlan(plan, plan.input, context),
  };
}

test("sample pricing reserves every explicit or default sample and validates execution count", async () => {
  for (const [samples, expected] of [
    [4, 0.08],
    [undefined, 0.04],
    [1, 0.02],
  ] as const) {
    const plan = buildFalOperation({
      endpoint: mirelo,
      input: {
        video_url: "https://example.com/video.mp4",
        duration: 2,
        ...(samples === undefined ? {} : { num_samples: samples }),
      },
    });
    const options = execution(plan);
    assert.equal(quote({ model: mirelo, ...options.quoteInput }).highUsd, expected);
    const result = await executeFalOperation(options);
    assert.equal((result.metadata.quote as { highUsd: number }).highUsd, expected);
    if (samples !== 1)
      await assert.rejects(
        executeFalOperation({ ...options, quoteInput: { durationSec: 2, multiplier: 1 } }),
        /sample count/,
      );
  }
});

test("schema-valid omitted sample counts without a default require an explicit planning bound", async () => {
  const original = [...loadCatalog().values()];
  const entry = original.find((row) => row.endpoint === mirelo)!;
  const model = structuredClone(readCachedApiModel(entry.schema!.sha256)!);
  const snapshot = snapshotFromOpenApi(model, "2026-11-15", entry.schema!.sha256);
  delete resolveSchema(snapshot.input, snapshot.schemas).properties!.num_samples!.default;
  const hash = writeCachedApiModel(model);
  const updated = buildCatalogEntry(model, {
    previous: entry,
    today: "2026-11-15",
    verifiedPins: {},
    schema: { ...entry.schema!, sha256: hash },
  });
  writeCatalog(
    original.map((row) => (row.endpoint === mirelo ? updated : row)),
    dirs.catalogDir,
  );
  try {
    const plan = buildFalOperation({
      endpoint: mirelo,
      input: { video_url: "https://example.com/video.mp4", duration: 2 },
    });
    const options = execution(plan);
    assert.equal(options.quoteInput.units, null);
    assert.equal(quote({ model: mirelo, ...options.quoteInput }).bounded, false);
    assert.equal((await executeFalOperation(options)).metadata.executable, false);
    const bounded = await executeFalOperation({ ...options, maxCostUsd: 1 });
    assert.equal((bounded.metadata.quote as { confidence: string }).confidence, "user-bound");
  } finally {
    writeCatalog(original, dirs.catalogDir);
  }
});

test("shared Scribe quantities apply the keyterm premium exactly once", async () => {
  const audio_url = "https://example.com/audio.wav";
  const context = { media: { [audio_url]: { durationSec: 600 } } };
  for (const [keyterms, expected] of [
    [["Remotion"], 0.78],
    [[], 0.6],
    [undefined, 0.6],
  ] as const) {
    const plan = buildFalOperation({
      endpoint: scribe,
      input: { audio_url, ...(keyterms ? { keyterms: [...keyterms] } : {}) },
      context,
    });
    const options = execution(plan, context);
    assert.ok(Math.abs(quote({ model: scribe, ...options.quoteInput }).highUsd! - expected) < 1e-12);
    assert.ok(
      Math.abs(((await executeFalOperation(options)).metadata.quote as { highUsd: number }).highUsd - expected) < 1e-12,
    );
  }
});

test("generated-second execution accepts all shared duration aliases and refuses mismatched seconds", async () => {
  const plan = buildFalOperation({ endpoint: sfx, input: { text: "Paper", duration_seconds: 5 } });
  const result = await executeFalOperation(execution(plan));
  assert.equal((result.metadata.quote as { highUsd: number }).highUsd, 0.35);
  assert.equal(resolveFalQuantities(sfx, { duration: 99, duration_seconds: 5 }).durationSec, 5);
  for (const [endpoint, key] of [
    [sfx, "duration_seconds"],
    [mirelo, "duration"],
  ] as const) {
    const input = { [key]: 5, ...(endpoint === mirelo ? { num_samples: 1 } : {}) };
    const options = {
      ...execution(plan),
      endpoint,
      model: endpoint,
      input,
      quoteInput: quoteInputForPlan({ ...plan, endpoint }, input),
    };
    assert.equal((await executeFalOperation(options)).metadata.executable, true);
    await assert.rejects(executeFalOperation({ ...options, quoteInput: { durationSec: 4 } }), /generated seconds/);
  }
});

test("cached Chatterbox allOf audio is summarised by the catalogue builder without kind overrides", () => {
  const model = readCachedApiModel(falFixtureManifest.endpoints[chatterbox]!.sha256)!;
  const entry = buildCatalogEntry(model, { today: "2026-11-15", verifiedPins: {} });
  assert.deepEqual(entry.outputs.kinds, ["audio"]);
  const snapshot = resolveFalSnapshotForPlan({ endpoint: chatterbox });
  assert.deepEqual(
    summariseOutputs({
      ...snapshot,
      schemaStatus: "verified",
      output: { allOf: [{ $ref: "#/components/schemas/Wrapper" }] },
      schemas: {
        Wrapper: {
          allOf: [{ type: "object", properties: { audio: { allOf: [{ $ref: "#/components/schemas/Audio" }] } } }],
        },
        Audio: { type: "object", properties: { url: { type: "string" } } },
      },
    }),
    { kinds: ["audio"], fields: ["audio"] },
  );
});

test("reviewed Kling tariff derives five provider seconds independently of quote evidence", async () => {
  const plan = buildFalOperation({ endpoint: kling, input: { prompt: "Offline", duration: "5" } });
  const result = await executeFalOperation({ ...execution(plan), mediaKind: "video" });
  assert.equal(
    (result.metadata.quote as { pricingEvidence: { kind: string } }).pricingEvidence.kind,
    "public-list-tariff",
  );
  let calls = 0;
  await fetchProviderEstimate(
    { [kling]: providerUnitQuantity(plan, plan.input) },
    {
      key: "offline",
      fetch: async (_url, init) => {
        calls++;
        assert.deepEqual(JSON.parse(String(init?.body)), {
          estimate_type: "unit_price",
          endpoints: { [kling]: { unit_quantity: 5 } },
        });
        return Response.json({ total_price: 0.35 });
      },
    },
  );
  assert.equal(calls, 1);
});

test("published training batch verifies weights, configs and containment before skipping", async (t) => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fal-review-batch-")));
  const previous = process.cwd();
  t.after(() => {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  });
  process.chdir(root);
  const directory = path.resolve("public/projects/demo");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  const spec: FalBatchSpec = {
    version: 1,
    batchId: "training",
    endpoint: trainer,
    baseInput: { image_data_url: "https://example.com/training.zip" },
    variations: [{ id: "a" }],
    outputDir: path.join(directory, "assets"),
    assetIdPrefix: "training",
  };
  const priced = {
    currency: "USD" as const,
    lowUsd: 0,
    expectedUsd: 1,
    highUsd: 1,
    bounded: true as const,
    source: "Offline bound",
    asOf: "2026-11-15",
    confidence: "user-bound" as const,
  };
  let calls = 0;
  const executor: BatchExecutor = async ({ operation }) => {
    calls++;
    return { ok: true, metadata: { quote: priced, inputHash: generationInputHash(operation.request.input) } };
  };
  const initial = await runBatch(spec, { projectId: "demo", executor });
  const operation = initial.operations[0]!.operation;
  const store = new OperationStore("demo");
  store.configure({ ceilingUsd: 2, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  const manifest = path.join(directory, "manifest.json");
  writeFileSync(manifest, "{}");
  const weights = path.join(directory, "weights.safetensors"),
    config = path.join(directory, "config.json");
  writeFileSync(weights, "weights");
  writeFileSync(config, "config");
  store.reserveOperation({
    operationId: operation.operationId,
    provider: "fal.ai",
    endpoint: spec.endpoint,
    assetId: operation.assetId,
    stage: "assets",
    inputHash: generationInputHash(operation.request.input),
    quote: priced,
    publication: { output: operation.output, kind: "training", model: spec.endpoint },
  });
  store.transitionJob(operation.operationId, "submitting");
  store.transitionJob(operation.operationId, "result-ready", {
    providerRequestId: "offline",
    result: {
      published: {
        outputs: [manifest],
        hashes: [digest("{}")],
        artifacts: [
          { path: weights, sha256: digest("weights") },
          { path: config, sha256: digest("config") },
        ],
      },
    },
  });
  for (const state of ["downloading", "validated", "published"] as const)
    store.transitionJob(operation.operationId, state);
  const resume = () => runBatch(spec, { projectId: "demo", executor, execute: true, maxTotalUsd: 1, scopeRoot: root });
  assert.equal((await resume()).results[0]!.skipped, true);
  const baseline = calls;
  for (const [file, bytes] of [
    [weights, "weights"],
    [config, "config"],
  ]) {
    writeFileSync(file!, "corrupt");
    await assert.rejects(resume(), /artifact.*changed/);
    rmSync(file!);
    await assert.rejects(resume(), /artifact.*missing/);
    const outside = path.join(root, path.basename(file!));
    writeFileSync(outside, bytes!);
    symlinkSync(outside, file!);
    await assert.rejects(resume(), /escapes project/);
    rmSync(file!);
    writeFileSync(file!, bytes!);
  }
  assert.equal(calls, baseline);
});

test("fal:quote provider estimate sends request-derived units through a fake fetch", (t) => {
  const repo = path.resolve(import.meta.dirname, "..");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fal-review-estimate-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "public/projects/demo"), { recursive: true });
  writeFileSync(path.join(root, "public/projects/demo/project.json"), "{}");
  const request = path.join(root, "request.json"),
    hook = path.join(root, "fetch.cjs");
  writeFileSync(request, JSON.stringify({ endpoint: kling, input: { prompt: "Offline", duration: "5" } }));
  writeFileSync(
    hook,
    `globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (url !== 'https://api.fal.ai/v1/models/pricing/estimate' || body.endpoints[${JSON.stringify(kling)}].unit_quantity !== 5) throw new Error('Wrong provider units');
    return Response.json({ total_price: .35 });
  };`,
  );
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
      "--import",
      hook,
      path.join(repo, "scripts/fal-quote.ts"),
      "--project",
      "demo",
      "--request",
      request,
      "--provider-estimate",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        FAL_KEY: "offline",
        AGENTBROS_FAL_CATALOG_DIR: dirs.catalogDir,
        AGENTBROS_FAL_SCHEMA_CACHE: dirs.cacheDir,
        AGENTBROS_FAL_PRICES: prices,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
    },
  );
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.metadata.providerEstimate.request.endpoints[kling].unit_quantity, 5);
  assert.equal(result.metadata.evidenceKind, "public-list-tariff");
});
