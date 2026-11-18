import { writeBudgetBrief } from "./helpers/ceiling-grant";
import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  openSync,
  closeSync,
  ftruncateSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  extractArtifacts,
  primaryKind,
  fileKind,
  assertTrustedFiles,
  type ResultSchema,
} from "../src/lib/providers/fal-results";
import { snapshotFromOpenApi, type FalApiModel } from "../src/lib/providers/fal-openapi";
import { executeFalOperation, type ExecutionOptions } from "../src/lib/jobs/execution";
import { createFalJobProvider, createFalRestQueue, validQueueUrl } from "../src/lib/jobs/fal-provider";
import { OperationStore } from "../src/lib/jobs/store";
import type { JobProvider } from "../src/lib/jobs/runner";
import { inspectAsset, inspectGlb, inspectGlbFile } from "../src/lib/assets/inspect";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { AssetRecordSchema } from "../src/types/assets";
import type { OutputKind } from "../src/types/fal-catalog";

const fixtures = path.resolve(import.meta.dirname, "fixtures/fal-catalog");
const outputs = JSON.parse(readFileSync(path.join(fixtures, "outputs.json"), "utf8")) as Record<
  string,
  Record<string, unknown>
>;
const manifest = JSON.parse(readFileSync(path.join(fixtures, "manifest.json"), "utf8")) as {
  endpoints: Record<string, { sha256: string; category: string }>;
};
function schemaOf(endpoint: string): ResultSchema {
  const entry = manifest.endpoints[endpoint];
  assert.ok(entry, `fixture for ${endpoint}`);
  const snapshot = snapshotFromOpenApi(
    JSON.parse(readFileSync(path.join(fixtures, "schemas", `${entry.sha256}.json`), "utf8")) as FalApiModel,
    "2026-11-15",
  );
  return { schema: snapshot.output, components: snapshot.schemas };
}
const media = (name: string, contentType?: string) => ({
  url: `https://v3.fal.media/files/synthetic/${name}`,
  ...(contentType ? { content_type: contentType } : {}),
  file_name: name,
});

/** A minimal valid GLB 2.0: header + one JSON chunk (padded to 4 bytes with spaces). */
function glb(
  json: Record<string, unknown> = {
    asset: { version: "2.0" },
    meshes: [{ primitives: [] }],
    nodes: [{ mesh: 0 }, {}],
    materials: [],
    animations: [{ channels: [], samplers: [] }],
  },
): Buffer {
  let text = Buffer.from(JSON.stringify(json));
  if (text.length % 4) text = Buffer.concat([text, Buffer.alloc(4 - (text.length % 4), 0x20)]);
  const header = Buffer.alloc(20);
  header.write("glTF", 0, "latin1");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(20 + text.length, 8);
  header.writeUInt32LE(text.length, 12);
  header.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([header, text]);
}
const tensors = () => {
  const header = Buffer.from(JSON.stringify({ weight: { dtype: "F32", shape: [1], data_offsets: [0, 4] } }));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  return Buffer.concat([size, header, Buffer.alloc(4)]);
};

