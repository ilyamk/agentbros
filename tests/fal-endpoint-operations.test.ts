import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import {
  buildFalOperation,
  FalOperationError,
  requireExecutableFalOperation,
  validateFalOperationResult,
} from "../src/lib/providers/fal-operations";
import { resolveCatalogSnapshot } from "../src/lib/models/fal-catalog";
import { exampleFromSchema, type JsonSchema, type SchemaComponents } from "../src/lib/providers/json-schema-validate";

const url = "https://example.com/reference.png";
useTempFalCatalog([
  { endpoint: "meshy/v7/image-to-3d", patch: { outputs: { kinds: ["model3d", "image"], fields: ["model_mesh"] } } },
  { endpoint: "fal-ai/aura-sr", patch: { retiresAt: "2027-01-01", replacement: "fal-ai/birefnet" } },
  { endpoint: "fal-ai/birefnet", patch: { status: "gone" } },
  { endpoint: "bytedance/seedream/v5/lite/edit" },
  { endpoint: "fal-ai/wizper", cached: false },
  { endpoint: "kotoba-technologies/kotoba-sts/v1/realtime_voice", patch: { schema: null, transport: "realtime" } },
]);
const code = (expected: string) => (error: unknown) => error instanceof FalOperationError && error.code === expected;

test("catalogue endpoint whose public ID differs from its OpenAPI path plans as a catalogue operation", () => {
  const plan = buildFalOperation({ endpoint: "meshy/v7/image-to-3d", input: { image_url: url } });
  assert.equal(plan.endpoint, "meshy/v7/image-to-3d");
  assert.equal(plan.family, "catalog");
  assert.equal(plan.variant, "");
  assert.equal(plan.operation, "image-to-3d");
  assert.equal(plan.category, "image-to-3d");
  assert.equal(plan.tier, "discovered");
  assert.deepEqual(plan.outputKinds, ["model3d", "image"]);
  assert.equal(plan.transport, "queue");
  assert.equal(plan.region, "global");
  assert.equal(plan.executable, true);
  assert.match(plan.schemaSource, /endpoint_id=meshy%2Fv7%2Fimage-to-3d/);
  assert.equal(plan.retiresAt, undefined);
  assert.throws(
    () => buildFalOperation({ endpoint: "meshy/v7/image-to-3d", input: { image_url: url, invented: 1 } }),
    /unsupported field/,
  );
  assert.throws(() => buildFalOperation({ endpoint: "meshy/v7/image-to-3d", input: {} }), /image_url: required/);
  // Top-level file limits (max_file_size) bind once metadata is known.
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: "meshy/v7/image-to-3d",
        input: { image_url: url },
        context: { media: { [url]: { bytes: 21 * 1024 * 1024 } } },
      }),
    /bytes exceeds/,
  );
});

test("retiring endpoint warns with its replacement; gone endpoint is planned but not executable", () => {
  const retiring = buildFalOperation({ endpoint: "fal-ai/aura-sr", input: { image_url: url } });
  assert.ok(retiring.warnings.includes("Endpoint retires at 2027-01-01; replacement: fal-ai/birefnet."));
  assert.equal(retiring.retiresAt, "2027-01-01");
  assert.equal(retiring.replacement, "fal-ai/birefnet");
  assert.equal(retiring.executable, true);
  const gone = buildFalOperation({ endpoint: "fal-ai/birefnet", input: { image_url: url } });
  assert.equal(gone.executable, false);
  assert.equal(gone.verification.localAdapter, false);
  assert.ok(gone.warnings.some((warning) => /gone/.test(warning)));
  assert.throws(() => requireExecutableFalOperation(gone), code("UNSUPPORTED_OPERATION"));
});

test("missing cache, realtime, unknown endpoint and transport mismatch are refused before submit", () => {
  assert.throws(
    () => buildFalOperation({ endpoint: "fal-ai/wizper", input: { audio_url: url } }),
    (error: unknown) =>
      code("SCHEMA_NOT_CACHED")(error) && /pnpm fal:sync --schemas fal-ai\/wizper/.test((error as Error).message),
  );
  assert.throws(
    () => buildFalOperation({ endpoint: "kotoba-technologies/kotoba-sts/v1/realtime_voice", input: {} }),
    code("UNSUPPORTED_OPERATION"),
  );
  assert.throws(
    () => buildFalOperation({ endpoint: "fal-ai/not-in-the-index", input: {} }),
    code("UNSUPPORTED_OPERATION"),
  );
  assert.throws(
    () => buildFalOperation({ endpoint: "meshy/v7/image-to-3d", transport: "stream", input: { image_url: url } }),
    code("UNSUPPORTED_OPERATION"),
  );
  assert.throws(() => validateFalOperationResult("fal-ai/not-in-the-index", {}), /Unknown result endpoint/);
  assert.throws(() => validateFalOperationResult("fal-ai/wizper", {}), code("SCHEMA_NOT_CACHED"));
});

test("result validation works for catalogue endpoints", () => {
  const snapshot = resolveCatalogSnapshot("meshy/v7/image-to-3d")!;
  const result = exampleFromSchema(snapshot.output as JsonSchema, snapshot.schemas as SchemaComponents) as Record<
    string,
    unknown
  >;
  assert.deepEqual(validateFalOperationResult("meshy/v7/image-to-3d", { ...result, provider_extra: true }), {
    ...result,
    provider_extra: true,
  });
  assert.throws(() => validateFalOperationResult("meshy/v7/image-to-3d", {}), /required/);
});

test("endpoint form of a tracked snapshot keeps legacy routing, guards and region rules", () => {
  const legacy = buildFalOperation({ family: "gpt-image-2.5", operation: "text-to-image", input: { prompt: "Card" } });
  const byEndpoint = buildFalOperation({
    endpoint: "openai/gpt-image-2.5/flare/text-to-image",
    input: { prompt: "Card" },
  });
  assert.deepEqual(byEndpoint, legacy);
  assert.equal(byEndpoint.family, "gpt-image-2.5");
  assert.equal(byEndpoint.tier, "verified");
  assert.equal(byEndpoint.category, "text-to-image");
  assert.deepEqual(byEndpoint.outputKinds, ["image"]);
  assert.throws(
    () => buildFalOperation({ endpoint: "openai/gpt-image-2.5/flare/edit", input: { prompt: "Edit", image_urls: [] } }),
    /at least one/,
  );
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: "fal-ai/kling-video/v3/4k/text-to-video",
        region: "global",
        input: { prompt: "Scene" },
      }),
    code("REGION_RESTRICTED"),
  );
  assert.equal(
    buildFalOperation({ endpoint: "fal-ai/kling-video/v3/4k/text-to-video", input: { prompt: "Scene" } }).region,
    "singapore",
  );
  assert.deepEqual(
    buildFalOperation({ family: "kling-v3", operation: "text-to-video", input: { prompt: "Scene" } }).outputKinds,
    ["video"],
  );
  assert.deepEqual(
    buildFalOperation({
      family: "flux-2",
      operation: "train",
      variant: "dev",
      input: { image_data_url: "https://example.com/d.zip" },
    }).outputKinds,
    ["weights"],
  );
});
