import test from "node:test";
import assert from "node:assert/strict";
import {
  NOISE_MATTE_CURVES,
  noiseMatteAlpha,
  noiseMatteCoverLevel,
  noiseMatteEase,
  noiseMatteField,
  noiseMatteGradient,
  noiseMatteAcePreset,
  noiseMatteLevel,
  noiseMattePhases,
  noiseMatteWipeDefaults,
  noiseMatteWipeSchema,
} from "../src/motion/library/transitions/NoiseMatteWipe";
import {
  SLICE_PANELS_PEAK,
  sheetCoverPreset,
  sheetPeak,
  sliceCover,
  slicePanels,
  slicePanelsPeak,
  slicePanelsSchema,
} from "../src/motion/library/transitions/SlicePanels";
import {
  LIGHT_BURN_PEAK,
  edgeBloomPreset,
  edgeBloomRadius,
  leakFlashPreset,
  leakStep,
  lightBurn,
  lightBurnPeak,
  lightBurnSchema,
} from "../src/motion/library/transitions/LightBurn";
import {
  MATTE_FROM,
  frameToObjectDefaults,
  frameToObjectSchema,
  matteCollapsePreset,
  matteRect,
} from "../src/motion/library/transitions/FrameToObject";
import {
  causedMorph,
  causedMorphSchema,
  edgeSheenPreset,
  edgeSheenReach,
  windowPreset,
  windowState,
} from "../src/motion/library/transitions/CausedMorph";
import { coverScale, shapeWipe, shapeWipeEndScale } from "../src/motion/transitions";
import {
  pixelBlock,
  pixelMosaicPhases,
  pixelResolveDefaults,
  pixelResolveSchema,
  ringCellState,
  ringCells,
  ringFront,
} from "../src/motion/library/transitions/PixelResolve";

import {
  BRUSH_SETTLE_MUSE,
  brushMonogramPreset,
  brushOutline,
  brushSettleShare,
  brushWidth,
  lineDrawPlan,
  lineDrawSchema,
  penTip,
  penWritePreset,
  strokeEase,
} from "../src/motion/library/kinetic/line-draw-math";
import {
  TRAVEL_DISC_GROW,
  TRAVEL_DISC_SHARE,
  TRAVEL_FRAMES,
  TRAVEL_GLITCH_FOREN,
  morphMarkSchema,
  power3Out,
  travelGlitchState,
  travelLayout,
  travelPlan,
  travelState,
} from "../src/motion/library/kinetic/morph-mark-math";

const W = 1920;
const H = 1080;
const grid = Array.from({ length: 11 }, (_, i) => i / 10);

test("noise-matte-wipe: nothing is uncovered at the start and everything at the end, whatever the noise", () => {
  for (const feather of [0.01, 0.08, 0.4]) {
    for (const roughness of [0, 0.3, 1]) {
      for (const g of grid) {
        for (const n of grid) {
          const v = noiseMatteField(g, n, roughness);
          assert.equal(noiseMatteAlpha(v, noiseMatteLevel(0, feather), feather), 0, `p=0 g=${g} n=${n}`);
          assert.equal(noiseMatteAlpha(v, noiseMatteLevel(1, feather), feather), 1, `p=1 g=${g} n=${n}`);
        }
      }
    }
  }
});

test("noise-matte-wipe: the front leaves the origin first and the soft band is feather wide", () => {
  const level = noiseMatteLevel(0.4, 0.1);
  const near = noiseMatteAlpha(noiseMatteField(0.1, 0.5, 0.3), level, 0.1);
  const far = noiseMatteAlpha(noiseMatteField(0.9, 0.5, 0.3), level, 0.1);
  assert.ok(near > far);
  assert.ok(Math.abs(noiseMatteAlpha(0.3, 0.35, 0.1) - 0.5) < 1e-9, "half way through the band");
});

