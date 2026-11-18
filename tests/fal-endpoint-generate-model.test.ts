import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { falFixtureManifest, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { buildFalOperation, resolveFalSnapshotForPlan } from "../src/lib/providers/fal-operations";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { primaryKind } from "../src/lib/providers/fal-results";
import { openApiRoutes, type FalApiModel } from "../src/lib/providers/fal-openapi";
import { AssetPlanSchema, AssetSpecSchema } from "../src/types/pipeline";
import { prepareModernAssetDispatch } from "../src/lib/providers/modern-asset";
import { dispatchAsset } from "../src/lib/asset-dispatcher";
import { generationInputHash } from "../src/lib/jobs/runner";
import type { FalAnyRequest } from "../src/types/generation";
import type { OutputKind } from "../src/types/fal-catalog";

const repository = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "endpoint-generate-"));
const url = "https://fal.media/reference.wav";
const cases: { endpoint: string; kind: OutputKind; input: Record<string, unknown> }[] = [
  {
    endpoint: "fal-ai/flux/schnell",
    kind: "image",
    input: { prompt: "A ceramic cup", num_images: 3, image_size: { width: 512, height: 768 } },
  },
  {
    endpoint: "fal-ai/kling-video/v2.6/pro/text-to-video",
    kind: "video",
    input: { prompt: "A moving cup", duration: "5" },
  },
  { endpoint: "meshy/v7/image-to-3d", kind: "model3d", input: { image_url: "https://fal.media/cup.png" } },
  { endpoint: "fal-ai/elevenlabs/tts/turbo-v2.5", kind: "audio", input: { text: "Hello there" } },
  { endpoint: "fal-ai/wizper", kind: "text", input: { audio_url: url } },
  { endpoint: "nvidia/nemotron-3-nano-omni", kind: "text", input: { prompt: "Explain a cup" } },
  { endpoint: "fal-ai/ffmpeg-api/metadata", kind: "json", input: { media_url: url } },
];
const catalog = useTempFalCatalog([
  ...cases.map(({ endpoint, kind }) => ({
    endpoint,
    patch: { outputs: { kinds: kind === "model3d" ? [kind, "image" as const] : [kind], fields: [] } },
  })),
  {
    endpoint: "fal-ai/aura-sr",
    patch: {
      outputs: { kinds: ["image" as const], fields: [] },
      retiresAt: "2027-01-01",
      replacement: "fal-ai/birefnet",
    },
  },
  { endpoint: "fal-ai/birefnet", patch: { outputs: { kinds: ["image" as const], fields: [] } } },
  { endpoint: "bria/fibo-lite/generate/structured_prompt", cached: false },
]);
process.chdir(root);
mkdirSync("public/projects/demo/pipeline", { recursive: true });
writeFileSync("public/projects/demo/project.json", "{}");
test.after(() => {
  process.chdir(repository);
  rmSync(root, { recursive: true, force: true });
});

function dryRun(request: FalAnyRequest, extra: string[] = []) {
  const file = path.join(root, "request.json");
  writeFileSync(file, JSON.stringify(request));
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repository, "node_modules/tsx/dist/loader.mjs"),
      "--import",
      path.join(repository, "tests/helpers/fal-no-network.ts"),
      path.join(repository, "scripts/generate-model.ts"),
      "--request",
      file,
      "--project",
      "demo",
      "--output",
      path.join(root, "public/projects/demo/identity.any"),
      "--dry-run",
      ...extra,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
        AGENTBROS_FAL_CATALOG_DIR: catalog.catalogDir,
        AGENTBROS_FAL_SCHEMA_CACHE: catalog.cacheDir,
      },
    },
  );
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stderr);
  return { status: result.status, envelope: JSON.parse(result.stdout) };
}

for (const { endpoint, kind, input } of cases)
  test(`endpoint CLI routes ${kind}: ${endpoint}`, () => {
    const request = { endpoint, input, context: { media: { [url]: { durationSec: 90 } } } };
    const { status, envelope } = dryRun(request);
    assert.equal(status, 0, JSON.stringify(envelope));
    assert.equal(envelope.ok, true);
    const metadata = envelope.metadata;
    const apiModel = JSON.parse(
      readFileSync(path.join(catalog.cacheDir, `${falFixtureManifest.endpoints[endpoint]!.sha256}.json`), "utf8"),
    ) as FalApiModel;
    assert.equal(metadata.mediaKind, kind);
    assert.equal(metadata.queuePath, openApiRoutes(apiModel)!.submitPath.slice(1));
    if (kind === "model3d") assert.notEqual(metadata.queuePath, endpoint);
    assert.deepEqual(metadata.outputKinds, kind === "model3d" ? [kind, "image"] : [kind]);
    assert.equal(metadata.tier, "discovered");
    assert.ok(metadata.category);
    const plan = buildFalOperation(request);
    assert.deepEqual(metadata.quoteInput, quoteInputForPlan(plan, plan.input, request.context));
    assert.ok(resolveFalSnapshotForPlan(plan).output);
    if (kind === "image")
      assert.deepEqual(metadata.quoteInput, { units: 3, inputCharacters: 13, width: 512, height: 768 });
    if (kind === "video") assert.equal(metadata.quoteInput.durationSec, 5);
    if (kind === "audio") assert.equal(metadata.quoteInput.inputCharacters, 11);
    if (endpoint === "fal-ai/wizper") assert.equal(metadata.quoteInput.inputAudioSec, 90);
  });

