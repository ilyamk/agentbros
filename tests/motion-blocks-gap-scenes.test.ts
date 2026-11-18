import test from "node:test";
import assert from "node:assert/strict";
import { arrivalTint } from "../src/motion/text-modes";
import { reframePose, uiPunchReframeNexaaSettle } from "../src/motion/library/camera/UiPunchReframe";
import {
  sceneEndCardCues,
  sceneEndCardDefaults,
  sceneEndCardSchema,
  sceneEndCardTypedPreset,
} from "../src/motion/library/scenes/SceneEndCard";
import {
  END_CARD_TINT,
  END_CARD_TINT_FRAMES,
  END_CARD_TYPE_EVERY,
  endCardLetterAt,
  endCardTyped,
  HERO_SNAP_SHARE,
  QUAD_DIAGONAL,
  QUAD_MEDIAN_GAP_SEC,
  bestRest,
  closePairs,
  focusLanding,
  focusSizeAt,
  focusTransform,
  heroSnapRect,
  heroSnapRects,
  maxChangesWithin,
  medianGap,
  planQuadCuts,
  quadEvents,
  quadRects,
  quadShotAt,
  quadWindowFrames,
} from "../src/motion/library/scenes/scene-plan";
import {
  TICKER_PULL_FRAMES,
  neighbourBlur,
  sineInOut,
  tickerDrift,
  tickerIndexAt,
  tickerPull,
  tickerSeries,
  tickerSwaps,
} from "../src/motion/library/data/ticker-plan";
import {
  IMAGE_CARD_PAPER,
  WALL_CURVE,
  WALL_FIRST_FRAMES,
  WALL_SCROLL,
  WALL_SECOND_FRAMES,
  WALL_VIGNETTE,
  defocusRamp,
  wallCurve,
  wallScrollY,
  imageCardRect,
  power1Out,
  power2Out,
  secondCardPose,
  wallPlan,
  wallScale,
  wallTiles,
} from "../src/motion/library/camera/camera-plan";
import {
  pullOutPose,
  pullOutScale,
  populatePullOutCues,
  populatePullOutDefaults,
} from "../src/motion/library/camera/PopulatePullOut";

// Pure helpers of batch 5 (scenes, data and camera rows E1-E7 of design-reference/gap-triage.md). The block
// components import media and fonts; they are exercised by the library preview and tests/motion-library.test.ts.

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
) => a.x < b.x + b.w - 1e-6 && b.x < a.x + a.w - 1e-6 && a.y < b.y + b.h - 1e-6 && b.y < a.y + a.h - 1e-6;

// ---------------------------------------------------------------------------------------------------------------- E1

test("quad-split: 0.1 s is 3 frames at 30 fps and 6 at ace's 60", () => {
  assert.equal(quadWindowFrames(30), 3);
  assert.equal(quadWindowFrames(60), 6);
});

test("quad-split: no more than two changes within 0.1 s, close pairs only on diagonals one frame apart", () => {
  const wanted = [
    [20, 52, 96, 128, 170],
    [38, 110, 150],
    [38, 66, 100, 134, 176],
    [24, 80, 98, 160],
  ];
  const plan = planQuadCuts(wanted, { fps: 30 });
  const w = quadWindowFrames(30);
  assert.ok(maxChangesWithin(plan, w) <= 2);
  const pairs = closePairs(plan, w);
  assert.ok(pairs.length >= 1, "the two requests on frame 38 became a pair");
  for (const { a, b, gap } of pairs) {
    assert.equal(QUAD_DIAGONAL[a.cell], b.cell, "a close pair sits on opposite corners");
    assert.equal(gap, 1);
  }
  // Changes only move later, never earlier, and none is lost.
  assert.equal(quadEvents(plan).length, quadEvents(wanted).length);
  plan.forEach((list, cell) => list.forEach((f, i) => assert.ok(f >= wanted[cell]![i]!)));
});

test("quad-split: a coinciding request on the diagonal becomes the pair, one on a neighbour is pushed clear", () => {
  const diagonal = planQuadCuts([[30], [], [], [30]], { restSec: 0 });
  assert.deepEqual(diagonal, [[30], [], [], [31]]);
  const neighbour = planQuadCuts([[30], [30], [], []], { restSec: 0 });
  assert.equal(neighbour[1]![0]! - neighbour[0]![0]!, 3, "a neighbour waits out the 3-frame window");
});

