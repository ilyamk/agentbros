import assert from "node:assert/strict";
import test from "node:test";
import { assessMasking, duckKeyframes, safeFixes, type MaskingEvent } from "../src/lib/audio/masking";
import { bandLevels, bandCentreHz, BAND_COUNT, SPECTRUM_RATE } from "../src/lib/audio/spectrum";
import { buildSyncMap, classifySpike, drawSyncMap, mergeCuts } from "../src/lib/audio/syncmap";
import { declaredCuts } from "../src/lib/audio/syncmap-files";
import { LocalAudioMixSchema } from "../src/types/audio-master";
import { AudioMapSchema } from "../src/types/film";

const FPS = 30;
const tone = (hz: number, seconds: number, amplitude: number) =>
  Float32Array.from(
    { length: Math.round(seconds * SPECTRUM_RATE) },
    (_, index) => amplitude * Math.sin((2 * Math.PI * hz * index) / SPECTRUM_RATE),
  );
/** A short decaying burst, like a tick or a pop. */
const burst = (hz: number, amplitude: number) =>
  tone(hz, 0.08, amplitude).map((value, index) => value * Math.exp(-index / (0.02 * SPECTRUM_RATE)));
/** Band-limited noise: a sum of tones across [low, high] with seeded phases, steady over the whole span. */
function bandNoise(low: number, high: number, seconds: number, amplitude: number, seed = 7): Float32Array {
  let state = seed;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const partials = Array.from({ length: 40 }, (_, index) => ({
    hz: low * (high / low) ** (index / 39),
    phase: random() * 2 * Math.PI,
  }));
  return Float32Array.from(
    { length: Math.round(seconds * SPECTRUM_RATE) },
    (_, index) =>
      (amplitude / Math.sqrt(partials.length)) *
      partials.reduce(
        (sum, partial) => sum + Math.sin((2 * Math.PI * partial.hz * index) / SPECTRUM_RATE + partial.phase),
        0,
      ),
  );
}
const event = (
  id: string,
  cueFrame: number,
  file: string,
  gain: number,
  extra: Partial<MaskingEvent> = {},
): MaskingEvent => ({ id, sfx: "tick", weight: "support", cueFrame, startFrame: cueFrame, file, gain, ...extra });

test("a full-scale sine reads about −3 dB in its own band and far lower two bands away", () => {
  const levels = bandLevels(tone(1000, 0.2, 1), 2000);
  const band = [...levels.keys()].reduce((a, b) => (levels[b]! > levels[a]! ? b : a));
  assert.equal(levels.length, BAND_COUNT);
  assert.ok(Math.abs(bandCentreHz(band) - 1000) < 150, `peak band ${bandCentreHz(band)} Hz`);
  assert.ok(Math.abs(levels[band]! + 3) < 1.5, `level ${levels[band]}`);
  assert.ok(levels[band + 3]! < levels[band]! - 30);
});

test("a tick inside loud same-band music is masked; the same tick over bass-only music is audible", () => {
  const sounds = new Map([["tick", burst(1500, 0.05)]]);
  const events = [event("tick", 30, "tick", 1)];
  const buried = assessMasking({ fps: FPS, events, sounds, music: bandNoise(1000, 2200, 2, 0.8) });
  assert.equal(buried.cues[0]!.status, "masked");
  assert.equal(buried.cues[0]!.masker, "music");
  assert.ok(buried.cues[0]!.marginDb < 0);
  const clear = assessMasking({ fps: FPS, events, sounds, music: bandNoise(50, 120, 2, 0.8) });
  assert.equal(clear.cues[0]!.status, "audible");
  assert.ok(clear.cues[0]!.marginDb > 10);
  assert.equal(clear.summary.masked, 0);
});

