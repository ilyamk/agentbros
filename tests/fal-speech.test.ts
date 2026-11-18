import "./helpers/fal-no-network";
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { useTempFalCatalog } from "./helpers/fal-temp-catalog";
import {
  buildFalOperation,
  resolveFalSnapshotForPlan,
  validateFalOperationResult,
} from "../src/lib/providers/fal-operations";
import { findCatalogEntry, readCachedApiModel } from "../src/lib/models/fal-catalog";
import { openApiRoutes } from "../src/lib/providers/fal-openapi";
import { extractArtifacts } from "../src/lib/providers/fal-results";
import { quoteInputForPlan } from "../src/lib/providers/fal-quote-input";
import { quote } from "../src/lib/pricing";
import { resetFalPricesCache } from "../src/lib/models/fal-pricing";
import { normaliseFalTranscript } from "../src/lib/speech/fal-transcript";
import { normaliseFalTtsAlignment } from "../src/lib/speech/fal-tts-alignment";
import { runFalTranscribe, runFalVoiceover } from "../src/lib/speech/fal-run";
import { readFootageState, decideNext } from "../src/lib/footage/next";
import { OperationStore } from "../src/lib/jobs/store";
import type { JobProvider } from "../src/lib/jobs/runner";
import { USER_GRANT } from "./helpers/ceiling-grant";

const repo = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "fal-speech-"));
const url = "https://v3.fal.media/files/test/input.mp3";
const audioResult = { audio: { url, content_type: "audio/wav" } };
const nativeResult = {
  text: "Hello world.",
  language_code: "eng",
  language_probability: 0.9,
  words: [
    { text: "Hello", type: "word", start: 0.1, end: 0.4, speaker_id: "A / ?" },
    { text: " ", type: "spacing", start: 0.4, end: 0.5 },
    { text: "world.", type: "word", start: 0.5, end: 1.1, speaker_id: "A / ?" },
  ],
};
const segmentResult = {
  text: "Hello world.",
  chunks: [{ text: "Hello world.", timestamp: [0.1, 1.1] }],
  languages: ["en"],
};
const cases = [
  {
    endpoint: "fal-ai/elevenlabs/speech-to-text/scribe-v2",
    input: { audio_url: url },
    kinds: ["text", "json"],
    result: nativeResult,
  },
  { endpoint: "fal-ai/wizper", input: { audio_url: url }, kinds: ["text", "json"], result: segmentResult },
  {
    endpoint: "elevenlabs/tts/eleven-v4",
    input: { text: "Hello world." },
    kinds: ["audio", "json"],
    result: { ...audioResult, timestamps: [{ word: "Hello", start: 0.1, end: 0.5 }] },
  },
  {
    endpoint: "fal-ai/qwen-3-tts/text-to-speech/1.7b",
    input: { text: "Hello world." },
    kinds: ["audio"],
    result: audioResult,
  },
  {
    endpoint: "nvidia/nemotron-3-nano-omni/audio",
    input: { audio_url: url, prompt: "Describe the audio." },
    kinds: ["text", "json"],
    result: { output: "A speaker says hello.", usage: { input_tokens: 5, output_tokens: 4 } },
  },
  {
    endpoint: "resemble-ai/chatterboxhd/speech-to-speech",
    input: { source_audio_url: url },
    kinds: ["audio"],
    result: audioResult,
  },
];
const currentWizperHash = "62ef9569fa8244da5010e8f0676a21c3b1623ce90336d7dc47b278a273f3b7dc";
const tempCatalog = useTempFalCatalog(
  cases.map((row) => ({
    endpoint: row.endpoint,
    patch: {
      tier: "verified",
      ...(row.endpoint === "fal-ai/wizper"
        ? {
            schema: {
              sha256: currentWizperHash,
              asOf: "2026-11-15",
              source: "https://api.fal.ai/v1/models",
              cached: true,
            },
          }
        : {}),
      outputs: { kinds: row.kinds as ("text" | "json" | "audio")[], fields: Object.keys(row.result) },
    },
  })),
);
copyFileSync(
  path.join(repo, "tests/fixtures/fal-catalog/schemas", `${currentWizperHash}.json`),
  path.join(tempCatalog.cacheDir, `${currentWizperHash}.json`),
);
process.chdir(root);
test.after(() => {
  process.chdir(repo);
  rmSync(root, { recursive: true, force: true });
});
const source = { file: "source.wav", sha256: "a".repeat(64), durationSec: 2 };

