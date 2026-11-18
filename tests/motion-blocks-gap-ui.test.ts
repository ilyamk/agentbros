import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_GAPS,
  FANOUT_FROM,
  ISOLATE_FRAMES,
  JUMP_SCALE,
  OUTLINE_FRAMES,
  PILL_FILL,
  PILL_STRETCH,
  PILL_WIPE,
  buildFrames,
  checkSchedule,
  chipWallLayout,
  clockSweep,
  coordinateLabel,
  dimensionLabel,
  fanoutPose,
  gridCells,
  growRectFrom,
  holdJitter,
  isolateOpacity,
  jumpFontSize,
  pillState,
  pillTiming,
  pushProgress,
  PUSH_HALF_LIFE,
  PUSH_RAMP,
  chipWallFirecrawlPush,
  readingRank,
  resolveDelays,
  resolveEndOf,
  resolvePlan,
  resolveState,
  sheenAt,
  statusSchedule,
  tickDraw,
  uiEase,
} from "../src/motion/library/ui/ui-plan";
import { chipWallSchema } from "../src/motion/library/ui/ChipWall";

// Pure helpers only: the block components import media and fonts, so they are exercised by the library preview and
// tests/motion-library.test.ts, not here.

const grid = (cols: number, rows: number) =>
  Array.from({ length: cols * rows }, (_, i) => ({
    x: (i % cols) / cols,
    y: Math.floor(i / cols) / rows,
    w: 1 / cols,
    h: 1 / rows,
  }));

test("placeholder-resolve: index order staggers by step and each region grows, holds and dissolves", () => {
  const regions = grid(3, 1);
  const plan = resolvePlan(regions, { start: 10, step: 6, grow: 12, hold: 2, dissolve: 6 });
  assert.deepEqual(plan[0], { at: 10, growEnd: 22, resolveAt: 24, resolveEnd: 30 });
  assert.deepEqual(
    plan.map((e) => e.at),
    [10, 16, 22],
  );
  assert.equal(resolveEndOf(plan), 42);
  const mid = resolveState(16, plan[0]!);
  assert.ok(mid.shown && mid.grow > 0 && mid.grow < 1 && mid.resolve === 0);
  assert.deepEqual(resolveState(9, plan[0]!), { shown: false, grow: 0, resolve: 0 });
  assert.deepEqual(resolveState(30, plan[0]!), { shown: true, grow: 1, resolve: 1 });
});

test("placeholder-resolve: radial order starts at the centre and moves out ring by ring (the white-tile wall)", () => {
  const regions = grid(5, 5);
  const delays = resolveDelays(regions, { step: 3, order: "radial" });
  assert.equal(delays[12], 0, "the centre tile goes first");
  assert.ok(delays[0]! > delays[6]!, "a corner after its inner neighbour");
  assert.equal(delays[7], delays[11], "tiles at the same distance start together");
  const ringed = resolveDelays(regions, { step: 3, order: "radial", ring: 0.25 });
  assert.ok(new Set(ringed).size < new Set(delays).size, "rings bucket distances");
});

test("placeholder-resolve: reading order is top to bottom, then left to right", () => {
  const regions = [
    { x: 0.6, y: 0.5, w: 0.3, h: 0.3 },
    { x: 0.1, y: 0.5, w: 0.3, h: 0.3 },
    { x: 0.6, y: 0.1, w: 0.3, h: 0.3 },
  ];
  assert.deepEqual(resolveDelays(regions, { step: 6, order: "reading" }), [12, 6, 0]);
});

test("placeholder-resolve: a region grows from its left-middle (or a given point) to its own rect", () => {
  const r = { x: 0.2, y: 0.4, w: 0.5, h: 0.2 };
  const zero = growRectFrom(r, 0);
  assert.deepEqual(zero, { x: 0.2, y: 0.5, w: 0, h: 0 });
  assert.deepEqual(growRectFrom(r, 1), r);
  const centre = growRectFrom(r, 0, { x: 0.45, y: 0.5 });
  assert.equal(centre.x, 0.45);
});

