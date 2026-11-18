import { USER_GRANT } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { executeFalNonMedia } from "../src/lib/jobs/nonmedia";
import { OperationStore } from "../src/lib/jobs/store";
import { generationInputHash, type JobProvider } from "../src/lib/jobs/runner";
import { createHiggsfieldPricingEvidence } from "../src/lib/models/pricing-evidence";
import {
  higgsfieldPricingFor,
  loadHiggsfieldPrices,
  serialiseHiggsfieldPrices,
  syncHiggsfieldPrices,
} from "../src/lib/models/hf-pricing";
import { retainFailedHiggsfieldPrices } from "../src/lib/models/models-refresh";
import { resolveProviderSnapshot } from "../src/lib/models/fal-catalog";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import type { HiggsfieldPriceRecord } from "../src/types/higgsfield";

function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "hf-rereview-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

for (const nonmedia of [false, true])
  for (const state of ["queued", "result-ready", "unknown", "submitting"] as const) {
    test(`${nonmedia ? "nonmedia" : "execution"}: historical discounted ${state} jobs resume with the original bound`, async (t) => {
      const root = workspace(t),
        previousCwd = process.cwd();
      process.chdir(root);
      t.after(() => process.chdir(previousCwd));
      const directory = path.join(root, "public/projects/review");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(directory, "project.json"), "{}");
      const endpoint = nonmedia ? "v1/custom-references" : "test/dated-sale";
      const input = { prompt: "original" },
        now = new Date();
      const record: HiggsfieldPriceRecord = {
        endpoint,
        list: {
          amount: 0.255,
          originalAmount: 0.3,
          unit: "request",
          qualifier: null,
          discountPercentage: null,
          discountExpiresAt: new Date(now.valueOf() + 86_400_000).toISOString(),
          discountAfterExpiryPercentage: null,
          discountAfterExpiryExpiresAt: null,
        },
        tiers: [],
        estimates: [{ input, type: "estimate", usd: 0.255, observedAt: now.toISOString() }],
        observedAsOf: now.toISOString().slice(0, 10),
      };
      const pricesFile = path.join(root, "prices.json"),
        previousPrices = process.env.AGENTBROS_HF_PRICES;
      writeFileSync(pricesFile, serialiseHiggsfieldPrices([record], record.observedAsOf));
      process.env.AGENTBROS_HF_PRICES = pricesFile;
      t.after(() => {
        if (previousPrices === undefined) delete process.env.AGENTBROS_HF_PRICES;
        else process.env.AGENTBROS_HF_PRICES = previousPrices;
      });
      const properties = resolveProviderSnapshot("higgsfield", endpoint)?.input.properties ?? {};
      const defaults = Object.fromEntries(
        Object.entries(properties)
          .filter(([, field]) => field.default !== undefined)
          .map(([key, field]) => [key, field.default]),
      );
      const pricingEvidence = createHiggsfieldPricingEvidence(record, input, { now, defaults })!;
      const quote = {
        model: endpoint,
        basis: "fixed",
        currency: "USD" as const,
        bounded: true as const,
        lowUsd: 0.255,
        expectedUsd: 0.255,
        highUsd: 0.255,
        confidence: "published-rate" as const,
        source: pricingEvidence.source,
        asOf: record.observedAsOf,
        pricingEvidence,
      };
      const store = new OperationStore("review");
      store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
      const output = path.join(directory, "original.bin");
      const operationId = "original";
      store.reserveOperation({
        operationId,
        provider: "higgsfield",
        endpoint,
        inputHash: generationInputHash(input),
        assetId: output,
        stage: "assets",
        quote,
        publication: { output, kind: nonmedia ? "training" : "file", model: endpoint, referenceAssetIds: [] },
      });
      store.transitionJob(operationId, "submitting");
      const recoverable = state === "queued" || state === "result-ready";
      if (recoverable) store.transitionJob(operationId, "queued", { providerRequestId: "original-request" });
      if (state === "unknown") store.transitionJob(operationId, "unknown");
      const result = nonmedia
        ? { id: "original-request", status: "completed" }
        : { file: { url: "https://cdn.higgsfield.ai/original.bin", content_type: "application/octet-stream" } };
      if (state === "result-ready") store.transitionJob(operationId, state, { result });
      // Reproduce the reservation written before full-price admission was introduced.
      const database = store.snapshot();
      database.jobs[operationId]!.reservedMicros = 255_000;
      writeFileSync(store.file, JSON.stringify(database));
      let polls = 0,
        downloads = 0;
      const provider: JobProvider = {
        idempotentSubmit: true,
        submit: async () => {
          assert.fail("Existing requests must never submit again");
        },
        inspect: async (_endpoint, requestId) => {
          polls++;
          assert.equal(requestId, "original-request");
          return { state: "completed", result };
        },
      };
      const options = {
        projectId: "review",
        providerId: "higgsfield" as const,
        endpoint,
        model: endpoint,
        input,
        output,
        operationId,
        maxCostUsd: 0.28,
        provider,
        fetch: async () => {
          downloads++;
          return new Response("original bytes");
        },
      };
      const execute = (maxCostUsd: number) =>
        nonmedia
          ? executeFalNonMedia({ ...options, maxCostUsd, kind: "training" })
          : executeFalOperation({ ...options, maxCostUsd, mediaKind: "file" });
      await assert.rejects(execute(0.25), /original operation commitment/);
      assert.deepEqual(store.snapshot(), database);
      const resumed = await execute(0.28);
      assert.equal(resumed.metadata.state, recoverable ? "published" : "unknown", JSON.stringify(resumed.metadata));
      assert.deepEqual(resumed.metadata.quote, database.jobs[operationId]!.quote);
      assert.equal(polls, state === "queued" ? 1 : 0);
      assert.equal(downloads, nonmedia || !recoverable ? 0 : 1);
      assert.equal(store.summary().reservedUsd, 0.255);
      assert.equal((await execute(0.28)).metadata.state, recoverable ? "published" : "unknown");
      assert.equal(polls, state === "queued" ? 1 : 0);
      assert.equal(downloads, nonmedia || !recoverable ? 0 : 1);
    });
  }

