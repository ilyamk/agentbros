import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { computeCurves, envelope, phaseAt } from "../src/lib/audio-curves/compute";
import { measureLevels } from "../src/lib/audio-curves/measure";
import { AudioCurvesSchema } from "../src/lib/audio-curves/schema";
import { fallbackGrid } from "../src/motion/sync/beatGrid";
import { barPhase, beatPhase, curveAt, curveIntegral, firstCurve, pulse } from "../src/motion/sync/curves";
import { demoCurves } from "../src/motion/sync/demo-curves";
import { AudioMapSchema, type AudioMap } from "../src/types/film";

const FPS = 30;

function clickMap(overrides: Partial<AudioMap> = {}): AudioMap {
  const beats = Array.from({ length: 16 }, (_, index) => index * 0.5);
  return AudioMapSchema.parse({
    schemaVersion: 1,
    source: { path: "click.wav", sha256: "a".repeat(64), durationSec: 8 },
    tempo: { bpm: 120, confidence: 0.9, gridTrust: "reliable" },
    beatsSec: beats,
    downbeatsSec: beats.filter((_, index) => index % 4 === 0),
    phrases: [],
    sections: [],
    events: [],
    keyMoments: [],
    silences: [],
    risers: [],
    energyCurve: Array.from({ length: 161 }, (_, index) => ({
      timeSec: index * 0.05,
      rms: (index % 10) / 10,
      low: 0.5,
      high: 0.2,
    })),
    drums: {
      source: "mix",
      kick: beats.map((timeSec) => ({ timeSec, strength: 0.9 })),
      snare: [{ timeSec: 1.02, strength: 0.6 }],
      hat: [],
    },
    ...overrides,
  });
}

test("kick envelope peaks on the hit frame and halves every half-life", () => {
  const curves = computeCurves({
    map: clickMap(),
    fps: FPS,
    params: { halfLifeMs: 100 },
    source: { map: "click.json" },
  });
  assert.ok(AudioCurvesSchema.safeParse(curves).success);
  const kick = curves.curves.kick!;
  assert.equal(kick.length, 240);
  for (const frame of [0, 15, 30, 45, 210]) assert.equal(kick[frame], 0.9, `peak at ${frame}`);
  assert.ok(kick[14]! < kick[15]! && kick[16]! < kick[15]!);
  assert.ok(Math.abs(kick[18]! - 0.9 * 0.5) < 0.01, "3 frames = 100 ms later it has halved");
  assert.equal(curves.curves.snare![31], 0.6, "1.02 s rounds to frame 31, as beatGridFromMap rounds");
  for (const values of Object.values(curves.curves)) for (const value of values!) assert.ok(value >= 0 && value <= 1);
});

test("overlapping hits take the max, never a sum above 1", () => {
  const values = envelope(
    [
      { timeSec: 0, strength: 1 },
      { timeSec: 0.034, strength: 1 },
    ],
    10,
    FPS,
    0,
    500,
  );
  assert.equal(Math.max(...values), 1);
});

test("phases, downbeats and the offset follow the grid", () => {
  const curves = computeCurves({ map: clickMap(), fps: FPS, offsetSec: 1, source: { map: "click.json" } });
  assert.equal(curves.frameCount, 210);
  assert.equal(curves.grid.beats[0], -30);
  assert.equal(curves.curves.kick![0], 0.9, "track 1 s is film frame 0");
  assert.equal(curves.curves.downbeat![30], 1, "track downbeat at 2 s is film frame 30");
  assert.ok(Math.abs(curves.curves.beatPhase![7]! - 7 / 15) < 0.002);
  assert.ok(Math.abs(curveAt(curves, "barPhase", 45) - 0.25) < 1e-9);
});

test("no grid: no phases and no downbeat, envelopes stay", () => {
  const curves = computeCurves({
    map: clickMap({ tempo: { confidence: 0.1, gridTrust: "none" } }),
    fps: FPS,
    source: { map: "click.json" },
  });
  assert.equal(curves.curves.beatPhase, undefined);
  assert.equal(curves.curves.downbeat, undefined);
  assert.deepEqual(curves.grid.beats, []);
  assert.equal(curveAt(curves, "beatPhase", 10), 0);
  assert.ok(curves.curves.kick);
  assert.equal(curves.curves.mid, undefined, "mid needs --input");
});

