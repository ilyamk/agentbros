import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync, spawnSync } from "node:child_process";
import { analyzeAudio } from "../src/lib/audio/analysis";
import { mixLocalAudio, buildAudioMix } from "../src/lib/audio/local-mix";
import { inspectEditorialProject } from "../src/lib/editorial/qa";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "audio-qa-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function tone(file: string, frequency = 440, duration = 3) {
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${frequency}:sample_rate=48000:duration=${duration}`,
    file,
  ]);
}
test("real loudness/true-peak and silence analysis report finite metrics and silent intervals", (t) => {
  const root = fixture(t),
    toneFile = path.join(root, "tone.wav"),
    silent = path.join(root, "silent.wav");
  tone(toneFile);
  const measurement = analyzeAudio(toneFile);
  assert.equal(measurement.present, true);
  assert.ok(Number.isFinite(measurement.integratedLufs));
  assert.ok(measurement.truePeakDb! < 0);
  assert.equal(measurement.silence.length, 0);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=mono", "-t", "2", silent]);
  const silence = analyzeAudio(silent);
  assert.equal(silence.integratedLufs, null);
  assert.ok(silence.silence[0].endSec > 1.99);
});
test("ducked normalized master meets target and output overwrite is explicit", (t) => {
  const root = fixture(t),
    speech = path.join(root, "speech.wav"),
    music = path.join(root, "music.wav"),
    master = path.join(root, "master.wav");
  tone(speech);
  tone(music, 220);
  const plan = {
    version: 1,
    durationSec: 3,
    tracks: [
      { source: speech, role: "speech" },
      { source: music, role: "music", volume: 0.3 },
    ],
  };
  const graph = buildAudioMix(plan);
  assert.match(graph.filter, /sidechaincompress/);
  const result = mixLocalAudio(plan, master);
  assert.ok(Math.abs(result.analysis.integratedLufs! + 16) < 1);
  assert.ok(result.analysis.truePeakDb! <= -1.2);
  assert.ok(Math.abs(result.analysis.durationSec - 3) < 0.001);
  const bytes = readFileSync(master);
  assert.throws(() => mixLocalAudio(plan, master), /already exists/);
  assert.deepEqual(readFileSync(master), bytes);
});
test("speech is never implicitly truncated; authored trim and automation validate", (t) => {
  const root = fixture(t),
    speech = path.join(root, "speech.wav");
  tone(speech);
  assert.throws(
    () =>
      buildAudioMix({
        version: 1,
        durationSec: 1,
        tracks: [{ source: speech, role: "speech" }],
      }),
    /cut speech/,
  );
  assert.throws(
    () =>
      buildAudioMix({
        version: 1,
        durationSec: 3,
        tracks: [
          {
            source: speech,
            role: "speech",
            keyframes: [
              { atSec: 1, volume: 0.5 },
              { atSec: 1, volume: 0.2 },
            ],
          },
        ],
      }),
    /increasing/,
  );
  assert.doesNotThrow(() =>
    buildAudioMix({
      version: 1,
      durationSec: 1,
      tracks: [
        {
          source: speech,
          role: "speech",
          sourceEndSec: 1,
          allowSpeechTrim: true,
        },
      ],
    }),
  );
});
test("a leftover legacy pipeline-state.json is ignored and cannot hide missing speech", (t) => {
  const root = fixture(t),
    dir = path.join(root, "public/projects/project");
  mkdirSync(path.join(dir, "pipeline"), { recursive: true });
  writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({
      name: "test",
      productName: "test",
      colors: {},
      formats: ["landscape"],
      musicVolume: 0,
      scenes: [{ id: "a", text: "hello", visualType: "title", durationInFrames: 30 }],
    }),
  );
  writeFileSync(
    path.join(dir, "pipeline/pipeline-state.json"),
    JSON.stringify({
      stages: {
        "caption-edit": { status: "skipped" },
        rhythm: { status: "done" },
        "audio-mix": { status: "skipped" },
      },
    }),
  );
  const report = inspectEditorialProject("project", { rootDir: root });
  assert.equal(report.status, "failed");
  assert.ok(report.findings.some((f) => f.code === "SPEECH_MISSING"));
  assert.ok(!report.findings.some((f) => ["STAGE_OUTPUT_MISSING", "QUALITY_STAGE_SKIPPED"].includes(f.code)));
});
test("retiming suggestion preserves complete speech and never edits canonical source", (t) => {
  const root = fixture(t),
    dir = path.join(root, "public/projects/project");
  mkdirSync(path.join(dir, "voiceover"), { recursive: true });
  tone(path.join(dir, "voiceover/a.mp3"));
  const file = path.join(dir, "project.json"),
    raw = JSON.stringify({
      name: "test",
      productName: "test",
      colors: {},
      formats: ["landscape"],
      musicVolume: 0,
      scenes: [{ id: "a", text: "hello", visualType: "title", durationInFrames: 30 }],
    });
  writeFileSync(file, raw);
  writeFileSync(
    path.join(dir, "voiceover/a.words.json"),
    JSON.stringify({ words: [{ text: "hello", start: 0, end: 2.9 }] }),
  );
  const report = inspectEditorialProject("project", { rootDir: root });
  assert.equal(report.status, "failed");
  assert.ok(report.suggestions[0].minimumFrames >= 96);
  assert.equal(report.suggestions[0].automatic, false);
  assert.equal(readFileSync(file, "utf8"), raw);
});

test("strict rendered-video CLI returns failure and persists evidence for missing audio", (t) => {
  const root = fixture(t),
    video = path.join(root, "silent.mp4"),
    reportDir = path.join(root, "qa");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=30:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    video,
  ]);
  const result = spawnSync(
    process.execPath,
    [
      path.resolve("node_modules/tsx/dist/cli.mjs"),
      path.resolve("scripts/validate-render.ts"),
      "--input",
      video,
      "--out-dir",
      reportDir,
      "--format",
      "landscape",
      "--strict",
      "--expect-audio",
      "--max",
      "1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.equal(JSON.parse(result.stdout).ok, false);
  const report = JSON.parse(readFileSync(path.join(reportDir, "validation-report.json"), "utf8"));
  assert.equal(report.status, "failed");
  assert.ok(report.findings.some((finding: { message: string }) => finding.message.includes("missing or silent")));
});

test("short music can loop across speech without shortening the master", (t) => {
  const root = fixture(t),
    speech = path.join(root, "speech.wav"),
    music = path.join(root, "music.wav");
  tone(speech, 440, 3);
  tone(music, 220, 1);
  const result = mixLocalAudio(
    {
      version: 1,
      durationSec: 3,
      tracks: [
        { source: speech, role: "speech" },
        { source: music, role: "music", volume: 0.3, loop: true },
      ],
    },
    path.join(root, "master.wav"),
  );
  assert.ok(Math.abs(result.analysis.durationSec - 3) < 0.001);
});

test("bounded audio repair preserves original bytes and requires full QA afterwards", async (t) => {
  const { repairRenderAudio } = await import("../src/lib/audio/repair");
  const root = fixture(t),
    original = path.join(root, "original.mp4"),
    output = path.join(root, "repaired.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=64x64:r=30:d=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=48000:duration=3",
    "-filter:a",
    "volume=5",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    original,
  ]);
  const bytes = readFileSync(original),
    result = repairRenderAudio(original, output);
  assert.equal(result.attempts, 1);
  assert.ok(Math.abs(result.analysis.integratedLufs! + 16) < 1);
  assert.deepEqual(readFileSync(original), bytes);
  assert.throws(() => repairRenderAudio(original, original), /new output/);
});
