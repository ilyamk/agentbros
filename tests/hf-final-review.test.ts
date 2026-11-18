import "./helpers/fal-no-network";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { OperationStore } from "../src/lib/jobs/store";
import { generationInputHash, runGenerationStep, type JobProvider } from "../src/lib/jobs/runner";
import { resolveImportedReferences } from "../src/lib/assets/provider-references";
import { createHiggsfieldPricingEvidence } from "../src/lib/models/pricing-evidence";
import {
  higgsfieldPricingFor,
  loadHiggsfieldPrices,
  serialiseHiggsfieldPrices,
  syncHiggsfieldPrices,
} from "../src/lib/models/hf-pricing";
import { prepareCommand } from "../src/mcp/bridge";
import { COMMANDS } from "../src/mcp/catalog";
import { findProviderEntry } from "../src/lib/models/fal-catalog";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { USER_GRANT } from "./helpers/ceiling-grant";

const repo = path.resolve(".");
const input = { prompt: "offline regression" };
const bound = {
  currency: "USD" as const,
  lowUsd: 0,
  expectedUsd: 1,
  highUsd: 1,
  bounded: true as const,
  confidence: "user-bound" as const,
  source: "offline bound",
  asOf: "2026-11-15",
};
function workspace(t: TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "hf-final-review-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
for (const providerId of ["fal.ai", "higgsfield"])
  for (const reconciled of [false, true]) {
    test(`${providerId}: released or reconciled ambiguous operations cannot recover a submit (${reconciled})`, async (t) => {
      const store = new OperationStore("review", { directory: workspace(t) });
      store.configure({ ceilingUsd: 10, maxJobUsd: 2, repairReserveFraction: 0 }, USER_GRANT);
      let submits = 0;
      const provider: JobProvider = {
        idempotentSubmit: true,
        submit: async () => {
          submits++;
          throw new Error("lost response");
        },
        inspect: async () => ({ state: "queued" }),
      };
      const options = {
        store,
        operation: {
          operationId: "review:1",
          provider: providerId,
          endpoint: "test/model",
          assetId: "asset",
          quote: bound,
        },
        input,
        provider,
      };
      assert.equal((await runGenerationStep(options)).state, "unknown");
      if (reconciled)
        store.reconcileBilling("review:1", {
          receiptId: "receipt",
          actualUsd: 0,
          source: "confirmed",
          confirmedAt: new Date().toISOString(),
        });
      else
        store.releaseReservation("review:1", {
          confirmationId: "release",
          reason: "confirmed-no-charge",
          source: "confirmed",
        });
      await assert.rejects(runGenerationStep(options), /reconciled|released|admission/i);
      assert.equal(submits, 1);
      assert.equal(store.summary().reservedUsd, 0);
    });
  }
for (const provider of ["fal", "higgsfield"] as const) {
  test(`${provider}: accepts in-scope local references through a workspace symlink`, (t) => {
    const parent = workspace(t),
      root = path.join(parent, "scope"),
      alias = path.join(parent, "alias");
    mkdirSync(root);
    writeFileSync(path.join(root, "ref.png"), "allowed bytes");
    symlinkSync(root, alias);
    const reference = path.join(alias, "ref.png");
    const result = resolveImportedReferences(
      { provider, endpoint: "test/model", input: { image_url: reference } },
      undefined,
      alias,
      undefined,
      realpathSync(root),
    );
    // Both providers inline contained local paths (fal since 2026-11-17).
    assert.equal(
      result.request.input.image_url,
      `data:image/png;base64,${Buffer.from("allowed bytes").toString("base64")}`,
    );
  });
  test(`${provider}: MCP generate_model supplies the trusted reference boundary`, () => {
    const tool = COMMANDS.find((row) => row.name === "generate_model")!;
    const plan = prepareCommand(
      tool,
      { request: "request.json", output: "out.png", project: "review" },
      { root: repo, codeRoot: repo, allowPaid: true },
    );
    assert.equal(plan.flags["scope-root"], repo);
    assert.equal(plan.flags["dry-run"], true);
  });
  for (const kind of ["absolute", "traversal", "symlink"] as const) {
    test(`${provider}: refuses ${kind} nested local references before reading bytes`, (t) => {
      const parent = workspace(t),
        root = path.join(parent, "scope");
      mkdirSync(root);
      const outside = path.join(parent, "private.png");
      writeFileSync(outside, "private bytes");
      symlinkSync(outside, path.join(root, "escape.png"));
      const reference = kind === "absolute" ? outside : kind === "traversal" ? "../private.png" : "escape.png";
      assert.throws(
        () =>
          resolveImportedReferences(
            { provider, endpoint: "test/model", input: { nested: [{ image_reference_urls: [reference] }] } },
            undefined,
            root,
            undefined,
            root,
          ),
        /outside|escape|within|scope/i,
      );
    });
  }
  test(`${provider}: generation CLI enforces the MCP boundary before any paid execution`, (t) => {
    const parent = workspace(t),
      root = path.join(parent, "scope");
    mkdirSync(root);
    writeFileSync(path.join(parent, "private.png"), "private bytes");
    const request = path.join(root, "request.json");
    writeFileSync(
      request,
      JSON.stringify({
        provider,
        endpoint: "test/model",
        input: { nested: { image_reference_url: "../private.png" } },
      }),
    );
    const tool = COMMANDS.find((row) => row.name === "generate_model")!;
    const plan = prepareCommand(
      tool,
      { request, output: path.join(root, "out.png"), project: "review", "dry-run": false },
      { root, codeRoot: repo, allowPaid: true },
    );
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        "--import",
        path.join(repo, "tests/helpers/fal-no-network.ts"),
        plan.script,
        ...plan.argv,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        },
      },
    );
    assert.equal(child.status, 1, child.stderr);
    assert.match(JSON.parse(child.stdout).message, /escapes project directory/);
  });
}
test("Seedance edit bills the documented four-second prepared-source minimum before ceil rounding", () => {
  const record = loadHiggsfieldPrices().get("bytedance/seedance-2.5/video-edit")!;
  for (const [durationSec, seconds] of [
    [1, 4],
    [3.99, 4],
    [4.01, 5],
  ]) {
    const result = higgsfieldPricingFor(
      record,
      { video_url: "https://example.test/source.mp4", resolution: "480p" },
      { media: { "https://example.test/source.mp4": { durationSec } } },
    );
    assert.deepEqual(result.pricing, { kind: "fixed", quantity: "request", usdPerUnit: seconds! * 0.1387 });
  }
});
for (const workflow of ["motion-transfer", "object-swap"]) {
  test(`Genjutsu ${workflow} bills the documented 30-second prepared-source cap`, () => {
    const record = loadHiggsfieldPrices().get(`higgsfield/genjutsu/${workflow}/v1.0`)!;
    const result = higgsfieldPricingFor(
      record,
      { video_url: "https://example.test/source.mp4", resolution: "480p" },
      { media: { "https://example.test/source.mp4": { durationSec: 35 } } },
    );
    assert.deepEqual(result.pricing, { kind: "fixed", quantity: "request", usdPerUnit: 30 * 0.154 });
  });
}
test("pricing errors and checkpoints redact the credential, secret and ID separately", async (t) => {
  const checkpointFile = path.join(workspace(t), "checkpoint.jsonl");
  const result = await syncHiggsfieldPrices(
    [{ endpoint: "test/model", schema: { type: "object", properties: {} } }],
    async () => ({
      ok: false,
      status: 400,
      headers: { get: () => null },
      json: async () => ({ detail: { parts: ["public-id:secret-fragment", "secret-fragment", "public-id"] } }),
    }),
    { apiKey: "public-id:secret-fragment", catalogue: { results: [] }, maxRetries: 0, checkpointFile },
  );
  const serialised = JSON.stringify(result) + readFileSync(checkpointFile, "utf8");
  for (const secret of ["public-id:secret-fragment", "secret-fragment", "public-id"])
    assert.ok(!serialised.includes(secret), secret);
  assert.match(serialised, /redacted/);
});