test("outputs.json: every synthetic kind extracts with its primary kind; untrusted hosts are listed, not thrown", () => {
  const expected: Record<string, OutputKind> = {
    image: "image",
    video: "video",
    audio: "audio",
    model3d: "model3d",
    text: "text",
    json: "json",
    weights: "weights",
    file: "file",
  };
  for (const [name, kind] of Object.entries(expected)) {
    const extracted = extractArtifacts(undefined, outputs[name]!);
    assert.equal(primaryKind(extracted), kind, name);
    for (const file of extracted.files) assert.match(file.url, /^https:\/\/v3\.fal\.media\//);
  }
  const model3d = extractArtifacts(undefined, outputs.model3d!);
  assert.deepEqual(
    model3d.files.map((file) => [file.path, file.kind]),
    [
      ["/model_glb", "model3d"],
      ["/thumbnail", "image"],
    ],
  );
  const image = extractArtifacts(undefined, outputs.image!);
  assert.deepEqual(
    image.files.map((file) => [file.path, file.width, file.height]),
    [["/images/0", 1024, 1024]],
  );
  assert.deepEqual(image.data, { seed: 7 });
  assert.deepEqual(extractArtifacts(undefined, outputs.text!).data, {
    text: "Synthetic transcript line.",
    chunks: [{ timestamp: [0, 1.4], text: "Synthetic" }],
  });
  assert.deepEqual(Object.keys(extractArtifacts(undefined, outputs.json!).data), ["output", "usage"]);
  const weights = extractArtifacts(undefined, outputs.weights!);
  assert.deepEqual(
    weights.files.map((file) => file.kind),
    ["weights", "file"],
  );
  assert.deepEqual(extractArtifacts(undefined, outputs.untrusted!).untrustedUrls, [
    { path: "/images/0", url: "https://evil.example.com/a.png" },
  ]);
  assert.equal(extractArtifacts(undefined, outputs.image!).untrustedUrls.length, 0);
  assert.equal(
    extractArtifacts(undefined, { video: { url: "http://v3.fal.media/a.mp4", content_type: "video/mp4" } }).files[0]!
      .trusted,
    false,
  );
  assert.equal(extractArtifacts(undefined, { video_url: "https://user:pw@fal.media/a.mp4" }).files[0]!.trusted, false);
  assert.equal(
    extractArtifacts(undefined, { video: { url: "not a url", content_type: "video/mp4" } }).files[0]!.trusted,
    false,
  );
  assert.throws(
    () => assertTrustedFiles(extractArtifacts(undefined, outputs.untrusted!).files),
    /trusted fal media HTTPS host/,
  );
});

test("file kind follows 3D/weights extension, MIME, schema ref, media extension, then field name", () => {
  for (const [hints, kind] of [
    [{ url: "https://fal.media/a.glb", contentType: "application/octet-stream" }, "model3d"],
    [{ url: "https://fal.media/x", fileName: "mesh.usdz" }, "model3d"],
    [{ url: "https://fal.media/lora.safetensors" }, "weights"],
    [{ url: "https://fal.media/x", contentType: "audio/mpeg" }, "audio"],
    [{ url: "https://fal.media/x", contentType: "model/gltf-binary" }, "model3d"],
    [{ url: "https://fal.media/x", ref: "ImageFile" }, "image"],
    [{ url: "https://fal.media/x.webm" }, "video"],
    [{ url: "https://fal.media/x", field: "images" }, "image"],
    [{ url: "https://fal.media/x.zip", contentType: "application/zip", field: "file" }, "file"],
  ] as const)
    assert.equal(fileKind(hints), kind, JSON.stringify(hints));
});

test("real output schemas: image, video, 3D, TTS, STT, LLM, JSON, vision and training", () => {
  const image = extractArtifacts(schemaOf("fal-ai/flux/schnell"), {
    images: [{ url: "https://v3.fal.media/files/a.jpeg", width: 8, height: 8, content_type: "image/jpeg" }],
    timings: { inference: 0.4 },
    seed: 1,
    has_nsfw_concepts: [false],
    prompt: "p",
  });
  assert.deepEqual(
    image.files.map((file) => file.kind),
    ["image"],
  );
  assert.deepEqual(Object.keys(image.data).sort(), ["has_nsfw_concepts", "prompt", "seed", "timings"]);
  assert.equal(primaryKind(image), "image");

  const video = extractArtifacts(schemaOf("fal-ai/kling-video/v3/pro/text-to-video"), {
    video: { url: "https://v3.fal.media/files/out" },
  });
  assert.deepEqual(
    video.files.map((file) => [file.path, file.kind]),
    [["/video", "video"]],
  );

  const meshy = extractArtifacts(schemaOf("meshy/v7/image-to-3d"), {
    model_glb: media("m.glb", "model/gltf-binary"),
    thumbnail: media("t.png", "image/png"),
    model_urls: {
      glb: media("m.glb", "model/gltf-binary"),
      fbx: media("m.fbx"),
      obj: media("m.obj"),
      usdz: media("m.usdz"),
      blend: null,
    },
    texture_urls: [{ base_color: media("c.png", "image/png") }],
    seed: 3,
  });
  assert.equal(primaryKind(meshy), "model3d");
  assert.deepEqual(
    meshy.files.filter((file) => file.kind === "model3d").map((file) => file.path),
    ["/model_glb", "/model_urls/glb", "/model_urls/fbx", "/model_urls/obj", "/model_urls/usdz"],
  );
  assert.deepEqual(
    meshy.files.filter((file) => file.kind === "image").map((file) => file.path),
    ["/thumbnail", "/texture_urls/0/base_color"],
  );
  assert.deepEqual(meshy.data, { seed: 3 });

  // Without content_type or file_name, the schema's `File` ref still marks a file.
  const hunyuan = extractArtifacts(schemaOf("fal-ai/hunyuan-3d/v3.1/rapid/text-to-3d"), {
    model_urls: { glb: { url: "https://v3.fal.media/files/h.glb" } },
    model_obj: { url: "https://v3.fal.media/files/h.obj" },
  });
  assert.deepEqual(
    hunyuan.files.map((file) => [file.path, file.kind]),
    [
      ["/model_urls/glb", "model3d"],
      ["/model_obj", "model3d"],
    ],
  );

  const tts = extractArtifacts(schemaOf("fal-ai/elevenlabs/tts/turbo-v2.5"), {
    audio: { url: "https://v3.fal.media/files/speech" },
    timestamps: [{ word: "hi", start: 0, end: 0.2 }],
  });
  assert.deepEqual(
    tts.files.map((file) => file.kind),
    ["audio"],
  );
  assert.deepEqual(Object.keys(tts.data), ["timestamps"]);

  const stt = extractArtifacts(schemaOf("fal-ai/wizper"), {
    text: "hello",
    chunks: [{ timestamp: [0, 1], text: "hello" }],
    languages: ["en"],
  });
  assert.deepEqual(stt.files, []);
  assert.equal(primaryKind(stt), "text");

  const llm = extractArtifacts(schemaOf("nvidia/nemotron-3-nano-omni"), {
    output: "answer",
    finish_reason: "stop",
    usage: { input_tokens: 3, output_tokens: 1 },
  });
  assert.equal(primaryKind(llm), "text");
  assert.deepEqual(llm.data.usage, { input_tokens: 3, output_tokens: 1 });

  const vision = extractArtifacts(schemaOf("fal-ai/moondream3-preview/detect"), {
    finish_reason: "stop",
    usage_info: { input_tokens: 1, output_tokens: 1, prefill_time_ms: 1, decode_time_ms: 1, ttft_ms: 1 },
    objects: [{ x_min: 0, y_min: 0, x_max: 1, y_max: 1 }],
    image: { url: "https://v3.fal.media/files/annotated" },
  });
  assert.deepEqual(
    vision.files.map((file) => [file.path, file.kind]),
    [["/image", "image"]],
  );
  assert.deepEqual(Object.keys(vision.data), ["finish_reason", "usage_info", "objects"]);

  const json = extractArtifacts(schemaOf("bria/fibo-lite/generate/structured_prompt"), {
    structured_prompt: { subject: "bottle" },
  });
  assert.equal(primaryKind(json), "json");

  const training = extractArtifacts(schemaOf("blackforestlabs/flux-3/klein/base/trainer"), {
    lora_file: { url: "https://v3.fal.media/files/lora.safetensors" },
    config_file: { url: "https://v3.fal.media/files/config.json" },
  });
  assert.deepEqual(
    training.files.map((file) => [file.path, file.kind]),
    [
      ["/lora_file", "weights"],
      ["/config_file", "file"],
    ],
  );
  assert.equal(primaryKind(training), "weights");
  assert.deepEqual(
    extractArtifacts(schemaOf("blackforestlabs/flux-3/klein/base/trainer"), {
      lora_file: { url: "https://evil.example/lora.safetensors" },
    }).untrustedUrls,
    [{ path: "/lora_file", url: "https://evil.example/lora.safetensors" }],
  );
});

test("inspect: GLB, glTF, JSON and text without ffprobe; corrupt GLB rejected", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "inspect-kinds-"));
  try {
    const good = path.join(dir, "model.glb");
    writeFileSync(good, glb());
    const inspected = inspectAsset(good, { nonMedia: true });
    assert.equal(inspected.kind, "model3d");
    assert.equal(inspected.mime, "model/gltf-binary");
    assert.deepEqual(
      { ...inspected.media },
      {
        codec: "glb",
        hasAudio: false,
        hasAlpha: "unknown",
        meshCount: 1,
        nodeCount: 2,
        materialCount: 0,
        hasAnimations: true,
      },
    );
    // Magic wins over a misleading extension.
    const renamed = path.join(dir, "model.bin");
    writeFileSync(renamed, glb());
    assert.equal(inspectAsset(renamed, { nonMedia: true }).kind, "model3d");
    const bytes = glb();
    const corrupt: [string, Buffer][] = [
      ["truncated", bytes.subarray(0, bytes.length - 4)],
      [
        "version",
        (() => {
          const b = Buffer.from(bytes);
          b.writeUInt32LE(1, 4);
          return b;
        })(),
      ],
      ["length", Buffer.concat([bytes, Buffer.alloc(4)])],
      [
        "chunk-type",
        (() => {
          const b = Buffer.from(bytes);
          b.writeUInt32LE(0x004e4942, 16);
          return b;
        })(),
      ],
      [
        "json",
        (() => {
          const b = Buffer.from(bytes);
          b.write("{{{{", 20, "latin1");
          return b;
        })(),
      ],
      ["gltf-version", glb({ asset: { version: "1.0" } })],
    ];
    for (const [name, data] of corrupt)
      assert.throws(
        () => inspectGlb(data),
        (error: Error) => /GLB|glTF/.test(error.message),
        name,
      );
    const fakeGlb = path.join(dir, "fake.glb");
    writeFileSync(fakeGlb, "not a glb at all");
    assert.throws(() => inspectAsset(fakeGlb, { nonMedia: true }), /magic/);

    const gltf = path.join(dir, "scene.gltf");
    writeFileSync(gltf, JSON.stringify({ asset: { version: "2.0" }, meshes: [{}, {}] }));
    assert.equal(inspectAsset(gltf, { nonMedia: true }).media.meshCount, 2);
    const json = path.join(dir, "data.json");
    writeFileSync(json, '{"a":1}\n');
    assert.deepEqual(
      [inspectAsset(json, { nonMedia: true }).kind, inspectAsset(json, { nonMedia: true }).media.lineCount],
      ["json", 2],
    );
    const badJson = path.join(dir, "bad.json");
    writeFileSync(badJson, "{");
    assert.throws(() => inspectAsset(badJson, { nonMedia: true }), /does not parse/);
    const text = path.join(dir, "notes.txt");
    writeFileSync(text, "one\ntwo\nthree");
    assert.deepEqual(
      [inspectAsset(text, { nonMedia: true }).kind, inspectAsset(text, { nonMedia: true }).media.lineCount],
      ["text", 3],
    );
    const latin = path.join(dir, "latin.txt");
    writeFileSync(latin, Buffer.from([0x66, 0xff, 0xfe]));
    assert.throws(() => inspectAsset(latin, { nonMedia: true }), /UTF-8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("AssetRecord: model3d/text/json carry no dimensions or duration; media kinds keep their rules", () => {
  const base = {
    schemaVersion: 1,
    id: `sha256:${"a".repeat(64)}`,
    hash: "a".repeat(64),
    revision: 1,
    createdAt: "2026-11-15T00:00:00.000Z",
    files: { bytes: 10, mime: "model/gltf-binary", original: `projects/demo/assets/imported/${"a".repeat(64)}.glb` },
    provenance: { origin: "provider" },
    rights: {},
    status: "candidate",
  };
  assert.ok(
    AssetRecordSchema.safeParse({
      ...base,
      kind: "model3d",
      media: { codec: "glb", hasAudio: false, meshCount: 1, hasAnimations: false },
    }).success,
  );
  assert.ok(
    AssetRecordSchema.safeParse({ ...base, kind: "json", media: { codec: "json", hasAudio: false, lineCount: 1 } })
      .success,
  );
  assert.equal(
    AssetRecordSchema.safeParse({
      ...base,
      kind: "model3d",
      media: { codec: "glb", hasAudio: false, width: 10, height: 10 },
    }).success,
    false,
  );
  assert.equal(
    AssetRecordSchema.safeParse({ ...base, kind: "text", media: { codec: "utf-8", hasAudio: false, durationSec: 1 } })
      .success,
    false,
  );
  assert.equal(
    AssetRecordSchema.safeParse({ ...base, kind: "text", media: { codec: "utf-8", hasAudio: false, meshCount: 1 } })
      .success,
    false,
  );
  assert.equal(
    AssetRecordSchema.safeParse({
      ...base,
      kind: "audio",
      media: { codec: "mp3", hasAudio: true, durationSec: 1, lineCount: 2 },
    }).success,
    false,
  );
  assert.equal(
    AssetRecordSchema.safeParse({ ...base, kind: "audio", media: { codec: "mp3", hasAudio: true } }).success,
    false,
  );
  assert.equal(
    AssetRecordSchema.safeParse({ ...base, kind: "image", media: { codec: "png", hasAudio: false } }).success,
    false,
  );
});

const fixture = async (fn: () => Promise<void>) => {
  const old = process.cwd();
  const root = mkdtempSync(path.join(tmpdir(), "fal-results-"));
  process.chdir(root);
  mkdirSync("public/projects/demo", { recursive: true });
  writeFileSync("public/projects/demo/project.json", "{}");
  writeBudgetBrief("public/projects/demo");
  try {
    await fn();
  } finally {
    process.chdir(old);
    rmSync(root, { recursive: true, force: true });
  }
};
function completed(result: Record<string, unknown>) {
  const counts = { submits: 0, inspects: 0, downloads: [] as string[] };
  const provider: JobProvider = {
    submit: async () => ({ requestId: `request-${++counts.submits}` }),
    inspect: async () => {
      counts.inspects++;
      return { state: "completed", result };
    },
  };
  return { provider, counts };
}
const serve = (files: Record<string, Buffer>, counts: { downloads: string[] }) =>
  (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    counts.downloads.push(url);
    const body = files[url];
    return body ? new Response(new Uint8Array(body)) : new Response("missing", { status: 404 });
  }) as typeof fetch;
const base = (over: Partial<ExecutionOptions>): ExecutionOptions => ({
  projectId: "demo",
  endpoint: "fixture/kinds",
  model: "fixture/kinds",
  input: { prompt: "kinds" },
  output: "public/projects/demo/assets/3d/out.glb",
  mediaKind: "model3d",
  maxCostUsd: 0.5,
  operationId: "kinds:1",
  ...over,
});

test("execute model3d: GLB downloaded, inspected, imported and published; resume does not resubmit or redownload", () =>
  fixture(async () => {
    const result = {
      model_glb: media("m.glb", "model/gltf-binary"),
      model_urls: { glb: media("m.glb", "model/gltf-binary"), fbx: media("m.fbx") },
      thumbnail: media("t.png", "image/png"),
    };
    const { provider, counts } = completed(result);
    const options = base({
      provider,
      fetch: serve({ [media("m.glb").url]: glb() }, counts),
      resultSchema: schemaOf("meshy/v7/image-to-3d"),
    });
    const published = await executeFalOperation(options);
    assert.equal(published.metadata.state, "published");
    assert.deepEqual(published.outputs, ["public/projects/demo/assets/3d/out.glb"]);
    assert.deepEqual(counts.downloads, [media("m.glb").url]);
    assert.deepEqual(readFileSync(published.outputs[0]!), glb());
    const [asset] = readAssetRegistry("demo").assets;
    assert.equal(asset?.kind, "model3d");
    assert.match(asset!.files.original, /\.glb$/);
    assert.deepEqual(published.metadata.assetIds, [asset!.id]);
    assert.equal(new OperationStore("demo").snapshot().jobs["kinds:1"]!.publication!.kind, "model3d");
    const again = await executeFalOperation(options);
    assert.deepEqual(again.outputs, published.outputs);
    assert.equal(counts.submits, 1);
    assert.equal(counts.downloads.length, 1);
  }));

test("execute model3d: a corrupt GLB fails publication, keeps the result and resumes without a submit", () =>
  fixture(async () => {
    const { provider, counts } = completed({ model_glb: media("m.glb", "model/gltf-binary") });
    let body: Buffer = Buffer.from("glTF-but-broken");
    const fetcher = (async (input: Parameters<typeof fetch>[0]) => {
      counts.downloads.push(String(input));
      return new Response(new Uint8Array(body));
    }) as typeof fetch;
    const options = base({ provider, fetch: fetcher });
    const failed = await executeFalOperation(options);
    assert.equal(failed.metadata.state, "failed");
    assert.match(String(failed.metadata.error), /GLB/);
    assert.deepEqual(failed.outputs, []);
    body = glb();
    const published = await executeFalOperation(options);
    assert.equal(published.metadata.state, "published");
    assert.equal(counts.submits, 1);
  }));

test("execute text and json: immutable result manifest, no download, stable on resume", () =>
  fixture(async () => {
    for (const [kind, result] of [
      ["text", outputs.text!],
      ["json", outputs.json!],
    ] as const) {
      const { provider, counts } = completed(result);
      const operationId = `kinds:${kind}`;
      const options = base({
        provider,
        operationId,
        mediaKind: kind,
        output: `public/projects/demo/pipeline/${kind}.json`,
        fetch: serve({}, counts),
      });
      const published = await executeFalOperation(options);
      assert.equal(published.metadata.state, "published");
      assert.deepEqual(published.outputs, [`public/projects/demo/pipeline/model-results/${operationId}.json`]);
      const saved = JSON.parse(readFileSync(published.outputs[0]!, "utf8"));
      assert.equal(saved.kind, kind);
      assert.equal(saved.endpoint, "fixture/kinds");
      assert.equal(saved.operationId, operationId);
      assert.equal(saved.providerRequestId, "request-1");
      assert.match(saved.inputHash, /^[a-f0-9]{64}$/);
      assert.deepEqual(saved.data, result);
      assert.deepEqual(saved.files, []);
      assert.deepEqual(counts.downloads, []);
      assert.deepEqual((await executeFalOperation(options)).outputs, published.outputs);
      assert.equal(counts.submits, 1);
      writeFileSync(published.outputs[0]!, "tampered");
      await assert.rejects(executeFalOperation(options), /Published output/);
    }
    const empty = completed({});
    const failed = await executeFalOperation(
      base({
        provider: empty.provider,
        operationId: "kinds:empty",
        mediaKind: "json",
        output: "public/projects/demo/pipeline/empty.json",
      }),
    );
    assert.equal(failed.metadata.state, "failed");
    assert.match(String(failed.metadata.error), /no json fields/);
  }));

test("execute weights: safetensors validated and published, the config file is not taken; invalid weights fail", () =>
  fixture(async () => {
    const lora = media("lora.safetensors", "application/octet-stream"),
      config = { url: "https://v3.fal.media/files/synthetic/config.json", content_type: "application/json" };
    const { provider, counts } = completed({ diffusers_lora_file: lora, config_file: config });
    const published = await executeFalOperation(
      base({
        provider,
        mediaKind: "weights",
        output: "public/projects/demo/assets/models/lora.safetensors",
        fetch: serve({ [lora.url]: tensors(), [config.url]: Buffer.from("{}") }, counts),
      }),
    );
    assert.equal(published.metadata.state, "published");
    assert.deepEqual(counts.downloads, [lora.url]);
    assert.deepEqual(readFileSync(published.outputs[0]!), tensors());
    assert.deepEqual(published.metadata.assetIds, []);
    assert.equal(existsSync("public/projects/demo/pipeline/asset-registry.json"), false);
    const bad = completed({ diffusers_lora_file: lora });
    const failed = await executeFalOperation(
      base({
        provider: bad.provider,
        operationId: "kinds:bad",
        mediaKind: "weights",
        output: "public/projects/demo/assets/models/bad.safetensors",
        fetch: serve({ [lora.url]: Buffer.from("not weights") }, bad.counts),
      }),
    );
    assert.equal(failed.metadata.state, "failed");
    assert.match(String(failed.metadata.error), /safetensors/);
  }));

test("execute file and missing kinds: a generic file is published as-is; a result without the kind fails", () =>
  fixture(async () => {
    const { provider, counts } = completed(outputs.file!);
    const zip = (outputs.file!.file as { url: string }).url;
    const published = await executeFalOperation(
      base({
        provider,
        mediaKind: "file",
        output: "public/projects/demo/assets/out.zip",
        fetch: serve({ [zip]: Buffer.from("PK\u0003\u0004zip") }, counts),
      }),
    );
    assert.equal(published.metadata.state, "published");
    assert.deepEqual(published.outputs, ["public/projects/demo/assets/out.zip"]);
    const none = completed(outputs.text!);
    const failed = await executeFalOperation(base({ provider: none.provider, operationId: "kinds:none" }));
    assert.equal(failed.metadata.state, "failed");
    assert.match(String(failed.metadata.error), /no model3d files/);
    const untrusted = completed({
      model_glb: { url: "https://evil.example/m.glb", content_type: "model/gltf-binary" },
    });
    const refused = await executeFalOperation(
      base({ provider: untrusted.provider, operationId: "kinds:evil", fetch: serve({}, untrusted.counts) }),
    );
    assert.equal(refused.metadata.state, "failed");
    assert.match(String(refused.metadata.error), /trusted/);
    assert.deepEqual(untrusted.counts.downloads, []);
  }));

type Call = { url: string; method: string };
function queueFetch(submitBody: Record<string, unknown>, calls: Call[]) {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET" });
    if (init?.method === "POST") return Response.json(submitBody);
    if (url.endsWith("/status")) return Response.json({ status: "COMPLETED" });
    return Response.json({ text: "done" });
  }) as typeof fetch;
}

