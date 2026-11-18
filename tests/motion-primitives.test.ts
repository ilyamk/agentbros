import test from "node:test";
import assert from "node:assert/strict";
import { projectLayer, regionTransform, shake, STILL_POSE } from "../src/motion/camera-math";
import {
  captionWords,
  collageCells,
  dollyPosition,
  dollyWord,
  elasticAxes,
  glyphRiseAt,
  growRect,
  hitDecay,
  hitsDecay,
  hitShake,
  lightBlobs,
  morphRect,
  odometerReels,
  raceValue,
  radialLines,
  scrambleChroma,
  scrambleGlyphs,
  shockRingAt,
  smearAt,
  typedCount,
  typingSchedule,
  wordPose,
  wordSpeed,
} from "../src/motion/kinetic-math";
import { layoutSeries } from "../src/motion/series";
import {
  DEFAULT_MASK_BLEED,
  formatOf,
  glyphWeight,
  linesFor,
  maskTravelEm,
  splitGraphemes,
  splitLines,
  splitWords,
} from "../src/motion/text-split";
import {
  activeCue,
  audioPulse,
  beatCues,
  beatGrid,
  cueFrame,
  cueFrames,
  cuePulse,
  curves,
  energyAt,
  followThrough,
  hierarchy,
  intentCurves,
  motionSigma,
  onSteps,
  progress,
  radialOrder,
  speedAt,
  stagger,
  timeRemap,
  track,
  trackPoint,
  velocity,
} from "../src/motion/timing";

test("intent curves start at 0 and end at 1; only punch and settle pass 1, the rest never fall back", () => {
  const samples = Array.from({ length: 201 }, (_, i) => i / 200);
  for (const [name, curve] of Object.entries(intentCurves)) {
    assert.ok(Math.abs(curve(0)) < 1e-6, name);
    assert.ok(Math.abs(curve(1) - 1) < 1e-6, name);
    const values = samples.map(curve);
    if (name === "punch" || name === "settle") {
      assert.ok(Math.max(...values) > 1.01, `${name} overshoots`);
      assert.ok(Math.max(...values) < 1.12, `${name} overshoot stays small`);
    } else {
      for (let i = 1; i < values.length; i++)
        assert.ok(values[i]! >= values[i - 1]! - 1e-9, `${name} is monotonic at ${samples[i]}`);
      assert.ok(Math.max(...values) <= 1 + 1e-9, name);
    }
  }
  assert.equal(intentCurves.settle(0.37), intentCurves.settle(0.37), "pure");
});

test("hierarchy enters hero, then support, then detail, and scales its gaps with fps", () => {
  const plan = hierarchy({ hero: 2, support: 2, detail: 3 }, { at: 6 });
  assert.deepEqual(plan.hero, [6, 10]);
  assert.ok(plan.support[0]! > plan.hero.at(-1)!);
  assert.ok(plan.detail[0]! > plan.support.at(-1)!);
  for (const role of [plan.hero, plan.support, plan.detail])
    for (let i = 1; i < role.length; i++) assert.ok(role[i]! > role[i - 1]!);
  assert.equal(plan.last, plan.detail.at(-1));
  const at60 = hierarchy({ hero: 1, support: 1, detail: 1 }, { fps: 60 });
  const at30 = hierarchy({ hero: 1, support: 1, detail: 1 });
  assert.equal(at60.support[0], at30.support[0]! * 2);
  assert.deepEqual(hierarchy({ hero: 1, detail: 2 }).support, []);
  assert.ok(hierarchy({ hero: 1, detail: 2 }).detail[0]! > 0, "detail waits for the hero even with no support");
});

test("followThrough is silent before the stop, peaks at its amplitude in the direction of travel and dies away", () => {
  assert.equal(followThrough(10, 10, { amplitude: 12 }), 0);
  assert.equal(followThrough(3, 10, { amplitude: 12 }), 0);
  const swing = Array.from({ length: 40 }, (_, i) => followThrough(10 + i, 10, { amplitude: 12 }));
  assert.ok(swing[1]! > 0, "carries on in the direction of travel");
  assert.ok(Math.max(...swing) <= 12 + 1e-9 && Math.max(...swing) > 11);
  assert.ok(Math.min(...swing) < 0, "swings back once");
  assert.ok(Math.abs(swing[39]!) < 0.05, "settled after about a second");
  assert.equal(followThrough(13.5, 10), followThrough(13.5, 10));
});