for (const row of cases)
  test(`speech contract: ${row.endpoint}`, () => {
    const context = { media: { [url]: { durationSec: 120 } } };
    const plan = buildFalOperation({ endpoint: row.endpoint, input: row.input, context });
    assert.deepEqual(plan.outputKinds, row.kinds);
    const entry = findCatalogEntry(row.endpoint)!;
    const routes = openApiRoutes(readCachedApiModel(entry.schema!.sha256)!);
    assert.equal(
      routes?.submitPath.replace(/^\//, ""),
      row.endpoint === cases[4]!.endpoint
        ? "fal-ai/nemotron-3-nano-omni/audio"
        : row.endpoint === cases[5]!.endpoint
          ? "Resemble-AI/ChatterboxHD/speech-to-speech"
          : row.endpoint.startsWith("fal-ai/")
            ? row.endpoint
            : `fal-ai/${row.endpoint}`,
    );
    const quantities = quoteInputForPlan(plan, plan.input, context);
    if ("audio_url" in row.input) assert.equal(quantities.inputAudioSec, 120);
    if (typeof row.input.text === "string") assert.equal(quantities.inputCharacters, row.input.text.length);
    assert.equal(quote({ model: row.endpoint, ...quantities }).bounded, false);
    const valid = validateFalOperationResult(row.endpoint, row.result);
    const snapshot = resolveFalSnapshotForPlan(plan);
    const extracted = extractArtifacts({ schema: snapshot.output, components: snapshot.schemas }, valid);
    if (row.kinds.includes("audio")) assert.equal(extracted.files[0]?.kind, "audio");
    else assert.ok(Object.keys(extracted.data).length);
  });

test("description-only speech limits and overrides", () => {
  assert.throws(
    () => buildFalOperation({ endpoint: cases[0]!.endpoint, input: { audio_url: url, keyterms: ["a".repeat(51)] } }),
    /50 characters/,
  );
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: cases[4]!.endpoint,
        input: cases[4]!.input,
        context: { media: { [url]: { durationSec: 3001 } } },
      }),
    /50 minutes/,
  );
  assert.throws(
    () =>
      buildFalOperation({
        endpoint: cases[4]!.endpoint,
        input: { audio_url: "https://example.com/clip.ogg", prompt: "Describe." },
      }),
    /wav or mp3/,
  );
  assert.throws(
    () => buildFalOperation({ endpoint: cases[3]!.endpoint, input: { text: "Hello", language: "Indonesian" } }),
    /enum|one of/,
  );
  assert.doesNotThrow(() =>
    buildFalOperation({
      endpoint: cases[4]!.endpoint,
      input: { audio_url: "https://example.com/signed-audio?token=fixture", prompt: "Describe." },
    }),
  );
  assert.ok(
    buildFalOperation({
      endpoint: cases[5]!.endpoint,
      input: { source_audio_url: url, target_voice: "Aurora", target_voice_audio_url: url },
    }).warnings.some((value) => /overrides/.test(value)),
  );
});

test("native STT words preserve times, skip spaces and retain speaker labels", () => {
  const transcript = normaliseFalTranscript(nativeResult, { source, endpoint: cases[0]!.endpoint });
  assert.equal(transcript.engine.provider, "fal");
  assert.equal(transcript.engine.timing, "native");
  assert.equal(transcript.engine.verbatim, false);
  assert.deepEqual(
    transcript.words.map((word) => [word.text, word.startSec, word.endSec, word.speaker]),
    [
      ["Hello", 0.1, 0.4, "speaker_1"],
      ["world.", 0.5, 1.1, "speaker_1"],
    ],
  );
  assert.deepEqual(transcript.speakers, [{ id: "speaker_1", label: "A / ?" }]);
  const emptySpeaker = normaliseFalTranscript(
    { ...nativeResult, words: [{ text: "Hello", type: "word", start: 0.1, end: 0.4, speaker_id: "" }] },
    { source, endpoint: cases[0]!.endpoint },
  );
  assert.deepEqual(emptySpeaker.speakers, []);
  assert.equal(emptySpeaker.words[0]?.speaker, null);
});