test("fixes: gain first within the ceiling, then a music duck; ducks become keyframes the mixer accepts", () => {
  const sounds = new Map([["tick", burst(1500, 0.05)]]);
  const report = assessMasking({
    fps: FPS,
    events: [event("a", 30, "tick", 0.1), event("b", 45, "tick", 0.19)],
    sounds,
    music: bandNoise(1000, 2200, 3, 0.8),
  });
  const [a, b] = report.cues;
  const gainA = a!.fixes.find((fix) => fix.type === "gain");
  assert.ok(gainA && gainA.type === "gain" && gainA.toGain <= 0.2 && gainA.toGain > 0.1);
  assert.ok(
    a!.fixes.some((fix) => fix.type === "duck"),
    "a deep deficit also ducks",
  );
  assert.ok(b!.fixes.every((fix) => fix.type !== "gain" || fix.toGain <= 0.2));
  const { events, ducks, changed } = safeFixes([event("a", 30, "tick", 0.1), event("b", 45, "tick", 0.19)], report);
  assert.equal(events[0]!.gain, gainA.toGain);
  assert.ok(ducks.length >= 1 && changed.length >= 2);
  const keyframes = duckKeyframes(ducks, { volume: 0.5 });
  const plan = LocalAudioMixSchema.parse({
    version: 1,
    durationSec: 3,
    tracks: [{ source: "music.wav", role: "music", volume: 0.5, keyframes }],
  });
  assert.ok(plan.tracks[0]!.keyframes.length >= 4);
  assert.equal(keyframes[0]!.volume, 0.5);
  assert.equal(keyframes.at(-1)!.volume, 0.5);
  assert.ok(Math.min(...keyframes.map((frame) => frame.volume)) < 0.5 * 10 ** (-2 / 20));
});

test("duck keyframes merge overlapping windows and multiply into the track's own keyframes", () => {
  const keyframes = duckKeyframes(
    [
      { fromSec: 1, toSec: 1.2, db: -6 },
      { fromSec: 1.25, toSec: 1.4, db: -3 },
    ],
    {
      volume: 1,
      keyframes: [
        { atSec: 0, volume: 1 },
        { atSec: 2, volume: 0.5 },
      ],
    },
  );
  const times = keyframes.map((frame) => frame.atSec);
  assert.deepEqual(
    times,
    [...times].sort((a, b) => a - b),
  );
  assert.equal(new Set(times).size, times.length);
  assert.ok(!times.includes(1.25), "the second window is merged into the first");
  const at = (sec: number) => keyframes.find((frame) => frame.atSec === sec)!.volume;
  assert.ok(
    Math.abs(at(1.4) - 0.65 * 10 ** (-6 / 20)) < 0.01,
    "the merged window holds the deeper duck, times the track's own ramp",
  );
  assert.equal(at(2), 0.5);
});

test("collisions: two sounds in one band within 200 ms, a layered pair on one cue, and a bright SFX on a consonant", () => {
  const sounds = new Map([
    ["tick", burst(1500, 0.3)],
    ["glass", burst(6000, 0.3)],
    ["low", burst(80, 0.3)],
  ]);
  const near = assessMasking({
    fps: FPS,
    events: [
      event("a", 30, "tick", 1),
      event("b", 32, "tick", 1),
      event("c", 60, "low", 1),
      event("d", 60, "glass", 1),
    ],
    sounds,
    music: new Float32Array(SPECTRUM_RATE * 3),
  });
  assert.deepEqual(
    near.collisions.map((item) => [item.kind, item.ids, item.layered ?? false]),
    [["sfx-sfx", ["a", "b"], false]],
  );
  const layered = assessMasking({
    fps: FPS,
    events: [event("a", 30, "tick", 1), event("b", 30, "tick", 0.5)],
    sounds,
    music: new Float32Array(SPECTRUM_RATE * 2),
  });
  assert.equal(layered.collisions[0]!.layered, true);
  const vo = new Float32Array(SPECTRUM_RATE * 2);
  vo.set(bandNoise(3500, 9000, 0.12, 0.3), Math.round(0.95 * SPECTRUM_RATE));
  const consonant = assessMasking({
    fps: FPS,
    events: [event("g", 30, "glass", 1), event("l", 30, "low", 1)],
    sounds,
    music: new Float32Array(SPECTRUM_RATE * 2),
    vo,
  });
  const hits = consonant.collisions.filter((item) => item.kind === "sfx-vo-consonant");
  assert.deepEqual(
    hits.map((item) => item.ids[0]),
    ["g"],
  );
});