test("timeRemap is continuous, never runs backwards and matches each constant speed exactly", () => {
  const segments = [
    { at: 10, speed: 0.25, ramp: 8 },
    { at: 30, speed: 4, ramp: 6 },
    { at: 50, speed: 0.3, ramp: 10 },
  ];
  assert.equal(timeRemap(0, segments), 0);
  assert.equal(timeRemap(10, segments), 10, "real time before the first change");
  assert.ok(Math.abs(timeRemap(28, segments) - timeRemap(20, segments) - 2) < 1e-9, "0.25 speed between ramps");
  assert.ok(Math.abs(timeRemap(48, segments) - timeRemap(40, segments) - 32) < 1e-9, "4x speed between ramps");
  let previous = -Infinity;
  for (let frame = 0; frame <= 90; frame += 0.25) {
    const value = timeRemap(frame, segments);
    assert.ok(value >= previous - 1e-9, `monotonic at ${frame}`);
    previous = value;
  }
  for (const boundary of [10, 18, 30, 36, 50, 60]) {
    const jump = Math.abs(timeRemap(boundary + 1e-4, segments) - timeRemap(boundary - 1e-4, segments));
    assert.ok(jump < 1e-2, `continuous at ${boundary}: ${jump}`);
  }
  const step = timeRemap(33.001, segments) - timeRemap(33, segments);
  assert.ok(Math.abs(step / 0.001 - speedAt(33, segments)) < 0.05, "derivative is the speed");
  assert.equal(timeRemap(41.3, segments), timeRemap(41.3, segments));
  assert.throws(() => timeRemap(5, [{ at: 0, speed: -1 }]), /0 or more/);
  assert.throws(() => timeRemap(5, [{ at: 0, speed: 2, curve: "overshoot" }]), /inside 0..1/);
  assert.throws(
    () =>
      timeRemap(5, [
        { at: 0, speed: 2, ramp: 10 },
        { at: 4, speed: 1 },
      ]),
    /before the previous ramp ends/,
  );
});

test("curves start at 0 and end at 1; overshoot and anticipation leave the range on the right side", () => {
  for (const [name, curve] of Object.entries(curves)) {
    assert.ok(Math.abs(curve(0)) < 1e-6, name);
    assert.ok(Math.abs(curve(1) - 1) < 1e-6, name);
  }
  assert.ok(Math.max(...Array.from({ length: 99 }, (_, i) => curves.overshoot((i + 1) / 100))) > 1);
  assert.ok(Math.min(...Array.from({ length: 99 }, (_, i) => curves.anticipation((i + 1) / 100))) < 0);
});

test("track holds outside its keys and applies each segment's own curve", () => {
  const keys = [
    { at: 10, value: 0 },
    { at: 20, value: 100 },
    { at: 30, value: 50, curve: "expoOut" as const },
  ];
  assert.equal(track(0, keys), 0);
  assert.equal(track(15, keys), 50);
  assert.equal(track(20, keys), 100);
  assert.equal(track(99, keys), 50);
  assert.ok(track(25, keys) < 75, "expo out covers most of the segment by its midpoint");
  assert.throws(
    () =>
      track(0, [
        { at: 5, value: 0 },
        { at: 5, value: 1 },
      ]),
    /ascend/,
  );
});

test("track is pure across fractional frames and repeated calls", () => {
  const keys = [
    { at: 0, value: 0 },
    { at: 10, value: 10, curve: "inOut" as const },
  ];
  assert.equal(track(3.25, keys), track(3.25, keys));
  assert.ok(track(3.25, keys) < track(3.5, keys));
});

test("trackPoint and velocity follow the same keys", () => {
  const point = trackPoint(5, [
    { at: 0, x: 0, y: 10 },
    { at: 10, x: 100, y: 30 },
  ]);
  assert.deepEqual(point, { x: 50, y: 20 });
  assert.equal(
    velocity((f) => f * 3, 4),
    3,
  );
});

