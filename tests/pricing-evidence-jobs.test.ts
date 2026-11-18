import { USER_GRANT, writeBudgetBrief } from "./helpers/ceiling-grant";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { CliErrorObject } from "../src/lib/cli";
import { executeFalOperation, type ExecutionOptions } from "../src/lib/jobs/execution";
import { executeFalNonMedia } from "../src/lib/jobs/nonmedia";
import { OperationStore } from "../src/lib/jobs/store";
import { runGenerationStep, generationInputHash, type JobProvider } from "../src/lib/jobs/runner";
import {
  OperationInputSchema,
  GenerationJobSchema,
  OperationDatabaseSchema,
  type PriceQuote,
} from "../src/lib/jobs/types";
import { createPublicListPricingEvidence } from "../src/lib/models/pricing-evidence";
import { findModel } from "../src/lib/models/registry";
import { pricingEvidenceDigest } from "../src/types/pricing-evidence";
const endpoint = "fal-ai/kling-video/v3/turbo/pro/text-to-video";
function fixture() {
  const projectId = `evidence-job-${randomUUID()}`,
    directory = path.resolve("public/projects", projectId),
    output = path.join(directory, "original.mp4");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  writeBudgetBrief(directory);
  const store = new OperationStore(projectId);
  let submits = 0,
    inspects = 0;
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      return { requestId: "original-request" };
    },
    inspect: async () => {
      inspects++;
      return { state: "running" };
    },
  };
  const options: ExecutionOptions = {
    projectId,
    endpoint,
    model: endpoint,
    input: { prompt: "offline", duration: "5" },
    output,
    mediaKind: "video",
    quoteInput: { durationSec: 5, units: 5 },
    operationId: "original",
    referenceAssetIds: ["immutable-ref"],
    provider,
    fetch: async () => {
      throw new Error("No network permitted");
    },
  };
  return {
    options,
    store,
    counts: () => ({ submits, inspects }),
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
  };
}
function alteredEvidence(quote: PriceQuote, changes: Record<string, unknown>) {
  const evidence = quote.pricingEvidence!;
  assert.equal(evidence.kind, "public-list-tariff");
  if (evidence.kind !== "public-list-tariff") throw new Error("Expected public-list evidence");
  const { sha256: _digest, ...payload } = evidence;
  const next = { ...payload, ...changes } as typeof payload;
  return { ...next, sha256: pricingEvidenceDigest(next) };
}
function restoreObject(target: object, original: object) {
  for (const key of Object.keys(target)) delete (target as Record<string, unknown>)[key];
  Object.assign(target, original);
}

test("new queue media/nonmedia dry-run attaches full trusted descriptor without writes; unknown/manual/legacy absence stays absent", async () => {
  const f = fixture();
  try {
    const dry = await executeFalOperation({ ...f.options, dryRun: true });
    assert.deepEqual((dry.metadata.quote as PriceQuote).pricingEvidence, createPublicListPricingEvidence(endpoint));
    const voice = "fal-ai/kling-video/create-voice";
    const voiceDry = await executeFalNonMedia({
      ...f.options,
      endpoint: voice,
      model: voice,
      kind: "voice",
      quoteInput: undefined,
      dryRun: true,
    });
    assert.deepEqual((voiceDry.metadata.quote as PriceQuote).pricingEvidence, createPublicListPricingEvidence(voice));
    const unknown = await executeFalOperation({
      ...f.options,
      quoteInput: undefined,
      input: { prompt: "offline" },
      dryRun: true,
    });
    assert.equal(unknown.metadata.quote, null);
    const manual = await executeFalOperation({
      ...f.options,
      quoteInput: undefined,
      input: { prompt: "offline" },
      maxCostUsd: 1,
      dryRun: true,
    });
    assert.equal((manual.metadata.quote as PriceQuote).confidence, "user-bound");
    assert.equal(Object.hasOwn(manual.metadata.quote as object, "pricingEvidence"), false);
    const legacy = await executeFalOperation({
      ...f.options,
      endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
      model: "fal-ai/kling-video/v3/pro/image-to-video",
      dryRun: true,
    });
    assert.equal((legacy.metadata.quote as PriceQuote).pricingEvidence, undefined);
    assert.equal(existsSync(f.store.file), false);
    assert.equal(existsSync(f.options.output), false);
    assert.deepEqual(f.counts(), { submits: 0, inspects: 0 });
    await assert.rejects(
      executeFalOperation({
        ...f.options,
        model: "fal-ai/kling-video/v3/standard/image-to-video",
        endpoint: "other/operation",
        provider: undefined,
      }),
      /exact endpoint\/model/,
    );
    assert.equal(existsSync(f.store.file), false);
  } finally {
    f.cleanup();
  }
});