const map = AudioMapSchema.parse({
  schemaVersion: 1,
  source: { path: "music.wav", sha256: "0".repeat(64), durationSec: 12 },
  tempo: { bpm: 120, confidence: 0.9, gridTrust: "reliable" },
  beatsSec: Array.from({ length: 24 }, (_, index) => index * 0.5),
  downbeatsSec: Array.from({ length: 6 }, (_, index) => index * 2),
  phrases: [
    { startSec: 0, endSec: 5, energy: 0.5 },
    { startSec: 5, endSec: 12, energy: 1 },
  ],
  sections: [],
  events: [],
  keyMoments: [],
  silences: [],
  risers: [],
  energyCurve: [],
});

test("sync map: error in frames to the nearest beat, structural cuts judged against downbeats, masked sounds flagged", () => {
  const sync = buildSyncMap({
    render: "film.mp4",
    fps: FPS,
    durationSec: 12,
    cutsSec: [1.0, 1.6, 4 - 1 / FPS, 5.0],
    map,
    sheet: { fps: FPS, events: [{ id: "t", sfx: "tick", cueFrame: 90, startFrame: 90, durationInFrames: 2 }] },
    masking: { cues: [{ id: "t", status: "masked", marginDb: -4 }] } as never,
  });
  assert.deepEqual(
    sync.cuts.map((cut) => [cut.errorFrames, cut.structural, cut.status]),
    [
      [0, false, "on-beat"],
      [3, false, "off-beat"],
      [-1, false, "on-beat"],
      [0, true, "missed-downbeat"],
    ],
  );
  assert.equal(Math.abs(sync.cuts[3]!.downbeatErrorFrames!), 30);
  assert.equal(sync.sounds[0]!.masked, true);
  assert.equal(sync.sounds[0]!.errorFramesToBeat, 0);
  assert.deepEqual(
    [sync.summary.onBeat, sync.summary.offBeat, sync.summary.structuralMissedDownbeat, sync.summary.worstErrorFrames],
    [2, 1, 1, 3],
  );
  const image = drawSyncMap(sync, { map, energyDb: Array.from({ length: 360 }, () => -20) });
  const pixel = (x: number, y: number) => [
    ...image.data.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3),
  ];
  const cutX = Math.round((1.6 / 12) * (image.width - 1));
  const column = Array.from({ length: image.height }, (_, y) => pixel(cutX + 1, y).join(","));
  assert.ok(column.includes("239,68,68"), "the off-beat cut is drawn red");
});

test("sync map: when the map says the bar is unknown, a structural cut is judged against beats only", () => {
  const unknown = {
    ...map,
    grid: {
      source: "tracker",
      confidence: 0.5,
      beatsPerBar: 4,
      downbeatConfidence: 0.1,
      bars: [],
      candidates: [],
      barKnown: false,
    },
  } as typeof map;
  const sync = buildSyncMap({ render: "film.mp4", fps: FPS, durationSec: 12, cutsSec: [5.0, 5.1], map: unknown });
  assert.equal(sync.barKnown, false);
  assert.deepEqual(
    sync.cuts.map((cut) => [cut.structural, cut.status]),
    [
      [true, "on-beat"],
      [true, "off-beat"],
    ],
  );
  assert.equal(sync.summary.structuralMissedDownbeat, 0);
  assert.equal(
    buildSyncMap({ render: "film.mp4", fps: FPS, durationSec: 12, cutsSec: [5.0], map }).barKnown,
    true,
    "a map without the field keeps downbeat verdicts",
  );
});