function saleOperation(t: TestContext) {
  const root = workspace(t),
    file = path.join(root, "prices.json");
  const endpoint = "test/dated-sale";
  const now = new Date();
  const record = {
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
    estimates: [{ input, type: "estimate" as const, usd: 0.255, observedAt: now.toISOString() }],
    tiers: [],
    observedAsOf: now.toISOString().slice(0, 10),
  };
  writeFileSync(file, serialiseHiggsfieldPrices([record], record.observedAsOf));
  const previous = process.env.AGENTBROS_HF_PRICES;
  process.env.AGENTBROS_HF_PRICES = file;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENTBROS_HF_PRICES;
    else process.env.AGENTBROS_HF_PRICES = previous;
  });
  const pricingEvidence = createHiggsfieldPricingEvidence(record, input, { now })!;
  const quote = {
    ...bound,
    model: endpoint,
    basis: "fixed",
    lowUsd: 0.255,
    expectedUsd: 0.255,
    highUsd: 0.255,
    source: pricingEvidence.source,
    asOf: record.observedAsOf,
    confidence: "published-rate" as const,
    pricingEvidence,
  };
  const store = new OperationStore("review", { directory: root });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  const operation = { operationId: "review:sale", provider: "higgsfield", endpoint, assetId: "sale", quote };
  return { store, operation };
}
test("dated Higgsfield discounts reserve undiscounted liability even if preparation fails", async (t) => {
  const { store, operation } = saleOperation(t);
  await assert.rejects(
    runGenerationStep({
      store,
      operation,
      input,
      provider: {
        idempotentSubmit: true,
        prepareInput: async () => {
          throw new Error("preparation failed");
        },
        submit: async () => {
          throw new Error("must not submit");
        },
        inspect: async () => ({ state: "queued" }),
      },
    }),
    /preparation failed/,
  );
  assert.equal(store.summary().reservedUsd, 0.3);
});
test("dated discount reservations respect the explicit per-operation bound", async (t) => {
  const { operation } = saleOperation(t);
  await assert.rejects(
    executeFalOperation({
      providerId: "higgsfield",
      endpoint: operation.endpoint,
      model: operation.endpoint,
      input,
      output: "/tmp/review.png",
      mediaKind: "image",
      dryRun: true,
      maxCostUsd: 0.28,
      quoteInput: { provider: "higgsfield", providerInput: input },
    }),
    /exceeds the explicit per-operation bound/,
  );
});
for (const policy of ["allowed", "job", "project", "allocation"] as const) {
  test(`historical discounted admission is raised atomically before POST or refused by ${policy} policy`, async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
    const { store, operation } = saleOperation(t);
    store.reserveOperation({ ...operation, inputHash: generationInputHash(input) });
    const db = store.snapshot();
    const job = db.jobs[operation.operationId]!;
    job.reservedMicros = 255_000;
    job.requestBody = JSON.stringify(input);
    if (policy === "job") db.policy.maxJobUsd = 0.28;
    if (policy === "project") db.policy.ceilingUsd = 0.28;
    if (policy === "allocation") {
      db.policy.ceilingUsd = 0.5;
      db.policy.repairReserveFraction = 0.45;
    }
    writeFileSync(store.file, JSON.stringify(db));
    // Resume the original evidence and frozen bytes after the dated sale has expired.
    t.mock.timers.setTime(Date.now() + 2 * 86_400_000);
    let posts = 0;
    const provider: JobProvider = {
      idempotentSubmit: true,
      submit: async (_endpoint, _input, context) => {
        posts++;
        assert.equal(store.summary().reservedUsd, 0.3);
        assert.equal(context?.operationId, operation.operationId);
        assert.equal(context?.body, job.requestBody);
        return { requestId: "same-request" };
      },
      inspect: async () => ({ state: "queued" }),
    };
    const action = runGenerationStep({ store, operation, input, provider });
    if (policy === "allowed") {
      assert.equal((await action).state, "queued");
      assert.equal(posts, 1);
    } else {
      await assert.rejects(action, /limit|ceiling|allocation/i);
      assert.equal(posts, 0);
      assert.equal(store.summary().reservedUsd, 0.255);
    }
  });
}