test("queue URLs: status_url/response_url from submit are validated, persisted and used; absent URLs fall back to the endpoint root", () =>
  fixture(async () => {
    const endpoint = "meshy/v7/image-to-3d";
    const status = "https://queue.fal.run/fal-ai/meshy/requests/req-1/status",
      response = "https://queue.fal.run/fal-ai/meshy/requests/req-1";
    const calls: Call[] = [];
    const provider = createFalJobProvider(
      createFalRestQueue({
        credentials: "fake",
        fetch: queueFetch({ request_id: "req-1", status_url: status, response_url: response }, calls),
      }),
    );
    const options = base({
      endpoint,
      model: endpoint,
      provider,
      mediaKind: "text",
      operationId: "queue:1",
      output: "public/projects/demo/pipeline/q.json",
    });
    const published = await executeFalOperation(options);
    assert.equal(published.metadata.state, "published");
    assert.deepEqual(calls, [
      { url: `https://queue.fal.run/${endpoint}`, method: "POST" },
      { url: status, method: "GET" },
      { url: response, method: "GET" },
    ]);
    assert.deepEqual(new OperationStore("demo").snapshot().jobs["queue:1"]!.providerUrls, { status, response });

    // Historical job without stored URLs: today's endpoint-root guess.
    const legacyCalls: Call[] = [];
    const legacy = createFalJobProvider(
      createFalRestQueue({ credentials: "fake", fetch: queueFetch({ request_id: "req-2" }, legacyCalls) }),
    );
    await executeFalOperation({
      ...options,
      provider: legacy,
      operationId: "queue:2",
      input: { prompt: "legacy" },
      output: "public/projects/demo/pipeline/q2.json",
    });
    assert.deepEqual(legacyCalls.map((call) => call.url).slice(1), [
      "https://queue.fal.run/meshy/v7/requests/req-2/status",
      "https://queue.fal.run/meshy/v7/requests/req-2",
    ]);
    assert.equal(new OperationStore("demo").snapshot().jobs["queue:2"]!.providerUrls, undefined);

    // Invalid URLs are dropped at submit (the request ID is kept): the fallback is used, never the foreign host.
    const badCalls: Call[] = [];
    const bad = createFalJobProvider(
      createFalRestQueue({
        credentials: "fake",
        fetch: queueFetch(
          {
            request_id: "req-3",
            status_url: "https://evil.example/fal-ai/meshy/requests/req-3/status",
            response_url: "https://queue.fal.run/fal-ai/meshy/requests/req-3",
          },
          badCalls,
        ),
      }),
    );
    const result = await executeFalOperation({
      ...options,
      provider: bad,
      operationId: "queue:3",
      input: { prompt: "bad" },
      output: "public/projects/demo/pipeline/q3.json",
    });
    assert.equal(result.metadata.providerRequestId, "req-3");
    assert.ok(badCalls.every((call) => new URL(call.url).hostname === "queue.fal.run"));
    assert.equal(new OperationStore("demo").snapshot().jobs["queue:3"]!.providerUrls, undefined);
  }));