test("missing schema preserves provider code and actionable sync detail", () => {
  const { status, envelope } = dryRun({ endpoint: "bria/fibo-lite/generate/structured_prompt", input: {} });
  assert.equal(status, 1);
  assert.equal(envelope.error, "INVALID_INPUT");
  assert.equal(envelope.details.providerCode, "SCHEMA_NOT_CACHED");
  assert.equal(envelope.details.nextAction, "pnpm fal:sync --schemas bria/fibo-lite/generate/structured_prompt");
});

test("dry-run reports the most the project's budget admits, from the brief's first policy, and writes no store", (t) => {
  const brief = path.join(root, "public/projects/demo/pipeline/brief.json");
  writeFileSync(brief, JSON.stringify({ budgetUsd: 0.2 }));
  t.after(() => rmSync(brief, { force: true }));
  const { envelope } = dryRun({ endpoint: "fal-ai/flux/schnell", input: { prompt: "Cup" } });
  assert.equal(envelope.ok, true, JSON.stringify(envelope));
  // Ceiling $0.20 minus the 15% repair reserve.
  assert.equal(envelope.metadata.maxAdmissibleUsd, 0.17);
  assert.equal(existsSync(path.join(root, "public/projects/demo/pipeline/operations.json")), false);
});

test("retirement and replacement appear in dry-run metadata", () => {
  const { envelope } = dryRun({ endpoint: "fal-ai/aura-sr", input: { image_url: "https://fal.media/cup.png" } });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.retiresAt, "2027-01-01");
  assert.equal(envelope.metadata.replacement, "fal-ai/birefnet");
});

const imagePlan = buildFalOperation({ endpoint: "fal-ai/flux/schnell", input: { prompt: "Cup" } });
test("quote quantities count only sent text, explicit dimensions and measured audio", () => {
  const input = {
    text: "abc",
    prompt: "de",
    input: "f",
    script: "ghij",
    previous_text: "excluded",
    audio_url: url,
    image_size: { width: 512, height: 768 },
  };
  const before = structuredClone(input);
  assert.deepEqual(quoteInputForPlan(imagePlan, input, { media: { [url]: { durationSec: 61 } } }), {
    units: 1,
    inputCharacters: 10,
    inputAudioSec: 61,
    width: 512,
    height: 768,
  });
  assert.deepEqual(input, before);
  assert.deepEqual(quoteInputForPlan(imagePlan, {}), { units: 1 });
  assert.deepEqual(
    quoteInputForPlan(imagePlan, { text: "", audio_url: url, image_size: "portrait_4_3", duration: "auto" }),
    { units: 1, inputCharacters: 0 },
  );
});
test("quote quantities support every explicit count and duration spelling without fabricated defaults", () => {
  for (const key of ["num_images", "num_outputs", "num_generations", "n"])
    assert.equal(quoteInputForPlan(imagePlan, { [key]: "3" }).units, 3);
  assert.equal(quoteInputForPlan(imagePlan, { num_images: 2, n: 4 }).units, 2);
  for (const key of ["duration", "duration_seconds", "seconds"])
    assert.deepEqual(quoteInputForPlan(imagePlan, { [key]: "5" }), { durationSec: 5 });
  for (const duration of [undefined, null, "", "auto", "nope", Infinity, 0, -1])
    assert.equal(quoteInputForPlan(imagePlan, { duration }).durationSec, undefined);
  assert.equal(quoteInputForPlan({ ...imagePlan, family: "seedance-2.5" }, { duration: "5", num_outputs: 4 }).units, 1);
  const trackedVideo = { ...imagePlan, family: "kling-v3", outputKinds: ["video" as const] };
  assert.deepEqual(quoteInputForPlan(trackedVideo, {}), { units: null });
  assert.deepEqual(quoteInputForPlan(trackedVideo, { duration: "5" }), { units: 5, durationSec: 5 });
  assert.deepEqual(quoteInputForPlan({ ...trackedVideo, family: "catalog" }, {}), {});
  assert.deepEqual(quoteInputForPlan({ ...imagePlan, outputKinds: ["audio"] }, {}), {});
});