test("motionSigma follows speed in either direction and stops at its limit", () => {
  assert.equal(motionSigma(0), 0);
  assert.equal(motionSigma(100), motionSigma(-100));
  assert.ok(Math.abs(motionSigma(100) - 15) < 1e-9);
  assert.ok(Math.abs(motionSigma(100, 0.3) - 30) < 1e-9);
  assert.equal(motionSigma(10000, 0.15, 60), 60);
});

test("progress clamps and handles an instant window", () => {
  assert.equal(progress(-1, 0, 10), 0);
  assert.equal(progress(11, 0, 10), 1);
  assert.equal(progress(0, 0, 0), 1);
});

test("stagger radial: outward rings from the box centre, ties together, ring buckets, inward, onSteps", () => {
  const grid = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ x, y })));
  assert.deepEqual(stagger(9, { kind: "radial", step: 2, points: grid }), [4, 2, 4, 2, 0, 2, 4, 2, 4]);
  assert.deepEqual(stagger(9, { kind: "radial", step: 2, points: grid, inward: true }), [0, 2, 0, 2, 4, 2, 0, 2, 0]);
  assert.deepEqual(stagger(9, { kind: "radial", step: 3, points: grid, ring: 2 }), [0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(
    stagger(3, {
      kind: "radial",
      step: 1,
      points: [
        { x: 5, y: 0 },
        { x: 1, y: 0 },
        { x: 3, y: 0 },
      ],
      origin: { x: 0, y: 0 },
    }),
    [2, 0, 1],
  );
  assert.deepEqual(radialOrder(grid), [4, 1, 3, 5, 7, 0, 2, 6, 8]);
  assert.throws(() => stagger(2, { kind: "radial", step: 1, points: grid }));
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((f) => onSteps(f, 2)),
    [0, 0, 2, 2, 4, 4],
  );
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((f) => onSteps(f, 3, 1)),
    [-2, 1, 1, 1, 4],
  );
  assert.equal(onSteps(7, 1), 7);
});

test("stagger maps: index, centre, edges and a stable seeded permutation", () => {
  assert.deepEqual(stagger(4, { kind: "index", step: 2 }), [0, 2, 4, 6]);
  assert.deepEqual(stagger(5, { kind: "centre", step: 3 }), [6, 3, 0, 3, 6]);
  assert.deepEqual(stagger(5, { kind: "edges", step: 3 }), [0, 3, 6, 3, 0]);
  const seeded = stagger(8, { kind: "seeded", seed: "a", step: 2 });
  assert.deepEqual(seeded, stagger(8, { kind: "seeded", seed: "a", step: 2 }));
  assert.deepEqual(
    [...seeded].sort((a, b) => a - b),
    [0, 2, 4, 6, 8, 10, 12, 14],
  );
  assert.notDeepEqual(seeded, stagger(8, { kind: "seeded", seed: "b", step: 2 }));
});

test("beat cues are frame accurate and rounding does not accumulate", () => {
  const cues = beatCues(30, [
    { id: "a", at: 0 },
    { id: "b", at: 0.51 },
    { id: "c", at: 1.02, until: 2 },
  ]);
  assert.deepEqual(
    cues.map(({ from, to }) => [from, to]),
    [
      [0, 15],
      [15, 31],
      [31, 60],
    ],
  );
  const grid = beatGrid(30, 140, 141);
  assert.equal(grid[140]!.from, Math.round((140 * 60 * 30) / 140));
  assert.equal(grid.at(-1)!.to, Math.round((141 * 60 * 30) / 140));
  for (let i = 1; i < grid.length; i++) assert.equal(grid[i]!.from, grid[i - 1]!.to);
  assert.equal(activeCue(cues, 15)!.id, "b");
  assert.equal(activeCue(cues, 60), undefined);
  assert.equal(cuePulse(cues[1]!, 14), 0);
  assert.equal(cuePulse(cues[1]!, 15), 1);
  assert.equal(cuePulse(cues[1]!, 40), 0);
  assert.throws(() => beatCues(30, [{ id: "a", at: 1, until: 1 }]), /ends before/);
});