test("strict present evidence provider/endpoint/publication bindings inherit through saved GenerationJob and database parsing", async () => {
  const f = fixture();
  try {
    await executeFalOperation(f.options);
    const db = f.store.snapshot(),
      job = db.jobs.original;
    for (const mutation of [
      { provider: "other" },
      { endpoint: "other/operation" },
      { publication: { ...job.publication!, model: "other/model" } },
    ]) {
      const invalid = { ...job, ...mutation };
      assert.equal(OperationInputSchema.safeParse(invalid).success, false);
      assert.equal(GenerationJobSchema.safeParse(invalid).success, false);
      assert.equal(OperationDatabaseSchema.safeParse({ ...db, jobs: { original: invalid } }).success, false);
    }
    const { pricingEvidence: _evidence, ...quote } = job.quote;
    // Legacy absent evidence never creates a new constraint on historical provider names.
    assert.equal(GenerationJobSchema.safeParse({ ...job, provider: "legacy", quote }).success, true);
  } finally {
    f.cleanup();
  }
});

test("new coherent rehashed forged tariff refuses under store transaction before writes or injected submit", async () => {
  const f = fixture();
  try {
    f.store.configure({ ceilingUsd: 5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
    const quote = (await executeFalOperation({ ...f.options, dryRun: true })).metadata.quote as PriceQuote;
    const before = readFileSync(f.store.file);
    for (const changes of [
      { conditions: "forged conditions" },
      { unit: "forged unit" },
      { observedAsOf: "2020-01-01" },
      { pricing: { kind: "fixed", quantity: "generated-second", usdPerUnit: 0.001 } },
    ]) {
      const evidence = alteredEvidence(quote, changes);
      const forged = { ...quote, pricingEvidence: evidence, asOf: evidence.observedAsOf, basis: evidence.pricing.kind };
      const operation = {
        operationId: "forged",
        provider: "fal.ai",
        endpoint,
        assetId: f.options.output,
        quote: forged,
        publication: { output: f.options.output, kind: "video" as const, model: endpoint, referenceAssetIds: [] },
      };
      assert.equal(
        OperationInputSchema.safeParse({ ...operation, inputHash: generationInputHash(f.options.input) }).success,
        true,
        "internally coherent shape control",
      );
      await assert.rejects(
        runGenerationStep({ store: f.store, input: f.options.input, operation, provider: f.options.provider! }),
        /trusted current pricing evidence/,
      );
      assert.deepEqual(readFileSync(f.store.file), before);
      assert.equal(existsSync(`${f.store.file}.lock`), false);
    }
    assert.deepEqual(f.counts(), { submits: 0, inspects: 0 });
    await executeFalOperation(f.options);
    assert.equal(f.counts().submits, 1);
  } finally {
    f.cleanup();
  }
});

test("historical full snapshot survives higher/lower/removed current definitions with no requote, enrichment or second submit", async () => {
  const f = fixture(),
    descriptor = findModel(endpoint)!,
    originalPricing = structuredClone(descriptor.pricing);
  try {
    await executeFalOperation(f.options);
    const original = f.store.snapshot().jobs.original;
    for (const usdPerUnit of [0.001, 9]) {
      Object.assign(descriptor.pricing, { usdPerUnit });
      const resumed = await executeFalOperation({ ...f.options, maxCostUsd: 0.7 });
      assert.deepEqual(resumed.metadata.quote, original.quote);
      await assert.rejects(
        executeFalOperation({ ...f.options, operationId: "new", dryRun: true, maxCostUsd: 50 }),
        /registered pricing differs/,
      );
      const before = readFileSync(f.store.file);
      await assert.rejects(
        executeFalOperation({ ...f.options, operationId: "new", provider: undefined, maxCostUsd: 50 }),
        (error) =>
          error instanceof CliErrorObject &&
          error.code === "VALIDATION" &&
          /registered pricing differs/.test(error.message),
      );
      assert.deepEqual(readFileSync(f.store.file), before);
      assert.equal(f.store.snapshot().jobs.original.reservedMicros, original.reservedMicros);
    }
    restoreObject(descriptor.pricing, { kind: "unknown", reason: "retired current pricing" });
    assert.deepEqual(
      (await executeFalOperation({ ...f.options, maxCostUsd: undefined })).metadata.quote,
      original.quote,
    );
    assert.equal((await executeFalOperation({ ...f.options, operationId: "new", dryRun: true })).metadata.quote, null);
    assert.deepEqual(f.counts(), { submits: 1, inspects: 4 });
    const before = readFileSync(f.store.file);
    await assert.rejects(
      executeFalOperation({ ...f.options, maxCostUsd: 0.6999, provider: undefined }),
      /original operation commitment/,
    );
    assert.deepEqual(readFileSync(f.store.file), before);
    await assert.rejects(
      executeFalOperation({ ...f.options, input: { prompt: "changed", duration: "5" }, provider: undefined }),
      /different inputs/,
    );
    assert.deepEqual(readFileSync(f.store.file), before);
  } finally {
    restoreObject(descriptor.pricing, originalPricing);
    f.cleanup();
  }
});

test("saved historical date/conditions/rate remains valid; corrupt digest or saved job binding refuses before provider with journal exact", async () => {
  const f = fixture();
  try {
    await executeFalOperation(f.options);
    const db = f.store.snapshot(),
      quote = db.jobs.original.quote;
    const old = alteredEvidence(quote, {
      observedAsOf: "2020-01-01",
      conditions: "Old trusted journal snapshot",
      pricing: { kind: "fixed", quantity: "generated-second", usdPerUnit: 0.01 },
    });
    db.jobs.original.quote = { ...quote, asOf: old.observedAsOf, pricingEvidence: old };
    writeFileSync(f.store.file, JSON.stringify(db));
    assert.deepEqual((await executeFalOperation(f.options)).metadata.quote, db.jobs.original.quote);
    const valid = structuredClone(db),
      count = f.counts();
    for (const mutate of [
      (row: typeof db) => {
        const evidence = row.jobs.original.quote.pricingEvidence!;
        if (evidence.kind === "public-list-tariff") evidence.conditions = "corrupt";
      },
      (row: typeof db) => {
        row.jobs.original.provider = "other";
      },
      (row: typeof db) => {
        row.jobs.original.endpoint = "other/operation";
      },
      (row: typeof db) => {
        row.jobs.original.publication!.model = "other/model";
      },
    ]) {
      const bad = structuredClone(valid);
      mutate(bad);
      writeFileSync(f.store.file, JSON.stringify(bad));
      const before = readFileSync(f.store.file);
      await assert.rejects(
        executeFalOperation({ ...f.options, provider: undefined }),
        /Pricing evidence|pricing evidence/,
      );
      assert.deepEqual(readFileSync(f.store.file), before);
      await assert.rejects(executeFalOperation(f.options), /Pricing evidence|pricing evidence/);
      assert.deepEqual(f.counts(), count);
    }
  } finally {
    f.cleanup();
  }
});

test("retired endpoint with coherent historical snapshot resumes while identical legacy quote remains absent", async () => {
  for (const absent of [false, true]) {
    const f = fixture();
    try {
      await executeFalOperation(f.options);
      const db = f.store.snapshot(),
        job = db.jobs.original,
        retired = "retired/public-operation";
      const evidence = alteredEvidence(job.quote, {
        endpoint: retired,
        model: retired,
        sourceUrl: `https://fal.ai/models/${retired}`,
      });
      job.endpoint = retired;
      job.publication!.model = retired;
      job.quote = { ...job.quote, model: retired, source: evidence.sourceUrl, pricingEvidence: evidence };
      if (absent) delete job.quote.pricingEvidence;
      writeFileSync(f.store.file, JSON.stringify(db));
      const frozen = structuredClone(job.quote);
      const resumed = await executeFalOperation({ ...f.options, endpoint: retired, model: retired });
      assert.deepEqual(resumed.metadata.quote, frozen);
      assert.equal(f.store.snapshot().jobs.original.reservedMicros, job.reservedMicros);
      assert.equal(f.counts().submits, 1);
      assert.equal(Object.hasOwn(f.store.snapshot().jobs.original.quote, "pricingEvidence"), !absent);
    } finally {
      f.cleanup();
    }
  }
});

test("voice evidence persists and ambiguous new media submit retains one frozen snapshot and liability across restart", async () => {
  const f = fixture();
  let submits = 0;
  try {
    const voice = "fal-ai/kling-video/create-voice";
    const result = await executeFalNonMedia({
      ...f.options,
      endpoint: voice,
      model: voice,
      kind: "voice",
      quoteInput: undefined,
    });
    assert.deepEqual((result.metadata.quote as PriceQuote).pricingEvidence, createPublicListPricingEvidence(voice));
    const frozen = f.store.snapshot().jobs.original.quote;
    assert.deepEqual(
      (await executeFalNonMedia({ ...f.options, endpoint: voice, model: voice, kind: "voice", quoteInput: undefined }))
        .metadata.quote,
      frozen,
    );
    assert.equal(f.counts().submits, 1);
    const provider: JobProvider = {
      submit: async () => {
        submits++;
        throw new Error("ambiguous injected result");
      },
      inspect: async () => {
        throw new Error("no acknowledged request");
      },
    };
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await executeFalOperation({ ...f.options, operationId: "ambiguous", assetId: "second", provider })).metadata
          .state,
        "unknown",
      );
    assert.equal(submits, 1);
    const saved = f.store.snapshot().jobs.ambiguous;
    assert.deepEqual(saved.quote.pricingEvidence, createPublicListPricingEvidence(endpoint));
    assert.equal(saved.reservedMicros, 700000);
  } finally {
    f.cleanup();
  }
});