test("quad-split: four cells cutting together still never put three in the window", () => {
  const plan = planQuadCuts(
    [
      [10, 40, 60, 90],
      [12, 42, 62, 92],
      [14, 44, 64, 94],
      [16, 46, 66, 96],
    ],
    { fps: 30 },
  );
  assert.ok(maxChangesWithin(plan, 3) <= 2);
  assert.ok(maxChangesWithin(plan, 6) <= 4);
});

test("quad-split: one cell rests at least 1.9 s while the others change three or more times (ace t14)", () => {
  const busy = [
    [10, 40, 60, 90],
    [12, 42, 62, 92],
    [14, 44, 64, 94],
    [16, 46, 66, 96],
  ];
  const before = bestRest(busy, 57);
  assert.equal(before, undefined, "no cell holds 57 frames in the wanted lists");
  const plan = planQuadCuts(busy, { fps: 30 });
  const rest = bestRest(plan, 57);
  assert.ok(rest && rest.to - rest.from >= 57 && rest.others >= 3, JSON.stringify(rest));
});

test("quad-split: the defaults keep ace's measures within reach (median gap near 0.5 s)", () => {
  const plan = planQuadCuts([
    [20, 52, 96, 128, 170],
    [38, 110, 150],
    [38, 66, 100, 134, 176],
    [24, 80, 98, 160],
  ]);
  const gap = medianGap(plan);
  assert.ok(gap >= 6 && gap <= Math.round(QUAD_MEDIAN_GAP_SEC * 30) + 4, `median ${gap}`);
  assert.equal(quadShotAt(plan[0]!, 0), 0);
  assert.equal(quadShotAt(plan[0]!, 20), 1);
  const rects = quadRects();
  assert.equal(
    rects.reduce((a, r) => a + r.w * r.h, 0),
    1,
    "four cells tile the frame with no gutter",
  );
});

// ---------------------------------------------------------------------------------------------------------------- E2

test("ticker-card: swaps are 6-12 frames apart, seeded, and the index rests on the last asset", () => {
  const swaps = tickerSwaps(7, 0, { seed: "t" });
  assert.equal(swaps.length, 6);
  swaps.forEach((f, i) => {
    const gap = f - (i === 0 ? 0 : swaps[i - 1]!);
    assert.ok(gap >= 6 && gap <= 12, `gap ${gap}`);
  });
  assert.deepEqual(swaps, tickerSwaps(7, 0, { seed: "t" }));
  assert.equal(tickerIndexAt(0, swaps), 0);
  assert.equal(tickerIndexAt(swaps[2]!, swaps), 3);
  assert.equal(tickerIndexAt(999, swaps), 6);
});

test("ticker-card: the price line follows the sign of the change", () => {
  const up = tickerSeries("x", 4);
  const down = tickerSeries("x", -4);
  assert.ok(up.every((v) => v >= 0 && v <= 1));
  assert.ok(up.at(-1)! > up[0]!, "rising ends higher");
  assert.ok(down.at(-1)! < down[0]!, "falling ends lower");
});

test("ticker-card: the pull-back is sine.inOut over 20 frames to the row scale, then the row slides left", () => {
  assert.equal(TICKER_PULL_FRAMES, 20);
  assert.ok(Math.abs(sineInOut(0.5) - 0.5) < 1e-12);
  assert.ok(sineInOut(0.1) < 0.1 && sineInOut(0.9) > 0.9, "slow in, slow out");
  assert.deepEqual(tickerPull(10, 20), { p: 0, scale: 1 });
  assert.ok(Math.abs(tickerPull(40, 20, 20, 0.62).scale - 0.62) < 1e-9);
  assert.deepEqual(tickerPull(30, -1), { p: 0, scale: 1 });
  assert.equal(tickerDrift(20, 20, 0.03), 0);
  assert.ok(tickerDrift(50, 20, 0.03) < tickerDrift(40, 20, 0.03), "keeps moving left at constant speed");
  assert.ok(neighbourBlur(2, 0, 10) > neighbourBlur(1, 0, 10), "further neighbours are softer");
  assert.ok(neighbourBlur(1, 1, 10) < neighbourBlur(1, 0, 10), "the depth of field eases as the row settles");
});

