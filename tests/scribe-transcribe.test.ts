import { USER_GRANT } from "./helpers/ceiling-grant";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OperationStore } from "../src/lib/jobs/store";
import { billableMinutes, transcribe, validateKeyterms } from "../src/lib/elevenlabs-scribe";
import { buildTranscript, scribeWords } from "../src/lib/speech/transcript";
import { quote } from "../src/lib/pricing";
import { TranscriptSchema } from "../src/types/transcript";

const response = {
  transcripts: [
    {
      language_code: "eng",
      language_probability: 0.98,
      text: "Um, hello.",
      channel_index: 0,
      words: [
        { text: "Um,", start: 0, end: 0.3, type: "word", speaker_id: "speaker_0", logprob: -0.2 },
        { text: " ", start: 0.3, end: 0.35, type: "spacing", speaker_id: "speaker_0", logprob: 0 },
        { text: "hello.", start: 0.35, end: 0.8, type: "word", speaker_id: "speaker_0", logprob: -0.01 },
      ],
    },
    {
      language_code: "eng",
      language_probability: 0.97,
      text: "(laughs) Hi.",
      channel_index: 1,
      words: [
        { text: "(laughs)", start: 0.5, end: 0.9, type: "audio_event", speaker_id: "speaker_0", logprob: 0 },
        { text: "Hi.", start: 1, end: 1.3, type: "word", speaker_id: "speaker_0", logprob: -0.05 },
      ],
    },
  ],
  audio_duration_secs: 2,
};

function fixture(t: test.TestContext) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "scribe-"));
  const store = new OperationStore("fixture", { directory });
  store.configure({ ceilingUsd: 1, maxJobUsd: 1, repairReserveFraction: 0 }, USER_GRANT);
  const audio = path.join(directory, "stereo.wav");
  assert.equal(
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2", audio])
      .status,
    0,
  );
  const originalFetch = globalThis.fetch,
    originalKey = process.env.ELEVENLABS_API_KEY;
  const requests: FormData[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    requests.push(init.body as FormData);
    return Response.json(response);
  }) as typeof fetch;
  process.env.ELEVENLABS_API_KEY = "fixture-never-sent";
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = originalKey;
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, audio, requests };
}

test("scribe_v3 sends every option as the API expects and budgets channels and keyterms", async (t) => {
  const { store, audio, requests } = fixture(t);
  const result = await transcribe({
    inputPath: audio,
    modelId: "scribe_v3",
    diarize: true,
    numSpeakers: 2,
    verbatim: true,
    multichannel: true,
    keyterms: ["Remotion", "Scribe v3"],
    secondaryLanguages: ["ru"],
    paid: { store },
  });
  assert.equal(requests.length, 1);
  const form = requests[0]!;
  assert.equal(form.get("model_id"), "scribe_v3");
  assert.equal(form.get("diarize"), "true");
  assert.equal(form.get("num_speakers"), "2");
  assert.equal(form.get("use_multi_channel"), "true");
  assert.equal(form.get("no_verbatim"), null);
  assert.deepEqual(form.getAll("keyterms"), ["Remotion", "Scribe v3"]);
  assert.deepEqual(form.getAll("secondary_language_codes"), ["ru"]);
  const job = Object.values(store.snapshot().jobs)[0]!;
  assert.equal(job.quote.model, "elevenlabs:scribe-v3");
  const expected = quote({ model: "elevenlabs:scribe-v3", units: (2 / 60) * 2 * 1.25 }).highUsd!;
  assert.ok(Math.abs(job.quote.highUsd! - expected) < 1e-9);
  assert.deepEqual(result.raw, response);
  await transcribe({
    inputPath: audio,
    modelId: "scribe_v3",
    diarize: true,
    numSpeakers: 2,
    verbatim: true,
    multichannel: true,
    keyterms: ["Remotion", "Scribe v3"],
    secondaryLanguages: ["ru"],
    paid: { store },
  });
  assert.equal(requests.length, 1, "the same options resume the settled operation instead of paying again");
  await transcribe({
    inputPath: audio,
    modelId: "scribe_v3",
    diarize: true,
    numSpeakers: 2,
    verbatim: true,
    multichannel: true,
    keyterms: ["Remotion"],
    secondaryLanguages: ["ru"],
    paid: { store },
  });
  assert.equal(requests.length, 2, "different keyterms are a new operation");
  assert.equal(result.words.length, 5);

  const parsed = scribeWords(result.raw, { multichannel: true });
  const transcript = buildTranscript({
    source: { file: "stereo.wav", sha256: "b".repeat(64), durationSec: parsed.durationSec },
    engine: { provider: "elevenlabs", model: "scribe_v3", verbatim: true, diarized: true, timing: "native" },
    language: parsed.language!,
    words: parsed.words,
  });
  assert.deepEqual(
    transcript.words.map((word) => [word.text, word.kind, word.speaker, word.channel]),
    [
      ["Um,", "filler", "ch0-speaker_0", 0],
      ["hello.", "word", "ch0-speaker_0", 0],
      ["(laughs)", "event", "ch1-speaker_0", 1],
      ["Hi.", "word", "ch1-speaker_0", 1],
    ],
  );
  assert.equal(transcript.language, "en");
});

