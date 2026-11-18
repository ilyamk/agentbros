import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKDROP_CONTRAST,
  CASHFREE_PULL_BACK,
  FLAME_TILE,
  FOREN_COUNTDOWN_HOLD,
  FOREN_COUNTDOWN_STEPS,
  UGC_LIQUID_FRAMES,
  countdownAt,
  countdownValues,
  liquidLight,
  liquidRadius,
  mazeSegments,
  mixHex,
  pullBackScale,
  ringField,
  specularBand,
  tileFlicker,
  tileGrow,
  tintedSweep,
} from "../src/motion/library/backgrounds/background-plan";
import {
  ACE_ORB,
  CASHFREE_TRUCK,
  FLAME_SPHERES,
  FLEX_FAN,
  FLEX_PULL_OUT,
  POLYMARKET_SLIP,
  curlPoint,
  fanAngles,
  isLand,
  isoGrid,
  orbState,
  project,
  pullOut,
  rotate,
  slipFlat,
  slipRowFrames,
  slipRowsShown,
  slipUnroll,
  sphereArcs,
  sphereField,
  spherePoints,
  spherePose,
  tintAt,
  truckOffset,
} from "../src/motion/library/three/three-plan";

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

// --- word-backdrop ---

test("word-backdrop: rings expand from the centre without end and fade at both ends", () => {
  const a = ringField(0, { count: 4, period: 40 });
  const b = ringField(5, { count: 4, period: 40 });
  assert.equal(a.length, 4);
  for (const ring of a) assert.ok(ring.radius >= 0 && ring.radius < 1 && ring.alpha >= 0 && ring.alpha <= 1);
  // an eighth of a period later every ring has grown by an eighth
  for (let i = 0; i < 4; i++) close(b[i]!.radius, a[i]!.radius + 0.125);
  assert.deepEqual(ringField(40, { count: 4, period: 40 }), a, "periodic");
  assert.equal(ringField(0, { count: 1 })[0]!.alpha, 0, "a ring at the centre is invisible");
  assert.ok(BACKDROP_CONTRAST >= 0.06 && BACKDROP_CONTRAST <= 0.12);
});

test("word-backdrop: tile flicker is seeded, partial and never changes every tile at once", () => {
  const opts = { columns: 8, rows: 5, seed: "poly", hold: 8, lit: 0.2 };
  const a = tileFlicker(30, opts);
  assert.deepEqual(a, tileFlicker(30, opts));
  assert.notDeepEqual(a, tileFlicker(30, { ...opts, seed: "other" }));
  let maxChanged = 0;
  let litTotal = 0;
  for (let f = 1; f < 120; f++) {
    const prev = tileFlicker(f - 1, opts);
    const now = tileFlicker(f, opts);
    maxChanged = Math.max(maxChanged, now.filter((v, i) => v !== prev[i]).length);
    litTotal += now.filter((v) => v > 0.5).length;
  }
  assert.ok(maxChanged < 40 / 2, `changed ${maxChanged}`);
  const share = litTotal / (119 * 40);
  assert.ok(share > 0.08 && share < 0.35, `lit share ${share}`);
});

test("word-backdrop: foren countdown steps on 0, 2, 4, 7, 11 to zero, then glows for the hold", () => {
  assert.deepEqual([...FOREN_COUNTDOWN_STEPS], [0, 2, 4, 7, 11]);
  assert.equal(FOREN_COUNTDOWN_HOLD, 13);
  assert.deepEqual(countdownValues(4, 5), [4, 3, 2, 1, 0]);
  assert.deepEqual(countdownValues(10, 5), [10, 8, 5, 3, 0]);
  const values = Array.from({ length: 14 }, (_, f) => countdownAt(f + 5, { at: 5 }).value);
  assert.deepEqual(values, [4, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 0, 0, 0]);
  assert.equal(countdownAt(4, { at: 5 }).value, null);
  assert.equal(countdownAt(15, { at: 5 }).glow, 0);
  assert.ok(countdownAt(16, { at: 5 }).glow > 0);
  assert.equal(countdownAt(30, { at: 5 }).glow, 1);
  // gaps between steps never shrink: the count decelerates
  const gaps = FOREN_COUNTDOWN_STEPS.slice(1).map((s, i) => s - FOREN_COUNTDOWN_STEPS[i]!);
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i]! >= gaps[i - 1]!);
});