for (const endpoint of ["higgsfield-ai/soul/v2/standard", "marketing-studio/image/flare"])
  for (const status of [401, 503, 400]) {
    test(`direct pricing CLI retains ${endpoint} history and reports ${status === 400 ? "terminal validation" : "partial failure"} for HTTP ${status}`, (t) => {
      const root = workspace(t),
        file = path.join(root, "prices.json"),
        catalogDir = path.join(root, "catalog");
      mkdirSync(catalogDir);
      const original = loadHiggsfieldPrices().get(endpoint)!;
      writeFileSync(file, serialiseHiggsfieldPrices([original], "2026-11-14"));
      writeFileSync(
        path.join(catalogDir, "text-to-image.json"),
        JSON.stringify({
          version: 1,
          provider: "higgsfield",
          category: "text-to-image",
          syncedAt: "2026-11-15",
          entries: [findProviderEntry("higgsfield", original.endpoint)!],
        }),
      );
      const preload = path.join(root, "fetch.mjs");
      writeFileSync(
        preload,
        `await import(${JSON.stringify(path.join(repo, "tests/helpers/fal-no-network.ts"))}); process.env.HIGGSFIELD_API_KEY = 'offline-id:offline-secret'; globalThis.fetch = async url => String(url).includes('dash.higgsfield.ai') ? Response.json({results: []}) : Response.json({detail: 'invalid input'}, {status: ${status}}); globalThis.setTimeout = ((original) => (fn, ms, ...args) => original(fn, Math.min(ms, 1), ...args))(globalThis.setTimeout);`,
      );
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          "--import",
          preload,
          path.join(repo, "scripts/hf-pricing.ts"),
          "--sync",
          "--as-of",
          "2026-11-15",
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            AGENTBROS_NO_DOTENV: "1",
            PATH: process.env.PATH,
            AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
            AGENTBROS_HF_PRICES: file,
            AGENTBROS_HF_CATALOG_DIR: catalogDir,
          },
        },
      );
      assert.ok(child.stdout.trim(), child.stderr);
      assert.equal(child.stdout.trim().split("\n").length, 1, child.stderr);
      const envelope = JSON.parse(child.stdout);
      assert.match(envelope.metadata.failures[0].reason, new RegExp(`HTTP ${status}`));
      assert.equal(envelope.ok, status === 400, child.stdout);
      assert.equal(child.status, status === 400 ? 0 : 1);
      assert.equal(envelope.metadata.partial, status !== 400);
      const saved = JSON.parse(readFileSync(file, "utf8"));
      assert.deepEqual(saved.prices, [original]);
      assert.equal(saved.syncedAt, status === 400 ? "2026-11-15" : null);
    });
  }