test("catalogue output priority matches extracted-result priority for every kind", () => {
  const kinds: OutputKind[] = ["model3d", "video", "audio", "image", "weights", "file", "text", "json"];
  for (let index = 0; index < kinds.length; index++)
    assert.equal(primaryKind(kinds.slice(index).reverse()), kinds[index]);
  assert.equal(primaryKind([]), undefined);
});

test("endpoint Seedance retains forecast pricing and refuses stale pins during asset preflight", () => {
  const request = {
    endpoint: "bytedance/seedance-2.5/text-to-video",
    input: { prompt: "Local forecast", duration: "10", resolution: "720p" },
  };
  const plan = buildFalOperation(request);
  const videoForecast = {
    version: 1 as const,
    endpoint: plan.endpoint,
    schemaSha256: plan.schemaSha256,
    inputSha256: generationInputHash(plan.input),
    output: {
      kind: "planning-assumption" as const,
      source: "Supplied planned output dimensions",
      width: 1280,
      height: 720,
      durationSec: 10,
      resolution: "720p" as const,
    },
    videoReferences: [],
  };
  const { envelope } = dryRun({ ...request, context: { videoForecast } });
  assert.equal(envelope.ok, true);
  assert.equal(envelope.metadata.quoteInput.units, 1);
  assert.equal(envelope.metadata.quoteInput.width, 1280);
  assert.equal(envelope.metadata.quoteInput.durationSec, 10);
  const asset = AssetSpecSchema.parse({
    id: "forecast",
    kind: "ai-video",
    source: "fal-model",
    targetPath: "assets/videos/forecast.mp4",
    status: "pending",
    metadata: {
      operationRequest: { ...request, context: { videoForecast: { ...videoForecast, inputSha256: "0".repeat(64) } } },
    },
  });
  assert.throws(
    () => prepareModernAssetDispatch(asset, "demo", path.resolve("public/projects/demo", asset.targetPath)),
    /pin mismatch/,
  );
});

for (const [kind, endpoint, input, targetPath] of [
  ["ai-audio", cases[3]!.endpoint, cases[3]!.input, "assets/audio/voice.mp3"],
  ["ai-3d", cases[2]!.endpoint, cases[2]!.input, "assets/3d/cup.glb"],
  ["ai-upscale", "fal-ai/aura-sr", { image_url: "https://fal.media/cup.png" }, "assets/images/large.png"],
  ["ai-upscale", cases[1]!.endpoint, cases[1]!.input, "assets/videos/large.mp4"],
  ["ai-cutout", "fal-ai/birefnet", { image_url: "https://fal.media/cup.png" }, "assets/images/cutout.png"],
] as const)
  test(`asset plan routes ${kind} to ${targetPath}`, async () => {
    const asset = AssetSpecSchema.parse({
      id: targetPath,
      kind,
      source: "fal-model",
      targetPath,
      status: "pending",
      metadata: { operationRequest: { endpoint, input } },
    });
    assert.equal(AssetSpecSchema.safeParse({ ...asset, source: "manual" }).success, false);
    const target = path.resolve("public/projects/demo", targetPath);
    const args = prepareModernAssetDispatch(asset, "demo", target);
    assert.equal(args[0], "scripts/generate-model.ts");
    assert.equal(args[args.indexOf("--output") + 1], target);
    assert.equal(JSON.parse(readFileSync(args[args.indexOf("--request") + 1]!, "utf8")).endpoint, endpoint);
    writeFileSync(
      "public/projects/demo/pipeline/asset-plan.json",
      JSON.stringify(AssetPlanSchema.parse({ assets: [asset] })),
    );
    const pending = await dispatchAsset(
      { projectId: "demo", assetId: asset.id },
      {
        dispatch: async (_project, passed, output) => {
          assert.equal(passed.kind, kind);
          assert.equal(output, target);
          prepareModernAssetDispatch(passed, "demo", output);
          return { ok: true, outputs: [], metadata: { state: "queued" }, elapsedMs: 0 };
        },
      },
    );
    assert.equal(pending.metadata.pending, true);
  });
test("asset kind/output mismatch refuses before persisting a request", () => {
  const asset = AssetSpecSchema.parse({
    id: "mismatch",
    kind: "ai-3d",
    source: "fal-model",
    targetPath: "assets/3d/cup.glb",
    status: "pending",
    metadata: { operationRequest: { endpoint: cases[3]!.endpoint, input: cases[3]!.input } },
  });
  assert.throws(
    () => prepareModernAssetDispatch(asset, "demo", path.resolve("public/projects/demo", asset.targetPath)),
    /media kind/,
  );
  const mixed = {
    ...asset,
    kind: "ai-image" as const,
    targetPath: "assets/images/cup.png",
    metadata: { operationRequest: { endpoint: cases[2]!.endpoint, input: cases[2]!.input } },
  };
  assert.throws(
    () => prepareModernAssetDispatch(mixed, "demo", path.resolve("public/projects/demo", mixed.targetPath)),
    /primary output.*media kind/,
  );
});