test("sync map: on a weak grid only phrase, section and key-moment anchors give verdicts; beat offsets are grey information", async () => {
  const weak = {
    ...map,
    tempo: { ...map.tempo, gridTrust: "weak" },
    keyMoments: [{ timeSec: 8, kind: "drop", strength: 1 }],
  } as typeof map;
  // 1.6: off-beat, no anchor near -> grey, no verdict. 5.1: 3 frames after the phrase start at 5 -> red miss. 8.0: on the drop -> green.
  const sync = buildSyncMap({ render: "film.mp4", fps: FPS, durationSec: 12, cutsSec: [1.6, 5.1, 8.0], map: weak });
  assert.equal(sync.verdictWeight, "low");
  assert.match(sync.gridNote ?? "", /phrase, section and key-moment/);
  assert.deepEqual(
    sync.cuts.map((cut) => [cut.status, cut.verdict, cut.anchor?.kind ?? null, cut.anchor?.errorFrames ?? null]),
    [
      ["off-beat", "none", null, null],
      ["off-beat", "miss", "phrase-start", 3],
      ["on-beat", "ok", "drop", 0],
    ],
  );
  assert.equal(sync.summary.misses, 1);
  assert.equal(sync.summary.structuralMissedDownbeat, 0, "downbeats are not judged on a weak grid");
  const reliableSync = buildSyncMap({ render: "film.mp4", fps: FPS, durationSec: 12, cutsSec: [1.6, 5.0], map });
  assert.deepEqual(
    reliableSync.cuts.map((cut) => [cut.verdict, cut.anchor]),
    [
      ["miss", undefined],
      ["miss", undefined],
    ],
    "a reliable grid judges as before",
  );
  const image = drawSyncMap(sync, { map: weak });
  const column = (sec: number) => {
    const x = Math.round((sec / 12) * (image.width - 1)) + 1;
    return Array.from({ length: image.height }, (_, y) =>
      [...image.data.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3)].join(","),
    );
  };
  assert.ok(
    !column(1.6).includes("239,68,68") && column(1.6).includes("150,150,160"),
    "an unanchored off-beat cut is grey",
  );
  assert.ok(column(5.1).includes("239,68,68"), "an anchor miss is red");
  const { syncmapSection } = await import("../src/lib/film/critic-pack");
  const section = syncmapSection({ sync, json: "s.json", image: "s.png" }) as Record<string, unknown>;
  assert.deepEqual(
    (section["offCuts"] as { against: string; errorFrames: number }[]).map((cut) => [cut.against, cut.errorFrames]),
    [["phrase-start", 3]],
  );
  assert.equal((section["beatOffsetsAdvisory"] as unknown[]).length, 2);
});

/** A flat series with a one-frame cut at 40 and the pilot's eased hero shrink peaking at 136–137. */
const diffSeries = () => {
  const diffs = Array.from({ length: 300 }, () => 1);
  diffs[40] = 60;
  [1.5, 3.7, 9.2, 21.8, 21.9, 7.7, 3.1].forEach((value, index) => (diffs[133 + index] = value));
  diffs[200] = 6;
  diffs[201] = 1.8;
  diffs[260] = 30;
  return diffs;
};

test("spike shape: a one-frame spike is a cut, an eased ramp is a move", () => {
  const diffs = diffSeries();
  assert.deepEqual([classifySpike(diffs, 41).shape, classifySpike(diffs, 41).frame], ["cut", 40]);
  const move = classifySpike(diffs, 136);
  assert.equal(move.shape, "move");
  assert.ok(move.ratio < 1.2, `ratio ${move.ratio}`);
  assert.equal(classifySpike(diffs, 200).shape, "cut", "a small flat swap is still a spike against its neighbours");
});

