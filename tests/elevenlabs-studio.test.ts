import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { executeStudioAudio, validateKnownStitchingIds } from "../src/lib/elevenlabs/operations";
import { compileSpeechCues, validateDirectedText } from "../src/lib/elevenlabs/direction";
import { characterWords } from "../src/lib/elevenlabs/timings";
import { ElevenLabsClient } from "../src/lib/elevenlabs/client";
import { verifyVoiceRef } from "../src/lib/elevenlabs/files";
import { digest } from "../src/lib/jobs/model-artifacts";
import {
  discoverVoices,
  executeVoiceManagement,
  recordVoiceSelection,
  voiceReadiness,
} from "../src/lib/elevenlabs/voices";
import { ElevenLabsAudioRequestSchema, VoiceManagementRequestSchema } from "../src/types/elevenlabs";
import { OperationStore } from "../src/lib/jobs/store";
import { pinPackSpeechScript, verifyPackSpeech } from "../src/lib/references/packs/speech";
import { ReferencePackSpecSchema } from "../src/types/references";
import { USER_GRANT } from "./helpers/ceiling-grant";

function setup(t: test.TestContext) {
  const root = mkdtempSync(path.join(tmpdir(), "el-studio-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "project.json"), "{}");
  const store = new OperationStore("demo", {
    directory: path.join(project, "pipeline"),
    responseCacheDirectory: path.join(root, ".cache/paid-responses"),
  });
  store.configure({ ceilingUsd: 10, maxJobUsd: 3, repairReserveFraction: 0 }, USER_GRANT);
  const audio = path.join(root, "fixture.mp3");
  const encoded = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=1",
    "-c:a",
    "libmp3lame",
    audio,
  ]);
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  return { root, project, store, audio, bytes: readFileSync(audio) };
}
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "request-id": "FAKE_REMOTE" },
  });
const alignment = (value: string) => ({
  characters: [...value],
  character_start_times_seconds: [...value].map((_, i) => i * 0.05),
  character_end_times_seconds: [...value].map((_, i) => (i + 1) * 0.05),
});

test("open tags preserve approved words, numeric meaning, bracket literals and word boundaries", () => {
  const text = "Не открывай [АРХИВ]. Осталось 2,5%.";
  const directed = compileSpeechCues(text, [{ offset: 0, direction: "quietly reassuring" }]);
  validateDirectedText(text, directed);
  assert.throws(() => validateDirectedText(text, "[quietly] Ты открывай [АРХИВ]. Осталось 2,5%."), /approved words/);
  assert.throws(() => validateDirectedText(text, "Не открывай [АРХИВ]. Осталось 25%."), /numbers/);
  assert.throws(() => validateDirectedText(text, "Не открывай АРХИВ. Осталось 2,5%."), /literal bracketed/);
  assert.throws(() => compileSpeechCues(text, [{ offset: 1, direction: "quietly" }]), /word boundary/);
  const japanese = "今日も元気です";
  assert.ok(characterWords(alignment(japanese), japanese, 1, undefined, undefined, "ja").length > 1);
  const approved = "Call Niamh.";
  const pronunciations = [{ start: 5, end: 10, ipa: "niːv" }];
  const spoken = compileSpeechCues(approved, [], pronunciations);
  assert.equal(spoken, "Call /niːv/.");
  validateDirectedText(approved, spoken, pronunciations);
  assert.deepEqual(
    characterWords(alignment(spoken), spoken, 1, undefined, undefined, "en", {
      approvedText: approved,
      pronunciations,
    }).map((word) => word.text),
    ["Call", "Niamh."],
  );
  assert.throws(() => validateDirectedText(approved, "Call niːv.", pronunciations), /approved inline IPA/);
});

