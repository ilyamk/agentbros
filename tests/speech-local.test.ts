import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import path from "node:path";
import { TranscriptSchema } from "../src/types/transcript";
import { SpeechMaskSchema } from "../src/types/speech-mask";
import { PYTHON_VERSION } from "../src/lib/python";

const repo = path.resolve(import.meta.dirname, "..");
const appleSilicon = platform() === "darwin" && arch() === "arm64";

/** A uvx stand-in: prints `<op>.json` from the fixture directory, records its arguments, fails when the file is absent. */
function fixture(t: test.TestContext, replies: Partial<Record<"vad" | "asr" | "diarize", unknown>>) {
  const directory = mkdtempSync(path.join(tmpdir(), "speech-local-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [operation, reply] of Object.entries(replies))
    writeFileSync(path.join(directory, `${operation}.json`), JSON.stringify(reply));
  const uvx = path.join(directory, "uvx");
  writeFileSync(
    uvx,
    `#!/bin/sh
for a in "$@"; do case "$a" in vad|asr|diarize) op="$a";; esac; done
echo "$@" >> "${directory}/calls.log"
echo "HF_HUB_OFFLINE=$HF_HUB_OFFLINE HF_DATASETS_OFFLINE=$HF_DATASETS_OFFLINE" >> "${directory}/calls.log"
if [ "$op" = diarize ] && [ -n "$FAKE_DIARIZE_ERROR" ]; then printf 'Traceback (most recent call last):\n  File "w.py", line 1\n%s\n' "$FAKE_DIARIZE_ERROR" >&2; exit 1; fi
if [ -f "${directory}/$op.json" ]; then echo "progress noise" >&2; cat "${directory}/$op.json"; else echo "no $op model" >&2; exit 3; fi
`,
  );
  chmodSync(uvx, 0o755);
  const audio = path.join(directory, "speech.wav");
  assert.equal(
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=300:duration=3", audio]).status,
    0,
  );
  const run = (args: string[], env: Record<string, string> = {}) => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/speech-local.ts",
        "--input",
        audio,
        "--output",
        path.join(directory, "out/transcript.json"),
        ...args,
      ],
      {
        cwd: repo,
        encoding: "utf8",
        timeout: 60000,
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          HF_TOKEN: "",
          SPEECH_LOCAL_UVX: uvx,
          SPEECH_LOCAL_CACHE: path.join(directory, "cache"),
          ...env,
        },
      },
    );
    return {
      ...child,
      json: JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
        ok: boolean;
        outputs?: string[];
        metadata?: Record<string, unknown>;
        error?: string;
        message?: string;
      },
    };
  };
  const read = (name: string) => JSON.parse(readFileSync(path.join(directory, "out", name), "utf8"));
  const calls = () => readFileSync(path.join(directory, "calls.log"), "utf8");
  return { run, read, calls };
}

const vad = {
  version: "6.2.3",
  speech: [
    { start: 0.1, end: 1.2 },
    { start: 1.6, end: 2.8 },
  ],
};
const asr = {
  words: [
    { text: "Hello", start: 0.1, end: 0.5, confidence: 0.99 },
    { text: "world.", start: 0.5, end: 1.1, confidence: 0.9 },
    { text: "Привет.", start: 1.6, end: 2.4, confidence: 0.95 },
  ],
  downloadSec: 0.1,
  inferenceSec: 0.2,
};