// --- material-fill ---

test("material-fill: the specular band crosses the surface once per period and slows at the edges", () => {
  close(specularBand(0), -0.25);
  close(specularBand(75), -0.25);
  assert.ok(specularBand(37) > 0.4 && specularBand(37) < 0.6);
  const mid = specularBand(38) - specularBand(37);
  const edge = specularBand(1) - specularBand(0);
  assert.ok(mid > edge * 5);
});

test("material-fill: the maze has one seeded wall per cell on the cell's edges", () => {
  const maze = mazeSegments("flame", 12, 7);
  assert.equal(maze.length, 84);
  assert.deepEqual(maze, mazeSegments("flame", 12, 7));
  for (const s of maze) {
    assert.ok(Number.isInteger(s.x1) && Number.isInteger(s.y2));
    assert.equal(Math.abs(s.x2 - s.x1) + Math.abs(s.y2 - s.y1), 1);
  }
  const horizontal = maze.filter((s) => s.y1 === s.y2).length;
  assert.ok(horizontal > 20 && horizontal < 64);
});

test("material-fill: flame's tile grows 6% to 20% of the width in 10 frames, decelerating", () => {
  close(tileGrow(0), FLAME_TILE.from);
  close(tileGrow(10), FLAME_TILE.to);
  close(tileGrow(40), FLAME_TILE.to);
  assert.ok(tileGrow(5) > (FLAME_TILE.from + FLAME_TILE.to) / 2, "decelerates");
});

// --- liquid-light ---

test("liquid-light: grows from nothing over ugc-app's 17 frames and has a dark core and a fringed rim", () => {
  assert.equal(UGC_LIQUID_FRAMES, 17);
  assert.equal(liquidRadius(4, { at: 5 }), 0);
  assert.ok(liquidRadius(10, { at: 5 }) > 0.3, "expo.out: most of the growth early");
  close(liquidRadius(22, { at: 5, size: 0.4 }), 0.4, 1e-3);
  const r = 0.4;
  const core = liquidLight(0.05, 0.8, r, 1, "ugc");
  const rim = liquidLight(r, 0.8, r, 1, "ugc");
  const lum = (c: number[]) => c[0]! + c[1]! + c[2]!;
  assert.ok(lum(rim) > lum(core) * 3, `rim ${lum(rim)} core ${lum(core)}`);
  const outside = liquidLight(r * 1.05, 0.8, r, 1, "ugc");
  const inside = liquidLight(r * 0.95, 0.8, r, 1, "ugc");
  assert.ok(outside[0]! - outside[2]! > inside[0]! - inside[2]!, "red outside, blue inside");
  assert.deepEqual(liquidLight(0.2, 0.8, 0, 1, "ugc"), [0, 0, 0]);
});

// --- spotlight-studio tint ---

test("spotlight-studio tint: the sweep runs pale at the top to a deep shade on the floor", () => {
  assert.equal(mixHex("#000000", "#ffffff", 0.5), "#808080");
  const sweep = tintedSweep("#1aa35c");
  const lum = (hex: string) =>
    Number.parseInt(hex.slice(1, 3), 16) + Number.parseInt(hex.slice(3, 5), 16) + Number.parseInt(hex.slice(5, 7), 16);
  assert.ok(
    lum(sweep.top) > lum(sweep.wall) && lum(sweep.wall) > lum(sweep.floor) && lum(sweep.floor) > lum(sweep.edge),
  );
  assert.ok(Number.parseInt(sweep.top.slice(3, 5), 16) > Number.parseInt(sweep.top.slice(1, 3), 16), "keeps its hue");
});