test("v4 TTS serialises endpoint controls, validates model limits and retains provider headers on replay", async (t) => {
  const env = setup(t);
  const request = {
    version: 1,
    projectId: "demo",
    task: "tts",
    output: "public/projects/demo/v4.mp3",
    voiceId: "voice_A",
    model: "eleven_v4",
    language: "en-GB",
    text: "12.",
    approvedText: "12.",
    expectedSpokenText: "Twelve.",
    textNormalization: "on",
    settings: { stability: 0.4, similarity_boost: 0.72 },
    lineId: "a",
    speaker: "host",
    previousText: "Earlier.",
    nextRequestIds: ["next"],
    seed: 0,
    maxCostUsd: 1,
  };
  let posts = 0;
  const options = {
    rootDir: env.root,
    store: env.store,
    dryRun: false,
    apiKey: "FAKE_TEST_ONLY",
    fetch: (async (url: string, init?: RequestInit) => {
      posts++;
      assert.match(url, /voice_A\/with-timestamps\?output_format=mp3_44100_128/);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model_id: "eleven_v4",
        language_code: "en",
        text: "12.",
        seed: 0,
        apply_text_normalization: "on",
        previous_text: "Earlier.",
        next_request_ids: ["next"],
        voice_settings: request.settings,
      });
      return new Response(
        JSON.stringify({
          audio_base64: env.bytes.toString("base64"),
          alignment: { invalid: true },
          normalized_alignment: alignment("Twelve."),
        }),
        { headers: { "request-id": "FAKE_V4", "character-cost": "18" } },
      );
    }) as typeof fetch,
  };
  assert.equal(ElevenLabsAudioRequestSchema.safeParse({ ...request, text: "x".repeat(10_001) }).success, false);
  assert.equal(ElevenLabsAudioRequestSchema.safeParse({ ...request, enableLogging: false }).success, false);
  assert.equal(ElevenLabsAudioRequestSchema.safeParse({ ...request, settings: { speed: 1.1 } }).success, false);
  await executeStudioAudio(request, options);
  const file = path.join(env.project, "v4.mp3.take.json");
  const original = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(original.providerRequestId, "FAKE_V4");
  assert.equal(original.characterCost, 18);
  assert.equal(original.timing.source, "normalised");
  assert.equal(original.timing.words[0].lineId, "a");
  assert.equal(original.timing.words[0].speaker, "host");
  rmSync(file);
  await executeStudioAudio(request, options);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original);
  assert.equal(posts, 1);
  const job = Object.values(env.store.snapshot().jobs)[0]!;
  assert.doesNotThrow(() => validateKnownStitchingIds(["FAKE_V4"], [job], "elevenlabs:eleven_v4"));
  assert.throws(() => validateKnownStitchingIds(["FAKE_V4"], [job], "elevenlabs:tts-v3"), /same model/);
  assert.throws(
    () =>
      validateKnownStitchingIds(
        ["FAKE_V4"],
        [job],
        "elevenlabs:eleven_v4",
        Date.parse(job.createdAt) + 2 * 60 * 60 * 1000 + 1,
      ),
    /two hours/,
  );
});