test("no-verbatim, model checks and keyterm limits fail before any request", async (t) => {
  const { store, audio, requests } = fixture(t);
  await transcribe({ inputPath: audio, modelId: "scribe_v2", verbatim: false, paid: { store } });
  assert.equal(requests[0]!.get("no_verbatim"), "true");
  assert.equal(Object.values(store.snapshot().jobs)[0]!.quote.model, "elevenlabs:scribe-v2");
  await assert.rejects(
    transcribe({ inputPath: audio, modelId: "scribe_v1", verbatim: false, paid: { store } }),
    /no_verbatim/,
  );
  await assert.rejects(
    transcribe({ inputPath: audio, modelId: "scribe_v2", secondaryLanguages: ["ru"], paid: { store } }),
    /scribe_v3/,
  );
  await assert.rejects(transcribe({ inputPath: audio, modelId: "scribe_v9", paid: { store } }), /Unknown Scribe model/);
  await assert.rejects(transcribe({ inputPath: audio, numSpeakers: 40, paid: { store } }), /1 to 32/);
  assert.equal(requests.length, 1);
  assert.throws(() => validateKeyterms(["a [b]"]), /unsupported/);
  assert.throws(() => validateKeyterms(["one two three four five six"]), /5 words/);
  assert.throws(() => validateKeyterms(["x".repeat(51)]), /50 characters/);
  assert.throws(() => validateKeyterms(Array.from({ length: 1001 }, (_, i) => `t${i}`)), /1000/);
});

test("scribe_v1 has no verified price, so it needs an explicit bound", async (t) => {
  const { store, audio, requests } = fixture(t);
  await assert.rejects(transcribe({ inputPath: audio, modelId: "scribe_v1", paid: { store } }), /Unknown audio price/);
  assert.equal(requests.length, 0);
});

test("billable minutes: every channel, keyterm surcharge, 20 s minimum over 100 keyterms", () => {
  assert.equal(billableMinutes(60, {}), 1);
  assert.equal(billableMinutes(60, { channels: 2 }), 2);
  assert.equal(billableMinutes(60, { keyterms: 3 }), 1.25);
  assert.equal(billableMinutes(6, { keyterms: 101 }), (20 / 60) * 1.25);
});

test("transcribe --from-raw rebuilds the transcript from a saved response with no API call", (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "scribe-raw-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const audio = path.join(directory, "stereo.wav");
  assert.equal(
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-ac", "2", audio])
      .status,
    0,
  );
  const raw = path.join(directory, "transcript.scribe.json");
  writeFileSync(raw, JSON.stringify(response));
  const before = readFileSync(raw, "utf8");
  const output = path.join(directory, "rebuilt.json");
  const run = (...extra: string[]) => {
    const child = spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/transcribe.ts", "--input", audio, "--output", output, "--from-raw", raw, ...extra],
      {
        cwd: path.resolve(import.meta.dirname, ".."),
        encoding: "utf8",
        timeout: 60000,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          ELEVENLABS_API_KEY: "",
        },
      },
    );
    return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
      ok: boolean;
      error?: string;
      outputs?: string[];
      metadata?: Record<string, unknown>;
    };
  };
  const result = run();
  assert.equal(result.ok, true, JSON.stringify(result));
  const transcript = TranscriptSchema.parse(JSON.parse(readFileSync(output, "utf8")));
  assert.equal(transcript.engine.model, "scribe_v3");
  assert.equal(transcript.engine.diarized, true, "multichannel raw implies channel speakers");
  assert.deepEqual(
    transcript.speakers.map((speaker) => speaker.id),
    ["ch0-speaker_0", "ch1-speaker_0"],
  );
  assert.equal(readFileSync(raw, "utf8"), before, "the raw response is never rewritten");
  assert.equal(run().error, "FILE_EXISTS");
  assert.equal(run("--force").ok, true);
  writeFileSync(raw, JSON.stringify({ text: "no words" }));
  assert.equal(run("--force").error, "INVALID_INPUT");
});
