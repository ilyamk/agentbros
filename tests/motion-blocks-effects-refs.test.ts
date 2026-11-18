import test from "node:test";
import assert from "node:assert/strict";
import {
  AIRFORM_ENTER,
  AIRFORM_EXIT,
  AIRFORM_MONTAGE_HOLDS,
  DOUBLING_DEFAULT_HOLDS,
  FLEX_MONTAGE_HOLDS,
  GOJIBERRY_HOLDS,
  GRADE_STEP_PREVIEW,
  MAX_CHANGES_PER_SECOND,
  accelerandoHolds,
  cadenceStarts,
  doublingLands,
  doublingReels,
  doublingValue,
  gradeAt,
  gradeChanges,
  gradeSchedule,
  halftoneDotRadius,
  halftoneScreen,
  maxChangesPerWindow,
  montageHolds,
  orbitPoints,
  plateAt,
  safeHolds,
  sliceOffsets,
} from "../src/motion/library/effects/flash-plan";
import { FLASH_GRID, FlashTracker } from "../src/lib/sensors/flash";

// The blocks' defaults, restated here so this suite needs no browser components (the preview files import media).
const GRADE_DEFAULT = { exitAt: 45, exit: AIRFORM_EXIT, enterAt: 45, enter: AIRFORM_ENTER };

/** Worst case for the flash sensor: every change flips the whole frame between black and white. */
const worstCaseReport = (changes: readonly number[], frames: number) => {
  const tracker = new FlashTracker();
  const set = new Set(changes);
  let light = false;
  for (let frame = 0; frame < frames; frame++) {
    if (set.has(frame)) light = !light;
    const value = light ? 1 : 0;
    tracker.push(new Float32Array(FLASH_GRID * FLASH_GRID * 3).fill(value));
  }
  return tracker.report(30);
};

test("grade schedule: airform exit is mono 3, negative 2, duotone 2 ending on the cut; enter is 1 negative frame", () => {
  const spans = gradeSchedule(GRADE_DEFAULT);
  assert.deepEqual(
    spans.map((s) => [s.grade, s.from, s.to, s.side]),
    [
      ["mono", 38, 41, "exit"],
      ["negative", 41, 43, "exit"],
      ["duotone", 43, 45, "exit"],
      ["negative", 45, 46, "enter"],
    ],
  );
  assert.equal(gradeAt(spans, 37), undefined);
  assert.equal(gradeAt(spans, 44)?.fringe, true);
  assert.equal(gradeAt(spans, 46), undefined);
  assert.deepEqual(gradeChanges(spans, 45), [38, 41, 43, 45, 46]);
});

test("grade schedule clamps an exit that starts before frame 0 and skips a side below 0", () => {
  const spans = gradeSchedule({ exitAt: 4, exit: AIRFORM_EXIT, enterAt: -1, enter: AIRFORM_ENTER });
  assert.equal(spans[0]!.from, 0);
  assert.ok(spans.every((s) => s.side === "exit"));
});

test("flash safety: the grade-step default event stays within six changes a second, even if every change flips black to white", () => {
  const changes = gradeChanges(gradeSchedule(GRADE_DEFAULT), 45);
  assert.ok(maxChangesPerWindow(changes) <= MAX_CHANGES_PER_SECOND);
  assert.equal(worstCaseReport(changes, 90).ranges.length, 0);
});

test("flash safety: the shipped preview (exit event, then the sliced entrance's flip and cut) keeps its whole-frame changes within budget", () => {
  const { exitAt, sliceAt, sliceFlipFrames } = GRADE_STEP_PREVIEW;
  const exit = gradeChanges(
    gradeSchedule({ exitAt, exit: AIRFORM_EXIT, enterAt: exitAt, enter: AIRFORM_ENTER }),
    exitAt,
  );
  // The slice adds its cut, the flip and the flip's end; its band steps move parts of the frame one way only (chaos 0),
  // which the worst-case model cannot express, so their safety rests on the rendered motion:check.
  const changes = [...exit, sliceAt, sliceAt + sliceFlipFrames];
  assert.ok(sliceAt - (exitAt + 1) >= 30, "one event a second");
  assert.ok(maxChangesPerWindow(changes) <= MAX_CHANGES_PER_SECOND);
  assert.equal(worstCaseReport(changes, 132).ranges.length, 0);
});

test("flash safety: the sensor fails seven full-frame flips in a second, so the worst-case model has teeth", () => {
  const changes = [10, 13, 16, 19, 22, 25, 28];
  assert.equal(maxChangesPerWindow(changes), 7);
  assert.ok(worstCaseReport(changes, 60).ranges.length > 0);
});

test("slice offsets: deterministic, resolve to 0, and with chaos 0 each band only shrinks on its own side", () => {
  const slice = { at: 10, frames: 11, bands: 9, offset: 0.2, seed: "s", hold: 2, chaos: 0 };
  assert.deepEqual(sliceOffsets(12, slice), sliceOffsets(12, slice));
  assert.ok(sliceOffsets(9, slice).every((o) => o === 0));
  assert.ok(sliceOffsets(21, slice).every((o) => o === 0));
  for (let band = 0; band < 9; band++) {
    let last = Infinity;
    for (let frame = 10; frame < 21; frame++) {
      const o = Math.abs(sliceOffsets(frame, slice)[band]!);
      assert.ok(o <= last + 1e-9, `band ${band} grows at ${frame}`);
      assert.ok(o <= 0.2);
      last = o;
    }
  }
  assert.ok(sliceOffsets(10, slice).some((o) => o !== 0));
});

