import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { decodeAudioWindows } from "./helpers/streamed-audio";
import { startProcessTreeMonitor } from "./helpers/process-tree-monitor";
import { educationFixture } from "./workflow-education-fixture";
import { runEducationWorkflow } from "../src/lib/workflows/education";
import { hashFile } from "../src/lib/assets/registry";

test("education accepts exactly 20 minutes but rejects oversized lessons before writing", () => {
  const f = educationFixture();
  try {
    const voice = path.join(f.root, "voice.wav");
    assert.equal(
      spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=100.1", voice])
        .status,
      0,
    );
    f.request.media.find((m) => m.id === "voice")!.sha256 = hashFile(voice);
    f.request.music.loop = true;
    for (const chapter of f.request.chapters)
      for (const beat of chapter.beats) {
        beat.durationFrames = 3000;
        beat.sourceStartFrame = 0;
        beat.captions = beat.spokenText.split(" ").map((text, i, words) => ({
          text,
          startFrame: Math.floor((i * 3000) / words.length),
          endFrame: Math.floor(((i + 1) * 3000) / words.length),
        }));
      }
    assert.equal(runEducationWorkflow(f.request, { action: "plan", rootDir: f.root }).metadata.durationSec, 1200);
    f.request.chapters[0].beats[0].durationFrames++;
    assert.throws(() => runEducationWorkflow(f.request, { action: "create", rootDir: f.root }), /20-minute/);
  } finally {
    f.cleanup();
  }
});

test("streamed full audio decode retains exact bounded windows, not duration-sized PCM", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "longform-stream-"));
  try {
    const audio = path.join(root, "tone.wav");
    assert.equal(
      spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=330:duration=3", "-ar", "48000", audio])
        .status,
      0,
    );
    const result = await decodeAudioWindows(audio, [
      { startSample: 12000, samples: 4800 },
      { startSample: 120000, samples: 4800 },
    ]);
    assert.equal(result.totalSamples, 144000);
    assert.equal(result.retainedBytes, 38400);
    for (const window of result.windows) assert.ok(window.data.some((b) => b !== 0));
    await assert.rejects(decodeAudioWindows(audio, [{ startSample: 143999, samples: 4800 }]), /incomplete/);
    await assert.rejects(decodeAudioWindows(audio, [{ startSample: -1, samples: 1 }]), /Invalid/);
    await assert.rejects(decodeAudioWindows(path.join(root, "missing.wav"), []), /decode failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("independent process-tree RSS sampler observes children during a blocked parent", { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "longform-memory-"));
  try {
    const output = path.join(root, "memory.json"),
      monitor = startProcessTreeMonitor(output);
    await monitor.ready;
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        "const memory = Buffer.alloc(64 * 1024 * 1024, 1); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); process.stdout.write(String(memory.length));",
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0);
    await monitor.stop();
    const evidence = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(evidence.rootPid, process.pid);
    assert.equal(evidence.sampleCadenceMs, 1000);
    assert.equal(evidence.failedSamples, 0);
    assert.ok(evidence.samples >= 3);
    const concurrent = evidence.series.find((s: { processes: Array<{ pid: number }> }) => s.processes.length >= 2);
    assert.ok(concurrent, "Child RSS was sampled while parent synchronously blocked");
    assert.equal(
      concurrent.rssBytes,
      concurrent.processes.reduce((n: number, p: { rssBytes: number }) => n + p.rssBytes, 0),
    );
    assert.ok(evidence.peakSampledAggregateRssBytes > 64 * 1024 * 1024);
    assert.ok(evidence.limitations.some((s: string) => s.includes("Reparented")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "fixture setup failure stops the independent sampler without hanging the worker",
  { skip: process.platform === "win32", timeout: 30000 },
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "longform-setup-failure-"));
    try {
      const actualFfmpeg = spawnSync("which", ["ffmpeg"], { encoding: "utf8" }).stdout.trim();
      assert.ok(actualFfmpeg);
      const counter = path.join(root, "counter"),
        wrapper = path.join(root, "ffmpeg");
      writeFileSync(
        wrapper,
        `#!${process.execPath}\nconst fs = require("node:fs"); const {spawnSync} = require("node:child_process");
const file = ${JSON.stringify(counter)}; const count = fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0; fs.writeFileSync(file, String(count + 1));
if (count === 4) {process.stderr.write("deliberate fixture tone failure"); process.exit(1);}
const child = spawnSync(${JSON.stringify(actualFfmpeg)}, process.argv.slice(2), {stdio: "inherit"}); process.exit(child.status ?? 1);\n`,
        { mode: 0o755 },
      );
      const childEnv: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: `${root}${path.delimiter}${process.env.PATH}`,
        RUN_WORKFLOW_FULLHD_TESTS: "1",
        WORKFLOW_FULLHD_DURATION_SEC: "600",
        WORKFLOW_ARTIFACTS_DIR: root,
      };
      delete childEnv.NODE_TEST_CONTEXT; // This is an independent acceptance worker, not recursive run().
      const child = spawnSync(
        path.resolve("node_modules/.bin/tsx"),
        ["--test", "tests/workflow-fullhd-browser.test.ts"],
        {
          env: childEnv,
          encoding: "utf8",
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        },
      );
      assert.equal(child.error, undefined, "Worker must finish before the timeout");
      assert.equal(child.status, 1, child.stdout + child.stderr);
      assert.match(child.stdout + child.stderr, /deliberate fixture tone failure/);
      assert.ok(
        existsSync(path.join(root, "fullhd-600s/process-tree-memory.json")),
        "Sampler was stopped and flushed even though setup failed",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