test("v4 dialogue keeps individual line ownership with a shared voice and uses dialogue wire settings", async (t) => {
  const env = setup(t);
  const voiceRef = { provider: "elevenlabs", voiceId: "voice_A", model: "eleven_v4", language: "ru" };
  const request = {
    version: 1,
    projectId: "demo",
    task: "dialogue",
    output: "public/projects/demo/dialogue-v4.mp3",
    model: "eleven_v4",
    language: "ru",
    settings: { similarity: 0.7 },
    nextText: "Потом.",
    turns: [
      { text: "Да", approvedText: "Да", speaker: "a", sceneId: "s1", lineId: "first", voiceRef },
      { text: "Нет", approvedText: "Нет", speaker: "b", sceneId: "s1", lineId: "second", voiceRef },
    ],
    maxCostUsd: 1,
  };
  await executeStudioAudio(request, {
    rootDir: env.root,
    store: env.store,
    apiKey: "TEST",
    dryRun: false,
    fetch: (async (url: string, init?: RequestInit) => {
      assert.match(url, /text-to-dialogue\/with-timestamps/);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model_id: "eleven_v4",
        language_code: "ru",
        settings: request.settings,
        future_text: "Потом.",
        inputs: request.turns.map((turn) => ({ text: turn.text, voice_id: "voice_A" })),
      });
      return reply({
        audio_base64: env.bytes.toString("base64"),
        alignment: alignment("Да Нет"),
        voice_segments: [
          [0, 2],
          [3, 6],
        ].map(([start, end], index) => ({
          dialogue_input_index: index,
          voice_id: "voice_A",
          character_start_index: start,
          character_end_index: end,
          start_time_seconds: start! * 0.05,
          end_time_seconds: end! * 0.05,
        })),
      });
    }) as typeof fetch,
  });
  const take = JSON.parse(readFileSync(path.join(env.project, "dialogue-v4.words.json"), "utf8"));
  assert.deepEqual(
    take.words.map((word: { lineId: string }) => word.lineId),
    ["first", "second"],
  );
  const receiptPath = `${request.output}.take.json`;
  const receiptBytes = readFileSync(path.join(env.root, receiptPath));
  const receipt = JSON.parse(receiptBytes.toString());
  const lines = request.turns.map((turn, index) => ({
    lineId: turn.lineId,
    speakerId: turn.speaker,
    text: turn.approvedText,
    language: "ru",
    startSec: index * 0.2,
    endSec: (index + 1) * 0.2,
  }));
  const scriptFile = path.join(env.project, "pipeline/script.json");
  writeFileSync(
    scriptFile,
    JSON.stringify({
      narratorVoice: "adam",
      voiceoverEnabled: false,
      language: "ru",
      beats: [],
      dialogue: lines.map(({ lineId, speakerId, text, language }) => ({
        lineId,
        speakerId,
        text,
        language,
        sceneId: "s1",
        voiceRef,
      })),
    }),
  );
  const spec = pinPackSpeechScript(
    "demo",
    ReferencePackSpecSchema.parse({
      schemaVersion: 1,
      id: "shot-s1",
      shotId: "s1",
      endpoint: "bytedance/seedance-2.5/reference-to-video",
      profileFamily: "seedance-2.5",
      audioPolicy: "replace-in-edit",
      prompt: { action: "The speakers respond." },
      attachments: [
        {
          requirementKey: "voice",
          source: { assetId: receipt.assetId },
          slot: "audio",
          order: 1,
          roleSentence: "the dialogue",
          speech: {
            kind: "performed-lines",
            use: "reference",
            sha256: receipt.sha256,
            receipt: receiptPath,
            receiptSha256: digest(receiptBytes),
            lines,
          },
        },
      ],
    }),
    env.root,
  );
  assert.doesNotThrow(() => verifyPackSpeech("demo", spec, env.root));
  const sidecar = path.join(env.project, "dialogue-v4.words.json");
  const alignmentBytes = readFileSync(sidecar);
  writeFileSync(sidecar, "{}");
  assert.throws(() => verifyPackSpeech("demo", spec, env.root), /alignment changed/);
  writeFileSync(sidecar, alignmentBytes);
  writeFileSync(scriptFile, "{}");
  assert.throws(() => verifyPackSpeech("demo", spec, env.root), /script changed/);
  assert.equal(
    ElevenLabsAudioRequestSchema.safeParse({ ...request, turns: [...request.turns, request.turns[0]] }).success,
    false,
  );
});

test("voice readiness and calibration are independent, and the selection pins every reviewed take", async (t) => {
  const env = setup(t);
  const manifest = path.join(env.project, "voice-ready.json");
  writeFileSync(manifest, JSON.stringify({ voiceId: "voice_A", model: "eleven_v4", readiness: "ready" }));
  const voiceRef = {
    provider: "elevenlabs" as const,
    voiceId: "voice_A",
    model: "eleven_v4",
    language: "en",
    manifest,
    manifestSha256: digest(readFileSync(manifest)),
  };
  const takes = ["neutral", "emotion", "short-line", "pronunciation"].map((use) => {
    const output = `${use}.mp3`,
      audio = path.join(env.project, output),
      receipt = `${audio}.take.json`;
    writeFileSync(audio, env.bytes);
    writeFileSync(
      receipt,
      JSON.stringify({
        provider: "elevenlabs",
        voiceId: "voice_A",
        output,
        sha256: digest(env.bytes),
        request: { voiceRef, model: "eleven_v4", language: "en" },
      }),
    );
    return { use, receipt, sha256: digest(readFileSync(receipt)) };
  });
  const selection = path.join(env.project, "choice.json");
  const request = { version: 1, projectId: "demo", output: selection, voiceRef, takes };
  assert.throws(() => recordVoiceSelection(request, undefined, env.root), /own words/);
  const result = recordVoiceSelection(request, "I listened and approve these four takes", env.root);
  const selected = { ...voiceRef, selection, selectionSha256: result.metadata.selectionSha256 };
  verifyVoiceRef(env.root, selected, env.root, "tts");
  assert.throws(() => verifyVoiceRef(env.root, { ...selected, language: "ru" }), /another voice/);
});

