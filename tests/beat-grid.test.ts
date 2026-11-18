import assert from "node:assert/strict";
import test from "node:test";
import { leadFor, leadFrame, toSheetKind } from "../src/lib/audio-map/leads";
import {
  beatAt,
  beatGridFromMap,
  fallbackGrid,
  shotLengthsFromSections,
  shotStarts,
  snap,
  snapFrame,
} from "../src/motion/sync/beatGrid";
import { AudioMapSchema, type AudioMap } from "../src/types/film";

function map(overrides: Partial<AudioMap> = {}): AudioMap {
  const beats = Array.from({ length: 40 }, (_, index) => index * 0.5);
  return AudioMapSchema.parse({
    schemaVersion: 1,
    source: { path: "track.wav", sha256: "a".repeat(64), durationSec: 20 },
    tempo: { bpm: 120, confidence: 0.9, gridTrust: "reliable" },
    beatsSec: beats,
    downbeatsSec: beats.filter((_, index) => index % 4 === 0),
    phrases: [
      { startSec: 0, endSec: 8, energy: 0.5 },
      { startSec: 8, endSec: 16, energy: 0.8 },
      { startSec: 16, endSec: 20, energy: 0.6 },
    ],
    sections: [
      { startSec: 0, endSec: 8, level: "low", density: 1, feel: "calm" },
      { startSec: 8, endSec: 16, level: "high", density: 6, feel: "busy" },
      { startSec: 16, endSec: 20, level: "mid", density: 2, feel: "falling" },
    ],
    events: beats.map((timeSec, index) => ({
      timeSec,
      kind: index % 4 === 0 ? "kick" : "hat",
      strength: index % 4 === 0 ? 0.9 : 0.4,
      metric: index % 4 === 0 ? "downbeat" : "beat",
    })),
    keyMoments: [
      { timeSec: 8, kind: "surge", strength: 0.9 },
      { timeSec: 17.3, kind: "hard-stop", strength: 1 },
    ],
    silences: [{ startSec: 17.3, endSec: 18 }],
    risers: [],
    energyCurve: [],
    ...overrides,
  });
}

test("leads are clamped per kind and map library kinds", () => {
  assert.equal(leadFor("cut"), 1);
  assert.equal(leadFor("sfx", { sfx: 2 }), 0, "sound never leads its picture");
  assert.equal(leadFor("hit", { hit: 7 }), 3);
  assert.equal(leadFrame(0, "cut"), 0);
  assert.equal(toSheetKind("land"), "hit");
  assert.equal(toSheetKind("click"), "sfx");
  assert.equal(toSheetKind("transition"), "transition");
});

test("a map becomes film frames, offset applied", () => {
  const grid = beatGridFromMap(map(), { fps: 30, offsetSec: 1 });
  assert.equal(grid.beats[0], 0);
  assert.equal(grid.beats[1], 15);
  assert.equal(grid.downbeats[0], 30, "track downbeat at 2 s is film 1 s");
  assert.deepEqual(grid.surges, [210]);
  assert.deepEqual(grid.hardStops, [489]);
  assert.equal(grid.durationInFrames, 570);
});

test("snap: a cut a frame before the downbeat, sfx on the onset, a hit up to three early", () => {
  const grid = beatGridFromMap(map(), { fps: 30 });
  assert.deepEqual(snap(grid, 122, "cut"), { frame: 119, anchorFrame: 120, leadFrames: 1, anchor: "downbeat" });
  assert.equal(snapFrame(grid, 77, "sfx"), 75);
  assert.equal(snapFrame(grid, 241, "land", { leadFrames: { hit: 3 } }), 237);
  assert.equal(snap(grid, 100, "cut").anchor, "none");
  assert.equal(snapFrame(grid, 100, "cut"), 100);
  assert.equal(snap(grid, 520, "stop", { toleranceFrames: 2 }).anchorFrame, 519);
});

test("between two anchors of one kind the nearer wins", () => {
  const grid = { ...fallbackGrid({ bpm: 120, fps: 30, durationInFrames: 300 }), onsets: [97, 102] };
  assert.equal(snap(grid, 100, "sfx", { to: ["onset"] }).anchorFrame, 102);
  assert.equal(snap(grid, 99, "sfx", { to: ["onset"] }).anchorFrame, 97);
});

test("a weak grid snaps only to measured moments", () => {
  const grid = beatGridFromMap(map({ tempo: { bpm: 120, confidence: 0.2, gridTrust: "weak" } }), { fps: 30 });
  assert.equal(snap(grid, 122, "cut").anchor, "none");
  assert.equal(snap(grid, 242, "cut").anchor, "surge");
});

test("shot lengths follow section levels and sum to the film", () => {
  const grid = beatGridFromMap(map(), { fps: 30 });
  const lengths = shotLengthsFromSections(grid, { totalFrames: 600 });
  assert.equal(
    lengths.reduce((sum, length) => sum + length, 0),
    600,
  );
  const starts = shotStarts(lengths);
  assert.ok(starts.includes(239), "the surge section starts a frame early");
  const calm = starts.filter((start) => start > 0 && start < 239);
  const busy = starts.filter((start) => start > 239 && start < 479);
  assert.ok(busy.length > calm.length * 2, `busy ${busy.length} vs calm ${calm.length}`);
  assert.deepEqual(shotLengthsFromSections(grid, { totalFrames: 600 }), lengths, "deterministic");
});

test("fallback grid from bpm", () => {
  const grid = fallbackGrid({ bpm: 120, fps: 30, durationInFrames: 300 });
  assert.equal(grid.trust, "assumed");
  assert.deepEqual(grid.beats.slice(0, 3), [0, 15, 30]);
  assert.deepEqual(grid.downbeats.slice(0, 3), [0, 60, 120]);
  assert.equal(snapFrame(grid, 62, "cut"), 59);
  assert.equal(
    shotLengthsFromSections(grid).reduce((a, b) => a + b, 0),
    300,
  );
});

test("fallbackGrid with an anchor fills the beats before the drop and counts bars from it", () => {
  const plain = fallbackGrid({ bpm: 120, fps: 30, durationInFrames: 300, offsetFrames: 10 });
  assert.equal(plain.anchorFrame, undefined);
  assert.equal(plain.beats[0], 10);
  const grid = fallbackGrid({ bpm: 140, fps: 30, durationInFrames: 435, anchorFrame: 120 });
  assert.equal(grid.anchorFrame, 120);
  assert.equal(grid.beats[0], 4);
  assert.ok(grid.beats.includes(120));
  assert.ok(
    grid.downbeats.includes(120) &&
      grid.downbeats.includes(beatAt(grid, -4)) &&
      grid.downbeats.includes(beatAt(grid, -8)),
  );
  assert.ok(!grid.downbeats.includes(beatAt(grid, -1)));
  assert.ok(grid.phrases.includes(120));
  assert.deepEqual(grid.surges, [120]);
  assert.equal(beatAt(grid, -9), 4);
  assert.equal(beatAt(grid, -4), 69);
  assert.equal(beatAt(grid, 0), 120);
  assert.equal(beatAt(grid, 14), 300);
  assert.equal(beatAt(plain, 2), 40);
  assert.throws(() => beatAt({ fps: 30, beats: [0] }, 1));
});
