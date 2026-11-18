import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { OperationStore } from "../src/lib/jobs/store";

test("local realtime result can publish without fabricated provider IDs and retains financial liability", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "realtime-financial-"));
  try {
    const store = new OperationStore("realtime-fixture", { directory });
    store.configure({ ceilingUsd: 3, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
    const quote = {
      currency: "USD" as const,
      lowUsd: 0,
      expectedUsd: 1,
      highUsd: 1,
      bounded: true as const,
      source: "local-fixture-bound",
      asOf: "2026-10-11",
      confidence: "user-bound" as const,
    };
    store.reserveOperation({
      operationId: "realtime-one",
      provider: "fal-realtime",
      endpoint: "fal-ai/flux-2/klein/realtime",
      inputHash: "input",
      assetId: "frame",
      quote,
    });
    store.transitionJob("realtime-one", "submitting");
    assert.throws(() => store.transitionJob("realtime-one", "queued"), /provider request ID/);
    assert.throws(
      () =>
        store.transitionJob("realtime-one", "result-ready", {
          result: { sessionId: "session", revisionId: "rev", providerAck: false, privateResultHash: "invalid" },
        }),
      /provider request ID/,
    );
    const result = { sessionId: "session", revisionId: "rev", providerAck: false, privateResultHash: "a".repeat(64) };
    store.transitionJob("realtime-one", "result-ready", { result });
    store.transitionJob("realtime-one", "downloading");
    store.transitionJob("realtime-one", "validated");
    store.transitionJob("realtime-one", "published");
    const job = store.snapshot().jobs["realtime-one"];
    assert.equal(job.providerRequestId, undefined);
    assert.equal(job.paidAttempts, 1);
    assert.equal(store.summary().reservedUsd, 1);
    assert.throws(
      () =>
        store.releaseReservation("realtime-one", {
          confirmationId: "fake",
          reason: "not-submitted",
          source: "fixture",
        }),
      /may have charged/,
    );
    for (const [operationId, provider, endpoint] of [
      ["queue", "fal.ai", "fal-ai/flux-2/klein/realtime"],
      ["other-endpoint", "fal-realtime", "fal-ai/flux-2"],
    ] as const) {
      store.reserveOperation({ operationId, provider, endpoint, inputHash: "input", assetId: operationId, quote });
      store.transitionJob(operationId, "submitting");
      assert.throws(() => store.transitionJob(operationId, "result-ready", { result }), /provider request ID/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