test("montage cadence: flex default is 4/4/4/3/4 after the lead and already flash-safe", () => {
  assert.deepEqual(FLEX_MONTAGE_HOLDS.slice(1, 6), [4, 4, 4, 3, 4]);
  assert.deepEqual(safeHolds(FLEX_MONTAGE_HOLDS), FLEX_MONTAGE_HOLDS);
  const starts = cadenceStarts(FLEX_MONTAGE_HOLDS);
  assert.deepEqual(starts, [0, 18, 22, 26, 30, 33, 37]);
  assert.equal(plateAt(starts, 25), 2);
  assert.equal(plateAt(starts, -1), -1);
  assert.equal(worstCaseReport(starts, 74).ranges.length, 0);
});

test("montage cadence: airform's ten 4-frame plates exceed the budget raw and are stretched minimally when safe", () => {
  assert.ok(maxChangesPerWindow(cadenceStarts(AIRFORM_MONTAGE_HOLDS)) > MAX_CHANGES_PER_SECOND);
  const safe = montageHolds(AIRFORM_MONTAGE_HOLDS, { flashSafe: true });
  const starts = cadenceStarts(safe);
  assert.ok(maxChangesPerWindow(starts) <= MAX_CHANGES_PER_SECOND);
  assert.equal(worstCaseReport(starts, starts.at(-1)! + 10).ranges.length, 0);
  // The first plates keep the measured cadence; nothing is shortened.
  assert.deepEqual(safe.slice(0, 5), AIRFORM_MONTAGE_HOLDS.slice(0, 5));
  safe.forEach((hold, i) => assert.ok(hold >= AIRFORM_MONTAGE_HOLDS[i]!));
  assert.deepEqual(montageHolds(AIRFORM_MONTAGE_HOLDS, { flashSafe: false }), AIRFORM_MONTAGE_HOLDS);
});

test("doubling montage: default keeps gojiberry's first twelve holds exactly and is flash-safe", () => {
  const safe = montageHolds(DOUBLING_DEFAULT_HOLDS, { flashSafe: true });
  assert.deepEqual(safe.slice(0, 12), GOJIBERRY_HOLDS.slice(0, 12));
  assert.ok(maxChangesPerWindow(cadenceStarts(safe)) <= MAX_CHANGES_PER_SECOND);
  assert.ok(maxChangesPerWindow(cadenceStarts(GOJIBERRY_HOLDS)) > MAX_CHANGES_PER_SECOND);
});

test("accelerando holds shrink from first to floor", () => {
  const holds = accelerandoHolds(44, 2, 16);
  assert.equal(holds[0], 44);
  assert.equal(holds.at(-1), 2);
  for (let i = 1; i < holds.length; i++) assert.ok(holds[i]! <= holds[i - 1]!);
});

test("doubling counter: doubles per cut, rolls after the lead, reels never show the numbers in between", () => {
  const starts = [0, 44, 90];
  assert.equal(doublingValue(10, starts), 1);
  assert.equal(doublingValue(45, starts), 1);
  assert.equal(doublingValue(49, starts), 2);
  assert.equal(doublingValue(200, starts), 4);
  assert.deepEqual(doublingLands(starts), [49, 95]);
  const before = doublingReels(5, [0, 10, 20, 30, 40, 50, 60, 70], 3, { lead: 2, roll: 4 });
  assert.equal(before.shown, 1);
  const settled = doublingReels(80, [0, 10, 20, 30, 40, 50, 60, 70], 3, { lead: 2, roll: 4 });
  assert.equal(settled.shown, 128);
  assert.deepEqual(settled.reels, [1, 2, 8]);
  // Mid-roll 64 -> 128: the units reel turns forward from 4 to 8, the tens from 6 to 2 (through 0), no 80 or 96 shown.
  const mid = doublingReels(73, [0, 10, 20, 30, 40, 50, 60, 70], 3, { lead: 2, roll: 4 });
  assert.equal(mid.reels[2], 4 + 4 * 0.5);
  assert.equal(mid.reels[1], 6 + 6 * 0.5);
});

test("halftone screen: cell scales with the frame, push crawls and wraps, dot area follows darkness", () => {
  const still = halftoneScreen(10, { dotSize: 12, angle: 45, push: 0, unit: 1 });
  assert.deepEqual([still.x, still.y], [0, 0]);
  const moving = halftoneScreen(5, { dotSize: 12, angle: 0, push: 1, unit: 2 });
  assert.equal(moving.cell, 24);
  assert.equal(moving.x, 10);
  assert.ok(halftoneScreen(100, { dotSize: 12, angle: 0, push: 1, unit: 1 }).x < 12);
  assert.equal(halftoneDotRadius(0, 10), 0);
  assert.ok(Math.abs(halftoneDotRadius(1, 10) - Math.SQRT2 * 5) < 1e-9);
  assert.ok(halftoneDotRadius(0.5, 10) < halftoneDotRadius(0.8, 10));
});

test("orbit points: seeded, a back and a front half, perspective larger in front", () => {
  const options = { count: 24, rows: 2, radius: 300, rowGap: 0.1, tilt: 60, roll: 0, angle: 0, seed: "o", twinkle: 3 };
  const a = orbitPoints(7, options);
  assert.deepEqual(a, orbitPoints(7, options));
  assert.equal(a.length, 48);
  const front = a.filter((p) => p.z > 0);
  const back = a.filter((p) => p.z < 0);
  assert.ok(front.length > 0 && back.length > 0);
  assert.ok(Math.max(...front.map((p) => p.scale)) > 1 && Math.min(...back.map((p) => p.scale)) < 1);
  // Glow re-rolls every `twinkle` frames only.
  assert.deepEqual(
    orbitPoints(6, options).map((p) => p.glow),
    orbitPoints(8, options).map((p) => p.glow),
  );
});