test("grapheme splitting keeps Cyrillic and combining characters whole", () => {
  assert.deepEqual(splitGraphemes("ЙЁу"), ["Й", "Ё", "у"]);
  assert.deepEqual(splitGraphemes("йё"), ["й", "ё"]);
  assert.equal(splitGraphemes("👩‍💻a").length, 2);
});

test("word splitting keeps punctuation attached and respects non-breaking spaces", () => {
  assert.deepEqual(splitWords("Кадр — это, функция!"), ["Кадр", "—", "это,", "функция!"]);
  assert.deepEqual(splitWords("  а не   около "), ["а не", "около"]);
  assert.deepEqual(splitWords("кто-то"), ["кто-то"]);
  assert.deepEqual(splitLines("Раз\r\n Два "), ["Раз", "Два"]);
});

test("line sets are hand-set per format with a fallback", () => {
  const set = { vertical: ["a", "b"], fallback: ["a b"] };
  assert.equal(formatOf(1080, 1920), "vertical");
  assert.equal(formatOf(1080, 1080), "square");
  assert.equal(formatOf(1920, 1080), "landscape");
  assert.deepEqual(linesFor(set, "vertical"), ["a", "b"]);
  assert.deepEqual(linesFor(set, "landscape"), ["a b"]);
});

test("a masked line travels clear of its mask at any line-height", () => {
  for (const lineHeight of [0.8, 0.92, 1.1])
    assert.ok(maskTravelEm(lineHeight) >= lineHeight + DEFAULT_MASK_BLEED.top + DEFAULT_MASK_BLEED.bottom);
});

test("the weight wave peaks at its position and rests outside its spread", () => {
  assert.equal(glyphWeight(3, 3, 2, 100, 900), 900);
  assert.equal(glyphWeight(0, 3, 2, 100, 900), 100);
  assert.ok(glyphWeight(2, 3, 2, 100, 900) > 100);
});

test("series layout matches TransitionSeries: transitions overlap, cuts simply add", () => {
  const layout = layoutSeries([
    { id: "a", frames: 60 },
    { transition: 15 },
    { id: "b", frames: 60 },
    { id: "c", frames: 30 },
  ]);
  assert.equal(layout.totalFrames, 135);
  assert.deepEqual(
    layout.scenes.map(({ from, to }) => [from, to]),
    [
      [0, 60],
      [45, 105],
      [105, 135],
    ],
  );
  assert.deepEqual(layout.transitions, [{ from: 45, to: 60, frames: 15 }]);
  assert.throws(() => layoutSeries([{ transition: 5 }, { id: "a", frames: 10 }]), /between two scenes/);
  assert.throws(() => layoutSeries([{ id: "a", frames: 10 }, { transition: 11 }, { id: "b", frames: 30 }]), /longer/);
});

test("camera projection gives parallax by depth and defocus away from the focus plane", () => {
  const pose = { ...STILL_POSE, x: 100, focus: 0 };
  const lens = { focal: 1000, aperture: 0.01, rackScale: 0 };
  const near = projectLayer(pose, -500, lens);
  const focal = projectLayer(pose, 0, lens);
  const far = projectLayer(pose, 1000, lens);
  assert.equal(focal.x, -100);
  assert.ok(Math.abs(near.x) > Math.abs(focal.x) && Math.abs(focal.x) > Math.abs(far.x));
  assert.equal(focal.blur, 0);
  assert.equal(far.blur, 10);
  assert.ok(projectLayer({ ...STILL_POSE, dolly: 200 }, 0, lens).scale > 1);
});

test("shake is seeded, bounded and pure", () => {
  const options = { seed: "s", amplitude: 5, rollAmplitude: 1 };
  assert.deepEqual(shake(12.5, options), shake(12.5, options));
  assert.notDeepEqual(shake(12.5, options), shake(12.5, { ...options, seed: "t" }));
  for (let f = 0; f < 200; f++) assert.ok(Math.abs(shake(f, options).x) <= 5);
});

