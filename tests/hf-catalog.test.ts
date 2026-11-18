import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildHiggsfieldEntry, findHiggsfieldFamily, parseHiggsfieldCatalogue } from "../src/lib/models/hf-catalogue";
import { listWorkflowLinks, parseHiggsfieldWorkflowPage } from "../src/lib/models/hf-docs";
import {
  buildCatalogEntry,
  findCatalogEntry,
  writeCatalog,
  writeCachedApiModel,
  higgsfieldSchemaSha256,
  resolveProviderSnapshot,
  snapshotFromHiggsfieldDoc,
  summariseInputs,
} from "../src/lib/models/fal-catalog";
import { runHiggsfieldSync } from "../src/lib/models/hf-sync";
import {
  resolveSchema,
  unsupportedKeywords,
  validateJsonSchema,
  type JsonSchema,
} from "../src/lib/providers/json-schema-validate";
import operationSnapshots from "../src/lib/providers/schemas/fal-operations.json";
import type { FalApiModel } from "../src/lib/providers/fal-openapi";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";

const fixtures = path.resolve("tests/fixtures/higgsfield");
const today = "2026-11-15";
const readDoc = (name: string) => readFileSync(path.join(fixtures, "docs", name), "utf8");
const workflows = readdirSync(path.join(fixtures, "docs"))
  .sort()
  .flatMap((name) => {
    const url = `https://docs.higgsfield.ai/docs/${name.replaceAll("_", "/")}`;
    const parsed = parseHiggsfieldWorkflowPage(readDoc(name), url);
    return parsed ? [parsed] : [];
  });
const workflow = (endpoint: string) => workflows.find((row) => row.endpoint === endpoint)!;
const catalogue = parseHiggsfieldCatalogue(
  JSON.parse(readFileSync(path.join(fixtures, "catalog-models.json"), "utf8")).results,
);
const seedance = "bytedance/seedance-2.5/reference-to-video";