test("queue URLs: resume after a restart polls the stored URLs; a tampered stored URL refuses", () =>
  fixture(async () => {
    const endpoint = "meshy/v7/image-to-3d";
    const status = "https://queue.fal.run/fal-ai/meshy/requests/req-9/status",
      response = "https://queue.fal.run/fal-ai/meshy/requests/req-9";
    let state = "IN_PROGRESS";
    const calls: Call[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "POST")
        return Response.json({ request_id: "req-9", status_url: status, response_url: response });
      if (url.endsWith("/status")) return Response.json({ status: state });
      return Response.json({ output: { ok: true } });
    }) as typeof fetch;
    const options = base({
      endpoint,
      model: endpoint,
      mediaKind: "json",
      operationId: "queue:resume",
      output: "public/projects/demo/pipeline/r.json",
    });
    assert.equal(
      (
        await executeFalOperation({
          ...options,
          provider: createFalJobProvider(createFalRestQueue({ credentials: "fake", fetch: fetcher })),
        })
      ).metadata.state,
      "running",
    );
    state = "COMPLETED";
    // A fresh transport (new process) has only the stored job to go on.
    const resumed = await executeFalOperation({
      ...options,
      provider: createFalJobProvider(createFalRestQueue({ credentials: "fake", fetch: fetcher })),
    });
    assert.equal(resumed.metadata.state, "published");
    assert.deepEqual(
      calls.map((call) => call.url),
      [`https://queue.fal.run/${endpoint}`, status, status, response],
    );
    assert.equal(calls.filter((call) => call.method === "POST").length, 1);

    const queue = createFalRestQueue({ credentials: "fake", fetch: fetcher });
    await assert.rejects(
      queue.status(endpoint, {
        requestId: "req-9",
        statusUrl: "https://queue.fal.run/fal-ai/meshy/requests/other/status",
      }),
      /Stored fal status URL/,
    );
    await assert.rejects(
      queue.result(endpoint, {
        requestId: "req-9",
        responseUrl: "https://queue.fal.run.evil.example/fal-ai/meshy/requests/req-9",
      }),
      /Stored fal response URL/,
    );
    const store = new OperationStore("demo");
    assert.throws(
      () =>
        store.transitionJob("queue:resume", "published", {
          providerUrls: { status: "https://queue.fal.run/x/requests/req-9/status", response },
        }),
      /immutable/,
    );
  }));

