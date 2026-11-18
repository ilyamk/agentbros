import test from "node:test";
import assert from "node:assert/strict";
import { flashDecay, onSteps } from "../src/motion/timing";
import {
  ABDULAH_INKS,
  ABDULAH_WAVE_EXIT,
  AIRFORM_ENTER,
  AIRFORM_EXIT,
  BLEACH_PEAK,
  GOJIBERRY_DARK_EXIT,
  MAX_CHANGES_PER_SECOND,
  NOWAK_STROBE_ENTER,
  PAPER_BLEACH_ENTER,
  bleachLevel,
  gojiberryXrayExit,
  gojiberryXrayFromCutout,
  matteRoute,
  gradeAt,
  gradeChanges,
  gradeSchedule,
  halftoneInkAt,
  halftoneInkChanges,
  maxChangesPerWindow,
  waveOffsets,
  type GradeSpan,
} from "../src/motion/library/effects/flash-plan";
import {
  BAND_FRAMES,
  cornerLanding,
  cornerPose,
  discEntry,
  popFrames,
  scatterPositions,
  spinPose,
  symbolIndex,
  dotBlobRadius,
  dotConvergeEnd,
  dotFieldStates,
  dotStreamEdge,
  dotSwapDelays,
  gridDotSources,
  limbAngle,
  type DotFieldTiming,
} from "../src/motion/library/effects/effects-plan";
import { FLASH_GRID, FlashTracker } from "../src/lib/sensors/flash";

// Batch 3 of the gap triage (design-reference/gap-triage.md rows C1-C9): pure plans only, no browser components.

test("flashDecay: peaks on its frame, settles in its length on power2.out, nothing outside", () => {
  assert.equal(flashDecay(7, 8, 3), 0);
  assert.equal(flashDecay(8, 8, 3), 1);
  assert.ok(Math.abs(flashDecay(9, 8, 3) - 4 / 9) < 1e-9);
  assert.ok(flashDecay(10, 8, 3) < flashDecay(9, 8, 3));
  assert.equal(flashDecay(11, 8, 3), 0);
  assert.equal(flashDecay(9, -1, 3), 0);
});

test("onSteps holds an element on twos and threes", () => {
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5, 6].map((f) => onSteps(f, 3)),
    [0, 0, 0, 3, 3, 3, 6],
  );
});

test("halftone ink cycle (C2): abdulah inks every 10 frames, steps, clamped to 5, within the flash budget", () => {
  assert.equal(halftoneInkAt(0, [], 10), undefined);
  assert.equal(halftoneInkAt(9, ABDULAH_INKS, 10), ABDULAH_INKS[0]);
  assert.equal(halftoneInkAt(10, ABDULAH_INKS, 10), ABDULAH_INKS[1]);
  assert.equal(halftoneInkAt(30, ABDULAH_INKS, 10), ABDULAH_INKS[0]);
  assert.equal(halftoneInkAt(4, ABDULAH_INKS, 1), ABDULAH_INKS[0]);
  assert.equal(halftoneInkAt(5, ABDULAH_INKS, 1), ABDULAH_INKS[1]);
  assert.deepEqual(halftoneInkChanges(ABDULAH_INKS, 10, 40), [10, 20, 30]);
  assert.ok(maxChangesPerWindow(halftoneInkChanges(ABDULAH_INKS, 1, 300)) <= MAX_CHANGES_PER_SECOND);
});

// --- C1: grade steps bleach, wave, darken, matte, colour ---

const rgb = (hex: string): [number, number, number] => {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
};

/**
 * Modelled picture of a plate of flat luminance `plate` (0 black .. 1 white) under a grade schedule, frame by frame, fed
 * to the real flash sensor. Intra-step changes (a bleach decaying, a wave) are modelled per frame, not per span.
 */
const modelledReport = (spans: GradeSpan[], frames: number, plate: number, exitAt = -1) => {
  const tracker = new FlashTracker();
  for (let frame = 0; frame < frames; frame++) {
    const span = gradeAt(spans, frame);
    let c: [number, number, number] = [plate, plate, plate];
    if (exitAt >= 0 && frame >= exitAt && !span) c = [1 - plate, 1 - plate, 1 - plate]; // the next plate: the opposite, the worst case
    if (span) {
      const local = frame - span.from;
      const g = span.grade;
      if (g === "negative" || g === "polarity") c = [1 - plate, 1 - plate, 1 - plate];
      if (g === "darken" || g === "matte") c = [plate * 0.3, plate * 0.3, plate * 0.3];
      if (g === "bleach") c = c.map((v) => v + (1 - v) * bleachLevel(local, span.to - span.from)) as typeof c;
      if (g === "colour" && !span.content) c = rgb(span.ground ?? "#000000");
      if (g === "colour" && span.content) {
        const [a, b] = [rgb(span.ground ?? "#000000"), rgb(span.ink ?? "#ffffff")];
        c = a.map((v, i) => v + (b[i]! - v) * plate) as typeof c;
      }
    }
    const pixels = new Float32Array(FLASH_GRID * FLASH_GRID * 3);
    for (let i = 0; i < pixels.length; i += 3) pixels.set(c, i);
    tracker.push(pixels);
  }
  return tracker.report(30);
};