// Explicit expectations for every recorded workflow, independent of the production classifier.
const expectedCategories = {
  "higgsfield/ads-studio/v1.0": "text-to-image",
  "higgsfield/cinema-studio/4.0": "image-to-video",
  "higgsfield/genjutsu/motion-transfer/v1.0": "video-to-video",
  "higgsfield/genjutsu/object-swap/v1.0": "video-to-video",
  "higgsfield/genjutsu/restyle/v1.0": "video-to-video",
  "xai/grok-imagine-image-2.0": "text-to-image",
  "xai/grok-imagine-video/v1.5/reference-to-video": "image-to-video",
  "minimax/hailuo-2.3/standard/image-to-video": "image-to-video",
  "minimax/hailuo-2.3/standard/text-to-video": "text-to-video",
  "alibaba/happy-horse/v1.1/image-to-video": "image-to-video",
  "alibaba/happy-horse/v1.1/reference-to-video": "image-to-video",
  "alibaba/happy-horse/v1.1/text-to-video": "text-to-video",
  "alibaba/happy-horse/image-to-video": "image-to-video",
  "alibaba/happy-horse/reference-to-video": "image-to-video",
  "alibaba/happy-horse/text-to-video": "text-to-video",
  "ideogram/v4.0": "text-to-image",
  "kling-video/v2.5-turbo/pro/image-to-video": "image-to-video",
  "kling-video/v2.5-turbo/pro/text-to-video": "text-to-video",
  "kling-video/v2.5-turbo/standard/image-to-video": "image-to-video",
  "kling-video/motion-control/pro": "video-to-video",
  "kling-video/motion-control/std": "video-to-video",
  "kling-video/v2.6/pro/image-to-video": "image-to-video",
  "kling-video/v2.6/pro/text-to-video": "text-to-video",
  "kling-video/v3/motion-control/pro": "video-to-video",
  "kling-video/v3/motion-control/std": "video-to-video",
  "kling-video/v3.0/4k/image-to-video": "image-to-video",
  "kling-video/v3.0/4k/text-to-video": "text-to-video",
  "kling-video/v3.0/pro/image-to-video": "image-to-video",
  "kling-video/v3.0/pro/text-to-video": "text-to-video",
  "kling-video/v3.0/std/image-to-video": "image-to-video",
  "kling-video/v3.0/std/text-to-video": "text-to-video",
  "kling-video/v3.0-turbo/image-to-video": "image-to-video",
  "kling-video/v3.0-turbo/text-to-video": "text-to-video",
  "kling-video/o3/first-last-frame": "image-to-video",
  "kling-video/o3/image-reference": "image-to-video",
  "kling-video/o3/video-edit": "video-to-video",
  "kling-video/o3/video-reference": "video-to-video",
  "kling-video/omni/first-last-frame": "image-to-video",
  "kling-video/omni/image-reference": "image-to-video",
  "kling-video/omni/video-edit": "video-to-video",
  "kling-video/omni/video-reference": "video-to-video",
  "lightricks/ltx-2.5/image-to-video/fast": "image-to-video",
  "lightricks/ltx-2.5/image-to-video/pro": "image-to-video",
  "lightricks/ltx-2.5/text-to-video/fast": "text-to-video",
  "lightricks/ltx-2.5/text-to-video/pro": "text-to-video",
  "marketing-studio/image/flare": "text-to-image",
  "marketing-studio/image": "text-to-image",
  "marketing-studio/image/sunburst": "text-to-image",
  "minimax/h3/image-to-video": "image-to-video",
  "minimax/h3/reference-to-video": "image-to-video",
  "minimax/h3/text-to-video": "text-to-video",
  "pixverse/v6/image-to-video": "image-to-video",
  "pixverse/v6/text-to-video": "text-to-video",
  "alibaba/qwen-image-3/edit": "image-to-image",
  "alibaba/qwen-image-3/text-to-image": "text-to-image",
  "recraft/v4.1/pro/text-to-image": "text-to-image",
  "recraft/v4.1/utility/pro/text-to-image": "text-to-image",
  "recraft/v4.1/utility/text-to-image": "text-to-image",
  "recraft/v4.1/text-to-image": "text-to-image",
  "bytedance/seedance-2.5/image-to-video": "image-to-video",
  "bytedance/seedance-2.5/reference-to-video": "image-to-video",
  "bytedance/seedance-2.5/text-to-video": "text-to-video",
  "bytedance/seedance-2.5/video-edit": "video-to-video",
  "bytedance/seedance-2.5/video-extend": "video-to-video",
  "bytedance/seedance-2.0/image-to-video": "image-to-video",
  "bytedance/seedance-2.0/reference-to-video": "image-to-video",
  "bytedance/seedance-2.0/text-to-video": "text-to-video",
  "higgsfield-ai/soul/v2/standard": "text-to-image",
  "higgsfield-ai/soul/cinema": "text-to-image",
  "v1/custom-references": "training",
  "higgsfield-ai/soul/standard": "text-to-image",
  "wan/v2.6/image-to-video": "image-to-video",
  "wan/v2.6/reference-to-video": "video-to-video",
  "wan/v2.6/text-to-video": "text-to-video",
  "wan/v2.7/image-to-video": "image-to-video",
  "wan/v2.7/reference-to-video": "image-to-video",
  "wan/v2.7/text-to-video": "text-to-video",
  "alibaba/wan-3.0-prime/image-to-video": "image-to-video",
  "alibaba/wan-3.0-prime/reference-to-video": "image-to-video",
  "alibaba/wan-3.0-prime/text-to-video": "text-to-video",
  "alibaba/wan-3.0/image-to-video": "image-to-video",
  "alibaba/wan-3.0/reference-to-video": "image-to-video",
  "alibaba/wan-3.0/text-to-video": "text-to-video",
  "z-image/turbo": "text-to-image",
} as const;

test("all 84 workflow pages parse, with unique endpoints and usage notes", () => {
  assert.equal(workflows.length, 84);
  assert.equal(new Set(workflows.map((row) => row.endpoint)).size, 84);
  for (const row of workflows) {
    assert.ok(row.title && row.family && row.docsUrl, row.endpoint);
    assert.ok(row.usageNotes.length, row.endpoint);
    assert.ok(row.schema.properties, row.endpoint);
    assert.ok(
      row.usageNotes.every((note) => !/\\[_{}]/.test(note)),
      row.endpoint,
    );
  }
  assert.equal(
    parseHiggsfieldWorkflowPage(
      readDoc("models_seedance-2-5.md"),
      "https://docs.higgsfield.ai/docs/models/seedance-2-5.md",
    ),
    undefined,
  );
});