test("spotlight-studio pull-back: frame-filling to rest in cashfree's 14 frames, power3.out", () => {
  close(pullBackScale(0), 1 / CASHFREE_PULL_BACK.to);
  close(pullBackScale(14), 1);
  assert.ok(pullBackScale(4) < 1 + (1 / CASHFREE_PULL_BACK.to - 1) / 2, "past half way within 4 frames");
});

// --- shaded-orb ---

test("shaded-orb glossy: ace's grow 11 f, shift, eyes 3 f and bottom-up flood 3 f, in order", () => {
  const plan = { at: 10, ...ACE_ORB };
  const s = (f: number) => orbState(f, plan);
  assert.equal(s(10).scale, 0);
  close(s(21).scale, 1);
  assert.ok(s(15).scale > 0.45 && s(15).scale < 0.75, "near-even growth");
  assert.equal(s(21).eyes, 0);
  assert.equal(s(29).eyes, 1);
  assert.equal(s(29).flood, 0);
  assert.equal(s(33).flood, 1);
  const zero = orbState(0, { at: 0, grow: 0, shiftAt: 0, shift: 0, eyesAt: 0, eyes: 0, floodAt: 0, flood: 0 });
  assert.deepEqual(zero, { scale: 1, shift: 1, eyes: 1, flood: 1 }, "zero-length steps are done");
});

test("shaded-orb iridescent: a seeded field round the edges, centre clear, outermost first, settled in 5 frames", () => {
  const field = sphereField("flame", 9);
  assert.deepEqual(field, sphereField("flame", 9));
  for (const s of field) {
    assert.ok(Math.hypot(s.x - 0.5, s.y - 0.5) >= 0.42 - 1e-9, "centre clear");
    assert.ok(s.r >= FLAME_SPHERES.minR && s.r <= FLAME_SPHERES.maxR);
  }
  const far = field.reduce((a, b) => (Math.hypot(a.x - 0.5, a.y - 0.5) > Math.hypot(b.x - 0.5, b.y - 0.5) ? a : b));
  assert.equal(far.delay, 0, "outermost enters first");
  const s = field[0]!;
  const settled = spherePose(s, s.delay + FLAME_SPHERES.enter, {});
  close(settled.x, s.x, 1e-3);
  const early = spherePose(s, s.delay + 1, {});
  assert.ok(Math.hypot(early.x - 0.5, early.y - 0.5) > Math.hypot(s.x - 0.5, s.y - 0.5), "comes from outside");
  const gone = spherePose(s, 40, { collapseAt: 20 });
  assert.equal(gone.opacity, 0);
  const ring = spherePose(s, 25, { collapseAt: 20 });
  assert.ok(Math.hypot(ring.x - 0.5, ring.y - 0.5) < 0.1, "pulled into a ring at the centre");
});

// --- point-sphere ---

test("point-sphere: seeded points and arcs lie on the unit sphere", () => {
  const pts = spherePoints("flex", 300);
  assert.equal(pts.length, 300);
  for (const p of pts) close(Math.hypot(...p), 1, 1e-6);
  const mean = pts.reduce((acc, p) => [acc[0] + p[0], acc[1] + p[1], acc[2] + p[2]], [0, 0, 0]);
  for (const m of mean) assert.ok(Math.abs(m / 300) < 0.05, "spread evenly");
  const arcs = sphereArcs("flex", 40, { samples: 6 });
  for (const arc of arcs) {
    assert.equal(arc.length, 6);
    for (const p of arc) close(Math.hypot(...p), 1, 1e-6);
  }
  assert.deepEqual(sphereArcs("flex", 5), sphereArcs("flex", 5));
});

test("point-sphere: rotation keeps length, projection puts the front nearer and larger", () => {
  const p = rotate([0.3, 0.4, Math.sqrt(1 - 0.25)], 0.7, -0.3);
  close(Math.hypot(...p), 1);
  const front = project([0, 0, 1], { cx: 500, cy: 500, radius: 200 });
  const back = project([0, 0, -1], { cx: 500, cy: 500, radius: 200 });
  assert.ok(front.scale > back.scale && front.depth === 1 && back.depth === 0);
  const top = project([0, 1, 0], { cx: 500, cy: 500, radius: 200 });
  close(top.y, 300);
});