test("segments and chunks explicitly estimate words; never invent bounds for null timestamps", () => {
  const transcript = normaliseFalTranscript(segmentResult, { source, endpoint: cases[1]!.endpoint });
  assert.equal(transcript.engine.timing, "estimated");
  assert.deepEqual(
    transcript.words.map((word) => [word.startSec, word.endSec]),
    [
      [0.1, 0.6],
      [0.6, 1.1],
    ],
  );
  const nested = normaliseFalTranscript(
    { segments: [{ speaker: "Jane", words: [{ text: "Hi", start: 0.2, end: 0.4 }] }] },
    { source, endpoint: "fixture" },
  );
  assert.equal(nested.engine.timing, "native");
  assert.equal(nested.speakers[0]?.label, "Jane");
  assert.throws(
    () =>
      normaliseFalTranscript(
        { text: "Hi", chunks: [{ text: "Hi", timestamp: [0, null] }] },
        { source, endpoint: "fixture" },
      ),
    /no usable timestamps/,
  );
  assert.throws(
    () =>
      normaliseFalTranscript(
        { provider: "fal.ai", endpoint: "wrong", data: nativeResult },
        { source, endpoint: "fixture" },
      ),
    /endpoint differs/,
  );
  assert.throws(() => normaliseFalTranscript({}, { source, endpoint: "fixture" }), /requires words/);
});

test("TTS only accepts explicitly labelled word timing, without fabricated loss or confidence", () => {
  assert.deepEqual(normaliseFalTtsAlignment(cases[2]!.result), { words: [{ text: "Hello", start: 0.1, end: 0.5 }] });
  for (const value of [
    {},
    { timestamps: [{ text: "H", start: 0, end: 0.1 }] },
    { timestamps: [{ word: "Hi", start: 1, end: 0 }] },
    { timestamps: [{ word: "Hi", start: 0 }] },
  ])
    assert.equal(normaliseFalTtsAlignment(value), null);
});