test("noise-matte-wipe: curves start at 0, end at 1 and power2.out front-loads like ace's smoke", () => {
  for (const curve of NOISE_MATTE_CURVES) {
    assert.ok(Math.abs(noiseMatteEase(curve, 0)) < 1e-9, curve);
    assert.ok(Math.abs(noiseMatteEase(curve, 1) - 1) < 1e-9, curve);
  }
  // ace: frame differences 33, 38, 30, 31, 30, 20, 12, 7, 4: most of the cover in the first half.
  assert.ok(noiseMatteEase("power2.out", 0.5) > 0.8);
  assert.ok(Math.abs(noiseMatteEase("power1.inOut", 0.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(noiseMatteEase("sine.inOut", 0.5) - 0.5) < 1e-9);
});

test("noise-matte-wipe: the reveal cut is where the curve crosses half; cover swaps scenes inside a full hold", () => {
  const reveal = noiseMattePhases("reveal", 0, "power1.inOut");
  assert.ok(Math.abs(reveal.cut - 0.5) < 1e-6);
  assert.ok(noiseMattePhases("reveal", 0, "power2.out").cut < 0.25);
  const cover = noiseMattePhases("cover", 0.14, "power2.inOut");
  assert.ok(cover.covered < cover.cut && cover.cut < cover.part);
  // muse: 2-3 frames of full cover in an 18-frame seam.
  const frames = 18;
  const full = Array.from({ length: frames + 1 }, (_, f) => f / frames).filter(
    (p) => noiseMatteCoverLevel(p, cover, "power2.inOut", 0.08).stage === "full",
  ).length;
  assert.ok(full >= 2 && full <= 3, `${full} full frames`);
  assert.equal(noiseMatteCoverLevel(0, cover, "power2.inOut", 0.08).level, 0, "the cover starts empty");
  const lastRise = noiseMatteCoverLevel(cover.covered - 1e-9, cover, "power2.inOut", 0.08).level;
  assert.ok(lastRise > 1.07, "the cover is complete when the hold starts");
  assert.ok(noiseMatteCoverLevel(cover.part, cover, "power2.inOut", 0.08).level < 1e-6, "the parting starts closed");
  assert.ok(noiseMatteCoverLevel(1 - 1e-9, cover, "power2.inOut", 0.08).level > 1.07, "and ends fully open");
});

test("noise-matte-wipe: gradients run from the origin to the far side", () => {
  assert.deepEqual(noiseMatteGradient("bottom-right", W, H), { kind: "radial", cx: W, cy: H, r: Math.hypot(W, H) });
  assert.deepEqual(noiseMatteGradient("right", W, H), { kind: "linear", x1: W, y1: 0, x2: 0, y2: 0 });
  assert.deepEqual(noiseMatteGradient("bottom", W, H), { kind: "linear", x1: 0, y1: H, x2: 0, y2: 0 });
  assert.ok(noiseMatteWipeSchema.safeParse(noiseMatteWipeDefaults).success);
});

test("pixel-resolve mosaic: blocks halve from the largest to full detail, front-loaded, never growing", () => {
  const from = 86;
  const sizes = Array.from({ length: 11 }, (_, i) => pixelBlock(i / 10, from, 5));
  assert.equal(sizes[0], from);
  assert.equal(sizes.at(-1), 1);
  for (let i = 1; i < sizes.length; i++) assert.ok(sizes[i]! <= sizes[i - 1]!, `frame ${i}`);
  for (const s of sizes) assert.ok([86, 43, 22, 11, 5, 3, 1].includes(s), `${s} is a halving`);
  // cashfree: the picture is readable within about 6 of 10 frames (power2.out).
  assert.ok(pixelBlock(0.6, from, 5) <= 3);
  assert.deepEqual(pixelMosaicPhases(3, 13), { flashEnd: 3 / 13 });
  assert.ok(pixelResolveSchema.safeParse(pixelResolveDefaults).success);
});

test("pixel-resolve ring: rings are grid bands around the origin cell, every cell ends inside", () => {
  const cell = 54;
  const cells = ringCells(W, H, cell, { x: W / 2, y: H / 2 }, 0, 3);
  assert.equal(cells.length, Math.ceil(W / cell) * Math.ceil(H / cell));
  const centre = cells.find((c) => c.x <= W / 2 && c.x + cell > W / 2 && c.y <= H / 2 && c.y + cell > H / 2)!;
  assert.equal(centre.rank, 0, "the origin's cell rings first");
  const maxRank = Math.max(...cells.map((c) => c.rank));
  assert.equal(ringFront(0, maxRank, 1, 3), 0);
  for (const c of cells) {
    assert.equal(ringCellState(c.rank, ringFront(0, maxRank, 1, 3), 1, 3).state, "outside");
    assert.equal(ringCellState(c.rank, ringFront(1, maxRank, 1, 3), 1, 3).state, "inside");
  }
  // Behind the front: solid ring, then a fade, then the new scene.
  assert.deepEqual(ringCellState(9.5, 10, 1, 3), { state: "ring", cover: 1 });
  assert.ok(Math.abs(ringCellState(7, 10, 1, 3).cover - 1 / 3) < 1e-9);
  assert.equal(ringCellState(2, 10, 1, 3).state, "inside");
  // sine.out: the ring is past half its reach before half the time.
  assert.ok(ringFront(0.5, maxRank, 1, 3) > 0.6 * ringFront(1, maxRank, 1, 3));
  const gapped = ringCells(W, H, cell, { x: W / 2, y: H / 2 }, 0.15, 3).filter((c) => c.gap).length / cells.length;
  assert.ok(gapped > 0.08 && gapped < 0.22, `${gapped} gaps`);
});

test("slice-panels sheet: one rising sheet, fast then a long tail, may stop short; the panels' defaults are unchanged", () => {
  // The default panels keep their look: five panels, expo.out, full reach, slide, sink 0.06.
  assert.deepEqual(slicePanels().props, {
    count: 5,
    direction: "up",
    spread: 0.38,
    shade: 0.55,
    curve: "expo.out",
    reach: 1,
    motion: "slide",
    sink: 0.06,
  });
  assert.equal(slicePanelsPeak({ count: 5 }), SLICE_PANELS_PEAK);
  assert.ok(slicePanelsSchema.safeParse(sheetCoverPreset).success);
  assert.ok(
    slicePanelsSchema.safeParse({ count: 5, direction: "up", spread: 0.38, shade: 0.55, transitionFrames: 22 }).success,
  );
  // flex: 6% to 55% of the height in 4 of 22 frames on power3.out, nearly full well before the end.
  const at = (f: number) => sliceCover(f / 22, "power3.out", 1);
  assert.ok(Math.abs(at(4) - 0.55) < 0.05, `${at(4)} after 4 frames`);
  assert.ok(at(12) > 0.86 && at(21) < 1);
  // reach below 1 cuts before the sheet is full.
  assert.ok(Math.abs(sliceCover(1, "power3.out", 0.9) - 0.9) < 1e-9);
  const peak = sheetPeak("power3.out", 1);
  assert.ok(Math.abs(sliceCover(peak, "power3.out", 1) - 0.5) < 1e-6 && peak < 0.2);
  assert.equal(slicePanelsPeak({ count: 1, curve: "power3.out", reach: 1 }), peak);
});

test("light-burn shapes: the sweep stays the default; the leak steps up and cuts after its brightest frame; the bloom closes edges first", () => {
  assert.equal(lightBurn().props.shape, "sweep");
  assert.equal(lightBurnPeak("sweep", 16), LIGHT_BURN_PEAK);
  assert.ok(lightBurnSchema.safeParse(leakFlashPreset).success && lightBurnSchema.safeParse(edgeBloomPreset).success);
  // abdulah: 1-3 flash frames, steps(1), the new plate on the frame after the brightest.
  const frames = 3;
  const steps = Array.from({ length: frames }, (_, f) => leakStep(f / frames, frames));
  assert.deepEqual(
    steps.map((s) => s.cut),
    [false, false, true],
  );
  assert.ok(
    steps[0]!.strength < steps[1]!.strength && steps[1]!.strength === 1,
    "brighter each frame, peak just before the cut",
  );
  assert.equal(lightBurnPeak("leak", frames), 2 / 3);
  assert.equal(leakStep(0, 2).cut, false);
  assert.equal(leakStep(0.5, 2).cut, true, "a two-frame seam is one flash frame and the cut");
  // flex: edges to centre in 10 frames on power2.out: the radius starts past the corners and ends at the centre.
  const feather = 0.8;
  assert.ok(edgeBloomRadius(0, feather) - feather >= 1, "nothing covered at the start");
  assert.equal(edgeBloomRadius(1, feather), 0);
  const r = (f: number) => edgeBloomRadius(f / 10, feather);
  assert.ok(r(0) - r(1) > r(8) - r(9), "fast front, decaying tail");
  assert.ok(
    Math.abs(edgeBloomRadius(lightBurnPeak("edges", 10), 1) - 1) < 1e-9,
    "the perceived cut is half the travel",
  );
});

test("shapeWipe feather: hard by default; a soft edge grows past the frame by its own width", () => {
  const wipe = shapeWipe({ originX: 0, originY: H });
  assert.equal(wipe.props.feather, 0);
  assert.equal(wipe.props.above, undefined);
  assert.equal(shapeWipeEndScale(0, H, W, H, 50, 0), coverScale(0, H, W, H, 50), "no feather, same end as before");
  // motionfly: a disc from the lower-left corner, soft by about 3% of the width; the last frame has no soft pixel left.
  const feather = 0.03 * W;
  const end = shapeWipeEndScale(0, H, W, H, 50, feather);
  assert.ok(Math.abs(end * 50 - (Math.hypot(W, H) + feather)) < 1e-6);
  assert.equal(shapeWipe({ originX: 0, originY: H, feather: -4 }).props.feather, 0);
});

test("frame-to-object matte: a 92% x 85% matte collapses into the target rect on power3.out and lands exactly on it", () => {
  const timing = { at: 0, frames: 12, ease: "power3.out" as const };
  const target = { x: 0.4, y: 0.45, width: 0.12, height: 0.006 };
  const start = matteRect(0, timing, MATTE_FROM, target, W, H);
  assert.ok(Math.abs(start.width - 0.92 * W) < 1e-9 && Math.abs(start.height - 0.85 * H) < 1e-9);
  assert.ok(Math.abs(start.x + start.width / 2 - W / 2) < 1e-9, "centred on the cut");
  const end = matteRect(12, timing, MATTE_FROM, target, W, H);
  assert.deepEqual(
    [end.x, end.y, end.width, end.height].map((v) => Math.round(v * 1000) / 1000),
    [0.4 * W, 0.45 * H, 0.12 * W, 0.006 * H].map((v) => Math.round(v * 1000) / 1000),
  );
  assert.ok(Math.abs(end.radius - end.height / 2) < 1e-9, "a pill-ended bar");
  // motionfly: frame differences 41, 33, 24, 16, 11, 6, 3: every step smaller than the one before.
  const step = (f: number) =>
    matteRect(f, timing, MATTE_FROM, target, W, H).width - matteRect(f + 1, timing, MATTE_FROM, target, W, H).width;
  for (let f = 1; f < 11; f++) assert.ok(step(f) < step(f - 1), `frame ${f}`);
  assert.ok(frameToObjectSchema.safeParse({ ...frameToObjectDefaults, ...matteCollapsePreset }).success);
  assert.ok(frameToObjectSchema.safeParse(frameToObjectDefaults).success, "the frame mode's defaults are untouched");
});

test("caused-morph window: drain, drift and rise in thirds; the edge sheen reaches further in as the button grows", () => {
  const button = { x: 900, y: 500, width: 100, height: 100 };
  const to = { x: W / 2, y: 0.42 * H, d: 0.34 * H };
  const s0 = windowState(0, button, to);
  assert.deepEqual([s0.phase, s0.drained, s0.cx, s0.cy, s0.d, s0.below], ["drain", 0, 950, 550, 100, 1]);
  // muse: 5 frames each in a 15-frame seam.
  assert.equal(windowState(1 / 3, button, to).drained, 1, "drained after the first third");
  assert.equal(windowState(1 / 3, button, to).cx, 950, "the disc has not moved yet");
  const s2 = windowState(2 / 3, button, to);
  assert.deepEqual([s2.phase, s2.cx, s2.cy, s2.d, s2.below], ["rise", to.x, to.y, to.d, 1]);
  const s3 = windowState(1 - 1e-9, button, to);
  assert.ok(s3.below < 1e-6, "the picture is in place at the end");
  assert.equal(windowState(1, button, to).phase, "done");
  assert.ok(causedMorphSchema.safeParse(windowPreset).success && causedMorphSchema.safeParse(edgeSheenPreset).success);
  // Defaults stay as they were: top sheen, no window.
  const plain = causedMorph({ fill: "#fff", colour: "#000" }).props;
  assert.equal(plain.mode, "rect");
  assert.equal(plain.sheenFrom, "top");
  assert.equal(edgeSheenReach(0), 0);
  assert.equal(edgeSheenReach(1), 1);
  assert.ok(edgeSheenReach(0.5) < 0.5, "slow at first, like the growth on power2.in");
});

test("kinetic-line-draw brush: the stroke touches down thin, swells, then tapers; the outline is a closed path", () => {
  assert.ok(brushWidth(0, 30, 0.5) < brushWidth(0.06, 30, 0.5));
  assert.equal(brushWidth(0.06, 30, 0), 30);
  assert.ok(brushWidth(1, 30, 0.5) < brushWidth(0.3, 30, 0.5));
  assert.equal(brushWidth(1, 30, 0.5), 15);
  const outline = brushOutline("M0,0 L100,0", 20, 0, 10);
  assert.match(outline, /^M.* Z$/);
  assert.equal(outline.split(" L").length, 22, "both sides, 11 samples each");
  assert.equal(brushOutline("M0,0", 20, 0), "", "a zero-length line has no outline");
  assert.equal(strokeEase(0), 0);
  assert.equal(strokeEase(1), 1);
  assert.ok(strokeEase(0.2) < 0.2 && strokeEase(0.8) > 0.8, "slow into each end");
});

test("kinetic-line-draw follower: the pen sits on the stroke tip and lifts before the first and after the last", () => {
  const props = penWritePreset;
  const plan = lineDrawPlan(props);
  assert.equal(penTip(props, plan.start - 0.01), null);
  assert.equal(penTip(props, plan.drawn + 0.3), null);
  const first = penTip(props, plan.start);
  assert.ok(first);
  assert.equal(first.stroke, 0);
  assert.deepEqual([Math.round(first.x), Math.round(first.y)], [40, 150], "starts at the first stroke's first point");
  const second = penTip(props, plan.starts[1]! + 0.01);
  assert.equal(second?.stroke, 1);
  const end = penTip(props, plan.drawn);
  assert.equal(end?.stroke, props.strokes.length - 1);
  assert.deepEqual([Math.round(end!.x), Math.round(end!.y)], [30, 120], "rests at the circle's end");
});

test("kinetic-line-draw presets parse and keep their measured timing", () => {
  const brush = lineDrawSchema.parse(brushMonogramPreset);
  assert.equal(brush.brush?.entryScale, 3);
  assert.equal(Math.round(brush.draw * 30), 13, "each stroke draws in 13 frames");
  assert.equal(brush.brush?.settle, BRUSH_SETTLE_MUSE, "but the scale settles over about 1.5 s");
  // muse F958-F1010: about 18% of the entry excess left after 12 frames, about 3% after 31.
  const left = (frames: number) => brushSettleShare(frames / 30, BRUSH_SETTLE_MUSE);
  assert.ok(left(12) > 0.1 && left(12) < 0.25, `12 frames: ${left(12)}`);
  assert.ok(left(31) < 0.05);
  assert.equal(brushSettleShare(0.5, 0.43), 0, "the old 13-frame settle was done long before");
  assert.equal(
    lineDrawSchema.parse({ ...brushMonogramPreset, brush: { ...brushMonogramPreset.brush!, settle: undefined } }).brush
      ?.settle,
    undefined,
    "absent: one draw, as before",
  );
  const pen = lineDrawSchema.parse(penWritePreset);
  assert.ok(pen.follower);
  assert.equal(pen.strokes.at(-1)?.accent, true, "the red circle is drawn last");
});

test("kinetic-morph-mark travel: foren's beats, a stepped mark, the disc ending as the full stop with the word whole", () => {
  const plan = travelPlan(6);
  assert.deepEqual(
    [
      plan.slices - plan.grow,
      plan.hold - plan.slices,
      plan.travel - plan.hold,
      plan.resolve - plan.travel,
      plan.done - plan.resolve,
    ],
    [6, 12, 6, 7, 10],
  );
  assert.equal(power3Out(0), 0);
  assert.equal(power3Out(1), 1);
  const layout = travelLayout(960, 540, 600, 200, 210);
  assert.ok(layout.stopX > layout.textLeft + layout.textWidth, "the stop sits after the word");
  assert.ok(
    Math.abs(layout.textLeft + (layout.stopX + layout.stopR - layout.textLeft) / 2 - 960) < 1e-9,
    "word and stop are centred together",
  );
  const at = (f: number) => travelState(f, 6, layout);
  assert.equal(at(5).r, 0, "nothing before the dot");
  // foren measured F133-F151: 0.135 W after 4 frames, 0.22 after 9, 0.266 (full) after 18, about power2.out.
  assert.ok(Math.abs(at(plan.grow + 4).r / 210 - 0.135 / 0.266) < 0.1, "about half grown after 4 frames");
  assert.ok(Math.abs(at(plan.grow + 9).r / 210 - 0.22 / 0.266) < 0.06, "about 83% after 9 frames");
  assert.equal(at(plan.grow + TRAVEL_DISC_GROW).r, 210, "grown to the disc in 18 frames, under the slices");
  assert.equal(TRAVEL_DISC_SHARE, 0.266);
  assert.equal(at(plan.slices - 1).slices, 0);
  const steps = new Set(Array.from({ length: TRAVEL_FRAMES.slices }, (_, i) => at(plan.slices + i).slices));
  assert.deepEqual([...steps], [1, 2, 3, 4], "stepped slices, no tween between them");
  assert.ok(at(plan.hold + 2).markOn && !at(plan.travel).markOn, "the mark goes on the first travel frame");
  assert.equal(at(plan.travel).clipRight, layout.textLeft, "no letters before the disc moves");
  for (let f = plan.travel; f < plan.done; f++)
    assert.ok(at(f).clipRight <= at(f).x - at(f).r + 1e-9, `letters stay behind the disc at ${f}`);
  const end = at(plan.done);
  assert.deepEqual([end.x, end.y, end.r], [layout.stopX, layout.stopY, layout.stopR]);
  assert.equal(end.clipRight, layout.textLeft + layout.textWidth);
});

test("noise-matte ace preset: an even front (linear, 13 frames) instead of power2.out's fast start; the new curves are GSAP's", () => {
  assert.deepEqual(noiseMatteAcePreset, { mode: "reveal", origin: "top-right", curve: "linear", transitionFrames: 13 });
  assert.equal(noiseMatteWipeSchema.parse({ ...noiseMatteWipeDefaults, ...noiseMatteAcePreset }).curve, "linear");
  assert.equal(noiseMatteWipeDefaults.curve, "power1.inOut", "the default stays flex's");
  // Over the first fifth power2.out has already moved about half; ace's covered share at that point is about 0.25.
  assert.ok(noiseMatteEase("power2.out", 0.2) > 0.45 && noiseMatteEase("linear", 0.2) < 0.25);
  assert.ok(Math.abs(noiseMatteEase("power1.out", 0.5) - 0.75) < 1e-12);
  assert.ok(Math.abs(noiseMatteEase("sine.out", 1 / 3) - 0.5) < 1e-12);
  for (const curve of NOISE_MATTE_CURVES) assert.equal(noiseMatteEase(curve, 1), 1, curve);
});

test("kinetic-morph-mark travel glitch: seeded colour copies to the right of the mark, closing in, clean mark last (foren F139-F150)", () => {
  const plan = travelPlan(6);
  const g = TRAVEL_GLITCH_FOREN;
  assert.deepEqual(travelGlitchState(plan.slices - 1, 6, g), { copies: [], clean: false });
  assert.deepEqual(travelGlitchState(plan.hold, 6, g), { copies: [], clean: true }, "clean once the slices end");
  assert.deepEqual(
    travelGlitchState(plan.slices, 6, g).copies.map((c) => c.ink),
    [g.inks[0]],
    "green first",
  );
  const late = travelGlitchState(plan.hold - 1, 6, g);
  assert.equal(late.copies.length, 3);
  assert.ok(late.clean, "the clean mark is in before the slices end");
  for (let f = plan.slices; f < plan.hold; f++) {
    const s = travelGlitchState(f, 6, g);
    assert.deepEqual(s, travelGlitchState(f, 6, g), "pure");
    for (const c of s.copies) assert.ok(c.dx > 0 && c.dx <= g.offset, `right of the mark, within the offset at ${f}`);
  }
  assert.ok(
    travelGlitchState(plan.slices, 6, g).copies[0]!.dx > travelGlitchState(plan.hold - 1, 6, g).copies[0]!.dx,
    "closing in",
  );
  assert.notDeepEqual(
    travelGlitchState(plan.slices + 8, 6, g),
    travelGlitchState(plan.slices + 8, 6, { ...g, seed: "other" }),
    "seeded",
  );
});

test("kinetic-morph-mark: the reveal is optional and validated", () => {
  const base = {
    shapes: ["M0,0 Z", "M1,1 Z"],
    wordmark: "A",
    color: "#000",
    accent: "#f00",
    background: "#fff",
    at: 6,
    morph: 0.5,
    hold: 0.1,
    turns: 1,
  };
  assert.equal(morphMarkSchema.parse(base).wordmarkReveal, undefined);
  assert.equal(morphMarkSchema.parse({ ...base, wordmarkReveal: "travel" }).wordmarkReveal, "travel");
  assert.throws(() => morphMarkSchema.parse({ ...base, wordmarkReveal: "spin" }));
});