test("ui-check-list: rows 11 then 9 frames apart at 30 fps (9 and 7 at 24); the clock wipe is linear over the fill; the tick follows", () => {
  assert.deepEqual(checkSchedule(4, 20), [20, 31, 40, 49]);
  assert.deepEqual([...CHECK_GAPS], [11, 9]);
  assert.equal(clockSweep(19, 20, 4), 0);
  assert.equal(clockSweep(22, 20, 4), 180);
  assert.equal(clockSweep(30, 20, 4), 360);
  assert.equal(tickDraw(22, 20, 4), 0);
  assert.ok(tickDraw(24, 20, 4) > 0);
  assert.equal(tickDraw(40, 20, 4), 1);
});

test("ui-annotate: items build whole in reading order within the span, on whole frames", () => {
  const points = [
    { x: 0.6, y: 0.6 },
    { x: 0.2, y: 0.2 },
    { x: 0.7, y: 0.2 },
    { x: 0.1, y: 0.6 },
  ];
  assert.deepEqual(readingRank(points), [3, 0, 1, 2]);
  const frames = buildFrames(points, 10, 4);
  assert.deepEqual(frames, [13, 10, 11, 12]);
  assert.ok(frames.every((f) => Number.isInteger(f) && f >= 10 && f < 14));
  assert.deepEqual(buildFrames(points, 10, 0), [10, 10, 10, 10]);
  assert.equal(dimensionLabel(314.2, 210.6), "314×211");
  assert.equal(coordinateLabel(12.4, 8.6), "x: 12 y: 9");
});

test("ui-annotate: jitter is seeded, held for two frames and zero when off", () => {
  assert.deepEqual(holdJitter(10, "a", 2), holdJitter(11, "a", 2));
  assert.deepEqual(holdJitter(10, "a", 0), { x: 0, y: 0 });
  const j = holdJitter(10, "a", 2);
  assert.ok(Math.abs(j.x) <= 2 && Math.abs(j.y) <= 2);
});

test("ui-card-grid: cells tile the area; fanned cards start at 0.3 on the source and overshoot into their cell", () => {
  const area = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const cells = gridCells(6, 3, area, 0.02);
  assert.equal(cells.length, 6);
  assert.ok(Math.abs(cells[2]!.x + cells[2]!.w - 0.9) < 1e-9);
  assert.ok(Math.abs(cells[5]!.y + cells[5]!.h - 0.9) < 1e-9);
  const source = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
  const start = fanoutPose(20, 1, source, cells[1]!, { at: 16 });
  assert.ok(start.started);
  assert.ok(Math.abs(start.rect.w - cells[1]!.w * FANOUT_FROM) < 1e-9, "starts at 0.3 of its size");
  assert.ok(Math.abs(start.rect.x + start.rect.w / 2 - 0.5) < 1e-9, "centred on the source");
  assert.equal(fanoutPose(19, 1, source, cells[1]!, { at: 16 }).started, false, "card 1 waits one step of 4 f");
  const peak = Math.max(...Array.from({ length: 9 }, (_, k) => uiEase["back.out"]((k + 1) / 9)));
  assert.ok(peak > 1.05, "back.out passes the target");
  const end = fanoutPose(60, 1, source, cells[1]!, { at: 16 });
  for (const k of ["x", "y", "w", "h"] as const) assert.ok(Math.abs(end.rect[k] - cells[1]![k]) < 1e-9, k);
});

test("ui-card-grid: status chips follow cursor order; a card the cursor never visits gets none", () => {
  const frames = statusSchedule(4, 30, 15, [2, 0, 3]);
  assert.deepEqual(frames.slice(0, 3), [45, Number.POSITIVE_INFINITY, 30]);
  assert.equal(frames[3], 60);
  assert.equal(OUTLINE_FRAMES, 5);
});

test("chip-wall: the layout is seeded and only the picked chip carries labels[0]", () => {
  const labels = ["Picked", "A", "B", "C"];
  const a = chipWallLayout(labels, 6, 5, "s", 14);
  assert.deepEqual(a, chipWallLayout(labels, 6, 5, "s", 14));
  assert.notDeepEqual(
    a.map((c) => c.label),
    chipWallLayout(labels, 6, 5, "t", 14).map((c) => c.label),
  );
  assert.equal(a[14]!.label, "Picked");
  assert.equal(a.filter((c) => c.label === "Picked").length, 1);
});