test("Genjutsu's schema retains required media, bounds and resolution enum", () => {
  const entry = buildHiggsfieldEntry(workflow("higgsfield/genjutsu/motion-transfer/v1.0"), undefined, { today });
  assert.deepEqual(
    entry.inputs.find((field) => field.name === "image_urls"),
    { name: "image_urls", type: "array", required: true, min: 1, max: 8, media: "image", array: true },
  );
  assert.equal(entry.inputs.find((field) => field.name === "video_url")?.required, true);
  assert.deepEqual(entry.inputs.find((field) => field.name === "resolution")?.enum, ["720p", "480p", "1080p"]);
});

test("Seedance 2.5 retains integer duration, nested if/else and optional reference summaries", () => {
  const row = workflow(seedance);
  const entry = buildHiggsfieldEntry(row, undefined, { today });
  assert.deepEqual(
    entry.inputs.find((field) => field.name === "duration"),
    { name: "duration", type: "integer", required: false, min: 4, max: 30, default: 5 },
  );
  assert.ok(row.schema.if && row.schema.else);
  assert.ok(entry.inputs.filter((field) => field.media).every((field) => !field.required));
  assert.deepEqual(unsupportedKeywords(row.schema, {}), []);
});

test("Soul 2 and Soul ID keep their separate generation and training contracts", () => {
  const soul = buildHiggsfieldEntry(workflow("higgsfield-ai/soul/v2/standard"), undefined, { today });
  assert.equal(soul.category, "text-to-image");
  assert.equal(soul.inputs.find((field) => field.name === "prompt")?.required, true);
  const training = buildHiggsfieldEntry(workflow("v1/custom-references"), undefined, { today });
  assert.equal(training.category, "training");
  assert.equal(training.transport, "training");
  assert.deepEqual(training.inputs.find((field) => field.name === "model_version")?.enum, ["v1", "v2", "cinema"]);
});

test("Soul ID local definitions resolve in the shared validator", () => {
  const row = workflow("v1/custom-references");
  const snapshot = snapshotFromHiggsfieldDoc({
    version: 1,
    endpoint: row.endpoint,
    title: row.title,
    usageNotes: row.usageNotes,
    asOf: today,
    schema: row.schema,
  });
  assert.deepEqual(unsupportedKeywords(snapshot.input, snapshot.schemas), []);
  validateJsonSchema(
    snapshot.input,
    {
      name: "Character",
      model_version: "v2",
      input_images: [{ type: "image_url", image_url: "https://example.com/image.jpg" }],
    },
    { components: snapshot.schemas },
  );
  assert.throws(
    () =>
      validateJsonSchema(
        snapshot.input,
        {
          name: "Character",
          model_version: "unknown",
          input_images: [{ type: "image_url", image_url: "https://example.com/image.jpg" }],
        },
        { components: snapshot.schemas },
      ),
    /expected one of/,
  );
});

test("every fixture endpoint matches its explicit expected category, including required-video override", () => {
  assert.deepEqual(workflows.map((row) => row.endpoint).sort(), Object.keys(expectedCategories).sort());
  for (const row of workflows) {
    const entry = buildHiggsfieldEntry(row, findHiggsfieldFamily(row.endpoint, catalogue, workflows), { today });
    assert.equal(entry.category, expectedCategories[row.endpoint as keyof typeof expectedCategories], row.endpoint);
    assert.equal(entry.provider, "higgsfield");
    assert.equal(entry.price, null);
    assert.equal(entry.tier, "discovered");
  }
  const row = {
    ...workflow(seedance),
    endpoint: "example/text-to-video",
    schema: { type: "object", properties: { video_url: { type: "string" } }, required: ["video_url"] },
  };
  assert.equal(buildHiggsfieldEntry(row, undefined, { today }).category, "video-to-video");
});

test("navigation collects category and family links without footer recommendations", () => {
  assert.equal(listWorkflowLinks(readDoc("models_video-generation.md")).length, 22);
  assert.equal(listWorkflowLinks(readDoc("models_image-generation.md")).length, 14);
  assert.equal(listWorkflowLinks(readDoc("models_seedance-2-5.md")).length, 5);
});