let sequence = 0;
function project() {
  const id = `speech-${++sequence}`;
  const directory = path.resolve("public/projects", id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "project.json"), "{}");
  const store = new OperationStore(id);
  store.configure({ ceilingUsd: 2, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  return { projectId: id, directory, store };
}
const wav = path.join(root, "tone.wav");
assert.equal(spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", wav]).status, 0);
function provider(result: Record<string, unknown>) {
  const requests: Record<string, unknown>[] = [];
  const fake: JobProvider = {
    submit: async (_endpoint, input) => {
      requests.push(input);
      return { requestId: "fake" };
    },
    inspect: async () => ({ state: "completed", result }),
  };
  return { fake, requests };
}
const fakeDownload = (async () => new Response(readFileSync(wav))) as typeof fetch;

test("fal transcribe durable fake-provider path, raw replay and resumed operation", async () => {
  const p = project(),
    fake = provider(nativeResult),
    output = path.join(p.directory, "pipeline/transcript.json");
  const run = {
    ...p,
    endpoint: cases[0]!.endpoint,
    inputPath: wav,
    output,
    operationId: "transcript",
    maxCostUsd: 0.1,
    provider: fake.fake,
    pollMs: 0,
  };
  const result = await runFalTranscribe(run);
  assert.equal(result.metadata.wordCount, 2);
  assert.equal(fake.requests.length, 1);
  assert.equal(p.store.snapshot().jobs.transcript?.publication?.kind, "json");
  assert.ok(result.outputs.some((file) => file.includes("pipeline/model-results/transcript.json")));
  assert.equal(p.store.snapshot().jobs.transcript?.quote.highUsd, 0.1);
  await runFalTranscribe({ ...run, force: true });
  assert.equal(fake.requests.length, 1);
  const replay = path.join(p.directory, "replayed.json");
  await runFalTranscribe({ ...run, output: replay, fromRaw: output.replace(/\.json$/, ".fal.json") });
  assert.deepEqual(JSON.parse(readFileSync(replay, "utf8")), JSON.parse(readFileSync(output, "utf8")));
});

test("fal voiceover converts WAV to MP3, publishes word sidecar only when supplied and clears stale alignment", async () => {
  const p = project(),
    fake = provider(cases[2]!.result),
    output = path.join(p.directory, "voiceover/scene.mp3");
  const run = {
    ...p,
    endpoint: cases[2]!.endpoint,
    text: "Hello",
    voice: "Rachel",
    language: "en",
    output,
    maxCostUsd: 0.1,
    provider: fake.fake,
    fetch: fakeDownload,
    pollMs: 0,
  };
  const result = await runFalVoiceover(run);
  assert.equal(result.metadata.alignment, "provider");
  assert.deepEqual(JSON.parse(readFileSync(output.replace(/\.mp3$/, ".words.json"), "utf8")), {
    words: [{ text: "Hello", start: 0.1, end: 0.5 }],
  });
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", output], {
    encoding: "utf8",
  });
  assert.equal(probe.stdout.trim(), "mp3");
  const editedPath = output.replace(/\.mp3$/, ".words.edited.json");
  writeFileSync(editedPath, JSON.stringify({ words: [{ text: "Stale", start: 5, end: 6 }] }));
  const qwen = provider(audioResult);
  const missing = await runFalVoiceover({
    ...run,
    endpoint: cases[3]!.endpoint,
    voice: "Ryan",
    language: "ru",
    provider: qwen.fake,
    force: true,
  });
  assert.equal(missing.metadata.alignment, "needed");
  assert.equal(missing.metadata.nextAction, `pnpm align:captions --project ${p.projectId}`);
  assert.equal(existsSync(output.replace(/\.mp3$/, ".words.json")), false);
  assert.equal(existsSync(editedPath), false);
  assert.equal(qwen.requests[0]?.language, "Russian");
  await assert.rejects(
    runFalVoiceover({ ...run, endpoint: cases[3]!.endpoint, voice: "Ryan", language: "id", force: true }),
    /enum|one of/,
  );
});

test("minute and kilo-character quote quantities use measured input and sent text", async () => {
  const prices = path.join(root, "prices.json");
  writeFileSync(
    prices,
    JSON.stringify({
      version: 1,
      syncedAt: "2026-11-15",
      prices: [
        {
          endpoint: cases[2]!.endpoint,
          unitPrice: 0.2,
          unit: "1000 characters",
          currency: "USD",
          observedAsOf: "2026-11-15",
          source: "platform-pricing-api",
        },
        {
          endpoint: cases[0]!.endpoint,
          unitPrice: 0.3,
          unit: "minutes",
          currency: "USD",
          observedAsOf: "2026-11-15",
          source: "platform-pricing-api",
        },
      ],
    }),
  );
  const prior = process.env.AGENTBROS_FAL_PRICES;
  process.env.AGENTBROS_FAL_PRICES = prices;
  resetFalPricesCache();
  try {
    const stt = await runFalTranscribe({
      endpoint: cases[0]!.endpoint,
      inputPath: wav,
      output: path.join(root, "dry.json"),
      dryRun: true,
    });
    assert.equal((stt.metadata.quote as { highUsd: number }).highUsd, 0.01);
    assert.equal((stt.metadata.quoteInput as { inputAudioSec: number }).inputAudioSec, 2);
    const premium = await runFalTranscribe({
      endpoint: cases[0]!.endpoint,
      inputPath: wav,
      output: path.join(root, "dry-keyterms.json"),
      keyterms: ["Remotion"],
      dryRun: true,
    });
    assert.ok(Math.abs((premium.metadata.quote as { highUsd: number }).highUsd - 0.013) < 1e-12);
    assert.equal((premium.metadata.quoteInput as { multiplier: number }).multiplier, 1.3);
    const tts = await runFalVoiceover({
      endpoint: cases[2]!.endpoint,
      text: "a".repeat(1001),
      output: path.join(root, "dry.mp3"),
      dryRun: true,
    });
    assert.equal((tts.metadata.quote as { highUsd: number }).highUsd, 0.4);
    assert.equal(existsSync(path.join(root, "dry.mp3")), false);
  } finally {
    if (prior === undefined) delete process.env.AGENTBROS_FAL_PRICES;
    else process.env.AGENTBROS_FAL_PRICES = prior;
    resetFalPricesCache();
  }
});

