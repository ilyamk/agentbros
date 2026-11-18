import { SPAWN_TIMEOUT_MS } from "./helpers/timeouts";
import test from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  captureCorpusFile,
  intendedScriptAgreement,
  preparePcmDerivative,
  diagnosticAudioClock,
  decodedCorpusClock,
  PreparedCorpusSchema,
  observedNetworkDenial,
  readPreparedCorpus,
} from "../src/lib/ingest/corpus-diagnostics";
import { EXISTING_CORPUS, CORPUS_REFERENCES } from "../src/lib/ingest/corpus-fixtures";
import { inspectLocalAudioClock } from "../src/lib/ingest/local-clock";
test("fixed existing corpus includes five EN and original RU with distinct immutable source pins", () => {
  assert.equal(EXISTING_CORPUS.length, 6);
  assert.equal(EXISTING_CORPUS.filter((s) => s.language === "en").length, 5);
  assert.equal(new Set(EXISTING_CORPUS.map((s) => s.hash)).size, 6);
  assert.equal(CORPUS_REFERENCES.presenter.file.endsWith("narrator-direction.json"), true);
});
test("intended-script agreement retains mistakes without human/timing/semantic accuracy claims", () => {
  const exact = intendedScriptAgreement("НЕ удаляй слова. Test 2026!", "не удаляй слова test 2026");
  assert.equal(exact.tokenEdits, 0);
  assert.equal(exact.groundTruth, false);
  assert.equal(exact.timingAccuracy, "not-measured");
  const missed = intendedScriptAgreement("do not delete speech", "do delete speech");
  assert.equal(missed.tokenEdits, 1);
  assert.equal(missed.intendedScriptEditRate, 0.25);
  assert.equal(intendedScriptAgreement("hello world", "").tokenEdits, 2);
  assert.equal(intendedScriptAgreement("short", "short added added").intendedScriptEditRate, 2);
  assert.throws(() => intendedScriptAgreement("", "words"));
  assert.throws(() => intendedScriptAgreement("a ".repeat(501), "a"));
});
test("captured finite originals reject FIFO/symlink/oversize; bytes and hashes are reproducible", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "corpus-reader-")));
  try {
    const file = path.join(root, "small.json");
    writeFileSync(file, "{}");
    assert.equal(captureCorpusFile(file).bytes.toString(), "{}");
    assert.equal(captureCorpusFile(file).sha256, captureCorpusFile(file).sha256);
    const link = path.join(root, "link");
    symlinkSync(file, link);
    assert.throws(() => captureCorpusFile(link), /symlink/);
    writeFileSync(file, Buffer.alloc(1025));
    assert.throws(() => captureCorpusFile(file, 1024), /bounded/);
    const fifo = path.join(root, "fifo");
    execFileSync("mkfifo", [fifo]);
    execFileSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        "-e",
        `import {captureCorpusFile} from './src/lib/ingest/corpus-diagnostics';try{captureCorpusFile(${JSON.stringify(fifo)});process.exit(2)}catch{}`,
      ],
      { timeout: SPAWN_TIMEOUT_MS },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("actual local MP3 derivative has explicit decoded-origin/sample extent and direct MP3 stays refused", () => {
  const available = spawnSync("ffmpeg", ["-version"]);
  assert.equal(available.status, 0, "Installed existing test dependency FFmpeg required");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "corpus-pcm-")));
  try {
    const original = path.join(root, "original.mp3"),
      wav = path.join(root, "derived.wav");
    execFileSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=330:sample_rate=44100:duration=2",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      original,
    ]);
    const before = captureCorpusFile(original).sha256,
      clock = diagnosticAudioClock(original, "ffprobe");
    assert.ok(clock.originSec > 0);
    assert.throws(() => inspectLocalAudioClock(original, clock.durationSec), /offset|normalization/);
    const prepared = preparePcmDerivative(original, wav, "ffmpeg", "ffprobe");
    assert.equal(prepared.clock.originSec, 0);
    assert.equal(prepared.clock.sampleRate, 16000);
    assert.equal(prepared.originalClockOffsetSec, clock.originSec);
    assert.ok(Math.abs(prepared.clock.decodedDurationSec - clock.decodedDurationSec) <= 2 / 16000);
    assert.equal(captureCorpusFile(original).sha256, before);
    assert.equal(inspectLocalAudioClock(wav, prepared.clock.durationSec).decodedSamples, prepared.clock.decodedSamples);
    assert.throws(() => preparePcmDerivative(original, wav, "ffmpeg", "ffprobe"), /already exists/);
    assert.throws(
      () => preparePcmDerivative(wav, path.join(root, "other.wav"), "ffmpeg", "ffprobe"),
      /audited nonzero/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("CLI missing explicit pins/action returns one failed JSON envelope", () => {
  const r = spawnSync(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "scripts/media-corpus.ts", "--action", "inspect", "--manifest", "anything"],
    { encoding: "utf8" },
  );
  assert.notEqual(r.status, 0);
  const lines = r.stdout.trim().split("\n");
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).ok, false);
});
test("network proof is observed rather than environment marker or configured metadata", () => {
  const before = process.env.LOCAL_INFERENCE_NETWORK_SANDBOX;
  process.env.LOCAL_INFERENCE_NETWORK_SANDBOX = "1";
  try {
    assert.equal(typeof observedNetworkDenial(), "boolean");
  } finally {
    if (before === undefined) delete process.env.LOCAL_INFERENCE_NETWORK_SANDBOX;
    else process.env.LOCAL_INFERENCE_NETWORK_SANDBOX = before;
  }
  assert.throws(() => PreparedCorpusSchema.parse({ humanGroundTruth: true, approved: true }));
});