test("bleach (C1, paper-style): near white on the first frame, decaying to nothing over the step", () => {
  const levels = [0, 1, 2, 3].map((f) => bleachLevel(f, 3));
  assert.equal(levels[0], BLEACH_PEAK);
  assert.ok(levels[1]! < levels[0]! && levels[2]! < levels[1]! && levels[2]! > 0);
  assert.equal(levels[3], 0);
  assert.equal(bleachLevel(-1, 3), 0);
});

test("wave (C1, abdulah): band offsets are a deterministic sine that moves between frames and stays small", () => {
  const a = waveOffsets(0);
  assert.deepEqual(a, waveOffsets(0));
  assert.notDeepEqual(a, waveOffsets(1));
  assert.ok(a.every((o) => Math.abs(o) <= 0.035 + 1e-12));
  assert.ok(a.some((o) => o > 0.02) && a.some((o) => o < -0.02));
});

test("grade schedule carries a step's ground, ink, content and matte onto its span, and leaves the airform spans unchanged", () => {
  const spans = gradeSchedule({ exitAt: -1, exit: [], enterAt: 0, enter: NOWAK_STROBE_ENTER });
  assert.deepEqual(spans[0], {
    from: 0,
    to: 3,
    grade: "colour",
    fringe: false,
    side: "enter",
    ground: "#0B1A5C",
    content: false,
  });
  assert.equal(spans.at(-1)!.from, 24);
  assert.equal(spans.at(-1)!.to, 26);
  assert.equal(
    gradeSchedule({ exitAt: -1, exit: [], enterAt: 0, enter: gojiberryXrayExit("projects/x/matte.png") })[0]!.src,
    "projects/x/matte.png",
  );
  assert.deepEqual(Object.keys(gradeSchedule({ exitAt: 45, exit: AIRFORM_EXIT, enterAt: -1, enter: [] })[0]!).sort(), [
    "fringe",
    "from",
    "grade",
    "side",
    "to",
  ]);
});

test("matte step: artwork from src, the plate's own cut-out from matteSrc, darken with neither (gojiberry x-ray)", () => {
  assert.equal(matteRoute({}), "darken");
  assert.equal(matteRoute({ matteSrc: "projects/x/cutout.png" }), "cutout");
  assert.equal(matteRoute({ src: "projects/x/xray.png" }), "artwork");
  assert.equal(matteRoute({ src: "projects/x/xray.png", matteSrc: "projects/x/cutout.png" }), "artwork", "src wins");
  const [span] = gradeSchedule({
    exitAt: 30,
    exit: gojiberryXrayFromCutout("projects/x/cutout.png"),
    enterAt: -1,
    enter: [],
  });
  assert.deepEqual(span, {
    from: 26,
    to: 30,
    grade: "matte",
    fringe: false,
    side: "exit",
    ink: "#62E6F2",
    ground: "#04080D",
    matteSrc: "projects/x/cutout.png",
  });
});

test("nowakdesign strobe (C1): the measured frames F0-F25 (flashes at 0, 3, 6, black at 9, title at 11, white 16-22, back at 23, split 24-25)", () => {
  const spans = gradeSchedule({ exitAt: -1, exit: [], enterAt: 0, enter: NOWAK_STROBE_ENTER });
  assert.deepEqual(
    spans.map((s) => [s.from, s.grade]),
    [
      [0, "colour"],
      [3, "colour"],
      [6, "colour"],
      [9, "colour"],
      [11, "none"],
      [16, "colour"],
      [23, "none"],
      [24, "none"],
    ],
  );
  assert.equal(gradeAt(spans, 24)!.fringe, true);
});