test("point-sphere: flex pull-out 25 frames circ.out, land mask and tint are seeded", () => {
  close(pullOut(0), FLEX_PULL_OUT.from);
  close(pullOut(25), 1);
  assert.ok(pullOut(5) < (FLEX_PULL_OUT.from + 1) / 2, "circ.out: past halfway early");
  const pts = spherePoints("globe", 800);
  const land = pts.filter((p) => isLand(p, "globe")).length / pts.length;
  assert.ok(land > 0.15 && land < 0.65, `land share ${land}`);
  assert.ok(tintAt([0, 1, 0], 0) < tintAt([0, -1, 0], 0));
  assert.ok(tintAt([0, 0, 1], 100) > tintAt([0, 0, 1], 0), "drifts over time");
});

// --- printing-slip ---

test("printing-slip: unrolls over polymarket's 29 frames, power3.out, early rows every 1-2 frames, then slower", () => {
  assert.equal(POLYMARKET_SLIP.frames, 29);
  assert.equal(slipUnroll(0), 0);
  close(slipUnroll(29), 1);
  assert.equal(slipRowsShown(0, 8), 0);
  assert.equal(slipRowsShown(1, 8), 8);
  const frames = slipRowFrames(8);
  assert.equal(frames.length, 8);
  for (let i = 1; i < frames.length; i++) assert.ok(frames[i]! >= frames[i - 1]!);
  const firstGaps = (frames[3]! - frames[0]!) / 3;
  assert.ok(firstGaps >= 0.5 && firstGaps <= 2.5, `early rows every ${firstGaps} f`);
  assert.ok(frames.at(-1)! <= 29);
  assert.ok(frames[7]! - frames[6]! > frames[1]! - frames[0]!, "slows down");
  close(slipFlat(0), 0.18);
  close(slipFlat(1), 1);
});

test("printing-slip: the curl is flat above the roll and wraps backwards below it", () => {
  assert.deepEqual(curlPoint(0.5, 1, 0.1), { y: -0.5, z: 0 });
  const quarter = curlPoint(1 + (Math.PI / 2) * 0.1, 1, 0.1);
  close(quarter.y, -1.1);
  close(quarter.z, -0.1);
  const far = curlPoint(50, 1, 0.1);
  assert.ok(far.z < 0 && far.z >= -0.2, "capped inside the roll");
});

// --- modes ---

test("depth-card fan: flex's dozen copies fan over 53 frames, sine.inOut, each later copy delayed", () => {
  const start = fanAngles(0);
  assert.equal(start.length, FLEX_FAN.copies);
  for (const a of start) close(a, 0);
  const end = fanAngles(FLEX_FAN.frames);
  close(end[0]!, 0);
  close(end.at(-1)!, 70);
  for (let i = 1; i < end.length; i++) assert.ok(end[i]! > end[i - 1]!);
  const shareOf = (frame: number, i: number) => fanAngles(frame)[i]! / ((70 * i) / 11);
  assert.ok(shareOf(20, 2) > shareOf(20, 8), "later copies trail");
});

test("studio-product-stage array: a centred isometric grid and cashfree's truck, sine.inOut", () => {
  const grid = isoGrid(4, 3, 2);
  assert.equal(grid.length, 12);
  close(
    grid.reduce((s, c) => s + c.x, 0),
    0,
  );
  close(
    grid.reduce((s, c) => s + c.z, 0),
    0,
  );
  const a = truckOffset(0, 91);
  const b = truckOffset(90, 91);
  close(b.x - a.x, CASHFREE_TRUCK.x);
  close(b.y - a.y, CASHFREE_TRUCK.y);
  close(truckOffset(45, 91).x, 0);
  assert.ok(truckOffset(5, 91).x - a.x < (b.x - a.x) * 0.05, "eases in");
});