test("both speech CLIs dry-run offline with one JSON line and no output writes", () => {
  const p = project();
  mkdirSync(path.join(p.directory, "pipeline"), { recursive: true });
  writeFileSync(
    path.join(p.directory, "pipeline/script.json"),
    JSON.stringify({
      voiceoverEnabled: true,
      narratorVoice: "drew",
      language: "en",
      beats: [
        { id: "beat1", kind: "hook", text: "Hello world.", durationSec: 2, visualNotes: "Speaker", emotion: "neutral" },
      ],
    }),
  );
  for (const [script, args] of [
    ["transcribe", ["--input", wav, "--output", path.join(root, "cli.json"), "--endpoint", cases[0]!.endpoint]],
    [
      "generate-voiceover",
      ["--project", p.projectId, "--endpoint", cases[3]!.endpoint, "--voice", "Ryan", "--language", "ru"],
    ],
  ] as const) {
    const before = readdirSync(p.directory);
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        path.join(repo, "node_modules/tsx/dist/loader.mjs"),
        path.join(repo, `scripts/${script}.ts`),
        "--provider",
        "fal",
        "--dry-run",
        ...args,
      ],
      {
        cwd: root,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          AGENTBROS_FAL_CATALOG_DIR: process.env.AGENTBROS_FAL_CATALOG_DIR,
          AGENTBROS_FAL_SCHEMA_CACHE: process.env.AGENTBROS_FAL_SCHEMA_CACHE,
        },
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.equal(child.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(child.stdout).ok, true);
    assert.deepEqual(readdirSync(p.directory), before);
  }
});

test("raw replay dry-run preserves an existing transcript without force", async () => {
  const output = path.join(root, "existing.json"),
    raw = path.join(root, "replay.fal.json");
  writeFileSync(output, "original");
  writeFileSync(raw, JSON.stringify(nativeResult));
  const result = await runFalTranscribe({
    endpoint: cases[0]!.endpoint,
    inputPath: wav,
    output,
    fromRaw: raw,
    dryRun: true,
  });
  assert.deepEqual(result.outputs, []);
  assert.equal(result.metadata.dryRun, true);
  assert.equal(readFileSync(output, "utf8"), "original");
});

test("footage discovery accepts a fal transcript and advances to the speech mask", () => {
  const p = project(),
    video = path.join(p.directory, "assets/footage/talk.mp4");
  mkdirSync(path.dirname(video), { recursive: true });
  assert.equal(
    spawnSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-i",
      wav,
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-shortest",
      video,
    ]).status,
    0,
  );
  const transcript = normaliseFalTranscript(nativeResult, {
    source: { file: video, sha256: createHash("sha256").update(readFileSync(video)).digest("hex"), durationSec: 2 },
    endpoint: cases[0]!.endpoint,
  });
  writeFileSync(path.join(p.directory, "pipeline/transcript.json"), JSON.stringify(transcript));
  const state = readFootageState(p.projectId, {
    rootDir: root,
    save: false,
    overrides: { goals: ["captions"], captionStyle: "boxed-word" },
  });
  assert.equal(state.transcripts[0]?.provider, "fal");
  assert.equal(state.transcripts[0]?.valid, true);
  assert.equal(decideNext(state).step, "1-speech-mask");
});
