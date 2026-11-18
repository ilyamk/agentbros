import "./helpers/fal-no-network";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import { CATALOG_DIR, loadCatalog, readCachedApiModel } from "../src/lib/models/fal-catalog";
import pins from "../src/lib/models/fal-verified.json";
import {
  buildFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "../src/lib/providers/fal-operations";
import { openApiRoutes } from "../src/lib/providers/fal-openapi";
import { extractArtifacts } from "../src/lib/providers/fal-results";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { prepareFalRoleExecution, requireVerifiedFalRoleEndpoint } from "../src/lib/providers/fal-plan-execution";
import { unsupportedKeywords } from "../src/lib/providers/json-schema-validate";
import { CliErrorObject } from "../src/lib/cli";
import type { FalEndpointRequest } from "../src/types/generation";

const image = "https://fal.media/source.png";
const video = "https://fal.media/source.mp4";
const audio = "https://fal.media/voice.wav";
const imageFile = {
  url: "https://fal.media/result.png",
  content_type: "image/png",
  file_name: "result.png",
  file_size: 128,
  width: 640,
  height: 480,
};
const videoFile = {
  url: "https://fal.media/result.mp4",
  content_type: "video/mp4",
  file_name: "result.mp4",
  file_size: 128,
};
const cases: Array<{
  endpoint: string;
  input: Record<string, unknown>;
  result: Record<string, unknown>;
  kind: "image" | "video";
  quote: Record<string, unknown>;
}> = [
  {
    endpoint: "fal-ai/aura-sr",
    input: { image_url: image },
    result: { image: imageFile, timings: {} },
    kind: "image",
    quote: { units: 1 },
  },
  {
    endpoint: "fal-ai/birefnet",
    input: { image_url: image },
    result: { image: imageFile },
    kind: "image",
    quote: { units: 1 },
  },
  {
    endpoint: "fal-ai/birefnet/v2",
    input: { image_url: image },
    result: { image: imageFile },
    kind: "image",
    quote: { units: 1 },
  },
  {
    endpoint: "fal-ai/seedvr/upscale/image",
    input: { image_url: image },
    result: { image: imageFile, seed: 1 },
    kind: "image",
    quote: { units: 1 },
  },
  {
    endpoint: "fal-ai/seedvr/upscale/video",
    input: { video_url: video },
    result: { video: videoFile, seed: 1 },
    kind: "video",
    quote: {},
  },
  {
    endpoint: "topaz/interpolate/video",
    input: { video_url: video },
    result: { video: videoFile },
    kind: "video",
    quote: {},
  },
  ...["fal-ai/sync-lipsync", "fal-ai/latentsync", "fal-ai/sync-lipsync/v3"].map((endpoint) => ({
    endpoint,
    input: { video_url: video, audio_url: audio },
    result: { video: videoFile },
    kind: "video" as const,
    quote: { inputAudioSec: 3 },
  })),
  {
    endpoint: "veed/avatars/audio-to-video",
    input: { audio_url: audio, avatar_id: "emily_vertical_primary" },
    result: { video: videoFile },
    kind: "video",
    quote: { inputAudioSec: 3 },
  },
  {
    endpoint: "fal-ai/qwen-image-edit/inpaint",
    input: { image_url: image, mask_url: image, prompt: "A blue cup" },
    result: { images: [imageFile], timings: {}, seed: 1, has_nsfw_concepts: [false], prompt: "A blue cup" },
    kind: "image",
    quote: { units: 1, inputCharacters: 10 },
  },
  {
    endpoint: "fal-ai/image-apps-v2/outpaint",
    input: { image_url: image },
    result: { images: [imageFile], seed: 1 },
    kind: "image",
    quote: { units: 1 },
  },
];
const indexed = loadCatalog(CATALOG_DIR);
const catalogue = useTempFalCatalog(
  cases.map(({ endpoint }) => ({
    endpoint,
    patch: {
      tier: "verified",
      schema: indexed.get(endpoint)!.schema,
      inputs: indexed.get(endpoint)!.inputs,
      outputs: indexed.get(endpoint)!.outputs,
    },
  })),
);
for (const { endpoint } of cases) {
  const name = `${indexed.get(endpoint)!.schema!.sha256}.json`;
  copyFileSync(
    path.join(import.meta.dirname, "fixtures/fal-catalog/schemas", name),
    path.join(catalogue.cacheDir, name),
  );
}
const context = { media: { [audio]: { durationSec: 3 } } };

for (const item of cases)
  test(`${item.endpoint}: pinned schema, minimal request, quote, queue and real result shape`, () => {
    const entry = indexed.get(item.endpoint)!;
    assert.equal(entry.tier, "verified");
    const pin = (pins.pins as Record<string, { catalogSha256: string | null; since: string }>)[item.endpoint]!;
    assert.deepEqual(pin, { catalogSha256: entry.schema!.sha256, since: "2026-11-15" });
    const bytes = readFileSync(
      path.join(import.meta.dirname, "fixtures/fal-catalog/schemas", `${pin.catalogSha256}.json`),
    );
    assert.equal(createHash("sha256").update(bytes).digest("hex"), pin.catalogSha256);
    const request: FalEndpointRequest = { endpoint: item.endpoint, input: item.input, context };
    const plan = buildFalOperation(request);
    assert.deepEqual(plan.outputKinds, [item.kind]);
    assert.equal(plan.executable, true);
    assert.equal(plan.tier, "verified");
    assert.equal(plan.schemaSha256, pin.catalogSha256);
    const snapshot = resolveFalSnapshotForPlan(plan);
    assert.deepEqual(unsupportedKeywords(snapshot.input, snapshot.schemas), []);
    assert.deepEqual(unsupportedKeywords(snapshot.output, snapshot.schemas), []);
    const model = readCachedApiModel(entry.schema!.sha256)!;
    const queuePath =
      item.endpoint === "topaz/interpolate/video"
        ? "fal-ai/topaz/interpolate/video"
        : item.endpoint === "veed/avatars/audio-to-video"
          ? "VEED/avatars/audio-to-video"
          : item.endpoint;
    assert.equal(openApiRoutes(model)!.submitPath.slice(1), queuePath);
    assert.deepEqual(quoteInputForPlan(plan, plan.input, context), item.quote);
    const result = validateFalOperationResult(item.endpoint, item.result);
    const extracted = extractArtifacts({ schema: snapshot.output, components: snapshot.schemas }, result);
    assert.equal(extracted.files.length, 1);
    assert.equal(extracted.files[0]!.kind, item.kind);
    assert.equal(extracted.files[0]!.trusted, true);
    assert.throws(() => validateFalOperationResult(item.endpoint, {}), /required/);
  });

test("BiRefNet v2 restricts the 2304 resolution to Dynamic and leaves original requests untouched", () => {
  for (const model of [undefined, "Portrait", "General Use (Light)"]) {
    assert.throws(
      () =>
        buildFalOperation({
          endpoint: "fal-ai/birefnet/v2",
          input: { image_url: image, operating_resolution: "2304x2304", ...(model ? { model } : {}) },
        }),
      /requires.*Dynamic/,
    );
  }
  const input = { image_url: image, operating_resolution: "2304x2304", model: "General Use (Dynamic)" };
  assert.deepEqual(buildFalOperation({ endpoint: "fal-ai/birefnet/v2", input }).input, input);
  assert.doesNotThrow(() =>
    buildFalOperation({ endpoint: "fal-ai/birefnet", input: { image_url: image, operating_resolution: "2048x2048" } }),
  );
});

test("Sync v3 enforces speaker pairs and bounding-box shape and honours nested sync mode", () => {
  const request = { endpoint: "fal-ai/sync-lipsync/v3", input: { video_url: video, audio_url: audio } };
  for (const speaker of [{ coordinates: [10, 20] }, { frame_number: 0 }, { bounding_boxes: [[1, 2, 3]] }]) {
    assert.throws(
      () =>
        buildFalOperation({ ...request, input: { ...request.input, options: { active_speaker_detection: speaker } } }),
      /together|bounding box/,
    );
  }
  const input = {
    ...request.input,
    sync_mode: "cut_off",
    options: {
      sync_mode: "loop",
      active_speaker_detection: { coordinates: [10, 20], frame_number: 0, bounding_boxes: [null, [0, 0, 20, 30]] },
    },
  };
  assert.equal(buildFalOperation({ ...request, input }).input.sync_mode, "loop");
  assert.equal(input.sync_mode, "cut_off");
});

test("schema bounds refuse invalid interpolation, upscale, inpaint, outpaint and avatar requests", () => {
  for (const [endpoint, input] of [
    ["topaz/interpolate/video", { video_url: video, target_fps: 121 }],
    ["topaz/interpolate/video", { video_url: video, slowdown_factor: 9 }],
    ["fal-ai/seedvr/upscale/video", { video_url: video, upscale_factor: 11 }],
    ["fal-ai/qwen-image-edit/inpaint", { image_url: image, prompt: "A cup" }],
    ["fal-ai/image-apps-v2/outpaint", { image_url: image, expand_left: 701 }],
    ["veed/avatars/audio-to-video", { audio_url: audio, avatar_id: "unknown-avatar" }],
  ] as const)
    assert.throws(() => buildFalOperation({ endpoint, input }));
  assert.doesNotThrow(() =>
    buildFalOperation({
      endpoint: "fal-ai/latentsync",
      input: { video_url: video, audio_url: audio, guidance_scale: 1.05 },
    }),
  );
});

test("utility routing rejects wrong roles, categories and non-verified tiers with an allow-list", () => {
  for (const endpoint of ["not/an-endpoint", "fal-ai/birefnet", "veed/avatars/audio-to-video"]) {
    assert.throws(
      () => requireVerifiedFalRoleEndpoint(endpoint, "upscale"),
      (error) => error instanceof CliErrorObject && /Allowed:.*fal-ai\/aura-sr/.test(error.message),
    );
  }
  assert.throws(
    () => requireVerifiedFalRoleEndpoint("fal-ai/seedvr/upscale/image", "upscale", "video-to-video"),
    /Allowed: fal-ai\/seedvr\/upscale\/video/,
  );
  const entry = loadCatalog().get("fal-ai/aura-sr")!;
  entry.tier = "priced";
  try {
    assert.throws(() => requireVerifiedFalRoleEndpoint(entry.endpoint, "upscale"), /verified upscale/);
  } finally {
    entry.tier = "verified";
  }
});

test("a missing utility schema reports the same actionable provider code as generate:model", () => {
  const entry = requireVerifiedFalRoleEndpoint("fal-ai/seedvr/upscale/image", "upscale");
  process.env.AGENTBROS_FAL_SCHEMA_CACHE = path.join(catalogue.cacheDir, "missing");
  try {
    assert.throws(
      () => prepareFalRoleExecution(entry, { image }),
      (error) => {
        assert.ok(error instanceof CliErrorObject);
        assert.equal(error.code, "INVALID_INPUT");
        assert.deepEqual(error.details, {
          providerCode: "SCHEMA_NOT_CACHED",
          nextAction: "pnpm fal:sync --schemas fal-ai/seedvr/upscale/image",
        });
        return true;
      },
    );
  } finally {
    process.env.AGENTBROS_FAL_SCHEMA_CACHE = catalogue.cacheDir;
  }
});

for (const [endpoint, role, media] of [
  ["fal-ai/aura-sr", "upscale", { image }],
  ["fal-ai/seedvr/upscale/image", "upscale", { image }],
  ["fal-ai/seedvr/upscale/video", "upscale", { video }],
  ["fal-ai/birefnet", "cutout", { image }],
  ["fal-ai/birefnet/v2", "cutout", { image }],
  ["fal-ai/sync-lipsync", "lipsync", { video, audio }],
  ["fal-ai/latentsync", "lipsync", { video, audio }],
  ["fal-ai/sync-lipsync/v3", "lipsync", { video, audio }],
] as const)
  test(`${endpoint}: utility execution options retain schema, route, result validation and quote`, () => {
    const entry = requireVerifiedFalRoleEndpoint(endpoint, role);
    const { plan, options } = prepareFalRoleExecution(entry, media, context);
    const item = cases.find((item) => item.endpoint === endpoint)!;
    assert.deepEqual(plan.input, item.input);
    assert.equal(options.endpoint, endpoint);
    assert.equal(options.model, endpoint);
    assert.equal(options.queuePath, endpoint);
    assert.equal(options.mediaKind, item.kind);
    assert.deepEqual(options.quoteInput, item.quote);
    assert.deepEqual(
      extractArtifacts(options.resultSchema, item.result).files.map((file) => file.kind),
      [item.kind],
    );
    assert.doesNotThrow(() => options.validateResult(item.result));
    assert.throws(() => options.validateResult({}), /required/);
    if (role === "lipsync") assert.throws(() => prepareFalRoleExecution(entry, { image, audio }), /image input field/);
  });

test("CLIs select verified endpoints offline, preserve default quotes and reject image/video mismatches", (t) => {
  if (spawnSync("ffmpeg", ["-version"]).status !== 0) return t.skip("ffmpeg unavailable");
  const root = mkdtempSync(path.join(tmpdir(), "fal-image-video-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const png = path.join(root, "source.png"),
    clip = path.join(root, "source.MP4"),
    wav = path.join(root, "voice.wav");
  for (const args of [
    ["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", png],
    ["-f", "lavfi", "-i", "color=c=blue:s=64x64:d=1", "-c:v", "libx264", clip],
    ["-f", "lavfi", "-i", "sine=frequency=440:duration=1", wav],
  ])
    assert.equal(spawnSync("ffmpeg", ["-v", "error", ...args]).status, 0);
  const repo = path.resolve(import.meta.dirname, "..");
  const run = (script: string, args: string[]) => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repo, "node_modules/tsx/dist/loader.mjs"),
        path.join(repo, "scripts", script),
        ...args,
        "--output",
        path.join(root, "output"),
        "--dry-run",
      ],
      {
        cwd: root,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          AGENTBROS_FAL_CATALOG_DIR: catalogue.catalogDir,
          AGENTBROS_FAL_SCHEMA_CACHE: catalogue.cacheDir,
        },
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const lines = child.stdout.trim().split("\n");
    assert.equal(lines.length, 1, child.stderr);
    return { status: child.status, envelope: JSON.parse(lines[0]!) };
  };
  for (const [script, args, endpoint, kind] of [
    ["upscale.ts", ["--input", png], "fal-ai/seedvr/upscale/image", "image"],
    ["upscale.ts", ["--input", clip], "fal-ai/seedvr/upscale/video", "video"],
    ["rmbg.ts", ["--input", png], "fal-ai/birefnet/v2", "image"],
    ["generate-lipsync.ts", ["--video", clip, "--audio", wav], "fal-ai/sync-lipsync/v3", "video"],
  ] as const) {
    const { status, envelope } = run(script, [...args, "--endpoint", endpoint]);
    assert.equal(status, 0, JSON.stringify(envelope));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.metadata.plan.endpoint, endpoint);
    assert.equal(envelope.metadata.plan.tier, "verified");
    assert.equal(envelope.metadata.mediaKind, kind);
    assert.equal(envelope.metadata.queuePath, endpoint);
    assert.match(envelope.metadata.input[`${kind === "image" ? "image" : "video"}_url`], /^data:/);
    if (script === "generate-lipsync.ts") assert.equal(envelope.metadata.quoteInput.inputAudioSec, 1);
  }
  for (const [script, endpoint, highUsd] of [
    ["upscale.ts", "fal-ai/aura-sr", 0.01],
    ["rmbg.ts", "fal-ai/birefnet", 0.005],
  ] as const) {
    const { envelope } = run(script, ["--input", png]);
    assert.equal(envelope.metadata.endpoint, endpoint);
    assert.equal(envelope.metadata.quote.highUsd, highUsd);
    assert.equal(envelope.metadata.plan, undefined);
  }
  for (const [script, args] of [
    ["upscale.ts", ["--input", png, "--endpoint", ""]],
    ["rmbg.ts", ["--input", png, "--endpoint", ""]],
    ["generate-lipsync.ts", ["--video", clip, "--audio", wav, "--endpoint", ""]],
    ["upscale.ts", ["--input", clip, "--endpoint", "fal-ai/aura-sr"]],
    ["upscale.ts", ["--input", png, "--endpoint", "fal-ai/seedvr/upscale/video"]],
    ["rmbg.ts", ["--input", png, "--endpoint", "fal-ai/aura-sr"]],
    ["generate-lipsync.ts", ["--portrait", png, "--audio", wav, "--endpoint", "fal-ai/sync-lipsync/v3"]],
  ] as const) {
    const { status, envelope } = run(script, [...args]);
    assert.equal(status, 1);
    assert.equal(envelope.error, "INVALID_INPUT");
  }
  assert.equal(existsSync(path.join(root, "output")), false);
  assert.equal(existsSync(path.join(root, "public")), false);
});