test("a shared professional clone is adopted read-only and checked against the requested v4 model and uses", async (t) => {
  const env = setup(t);
  const request = {
    version: 1,
    projectId: "demo",
    task: "adopt",
    voiceId: "shared_pvc",
    output: "public/projects/demo/pvc-v4.json",
    model: "eleven_v4",
    language: "ru",
    rights: { source: "Private actor share", consent: "Use my voice for narration", permittedUses: ["tts"] },
  };
  let reads = 0;
  const options = {
    rootDir: env.root,
    apiKey: "TEST",
    fetch: (async (url: string, init?: RequestInit) => {
      reads++;
      assert.match(url, /\/v1\/voices\/shared_pvc$/);
      assert.equal(init?.method ?? "GET", "GET");
      return reply({
        voice_id: request.voiceId,
        category: "professional",
        fine_tuning: { state: { eleven_v3: "fine_tuned", eleven_v4: "fine_tuned", eleven_v4_turbo: "training" } },
        voice_verification: { is_verified: true },
      });
    }) as typeof fetch,
  };
  const planned = await executeVoiceManagement(request, options);
  assert.equal(planned.metadata.state, "planned");
  assert.equal(reads, 0);
  await executeVoiceManagement(request, { ...options, dryRun: false });
  const manifest = path.join(env.root, request.output);
  const ref = {
    provider: "elevenlabs" as const,
    voiceId: request.voiceId,
    model: request.model,
    language: request.language,
    manifest,
    manifestSha256: digest(readFileSync(manifest)),
  };
  assert.doesNotThrow(() => verifyVoiceRef(env.root, ref, env.root, "tts"));
  assert.throws(() => verifyVoiceRef(env.root, ref, env.root, "dialogue"), /permission/);
  assert.throws(() => verifyVoiceRef(env.root, { ...ref, model: "eleven_v4_turbo" }), /selected model/);
  await executeVoiceManagement(request, { ...options, dryRun: false });
  assert.equal(reads, 1);
});

test("the fal Voice Changer passes the voice pinned by VoiceRef into the provider request", async (t) => {
  const env = setup(t);
  const previousCache = process.env.AGENTBROS_FAL_SCHEMA_CACHE;
  process.env.AGENTBROS_FAL_SCHEMA_CACHE = path.resolve(import.meta.dirname, "fixtures/fal-catalog/schemas");
  t.after(() => {
    if (previousCache === undefined) delete process.env.AGENTBROS_FAL_SCHEMA_CACHE;
    else process.env.AGENTBROS_FAL_SCHEMA_CACHE = previousCache;
  });
  const previous = process.cwd();
  process.chdir(env.root);
  try {
    const planned = await executeStudioAudio(
      {
        version: 1,
        projectId: "demo",
        task: "voice-change",
        provider: "fal",
        source: "fixture.mp3",
        output: "public/projects/demo/changed.mp3",
        model: "eleven_multilingual_sts_v2",
        language: "en",
        maxCostUsd: 1,
        voiceRef: {
          provider: "elevenlabs",
          model: "eleven_multilingual_sts_v2",
          language: "en",
          voiceId: "target_voice",
        },
      },
      { dryRun: true },
    );
    assert.equal(planned.metadata.state, "planned");
    const metadata = planned.metadata as { input?: { voice?: string }; derivation?: { sourceSha256?: string } };
    assert.equal(metadata.input?.voice, "target_voice");
    assert.equal(metadata.derivation?.sourceSha256, digest(env.bytes));
  } finally {
    process.chdir(previous);
  }
});