test("chip-wall: the push ramps for 3 frames, then each 7.5 frames halves its speed (firecrawl's 5 and 15 at 60 fps), ending at 1", () => {
  const at = 10;
  const frames = 60;
  const speed = (f: number) => pushProgress(f + 1, at, frames) - pushProgress(f, at, frames);
  assert.equal(pushProgress(at, at, frames), 0);
  assert.ok(speed(at) < speed(at + 1) && speed(at + 1) < speed(at + 2), "ramps up over the first 3 frames");
  const ratio = speed(at + 18) / speed(at + 3);
  assert.ok(Math.abs(ratio - 0.25) < 0.03, `halves every 7.5 frames (${ratio})`);
  assert.equal(pushProgress(at + frames, at, frames), 1);
  assert.equal(pushProgress(at + frames + 30, at, frames), 1);
});

test("chip-wall firecrawl push: re-measured share of the push within 0.03 at every sample, later than the 3-frame ramp", () => {
  const { pushFrames, pushRamp, pushHalfLife } = chipWallFirecrawlPush;
  const measured: [number, number][] = [
    [2, 0.05],
    [4, 0.13],
    [6, 0.24],
    [8, 0.35],
    [10, 0.47],
    [12, 0.59],
    [14, 0.69],
    [16, 0.76],
    [18, 0.84],
    [20, 0.88],
    [22, 0.92],
    [24, 0.95],
    [28, 0.98],
  ];
  for (const [k, share] of measured)
    assert.ok(Math.abs(pushProgress(k, 0, pushFrames, pushRamp, pushHalfLife) - share) < 0.03, `${k} frames`);
  assert.ok(
    pushProgress(4, 0, 40) > pushProgress(4, 0, pushFrames, pushRamp, pushHalfLife) + 0.08,
    "the old ramp reads early",
  );
  assert.equal(chipWallSchema.shape.pushRamp.parse(pushRamp), 6);
  assert.equal(chipWallSchema.shape.pushHalfLife.parse(undefined), undefined, "optional: absent keeps 3 and 7.5");
  assert.deepEqual([PUSH_RAMP, PUSH_HALF_LIFE], [3, 7.5]);
});

test("chip-wall: every unpicked chip is gone by the end of the isolate, in a seeded order", () => {
  const at = 100;
  const ends = Array.from({ length: 30 }, (_, i) => isolateOpacity(at + ISOLATE_FRAMES, at, ISOLATE_FRAMES, "s", i));
  assert.ok(ends.every((o) => o === 0));
  const mid = Array.from({ length: 30 }, (_, i) => isolateOpacity(at + 20, at, ISOLATE_FRAMES, "s", i));
  assert.ok(new Set(mid.map((o) => o.toFixed(3))).size > 3, "chips fade at different times");
  assert.equal(isolateOpacity(at - 1, at, ISOLATE_FRAMES, "s", 3), 1);
});

test("ui-data-table: the row sheen crosses on power2.out and only inside its window", () => {
  assert.equal(sheenAt(9, 10, 20).visible, false);
  assert.equal(sheenAt(10, 10, 20).x, 0);
  assert.ok(sheenAt(15, 10, 20).x > 0.25 / 1 && sheenAt(15, 10, 20).x > 0.5 * 0.8, "front-loaded");
  assert.equal(sheenAt(30, 10, 20).visible, false);
});

test("ui-ai-chat: the pill fills 2 f, stretches 6 f, wipes 5 f and ends on the answer frame", () => {
  const t = pillTiming(100);
  assert.equal(t.wipeAt, 100 - PILL_WIPE);
  assert.equal(t.stretchAt, t.wipeAt - PILL_STRETCH);
  assert.equal(t.fillAt, t.stretchAt - PILL_FILL);
  const before = pillState(t.fillAt - 1, 100);
  assert.ok(before.shown && before.fill === 0 && before.stretch === 0);
  assert.equal(pillState(t.stretchAt, 100).fill, 1);
  assert.ok(pillState(t.stretchAt + 2, 100).stretch > 0.6, "power3.out is front-loaded");
  assert.equal(pillState(100, 100).wipe, 1);
});

test("ui-prompt-bar: the jump re-sets the text at 3.5x unless that would leave the frame", () => {
  assert.equal(JUMP_SCALE, 3.5);
  assert.equal(jumpFontSize(28, 10, 1700), 98);
  const long = jumpFontSize(28, 60, 1700);
  assert.ok(long < 98 && long * 60 * 0.52 <= 1700 + 1e-6);
});