test("declared cuts merge with detected ones: both, declared only, detected only; unclaimed ramps become moves", () => {
  const diffs = diffSeries();
  const detected = [41, 136, 261].map((frame) => classifySpike(diffs, frame));
  const { cuts, moves } = mergeCuts(
    [
      { frame: 40, kind: "cut" },
      { frame: 200, kind: "ground-swap", label: "swap" },
      { frame: 200, kind: "cut" },
    ],
    detected,
  );
  assert.deepEqual(
    cuts.map((cut) => [cut.frame, cut.source, cut.declaredKind ?? null]),
    [
      [40, "both", "cut"],
      [200, "declared", "ground-swap"],
      [260, "detected", null],
    ],
  );
  assert.deepEqual(
    moves.map((move) => move.frame),
    [137],
  );
});

test("sync map: a move gets no verdict and is drawn as a thin marker; a declared flat swap is measured on its small spike; cuts before the grid get no beat verdict", () => {
  const diffs = diffSeries();
  const late = {
    ...map,
    beatsSec: map.beatsSec.filter((beat) => beat >= 4),
    downbeatsSec: map.downbeatsSec.filter((beat) => beat >= 4),
    phrases: [],
    keyMoments: [],
  } as typeof map;
  const sync = buildSyncMap({
    render: "film.mp4",
    fps: FPS,
    durationSec: 10,
    cutsSec: [136 / FPS, 140 / FPS],
    frameDiffs: diffs,
    declared: [
      { frame: 40, kind: "cut" },
      { frame: 201, kind: "cut" },
    ],
    map: late,
  });
  assert.deepEqual(
    sync.moves.map((move) => move.frame),
    [137],
  );
  assert.deepEqual(
    sync.cuts.map((cut) => [cut.frame, cut.source, cut.status, cut.verdict]),
    [
      [40, "declared", "no-grid", "none"],
      [200, "declared", "off-beat", "miss"],
    ],
  );
  assert.equal(sync.cuts[1]!.declaredFrame, 201);
  assert.deepEqual([sync.summary.declared, sync.summary.both, sync.summary.detected, sync.summary.moves], [2, 0, 0, 1]);
  const image = drawSyncMap(sync, { map: late });
  const x = Math.round((137 / FPS / 10) * (image.width - 1));
  const column = Array.from({ length: image.height }, (_, y) =>
    [...image.data.subarray((y * image.width + x) * 3, (y * image.width + x) * 3 + 3)].join(","),
  );
  assert.ok(column.includes("167,139,250") && !column.includes("239,68,68"), "the move is violet, never red");
});

test("declared cuts are read from an edit plan, placements, a sound sheet's blockCues and a plain cut list", () => {
  assert.deepEqual(
    declaredCuts(
      {
        kind: "edit-plan",
        fps: 30,
        events: [
          { id: "a", kind: "cut", frame: 120 },
          { id: "b", kind: "hit", frame: 130 },
          { id: "c", kind: "ground-swap", frame: 150 },
        ],
      },
      30,
    ).map((cut) => [cut.frame, cut.kind]),
    [
      [120, "cut"],
      [150, "ground-swap"],
    ],
  );
  assert.deepEqual(
    declaredCuts(
      {
        fps: 30,
        blocks: [
          {
            startFrame: 100,
            cues: [
              { frame: 9, kind: "cut" },
              { frame: 3, kind: "type" },
            ],
          },
        ],
      },
      30,
    ).map((cut) => cut.frame),
    [109],
  );
  assert.deepEqual(
    declaredCuts({ fps: 30, events: [], blockCues: [{ frame: 69, kind: "cut", label: "cut to the stat" }] }, 30),
    [{ frame: 69, kind: "cut", label: "cut to the stat" }],
  );
  assert.deepEqual(declaredCuts({ fps: 60, cuts: [{ frame: 120 }] }, 30), [{ frame: 60, kind: "cut" }]);
});
