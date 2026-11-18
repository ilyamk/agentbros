import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { takeList } from "../src/lib/multicam/args";
import { assess, DEFAULT_THRESHOLDS, sourceIds } from "../src/lib/multicam/sync";
import { MulticamSyncSchema } from "../src/types/multicam";

const repo = path.resolve(import.meta.dirname, "..");
const hasUv = spawnSync(process.env.MULTICAM_UVX ?? "uvx", ["--version"], { encoding: "utf8" }).status === 0;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const worker = { skip: hasUv && hasFfmpeg ? false : "needs uv and ffmpeg", timeout: 900000 } as const;

const ffmpeg = (...args: string[]) => {
  const result = spawnSync("ffmpeg", ["-v", "error", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

function cli(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "scripts/multicam-sync.ts"), ...args],
    { encoding: "utf8", timeout: 900000, cwd: repo },
  );
  const lines = result.stdout.trim().split("\n");
  assert.equal(lines.length, 1, result.stdout + result.stderr);
  return {
    status: result.status,
    envelope: JSON.parse(lines[0]!) as {
      ok: boolean;
      error?: string;
      message?: string;
      details?: { failures?: Record<string, string[]> };
    },
  };
}

test("takeList collects space- and comma-separated values", () => {
  assert.deepEqual(takeList(["--inputs", "a.mp4", "b.wav", "--output", "x.json"], "inputs"), {
    values: ["a.mp4", "b.wav"],
    rest: ["--output", "x.json"],
  });
  assert.deepEqual(takeList(["--inputs=a,b"], "inputs").values, ["a", "b"]);
  assert.equal(takeList(["--output", "x"], "inputs").values, undefined);
});

test("source ids come from file names and stay unique", () => {
  assert.deepEqual(sourceIds(["/x/Cam A.mp4", "/y/Cam A.mov", "/z/_mic.wav"]), ["Cam-A", "Cam-A-2", "mic"]);
  assert.throws(() => sourceIds(["a", "b"], ["one"]), /every input/);
});

test("assess: drift ppm, accumulated drift, resample verdict and low-confidence reasons", () => {
  const good = assess(
    { offsetSec: 2.0, standardScore: 30 },
    {
      overlap: [2, 602],
      start: { referenceSec: 7, offsetSec: 2.0005, peakRatio: 40 },
      end: { referenceSec: 597, offsetSec: 2.0005 + 590 * 100e-6, peakRatio: 30 },
    },
    DEFAULT_THRESHOLDS,
  );
  assert.equal(good.confidence, "high");
  assert.ok(Math.abs(good.drift.ppm! - 100) < 1e-6);
  assert.ok(Math.abs(good.drift.accumulatedMs! - 60) < 1e-6);
  assert.equal(good.drift.needsResample, true);
  assert.ok(Math.abs(good.offsetSec - (2.0005 - 5 * 100e-6)) < 1e-9);
  const weak = assess(
    { offsetSec: 1, standardScore: 4 },
    { overlap: [1, 20], start: { referenceSec: 5, offsetSec: 1, peakRatio: 1.2 }, end: null },
    DEFAULT_THRESHOLDS,
  );
  assert.equal(weak.confidence, "low");
  assert.equal(weak.reasons.length, 2);
  assert.equal(weak.drift.measured, false);
});

test("multicam:sync finds known offsets within 1 ms, both signs, and measures drift", worker, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "multicam-sync-"));
  try {
    const noise = path.join(dir, "noise.wav");
    ffmpeg("-f", "lavfi", "-i", "anoisesrc=d=75:c=pink:r=48000:seed=7:a=0.3", "-ac", "1", "-c:a", "pcm_s16le", noise);
    const reference = path.join(dir, "wide.mov");
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=30:d=40",
      "-i",
      noise,
      "-t",
      "40",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      reference,
    );
    const close = path.join(dir, "close.mov");
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=30:d=30",
      "-ss",
      "3.2105",
      "-i",
      noise,
      "-t",
      "30",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      close,
    );
    const phone = path.join(dir, "phone.mp4");
    ffmpeg(
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=160x90:r=30:d=30",
      "-ss",
      "5.4321",
      "-i",
      noise,
      "-t",
      "30",
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      phone,
    );
    const early = path.join(dir, "early.wav");
    ffmpeg("-i", noise, "-af", "adelay=1500,atrim=end=35", "-c:a", "pcm_s16le", early);
    const drifting = path.join(dir, "drift.wav");
    ffmpeg("-i", noise, "-af", "asetrate=48015,aresample=48000,atrim=end=38", "-c:a", "pcm_s16le", drifting);
    const output = path.join(dir, "sync.json");
    const { status, envelope } = cli([
      "--inputs",
      reference,
      close,
      phone,
      early,
      drifting,
      "--output",
      output,
      "--drift-tolerance-ms",
      "5",
    ]);
    assert.equal(status, 0, JSON.stringify(envelope));
    const sync = MulticamSyncSchema.parse(JSON.parse(readFileSync(output, "utf8")));
    const byId = Object.fromEntries(sync.sources.map((source) => [source.id, source]));
    assert.equal(sync.referenceId, "wide");
    assert.ok(Math.abs(byId.close!.offsetSec - 3.2105) < 0.001, `close ${byId.close!.offsetSec}`);
    assert.ok(Math.abs(byId.early!.offsetSec + 1.5) < 0.001, `early ${byId.early!.offsetSec}`);
    assert.ok(Math.abs(byId.close!.videoOffsetSec! - 3.2105) < 0.001);
    assert.ok(Math.abs(byId.phone!.offsetSec - 5.4321) < 0.001, `AAC phone ${byId.phone!.offsetSec}`);
    assert.ok(Math.abs(byId.phone!.videoOffsetSec! - 5.4321) < 0.001, `AAC phone video ${byId.phone!.videoOffsetSec}`);
    assert.equal(byId.early!.video, null);
    assert.ok(Math.abs(byId.close!.drift.ppm!) < 5, `close drift ${byId.close!.drift.ppm}`);
    const expectedPpm = (1 - 48000 / 48015) * 1e6;
    assert.ok(Math.abs(byId.drift!.drift.ppm! - expectedPpm) < 15, `drift ${byId.drift!.drift.ppm} vs ${expectedPpm}`);
    assert.ok(Math.abs(byId.drift!.offsetSec) < 0.001);
    assert.ok(Math.abs(byId.drift!.drift.accumulatedMs! - expectedPpm * 38e-3) < 1);
    assert.equal(byId.drift!.drift.needsResample, true);
    assert.equal(byId.close!.drift.needsResample, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("multicam:sync fails clearly on unrelated audio", worker, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "multicam-sync-"));
  try {
    const a = path.join(dir, "a.wav");
    const b = path.join(dir, "b.wav");
    ffmpeg("-f", "lavfi", "-i", "anoisesrc=d=20:c=pink:r=48000:seed=7:a=0.3", "-ac", "1", "-c:a", "pcm_s16le", a);
    ffmpeg("-f", "lavfi", "-i", "anoisesrc=d=20:c=pink:r=48000:seed=99:a=0.3", "-ac", "1", "-c:a", "pcm_s16le", b);
    const { status, envelope } = cli(["--inputs", a, b, "--output", path.join(dir, "sync.json")]);
    assert.notEqual(status, 0);
    assert.equal(envelope.error, "VALIDATION");
    assert.match(envelope.message!, /Low sync confidence for b/);
    assert.ok(envelope.details?.failures?.b?.length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