test("timestamped TTS plans without keys, publishes source-bound words, and recovers publication without another POST", async (t) => {
  const env = setup(t);
  let calls = 0;
  const request = {
    version: 1,
    projectId: "demo",
    output: "public/projects/demo/voice.mp3",
    task: "tts",
    text: "Hello.",
    voiceId: "voice_A",
    language: "en",
    maxCostUsd: 1,
  };
  const transport = (async (url, init) => {
    calls++;
    assert.match(String(url), /text-to-speech\/voice_A\/with-timestamps\?output_format=mp3_44100_128/);
    const data = JSON.parse(String(init?.body));
    assert.equal(data.text, request.text);
    return reply({ audio_base64: env.bytes.toString("base64"), alignment: alignment(request.text) });
  }) as typeof fetch;
  const dry = await executeStudioAudio(request, { rootDir: env.root, fetch: transport });
  assert.equal(dry.metadata.state, "planned");
  assert.equal(calls, 0);
  const options = { rootDir: env.root, store: env.store, dryRun: false, fetch: transport, apiKey: "FAKE_TEST_ONLY" };
  const result = await executeStudioAudio(request, options);
  assert.equal(result.metadata.state, "published");
  assert.equal(calls, 1);
  const take = JSON.parse(readFileSync(path.join(env.project, "voice.mp3.take.json"), "utf8"));
  assert.equal(take.voiceId, "voice_A");
  assert.equal(take.model, "eleven_v3");
  assert.equal(take.request.text, "Hello.");
  assert.equal(take.alignmentRequired, false);
  assert.equal(take.timing.words[0].text, "Hello.");
  assert.equal(take.timing.method, "derived-from-provider-character-alignment");
  const canonical = JSON.parse(readFileSync(path.join(env.project, "voice.words.json"), "utf8"));
  assert.equal(canonical.words[0].text, "Hello.");
  assert.equal(canonical.sourceSha256, take.sha256);
  await executeStudioAudio({ ...request, operationId: take.operationId, maxCostUsd: 0.000001 }, options);
  assert.equal(calls, 1);
  rmSync(path.join(env.project, "voice.words.json"));
  await executeStudioAudio(request, { ...options, dryRun: true });
  assert.equal(existsSync(path.join(env.project, "voice.words.json")), false);
  await executeStudioAudio(request, options);
  assert.ok(existsSync(path.join(env.project, "voice.words.json")));
  assert.equal(calls, 1);
  writeFileSync(path.join(env.project, "voice.words.json"), "corrupt");
  await assert.rejects(executeStudioAudio(request, options), /immutable|differs|exist/i);
  assert.equal(calls, 1);
  writeFileSync(path.join(env.project, "voice.words.json"), JSON.stringify(canonical, null, 2) + "\n");
  rmSync(path.join(env.project, "voice.mp3.take.json"));
  await executeStudioAudio({ ...request, maxCostUsd: 0.000001 }, options);
  assert.equal(calls, 1);
  assert.ok(env.store.summary().reservedUsd > 0, "publication does not invent settled billing");
});

test("dialogue preserves Cyrillic, scene and speaker ownership; altered normalisation is not guessed", async (t) => {
  const env = setup(t),
    text = "Hi. Да.";
  const turns = [
    { text: "Hi.", voiceId: "voice_A", speaker: "alice", sceneId: "s1" },
    { text: "Да.", voiceId: "voice_B", speaker: "bob", sceneId: "s2" },
  ];
  const voice_segments = [
    {
      voice_id: "voice_A",
      start_time_seconds: 0,
      end_time_seconds: 0.15,
      character_start_index: 0,
      character_end_index: 3,
      dialogue_input_index: 0,
    },
    {
      voice_id: "voice_B",
      start_time_seconds: 0.2,
      end_time_seconds: 0.35,
      character_start_index: 4,
      character_end_index: 7,
      dialogue_input_index: 1,
    },
  ];
  const result = await executeStudioAudio(
    {
      version: 1,
      projectId: "demo",
      output: "public/projects/demo/dialogue.mp3",
      task: "dialogue",
      turns,
      language: "ru",
      maxCostUsd: 1,
    },
    {
      rootDir: env.root,
      store: env.store,
      dryRun: false,
      apiKey: "FAKE",
      fetch: (async () =>
        reply({
          audio_base64: env.bytes.toString("base64"),
          alignment: alignment(text),
          voice_segments,
        })) as typeof fetch,
    },
  );
  assert.equal(result.metadata.state, "published");
  const take = JSON.parse(readFileSync(path.join(env.project, "dialogue.mp3.take.json"), "utf8"));
  assert.deepEqual(
    take.timing.words.map((word: { speaker: string; sceneId: string }) => [word.speaker, word.sceneId]),
    [
      ["alice", "s1"],
      ["bob", "s2"],
    ],
  );
  assert.throws(() => characterWords(alignment("forty"), "40", 1), /differs/);
  assert.throws(
    () => characterWords(alignment(text), text, 1, turns, [{ ...voice_segments[0], character_end_index: 7 }]),
    /match|ownership/,
  );
  assert.throws(() => characterWords({ ...alignment("a"), character_end_times_seconds: [5] }, "a", 1), /exceeds/);
});

