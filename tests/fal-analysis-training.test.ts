import { writeBudgetBrief } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import {
  buildFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "../src/lib/providers/fal-operations";
import { openApiRoutes } from "../src/lib/providers/fal-openapi";
import { exampleFromSchema, unsupportedKeywords } from "../src/lib/providers/json-schema-validate";
import { extractArtifacts, primaryKind } from "../src/lib/providers/fal-results";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { executeFalNonMedia, type NonMediaOptions } from "../src/lib/jobs/nonmedia";
import { OperationStore } from "../src/lib/jobs/store";
import { COMMANDS } from "../src/mcp/catalog";
import type { OutputKind } from "../src/types/fal-catalog";

const repo = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(repo, "tests/fixtures/fal-catalog");
const manifest = JSON.parse(readFileSync(path.join(fixtures, "manifest.json"), "utf8")) as {
  endpoints: Record<string, { sha256: string; category: string }>;
  verifiedSnapshots: Record<string, { sha256: string; category: string }>;
};
const trainer = "blackforestlabs/flux-3/klein/base/trainer";
const image = "https://fal.media/frame.png",
  video = "https://fal.media/clip.mp4",
  archive = "https://fal.media/images.zip";
const usage = { input_tokens: 24, output_tokens: 87 };
const contracts: {
  endpoint: string;
  kinds: OutputKind[];
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  route: string;
  quote: Record<string, unknown>;
  kind: OutputKind;
}[] = [
  {
    endpoint: "fal-ai/florence-2-large/caption",
    kinds: ["json"],
    input: { image_url: image },
    result: { results: "Text appears in the frame." },
    route: "fal-ai/florence-2-large/caption",
    quote: { units: 1 },
    kind: "json",
  },
  {
    endpoint: "fal-ai/bytedance/seed/v2/mini",
    kinds: ["text", "json"],
    input: { prompt: "Describe", image_urls: [image], video_urls: [video] },
    result: {
      output: "Text appears in frame 3.",
      messages: [{ role: "assistant", content: "Text appears in frame 3." }],
    },
    route: "fal-ai/bytedance/seed/v2/mini",
    quote: { units: 1, inputCharacters: 8 },
    kind: "text",
  },
  {
    endpoint: "bria/ad-delayer",
    kinds: ["json"],
    input: { image_url: image },
    result: { layers: [{ name: "Heading", bounds: [0, 0, 200, 100] }] },
    route: "bria/ad-delayer",
    quote: { units: 1 },
    kind: "json",
  },
  {
    endpoint: "bria/fibo-lite/generate/structured_prompt",
    kinds: ["json"],
    input: { prompt: "Describe" },
    route: "bria/fibo-lite/generate/structured_prompt",
    quote: { units: 1, inputCharacters: 8 },
    kind: "json",
  },
  {
    endpoint: "nvidia/nemotron-3-5-super/video",
    kinds: ["text", "json"],
    input: { prompt: "Describe", video_url: video },
    result: { output: "Text in frame 3.", usage },
    route: "fal-ai/nemotron-3-5-super/video",
    quote: { units: 1, inputCharacters: 8 },
    kind: "text",
  },
  {
    endpoint: "nvidia/nemotron-3-5-super/vision",
    kinds: ["text", "json"],
    input: { prompt: "Describe", image_url: image },
    result: { output: "Text on the sign.", usage },
    route: "fal-ai/nemotron-3-5-super/vision",
    quote: { units: 1, inputCharacters: 8 },
    kind: "text",
  },
  {
    endpoint: trainer,
    kinds: ["weights", "file"],
    input: { images_data_url: archive, trigger_phrase: "subject" },
    result: {
      lora_file: { url: "https://fal.media/lora.safetensors", file_name: "lora.safetensors" },
      config_file: { url: "https://fal.media/config.json", content_type: "application/json" },
    },
    route: "fal-ai/flux-3-image-klein-trainer",
    quote: { units: 1 },
    kind: "weights",
  },
];
const temp = useTempFalCatalog(
  contracts.map((row) => {
    const record = manifest.verifiedSnapshots[row.endpoint] ?? manifest.endpoints[row.endpoint]!;
    return {
      endpoint: row.endpoint,
      cached: false,
      patch: {
        tier: "verified" as const,
        transport: row.endpoint === trainer ? ("training" as const) : ("queue" as const),
        outputs: { kinds: row.kinds, fields: [] },
        schema: { sha256: record.sha256, asOf: "2026-11-15", source: "https://api.fal.ai/v1/models", cached: true },
      },
    };
  }),
);
for (const row of contracts) {
  const record = manifest.verifiedSnapshots[row.endpoint] ?? manifest.endpoints[row.endpoint]!;
  copyFileSync(
    path.join(fixtures, "schemas", `${record.sha256}.json`),
    path.join(temp.cacheDir, `${record.sha256}.json`),
  );
  test(`offline analysis/training contract: ${row.endpoint}`, () => {
    const plan = buildFalOperation({ endpoint: row.endpoint, input: row.input });
    const snapshot = resolveFalSnapshotForPlan(plan);
    assert.deepEqual(unsupportedKeywords(snapshot.input, snapshot.schemas), []);
    assert.deepEqual(unsupportedKeywords(snapshot.output, snapshot.schemas), []);
    assert.deepEqual(plan.outputKinds, row.kinds);
    const apiModel = JSON.parse(readFileSync(path.join(temp.cacheDir, `${record.sha256}.json`), "utf8"));
    assert.equal(openApiRoutes(apiModel)?.submitPath.slice(1), row.route);
    assert.deepEqual(quoteInputForPlan(plan, plan.input), row.quote);
    const result = row.result ?? (exampleFromSchema(snapshot.output, snapshot.schemas) as Record<string, unknown>);
    validateFalOperationResult(row.endpoint, result);
    const extracted = extractArtifacts({ schema: snapshot.output, components: snapshot.schemas }, result);
    assert.equal(primaryKind(extracted), row.kind);
    if (row.endpoint === trainer)
      assert.deepEqual(
        extracted.files.map((file) => file.kind),
        ["weights", "file"],
      );
    else assert.deepEqual(extracted.data, result);
    if (row.endpoint !== "bria/ad-delayer") assert.throws(() => validateFalOperationResult(row.endpoint, {}));
  });
}

test("analysis guards refuse ignored media, unsupported formats and measured video limits", () => {
  const seed = contracts[1]!,
    nemotron = contracts[4]!,
    vision = contracts[5]!;
  for (const input of [
    { image_urls: Array(7).fill(image) },
    { video_urls: Array(4).fill(video) },
    { image_urls: ["https://fal.media/file.gif"] },
    { video_urls: ["https://fal.media/file.webm"] },
    { thinking: "disabled", reasoning_effort: "high" },
  ])
    assert.throws(() => buildFalOperation({ endpoint: seed.endpoint, input: { ...seed.input, ...input } }));
  for (const media of [{ durationSec: 121 }, { width: 3841 }, { height: 3841 }, { width: 3840, height: 2161 }])
    assert.throws(
      () =>
        buildFalOperation({
          endpoint: nemotron.endpoint,
          input: nemotron.input,
          context: { media: { [video]: media } },
        }),
      /minutes|pixel/,
    );
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: nemotron.endpoint,
        input: { ...nemotron.input, video_url: "https://fal.media/file.mov" },
      }),
    /mp4/,
  );
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: vision.endpoint,
        input: { ...vision.input, image_url: "https://fal.media/file.webp" },
      }),
    /png/,
  );
  assert.throws(() => buildFalOperation({ endpoint: trainer, input: { images_data_url: image } }), /zip/);
  assert.ok(
    buildFalOperation({ endpoint: trainer, input: { images_data_url: archive } }).warnings.some((w) =>
      w.includes("captions"),
    ),
  );
  buildFalOperation({
    endpoint: nemotron.endpoint,
    input: nemotron.input,
    context: { media: { [video]: { durationSec: 120, width: 3840, height: 2160 } } },
  });
});