test("catalogue retains family metadata, primary pricing and folds workflow products onto mode tags", () => {
  const family = catalogue.byModeId.get("marketing-studio/image")!;
  assert.ok(family.title && family.description && family.company && family.pricing?.primary);
  assert.deepEqual(
    catalogue.workflowTags.get("marketing-studio/image")?.filter((tag) => !tag.startsWith("workflows/")),
    ["graphic-ads", "marketplace-design", "product-shots"],
  );
  assert.ok(
    ![...catalogue.byModeId.keys(), ...catalogue.workflowTags.keys()].some((id) => id.startsWith("higgsfiled/")),
  );
  assert.ok(!catalogue.families.some((row) => row.catalog_type === "workflow"));
  const entry = buildHiggsfieldEntry(workflow(seedance), findHiggsfieldFamily(seedance, catalogue), { today });
  assert.equal(entry.family?.slug, "bytedance-seedance-2-5");
  assert.equal(entry.family?.company, "ByteDance");
  assert.equal(entry.releasedOn, "2026-07-01");
  assert.ok(entry.description);
});

test("non-default Kling variants inherit catalogue metadata through their documented family", () => {
  for (const endpoint of [
    "kling-video/v2.5-turbo/pro/text-to-video",
    "kling-video/v3.0/pro/text-to-video",
    "kling-video/v3.0/4k/image-to-video",
    "kling-video/v3.0-turbo/text-to-video",
  ]) {
    const entry = buildHiggsfieldEntry(workflow(endpoint), findHiggsfieldFamily(endpoint, catalogue, workflows), {
      today,
    });
    assert.equal(entry.family?.company, "Kling", endpoint);
    assert.ok(entry.releasedOn && entry.description, endpoint);
    assert.equal(typeof entry.exclusive, "boolean");
  }
  assert.equal(
    findHiggsfieldFamily("lightricks/ltx-2.5/image-to-video/pro", catalogue, workflows)?.slug,
    "ltx-2-5-pro",
  );
  assert.equal(
    findHiggsfieldFamily("lightricks/ltx-2.5/image-to-video/fast", catalogue, workflows)?.slug,
    "ltx-2-5-fast",
  );
});

test("families without docs are schema-less discovered entries", () => {
  for (const [endpoint, category] of Object.entries({
    "higgsfield/genjutsu-light/motion-transfer/v1.0": "video-to-video",
    "kling-video/v4.0/text-to-video": "text-to-video",
    "kling-video/v4.0-flash/text-to-video": "text-to-video",
    "higgsfield/ai-influencer": "text-to-image",
  })) {
    const entry = buildHiggsfieldEntry(undefined, catalogue.byModeId.get(endpoint), { today, endpoint });
    assert.equal(entry.category, category);
    assert.equal(entry.schema, null);
    assert.equal(entry.tier, "discovered");
    assert.deepEqual(entry.outputs.kinds, [category.includes("video") ? "video" : "image"]);
  }
});

test("verification requires an exact reviewed pin; no automatic promotion or price", () => {
  const row = workflow(seedance),
    sha = higgsfieldSchemaSha256(row.schema);
  for (const hash of [null, "0".repeat(64), sha]) {
    const entry = buildHiggsfieldEntry(row, undefined, {
      today,
      verifiedPins: { [seedance]: { catalogSha256: hash, since: today } },
    });
    assert.equal(entry.tier, hash === sha ? "verified" : "discovered");
    assert.equal(entry.price, null);
  }
});

test("conditional fields appear in summaries without making branch requirements unconditional", () => {
  const row = workflow(seedance);
  const doc = {
    version: 1 as const,
    endpoint: row.endpoint,
    title: row.title,
    usageNotes: [],
    asOf: today,
    schema: {
      type: "object",
      properties: { prompt: { type: "string" } },
      if: { properties: { image_url: { type: "string" } } },
      else: { properties: { duration: { type: "integer", minimum: 4 } }, required: ["duration"] },
    },
  };
  assert.deepEqual(
    summariseInputs(snapshotFromHiggsfieldDoc(doc)).map((field) => [field.name, field.required]),
    [
      ["duration", false],
      ["image_url", false],
      ["prompt", false],
    ],
  );
});