test("partial pricing refresh saves fresh matching estimates and retains missing historical samples", async (t) => {
  const root = workspace(t),
    endpoint = "test/partial-price";
  const previous: HiggsfieldPriceRecord = {
    endpoint,
    list: null,
    tiers: [],
    estimates: ["720p", "1080p"].map((resolution) => ({
      input: { resolution },
      type: "estimate",
      usd: 0.01,
      observedAt: "2026-11-14",
    })),
    observedAsOf: "2026-11-14",
  };
  let calls = 0;
  const refreshed = await syncHiggsfieldPrices(
    [
      {
        endpoint,
        schema: {
          type: "object",
          properties: { resolution: { type: "string", enum: ["720p", "1080p"] } },
          required: ["resolution"],
        },
      },
    ],
    async (_url, init) => {
      calls++;
      assert.equal(JSON.parse(String(init?.body)).resolution, calls === 1 ? "720p" : "1080p");
      return calls === 1
        ? Response.json({ type: "estimate", usd: 0.02 })
        : Response.json({ detail: "unavailable" }, { status: 503 });
    },
    {
      apiKey: "offline-id:offline-secret",
      catalogue: { results: [] },
      maxRetries: 0,
      now: new Date("2026-11-15T00:00:00Z"),
    },
  );
  assert.equal(calls, 2);
  assert.equal(refreshed.partial, true);
  const records = retainFailedHiggsfieldPrices(
    [previous],
    refreshed.records,
    refreshed.failed.map((row) => row.endpoint),
  );
  const file = path.join(root, "prices.json");
  writeFileSync(file, serialiseHiggsfieldPrices(records, null));
  const saved = loadHiggsfieldPrices(file).get(endpoint)!;
  assert.equal(saved.estimates.length, 2);
  assert.equal(saved.estimates.find((row) => row.input.resolution === "720p")?.usd, 0.02);
  assert.equal(saved.estimates.find((row) => row.input.resolution === "1080p")?.observedAt, "2026-11-14");
  for (const [resolution, usdPerUnit] of [
    ["720p", 0.02],
    ["1080p", 0.01],
  ] as const)
    assert.deepEqual(higgsfieldPricingFor(saved, { resolution }).pricing, {
      kind: "fixed",
      quantity: "request",
      usdPerUnit,
    });
});

test("partial pricing refresh gives fresh matching tiers precedence and retains missing tiers", () => {
  const tier = (resolution: string, usdPerUnit: number) => ({
    when: { resolution },
    usdPerUnit,
    basis: "request" as const,
    rounding: null,
  });
  const previous: HiggsfieldPriceRecord = {
    endpoint: "test/tiers",
    list: null,
    tiers: [tier("720p", 0.01), tier("1080p", 0.03)],
    estimates: [],
    observedAsOf: "2026-11-14",
  };
  const current = { ...previous, tiers: [tier("720p", 0.02)], observedAsOf: "2026-11-15" };
  const [saved] = retainFailedHiggsfieldPrices([previous], [current], [current.endpoint]);
  assert.deepEqual(saved!.tiers, [tier("720p", 0.02), tier("1080p", 0.03)]);
  assert.equal(saved!.observedAsOf, "2026-11-15");
});

for (const scoped of [false, true]) {
  test(`Higgsfield local symlink MIME follows the supplied pathname (${scoped ? "scoped" : "unscoped"})`, (t) => {
    const root = workspace(t);
    mkdirSync(path.join(root, "blobs"));
    const blob = path.join(root, "blobs/hash");
    writeFileSync(blob, "original bytes");
    symlinkSync("blobs/hash", path.join(root, "ref.png"));
    symlinkSync("blobs/hash", path.join(root, "ref.jpeg"));
    const resolved = resolveImportedReferences(
      {
        provider: "higgsfield",
        endpoint: "test/model",
        input: { image_url: "ref.png", image_reference_urls: ["ref.jpeg"] },
      },
      undefined,
      root,
      undefined,
      scoped ? root : undefined,
    );
    assert.equal(resolved.request.input.image_url, `data:image/png;base64,${readFileSync(blob).toString("base64")}`);
    assert.deepEqual(resolved.request.input.image_reference_urls, [
      `data:image/jpeg;base64,${readFileSync(blob).toString("base64")}`,
    ]);
  });
}