// ---------------------------------------------------------------------------------------------------------------- E3

test("bento heroSnap: full bleed until the snap frame, then a centred card at 63% of the width; tiles never overlap it", () => {
  const W = 1920;
  const H = 1080;
  const { hero, tiles } = heroSnapRects(W, H, HERO_SNAP_SHARE, 16);
  assert.ok(Math.abs(hero.w / W - 0.63) < 1e-9);
  assert.ok(Math.abs(hero.x + hero.w / 2 - W / 2) < 1e-6 && Math.abs(hero.y + hero.h / 2 - H / 2) < 1e-6);
  assert.deepEqual(heroSnapRect(19, 20, W, H, hero), { x: 0, y: 0, w: W, h: H });
  assert.deepEqual(heroSnapRect(20, 20, W, H, hero), hero, "one frame, no tween");
  assert.equal(tiles.length, 6);
  for (const t of tiles) {
    assert.ok(!overlaps(t, hero));
    assert.ok(t.x >= 0 && t.y >= 0 && t.x + t.w <= W + 1e-6 && t.y + t.h <= H + 1e-6);
  }
  const v = heroSnapRects(1080, 1920);
  for (const t of v.tiles) assert.ok(!overlaps(t, v.hero) && t.w > 1080 * 0.3, "vertical tiles stay readable");
});

// ---------------------------------------------------------------------------------------------------------------- E4

test("aligned burst: each plate's focus box lands on the same point at the planned size", () => {
  const W = 1920;
  const H = 1080;
  const target = { x: 0.5, y: 0.5 };
  const boxes = [
    { x: 0.1, y: 0.2, w: 0.2, h: 0.05 },
    { x: 0.6, y: 0.7, w: 0.1, h: 0.04 },
  ];
  for (const box of boxes) {
    const t = focusTransform(box, target, 0.3, W, H);
    const landed = focusLanding(box, t, W, H);
    assert.ok(Math.abs(landed.x + landed.w / 2 - W / 2) < 1e-6);
    assert.ok(Math.abs(landed.y + landed.h / 2 - H / 2) < 1e-6);
    assert.ok(Math.abs(landed.w - 0.3 * W) < 1e-6);
  }
});

test("aligned burst: the focus grows geometrically by plate index (palmier closes in steadily)", () => {
  assert.equal(focusSizeAt(0, 10, 0.1, 3), 0.1);
  assert.ok(Math.abs(focusSizeAt(9, 10, 0.1, 3) - 0.3) < 1e-12);
  const ratios = [1, 2, 3].map((i) => focusSizeAt(i, 10, 0.1, 3) / focusSizeAt(i - 1, 10, 0.1, 3));
  assert.ok(Math.abs(ratios[0]! - ratios[2]!) < 1e-12, "a constant ratio per plate");
  assert.equal(focusSizeAt(5, 10, 0.2), 0.2, "no growth by default");
});

// ---------------------------------------------------------------------------------------------------------------- E5

test("video wall: power2.out for 15 frames, then power1.out for 51, from close to the whole wall", () => {
  assert.equal(WALL_FIRST_FRAMES, 15);
  assert.equal(WALL_SECOND_FRAMES, 51);
  assert.equal(power2Out(1), 1);
  assert.ok(power2Out(0.5) > power1Out(0.5));
  assert.equal(wallScale(39, 40, 4, 2.2).scale, 4);
  assert.ok(Math.abs(wallScale(55, 40, 4, 2.2).scale - 2.2) < 1e-9, "first stage lands on mid");
  assert.ok(Math.abs(wallScale(106, 40, 4, 2.2).scale - 1) < 1e-9, "second stage ends on the whole wall");
  const s = (f: number) => wallScale(f, 40, 4, 2.2).scale;
  for (let f = 40; f < 106; f++) assert.ok(s(f + 1) <= s(f) + 1e-12, `never pushes back in at ${f}`);
  assert.ok(s(60) - s(61) > s(100) - s(101), "the second stage decelerates");
});

