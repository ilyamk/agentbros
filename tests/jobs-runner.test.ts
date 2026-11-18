import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperationStore } from "../src/lib/jobs/store";
import { generationInputHash, runGenerationStep, type JobProvider } from "../src/lib/jobs/runner";

const quote = {
  lowUsd: 1,
  expectedUsd: 1,
  highUsd: 1,
  bounded: true as const,
  currency: "USD" as const,
  source: "fixture",
  asOf: "2026-10-11",
  confidence: "user-bound" as const,
};
const operation = { operationId: "shot-1", assetId: "asset-1", provider: "fixture", endpoint: "fixture/model", quote };
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "runner-"));
  const store = new OperationStore("fixture", { directory });
  store.configure({ ceilingUsd: 5, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
  return { directory, store };
}
test("lost submit response retains liability and cannot resubmit after restart", async () => {
  const { directory, store } = fixture();
  let submissions = 0;
  const provider: JobProvider = {
    submit: async () => {
      submissions++;
      throw new Error("lost response");
    },
    inspect: async () => ({ state: "running" }),
  };
  try {
    const args = { store, operation, input: { prompt: "hello" }, provider };
    assert.equal((await runGenerationStep(args)).state, "unknown");
    assert.equal(
      (await runGenerationStep({ ...args, store: new OperationStore("fixture", { directory }) })).state,
      "unknown",
    );
    assert.equal(submissions, 1);
    assert.equal(store.summary().reservedUsd, 1);
    await assert.rejects(runGenerationStep({ ...args, input: { prompt: "different" } }), /different inputs/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("download failure resumes stored result without a second paid submit", async () => {
  const { directory, store } = fixture();
  let submissions = 0,
    downloads = 0;
  const provider: JobProvider = {
    submit: async () => {
      submissions++;
      return { requestId: "provider-1" };
    },
    inspect: async () => ({ state: "completed", result: { images: [{ url: "fixture://image" }] } }),
  };
  const publish = async () => {
    if (++downloads === 1) throw new Error("disk failed");
    return { file: "assets/image.png", sha256: "fixture-hash" };
  };
  try {
    const args = { store, operation, input: { prompt: "hello" }, provider, publish };
    assert.equal((await runGenerationStep(args)).state, "failed");
    const resumed = await runGenerationStep({ ...args, store: new OperationStore("fixture", { directory }) });
    assert.equal(resumed.state, "published");
    assert.equal(submissions, 1);
    assert.equal(downloads, 2);
    assert.equal(store.summary().reservedUsd, 1);
    assert.deepEqual(store.summary().unreconciled, [operation.operationId]);
    assert.equal((await runGenerationStep(args)).state, "published");
    assert.equal(downloads, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("input hashing is stable across object field order and rejects non-JSON values", () => {
  assert.equal(generationInputHash({ a: 1, b: { c: true } }), generationInputHash({ b: { c: true }, a: 1 }));
  assert.throws(() => generationInputHash({ a: NaN }), /finite JSON/);
  assert.throws(() => generationInputHash({ a: undefined }), /finite JSON/);
  assert.throws(() => generationInputHash({ a: new Date() }), /plain JSON/);
  for (const array of [Array(1), Array(2), [1, , 3]]) {
    assert.throws(() => generationInputHash({ images: array }), /finite JSON/);
    assert.throws(() => generationInputHash({ nested: { images: array } }), /finite JSON/);
  }
});

test("paid submit claims are exclusive even when two workers read reserved state", () => {
  const { directory, store } = fixture();
  try {
    store.reserveOperation({ ...operation, inputHash: "fixture" });
    const other = new OperationStore("fixture", { directory });
    assert.equal(other.snapshot().jobs[operation.operationId].state, "reserved");
    store.transitionJob(operation.operationId, "submitting", { expectedState: "reserved" });
    assert.throws(
      () => other.transitionJob(operation.operationId, "submitting", { expectedState: "reserved" }),
      /changed before claiming/,
    );
    assert.equal(other.snapshot().jobs[operation.operationId].paidAttempts, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent resumes cannot mark a live submit unknown or publish twice", async () => {
  const { directory, store } = fixture();
  let submissions = 0,
    publications = 0;
  let releaseSubmit!: () => void;
  const barrier = new Promise<void>((resolve) => {
    releaseSubmit = resolve;
  });
  const provider: JobProvider = {
    submit: async () => {
      submissions++;
      await barrier;
      return { requestId: "provider-1" };
    },
    inspect: async () => ({ state: "completed", result: { images: [] } }),
  };
  const publish = async () => {
    publications++;
    return { file: "fixture" };
  };
  try {
    const args = { store, operation, input: { prompt: "concurrent" }, provider, publish };
    const first = runGenerationStep(args);
    assert.equal((await runGenerationStep(args)).state, "submitting");
    assert.equal(store.snapshot().jobs[operation.operationId].state, "submitting");
    releaseSubmit();
    assert.equal((await first).state, "published");
    assert.equal(submissions, 1);
    assert.equal(publications, 1);
  } finally {
    releaseSubmit();
    rmSync(directory, { recursive: true, force: true });
  }
});