test("flash safety (C1): every new preset passes the flash sensor on a black and on a white plate, frame by frame", () => {
  const cases: { name: string; spans: GradeSpan[]; exitAt?: number }[] = [
    { name: "nowak strobe", spans: gradeSchedule({ exitAt: -1, exit: [], enterAt: 0, enter: NOWAK_STROBE_ENTER }) },
    { name: "paper bleach", spans: gradeSchedule({ exitAt: -1, exit: [], enterAt: 10, enter: PAPER_BLEACH_ENTER }) },
    {
      name: "abdulah wave exit",
      spans: gradeSchedule({ exitAt: 30, exit: ABDULAH_WAVE_EXIT, enterAt: 30, enter: PAPER_BLEACH_ENTER }),
      exitAt: 30,
    },
    {
      name: "gojiberry dark",
      spans: gradeSchedule({ exitAt: 30, exit: GOJIBERRY_DARK_EXIT, enterAt: 30, enter: AIRFORM_ENTER }),
      exitAt: 30,
    },
    {
      name: "gojiberry x-ray",
      spans: gradeSchedule({ exitAt: 30, exit: gojiberryXrayExit("m.png"), enterAt: -1, enter: [] }),
      exitAt: 30,
    },
  ];
  for (const { name, spans, exitAt } of cases) {
    for (const plate of [0.04, 0.95])
      assert.equal(modelledReport(spans, 90, plate, exitAt).ranges.length, 0, `${name} on plate ${plate}`);
  }
  // The structural count of the abdulah exit stays within six changes a second as well.
  assert.ok(
    maxChangesPerWindow(
      gradeChanges(gradeSchedule({ exitAt: 30, exit: ABDULAH_WAVE_EXIT, enterAt: 30, enter: PAPER_BLEACH_ENTER }), 30),
    ) <= MAX_CHANGES_PER_SECOND,
  );
});

test("the modelled sensor has teeth: four white bleaches in a second fail", () => {
  const enter = Array.from({ length: 4 }, () => [
    { grade: "bleach" as const, frames: 3 },
    { grade: "none" as const, frames: 4 },
  ]).flat();
  assert.ok(modelledReport(gradeSchedule({ exitAt: -1, exit: [], enterAt: 0, enter }), 60, 0.04).ranges.length > 0);
});

// --- C8: puppet limb on steps ---

test("puppet limb (C8): still before landing, swings on threes about rest, holds each pose", () => {
  const limb = { pivotX: 0.5, pivotY: 1, swing: 14, period: 36, step: 3 };
  assert.equal(limbAngle(9, limb, 10), 0);
  assert.equal(limbAngle(10, limb, 10), 0);
  assert.equal(limbAngle(13, limb, 10), limbAngle(15, limb, 10));
  assert.notEqual(limbAngle(13, limb, 10), limbAngle(16, limb, 10));
  const angles = Array.from({ length: 72 }, (_, f) => limbAngle(f + 10, limb, 10));
  assert.ok(Math.max(...angles) <= 14 && Math.min(...angles) >= -14 && Math.max(...angles) > 12);
});

// --- C3: things become dots ---

const FIELD = gridDotSources({ x: 100, y: 100, w: 1600, h: 800 }, 16, 8, [0.16, 0.22, 0.3, 0.4], 0.25, "dots");
const FIELD_TIMING: DotFieldTiming = {
  swapAt: 12,
  swapStep: 23,
  order: "radial",
  swapFrames: 3,
  to: "stream",
  toAt: 38,
  convergeFrames: 11,
  target: { x: 1650, y: 540 },
  streamFrames: 30,
  bandFrom: 230,
  bandHeight: 54,
  width: 1920,
  seed: "dots",
};

test("dot field (C3): grid sources are seeded, one per cell, sized from the list", () => {
  assert.equal(FIELD.length, 128);
  assert.deepEqual(
    FIELD,
    gridDotSources({ x: 100, y: 100, w: 1600, h: 800 }, 16, 8, [0.16, 0.22, 0.3, 0.4], 0.25, "dots"),
  );
  const cell = 100;
  assert.ok(FIELD.every((s) => [0.16, 0.22, 0.3, 0.4].some((k) => Math.abs(s.r - (k * cell) / 2) < 1e-9)));
});

