import { writeBudgetBrief } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { falFixtureManifest, useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { buildCatalogEntry, loadCatalog } from "../src/lib/models/fal-catalog";
import {
  buildFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "../src/lib/providers/fal-operations";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { openApiRoutes, type FalApiModel } from "../src/lib/providers/fal-openapi";
import { unsupportedKeywords } from "../src/lib/providers/json-schema-validate";
import { extractArtifacts, assertTrustedFiles, primaryKind } from "../src/lib/providers/fal-results";
import { executeFalOperation } from "../src/lib/jobs/execution";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { inspectAsset } from "../src/lib/assets/inspect";
import { AssetSpecSchema, AssetPlanSchema } from "../src/types/pipeline";
import { prepareModernAssetDispatch } from "../src/lib/providers/modern-asset";
import { dispatchAsset } from "../src/lib/asset-dispatcher";
import pins from "../src/lib/models/fal-verified.json";

const repository = process.cwd();
const image = "https://fal.media/reference.png",
  model = "https://fal.media/reference.glb";
const file = {
  url: "https://v3.fal.media/files/fixture/cup.glb",
  content_type: "model/gltf-binary",
  file_name: "cup.glb",
};
const cases = [
  {
    endpoint: "meshy/v7.1/image-to-3d",
    input: { image_url: image },
    queuePath: "fal-ai/meshy/v7.1/image-to-3d",
    kinds: ["image", "model3d", "json"],
    result: { model_glb: file, model_urls: { glb: file } },
  },
  {
    endpoint: "meshy/v7.1/text-to-3d",
    input: { prompt: "Cup" },
    queuePath: "fal-ai/meshy/v7.1/text-to-3d",
    kinds: ["image", "model3d", "json"],
    result: { model_glb: file, model_urls: { glb: file }, prompt: "Cup" },
  },
  {
    endpoint: "meshy/rigging",
    input: { model_url: model },
    queuePath: "fal-ai/meshy/rigging",
    kinds: ["model3d", "json"],
    result: { rigged_character_glb: file },
  },
  {
    endpoint: "fal-ai/hunyuan-3d/v3.1/smart-topology",
    input: { input_file_url: model },
    queuePath: "fal-ai/hunyuan-3d-smart-topology/v3.1/smart-topology",
    kinds: ["model3d", "json"],
    result: { model_glb: file, model_urls: { glb: file } },
  },
  {
    endpoint: "meshy/n1/retexture",
    input: { model_url: model, image_style_url: image },
    queuePath: "fal-ai/meshy/n1/retexture",
    kinds: ["image", "model3d", "json"],
    result: { model_glb: file, model_urls: { glb: file } },
  },
];
const worlds = ["alibaba/abot-world-0", "robbyant/lingbot-world-2", "vast/eden-live-14b-game"];
function apiModel(endpoint: string): FalApiModel {
  return JSON.parse(
    readFileSync(
      path.join(
        import.meta.dirname,
        "fixtures/fal-catalog/schemas",
        `${falFixtureManifest.endpoints[endpoint]!.sha256}.json`,
      ),
      "utf8",
    ),
  );
}
const catalog = useTempFalCatalog(
  [...cases.map((item) => item.endpoint), ...worlds].map((endpoint) => {
    const entry = buildCatalogEntry(apiModel(endpoint), { today: "2026-11-15", verifiedPins: pins.pins });
    return {
      endpoint,
      patch: { ...entry, schema: { ...entry.schema!, sha256: falFixtureManifest.endpoints[endpoint]!.sha256 } },
    };
  }),
);

for (const item of cases)
  test(`3D contract: ${item.endpoint}`, () => {
    const plan = buildFalOperation({ endpoint: item.endpoint, input: item.input });
    assert.equal(plan.tier, "verified");
    assert.equal(plan.transport, "queue");
    assert.equal(plan.executable, true);
    assert.deepEqual(plan.outputKinds, item.kinds);
    assert.equal(openApiRoutes(apiModel(item.endpoint))!.submitPath.slice(1), item.queuePath);
    assert.deepEqual(quoteInputForPlan(plan, plan.input), {
      units: 1,
      ...(item.endpoint.endsWith("text-to-3d") ? { inputCharacters: 3 } : {}),
    });
    const snapshot = resolveFalSnapshotForPlan(plan);
    assert.deepEqual(unsupportedKeywords(snapshot.input, snapshot.schemas), []);
    assert.deepEqual(unsupportedKeywords(snapshot.output, snapshot.schemas), []);
    const fileSchema = snapshot.schemas.File!;
    assert.equal(fileSchema.type, "object");
    assert.equal(fileSchema.properties!.url!.type, "string");
    assert.ok(fileSchema.properties!.content_type);
    assert.ok(fileSchema.required?.includes("url"));
    assert.match(JSON.stringify(snapshot.output) + JSON.stringify(snapshot.schemas), /#\/components\/schemas\/File/);
    const result = validateFalOperationResult(item.endpoint, item.result);
    const extracted = extractArtifacts({ schema: snapshot.output, components: snapshot.schemas }, result);
    assert.equal(primaryKind(extracted), "model3d");
    assert.ok(extracted.files.length);
    assert.ok(extracted.files.every((artifact) => artifact.kind === "model3d"));
    assertTrustedFiles(extracted.files);
    const key = item.endpoint === "meshy/rigging" ? "rigged_character_glb" : "model_glb";
    assert.throws(
      () => validateFalOperationResult(item.endpoint, { ...item.result, [key]: { content_type: "model/gltf-binary" } }),
      /url.*required|allowed schema alternatives/,
    );
    assert.throws(
      () => buildFalOperation({ endpoint: item.endpoint, input: { ...item.input, invented: 1 } }),
      /unsupported field/,
    );
  });

test("Meshy animation dependency, action bounds and N1 texture constraints", () => {
  for (const item of cases.slice(0, 2)) {
    const build = (extra: Record<string, unknown>) =>
      buildFalOperation({ endpoint: item.endpoint, input: { ...item.input, ...extra } });
    assert.throws(() => build({ enable_animation: true }), /requires enable_rigging/);
    for (const animation_action_id of [-1, 697])
      assert.throws(() => build({ enable_rigging: true, enable_animation: true, animation_action_id }), /\[0, 696\]/);
    for (const animation_action_id of [0, 696])
      assert.doesNotThrow(() => build({ enable_rigging: true, enable_animation: true, animation_action_id }));
    assert.doesNotThrow(() => build({ animation_action_id: 697 }));
    for (const extra of [{ texture_prompt: "red" }, { enable_pbr: true }, { topology: "quad" }])
      assert.throws(() => build({ texture_model: "meshy-n1", ...extra }), /N1 rejects/);
    assert.doesNotThrow(() => build({ texture_model: "meshy-n1", topology: "quad", should_remesh: false }));
    assert.doesNotThrow(() =>
      build({
        texture_model: "meshy-n1",
        enable_pbr: true,
        ...(item.endpoint.endsWith("text-to-3d") ? { mode: "preview" } : { should_texture: false }),
      }),
    );
    if (item.endpoint.endsWith("image-to-3d"))
      assert.throws(
        () =>
          buildFalOperation({
            endpoint: item.endpoint,
            input: item.input,
            context: { media: { [image]: { bytes: 21 * 1024 * 1024 } } },
          }),
        /bytes exceeds/,
      );
  }
});

test("standalone rigging rejects invalid animation actions and non-GLB models", () => {
  const endpoint = "meshy/rigging";
  assert.throws(
    () =>
      buildFalOperation({ endpoint, input: { model_url: model, enable_animation: true, animation_action_id: 697 } }),
    /\[0, 696\]/,
  );
  assert.throws(() => buildFalOperation({ endpoint, input: { model_url: "https://fal.media/model.obj" } }), /GLB/);
  assert.doesNotThrow(() =>
    buildFalOperation({ endpoint, input: { model_url: "https://fal.media/download?id=character" } }),
  );
  assert.ok(
    buildFalOperation({ endpoint, input: { model_url: "https://fal.media/download.php?id=character" } }).warnings.some(
      (warning) => /verify the format/.test(warning),
    ),
  );
  const plan = buildFalOperation({
    endpoint,
    input: { model_url: model, enable_animation: true, animation_action_id: 0 },
  });
  assert.ok(plan.warnings.some((warning) => /humanoid/.test(warning)));
});

test("N1 retexturing requires exactly one reference form", () => {
  const endpoint = "meshy/n1/retexture";
  for (const input of [
    { model_url: model },
    { model_url: model, image_style_url: image, multiview_image_urls: [image] },
  ])
    assert.throws(() => buildFalOperation({ endpoint, input }), /exactly one/);
  assert.doesNotThrow(() =>
    buildFalOperation({ endpoint, input: { model_url: model, multiview_image_urls: [image] } }),
  );
  for (const multiview_image_urls of [[], Array(5).fill(image)])
    assert.throws(
      () => buildFalOperation({ endpoint, input: { model_url: model, multiview_image_urls } }),
      /alternatives|exactly one/,
    );
});

test("smart topology enforces the described format and measured 200MB limit", () => {
  const endpoint = "fal-ai/hunyuan-3d/v3.1/smart-topology",
    input = { input_file_url: model };
  assert.throws(
    () => buildFalOperation({ endpoint, input, context: { media: { [model]: { bytes: 200_000_001 } } } }),
    /200MB/,
  );
  assert.doesNotThrow(() =>
    buildFalOperation({ endpoint, input, context: { media: { [model]: { bytes: 200_000_000 } } } }),
  );
  assert.throws(
    () => buildFalOperation({ endpoint, input: { input_file_url: "https://fal.media/model.fbx" } }),
    /GLB or OBJ/,
  );
  assert.ok(buildFalOperation({ endpoint, input }).warnings.some((warning) => /measure bytes/.test(warning)));
});

for (const endpoint of worlds)
  test(`worlds remain discovered: ${endpoint} has no output contract`, () => {
    const plan = buildFalOperation({ endpoint, input: { sdp: "v=0\r\n" } });
    assert.equal(plan.tier, "discovered");
    assert.deepEqual(plan.outputKinds, ["json"]);
    const snapshot = resolveFalSnapshotForPlan(plan);
    const name = snapshot.output.$ref!.split("/").at(-1)!;
    assert.deepEqual(snapshot.schemas[name], {});
    assert.deepEqual(validateFalOperationResult(endpoint, {}), {});
    assert.deepEqual(extractArtifacts({ schema: snapshot.output, components: snapshot.schemas }, {}).files, []);
    assert.throws(() => buildFalOperation({ endpoint, input: {} }), /sdp.*required/);
  });

/** GLB 2.0 triangle, material and two-key translation animation, with embedded BIN data. */
function glb(): Buffer {
  const values = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0, 0, 1, 0];
  const binary = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => binary.writeFloatLE(value, index * 4));
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    materials: [{}],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, material: 0 }] }],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 36 },
      { buffer: 0, byteOffset: 36, byteLength: 8 },
      { buffer: 0, byteOffset: 44, byteLength: 24 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 2, type: "SCALAR", min: [0], max: [1] },
      { bufferView: 2, componentType: 5126, count: 2, type: "VEC3" },
    ],
    animations: [
      { samplers: [{ input: 1, output: 2 }], channels: [{ sampler: 0, target: { node: 0, path: "translation" } }] },
    ],
  };
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
  const header = Buffer.alloc(20);
  header.write("glTF");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + binary.length, 8);
  header.writeUInt32LE(padded.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binary.length);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, binHeader, binary]);
}
async function workspace(fn: (root: string) => Promise<void> | void) {
  const root = mkdtempSync(path.join(tmpdir(), "fal-3d-"));
  process.chdir(root);
  mkdirSync("public/projects/demo/pipeline", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  writeBudgetBrief("public/projects/demo");
  try {
    await fn(root);
  } finally {
    process.chdir(repository);
    rmSync(root, { recursive: true, force: true });
  }
}

test("inspectAsset nonMedia counts meshes, nodes, materials and animation in a valid GLB", () =>
  workspace((root) => {
    const target = path.join(root, "triangle.glb");
    writeFileSync(target, glb());
    const inspected = inspectAsset(target, { nonMedia: true });
    assert.equal(inspected.kind, "model3d");
    assert.equal(inspected.mime, "model/gltf-binary");
    assert.deepEqual(
      [
        inspected.media.meshCount,
        inspected.media.nodeCount,
        inspected.media.materialCount,
        inspected.media.hasAnimations,
      ],
      [1, 1, 1, true],
    );
  }));

test("executeFalOperation publishes GLB as a model3d asset and resumes without a second submit", () =>
  workspace(async () => {
    const item = cases[0]!,
      plan = buildFalOperation({ endpoint: item.endpoint, input: item.input });
    const snapshot = resolveFalSnapshotForPlan(plan);
    let submits = 0,
      downloads = 0;
    const options = {
      projectId: "demo",
      endpoint: plan.endpoint,
      model: plan.endpoint,
      input: plan.input,
      output: "public/projects/demo/assets/3d/cup.glb",
      mediaKind: "model3d" as const,
      queuePath: item.queuePath,
      operationId: "3d:publication",
      maxCostUsd: 0.5,
      resultSchema: { schema: snapshot.output, components: snapshot.schemas },
      provider: {
        submit: async () => ({ requestId: `fake-${++submits}` }),
        inspect: async () => ({ state: "completed" as const, result: item.result }),
      },
      fetch: (async (url: Parameters<typeof fetch>[0]) => {
        assert.equal(String(url), file.url);
        downloads++;
        return new Response(new Uint8Array(glb()));
      }) as typeof fetch,
      validateResult: (result: Record<string, unknown>) => {
        validateFalOperationResult(plan.endpoint, result);
      },
      quoteInput: quoteInputForPlan(plan, plan.input),
    };
    const result = await executeFalOperation(options);
    assert.equal(result.metadata.state, "published");
    assert.deepEqual(result.outputs, [options.output]);
    assert.deepEqual(readFileSync(options.output), glb());
    assert.equal(readAssetRegistry("demo").assets[0]?.kind, "model3d");
    assert.deepEqual((await executeFalOperation(options)).outputs, result.outputs);
    assert.equal(submits, 1);
    assert.equal(downloads, 1);
    const foreign = { ...item.result, model_glb: { ...file, url: "https://partner.example/cup.glb" }, model_urls: {} };
    const extracted = extractArtifacts(options.resultSchema, validateFalOperationResult(plan.endpoint, foreign));
    assert.throws(() => assertTrustedFiles(extracted.files), /trusted/);
    const refused = await executeFalOperation({
      ...options,
      operationId: "3d:untrusted",
      output: "public/projects/demo/assets/3d/foreign.glb",
      provider: { ...options.provider, inspect: async () => ({ state: "completed" as const, result: foreign }) },
    });
    assert.equal(refused.metadata.state, "failed");
    assert.equal(downloads, 1);
  }));

test("AssetSpec ai-3d dispatches through generate:model to fake queue, publication and completed asset plan", () =>
  workspace(async (root) => {
    const item = cases[0]!;
    const asset = AssetSpecSchema.parse({
      id: "cup",
      kind: "ai-3d",
      source: "fal-model",
      targetPath: "assets/3d/cup.glb",
      status: "pending",
      metadata: { operationRequest: { endpoint: item.endpoint, input: item.input }, maxCostUsd: 0.5 },
    });
    assert.equal(AssetSpecSchema.safeParse({ ...asset, source: "manual" }).success, false);
    assert.equal(AssetSpecSchema.safeParse({ ...asset, source: "fal-model", metadata: {} }).success, false);
    writeFileSync(
      "public/projects/demo/pipeline/asset-plan.json",
      JSON.stringify(AssetPlanSchema.parse({ assets: [asset] })),
    );
    const hook = path.join(root, "fake-provider.mjs"),
      calls = path.join(root, "calls.jsonl");
    writeFileSync(
      hook,
      `import {appendFileSync} from 'node:fs';
    process.env.FAL_KEY='offline-fixture';
    globalThis.fetch=async (input, init)=>{
      const url=String(input); appendFileSync(${JSON.stringify(calls)}, JSON.stringify({url,method:init?.method??'GET'})+'\\n');
      if(url===${JSON.stringify(`https://queue.fal.run/${item.endpoint}`)} && init?.method==='POST') return Response.json({request_id:'fake-cli'});
      if(url===${JSON.stringify(`https://queue.fal.run/${item.queuePath}/requests/fake-cli/status`)}) return Response.json({status:'COMPLETED'});
      if(url===${JSON.stringify(`https://queue.fal.run/${item.queuePath}/requests/fake-cli`)}) return Response.json(${JSON.stringify(item.result)});
      if(url===${JSON.stringify(file.url)}) return new Response(Buffer.from(${JSON.stringify(glb().toString("base64"))},'base64'));
      throw new Error('Unexpected offline fetch '+url);
    };`,
    );
    const run = (args: string[], dryRun = false) => {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          path.join(repository, "node_modules/tsx/dist/loader.mjs"),
          "--import",
          path.join(repository, "tests/helpers/fal-no-network.ts"),
          ...(dryRun ? [] : ["--import", hook]),
          path.join(repository, args[0]!),
          ...args.slice(1),
          ...(dryRun ? ["--dry-run"] : []),
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            AGENTBROS_NO_DOTENV: "1",
            PATH: process.env.PATH,
            AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
            AGENTBROS_FAL_PRICES: process.env.AGENTBROS_FAL_PRICES,
            AGENTBROS_FAL_CATALOG_DIR: catalog.catalogDir,
            AGENTBROS_FAL_SCHEMA_CACHE: catalog.cacheDir,
          },
        },
      );
      assert.equal(child.status, 0, child.stdout + child.stderr);
      assert.equal(child.stdout.trim().split("\n").length, 1);
      return JSON.parse(child.stdout);
    };
    const args = prepareModernAssetDispatch(asset, "demo", path.resolve("public/projects/demo", asset.targetPath));
    const dry = run(args, true);
    assert.equal(dry.metadata.mediaKind, "model3d");
    assert.equal(dry.metadata.queuePath, item.queuePath);
    const result = await dispatchAsset(
      { projectId: "demo", assetId: "cup" },
      { dispatch: async (projectId, passed, output) => run(prepareModernAssetDispatch(passed, projectId, output)) },
    );
    assert.equal(result.ok, true);
    assert.deepEqual(readFileSync("public/projects/demo/assets/3d/cup.glb"), glb());
    assert.equal(readAssetRegistry("demo").assets[0]?.kind, "model3d");
    const plan = AssetPlanSchema.parse(
      JSON.parse(readFileSync("public/projects/demo/pipeline/asset-plan.json", "utf8")),
    );
    assert.equal(plan.assets[0]?.status, "done");
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 4);
    assert.equal(loadCatalog().get(item.endpoint)?.tier, "verified");
  }));
