import { writeBudgetBrief } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { executeFalOperation, type ExecutionOptions } from "../src/lib/jobs/execution";
import { executeFalNonMedia } from "../src/lib/jobs/nonmedia";
import { createPublicListPricingEvidence } from "../src/lib/models/pricing-evidence";
import type { PriceQuote } from "../src/lib/jobs/types";
import { OperationStore } from "../src/lib/jobs/store";

async function fixture(run: () => Promise<void>) {
  const previous = process.cwd(),
    root = mkdtempSync(path.join(tmpdir(), "publication-identity-"));
  process.chdir(root);
  mkdirSync("public/projects/demo", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  writeBudgetBrief("public/projects/demo");
  try {
    await run();
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
}
test("queued media identity rejects changed publication before polling, downloading or reserving again", () =>
  fixture(async () => {
    let submits = 0,
      polls = 0;
    const provider = {
      submit: async () => ({ requestId: `fixture-${++submits}` }),
      inspect: async () => {
        polls++;
        return { state: "queued" as const };
      },
    };
    const options: ExecutionOptions = {
      projectId: "demo",
      endpoint: "fixture/image",
      model: "fixture-model",
      input: { prompt: "fixture" },
      output: "image.png",
      mediaKind: "image",
      maxCostUsd: 0.5,
      operationId: "stable",
      assetId: "stable-asset",
      referenceAssetIds: ["a", "b"],
      provider,
      fetch: async () => {
        throw new Error("No download allowed");
      },
    };
    await executeFalOperation(options);
    const store = new OperationStore("demo"),
      before = readFileSync(store.file, "utf8");
    for (const patch of [
      { output: "changed.png" },
      { mediaKind: "video" as const },
      { model: "changed-model" },
      { referenceAssetIds: ["a", "c"] },
    ]) {
      await assert.rejects(() => executeFalOperation({ ...options, ...patch }), /bound to different/);
      assert.equal(readFileSync(store.file, "utf8"), before);
      assert.equal(submits, 1);
      assert.equal(polls, 1);
    }
    await executeFalOperation({ ...options, referenceAssetIds: ["b", "a", "a"] });
    assert.equal(polls, 2);
    assert.equal(submits, 1);
    assert.equal(store.summary().reservedUsd, 0.5);
    assert.equal(existsSync("changed.png"), false);
  }));
test("published voice identity cannot be rebound to another output, kind, model or provenance", () =>
  fixture(async () => {
    let submits = 0,
      polls = 0;
    const provider = {
      submit: async () => ({ requestId: `fixture-${++submits}` }),
      inspect: async () => {
        polls++;
        return { state: "completed" as const, result: { voice_id: "voice-fixture" } };
      },
    };
    const options = {
      projectId: "demo",
      endpoint: "fal-ai/kling-video/create-voice",
      model: "fal-ai/kling-video/create-voice",
      input: { video_url: "https://fal.media/fixture.mp4" },
      output: "voice.json",
      kind: "voice" as const,
      maxCostUsd: 0.5,
      operationId: "stable",
      assetId: "stable-asset",
      referenceAssetIds: ["reference"],
      provider,
    };
    await assert.rejects(executeFalNonMedia({ ...options, model: "voice-model" }), /exact registered endpoint\/model/);
    assert.equal(submits, 0);
    assert.equal(polls, 0);
    assert.equal(existsSync(new OperationStore("demo").file), false);
    assert.equal(existsSync("voice.json"), false);
    const result = await executeFalNonMedia(options);
    assert.equal(result.metadata.state, "published");
    assert.equal((result.metadata.quote as PriceQuote).highUsd, 0.007);
    assert.deepEqual(
      (result.metadata.quote as PriceQuote).pricingEvidence,
      createPublicListPricingEvidence(options.endpoint),
    );
    const store = new OperationStore("demo"),
      before = readFileSync(store.file, "utf8");
    for (const patch of [
      { output: "different.json" },
      { kind: "training" as const },
      { model: "other-model" },
      { referenceAssetIds: [] },
    ]) {
      await assert.rejects(() => executeFalNonMedia({ ...options, ...patch }), /bound to different/);
      assert.equal(readFileSync(store.file, "utf8"), before);
      assert.equal(submits, 1);
      assert.equal(polls, 1);
    }
    const repeat = await executeFalNonMedia(options);
    assert.deepEqual(repeat.outputs, result.outputs);
    assert.equal(submits, 1);
    assert.equal(polls, 1);
    assert.deepEqual(repeat.metadata.quote, result.metadata.quote);
  }));