test("validQueueUrl accepts only queue.fal.run request URLs for the same request", () => {
  assert.equal(
    validQueueUrl("https://queue.fal.run/fal-ai/meshy/requests/r1/status", "r1", "status"),
    "https://queue.fal.run/fal-ai/meshy/requests/r1/status",
  );
  assert.equal(
    validQueueUrl("https://queue.fal.run/fal-ai/meshy/requests/r1", "r1", "response"),
    "https://queue.fal.run/fal-ai/meshy/requests/r1",
  );
  for (const [url, kind] of [
    ["http://queue.fal.run/fal-ai/meshy/requests/r1/status", "status"],
    ["https://queue.fal.run:8443/fal-ai/meshy/requests/r1/status", "status"],
    ["https://fal.run/fal-ai/meshy/requests/r1/status", "status"],
    ["https://queue.fal.run/fal-ai/meshy/requests/r2/status", "status"],
    ["https://queue.fal.run/fal-ai/meshy/requests/r1/status?x=1", "status"],
    ["https://user@queue.fal.run/fal-ai/meshy/requests/r1", "response"],
    ["https://queue.fal.run/requests/r1", "response"],
    ["https://queue.fal.run/fal-ai/meshy/requests/r1/status", "response"],
    ["https://queue.fal.run/fal-ai/%2e%2e/requests/r1", "response"],
    [42, "response"],
  ] as const)
    assert.equal(validQueueUrl(url, "r1", kind), undefined, String(url));
});

