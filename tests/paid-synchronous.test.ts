import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperationStore } from "../src/lib/jobs/store";
import { synchronousPaidRequest } from "../src/lib/jobs/synchronous";

const operation = {
  operationId: "speech-1",
  assetId: "speech-1",
  provider: "fixture",
  endpoint: "fixture/tts",
  quote: {
    lowUsd: 0.3,
    expectedUsd: 0.3,
    highUsd: 0.3,
    currency: "USD" as const,
    bounded: true as const,
    source: "fixture",
    asOf: "2026-10-11",
    confidence: "user-bound" as const,
  },
};
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "paid-response-"));
  const store = new OperationStore("fixture", { directory });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  return { directory, store };
}
test("synchronous audio survives caller file-save failure and replays without paid POST", async () => {
  const { directory, store } = setup();
  let requests = 0;
  const perform = async () => {
    requests++;
    return new Response("fixture audio", {
      headers: { "request-id": "remote-123", "content-type": "audio/mpeg" },
    });
  };
  try {
    const args = { store, operation, identity: { text: "hello" }, perform };
    assert.equal(await (await synchronousPaidRequest(args)).text(), "fixture audio");
    const resumed = await synchronousPaidRequest({
      ...args,
      store: new OperationStore("fixture", { directory }),
    });
    assert.equal(await resumed.text(), "fixture audio");
    assert.equal(requests, 1);
    assert.equal(store.snapshot().jobs[operation.operationId].providerRequestId, "remote-123");
    assert.equal(store.summary().reservedUsd, 0.3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("ambiguous synchronous POST cannot be retried by outer network retry helpers", async () => {
  const { directory, store } = setup();
  let requests = 0;
  const perform = async (): Promise<Response> => {
    requests++;
    throw new Error("socket closed");
  };
  try {
    const args = { store, operation, identity: { text: "hello" }, perform };
    await assert.rejects(synchronousPaidRequest(args), /ambiguous/);
    await assert.rejects(synchronousPaidRequest(args), /reconcile/);
    assert.equal(requests, 1);
    assert.equal(store.snapshot().jobs[operation.operationId].state, "unknown");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("HTTP failure and missing provider request ID remain explicit billing uncertainty", async () => {
  const { directory, store } = setup();
  let requests = 0;
  const perform = async () => {
    requests++;
    return new Response("rate limited", { status: 429 });
  };
  try {
    const args = { store, operation, identity: { text: "hello" }, perform };
    assert.equal((await synchronousPaidRequest(args)).status, 429);
    assert.equal((await synchronousPaidRequest(args)).status, 429);
    assert.equal(requests, 1);
    const job = store.snapshot().jobs[operation.operationId];
    assert.equal(job.state, "failed");
    assert.equal(job.result?.providerRequestIdKnown, false);
    assert.equal(job.receipt, undefined);
    assert.equal(store.summary().reservedUsd, 0.3);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("corrupted paid cache fails without regeneration", async () => {
  const { directory, store } = setup();
  let requests = 0;
  const perform = async () => {
    requests++;
    return new Response("fixture audio");
  };
  try {
    const args = { store, operation, identity: { text: "hello" }, perform };
    await synchronousPaidRequest(args);
    writeFileSync(store.snapshot().jobs[operation.operationId].result!.bodyFile as string, "corrupt");
    await assert.rejects(synchronousPaidRequest(args), /checksum/);
    assert.equal(requests, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