test("curveAt is deterministic, interpolates sub-frames and wraps phase cleanly", () => {
  const curves = demoCurves();
  const first = Array.from({ length: 240 }, (_, frame) => curveAt(curves, "kick", frame, { smooth: 2 }));
  const second = Array.from({ length: 240 }, (_, frame) => curveAt(curves, "kick", frame, { smooth: 2 }));
  assert.deepEqual(first, second);
  const a = curveAt(curves, "level", 10);
  const b = curveAt(curves, "level", 11);
  assert.ok(Math.abs(curveAt(curves, "level", 10.5) - (a + b) / 2) < 1e-9);
  assert.ok(curveAt(curves, "beatPhase", 14.9) > 0.99);
  assert.equal(curveAt(curves, "beatPhase", 15), 0);
  assert.ok(Math.abs(curveAt(curves, "beatPhase", 15.5) - 1 / 30) < 1e-9);
  assert.equal(curveAt(curves, "kick", 5, { offsetFrames: 10 }), curves.curves.kick![15]);
  assert.equal(curveAt(curves, "kick", 15, { gain: 3 }), 1, "gain clamps to 1");
  assert.equal(curveAt(curves, "kick", -5), curves.curves.kick![0]);
  assert.equal(curveAt(curves, "kick", 1e6), curves.curves.kick!.at(-1));
});

test("integral never runs backwards; helpers", () => {
  const curves = demoCurves();
  let previous = -1;
  for (let frame = 0; frame < 240; frame += 0.25) {
    const value = curveIntegral(curves, "low", frame, { smooth: 6 });
    assert.ok(value >= previous);
    previous = value;
  }
  assert.equal(pulse(0, 0.02), 1);
  assert.equal(pulse(1, 0.02), 1.02);
  assert.equal(firstCurve(curves, ["bass", "low"]), "low");
  const grid = fallbackGrid({ bpm: 120, fps: FPS, durationInFrames: 240 });
  assert.ok(Math.abs(beatPhase(grid, 22.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(barPhase(grid, 30) - 0.5) < 1e-9);
  assert.equal(beatPhase(curves, 22.5), beatPhase(grid, 22.5));
});

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

/** 16-bit mono WAV: low thumps (60 Hz) on each half second, high ticks (6 kHz) a quarter second later. */
function clickTrack(file: string, seconds: number, rate = 24000) {
  const samples = new Int16Array(seconds * rate);
  for (let beat = 0; beat < seconds * 2; beat++) {
    const low = Math.round(beat * 0.5 * rate);
    for (let i = 0; i < rate * 0.04 && low + i < samples.length; i++)
      samples[low + i] = Math.round(20000 * Math.sin((2 * Math.PI * 60 * i) / rate) * (1 - i / (rate * 0.04)));
    const high = Math.round((beat * 0.5 + 0.25) * rate);
    for (let i = 0; i < rate * 0.02 && high + i < samples.length; i++)
      samples[high + i] = Math.round(12000 * Math.sin((2 * Math.PI * 6000 * i) / rate));
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.byteLength, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.byteLength, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.from(samples.buffer)]));
}

test("measured bands from a click track peak on the right frames", { skip: !hasFfmpeg && "ffmpeg missing" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "audio-curves-"));
  try {
    const file = path.join(dir, "click.wav");
    clickTrack(file, 4);
    const measured = measureLevels(file, { fps: FPS, offsetSec: 0, frameCount: 120 });
    const curves = computeCurves({
      map: clickMap({ source: { path: file, sha256: "a".repeat(64), durationSec: 4 } }),
      fps: FPS,
      frameCount: 120,
      measured,
      params: { attackMs: 0, releaseMs: 0 },
      source: { map: "click.json", input: file },
    });
    const low = curves.curves.low!;
    const high = curves.curves.high!;
    for (const beat of [15, 30, 45, 60]) {
      assert.ok(low[beat]! > 0.8, `low thump at frame ${beat}: ${low[beat]}`);
      assert.ok(low[beat + 7]! < 0.1, `low quiet between thumps at ${beat + 7}: ${low[beat + 7]}`);
      assert.ok(high[beat + 7]! > 0.5 || high[beat + 8]! > 0.5, `high tick at ${beat + 7}/${beat + 8}`);
      assert.ok(high[beat]! < 0.2, `no high on the thump at ${beat}: ${high[beat]}`);
    }
    assert.ok(curves.curves.mid, "mid comes with --input");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audio-reactive props are off by default and accept a small config", { timeout: 120000 }, async () => {
  const { loadLibrary } = await import("../src/lib/library/load");
  const { items } = await loadLibrary();
  for (const id of ["type-hero-word", "kinetic-headline-build", "mesh-gradient", "ui-camera-read"]) {
    const item = items.find((entry) => entry.id === id);
    assert.ok(item, id);
    assert.equal("react" in item.defaultProps, false, `${id}: react must be absent from defaults`);
    assert.ok(item.schema.safeParse({ ...item.defaultProps, react: { amount: 0.02 } }).success, `${id}: accepts react`);
    assert.equal(
      item.schema.safeParse({ ...item.defaultProps, react: { amount: 5 } }).success,
      false,
      `${id}: amount is capped`,
    );
  }
  assert.ok(items.some((entry) => entry.id === "audio-pulse-demo"));
});
