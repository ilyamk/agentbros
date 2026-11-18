import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { pinFile } from "../src/lib/campaigns/production/files";
import { approveCampaignPackage, reviewPackage } from "../src/lib/campaigns/production/review";
import { runCampaign } from "../src/lib/campaigns/production/service";
import { initCampaign } from "../src/lib/campaigns/production/store";
import { createHiggsfieldPricingEvidence } from "../src/lib/models/pricing-evidence";
import { ProjectConfigSchema } from "../src/types/video";

test("campaign execution binds expiring discounts at their full reservation liability", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "campaign-spend-bound-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const request = path.join(root, "generation.json");
  const input = { prompt: "Synthetic fixture" };
  writeFileSync(request, JSON.stringify({ provider: "higgsfield", endpoint: "fixture/sale", input }));
  const now = new Date();
  const evidence = createHiggsfieldPricingEvidence(
    {
      endpoint: "fixture/sale",
      list: {
        amount: 0.255,
        originalAmount: 0.3,
        unit: "request",
        qualifier: null,
        discountPercentage: null,
        discountExpiresAt: new Date(now.valueOf() + 86400000).toISOString(),
        discountAfterExpiryPercentage: null,
        discountAfterExpiryExpiresAt: null,
      },
      tiers: [],
      estimates: [{ input, type: "estimate", usd: 0.255, observedAt: now.toISOString() }],
      observedAsOf: now.toISOString().slice(0, 10),
    },
    input,
    { now },
  )!;
  const quote = {
    model: evidence.model,
    basis: evidence.pricing.kind,
    currency: "USD",
    bounded: true,
    lowUsd: 0.255,
    expectedUsd: 0.255,
    highUsd: 0.255,
    source: evidence.source,
    asOf: now.toISOString().slice(0, 10),
    confidence: "published-rate",
    pricingEvidence: evidence,
  };
  const project = ProjectConfigSchema.parse({
    name: "Synthetic",
    productName: "Fixture",
    colors: {},
    musicVolume: 0,
    formats: ["vertical"],
    scenes: [
      { id: "hook", headline: "Fixture", text: "", visualType: "title", durationInFrames: 30, transitionToNext: "cut" },
    ],
  });
  const plan = initCampaign(
    {
      version: 1,
      id: "batch",
      revision: 1,
      scenario: "ad-experiments",
      spend: "authorised",
      capUsd: 1,
      sharedQuotaUsd: 1,
      brief: "Offline bound fixture",
      materials: [
        {
          id: "source",
          owner: "shared",
          source: {
            kind: "generate",
            useCase: "product-image",
            request: pinFile(root, request),
            output: "public/projects/batch/source.png",
            reason: "Offline fixture",
          },
        },
      ],
      members: [{ id: "one", projectId: "one", language: "en", adapter: { kind: "template", project } }],
    },
    root,
  );
  const { pack } = reviewPackage(root, plan, "generation-requests");
  await approveCampaignPackage(
    root,
    plan,
    pack,
    pack.packageHash,
    "Approve this synthetic request fixture.",
    "fixture",
  );
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = (() => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(JSON.stringify({ ok: true, outputs: [], metadata: { quote, executable: true } })),
      );
      child.emit("close", 0);
    });
    return child;
  }) as unknown as typeof childProcess.spawn;
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      runCampaign(root, "batch", { paid: true, maxTotalUsd: 0.255 }),
      /exceeds the explicit execution bound/,
    );
    const result = await runCampaign(root, "batch", { paid: true, maxTotalUsd: 0.3 });
    assert.ok("action" in result);
    assert.equal(result.action, "ask");
  } finally {
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  }
});