test("region camera frames its region exactly at the keys", () => {
  const stage = { width: 1000, height: 500 };
  const keys = [
    { at: 0, x: 0, y: 0, width: 1000 },
    { at: 10, x: 600, y: 300, width: 200, curve: "inOut" as const },
  ];
  const start = regionTransform(0, keys, stage);
  assert.ok(Math.abs(start.scale - 1) < 1e-9 && Math.abs(start.x) < 1e-9 && Math.abs(start.y) < 1e-9);
  const end = regionTransform(10, keys, stage);
  assert.ok(Math.abs(end.scale - 5) < 1e-9);
  assert.ok(Math.abs(end.x + 3000) < 1e-9);
  assert.ok(Math.abs(end.y + 1500) < 1e-9);
});

const sheet = {
  cues: [
    {
      id: "open",
      kind: "cut" as const,
      intentSec: 0.1,
      snap: "downbeat" as const,
      snappedSec: 0.1,
      frame: 3,
      deltaSec: 0,
    },
    { id: "turn", kind: "cut" as const, intentSec: 2, snap: "none" as const, snappedSec: 2, frame: 60, deltaSec: 0 },
  ],
};

test("cueFrame reads a cue sheet and refuses an id it does not have", () => {
  assert.equal(cueFrame(sheet, "turn"), 60);
  assert.deepEqual(cueFrames(sheet), { open: 3, turn: 60 });
  assert.throws(() => cueFrame(sheet, "gone"), /gone/);
});

test("cueFrames takes a cue sheet imported as JSON, its literals widened (schemaVersion: number, kind: string)", () => {
  // The type a `import sheet from "./cue-sheet.json"` gets: no literal survives. This must typecheck.
  const imported: {
    schemaVersion: number;
    fps: number;
    cues: { id: string; kind: string; snap: string; frame: number }[];
  } = JSON.parse(
    JSON.stringify({ schemaVersion: 1, fps: 30, cues: [{ id: "drop", kind: "cut", snap: "downbeat", frame: 90 }] }),
  );
  assert.deepEqual(cueFrames(imported), { drop: 90 });
  assert.equal(cueFrame(imported, "drop"), 90);
});

test("audioPulse peaks on the event's frame, decays, filters and honours the music offset", () => {
  const events = [
    { timeSec: 1, kind: "kick" as const, strength: 0.8 },
    { timeSec: 1.5, kind: "hat" as const, strength: 0.3 },
  ];
  assert.equal(audioPulse(29, 30, events), 0);
  assert.equal(audioPulse(30, 30, events), 0.8);
  assert.ok(audioPulse(32, 30, events) < 0.8 && audioPulse(32, 30, events) > 0);
  assert.equal(audioPulse(37, 30, events), 0, "gone after its frames");
  assert.equal(audioPulse(45, 30, events, { kinds: ["kick"] }), 0);
  assert.equal(audioPulse(45, 30, events, { minStrength: 0.5 }), 0);
  assert.equal(audioPulse(45, 30, events), 0.3);
  assert.equal(audioPulse(15, 30, events, { offsetSec: 0.5 }), 0.8, "film frame 15 plays the track at 1 s");
  assert.equal(audioPulse(30, 30, events), audioPulse(30, 30, events), "pure");
});

test("energyAt interpolates the curve, holds its ends and honours the music offset", () => {
  const curve = [
    { timeSec: 0, rms: 0, low: 1, high: 0.5 },
    { timeSec: 1, rms: 1, low: 0, high: 0.5 },
  ];
  assert.equal(energyAt(15, 30, curve), 0.5);
  assert.equal(energyAt(15, 30, curve, { band: "low" }), 0.5);
  assert.equal(energyAt(0, 30, curve, { offsetSec: 0.25 }), 0.25);
  assert.equal(energyAt(300, 30, curve), 1);
  assert.equal(energyAt(0, 30, []), 0);
});

// --- Kinetic vocabulary ---