test("dot field (C3): index swaps left to right every 2-3 frames (ace); radial swaps outward, ties together, the ring speeding up (context-dev)", () => {
  const row = [0, 1, 2, 3, 4].map((i) => ({ x: i * 100, y: 0, r: 10 }));
  assert.deepEqual(dotSwapDelays(row, "index", 2.5), [0, 3, 5, 8, 10]);
  const grid = [0, 1, 2].flatMap((y) => [0, 1, 2].map((x) => ({ x, y, r: 0.1 })));
  const delays = dotSwapDelays(grid, "radial", 23);
  assert.equal(delays[4], 0);
  assert.equal(delays[1], delays[3]);
  assert.equal(delays[0], 23);
  // power1.in: the first ring takes longer to start than the gap from the first ring to the corners.
  assert.ok(delays[1]! > delays[0]! - delays[1]!);
  const field = dotSwapDelays(FIELD, "radial", 23);
  assert.equal(Math.max(...field), 23);
});

test("dot field (C3): items fade as discs pop, then the field converges to the target and streams off right, revealing type behind its trailing edge", () => {
  const before = dotFieldStates(11, FIELD, FIELD_TIMING);
  assert.ok(before.every((s) => s.item === 1 && s.dot === 0));
  const swapped = dotFieldStates(38, FIELD, FIELD_TIMING);
  assert.ok(swapped.every((s) => s.item === 0 && s.dot === 1));
  const end = dotConvergeEnd(FIELD_TIMING);
  const met = dotFieldStates(end, FIELD, FIELD_TIMING);
  assert.ok(met.every((s) => Math.hypot(s.x - 1650, s.y - 540) < 1e-6));
  assert.equal(dotStreamEdge(end, FIELD, FIELD_TIMING), -1);
  const edges = [end + BAND_FRAMES, end + 12, end + 20, end + 26].map((f) => dotStreamEdge(f, FIELD, FIELD_TIMING));
  for (let i = 1; i < edges.length; i++) assert.ok(edges[i]! >= edges[i - 1]!, `edge ${edges}`);
  assert.equal(dotStreamEdge(end + 30, FIELD, FIELD_TIMING), 1920);
  assert.ok(dotFieldStates(end + 30, FIELD, FIELD_TIMING).every((s) => s.gone));
  assert.deepEqual(dotFieldStates(50, FIELD, FIELD_TIMING), dotFieldStates(50, FIELD, FIELD_TIMING));
});

test("dot field (C3): merge swaps the discs for one blob on the converge's last frame", () => {
  const t = { ...FIELD_TIMING, to: "merge" as const };
  const end = dotConvergeEnd(t);
  assert.equal(dotBlobRadius(end - 1, FIELD, t), 0);
  assert.ok(dotBlobRadius(end + 6, FIELD, t) > 0);
  assert.ok(dotFieldStates(end, FIELD, t).every((s) => s.gone));
  assert.ok(dotFieldStates(end - 1, FIELD, t).every((s) => !s.gone));
});

// --- C4: scatter around a line ---

const LINE_BOX = { x: 600, y: 500, w: 720, h: 80 };
const SAFE = { x: 154, y: 86, w: 1612, h: 908 };

test("scatter (C4): seeded positions inside the area, clear of the line's box and of each other, stable per seed", () => {
  const sizes = Array.from({ length: 18 }, (_, i) => ({ hw: 30 + (i % 3) * 10, hh: 40 + (i % 3) * 12 }));
  const gap = 20;
  const a = scatterPositions(sizes, { area: SAFE, avoid: LINE_BOX, gap, seed: "s" });
  assert.equal(a.length, 18);
  assert.deepEqual(a, scatterPositions(sizes, { area: SAFE, avoid: LINE_BOX, gap, seed: "s" }));
  assert.notDeepEqual(a, scatterPositions(sizes, { area: SAFE, avoid: LINE_BOX, gap, seed: "t" }));
  for (const p of a) {
    assert.ok(
      p.x - p.hw >= SAFE.x - 1e-9 &&
        p.x + p.hw <= SAFE.x + SAFE.w + 1e-9 &&
        p.y - p.hh >= SAFE.y - 1e-9 &&
        p.y + p.hh <= SAFE.y + SAFE.h + 1e-9,
      "inside the safe area",
    );
    const clearOfLine =
      p.x + p.hw + gap <= LINE_BOX.x ||
      p.x - p.hw - gap >= LINE_BOX.x + LINE_BOX.w ||
      p.y + p.hh + gap <= LINE_BOX.y ||
      p.y - p.hh - gap >= LINE_BOX.y + LINE_BOX.h;
    assert.ok(clearOfLine, "clear of the line");
  }
  for (let i = 0; i < a.length; i++)
    for (let j = i + 1; j < a.length; j++) {
      const p = a[i]!;
      const q = a[j]!;
      assert.ok(
        Math.abs(p.x - q.x) >= p.hw + q.hw + gap - 1e-9 || Math.abs(p.y - q.y) >= p.hh + q.hh + gap - 1e-9,
        `items ${i} and ${j} overlap`,
      );
    }
});

