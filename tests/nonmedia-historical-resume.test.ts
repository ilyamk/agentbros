import { USER_GRANT } from "./helpers/ceiling-grant";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { executeFalNonMedia, type NonMediaOptions } from "../src/lib/jobs/nonmedia";
import { OperationStore } from "../src/lib/jobs/store";
import { generationInputHash, type JobProvider } from "../src/lib/jobs/runner";
import type { PriceQuote } from "../src/lib/jobs/types";
const originalDirectory = process.cwd(),
  workspace = mkdtempSync(path.join(tmpdir(), "nonmedia-resume-"));
process.chdir(workspace);
process.once("exit", () => {
  process.chdir(originalDirectory);
  rmSync(workspace, { recursive: true, force: true });
});

function fixture(
  model = "fal-ai/kling-video/create-voice",
  cost = 0.001,
  confidence: PriceQuote["confidence"] = "published-rate",
) {
  const projectId = `voice-resume-${randomUUID()}`,
    dir = path.resolve("public/projects", projectId),
    output = path.join(dir, "voice.json");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  const store = new OperationStore(projectId);
  store.configure({ ceilingUsd: 5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
  const options: NonMediaOptions = {
    projectId,
    model,
    endpoint: model,
    input: { voice_url: "original" },
    output,
    kind: "voice",
    operationId: "original",
    referenceAssetIds: ["ref-v1"],
    maxCostUsd: cost,
    quoteInput: { units: 1 },
  };
  store.reserveOperation({
    operationId: "original",
    provider: "fal.ai",
    endpoint: model,
    inputHash: generationInputHash(options.input),
    assetId: output,
    stage: "assets",
    quote: {
      lowUsd: cost,
      expectedUsd: cost,
      highUsd: cost,
      currency: "USD",
      bounded: true,
      source: "original immutable quote",
      asOf: "2026-01-01",
      confidence,
      model,
    },
    publication: { output, kind: "voice", model, referenceAssetIds: ["ref-v1"] },
  });
  const original = store.snapshot().jobs.original;
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
  return {
    options: { ...options, provider },
    store,
    original,
    counts: () => ({ submits, inspects }),
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
  };
}
test("voice historical known/manual quote survives increased/newly published/removed prices and restart", async () => {
  for (const [model, cost, confidence] of [
    ["fal-ai/kling-video/create-voice", 0.001, "published-rate"],
    ["fal-ai/kling-video/create-voice", 0.5, "user-bound"],
    ["missing/historical-voice", 0.5, "user-bound"],
  ] as const) {
    const f = fixture(model, cost, confidence);
    try {
      assert.deepEqual((await executeFalNonMedia({ ...f.options, dryRun: true })).metadata.quote, f.original.quote);
      for (const maxCostUsd of [cost, undefined, 5])
        assert.deepEqual((await executeFalNonMedia({ ...f.options, maxCostUsd })).metadata.quote, f.original.quote);
      assert.equal(f.store.snapshot().jobs.original.reservedMicros, f.original.reservedMicros);
      assert.equal(f.store.summary().reservedUsd, cost);
      assert.deepEqual(f.counts(), { submits: 1, inspects: 3 });
      const dry = await executeFalNonMedia({ ...f.options, dryRun: true, maxCostUsd: undefined });
      assert.equal(dry.metadata.executable, true);
      assert.deepEqual(dry.metadata.quote, f.original.quote);
    } finally {
      f.cleanup();
    }
  }
});
test("nonmedia lowered/invalid bounds and changed identity refuse before provider/env and leave journal exact", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.store.file);
    for (const maxCostUsd of [0, -1, NaN, Infinity, 0.0009]) {
      await assert.rejects(
        executeFalNonMedia({ ...f.options, maxCostUsd, provider: undefined }),
        /positive and finite|original operation commitment/,
      );
      assert.deepEqual(readFileSync(f.store.file), before);
    }
    for (const mutation of [
      { endpoint: "changed" },
      { model: "changed" },
      { input: { voice_url: "changed" } },
      { input: { bad: NaN } },
      { output: `${f.options.output}.other` },
      { kind: "training" as const },
      { assetId: "changed" },
      { stage: "changed" },
      { referenceAssetIds: ["changed"] },
    ]) {
      for (const dryRun of [false, true])
        await assert.rejects(
          executeFalNonMedia({ ...f.options, ...mutation, dryRun, provider: undefined }),
          /different inputs|finite JSON/,
        );
      assert.deepEqual(readFileSync(f.store.file), before);
    }
    assert.deepEqual(f.counts(), { submits: 0, inspects: 0 });
  } finally {
    f.cleanup();
  }
});
test("historical ambiguous voice response cannot duplicate submit or release original liability", async () => {
  const f = fixture();
  let calls = 0;
  const provider: JobProvider = {
    submit: async () => {
      calls++;
      throw new Error("ambiguous offline response");
    },
    inspect: async () => {
      throw new Error("no acknowledged ID");
    },
  };
  try {
    for (let i = 0; i < 2; i++)
      assert.equal((await executeFalNonMedia({ ...f.options, provider })).metadata.state, "unknown");
    assert.equal(calls, 1);
    assert.deepEqual(f.store.snapshot().jobs.original.quote, f.original.quote);
    assert.equal(f.store.summary().reservedUsd, 0.001);
  } finally {
    f.cleanup();
  }
});
test("concurrent historical nonmedia resumes keep one submit and original commitment under work lease", async () => {
  const f = fixture();
  let unblock!: () => void;
  let submits = 0;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      await barrier;
      return { requestId: "owned" };
    },
    inspect: async () => ({ state: "running" }),
  };
  try {
    const first = executeFalNonMedia({ ...f.options, provider });
    assert.equal((await executeFalNonMedia({ ...f.options, provider })).metadata.state, "submitting");
    unblock();
    assert.equal((await first).metadata.state, "running");
    assert.equal(submits, 1);
    assert.deepEqual(f.store.snapshot().jobs.original.quote, f.original.quote);
    assert.equal(f.store.summary().reservedUsd, 0.001);
  } finally {
    unblock();
    f.cleanup();
  }
});
test("new nonmedia job and dry-run use current tariff without rewriting existing quote", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.store.file);
    const dry = await executeFalNonMedia({ ...f.options, operationId: "new", dryRun: true, maxCostUsd: 0.007 });
    assert.equal((dry.metadata.quote as PriceQuote).highUsd, 0.007);
    assert.deepEqual(readFileSync(f.store.file), before);
    const result = await executeFalNonMedia({ ...f.options, operationId: "new", maxCostUsd: 0.007 });
    assert.equal((result.metadata.quote as PriceQuote).highUsd, 0.007);
    assert.equal(f.store.summary().reservedUsd, 0.008);
    assert.deepEqual(f.store.snapshot().jobs.original.quote, f.original.quote);
  } finally {
    f.cleanup();
  }
});
test("fresh/dry-run nonmedia binds endpoint/model/kind and one operation before any store or provider effects", async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.store.file);
    const mutations: Partial<NonMediaOptions>[] = [
      { quoteInput: { units: 0 } },
      { quoteInput: { units: 0.001 } },
      { quoteInput: { units: 2 } },
      { quoteInput: { units: null } },
      { quoteInput: { multiplier: 0 } },
      { quoteInput: { multiplier: 0.001 } },
      { quoteInput: { multiplier: 2 } },
      { quoteInput: { units: NaN } },
      { quoteInput: { multiplier: Infinity } },
      { quoteInput: { durationSec: 1 } },
      { endpoint: "fal-ai/flux-2-trainer", kind: "training" },
      { model: "fal-ai/flux-2-trainer" },
      { kind: "training" },
      { endpoint: "unregistered", model: "unregistered" },
    ];
    for (const mutation of mutations)
      for (const dryRun of [true, false]) {
        await assert.rejects(
          executeFalNonMedia({ ...f.options, operationId: "fresh-invalid", maxCostUsd: 1, ...mutation, dryRun }),
          /one physical operation|exact registered/,
        );
        assert.deepEqual(readFileSync(f.store.file), before);
        // No injection/key on the same invalid request: validation must precede credential creation.
        await assert.rejects(
          executeFalNonMedia({
            ...f.options,
            operationId: "fresh-invalid",
            maxCostUsd: 1,
            ...mutation,
            dryRun,
            provider: undefined,
          }),
          /one physical operation|exact registered/,
        );
      }
    assert.deepEqual(f.counts(), { submits: 0, inspects: 0 });
    const training = await executeFalNonMedia({
      ...f.options,
      operationId: "training-manual",
      endpoint: "fal-ai/flux-2-trainer",
      model: "fal-ai/flux-2-trainer",
      kind: "training",
      maxCostUsd: 0.5,
      quoteInput: { units: 1, multiplier: 1 },
    });
    assert.equal((training.metadata.quote as PriceQuote).highUsd, 0.5);
    assert.equal((training.metadata.quote as PriceQuote).confidence, "user-bound");
    const resume = await executeFalNonMedia({ ...f.options, quoteInput: { units: 0, multiplier: 0.001 } });
    assert.deepEqual(resume.metadata.quote, f.original.quote);
    assert.equal(f.store.snapshot().jobs.original.reservedMicros, f.original.reservedMicros);
  } finally {
    f.cleanup();
  }
});
test("fresh invalid nonmedia request cannot create a paid journal or reach a provider", async () => {
  const projectId = `voice-fresh-${randomUUID()}`,
    dir = path.resolve("public/projects", projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  const store = new OperationStore(projectId);
  let calls = 0;
  const options: NonMediaOptions = {
    projectId,
    model: "fal-ai/kling-video/create-voice",
    endpoint: "fal-ai/kling-video/create-voice",
    kind: "voice",
    input: { voice_url: "original" },
    output: path.join(dir, "voice.json"),
    maxCostUsd: 1,
    provider: {
      submit: async () => {
        calls++;
        throw new Error("forbidden");
      },
      inspect: async () => {
        calls++;
        throw new Error("forbidden");
      },
    },
  };
  try {
    for (const mutation of [
      { quoteInput: { units: 0 } },
      { quoteInput: { units: 0.001 } },
      { endpoint: "fal-ai/flux-2-trainer", kind: "training" as const },
    ])
      for (const dryRun of [true, false]) {
        await assert.rejects(
          executeFalNonMedia({ ...options, ...mutation, dryRun }),
          /one physical operation|exact registered/,
        );
        assert.equal(existsSync(store.file), false);
      }
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