test("smear is untouched at rest and grows with speed in either direction", () => {
  assert.deepEqual(smearAt(0), { blur: 0, stretch: 1, rowShift: 0, rowCut: 0, chroma: 0 });
  assert.equal(smearAt(0.5).blur, 0);
  assert.deepEqual(smearAt(80), smearAt(-80));
  assert.ok(smearAt(200).blur > smearAt(40).blur);
  assert.equal(smearAt(100000).blur, 110);
  assert.equal(smearAt(100000).rowCut, 0.72);
  assert.equal(smearAt(100000).stretch, 1.9);
});

test("a slam is hidden before its cue, grows with the measured curve and keeps creeping", () => {
  const motion = { at: 10, creep: 0 };
  assert.equal(wordPose(9, motion).visible, false);
  assert.ok(Math.abs(wordPose(10, motion).scale - 0.36) < 1e-9);
  const third = wordPose(13, motion).scale;
  assert.ok(third > 0.75 && third < 0.87, `three frames in: ${third}`);
  assert.ok(wordPose(60, { at: 10, creep: 0.04 }).scale > wordPose(40, { at: 10, creep: 0.04 }).scale);
  assert.ok(wordPose(10, { at: 10, enter: "lens" }).scale > 3);
  assert.equal(wordPose(10, { at: 10, enter: "cut", creep: 0 }).scale, 1);
});

test("a word's exit accelerates, keeps its speed to the last frame and then is gone", () => {
  const motion = { at: 0, exitAt: 20, exit: "left" as const, exitFrames: 5, creep: 0 };
  const speeds = [20, 21, 22, 23, 24].map((frame) => Math.abs(wordSpeed(frame, motion, 400).vx));
  for (let i = 1; i < speeds.length - 1; i++) assert.ok(speeds[i]! > speeds[i - 1]!, String(speeds));
  assert.ok(speeds.at(-1)! > 0);
  assert.equal(wordPose(25, motion).visible, false);
  const through = { at: 0, exitAt: 20, exit: "through" as const, creep: 0 };
  assert.ok(wordPose(23, through).scale > 3);
  assert.equal(wordPose(24, through).visible, false);
});

test("hits decay from one to nothing and shake dies with them", () => {
  assert.equal(hitDecay(9, 10), 0);
  assert.equal(hitDecay(10, 10), 1);
  assert.equal(hitDecay(16, 10), 0);
  assert.equal(hitsDecay(21, [10, 20]), hitDecay(21, 20));
  assert.deepEqual(hitShake(11, 10, { seed: "a" }), hitShake(11, 10, { seed: "a" }));
  assert.equal(Math.abs(hitShake(30, 10, { seed: "a" }).x), 0);
  assert.notEqual(hitShake(11, 10, { seed: "a" }).x, 0);
});

test("glyphs arrive in order, end at rest and keep a set tilt only if asked", () => {
  const options = { at: 0, step: 2, frames: 7, seed: "w" };
  assert.equal(glyphRiseAt(1, 1, options).visible, false);
  assert.equal(glyphRiseAt(2, 1, options).visible, true);
  const rest = glyphRiseAt(100, 2, options);
  assert.equal(rest.y, 0);
  assert.equal(rest.rotateX, 0);
  assert.equal(rest.scaleAlong, 1);
  assert.equal(rest.opacity, 1);
  assert.ok(glyphRiseAt(5, 2, options).scaleAlong > 1, "stretched in flight");
  assert.notEqual(glyphRiseAt(100, 2, { ...options, restTilt: 8 }).rotateZ, 0);
});

test("the dolly rests on each word at its cue and the next word waits inside the current one", () => {
  const cues = [0, 40, 80];
  assert.ok(Math.abs(dollyPosition(0, cues, { creep: 0 })) < 1e-9);
  assert.ok(Math.abs(dollyPosition(40, cues, { creep: 0 }) - 1) < 1e-9);
  assert.ok(Math.abs(dollyPosition(80, cues, { creep: 0 }) - 2) < 1e-9);
  assert.ok(
    dollyPosition(60, cues, { travel: 11 }) > dollyPosition(50, cues, { travel: 11 }),
    "the camera creeps on a hold",
  );
  const here = dollyWord(1, 1);
  const behind = dollyWord(1, 2);
  const passed = dollyWord(2.2, 1);
  assert.equal(here.scale, 1);
  assert.equal(here.opacity, 1);
  assert.equal(here.blur, 0);
  assert.ok(behind.visible && behind.scale < 0.3);
  assert.equal(passed.visible, false);
});

