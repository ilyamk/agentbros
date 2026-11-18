import { USER_GRANT } from "./helpers/ceiling-grant";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { executeFalOperation, type ExecutionOptions } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
import { generationInputHash, type JobProvider } from "../src/lib/jobs/runner";
import type { PriceQuote } from "../src/lib/jobs/types";

const originalDirectory = process.cwd(),
  workspace = mkdtempSync(path.join(tmpdir(), "historical-resume-"));
process.chdir(workspace);
process.once("exit", () => {
  process.chdir(originalDirectory);
  rmSync(workspace, { recursive: true, force: true });
});

function fixture(
  model = "fal-ai/kling-video/v3/pro/text-to-video",
  confidence: PriceQuote["confidence"] = "published-rate",
) {
  const projectId = `resume-${randomUUID()}`;
  const directory = path.resolve("public/projects", projectId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  const store = new OperationStore(projectId);
  store.configure({ ceilingUsd: 5, maxJobUsd: 5, repairReserveFraction: 0 }, USER_GRANT);
  const output = path.join(directory, "assets/original.mp4");
  const historical: PriceQuote = {
    currency: "USD",
    bounded: true,
    lowUsd: 0.1,
    expectedUsd: 0.1,
    highUsd: 0.1,
    source: "historic list or approved manual bound",
    asOf: "2026-01-01",
    confidence,
    model,
  };
  const options: ExecutionOptions = {
    operationId: "original",
    projectId,
    model,
    endpoint: model,
    input: { prompt: "original" },
    output,
    mediaKind: "video",
    referenceAssetIds: ["reference-v1"],
    quoteInput: { durationSec: 5, generateAudio: true },
    maxCostUsd: 0.1,
  };
  store.reserveOperation({
    operationId: "original",
    provider: "fal.ai",
    endpoint: model,
    inputHash: generationInputHash(options.input),
    assetId: output,
    stage: "assets",
    quote: historical,
    publication: { output, kind: "video", model, referenceAssetIds: ["reference-v1"] },
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
  options.provider = provider;
  options.fetch = async () => {
    throw new Error("No media fetch permitted in this test");
  };
  return {
    options,
    store,
    original,
    provider,
    counts: () => ({ submits, inspects }),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

test("increased current tariff cannot block historical quote resume or cause another submit after restart", async () => {
  const f = fixture();
  try {
    assert.deepEqual((await executeFalOperation({ ...f.options, dryRun: true })).metadata.quote, f.original.quote);
    const first = await executeFalOperation(f.options);
    assert.deepEqual(first.metadata.quote, f.original.quote);
    const second = await executeFalOperation({ ...f.options, maxCostUsd: undefined });
    assert.deepEqual(second.metadata.quote, f.original.quote);
    assert.equal(f.store.snapshot().jobs.original.reservedMicros, f.original.reservedMicros);
    assert.deepEqual(f.counts(), { submits: 1, inspects: 2 });
  } finally {
    f.cleanup();
  }
});

test("historical manual quote survives unknown-to-published price and unavailable current forecast", async () => {
  for (const model of ["google/nano-banana-2.1/edit", "unavailable/historical-endpoint"]) {
    const f = fixture(model, "user-bound");
    try {
      const quoteInput = model.startsWith("google/")
        ? { tokens: { textInput: 0, imageInput: 0, imageOutput: 10000 } }
        : f.options.quoteInput;
      if (model.startsWith("google/"))
        assert.deepEqual(
          (await executeFalOperation({ ...f.options, quoteInput, dryRun: true })).metadata.quote,
          f.original.quote,
        );
      const result = await executeFalOperation({ ...f.options, quoteInput, maxCostUsd: undefined });
      assert.deepEqual(result.metadata.quote, f.original.quote);
      assert.equal(f.store.summary().reservedUsd, 0.1);
      const planned = await executeFalOperation({ ...f.options, dryRun: true, maxCostUsd: undefined });
      assert.deepEqual(planned.metadata.quote, f.original.quote);
      assert.equal(planned.metadata.executable, true);
      assert.deepEqual(f.counts(), { submits: 1, inspects: 1 });
    } finally {
      f.cleanup();
    }
  }
});

test("caller bound below historical commitment and invalid bounds reject without changing any liability", async () => {
  const f = fixture();
  try {
    const before = f.store.snapshot();
    for (const maxCostUsd of [0, -1, NaN, Infinity, 0.0999]) {
      await assert.rejects(
        executeFalOperation({ ...f.options, maxCostUsd }),
        /positive and finite|original operation commitment/,
      );
      assert.deepEqual(f.store.snapshot(), before);
    }
    assert.deepEqual(f.counts(), { submits: 0, inspects: 0 });
    await executeFalOperation({ ...f.options, maxCostUsd: 5 });
    assert.deepEqual(f.store.snapshot().jobs.original.quote, f.original.quote);
    assert.equal(f.store.summary().reservedUsd, 0.1);
  } finally {
    f.cleanup();
  }
});

test("changed endpoint, input, publication and asset/stage pins refuse before any provider call", async () => {
  const f = fixture();
  try {
    const before = f.store.snapshot();
    const changed: Partial<ExecutionOptions>[] = [
      { endpoint: "different/endpoint" },
      { input: { prompt: "changed" } },
      { output: `${f.options.output}.other` },
      { model: "different/model" },
      { referenceAssetIds: ["reference-v2"] },
      { mediaKind: "image" },
      { assetId: "different-asset" },
      { stage: "different-stage" },
      { input: { invalid: NaN } },
    ];
    for (const mutation of changed) {
      for (const dryRun of [false, true])
        await assert.rejects(
          executeFalOperation({ ...f.options, ...mutation, dryRun }),
          /different inputs|finite JSON/,
        );
      assert.deepEqual(f.store.snapshot(), before);
    }
    // With no injection or key, identity validation still wins over transport creation.
    await assert.rejects(
      executeFalOperation({ ...f.options, provider: undefined, input: { prompt: "changed" } }),
      /different inputs/,
    );
    assert.deepEqual(f.counts(), { submits: 0, inspects: 0 });
  } finally {
    f.cleanup();
  }
});

test("historical ambiguous submission retains frozen quote and never resubmits", async () => {
  const f = fixture();
  let submits = 0;
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      throw new Error("ambiguous offline response");
    },
    inspect: async () => {
      throw new Error("Must not inspect without an ID");
    },
  };
  try {
    assert.equal((await executeFalOperation({ ...f.options, provider })).metadata.state, "unknown");
    assert.equal((await executeFalOperation({ ...f.options, provider })).metadata.state, "unknown");
    assert.equal(submits, 1);
    assert.deepEqual(f.store.snapshot().jobs.original.quote, f.original.quote);
    assert.equal(f.store.summary().reservedUsd, 0.1);
  } finally {
    f.cleanup();
  }
});

test("concurrent historical resumes preserve one submit through existing work lease", async () => {
  const f = fixture();
  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let submits = 0;
  const provider: JobProvider = {
    submit: async () => {
      submits++;
      await barrier;
      return { requestId: "owned" };
    },
    inspect: async () => ({ state: "running" }),
  };
  try {
    const first = executeFalOperation({ ...f.options, provider });
    assert.equal((await executeFalOperation({ ...f.options, provider })).metadata.state, "submitting");
    unblock();
    assert.equal((await first).metadata.state, "running");
    assert.equal(submits, 1);
    assert.equal(f.store.summary().reservedUsd, 0.1);
  } finally {
    unblock();
    f.cleanup();
  }
});

test("current tariffs govern new operation previews while missing tariffs preserve known history", async () => {
  const f = fixture();
  const missing = fixture("retired/historical-endpoint");
  try {
    const dry = await executeFalOperation({ ...f.options, operationId: "new-priced", dryRun: true, maxCostUsd: 1 });
    assert.equal((dry.metadata.quote as PriceQuote).highUsd, 0.84);
    const newJob = await executeFalOperation({ ...f.options, operationId: "new-priced", maxCostUsd: 1 });
    assert.equal((newJob.metadata.quote as PriceQuote).highUsd, 0.84);
    assert.equal(f.store.summary().reservedUsd, 0.94);
    assert.deepEqual(f.store.snapshot().jobs.original.quote, f.original.quote);
    const resumed = await executeFalOperation({ ...missing.options, maxCostUsd: undefined });
    assert.deepEqual(resumed.metadata.quote, missing.original.quote);
    assert.equal(missing.store.summary().reservedUsd, 0.1);
  } finally {
    f.cleanup();
    missing.cleanup();
  }
});
