import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SpeechMaskSchema } from "../src/types/speech-mask";
import { separateReferenceStems } from "../src/lib/reference/audio";

const enabled = process.env.RUN_PYTHON_MODELS === "1";
const selected = process.env.PYTHON_MODEL_PROFILE;
if (enabled && selected && !["vad", "stems", "matte"].includes(selected))
  throw new Error(`Unknown public model profile: ${selected}`);
const gate = (profile: string) => ({ skip: !enabled || Boolean(selected && selected !== profile), timeout: 900_000 });
const tsx = path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs");
function temporary(t: test.TestContext) {
  const directory = mkdtempSync(path.join(tmpdir(), "python-model-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function cli(script: string, args: string[], env = process.env) {
  const child = spawnSync(process.execPath, [tsx, `scripts/${script}.ts`, ...args], {
    encoding: "utf8",
    timeout: 840_000,
    env: { ...env, OMP_NUM_THREADS: "2", MKL_NUM_THREADS: "2" },
    maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(child.status, 0, child.error?.message ?? (child.stdout + child.stderr).slice(-3000));
  const lines = child.stdout.trim().split("\n");
  assert.equal(lines.length, 1, child.stdout);
  const result = JSON.parse(lines[0]!);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function silence(file: string) {
  const dataBytes = 44100 * 2 * 2 * 2;
  const bytes = Buffer.alloc(44 + dataBytes + 24);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(44100, 24);
  bytes.writeUInt32LE(176400, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataBytes, 40);
  // A fresh inert chunk avoids accepting a stem cache hit as an inference check.
  bytes.write("JUNK", 44 + dataBytes);
  bytes.writeUInt32LE(16, 48 + dataBytes);
  randomBytes(16).copy(bytes, 52 + dataBytes);
  writeFileSync(file, bytes);
}

test("public Silero model: owning speech CLI returns an empty mask for silence", gate("vad"), (t) => {
  const directory = temporary(t);
  const input = path.join(directory, "silence.wav");
  silence(input);
  const output = path.join(directory, "transcript.json");
  const mask = path.join(directory, "speech-mask.json");
  const env = {
    ...process.env,
    AGENTBROS_LOCAL_DOWNLOADS: "task",
    SPEECH_LOCAL_CACHE: path.join(directory, "speech-cache"),
  };
  cli(
    "speech-local",
    ["--input", input, "--output", output, "--vad-output", mask, "--engine", "auto", "--no-diarize"],
    env,
  );
  const result = SpeechMaskSchema.parse(JSON.parse(readFileSync(mask, "utf8")));
  assert.equal(result.engine.version, "6.2.3");
  assert.equal(result.engine.sampleRate, 16000);
  assert.equal(result.speechSec, 0);
  assert.deepEqual(result.speech, []);
});

test("public Demucs model: owning audio and reference paths write readable stems", gate("stems"), (t) => {
  const directory = temporary(t);
  const input = path.join(directory, "silence.wav");
  silence(input);
  const result = cli("audio-stems", ["--input", input]);
  assert.equal(result.metadata.model, "htdemucs");
  assert.equal(result.metadata.cached, false);
  assert.equal(result.outputs.length, 4);
  const reference = separateReferenceStems(input, directory);
  assert.equal(reference.available, true, reference.unavailableReason ?? "");
  assert.equal(Object.keys(reference.paths).length, 4);
  for (const file of result.outputs as string[]) {
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "stream=channels,sample_rate,duration", "-of", "json", file],
      { encoding: "utf8" },
    );
    assert.equal(probe.status, 0, probe.stderr);
    const stream = JSON.parse(probe.stdout).streams[0];
    assert.equal(stream.channels, 2);
    assert.equal(stream.sample_rate, "44100");
    assert.ok(Math.abs(Number(stream.duration) - 2) < 0.02);
  }
  if (!result.metadata.cached)
    t.after(() => rmSync(path.resolve(result.metadata.dir), { recursive: true, force: true }));
});

test("public pinned BiRefNet model: owning matte CLI writes an alpha image", gate("matte"), (t) => {
  const directory = temporary(t);
  const input = path.join(directory, "frame.png");
  const fixture = spawnSync(
    "ffmpeg",
    ["-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=128x96", "-frames:v", "1", input],
    { encoding: "utf8" },
  );
  assert.equal(fixture.status, 0, fixture.stderr);
  cli("assets-sync", ["--id", "models:birefnet-general-lite"]);
  const output = path.join(directory, "cutout.png");
  cli("matte", ["--input", input, "--output", output, "--engine", "onnx", "--kind", "subject", "--threads", "2"]);
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", output],
    { encoding: "utf8" },
  );
  assert.equal(probe.status, 0, probe.stderr);
  assert.deepEqual(JSON.parse(probe.stdout).streams[0], { width: 128, height: 96, pix_fmt: "rgba" });
});