test("elastic axes overshoot the target, then land on it, and hold what a key omits", () => {
  const keys = [
    { at: 10, wdth: 150, wght: 900 },
    { at: 200, wght: 300 },
  ];
  assert.equal(elasticAxes(0, keys).wdth, 100);
  const path = Array.from({ length: 40 }, (_, i) => elasticAxes(10 + i, [{ at: 10, wdth: 130 }]).wdth);
  assert.ok(Math.max(...path) > 130, "goes past the target");
  assert.ok(Math.abs(elasticAxes(120, keys).wdth - 150) < 1e-3);
  assert.ok(Math.abs(elasticAxes(330, keys).wght - 300) < 1);
  assert.ok(Math.abs(elasticAxes(330, keys).wdth - 150) < 1e-3);
});

test("a scramble repeats for a seed, touches only its window and resolves to the target", () => {
  const word = splitGraphemes("ЙОД ЁЖ");
  const options = { at: 10, duration: 15, seed: "s" };
  assert.deepEqual(scrambleGlyphs(word, 9, options), word);
  assert.deepEqual(scrambleGlyphs(word, 25, options), word);
  assert.deepEqual(scrambleGlyphs(word, 18, options), scrambleGlyphs(word, 18, options));
  assert.notDeepEqual(scrambleGlyphs(word, 18, options), word);
  assert.equal(scrambleGlyphs(word, 18, options)[3], " ");
  assert.equal(scrambleGlyphs(word, 10, options).at(-1), "Ж", "spreads from the first glyph");
  assert.equal(scrambleChroma(10, 10), 0);
  assert.ok(scrambleChroma(17, 10) > 4);
});

test("the caption's tag leaves one word as it reaches the next", () => {
  const words = [
    { text: "а", at: 0 },
    { text: "б", at: 10 },
    { text: "в", at: 20 },
  ];
  const at = captionWords(11, words);
  assert.ok(at[0]!.tagFrom > 0 && at[0]!.tagFrom < 1);
  assert.ok(at[1]!.tagTo > 0 && at[1]!.tagTo < 1);
  assert.equal(at[2]!.visible, false);
  const later = captionWords(30, words);
  assert.equal(later[0]!.tagFrom, 1);
  assert.equal(later[2]!.tagTo, 1);
  assert.equal(later[2]!.tagFrom, 0);
});

test("typing is uneven, repeats for a seed and counts up to the whole text", () => {
  const schedule = typingSchedule("Съёмка идёт быстрее", { at: 5, seed: "t" });
  assert.deepEqual(schedule, typingSchedule("Съёмка идёт быстрее", { at: 5, seed: "t" }));
  assert.equal(schedule[0], 5);
  assert.ok(new Set(schedule.slice(1).map((value, i) => value - schedule[i]!)).size > 1);
  assert.equal(typedCount(4, schedule), 0);
  assert.equal(typedCount(schedule.at(-1)!, schedule), schedule.length);
});

test("a layout morph hits both end layouts exactly", () => {
  const keys = [
    { at: 0, x: 10, y: 20, width: 300, height: 4, radius: 2 },
    { at: 12, x: 100, y: 50, width: 800, height: 500, radius: 24 },
  ];
  assert.deepEqual(morphRect(0, keys), { x: 10, y: 20, width: 300, height: 4, radius: 2 });
  assert.deepEqual(morphRect(12, keys), { x: 100, y: 50, width: 800, height: 500, radius: 24 });
  assert.deepEqual(morphRect(99, keys), morphRect(12, keys));
});