test("video wall: populate-pull-out variant wall uses that pose and keeps the edges covered", () => {
  const plan = {
    ...populatePullOutDefaults,
    variant: "wall" as const,
    closeScale: 4,
    driftZoom: 0,
    driftX: 0,
    pullAt: 40,
    pullFrames: 15,
    focusX: 0.5,
    focusY: 0.5,
    midScale: 2.2,
    secondFrames: 51,
  };
  assert.equal(pullOutScale(55, plan).scale, wallScale(55, 40, 4, 2.2).scale);
  for (let f = 0; f < 110; f += 5) {
    const p = pullOutPose(f, plan, 1920, 1080);
    assert.ok(p.x <= 1e-6 && p.x + 1920 * p.scale >= 1920 - 1e-6, `edges at ${f}`);
  }
  const cues = populatePullOutCues(plan, [8]);
  assert.deepEqual(
    cues.map((c) => c.frame),
    [8, 40],
  );
  // The default variant is untouched.
  assert.equal(populatePullOutDefaults.variant, "single");
});

test("video wall: white tiles resolve ring by ring outward from the centre, each in about 8 frames", () => {
  const tiles = wallTiles(14, 5);
  assert.equal(tiles.length, 70);
  const plan = wallPlan(tiles, 14, 8);
  const centre = plan[2 * 14 + 7]!;
  const corner = plan[0]!;
  assert.equal(centre.resolveEnd - centre.resolveAt, 8);
  assert.ok(centre.at < corner.at, "centre first");
  assert.ok(Math.max(...plan.map((e) => e.at)) - 8 <= 10, "the whole wall appears within about 10 frames");
});

// ---------------------------------------------------------------------------------------------------------------- E6

test("image card: abdulah's card in the right third on paper; the second card cuts on at its frame", () => {
  assert.equal(IMAGE_CARD_PAPER, "#F8F6F2");
  assert.deepEqual(imageCardRect(1920, 1080), { x: 0.56, y: 0.275, w: 0.25, h: 0.45 });
  const v = imageCardRect(1080, 1920);
  assert.ok(v.x > 0 && v.x + v.w < 1 && v.y > 0 && v.y + v.h < 1);
  assert.equal(secondCardPose(10, 12).shown, false);
  assert.deepEqual(secondCardPose(12, 12), { shown: true, rotate: 3, x: 0.07, y: -0.05 });
  assert.equal(secondCardPose(500, -1).shown, false);
});

// ---------------------------------------------------------------------------------------------------------------- E7

test("defocus ramp: zero before, sine.inOut over about 0.75 s, held at the maximum", () => {
  assert.equal(defocusRamp(20, 24), 0);
  assert.equal(defocusRamp(46, 24, 22, 24), 24);
  assert.equal(defocusRamp(90, 24, 22, 24), 24);
  assert.ok(Math.abs(defocusRamp(35, 24, 22, 24) - 12) < 1e-9, "half way at half time");
  assert.ok(defocusRamp(27, 24, 22, 24) < 24 * 0.1, "starts gently, as gojiberry does");
});

// ------------------------------------------------------------------------- video wall scroll, curve, vignette (E5)

test("video wall scroll: neighbouring columns move in opposite directions and wrap as endless feeds", () => {
  const pitch = 0.2;
  assert.equal(wallScrollY(0.1, 0, 50, 0, pitch, 6), 0.1, "off by default");
  const down = wallScrollY(0.1, 0, 5, WALL_SCROLL, pitch, 6) - 0.1;
  const up = wallScrollY(0.1, 1, 5, WALL_SCROLL, pitch, 6) - 0.1;
  assert.ok(Math.abs(down - 5 * WALL_SCROLL * pitch) < 1e-12 && Math.abs(up + 5 * WALL_SCROLL * pitch) < 1e-12);
  for (let f = 0; f < 2000; f += 37) {
    const y = wallScrollY(0.1, f % 2, f, 0.05, pitch, 6);
    assert.ok(y >= -pitch - 1e-9 && y < pitch * 5 + 1e-9, `inside the column span at ${f}`);
  }
  // Tiles of one column stay one pitch apart while they scroll.
  const a = wallScrollY(0, 0, 13, 0.05, pitch, 6);
  const b = wallScrollY(pitch, 0, 13, 0.05, pitch, 6);
  assert.ok(Math.abs(((b - a + 6 * pitch) % (6 * pitch)) - pitch) < 1e-9);
});