async function project(fn: (root: string) => Promise<void>) {
  const previous = process.cwd(),
    root = mkdtempSync(path.join(tmpdir(), "analysis-training-"));
  process.chdir(root);
  mkdirSync("public/projects/demo/pipeline", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  writeBudgetBrief("public/projects/demo");
  try {
    await fn(root);
  } finally {
    process.chdir(previous);
    rmSync(root, { recursive: true, force: true });
  }
}
const tensors = () => {
  const header = Buffer.from(JSON.stringify({ weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([size, header, Buffer.alloc(4)]);
};
function trainingOptions(): NonMediaOptions {
  const plan = buildFalOperation({ endpoint: trainer, input: contracts[6]!.input });
  const snapshot = resolveFalSnapshotForPlan(plan);
  return {
    projectId: "demo",
    endpoint: trainer,
    model: trainer,
    input: plan.input,
    output: "training",
    kind: "training",
    operationId: "training:1",
    quoteInput: { units: 1 },
    resultSchema: { schema: snapshot.output, components: snapshot.schemas },
    queuePath: contracts[6]!.route,
    validateResult: (result) => validateFalOperationResult(trainer, result),
  };
}

test("catalogue training requires a bound before reservation, then reserves and retains its queue route", () =>
  project(async () => {
    let submits = 0;
    const options = {
      ...trainingOptions(),
      provider: {
        submit: async () => {
          submits++;
          return { requestId: "r" };
        },
        inspect: async () => ({ state: "queued" as const }),
      },
    };
    assert.equal((await executeFalNonMedia({ ...options, dryRun: true })).metadata.executable, false);
    await assert.rejects(executeFalNonMedia(options), /Unknown price/);
    assert.equal(existsSync("public/projects/demo/pipeline/operations.json"), false);
    assert.equal(submits, 0);
    const result = await executeFalNonMedia({ ...options, maxCostUsd: 2 });
    assert.equal(result.metadata.state, "queued");
    assert.equal(submits, 1);
    const store = new OperationStore("demo");
    assert.equal(store.summary().reservedUsd, 2);
    assert.equal(store.snapshot().jobs["training:1"]!.queueRoute, options.queuePath);
    await executeFalNonMedia({ ...options, maxCostUsd: undefined });
    assert.equal(submits, 1);
    assert.equal(store.summary().reservedUsd, 2);
    await assert.rejects(
      executeFalNonMedia({ ...options, operationId: "wrong-kind", kind: "voice", maxCostUsd: 2 }),
      /matching operation kind/,
    );
  }));

test("schema-driven training publishes valid safetensors and config JSON with immutable resume", () =>
  project(async () => {
    let submits = 0,
      downloads = 0;
    const bytes = tensors(),
      options = trainingOptions();
    const provider = {
      submit: async () => ({ requestId: `r-${++submits}` }),
      inspect: async () => ({
        state: "completed" as const,
        result: {
          ...contracts[6]!.result!,
          config_file: { url: "https://fal.media/opaque-config", content_type: "application/json" },
        },
      }),
    };
    const request = (async (url: string | URL | Request) => {
      downloads++;
      return String(url).includes("config")
        ? new Response('{"rank":16}', { headers: { "content-type": "application/json" } })
        : new Response(new Uint8Array(bytes));
    }) as typeof fetch;
    const first = await executeFalNonMedia({ ...options, maxCostUsd: 2, provider, fetch: request });
    assert.equal(first.metadata.state, "published");
    assert.equal(downloads, 2);
    const result = JSON.parse(readFileSync(first.outputs[0]!, "utf8"));
    assert.deepEqual(
      result.artifacts.map((entry: { kind: string }) => entry.kind),
      ["safetensors", "config"],
    );
    assert.deepEqual(readFileSync(result.artifacts[0].path), bytes);
    assert.equal(result.provenance.endpoint, trainer);
    assert.equal(result.provenance.billing, "unreconciled");
    assert.deepEqual((await executeFalNonMedia({ ...options, provider, fetch: request })).outputs, first.outputs);
    assert.equal(submits, 1);
    assert.equal(downloads, 2);
    writeFileSync(result.artifacts[0].path, "tampered");
    await assert.rejects(executeFalNonMedia({ ...options, provider, fetch: request }), /artifact.*changed/);
  }));

test("schema-driven training rejects unsafe weights and hosts while retaining the paid result", () =>
  project(async () => {
    for (const [i, file] of [
      { url: "https://fal.media/lora.pkl", file_name: "lora.pkl" },
      { url: "https://evil.invalid/lora.safetensors", file_name: "lora.safetensors" },
      { url: "https://fal.media/lora.safetensors", file_name: "lora.safetensors" },
    ].entries()) {
      const result = { ...contracts[6]!.result, lora_file: file };
      const run = await executeFalNonMedia({
        ...trainingOptions(),
        operationId: `invalid:${i}`,
        assetId: `invalid-${i}`,
        maxCostUsd: 1,
        provider: {
          submit: async () => ({ requestId: "r" }),
          inspect: async () => ({ state: "completed" as const, result }),
        },
        fetch: (async () => new Response("pickle executable")) as typeof fetch,
      });
      assert.equal(run.metadata.state, "failed");
      assert.deepEqual(run.outputs, []);
    }
    assert.equal(new OperationStore("demo").summary().reservedUsd, 3);
  }));

test("tracked FLUX trainer keeps its original fields, quote and publication despite a supplied schema", () =>
  project(async () => {
    const endpoint = "fal-ai/flux-2-trainer",
      bytes = tensors();
    const result = {
      diffusers_lora_file: { url: "https://fal.media/lora.safetensors" },
      config_file: { url: "https://fal.media/config.json" },
    };
    const run = await executeFalNonMedia({
      ...trainingOptions(),
      endpoint,
      model: endpoint,
      input: { image_data_url: archive },
      maxCostUsd: 0.5,
      resultSchema: { schema: { type: "object", properties: {} } },
      provider: {
        submit: async () => ({ requestId: "legacy" }),
        inspect: async () => ({ state: "completed" as const, result }),
      },
      validateResult: (data) => validateFalOperationResult(endpoint, data),
      fetch: (async (url: string | URL | Request) =>
        String(url).endsWith(".json")
          ? new Response('{"rank":16}')
          : new Response(new Uint8Array(bytes))) as typeof fetch,
    });
    assert.equal(run.metadata.state, "published");
    assert.equal(new OperationStore("demo").summary().reservedUsd, 0.5);
    assert.equal(JSON.parse(readFileSync(run.outputs[0]!, "utf8")).artifacts.length, 2);
  }));

test("model:result CLI reads bounded summary without writes, checks identity and rejects traversal", () =>
  project(async (root) => {
    const file = "public/projects/demo/pipeline/model-results/analysis:1.json";
    mkdirSync(path.dirname(file), { recursive: true });
    const value = {
      version: 1,
      endpoint: contracts[1]!.endpoint,
      kind: "text",
      operationId: "analysis:1",
      data: { output: "x".repeat(2500), usage },
      files: [],
      untrustedUrls: [{ path: "/source", url: "https://evil.invalid/source" }],
    };
    writeFileSync(file, JSON.stringify(value));
    const before = readFileSync(file);
    const run = (operationId: string) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          path.join(repo, "node_modules/tsx/dist/loader.mjs"),
          path.join(repo, "scripts/model-result.ts"),
          "--project",
          "demo",
          "--operation-id",
          operationId,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            AGENTBROS_NO_DOTENV: "1",
            PATH: process.env.PATH,
            AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
          },
        },
      );
    const child = run("analysis:1");
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    const summary = JSON.parse(child.stdout).metadata;
    assert.equal(summary.textExcerpt.length, 2000);
    assert.deepEqual(summary.dataKeys, ["output", "usage"]);
    assert.deepEqual(summary.untrustedUrls, value.untrustedUrls);
    assert.deepEqual(summary.files, []);
    assert.equal(summary.endpoint, value.endpoint);
    assert.equal(summary.kind, "text");
    assert.deepEqual(readFileSync(file), before);
    assert.notEqual(run("../escape").status, 0);
    assert.notEqual(run("missing").status, 0);
    writeFileSync(file, JSON.stringify({ ...value, operationId: "different" }));
    assert.notEqual(run("analysis:1").status, 0);
    const tool = COMMANDS.find((command) => command.name === "model_result")!;
    assert.equal(tool.paid, "local");
    assert.equal(tool.readOnly, true);
  }));

test("catalogue publication extracts multiple weights/configs and ignores unrelated media", () =>
  project(async () => {
    const bytes = tensors();
    let downloads = 0;
    const result = {
      weights: [
        { url: "https://fal.media/a.safetensors", file_name: "a.safetensors" },
        { url: "https://fal.media/b.safetensors", file_name: "b.safetensors" },
      ],
      config_files: [
        { url: "https://fal.media/config-opaque" },
        { url: "https://fal.media/opaque", content_type: "application/json" },
      ],
      preview: { url: "https://fal.media/preview.png", content_type: "image/png" },
    };
    const run = await executeFalNonMedia({
      ...trainingOptions(),
      maxCostUsd: 1,
      resultSchema: { schema: { type: "object", additionalProperties: true } },
      validateResult: undefined,
      provider: {
        submit: async () => ({ requestId: "many" }),
        inspect: async () => ({ state: "completed" as const, result }),
      },
      fetch: (async (url: string | URL | Request) => {
        downloads++;
        return String(url).endsWith(".safetensors") ? new Response(new Uint8Array(bytes)) : new Response('{"rank":16}');
      }) as typeof fetch,
    });
    assert.equal(run.metadata.state, "published");
    assert.equal(downloads, 4);
    const published = JSON.parse(readFileSync(run.outputs[0]!, "utf8"));
    assert.deepEqual(
      published.artifacts.map((entry: { kind: string }) => entry.kind),
      ["safetensors", "safetensors", "config", "config"],
    );
  }));

test("generate:model endpoint-form training dry-run uses the nonmedia branch without spending", () =>
  project(async (root) => {
    writeFileSync("request.json", JSON.stringify({ endpoint: trainer, input: contracts[6]!.input }));
    const run = (bound: string[]) =>
      spawnSync(
        process.execPath,
        [
          "--import",
          path.join(repo, "node_modules/tsx/dist/loader.mjs"),
          path.join(repo, "scripts/generate-model.ts"),
          "--project",
          "demo",
          "--request",
          "request.json",
          "--output",
          "training",
          "--dry-run",
          ...bound,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            AGENTBROS_NO_DOTENV: "1",
            PATH: process.env.PATH,
            AGENTBROS_FAL_CATALOG_DIR: temp.catalogDir,
            AGENTBROS_FAL_SCHEMA_CACHE: temp.cacheDir,
            AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
          },
        },
      );
    const refused = run([]);
    assert.equal(refused.status, 0, refused.stderr);
    const offline = JSON.parse(refused.stdout).metadata;
    assert.equal(offline.kind, "training");
    assert.equal(offline.executable, false);
    assert.equal(offline.quote, null);
    const bounded = run(["--max-cost-usd", "2"]);
    assert.equal(bounded.status, 0, bounded.stderr);
    const allowed = JSON.parse(bounded.stdout).metadata;
    assert.equal(allowed.kind, "training");
    assert.equal(allowed.executable, true);
    assert.equal(allowed.quote.highUsd, 2);
    assert.equal(allowed.queuePath, contracts[6]!.route);
    assert.equal(existsSync("public/projects/demo/pipeline/operations.json"), false);
  }));
