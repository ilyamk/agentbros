import "./helpers/fal-no-network";
import { writeBudgetBrief } from "./helpers/ceiling-grant";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runSfxGeneration } from "../scripts/sfx-generate";
import {
  buildFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "../src/lib/providers/fal-operations";
import { buildFalMusicOperation, FAL_MUSIC_MODELS, type FalMusicRequest } from "../src/lib/providers/fal-music";
import { musicGuard } from "../src/lib/providers/fal-guards/music";
import type { FalGuardInfo } from "../src/lib/providers/fal-guards/all";
import { extractArtifacts } from "../src/lib/providers/fal-results";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { openApiRoutes } from "../src/lib/providers/fal-openapi";
import { readCachedApiModel } from "../src/lib/models/fal-catalog";
import { unsupportedKeywords } from "../src/lib/providers/json-schema-validate";
import { readAssetRegistry } from "../src/lib/assets/registry";
import { OperationStore } from "../src/lib/jobs/store";
import type { OutputKind } from "../src/types/fal-catalog";
import type { JobProvider } from "../src/lib/jobs/runner";
import { falFixtureManifest, useTempFalCatalog } from "./helpers/fal-temp-catalog";

const repo = path.resolve(import.meta.dirname, "..");
const audio = (name = "sound.wav") => ({
  url: `https://v3.fal.media/files/${name}`,
  content_type: "audio/wav",
  file_name: name,
});
const contracts = [
  {
    endpoint: "elevenlabs/sound-effects/v3",
    input: { text: "Paper crumpling", duration_seconds: 2 },
    output: { audio: audio() },
    kinds: ["audio"],
    quote: { durationSec: 2, inputCharacters: 15 },
  },
  {
    endpoint: "fal-ai/stable-audio-3/small/sfx/text-to-audio",
    input: { prompt: "Paper", duration: 2 },
    output: { audio: audio(), seed: 1, prompt: "Paper" },
    kinds: ["audio"],
    quote: { durationSec: 2, inputCharacters: 5 },
  },
  {
    endpoint: "mirelo-ai/sfx2.0/video-to-audio",
    input: { video_url: "https://example.com/action.mp4", duration: 2, num_samples: 1 },
    output: { model: "sfx-2.0", audio: [audio()] },
    kinds: ["audio", "json"],
    quote: { durationSec: 2 },
  },
  {
    endpoint: "fal-ai/demucs",
    input: { audio_url: "https://example.com/song.wav" },
    output: { drums: audio("drums.wav"), vocals: audio("vocals.wav"), bass: null },
    kinds: ["audio", "file"],
    quote: {},
  },
  {
    endpoint: "fal-ai/deepfilternet3",
    input: { audio_url: "https://example.com/voice.wav" },
    output: { audio_file: audio(), timings: { inference: 1, preprocess: 0, postprocess: 0 } },
    kinds: ["audio"],
    quote: {},
  },
  {
    endpoint: "fal-ai/elevenlabs/voice-changer",
    input: { audio_url: "https://example.com/voice.wav" },
    output: { audio: audio(), seed: 1 },
    kinds: ["audio"],
    quote: {},
  },
];
const dirs = useTempFalCatalog([
  ...contracts.map(({ endpoint, kinds }) => ({
    endpoint,
    patch: { tier: "verified" as const, outputs: { kinds: kinds as OutputKind[], fields: [] } },
  })),
  ...Object.keys(FAL_MUSIC_MODELS).map((endpoint) => ({
    endpoint,
    patch: { outputs: { kinds: ["audio" as const], fields: [] } },
  })),
]);

for (const row of contracts)
  test(`${row.endpoint}: offline schema, routing, quantities and result extraction`, () => {
    const plan = buildFalOperation({ endpoint: row.endpoint, input: row.input });
    assert.deepEqual(plan.outputKinds, row.kinds);
    assert.equal(plan.tier, "verified");
    assert.equal(plan.executable, true);
    assert.deepEqual(quoteInputForPlan(plan, plan.input), row.quote);
    const snapshot = resolveFalSnapshotForPlan(plan);
    assert.deepEqual(unsupportedKeywords(snapshot.input, snapshot.schemas), []);
    assert.deepEqual(unsupportedKeywords(snapshot.output, snapshot.schemas), []);
    const model = readCachedApiModel(falFixtureManifest.endpoints[row.endpoint]!.sha256)!;
    assert.equal(
      openApiRoutes(model)!.submitPath,
      row.endpoint.startsWith("mirelo-ai/")
        ? "/Mirelo-AI/sfx2.0/video-to-audio"
        : row.endpoint === "elevenlabs/sound-effects/v3"
          ? "/fal-ai/elevenlabs/sound-effects/v3"
          : `/${row.endpoint}`,
    );
    const result = validateFalOperationResult(row.endpoint, row.output);
    const extracted = extractArtifacts({ schema: snapshot.output, components: snapshot.schemas }, result);
    assert.equal(extracted.files.length, row.endpoint === "fal-ai/demucs" ? 2 : 1);
    assert.ok(extracted.files.every((file) => file.kind === "audio" && file.trusted));
  });

test("sound semantic guards refuse unsupported stems, language and foley encodings", () => {
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: "fal-ai/demucs",
        input: { audio_url: audio().url, model: "htdemucs", stems: ["piano"] },
      }),
    /6s/,
  );
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: "fal-ai/elevenlabs/voice-changer",
        input: { audio_url: audio().url, model_id: "eleven_english_sts_v2" },
        context: { speechLanguage: "ru" },
      }),
    /English only/,
  );
  for (const input of [
    { video_url: "data:audio/wav;base64,AAAA" },
    { video_url: "data:video/mp4;base64," + Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64") },
    { video_url: "https://example.com/a.mp4", upload_audio_bitrate_kbps: 128 },
    { video_url: "https://example.com/a.mp4", upload_audio_format: "mp3", upload_audio_bitrate_kbps: 33 },
    { video_url: "https://example.com/a.mp4", upload_audio_format: "aac", upload_audio_bitrate_kbps: 320 },
  ])
    assert.throws(
      () => buildFalOperation({ endpoint: "mirelo-ai/sfx2.0/video-to-audio", input }),
      /video|bitrate|rate/i,
    );
  const video = "https://example.com/a.mp4";
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: "mirelo-ai/sfx2.0/video-to-audio",
        input: { video_url: video },
        context: { media: { [video]: { durationSec: 0.5 } } },
      }),
    /at least 1/,
  );
});