test("scatter (C4): a crowded area still places every item, within bounded attempts", () => {
  const sizes = Array.from({ length: 30 }, () => ({ hw: 120, hh: 120 }));
  const placed = scatterPositions(sizes, {
    area: { x: 0, y: 0, w: 1000, h: 1000 },
    avoid: null,
    gap: 10,
    seed: "c",
    attempts: 40,
  });
  assert.equal(placed.length, 30);
});

test("scatter (C4): pops every 4 frames (abdulah); corner cards brake on their spot without overshoot, then drift outward (foren)", () => {
  assert.deepEqual(popFrames(4, 8, 4), [8, 12, 16, 20]);
  const opts = {
    at: 6,
    enterFrames: 6,
    lag: 1,
    drift: 0.6,
    spot: { x: 384, y: 238, w: 1152, h: 605 },
    width: 1920,
    height: 1080,
  };
  assert.equal(cornerPose(5, 0, opts).visible, false);
  const path = Array.from({ length: 7 }, (_, k) => cornerPose(6 + k, 0, opts));
  // Card 0 aims at the top-left spot from beyond the frame: x rises monotonically to the spot and never passes it.
  for (let k = 1; k < path.length; k++) assert.ok(path[k]!.x >= path[k - 1]!.x && path[k]!.x <= 384 + 1e-9);
  assert.ok(Math.abs(path[6]!.x - 384) < 1e-9 && Math.abs(path[6]!.y - 238) < 1e-9);
  const later = cornerPose(40, 0, opts);
  assert.ok(later.x < 384 && later.y < 238, "drifts outward");
  assert.equal(cornerLanding(3, opts), 15);
  assert.ok(cornerPose(20, 2, opts).x > 1536 && cornerPose(20, 2, opts).y > 843, "card 2 sits bottom right");
});

// --- C5: symbol disc ---

test("symbol disc (C5): the symbol swaps on its cue frames only and cycles", () => {
  assert.deepEqual(
    [0, 25, 26, 42, 43, 80].map((f) => symbolIndex(f, [26, 43], 3)),
    [0, 0, 1, 1, 2, 2],
  );
  assert.equal(symbolIndex(50, [10, 20, 30], 3), 0);
  assert.equal(symbolIndex(5, [], 1), 0);
});

test("symbol disc (C5): the disc settles in 5 frames on power3.out without overshoot, then drifts on (foren)", () => {
  const opts = { at: 4, settleFrames: 5, from: { x: 0.45, y: 0.55 }, drift: 0.35, width: 1920, height: 1080 };
  assert.equal(discEntry(3, opts).visible, false);
  const xs = [4, 5, 6, 7, 8, 9].map((f) => discEntry(f, opts).dx);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i]! <= xs[i - 1]! && xs[i]! >= -1e-9, `dx ${xs}`);
  assert.ok(Math.abs(xs[5]!) < 1e-9);
  // power3.out: more than 70% of the way in the first 2 of 5 frames.
  assert.ok(discEntry(6, opts).dx < 0.3 * 0.45 * 1920);
  const later = discEntry(40, opts);
  assert.ok(later.dx < 0 && later.dy < 0, "drifts on along its line of travel");
});

test("symbol disc (C5): the spin starts on its back, passes edge-on, ends face-on at scale 1 on its spot (polymarket)", () => {
  const opts = { at: 6, frames: 20, turns: 0.5, fromScale: 5, from: { x: 2016, y: 454 }, to: { x: 960, y: 540 } };
  const start = spinPose(6, opts);
  assert.equal(start.back, true);
  assert.equal(start.scale, 5);
  const mid = Array.from({ length: 12 }, (_, k) => spinPose(6 + k, opts));
  assert.ok(
    mid.some((p) => p.squash < 0.2),
    "passes edge-on",
  );
  const end = spinPose(26, opts);
  assert.equal(end.landed, true);
  assert.equal(end.back, false);
  assert.ok(
    Math.abs(end.squash - 1) < 1e-9 &&
      Math.abs(end.scale - 1) < 1e-9 &&
      Math.abs(end.x - 960) < 1e-9 &&
      Math.abs(end.y - 540) < 1e-9,
  );
  // Decelerates: the turn's speed falls frame on frame.
  assert.ok(spinPose(8, opts).speed > spinPose(14, opts).speed);
  assert.equal(spinPose(5, opts).visible, false);
});
