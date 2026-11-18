import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AssetSpecSchema } from "../src/types/pipeline";
import { prepareModernAssetDispatch } from "../src/lib/providers/modern-asset";
import { dispatchAsset } from "../src/lib/asset-dispatcher";
import { spawnSync } from "node:child_process";
import { importAsset } from "../src/lib/assets/registry";
const original = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "modern-assets-"));
process.chdir(root);
test.after(() => {
  process.chdir(original);
  rmSync(root, { recursive: true, force: true });
});
const image = {
  id: "modern",
  kind: "ai-image",
  source: "fal-model",
  status: "pending",
  targetPath: "assets/images/modern.png",
  metadata: {
    maxCostUsd: 1,
    operationRequest: {
      family: "nano-banana-2.1",
      operation: "text-to-image",
      input: { prompt: "Test editorial illustration" },
    },
  },
};
test("modern source requires strict request and media asset kind", () => {
  assert.equal(AssetSpecSchema.safeParse(image).success, true);
  assert.equal(AssetSpecSchema.safeParse({ ...image, metadata: {} }).success, false);
  assert.equal(AssetSpecSchema.safeParse({ ...image, kind: "sfx" }).success, false);
  assert.equal(
    AssetSpecSchema.safeParse({
      ...image,
      metadata: { operationRequest: { ...image.metadata.operationRequest, typo: true } },
    }).success,
    false,
  );
});
test("exact modern operation persisted with stable paid identity and never legacy model alias", () => {
  const asset = AssetSpecSchema.parse(image);
  const target = path.resolve("public/projects/demo", asset.targetPath);
  const args = prepareModernAssetDispatch(asset, "demo", target);
  assert.equal(args[0], "scripts/generate-model.ts");
  assert.ok(!args.includes("--model"));
  assert.equal(args[args.indexOf("--max-cost-usd") + 1], "1");
  const file = args[args.indexOf("--request") + 1]!;
  assert.equal(JSON.parse(readFileSync(file, "utf8")).family, "nano-banana-2.1");
  assert.deepEqual(prepareModernAssetDispatch(asset, "demo", target), args);
  assert.throws(() => prepareModernAssetDispatch({ ...asset, kind: "ai-video" }, "demo", target), /media kind/);
  assert.throws(() => prepareModernAssetDispatch(asset, "demo", path.resolve("../escape.png")), /outside|escapes/i);
  assert.throws(
    () =>
      prepareModernAssetDispatch(
        {
          ...asset,
          metadata: {
            ...asset.metadata,
            operationRequest: {
              ...image.metadata.operationRequest,
              input: { prompt: "invalid field test", unknown_field: true },
            },
          },
        },
        "demo",
        target,
      ),
    /unsupported field/,
  );
});
test("modern pipeline pending result remains running until validated published file", async () => {
  const directory = "public/projects/pending/pipeline";
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "asset-plan.json");
  writeFileSync(file, JSON.stringify({ assets: [image] }));
  const pending = await dispatchAsset(
    { projectId: "pending", assetId: "modern" },
    {
      dispatch: async (projectId, asset, target) => {
        const args = prepareModernAssetDispatch(asset, projectId, target);
        return {
          ok: true,
          outputs: [],
          metadata: { operationId: args[args.indexOf("--operation-id") + 1], state: "queued" },
          elapsedMs: 0,
        };
      },
    },
  );
  assert.equal(pending.metadata.pending, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).assets[0].status, "running");
  const done = await dispatchAsset(
    { projectId: "pending", assetId: "modern" },
    {
      dispatch: async (_, __, target) => {
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, "fixture");
        return { ok: true, outputs: [target], metadata: { state: "published" }, elapsedMs: 0 };
      },
    },
  );
  assert.equal(done.ok, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).assets[0].status, "done");
});
test("explicit stream image assets route through the dedicated transport while realtime needs its session contract", () => {
  const stream = AssetSpecSchema.parse({
    ...image,
    metadata: {
      maxCostUsd: 1,
      operationRequest: {
        family: "flux-2",
        variant: "dev",
        operation: "text-to-image",
        transport: "stream",
        input: { prompt: "Local plan" },
      },
    },
  });
  const args = prepareModernAssetDispatch(
    stream,
    "stream-project",
    path.resolve("public/projects/stream-project/assets/image.png"),
  );
  assert.equal(JSON.parse(readFileSync(args[args.indexOf("--request") + 1]!, "utf8")).transport, "stream");
  const realtime = {
    ...stream,
    metadata: {
      operationRequest: {
        family: "flux-2",
        variant: "klein",
        operation: "realtime",
        transport: "realtime",
        input: { image_url: "data:image/png;base64,YQ==", seed: 35 },
      },
    },
  };
  assert.throws(
    () =>
      prepareModernAssetDispatch(
        AssetSpecSchema.parse(realtime),
        "stream-project",
        path.resolve("public/projects/stream-project/assets/realtime.png"),
      ),
    /session/,
  );
});
test("asset-plan accepts verified harness references and preserves immutable IDs for CLI provenance", () => {
  const directory = path.resolve("public/projects/harness");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  const source = path.join(directory, "source.png");
  const generated = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=32x32",
    "-frames:v",
    "1",
    source,
  ]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const imported = importAsset({
    projectId: "harness",
    sourceFile: source,
    provenance: { origin: "agent-harness", tool: "local fixture", billing: { status: "unknown" } },
  });
  const reference = `asset://sha256/${imported.asset.hash}`;
  const asset = AssetSpecSchema.parse({
    ...image,
    metadata: {
      maxCostUsd: 1,
      operationRequest: {
        family: "nano-banana-2.1",
        operation: "edit",
        input: { prompt: "Preserve this object", image_urls: [reference] },
      },
    },
  });
  const args = prepareModernAssetDispatch(asset, "harness", path.join(directory, asset.targetPath));
  const requestFile = args[args.indexOf("--request") + 1]!;
  assert.equal(JSON.parse(readFileSync(requestFile, "utf8")).input.image_urls[0], reference);
  writeFileSync(path.resolve("public", imported.asset.files.original), "corrupt");
  assert.throws(
    () => prepareModernAssetDispatch(asset, "harness", path.join(directory, asset.targetPath)),
    /checksum|size/,
  );
});