test("execute image: a file outside the older result fields is found by extraction and imported", async (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  await fixture(async () => {
    const generated = spawnSync(
      "ffmpeg",
      ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=16x16", "-frames:v", "1", "source.png"],
      { encoding: "utf8" },
    );
    assert.equal(generated.status, 0, generated.stderr);
    const png = media("edited.png", "image/png");
    const { provider, counts } = completed({
      result_image: png,
      thumbnail_video: media("p.mp4", "video/mp4"),
      seed: 1,
    });
    const published = await executeFalOperation(
      base({
        provider,
        mediaKind: "image",
        output: "public/projects/demo/assets/edited.png",
        fetch: serve({ [png.url]: readFileSync("source.png") }, counts),
      }),
    );
    assert.equal(published.metadata.state, "published");
    assert.deepEqual(counts.downloads, [png.url]);
    assert.equal(readAssetRegistry("demo").assets[0]?.kind, "image");
  });
});

test("trust scope: an echoed untrusted input URL is listed in the json manifest, not fetched, and does not fail", () =>
  fixture(async () => {
    const echoed = {
      media: {
        media_type: "video",
        url: "https://cdn.example.org/input.mp4",
        content_type: "video/mp4",
        file_name: "input.mp4",
        file_size: 10,
        duration: 2,
        codec: "h264",
        container: "mp4",
      },
    };
    const { provider, counts } = completed(echoed);
    const published = await executeFalOperation(
      base({
        provider,
        endpoint: "fal-ai/ffmpeg-api/metadata",
        model: "fal-ai/ffmpeg-api/metadata",
        mediaKind: "json",
        operationId: "kinds:echo",
        output: "public/projects/demo/pipeline/meta.json",
        resultSchema: schemaOf("fal-ai/ffmpeg-api/metadata"),
        fetch: serve({}, counts),
      }),
    );
    assert.equal(published.metadata.state, "published");
    assert.deepEqual(counts.downloads, []);
    const saved = JSON.parse(readFileSync(published.outputs[0]!, "utf8"));
    assert.deepEqual(saved.untrustedUrls, [{ path: "/media", url: "https://cdn.example.org/input.mp4" }]);
    assert.deepEqual(saved.files, []);
    assert.equal(saved.data.media, undefined);
  }));

