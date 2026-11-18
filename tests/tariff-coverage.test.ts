import assert from "node:assert/strict";
import test from "node:test";
import { quote } from "../src/lib/pricing";
import { publicTariff } from "../src/lib/models/public-tariffs";
import { findModel } from "../src/lib/models/registry";
const rows = [
  ["fal-ai/kling-video/v3/turbo/pro/text-to-video", 0.7],
  ["fal-ai/kling-video/v3/turbo/pro/image-to-video", 0.7],
  ["fal-ai/kling-video/v3/turbo/standard/text-to-video", 0.56],
  ["fal-ai/kling-video/v3/turbo/standard/image-to-video", 0.56],
  ["fal-ai/kling-video/o3/pro/video-to-video/reference", 0.84],
] as const;
test("five exact generated-second tariffs retain independent dated provenance and arithmetic", () => {
  for (const [model, cost] of rows) {
    const result = quote({ model, durationSec: 5 });
    assert.equal(result.expectedUsd, cost);
    assert.equal(result.highUsd, cost);
    assert.equal(result.lowUsd, cost);
    assert.equal(result.source, `https://fal.ai/models/${model}`);
    assert.equal(result.asOf, "2026-10-12");
    assert.equal(publicTariff(model)?.evidence.unit, "USD per generated second");
    assert.equal(findModel(model)?.verification.live, false);
    assert.equal(quote({ model, durationSec: 5, units: 5, multiplier: 2 }).expectedUsd, cost * 2);
  }
  assert.equal(quote({ model: "fal-ai/kling-video/create-voice", units: 1 }).expectedUsd, 0.007);
});
test("generated seconds are never assumed, contradicted or turned into a zero executable commitment", () => {
  for (const [model] of rows) {
    for (const quantities of [{}, { units: 5 }, { durationSec: 5, units: null }])
      assert.equal(quote({ model, ...quantities }).bounded, false);
    for (const quantities of [
      { durationSec: 0 },
      { durationSec: -1 },
      { durationSec: NaN },
      { durationSec: Infinity },
      { durationSec: 5, units: 0 },
      { durationSec: 5, units: 4 },
      { durationSec: 5, multiplier: 0 },
      { durationSec: 5, multiplier: NaN },
      { durationSec: 5, multiplier: -1 },
      { durationSec: 5, multiplier: Infinity },
      { durationSec: Number.MIN_VALUE },
    ])
      assert.throws(() => quote({ model, ...quantities }));
  }
  // Legacy fixed entries intentionally preserve historical per-unit/default/zero semantics.
  assert.equal(quote({ model: "fal-ai/kling-video/create-voice" }).expectedUsd, 0.007);
  assert.equal(quote({ model: "fal-ai/kling-video/create-voice", units: 0 }).expectedUsd, 0);
  for (const model of [
    "fal-ai/flux-2",
    "fal-ai/flux-2-max",
    "fal-ai/flux-2-pro/edit",
    "fal-ai/kling-video/v3/pro/motion-control",
    "fal-ai/kling-video/v3/standard/motion-control",
    "fal-ai/kling-video/o3/pro/video-to-video/edit",
  ])
    assert.equal(quote({ model, durationSec: 5, width: 1024, height: 1024 }).bounded, false);
});