test("decoded lineage rejects exact one-sample gaps/overlaps and fractional sample clocks", () => {
  const row = (pts: number, count: number) => ({ best_effort_timestamp: pts, nb_samples: count });
  assert.equal(
    decodedCorpusClock([row(353600, 47), row(368640, 1152)], 1, 14112000, 44100, 1, 0.1).originSec,
    353600 / 14112000,
  );
  for (const delta of [-320, 320, 1, -1])
    assert.throws(
      () => decodedCorpusClock([row(353600, 47), row(368640 + delta, 1152)], 1, 14112000, 44100, 1, 0.1),
      /discontinuous/,
    );
  assert.throws(() => decodedCorpusClock([row(0, 1024), row(1023, 1024)], 1, 48000, 48000, 2, 0.1), /discontinuous/);
  assert.throws(() => decodedCorpusClock([row(0, 1024), row(1025, 1024)], 1, 48000, 48000, 2, 0.1), /discontinuous/);
  assert.throws(() => decodedCorpusClock([row(0, 1), row(1, 1)], 1, 3, 8000, 1, 0.1), /discontinuous/);
});

test("receipt tool pins cannot select an executable even with coherent forged identity and checksum", () => {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "corpus-execution-"))),
    sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
  try {
    const marker = path.join(root, "executed"),
      malicious = path.join(root, "owned-tool");
    writeFileSync(malicious, `#!/bin/sh\ntouch '${marker}'\nprintf 'fake-version\\n'\n`, { mode: 0o700 });
    const clock = {
      originSec: 0,
      decodedSamples: 8000,
      sampleRate: 8000,
      channels: 1,
      durationSec: 1,
      decodedDurationSec: 1,
    };
    const tools = {
      ffmpeg: { path: malicious, sha256: sha(readFileSync(malicious)), versionSha256: sha("fake-version\n") },
      ffprobe: { path: malicious, sha256: sha(readFileSync(malicious)), versionSha256: sha("fake-version\n") },
    };
    const helperSha256 = captureCorpusFile(path.resolve("src/lib/ingest/corpus-diagnostics.ts")).sha256,
      fixturesSha256 = captureCorpusFile(path.resolve("src/lib/ingest/corpus-fixtures.ts")).sha256;
    const base = {
      version: 1,
      sourceRoot: root,
      originals: EXISTING_CORPUS,
      references: CORPUS_REFERENCES,
      tools,
      helperSha256,
      fixturesSha256,
    };
    const entries = EXISTING_CORPUS.map((sample) => ({
      id: sample.id,
      language: sample.language,
      original: { file: sample.file, bytes: sample.bytes, sha256: sample.hash, snapshot: "missing", clock },
      reference: {
        file: CORPUS_REFERENCES[sample.reference].file,
        sha256: CORPUS_REFERENCES[sample.reference].hash,
        snapshot: "missing",
        text: "x",
        textSha256: sha("x"),
        kind: "intended-generation-script",
        independentlyVerified: false,
      },
      input: {
        path: "missing",
        sha256: sample.hash,
        clock,
        recipe: "original-direct",
        originalClockOffsetSec: 0,
        automaticOriginalTimelineMapping: false,
      },
      directOriginal: { state: "supported" },
      provenance: "existing-ai-or-configured-tts; exact-provider-origin-unverified",
      commercialAllowed: "unknown",
      approved: false,
    }));
    const manifest = path.join(root, "manifest.json"),
      bytes = JSON.stringify({
        version: 1,
        key: sha(JSON.stringify(base)),
        sourceRoot: root,
        tools,
        helperSha256,
        fixturesSha256,
        entries,
        providerSpendUsd: 0,
        reviewRequired: true,
        humanGroundTruth: false,
      });
    writeFileSync(manifest, bytes);
    writeFileSync(path.join(root, "manifest.sha256"), sha(bytes) + "\n");
    assert.throws(() => readPreparedCorpus(manifest), /trusted tool pin/);
    assert.equal(existsSync(marker), false);
    const cli = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/media-corpus.ts",
        "--action",
        "inspect",
        "--manifest",
        manifest,
        "--manifest-sha256",
        sha(bytes),
      ],
      { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS },
    );
    assert.notEqual(cli.status, 0);
    assert.equal(JSON.parse(cli.stdout).ok, false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