test("an element that grows to the next scene ends as exactly the stage", () => {
  const from = { x: 700, y: 800, width: 400, height: 100, radius: 20 };
  const stage = { width: 1920, height: 1080 };
  const start = growRect(10, from, stage, { at: 10, frames: 15 });
  assert.equal(start.width, 400);
  assert.equal(start.label, 1);
  const end = growRect(25, from, stage, { at: 10, frames: 15 });
  assert.deepEqual([end.x, end.y, end.width, end.height, end.radius, end.flat], [0, 0, 1920, 1080, 0, 1]);
  assert.equal(end.label, 0);
  const swell = growRect(16, from, stage, { at: 10, frames: 15 });
  assert.ok(swell.width > 400 && swell.width < 700, "swells before it surges");
});

test("collage cells tile the stage exactly at every frame", () => {
  const stage = { width: 1920, height: 1080 };
  const steps = [
    { at: 0, cell: "root", dir: "x" as const, ratio: 0.5, into: ["a", "b"] as const },
    { at: 10, cell: "b", dir: "y" as const, ratio: 0.4, into: ["b1", "b2"] as const },
    { at: 20, cell: "a", dir: "y" as const, ratio: 0.6, into: ["a1", "a2"] as const },
    { at: 34, cell: "root", ratio: 0.72 },
    { at: 50, cell: "root", ratio: 1 },
  ];
  for (const frame of [-1, 0, 3, 10, 14, 26, 38, 49, 56, 80]) {
    const cells = collageCells(frame, steps, stage);
    const area = cells.reduce((sum, cell) => sum + cell.width * cell.height, 0);
    assert.ok(Math.abs(area - stage.width * stage.height) < 1e-3, `frame ${frame}`);
    for (const a of cells)
      for (const b of cells) {
        if (a === b) continue;
        const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
        const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
        assert.ok(overlapX <= 1e-6 || overlapY <= 1e-6, `${a.id} over ${b.id} at ${frame}`);
      }
  }
  assert.deepEqual(
    collageCells(-1, steps, stage).map((cell) => cell.id),
    ["root"],
  );
  const taken = collageCells(100, steps, stage).find((cell) => cell.id === "a1")!;
  assert.equal(taken.width, stage.width);
});

test("an odometer rests on whole digits and rolls its next column only on the carry", () => {
  assert.deepEqual(odometerReels(3108, 4), [3, 31, 310, 3108]);
  const reels = odometerReels(199.5, 3);
  assert.equal(reels[2], 199.5);
  assert.equal(reels[1], 19.5);
  assert.equal(reels[0], 1.5);
  assert.equal(odometerReels(150.5, 3)[1], 15);
  assert.equal(raceValue(0, { at: 10, to: 100 }), 0);
  assert.equal(raceValue(40, { at: 10, frames: 30, to: 100 }), 100);
});

test("radial lines answer energy, repeat for a seed and respect a clear pocket", () => {
  const base = { cx: 960, cy: 540, reach: 1300, seed: "r", count: 200 };
  assert.ok(radialLines(10, { ...base, energy: 1 }).length > radialLines(10, { ...base, energy: 0 }).length * 3);
  assert.deepEqual(radialLines(10, { ...base, energy: 0.5 }), radialLines(10, { ...base, energy: 0.5 }));
  assert.notDeepEqual(radialLines(10, { ...base, energy: 0.5 }), radialLines(11, { ...base, energy: 0.5 }));
  for (const line of radialLines(10, { ...base, energy: 1, clear: 0.3 }))
    assert.ok(Math.hypot(line.x1 - 960, line.y1 - 540) >= 0.3 * 1300 - 1e-6);
});

test("a shock ring exists only after its hit and grows until it is gone", () => {
  assert.equal(shockRingAt(9, 10).visible, false);
  assert.equal(shockRingAt(24, 10).visible, false);
  assert.ok(shockRingAt(16, 10).radius > shockRingAt(12, 10).radius);
  assert.ok(shockRingAt(16, 10).opacity < shockRingAt(12, 10).opacity);
});

test("lights wander smoothly and grow with energy", () => {
  const [a] = lightBlobs(100, { energy: 0.2 });
  const [b] = lightBlobs(101, { energy: 0.2 });
  const [hot] = lightBlobs(100, { energy: 1 });
  assert.ok(Math.abs(a!.x - b!.x) < 0.02 && a!.x !== b!.x);
  assert.ok(hot!.radius > a!.radius && hot!.strength > a!.strength);
});
