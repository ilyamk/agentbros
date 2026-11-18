import assert from "node:assert/strict";
import test from "node:test";
import { shotsLayer } from "../src/lib/reference/shots";
import { buildSync, lift, signedMedianOffset } from "../src/lib/reference/sync";

const audio = (bpm: number, seconds: number) => {
  const step = 60 / bpm;
  const beatsSec = Array.from({ length: Math.floor(seconds / step) }, (_, i) => Math.round(i * step * 1000) / 1000);
  return {
    schemaVersion: 1 as const,
    referenceId: "demo",
    hasAudio: true,
    tempo: { bpm, confidence: 1, beatsSec, downbeatsSec: beatsSec.filter((_, i) => i % 4 === 0) },
    onsetsSec: [],
    sections: [],
    silence: [],
  };
};
const cutsAt = (times: number[]) =>
  shotsLayer(
    "demo",
    30,
    times.map((timeSec) => ({ timeSec, startSec: timeSec, endSec: timeSec, kind: "cut" as const, confidence: 0.9 })),
    { name: "test", params: {} },
  );

test("lift and signed offset", () => {
  assert.equal(lift(0.5, 0.25), 2);
  assert.equal(lift(0.5, 0), undefined);
  assert.equal(signedMedianOffset([1.03, 2.03, 2.97], [1, 2, 3]), 0.03);
  assert.equal(signedMedianOffset([0.96, 1.97], [1, 2]), -0.035);
});

test("at 174 BPM the ±80 ms beat rate is near chance; downbeat-frame lift separates sync from scatter", () => {
  const track = audio(174, 30);
  const downbeats = track.tempo.downbeatsSec;
  const synced = buildSync({
    referenceId: "demo",
    durationSec: 30,
    shots: cutsAt(downbeats.slice(1, 13).map((at) => Math.round((at - 1 / 30) * 1000) / 1000)),
    audio: track,
    fps: 30,
  });
  assert.ok(synced.metrics.cutsOnBeatChance! > 0.4, "the old window covers almost half the timeline");
  assert.equal(synced.metrics.cutsOnDownbeatFrameRatio, 1);
  assert.ok(synced.metrics.cutsOnDownbeatFrameLift! > 5);
  assert.ok(synced.metrics.signedMedianCutToBeatSec! < 0, "cuts a frame early read as negative");
  const scattered = buildSync({
    referenceId: "demo",
    durationSec: 30,
    shots: cutsAt(Array.from({ length: 12 }, (_, i) => 1.17 + i * 2.31)),
    audio: track,
    fps: 30,
  });
  assert.ok(scattered.metrics.cutsOnDownbeatFrameLift! < 2);
  assert.ok(
    synced.metrics.cutsOnBeatRatio !== undefined && synced.metrics.cutsOnBeatChance !== undefined,
    "old fields stay",
  );
  assert.equal(synced.metrics.frameToleranceSec, 0.033);
  const oneFrame = buildSync({
    referenceId: "demo",
    durationSec: 30,
    shots: cutsAt([downbeats[2]! + 0.034]),
    audio: track,
    fps: 30,
  });
  assert.equal(oneFrame.metrics.cutsOnDownbeatFrameRatio, 1, "a cut 0.034 s off is one frame off");
});