test("trust scope: an untrusted non-selected file does not block the selected trusted model and is recorded", () =>
  fixture(async () => {
    const { provider, counts } = completed({
      model_glb: media("m.glb", "model/gltf-binary"),
      thumbnail: { url: "https://cdn.example.org/t.png", content_type: "image/png" },
    });
    const published = await executeFalOperation(
      base({ provider, operationId: "kinds:mixed", fetch: serve({ [media("m.glb").url]: glb() }, counts) }),
    );
    assert.equal(published.metadata.state, "published");
    assert.deepEqual(counts.downloads, [media("m.glb").url]);
    const record = new OperationStore("demo").snapshot().jobs["kinds:mixed"]!.result!.published as {
      untrustedUrls?: unknown;
    };
    assert.deepEqual(record.untrustedUrls, [{ path: "/thumbnail", url: "https://cdn.example.org/t.png" }]);
  }));

test("queuePath: without queue URLs the OpenAPI route is used, persisted and kept on resume; invalid paths refuse before submit", () =>
  fixture(async () => {
    const endpoint = "meshy/v7/image-to-3d",
      route = "fal-ai/meshy/v7/image-to-3d";
    let state = "IN_QUEUE";
    const calls: Call[] = [];
    const fetcher = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      if (init?.method === "POST") return Response.json({ request_id: "req-5" });
      if (url.endsWith("/status")) return Response.json({ status: state });
      return Response.json({ text: "ok" });
    }) as typeof fetch;
    const options = base({
      endpoint,
      model: endpoint,
      mediaKind: "text",
      operationId: "route:1",
      output: "public/projects/demo/pipeline/route.json",
    });
    const transport = () => createFalJobProvider(createFalRestQueue({ credentials: "fake", fetch: fetcher }));
    assert.equal(
      (await executeFalOperation({ ...options, queuePath: `/${route}`, provider: transport() })).metadata.state,
      "queued",
    );
    const job = new OperationStore("demo").snapshot().jobs["route:1"]!;
    assert.equal(job.queueRoute, route);
    assert.equal(job.providerUrls, undefined);
    state = "COMPLETED";
    // A resume without queuePath (or with another one) still polls the stored route.
    assert.equal((await executeFalOperation({ ...options, provider: transport() })).metadata.state, "published");
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        `https://queue.fal.run/${endpoint}`,
        `https://queue.fal.run/${route}/requests/req-5/status`,
        `https://queue.fal.run/${route}/requests/req-5/status`,
        `https://queue.fal.run/${route}/requests/req-5`,
      ],
    );
    for (const queuePath of ["fal-ai/../x", "fal-ai/x/requests/y", "https://queue.fal.run/fal-ai/x", "single"]) {
      let submits = 0;
      const provider: JobProvider = {
        submit: async () => ({ requestId: `r${++submits}` }),
        inspect: async () => ({ state: "queued" }),
      };
      await assert.rejects(
        executeFalOperation({
          ...options,
          provider,
          queuePath,
          operationId: "route:bad",
          output: "public/projects/demo/pipeline/bad.json",
        }),
        /queuePath/,
      );
      assert.equal(submits, 0);
    }
    const queue = createFalRestQueue({ credentials: "fake", fetch: fetcher });
    await assert.rejects(queue.status(endpoint, { requestId: "req-5", route: "fal-ai/../evil" }), /queue route/);
  }));

test("inspect: a GLB larger than the 256 MiB structured cap is read by header and JSON chunk only", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "large-glb-"));
  try {
    const head = glb();
    const total = 300 * 1024 * 1024;
    head.writeUInt32LE(total, 8);
    // A trailing BIN chunk header so the layout stays plausible; the rest is sparse.
    const file = path.join(dir, "big.glb");
    const fd = openSync(file, "w");
    try {
      writeSync(fd, head);
      const bin = Buffer.alloc(8);
      bin.writeUInt32LE(total - head.length - 8, 0);
      bin.writeUInt32LE(0x004e4942, 4);
      writeSync(fd, bin);
      ftruncateSync(fd, total);
    } finally {
      closeSync(fd);
    }
    assert.equal(inspectAsset(file, { nonMedia: true }).kind, "model3d");
    assert.equal(inspectGlbFile(file).media.meshCount, 1);
    const short = path.join(dir, "short.glb");
    writeFileSync(short, head.subarray(0, 24));
    assert.throws(() => inspectGlbFile(short), /declared length/);
    const empty = path.join(dir, "empty.glb");
    writeFileSync(empty, "");
    assert.throws(() => inspectGlbFile(empty), /magic/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