test("Seedance nested conditionals reject missing references and accept image, video and audio references", () => {
  const schema = workflow(seedance).schema;
  assert.throws(() => validateJsonSchema(schema, {}, { components: {} }), /required/);
  for (const key of ["image_urls", "video_urls", "audio_urls"]) {
    validateJsonSchema(schema, { [key]: ["https://example.com/reference"] }, { components: {} });
    assert.throws(() => validateJsonSchema(schema, { [key]: [] }, { components: {} }), /few items/);
  }
  assert.throws(
    () => validateJsonSchema(schema, { audio_urls: ["https://example.com/a"], duration: "5" }, { components: {} }),
    /integer/,
  );
});

test("if predicates allow sibling fields; then/else enforce only the selected branch", () => {
  const schema: JsonSchema = {
    type: "object",
    properties: { mode: { type: "string" }, count: { type: "integer" } },
    if: { required: ["mode"], properties: { mode: { const: "many" } } },
    then: { required: ["count"], properties: { count: { minimum: 2 } } },
    else: { properties: { count: { maximum: 1 } } },
  };
  validateJsonSchema(schema, { mode: "many", count: 2 }, { components: {} });
  validateJsonSchema(schema, { count: 1 }, { components: {} });
  assert.throws(() => validateJsonSchema(schema, { mode: "many" }, { components: {} }), /required/);
  assert.throws(() => validateJsonSchema(schema, { count: 2 }, { components: {} }), /maximum/);
  assert.throws(
    () => validateJsonSchema(schema, { mode: "many", count: 2, surprise: true }, { components: {} }),
    /unsupported/,
  );
  assert.deepEqual(unsupportedKeywords({ if: { then: { unsupported: true } } }, {}), ["unsupported"]);
});

test("provider collision resolves separate schemas and preserves fal-only legacy lookup", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "hf-collision-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fal = useTempFalCatalog([]);
  const recorded = operationSnapshots.find((row) => row.endpoint === seedance)!;
  // The original recorded fal snapshot predates the Platform API fixture manifest.
  const model: FalApiModel = {
    endpoint_id: seedance,
    metadata: { category: "image-to-video" },
    openapi: {
      paths: {
        "/submit": { post: { requestBody: { content: { "application/json": { schema: recorded.input } } } } },
        "/submit/requests/{request_id}": {
          get: { responses: { "200": { content: { "application/json": { schema: recorded.output } } } } },
        },
      },
      components: { schemas: recorded.schemas as unknown as Record<string, Record<string, unknown>> },
    },
  };
  const sha256 = writeCachedApiModel(model, fal.cacheDir);
  writeCatalog(
    [
      buildCatalogEntry(model, {
        today,
        verifiedPins: {},
        schema: { sha256, asOf: today, source: "https://fal.ai/models/seedance", cached: true },
      }),
    ],
    fal.catalogDir,
  );
  const outDir = path.join(root, "catalog"),
    schemaDir = path.join(root, "schemas");
  await runHiggsfieldSync({ fromFixtures: fixtures, outDir, schemaDir, reportFile: path.join(root, "drift.md") });
  const falSnapshot = resolveProviderSnapshot("fal", seedance, { dir: fal.catalogDir, cacheDir: fal.cacheDir })!;
  const hfSnapshot = resolveProviderSnapshot("higgsfield", seedance, { dir: outDir, schemaDir })!;
  const falDuration = (resolveSchema(falSnapshot.input, falSnapshot.schemas).properties as Record<string, JsonSchema>)
    .duration!;
  const hfDuration = (hfSnapshot.input.properties as Record<string, JsonSchema>).duration!;
  assert.equal(hfDuration.type, "integer");
  assert.equal(falDuration.type, "string");
  assert.ok(falDuration.enum?.includes("auto"));
  assert.notEqual(falSnapshot.sha256, hfSnapshot.sha256);
  assert.equal(findCatalogEntry(seedance)?.provider ?? "fal", "fal");
  assert.equal(findCatalogEntry(seedance)?.schema?.sha256, falSnapshot.sha256);
});