test("transform keeps immutable source provenance and requires timing review despite equal duration", async (t) => {
  const env = setup(t);
  let calls = 0;
  const before = readFileSync(env.audio);
  const result = await executeStudioAudio(
    {
      version: 1,
      projectId: "demo",
      output: "public/projects/demo/clean.mp3",
      task: "isolate",
      source: env.audio,
      maxCostUsd: 1,
    },
    {
      rootDir: env.root,
      store: env.store,
      dryRun: false,
      apiKey: "FAKE",
      fetch: (async (_url, init) => {
        calls++;
        assert.ok(init?.body instanceof FormData);
        return new Response(env.bytes);
      }) as typeof fetch,
    },
  );
  assert.equal(result.metadata.state, "published");
  assert.equal(calls, 1);
  assert.deepEqual(readFileSync(env.audio), before);
  const take = JSON.parse(readFileSync(path.join(env.project, "clean.mp3.take.json"), "utf8"));
  assert.equal(take.alignmentRequired, true);
  assert.equal(take.clock.status, "requires-review");
  assert.match(take.source.sha256, /^[a-f0-9]{64}$/);
  await assert.rejects(
    executeStudioAudio(
      { version: 1, projectId: "demo", output: "public/projects/demo/bad.mp3", task: "isolate", source: "/etc/passwd" },
      { rootDir: env.root },
    ),
    /escapes/,
  );
});

test("unknown prices, invalid profiles and unconfigured budgets reject before POST", async (t) => {
  const env = setup(t);
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    throw Error("No request expected");
  }) as typeof fetch;
  const request = {
    version: 1,
    projectId: "demo",
    output: "public/projects/demo/unknown.mp3",
    task: "dialogue",
    turns: [{ text: "Hi", voiceId: "voice_A", speaker: "a", sceneId: "s1" }],
    language: "en",
  };
  await assert.rejects(
    executeStudioAudio(request, { rootDir: env.root, store: env.store, dryRun: false, fetch: fetcher }),
    /Unknown price/,
  );
  assert.equal(calls, 0);
  assert.equal(ElevenLabsAudioRequestSchema.safeParse({ ...request, model: "eleven_v4" }).success, true);
  assert.equal(ElevenLabsAudioRequestSchema.safeParse({ ...request, model: "eleven_v4_turbo" }).success, false);
  assert.equal(
    ElevenLabsAudioRequestSchema.safeParse({
      version: 1,
      task: "voice-change",
      projectId: "demo",
      output: "x",
      source: "x",
      voiceId: "v",
      language: "ru",
      model: "eleven_english_sts_v2",
    }).success,
    false,
  );
  assert.equal(
    VoiceManagementRequestSchema.safeParse({
      version: 1,
      task: "clone-instant",
      projectId: "demo",
      output: "x",
      name: "A",
      samples: ["x"],
    }).success,
    false,
  );
});

test("voice design previews and PVC metadata never become ready voices", async (t) => {
  const env = setup(t);
  let calls = 0;
  const design = {
    version: 1,
    task: "design",
    projectId: "demo",
    output: "public/projects/demo/design.json",
    description: "A calm and warm documentary narrator.",
    previewText:
      "This is the complete preview text for a calm documentary narrator. It is deliberately long enough for voice design.",
    maxCostUsd: 1,
  };
  await executeVoiceManagement(design, {
    rootDir: env.root,
    store: env.store,
    dryRun: false,
    apiKey: "FAKE",
    fetch: (async (_url, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.equal(body.voice_description, design.description);
      return reply({ previews: [{ generated_voice_id: "preview_A", audio_base_64: env.bytes.toString("base64") }] });
    }) as typeof fetch,
  });
  const saved = JSON.parse(readFileSync(path.join(env.project, "design.json"), "utf8"));
  assert.equal(saved.readiness, "awaiting-selection");
  assert.equal(saved.voiceId, undefined);
  assert.equal(calls, 1);
  await executeVoiceManagement(
    {
      version: 1,
      task: "clone-professional",
      projectId: "demo",
      output: "public/projects/demo/pvc.json",
      name: "Sample",
      language: "en",
      rights: { source: "Test fixture only", consent: "Test consent; not a real person or approval" },
      maxCostUsd: 1,
    },
    {
      rootDir: env.root,
      store: env.store,
      dryRun: false,
      apiKey: "FAKE",
      fetch: (async () => reply({ voice_id: "pvc_A" })) as typeof fetch,
    },
  );
  assert.equal(JSON.parse(readFileSync(path.join(env.project, "pvc.json"), "utf8")).readiness, "needs-verification");
  assert.equal(voiceReadiness({ fine_tuning: { state: { model: "fine_tuned" } } }, "model"), "needs-verification");
  assert.equal(
    voiceReadiness(
      { fine_tuning: { state: { model: "fine_tuned" } }, voice_verification: { requires_verification: false } },
      "model",
    ),
    "ready",
  );
  assert.ok(existsSync(path.join(env.project, "pipeline/asset-registry.json")));
});

