import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import examples from "../docs/examples/modern-asset-plan.json";
import { AssetPlanSchema } from "../src/types/pipeline";
import { buildFalOperation, requireExecutableFalOperation } from "../src/lib/providers/fal-operations";
import { prepareModernAssetDispatch } from "../src/lib/providers/modern-asset";
import { FalOperationRequestSchema } from "../src/types/generation";
import { quote } from "../src/lib/pricing";

test("documented modern asset plans route exact schema-tested unsubmitted media requests", () => {
  const original = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), "production-routing-docs-"));
  process.chdir(root);
  try {
    const plan = AssetPlanSchema.parse(examples);
    assert.equal(plan.assets.length, 3);
    const expected = [
      "openai/gpt-image-2.5/flare/text-to-image",
      "google/nano-banana-2.1",
      "bytedance/seedance-2.5/text-to-video",
    ];
    plan.assets.forEach((asset, index) => {
      const request = FalOperationRequestSchema.parse(asset.metadata?.operationRequest);
      const operation = buildFalOperation(request);
      requireExecutableFalOperation(operation);
      assert.equal(operation.endpoint, expected[index]);
      assert.equal(operation.verification.live, false);
      const args = prepareModernAssetDispatch(
        asset,
        "doc-demo",
        path.resolve("public/projects/doc-demo", asset.targetPath),
      );
      assert.equal(args[0], "scripts/generate-model.ts");
      assert.ok(!args.includes("--model"));
      assert.ok(!args.includes("--max-cost-usd"));
      const file = args[args.indexOf("--request") + 1];
      assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), request);
      const again = prepareModernAssetDispatch(
        asset,
        "doc-demo",
        path.resolve("public/projects/doc-demo", asset.targetPath),
      );
      assert.deepEqual(args, again);
      assert.throws(
        () =>
          buildFalOperation({
            ...request,
            input: { ...request.input, referenceImageUrls: ["https://example.com/legacy.png"] },
          }),
        /unsupported field/,
      );
      assert.throws(
        () =>
          prepareModernAssetDispatch(
            {
              ...asset,
              metadata: { operationRequest: { ...request, input: { ...request.input, unknown_option: true } } },
            },
            "doc-demo",
            path.resolve("public/projects/doc-demo", asset.targetPath),
          ),
        /unsupported field/,
      );
    });
    const unknown = quote({ model: "unpublished-documentation-endpoint", units: 1 });
    assert.equal(unknown.highUsd, null);
    assert.equal(unknown.bounded, false);
  } finally {
    process.chdir(original);
    rmSync(root, { recursive: true, force: true });
  }
});
