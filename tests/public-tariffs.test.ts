import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import test from "node:test";
import { publicTariff } from "../src/lib/models/public-tariffs";
import { findModel, listModels, resolveModelEndpoint } from "../src/lib/models/registry";
import { quote } from "../src/lib/pricing";

test("only independently reviewed exact operations gain dated public provenance", () => {
  assert.equal(listModels().filter((m) => m.pricing.kind !== "unknown").length, 26);
  const endpoint = "openai/gpt-image-2.5/flare/edit";
  assert.deepEqual(publicTariff(endpoint)?.evidence, {
    source: `https://fal.ai/models/${endpoint}`,
    observedAsOf: "2026-10-11",
    kind: "public-model-page",
    unit: "USD per million tokens",
    conditions: publicTariff(endpoint)?.evidence.conditions,
    acceptance: "not-run",
  });
  assert.equal(findModel(endpoint)?.verification.live, false);
  assert.equal(findModel(endpoint)?.capabilities.pricingEvidence !== undefined, true);
  for (const id of [
    "fal-ai/flux-2/edit",
    "fal-ai/flux-2-max",
    "fal-ai/kling-video/v3/4k/text-to-video",
    "bytedance/seedance-2.5/draft/complete",
  ]) {
    assert.equal(findModel(id)?.pricing.kind, "unknown", id);
    assert.equal(publicTariff(id), undefined);
  }
  assert.equal(resolveModelEndpoint("gpt-image-2", "image-edit"), "openai/gpt-image-2/edit");
});
test("public snapshot lookup cannot mutate process-global tariff evidence", () => {
  const endpoint = "google/nano-banana-2.1/edit";
  const first = publicTariff(endpoint)!;
  first.evidence.source = "corrupted";
  assert.match(publicTariff(endpoint)!.evidence.source, /^https:\/\/fal.ai\/models\//);
});
test("new GPT operations calculate complete disjoint token forecasts and reject unpriced categories", () => {
  for (const model of [
    "openai/gpt-image-2.5/flare/text-to-image",
    "openai/gpt-image-2.5/flare/edit",
    "openai/gpt-image-2.5/sunburst/edit",
    "openai/gpt-image-2.6/flare/text-to-image",
    "openai/gpt-image-2.6/flare/edit",
    "openai/gpt-image-2.6/sunburst/edit",
  ]) {
    const result = quote({
      model,
      tokens: {
        textInput: 1000,
        imageInput: 1000,
        imageOutput: 1000,
        cachedTextInput: 1000,
        cachedImageInput: 1000,
        textOutput: 1000,
      },
    });
    assert.equal(result.expectedUsd, 0.0563);
    assert.equal(result.lowUsd, 0.045);
    assert.equal(result.highUsd, 0.0675);
    assert.equal(
      quote({ model, tokens: { textInput: 0, imageInput: 0, imageOutput: 0, thinkingOutput: 1 } }).bounded,
      false,
    );
    assert.equal(quote({ model, width: 1024, height: 1024 }).bounded, false);
  }
});
test("Nano edit bills text and thinking outputs, not a guessed image flat fee or cached rate", () => {
  const model = "google/nano-banana-2.1/edit";
  assert.equal(
    quote({
      model,
      tokens: { textInput: 1000, imageInput: 1000, imageOutput: 1000, textOutput: 1000, thinkingOutput: 1000 },
    }).expectedUsd,
    0.0565,
  );
  assert.equal(
    quote({ model, tokens: { textInput: 0, imageInput: 0, imageOutput: 0, cachedTextInput: 1 } }).bounded,
    false,
  );
});
test("exact Kling operation selects audio and voice conditions without a sibling rate", () => {
  for (const [model, off, on, voice] of [
    ["fal-ai/kling-video/v3/pro/text-to-video", 0.56, 0.84, 0.98],
    ["fal-ai/kling-video/v3/standard/text-to-video", 0.42, 0.63, 0.77],
    ["fal-ai/kling-video/v3/standard/image-to-video", 0.42, 0.63, 0.77],
  ] as const) {
    assert.equal(quote({ model, durationSec: 5, generateAudio: false }).expectedUsd, off);
    assert.equal(quote({ model, durationSec: 5, generateAudio: true }).expectedUsd, on);
    assert.equal(quote({ model, durationSec: 5, generateAudio: true, voiceControl: true }).expectedUsd, voice);
    assert.equal(quote({ model, durationSec: 5 }).highUsd, voice);
    assert.throws(
      () => quote({ model, durationSec: 5, generateAudio: false, voiceControl: true }),
      /requires generated audio/,
    );
  }
});
test("Seedance region and resolution use exact page rates, output counts and reference conditions", () => {
  const base = { width: 1280, height: 720, durationSec: 10, resolution: "720p" as const };
  for (const model of ["bytedance/seedance-2.5/text-to-video", "bytedance/seedance-2.5/image-to-video"]) {
    assert.equal(quote({ model, ...base }).expectedUsd, 4.6224);
    assert.equal(quote({ model, ...base, units: 2 }).expectedUsd, 9.2448);
    assert.equal(quote({ model, ...base, inputVideoDurationSec: 8 }).bounded, false);
    assert.equal(quote({ model, ...base, resolution: "1080p" }).bounded, false);
  }
  for (const model of ["bytedance/seedance-2.5/us/text-to-video", "bytedance/seedance-2.5/us/image-to-video"]) {
    assert.equal(quote({ model, ...base }).expectedUsd, 5.5469);
    assert.equal(quote({ model, width: 1920, height: 1080, durationSec: 5, resolution: "1080p" }).expectedUsd, 6.8235);
    assert.equal(quote({ model, ...base, inputVideoDurationSec: 8 }).bounded, false);
  }
  assert.equal(
    quote({ model: "bytedance/seedance-2.5/us/reference-to-video", ...base, inputVideoDurationSec: 8 }).expectedUsd,
    5.9907,
  );
  assert.equal(quote({ model: "bytedance/seedance-2.5/us/reference-to-video", ...base }).expectedUsd, 5.5469);
  assert.equal(quote({ model: "bytedance/seedance-2.5/us/reference-to-video", durationSec: 10 }).bounded, false);
});
