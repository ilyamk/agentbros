import "./helpers/fal-no-network";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { quote, estimate, PRICING } from "../src/lib/pricing";
import { listModels, findModel, resolveModelEndpoint } from "../src/lib/models/registry";
import { logCost, totalUsd, readLedger } from "../src/lib/cli/cost-log";
test("unknown costs and unknown quantity never become zero/free", () => {
  for (const model of ["unknown", "fal:gpt-image-2", "fal:seedance-1-pro", "bytedance/seedance-2.5/draft/complete"]) {
    assert.equal(estimate({ model, units: 1 }).estimatedUsd, null);
    assert.equal(quote({ model }).bounded, false);
    assert.equal(quote({ model }).highUsd, null);
  }
  assert.equal(estimate({ model: "fal:kling-2.5-turbo", units: null }).estimatedUsd, null);
  assert.equal(estimate({ model: "pexels:stock", units: 20 }).estimatedUsd, 0);
});
test("negative, nonfinite values and malformed token forecasts are rejected", () => {
  for (const units of [-1, Infinity, NaN]) assert.throws(() => quote({ model: "pexels:stock", units }), RangeError);
  for (const dimensions of [{ width: 0 }, { height: 1.2 }, { width: 20000 }])
    assert.throws(() => quote({ model: "fal-ai/flux-2-pro", ...dimensions }), RangeError);
  assert.throws(() => quote({ model: "fal:kling-2.5-turbo", multiplier: -2 }), RangeError);
  assert.throws(
    () => quote({ model: "unknown", tokens: { textInput: -1, imageInput: 0, imageOutput: 0 } }),
    RangeError,
  );
  assert.throws(() => quote({ model: "unknown", units: Number.MAX_VALUE }), /precision|finite/);
});
test("fixed legacy aliases and per-operation native audio/voice costs are centralized", () => {
  assert.equal(estimate({ model: "fal:kling-2.5-turbo", units: 5 }).estimatedUsd, 0.35);
  assert.equal(
    quote({ model: "fal:seedance-2-fast", units: 10 }).expectedUsd,
    PRICING["fal:seedance-2-fast"].usdPerUnit! * 10,
  );
  const model = "fal-ai/kling-video/v3/pro/image-to-video";
  assert.equal(quote({ model, units: 5, generateAudio: false }).highUsd, 0.56);
  assert.equal(quote({ model, units: 5, generateAudio: true, voiceControl: true }).highUsd, 0.98);
  assert.throws(() => quote({ model, units: 5, generateAudio: false, voiceControl: true }));
});
test("FLUX megapixel quote preserves documented rounding ambiguity conservatively", () => {
  const model = "fal-ai/flux-2-pro";
  const image = quote({ model, width: 1024, height: 1024 });
  assert.equal(image.expectedUsd, 0.03);
  assert.equal(image.highUsd, 0.045);
  assert.equal(quote({ model, width: 1920, height: 1080 }).expectedUsd, 0.045);
  assert.equal(quote({ model, width: 1920, height: 1080 }).highUsd, 0.06);
  assert.equal(quote({ model }).bounded, false);
});
test("Seedance video reference discount includes both input and output seconds", () => {
  const model = "bytedance/seedance-2.5/reference-to-video";
  const regular = quote({ model, width: 1280, height: 720, resolution: "720p", durationSec: 10 });
  assert.equal(regular.expectedUsd, 4.6224);
  const refs = quote({
    model,
    width: 1280,
    height: 720,
    resolution: "720p",
    durationSec: 10,
    inputVideoDurationSec: 8,
  });
  assert.equal(refs.expectedUsd, 4.9922);
  assert.ok(refs.highUsd! > refs.expectedUsd!);
  assert.equal(quote({ model, width: 1280, height: 720, resolution: "720p", durationSec: 30 }).expectedUsd, 13.8672);
});
test("image token forecasts include caches and text output; absent forecasts stay unbounded", () => {
  const model = "openai/gpt-image-2.5/sunburst/text-to-image";
  assert.equal(quote({ model }).bounded, false);
  const tokenQuote = quote({
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
  assert.equal(tokenQuote.expectedUsd, 0.0563);
  assert.ok(tokenQuote.highUsd! > tokenQuote.expectedUsd!);
  assert.equal(
    quote({
      model: "google/nano-banana-2.1",
      tokens: { textInput: 0, imageInput: 0, imageOutput: 1, cachedTextInput: 2 },
    }).bounded,
    false,
  );
});
test("discovery inventory preserves all transports and separate endpoint operations without pretending integration", () => {
  assert.equal(listModels({ family: "seedance-2.5" }).length, 7);
  assert.equal(listModels({ family: "kling-3" }).length, 12);
  assert.equal(listModels({ family: "kling-o3" }).length, 15);
  assert.ok(listModels({ transport: "stream" }).length > 0);
  assert.ok(listModels({ transport: "training" }).length > 0);
  assert.equal(findModel("fal-ai/flux-2/klein/realtime")?.transport, "session");
  assert.equal(findModel("fal-ai/kling-video/o3/pro/video-to-video/edit")?.operation, "video-edit");
  assert.equal(
    resolveModelEndpoint("fal:seedance-2-fast", "image-to-video"),
    "bytedance/seedance-2.0/fast/image-to-video",
  );
  assert.equal(resolveModelEndpoint("openai/gpt-image-2.5/flare/edit", "text-to-image"), undefined);
  for (const model of listModels()) {
    assert.equal(model.verification.discovery, true);
    assert.equal(model.verification.live, false);
    if (model.verification.schema) {
      assert.equal(typeof model.capabilities.schemaSha256, "string");
      assert.equal(model.verification.localAdapter, true);
    } else assert.equal(model.verification.localAdapter, false);
  }
});
test("ledger and CLI report show unresolved total plus known subtotal, keep estimates out of actual bill", () => {
  const cwd = process.cwd();
  const dir = mkdtempSync(path.join(tmpdir(), "cost-report-"));
  const repo = path.resolve(import.meta.dirname, "..");
  try {
    process.chdir(dir);
    mkdirSync("public/projects/cost/pipeline", { recursive: true });
    const unknown = logCost({ projectId: "cost", service: "fal", model: "unknown", units: 1, unitName: "image" })!;
    assert.equal(unknown.estimatedUsd, null);
    assert.equal(unknown.actualUsd, null);
    logCost({ projectId: "cost", service: "fal", model: "fal:kling-2.5-turbo", units: 5, unitName: "second" });
    assert.equal(totalUsd(readLedger("cost")), null);
    const report = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repo, "node_modules/tsx/dist/loader.mjs"),
        path.join(repo, "scripts/cost-report.ts"),
        "--project",
        "cost",
      ],
      { cwd: dir, encoding: "utf8" },
    );
    assert.equal(report.status, 0, report.stderr);
    const metadata = JSON.parse(report.stdout).metadata;
    assert.equal(metadata.totalUsd, null);
    assert.equal(metadata.knownSubtotalUsd, 0.35);
    assert.equal(metadata.unknownEntries, 1);
    assert.match(readFileSync("public/projects/cost/pipeline/cost-report.md", "utf8"), /total:\*\* Unknown/);
    assert.throws(() => readLedger("../escape"));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