test("voice search encodes spaces/Cyrillic and readiness refresh produces a model-bound manifest", async (t) => {
  const env = setup(t);
  let calls = 0;
  const client = new ElevenLabsClient({
    apiKey: "FAKE",
    fetch: (async (url) => {
      calls++;
      assert.match(String(url), /search=.*\+/);
      return reply({ voices: [] });
    }) as typeof fetch,
  });
  await discoverVoices({ action: "search", query: "calm русский", client });
  assert.equal(calls, 1);
  const source = path.join(env.project, "ivc.json");
  writeFileSync(
    source,
    JSON.stringify({
      voiceId: "voice_A",
      task: "clone-instant",
      readiness: "needs-verification",
      rights: { source: "Fixture", consent: "Fixture only" },
    }),
  );
  const request = {
    version: 1,
    task: "refresh",
    projectId: "demo",
    voiceId: "voice_A",
    sourceManifest: source,
    model: "eleven_v3",
    output: "public/projects/demo/ready.json",
  };
  const options = {
    rootDir: env.root,
    dryRun: false,
    apiKey: "FAKE",
    fetch: (async () => {
      calls++;
      return reply({
        voice_id: "voice_A",
        fine_tuning: { state: { eleven_v3: "fine_tuned" } },
        voice_verification: { requires_verification: false },
      });
    }) as typeof fetch,
  };
  await executeVoiceManagement(request, options);
  const bytes = readFileSync(path.join(env.project, "ready.json")),
    saved = JSON.parse(bytes.toString());
  assert.equal(saved.readiness, "ready");
  assert.equal(saved.model, "eleven_v3");
  await executeVoiceManagement({ ...request, operationId: saved.operationId }, options);
  assert.equal(calls, 2);
  assert.throws(
    () =>
      verifyVoiceRef(env.root, {
        provider: "elevenlabs",
        language: "en",
        voiceId: "voice_A",
        model: "eleven_v4",
        manifest: "public/projects/demo/ready.json",
        manifestSha256: digest(bytes),
      }),
    /selected model/,
  );
});

test("public response caches, including symlink ancestors, fail before reservation or POST", async (t) => {
  const env = setup(t);
  let posts = 0;
  const request = {
    version: 1,
    task: "tts",
    projectId: "demo",
    output: "public/projects/demo/private-test.mp3",
    voiceId: "voice_A",
    text: "Fixture",
    model: "eleven_v3",
    language: "en",
    maxCostUsd: 1,
  };
  const execution = {
    rootDir: env.root,
    dryRun: false,
    apiKey: "FAKE",
    fetch: (async () => {
      posts++;
      throw Error("Must not submit");
    }) as typeof fetch,
  };
  const unsafe = new OperationStore("demo", { directory: path.join(env.project, "pipeline") });
  await assert.rejects(executeStudioAudio(request, { ...execution, store: unsafe }), /Private paid response cache/);
  assert.equal(posts, 0);
  assert.equal(Object.keys(env.store.snapshot().jobs).length, 0);
  symlinkSync(path.join(env.project, "pipeline"), path.join(env.root, ".cache"), "dir");
  await assert.rejects(executeStudioAudio(request, execution), /Private paid response cache/);
  assert.equal(posts, 0);
  assert.equal(Object.keys(env.store.snapshot().jobs).length, 0);
});