test(
  "speech:local writes a transcript and an unpadded speech mask; no HF_TOKEN is a note, not an error",
  { skip: !appleSilicon && "Parakeet path needs Apple Silicon" },
  (t) => {
    const { run, read, calls } = fixture(t, { vad, asr });
    const result = run(["--language", "en"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.json.ok, true);
    const transcript = TranscriptSchema.parse(read("transcript.json"));
    assert.equal(transcript.engine.model, "parakeet-tdt-0.6b-v3");
    assert.equal(transcript.engine.diarized, false);
    assert.equal(transcript.engine.verbatim, false);
    assert.match(transcript.notes!.join(" "), /HF_TOKEN/);
    assert.deepEqual(
      transcript.sentences.map((sentence) => sentence.text),
      ["Hello world.", "Привет."],
    );
    const mask = SpeechMaskSchema.parse(read("speech-mask.json"));
    assert.deepEqual(mask.speech, [
      { startSec: 0.1, endSec: 1.2 },
      { startSec: 1.6, endSec: 2.8 },
    ]);
    assert.equal(mask.engine.padMs, 0);
    assert.match(calls(), /--group asr/);
    assert.match(calls(), /--group vad/);
    assert.doesNotMatch(calls(), /pyannote/);
    const again = run(["--language", "en"]);
    assert.equal(again.json.error, "FILE_EXISTS");
  },
);

test(
  "speech:local labels speakers from pyannote turns when HF_TOKEN is set",
  { skip: !appleSilicon && "Parakeet path needs Apple Silicon" },
  (t) => {
    const { run, read, calls } = fixture(t, {
      vad,
      asr,
      diarize: {
        turns: [
          { start: 0, end: 1.3, speaker: "SPEAKER_00" },
          { start: 1.5, end: 2.9, speaker: "SPEAKER_01" },
        ],
      },
    });
    const result = run(["--speakers", "2"], { HF_TOKEN: "fixture-token" });
    assert.equal(result.status, 0, result.stderr);
    const transcript = TranscriptSchema.parse(read("transcript.json"));
    assert.equal(transcript.engine.diarized, true);
    assert.deepEqual(
      transcript.speakers.map((speaker) => speaker.id),
      ["SPEAKER_00", "SPEAKER_01"],
    );
    assert.deepEqual(
      transcript.sentences.map((sentence) => sentence.speaker),
      ["SPEAKER_00", "SPEAKER_01"],
    );
    assert.equal(transcript.language, "und");
    assert.match(calls(), /--group diarize/);
  },
);

test(
  "speech:local reports a failed diarisation as a note and keeps the transcript",
  { skip: !appleSilicon && "Parakeet path needs Apple Silicon" },
  (t) => {
    const { run, read } = fixture(t, { vad, asr });
    const result = run([], { HF_TOKEN: "fixture-token" });
    assert.equal(result.status, 0, result.stderr);
    const transcript = TranscriptSchema.parse(read("transcript.json"));
    assert.equal(transcript.engine.diarized, false);
    assert.match(transcript.notes!.join(" "), /Diarisation failed/);
  },
);

test(
  "speech:local with an explicit parakeet engine fails loudly when the model cannot run",
  { skip: !appleSilicon && "Parakeet path needs Apple Silicon" },
  (t) => {
    const { run } = fixture(t, { vad });
    const result = run(["--engine", "parakeet"]);
    assert.notEqual(result.status, 0);
    assert.equal(result.json.ok, false);
    assert.match(result.json.message!, /no asr model/);
  },
);

test("speech:local needs an output or a project", () => {
  const child = spawnSync(process.execPath, ["--import", "tsx", "scripts/speech-local.ts", "--input", "package.json"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 60000,
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR },
  });
  const json = JSON.parse(child.stdout.trim().split("\n").at(-1)!);
  assert.equal(json.ok, false);
  assert.equal(json.error, "INVALID_INPUT");
});

test(
  "speech:local turns a refused gated model into a plain note without the token",
  { skip: !appleSilicon && "Parakeet path needs Apple Silicon" },
  (t) => {
    const { run, read } = fixture(t, { vad, asr });
    const result = run([], {
      HF_TOKEN: "hf_fixtureSECRET0123456789",
      FAKE_DIARIZE_ERROR: "huggingface_hub.errors.GatedRepoError: 403 Client Error. Cannot access gated repo",
    });
    assert.equal(result.status, 0, result.stderr);
    const raw = readFileSync(path.join(path.dirname(result.json.outputs![0]!), "transcript.json"), "utf8");
    const transcript = TranscriptSchema.parse(JSON.parse(raw));
    assert.equal(transcript.engine.diarized, false);
    assert.match(
      transcript.notes!.join(" "),
      /huggingface\.co\/pyannote\/speaker-diarization-community-1.*accept its conditions/,
    );
    assert.doesNotMatch(raw + result.stdout + result.stderr, /hf_fixtureSECRET/);
    void read;
  },
);

test(
  "speech:local never-download policy covers uv and reused Hugging Face workers",
  { skip: !appleSilicon && "Parakeet path needs Apple Silicon" },
  (t) => {
    const { run, calls } = fixture(t, { vad, asr });
    const result = run(["--engine", "parakeet", "--language", "en"], { AGENTBROS_LOCAL_DOWNLOADS: "never" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(calls(), new RegExp(`--offline run .*--python ${PYTHON_VERSION.replaceAll(".", "\\.")}`, "u"));
    assert.match(calls(), /HF_HUB_OFFLINE=1 HF_DATASETS_OFFLINE=1/u);
  },
);