test("video wall curve: flat at 0; on the cylinder the middle stays put, edges come in and narrow, and the width still fills", () => {
  assert.deepEqual(wallCurve(0.2, 0), { cx: 0.2, scaleX: 1, scaleY: 1 });
  assert.ok(Math.abs(wallCurve(0.5, WALL_CURVE).cx - 0.5) < 1e-12);
  assert.ok(
    Math.abs(wallCurve(1, WALL_CURVE).cx - 1) < 1e-12 && Math.abs(wallCurve(0, WALL_CURVE).cx) < 1e-12,
    "the wall still spans the stage",
  );
  const edge = wallCurve(0.97, WALL_CURVE);
  const mid = wallCurve(0.53, WALL_CURVE);
  assert.ok(edge.scaleX < mid.scaleX && edge.scaleY < mid.scaleY, "outer columns narrower and shorter");
  assert.ok(WALL_VIGNETTE > 0 && WALL_VIGNETTE <= 1);
});

// ------------------------------------------------------------------------------- ui-punch-reframe nexaa settle (6.45-7.15 s)

test("ui-punch-reframe nexaa settle: the cut-in keeps its scale and slides right 0.125 W on expo.out (42%, 79%, 92%, 98%)", () => {
  const shots = [
    { at: 0, scale: 1, x: 0.5, y: 0.5 },
    { at: 18, scale: 2, x: 0.5, y: 0.5 },
  ];
  const pose = (f: number) => reframePose(f, shots, 1920, 1080, uiPunchReframeNexaaSettle);
  const rest = pose(60);
  assert.equal(pose(18).scale, 2, "scale is constant from the cut");
  const done = (seconds: number) => (pose(18 + seconds * 30).x - pose(18).x) / (rest.x - pose(18).x);
  assert.ok(Math.abs(rest.x - pose(18).x - 0.125 * 1920) < 1, "slides right by 0.125 of the width");
  for (const [seconds, share] of [
    [0.04, 0.45],
    [0.12, 0.75],
    [0.21, 0.88],
    [0.29, 0.95],
  ] as const)
    assert.ok(Math.abs(done(seconds) - share) < 0.08, `${seconds} s: ${done(seconds)}`);
  assert.deepEqual(
    reframePose(25, shots, 1920, 1080, { settlePan: 0 }),
    reframePose(25, shots, 1920, 1080),
    "default: no pan",
  );
});

// ------------------------------------------------------------------------------------- scene-end-card typed (A5, t17)

test("end card typed wordmark: a letter every 3 frames from revealAt, each tinted then ink 5 frames after (motionfly t17)", () => {
  assert.equal(END_CARD_TYPE_EVERY, 3);
  assert.equal(endCardTyped(7, 8, 3, 8), 0);
  assert.equal(endCardTyped(8, 8, 3, 8), 1);
  assert.equal(endCardTyped(10, 8, 3, 8), 1);
  assert.equal(endCardTyped(11, 8, 3, 8), 2);
  assert.equal(endCardTyped(200, 8, 3, 8), 8);
  // motionfly: F787 to about F818 for its wordmark, a letter about every 3 frames.
  assert.equal(endCardLetterAt(10, 787, 3), 817);
  const at = endCardLetterAt(2, 8, 3);
  assert.equal(arrivalTint(at, at, END_CARD_TINT, "#030303", END_CARD_TINT_FRAMES), END_CARD_TINT[0]);
  assert.equal(arrivalTint(at + 1, at, END_CARD_TINT, "#030303", END_CARD_TINT_FRAMES), END_CARD_TINT[1]);
  assert.equal(arrivalTint(at + END_CARD_TINT_FRAMES, at, END_CARD_TINT, "#030303", END_CARD_TINT_FRAMES), "#030303");
  assert.equal(sceneEndCardSchema.parse(sceneEndCardTypedPreset).wordmarkEntry, "type");
  assert.equal(sceneEndCardDefaults.wordmarkEntry, undefined, "the default still slides");
  assert.equal(sceneEndCardCues(sceneEndCardTypedPreset, 75)[1]!.sfx, "tick");
  assert.equal(sceneEndCardCues(sceneEndCardDefaults, 75)[1]!.sfx, "whoosh");
});