function workspace(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "fal-sound-")));
  const directory = path.join(root, "public/projects/demo");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, directory };
}

test("sfx:generate CLI dry-run uses a temporary project/catalogue, one envelope and no writes", (t) => {
  const { root, directory } = workspace(t);
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      path.join(repo, "node_modules/tsx/dist/loader.mjs"),
      path.join(repo, "scripts/sfx-generate.ts"),
      "--project",
      "demo",
      "--prompt",
      "Paper",
      "--duration",
      "2",
      "--endpoint",
      contracts[0]!.endpoint,
      "--output",
      path.join(directory, "assets/sfx/take.mp3"),
      "--max-cost-usd",
      "1",
      "--dry-run",
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        AGENTBROS_NO_DOTENV: "1",
        PATH: process.env.PATH,
        AGENTBROS_FAL_CATALOG_DIR: dirs.catalogDir,
        AGENTBROS_FAL_SCHEMA_CACHE: dirs.cacheDir,
        AGENTBROS_MEMORY_ROOT: process.env.AGENTBROS_MEMORY_ROOT,
      },
    },
  );
  assert.equal(child.status, 0, child.stderr + child.stdout);
  assert.equal(child.stdout.trim().split("\n").length, 1);
  const result = JSON.parse(child.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.metadata.dryRun, true);
  assert.equal(result.metadata.take.status, "needs-generation");
  assert.deepEqual(result.outputs, []);
  assert.deepEqual(readdirSync(directory), ["project.json"]);
});

