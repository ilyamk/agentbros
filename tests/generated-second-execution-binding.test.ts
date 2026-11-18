import { writeBudgetBrief } from "./helpers/ceiling-grant";
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { executeFalOperation, type ExecutionOptions } from "../src/lib/jobs/execution";
import { OperationStore } from "../src/lib/jobs/store";
import type { PriceQuote } from "../src/lib/jobs/types";
const endpoint = "fal-ai/kling-video/v3/turbo/pro/text-to-video";
function fixture() {
  const projectId = `seconds-bound-${randomUUID()}`,
    dir = path.resolve("public/projects", projectId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.json"), "{}");
  writeBudgetBrief(dir);
  let submits = 0;
  const options: ExecutionOptions = {
    projectId,
    endpoint,
    model: endpoint,
    input: { prompt: "offline", duration: "5" },
    mediaKind: "video",
    output: path.join(dir, "output.mp4"),
    quoteInput: { durationSec: 5, units: 5 },
    operationId: "operation",
    provider: {
      submit: async () => ({ requestId: `request-${++submits}` }),
      inspect: async () => ({ state: "queued" }),
    },
  };
  return {
    options,
    store: new OperationStore(projectId),
    submits: () => submits,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
test("fresh/dry generated-second helper binds actual duration and both endpoint/model directions with no new journal", async () => {
  const f = fixture();
  try {
    const mutations: Partial<ExecutionOptions>[] = [
      { input: { prompt: "offline", duration: "15" } },
      { input: { prompt: "offline", duration: null } },
      { input: { prompt: "offline" } },
      { input: { prompt: "offline", duration: "auto" } },
      { input: { prompt: "offline", duration: 0 } },
      { quoteInput: { units: 0 } },
      { quoteInput: { units: 0.001 } },
      { quoteInput: { units: 5, durationSec: 4 } },
      { quoteInput: { units: 5, durationSec: 5, multiplier: 0 } },
      { quoteInput: { durationSec: 5, multiplier: 0.001 } },
      { quoteInput: { durationSec: 5, multiplier: 2 } },
      { endpoint: "other/unpriced" },
      { model: "fal-ai/kling-video/create-voice" },
      { mediaKind: "image" },
      {
        endpoint: "fal-ai/kling-video/o3/pro/video-to-video/reference",
        model: "fal-ai/kling-video/o3/pro/video-to-video/reference",
        input: { prompt: "offline", video_url: "original", duration: null },
      },
    ];
    for (const mutation of mutations)
      for (const dryRun of [true, false]) {
        await assert.rejects(
          executeFalOperation({ ...f.options, ...mutation, dryRun, maxCostUsd: 5 }),
          /generated seconds|Generated-second|same exact/,
        );
        assert.equal(existsSync(f.store.file), false);
        await assert.rejects(
          executeFalOperation({ ...f.options, ...mutation, dryRun, maxCostUsd: 5, provider: undefined }),
          /generated seconds|Generated-second|same exact/,
        );
      }
    assert.equal(f.submits(), 0);
  } finally {
    f.cleanup();
  }
});
test("matching physical seconds and one operation is priced; historical resume retains frozen quote despite new caller quantities", async () => {
  const f = fixture();
  try {
    const dry = await executeFalOperation({ ...f.options, dryRun: true });
    assert.equal((dry.metadata.quote as PriceQuote).highUsd, 0.7);
    assert.equal(existsSync(f.store.file), false);
    const result = await executeFalOperation(f.options);
    assert.equal((result.metadata.quote as PriceQuote).highUsd, 0.7);
    assert.equal(f.submits(), 1);
    const quote = f.store.snapshot().jobs.operation.quote,
      liability = f.store.snapshot().jobs.operation.reservedMicros;
    const resumed = await executeFalOperation({
      ...f.options,
      quoteInput: { units: 0, durationSec: 1, multiplier: 0.001 },
    });
    assert.deepEqual(resumed.metadata.quote, quote);
    assert.equal(f.submits(), 1);
    assert.equal(f.store.snapshot().jobs.operation.reservedMicros, liability);
    const before = readFileSync(f.store.file);
    await assert.rejects(
      executeFalOperation({ ...f.options, input: { prompt: "offline", duration: "15" } }),
      /different inputs/,
    );
    assert.deepEqual(readFileSync(f.store.file), before);
  } finally {
    f.cleanup();
  }
});
test("absent physical/quote duration stays unknown/manual-bound without assuming schema defaults", async () => {
  const f = fixture();
  try {
    const opts = { ...f.options, input: { prompt: "offline" }, quoteInput: undefined };
    const unknown = await executeFalOperation({ ...opts, dryRun: true });
    assert.equal(unknown.metadata.quote, null);
    assert.equal(unknown.metadata.executable, false);
    const manual = await executeFalOperation({ ...opts, maxCostUsd: 1 });
    assert.equal((manual.metadata.quote as PriceQuote).confidence, "user-bound");
    assert.equal(f.store.summary().reservedUsd, 1);
    assert.equal(f.submits(), 1);
  } finally {
    f.cleanup();
  }
});