function wav() {
  const bytes = Buffer.alloc(44 + 16000 * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(bytes.length - 44, 40);
  return bytes;
}

test("fake SFX execution publishes project provenance and a resumable take without resubmitting", async (t) => {
  const { root, directory } = workspace(t);
  writeBudgetBrief(directory);
  const previous = process.cwd();
  process.chdir(root);
  try {
    let submits = 0;
    const provider: JobProvider = {
      submit: async () => {
        submits++;
        return { requestId: "sfx-1" };
      },
      inspect: async () => ({
        state: "completed",
        result: { audio: { ...audio("sound.mp3"), content_type: "audio/mpeg" } },
      }),
    };
    const encoded = spawnSync("ffmpeg", ["-v", "error", "-f", "wav", "-i", "pipe:0", "-f", "mp3", "pipe:1"], {
      input: wav(),
    });
    assert.equal(encoded.status, 0, encoded.stderr.toString());
    const mp3 = encoded.stdout;
    const options = {
      projectId: "demo",
      endpoint: contracts[0]!.endpoint,
      prompt: "Paper",
      durationSec: 2,
      output: path.join(directory, "assets/sfx/take.mp3"),
      maxCostUsd: 1,
      operationId: "sfx:take",
      provider,
      fetch: (async () => new Response(mp3)) as typeof fetch,
    };
    const first = await runSfxGeneration(options);
    const second = await runSfxGeneration(options);
    assert.equal(submits, 1);
    assert.deepEqual(second.outputs, first.outputs);
    assert.equal(first.metadata.take.status, "published");
    assert.equal(JSON.parse(readFileSync(`${options.output}.take.json`, "utf8")).operationId, "sfx:take");
    const registry = readAssetRegistry("demo");
    assert.equal(registry.assets.length, 1);
    assert.equal(registry.assets[0]!.kind, "audio");
    assert.equal(registry.assets[0]!.provenance.generationJobId, "sfx:take");
    assert.equal(registry.assets[0]!.provenance.model, options.endpoint);
    assert.equal(first.metadata.take.prompt, "Paper");
    assert.equal(JSON.parse(readFileSync(first.metadata.take.request, "utf8")).input.text, "Paper");
    await assert.rejects(
      runSfxGeneration({ ...options, output: options.output.replace(".mp3", ".wav") }),
      /must use .mp3/,
    );
    assert.equal(new OperationStore("demo").snapshot().jobs["sfx:take"]!.publication!.kind, "audio");
    await assert.rejects(runSfxGeneration({ ...options, prompt: "Different" }), /different inputs|different content/);
    await assert.rejects(runSfxGeneration({ ...options, output: path.join(root, "escape.wav") }), /escapes/);
    await assert.rejects(runSfxGeneration({ ...options, endpoint: "fal-ai/lyria2" }), /music/);
  } finally {
    process.chdir(previous);
  }
});

test("foley checks physical video kind, duration and size before a provider call", async (t) => {
  const { root, directory } = workspace(t);
  const previous = process.cwd();
  process.chdir(root);
  try {
    const source = path.join(root, "source.wav");
    writeFileSync(source, wav());
    const options = {
      projectId: "demo",
      endpoint: "mirelo-ai/sfx2.0/video-to-audio",
      video: source,
      output: path.join(directory, "assets/foley.wav"),
      maxCostUsd: 1,
      dryRun: true,
    };
    await assert.rejects(runSfxGeneration(options), /video stream/);
    const video = path.join(root, "source.mp4");
    for (const duration of [0.5, 1.2]) {
      const ffmpeg = spawnSync("ffmpeg", [
        "-v",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=s=16x16:r=10",
        "-t",
        String(duration),
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        video,
      ]);
      assert.equal(ffmpeg.status, 0, ffmpeg.stderr.toString());
      if (duration < 1) await assert.rejects(runSfxGeneration({ ...options, video }), /at least 1/);
      else {
        const result = await runSfxGeneration({ ...options, video });
        assert.equal(result.metadata.plan.input.num_samples, 1);
        assert.equal(result.metadata.plan.input.preserve_speech, false);
        assert.match(String(result.metadata.plan.input.video_url), /^data:video\//);
        assert.deepEqual(readdirSync(directory), ["project.json"]);
      }
    }
    writeFileSync(video, Buffer.alloc(8 * 1024 * 1024 + 1));
    await assert.rejects(runSfxGeneration({ ...options, video }), /8 MB/);
  } finally {
    process.chdir(previous);
  }
});

const musicInfo = (endpoint: string): FalGuardInfo => ({ endpoint, inputSchema: {}, components: {} });
test("music plugin accepts each allow-list builder's exact provider bytes, including composition plans", () => {
  const requests: Record<string, FalMusicRequest> = {
    "fal-ai/elevenlabs/music": { prompt: "Warm piano", durationSec: 16 },
    "fal-ai/lyria2": { prompt: "Warm piano", negativePrompt: "vocals", seed: 2 },
    "fal-ai/minimax-music/v2.6": { prompt: "Warm piano instrumental", instrumental: true },
    "minimax/music-3": { prompt: "Warm piano", durationSec: 16, instrumental: true, seed: 2 },
    "fal-ai/stable-audio-3/small/music/text-to-audio": {
      prompt: "Warm piano",
      durationSec: 16,
      seed: 2,
      negativePrompt: "vocals",
    },
  };
  for (const [endpoint, request] of Object.entries(requests)) {
    const { input } = buildFalMusicOperation(endpoint, request);
    assert.equal(musicGuard.match(musicInfo(endpoint)), true);
    assert.deepEqual(buildFalOperation({ endpoint, input }).input, input);
  }
  const endpoint = "fal-ai/elevenlabs/music";
  const { input } = buildFalMusicOperation(endpoint, {
    compositionPlan: { sections: [{ section_name: "Intro", duration_ms: 4000 }] },
  });
  assert.deepEqual(buildFalOperation({ endpoint, input }).input, input);
});

test("generic music validates schema capabilities without the CLI's narrower policy", () => {
  const endpoint = "minimax/music-3";
  const input = { prompt: "Warm piano", lyrics: "[verse]\nMorning light", duration: 60 };
  assert.deepEqual(buildFalOperation({ endpoint, input }).input, input);
  assert.throws(() => buildFalMusicOperation(endpoint, { prompt: "Warm piano", durationSec: 60 }), /instrumental/);
  assert.throws(() => buildFalOperation({ endpoint, input: { ...input, duration: 301 } }), /maximum/);
  assert.throws(() => buildFalOperation({ endpoint, input: { ...input, seed: 1.5 } }), /alternatives/);
  assert.throws(
    () => buildFalOperation({ endpoint, input: { ...input, negative_prompt: "noise" } }),
    /unknown|unexpected|unsupported/i,
  );
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: "fal-ai/elevenlabs/music",
        input: {
          music_length_ms: 16000,
          composition_plan: buildFalMusicOperation("fal-ai/elevenlabs/music", {
            compositionPlan: { sections: [{ section_name: "Intro", duration_ms: 4000 }] },
          }).input.composition_plan,
        },
      }),
    /only be used with prompt/,
  );
  assert.throws(
    () => buildFalOperation({ endpoint: "fal-ai/minimax-music/v2.6", input: { prompt: "Warm piano with voice" } }),
    /Lyrics/,
  );
});
