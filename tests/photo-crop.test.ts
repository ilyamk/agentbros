import assert from "node:assert/strict";
import test from "node:test";
import {
  cropAt,
  FRAME_ASPECT,
  frameCrop,
  fromCanvas,
  moveProgress,
  moveRate,
  orientation,
  planMove,
  suggestMove,
  type Rect,
} from "../src/lib/photo/crop";

const near = (a: number, b: number, eps = 1e-3) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);
const inside = (r: Rect) => r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= 1 + 1e-6 && r.y + r.h <= 1 + 1e-6;
const holds = (outer: Rect, inner: Rect) =>
  inner.x >= outer.x - 1e-4 &&
  inner.y >= outer.y - 1e-4 &&
  inner.x + inner.w <= outer.x + outer.w + 1e-4 &&
  inner.y + inner.h <= outer.y + outer.h + 1e-4;
const pxAspect = (r: Rect, imageAspect: number) => (r.w * imageAspect) / r.h;

test("frameCrop: cover gives the frame's aspect inside the image, centred on the box when it can", () => {
  const ia = 4 / 3;
  const crop = frameCrop({ x: 0.45, y: 0.4, w: 0.1, h: 0.1 }, ia, FRAME_ASPECT.vertical, "cover");
  near(pxAspect(crop, ia), 9 / 16);
  near(crop.x + crop.w / 2, 0.5);
  assert.ok(inside(crop));
  const edge = frameCrop({ x: 0.95, y: 0.9, w: 0.05, h: 0.05 }, ia, FRAME_ASPECT.vertical, "cover");
  assert.ok(inside(edge), JSON.stringify(edge));
  const huge = frameCrop({ x: 0, y: 0, w: 1, h: 1 }, ia, FRAME_ASPECT.vertical, "cover");
  near(huge.h, 1);
  near(pxAspect(huge, ia), 9 / 16);
});

test("frameCrop: blur shows a portrait photo whole in a landscape frame, centred, never wider than contain", () => {
  const ia = 3 / 4;
  const crop = frameCrop({ x: 0, y: 0, w: 1, h: 1 }, ia, FRAME_ASPECT.landscape, "blur");
  near(crop.y, 0);
  near(crop.h, 1);
  near(crop.x + crop.w / 2, 0.5);
  assert.ok(crop.w > 1, "the frame is wider than the photo, the fill shows at the sides");
  near(pxAspect(crop, ia), 16 / 9);
});

test("moveProgress: eased curves keep a slope floor so their tails never stop", () => {
  for (const easing of ["ease-in", "ease-out", "ease-in-out"] as const) {
    assert.equal(moveProgress(0, easing), 0);
    assert.equal(moveProgress(1, easing), 1);
    const dt = 1e-4;
    for (const t of [0, 0.999])
      assert.ok((moveProgress(t + dt, easing) - moveProgress(t, easing)) / dt >= 0.34, `${easing} at ${t}`);
  }
  near(moveProgress(0.3, "linear"), 0.3, 1e-9);
});

test("cropAt: zoom is geometric and the fixed point stays put", () => {
  const from = { x: 0, y: 0, w: 1, h: 1 },
    to = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 };
  near(cropAt(from, to, 0.5).w, 0.5);
  const fixed = { x: 2 / 3, y: 2 / 3 };
  for (const p of [0.25, 0.5, 0.75]) {
    const c = cropAt(from, to, p);
    near((fixed.x - c.x) / c.w, 2 / 3);
  }
  const pan = cropAt({ x: 0, y: 0, w: 0.5, h: 0.5 }, { x: 0.5, y: 0, w: 0.5, h: 0.5 }, 0.5);
  near(pan.x, 0.25);
});

test("planMove: a cubic ease-out at 1% a second fails the floor, linear 2% passes, and slow moves are carried further", () => {
  const ia = 1,
    from = { x: 0, y: 0, w: 1, h: 1 };
  const slowTo = cropAt(from, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, Math.log(1 / 0.96) / Math.log(2));
  near(moveRate(from, slowTo, 4), 0.0102, 1e-3);
  const ok = planMove({
    from,
    to: cropAt(from, { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, Math.log(Math.exp(0.08)) / Math.log(2)),
    imageAspect: ia,
    frameAspect: 1,
    fill: "cover",
    durationSec: 4,
    easing: "linear",
  });
  assert.equal(ok.adjusted, false);
  assert.equal(ok.tooSlow, false);
  const eased = planMove({
    from,
    to: slowTo,
    imageAspect: ia,
    frameAspect: 1,
    fill: "cover",
    durationSec: 4,
    easing: "ease-out",
  });
  assert.equal(eased.adjusted, true);
  assert.ok(eased.slowestPerSec >= 0.02 - 1e-6, JSON.stringify(eased));
  near(eased.to.x + eased.to.w / 2, 0.5);
  const still = planMove({
    from,
    to: from,
    imageAspect: ia,
    frameAspect: 1,
    fill: "cover",
    durationSec: 3,
    easing: "linear",
  });
  assert.ok(still.ratePerSec >= 0.02 - 1e-6 && still.to.w < 1);
});

test("suggestMove: a single face is pushed in to head and shoulders and never cut, in every format", () => {
  const face = { x: 0.62, y: 0.3, w: 0.08, h: 0.1 };
  for (const format of ["vertical", "square", "landscape"] as const) {
    const s = suggestMove({ width: 4032, height: 3024, faces: [face], format, durationSec: 4 });
    assert.equal(s.fill, "cover", format);
    assert.ok(inside(s.from) && inside(s.to), format);
    assert.ok(holds(s.to, face) && holds(s.from, face), `${format} ${JSON.stringify(s)}`);
    assert.ok(s.to.w < s.from.w && s.ratePerSec >= 0.02 && !s.tooSlow, `${format} ${JSON.stringify(s)}`);
    near(pxAspect(s.to, 4032 / 3024), FRAME_ASPECT[format]);
    const out = suggestMove({ width: 4032, height: 3024, faces: [face], format, durationSec: 4, direction: "out" });
    assert.deepEqual([out.from, out.to], [s.to, s.from]);
  }
});

test("suggestMove: a wide group in a landscape photo for a vertical frame goes whole over a blurred fill", () => {
  const faces = [0.08, 0.3, 0.52, 0.75].map((x) => ({ x, y: 0.35, w: 0.08, h: 0.1 }));
  const s = suggestMove({ width: 4000, height: 3000, faces, format: "vertical", durationSec: 4 });
  assert.equal(s.fill, "blur");
  for (const face of faces) assert.ok(holds(s.from, face) && holds(s.to, face), JSON.stringify(s));
  const couple = suggestMove({
    width: 4000,
    height: 3000,
    faces: faces.slice(1, 3),
    format: "vertical",
    durationSec: 4,
  });
  assert.equal(couple.fill, "cover");
});

test("suggestMove: no subject pushes in on the centre; the enlargement limit yields to the minimum speed", () => {
  const s = suggestMove({ width: 3000, height: 2000, faces: [], format: "landscape", durationSec: 4 });
  near(s.to.x + s.to.w / 2, 0.5);
  assert.ok(s.upscale <= 1.5 + 1e-3 || s.tooSlow, JSON.stringify(s));
  const tiny = suggestMove({ width: 1280, height: 720, faces: [], format: "landscape", durationSec: 4 });
  assert.ok(!tiny.tooSlow && tiny.upscale > 1.5, `motion wins over the enlargement limit: ${JSON.stringify(tiny)}`);
});

test("fromCanvas maps a box on the padded square canvas back to the photo; orientation reads display size", () => {
  const box = fromCanvas({ x: 0.25, y: 0.1, w: 0.1, h: 0.1 }, 1280, 960, 1280);
  near(box.x, (0.25 * 1280) / 960);
  near(box.y, 0.1);
  near(box.w, 128 / 960);
  assert.deepEqual(fromCanvas({ x: 0.7, y: 0.9, w: 0.2, h: 0.2 }, 1280, 960, 1280).w, 1 - (0.7 * 1280) / 960);
  assert.equal(orientation(3024, 4032), "portrait");
  assert.equal(orientation(4032, 3024), "landscape");
  assert.equal(orientation(1000, 1010), "square");
});

test("suggestMove: a large portrait face keeps cover in square and landscape when the cover crop holds it", () => {
  const face = { x: 0.2773, y: 0.2272, w: 0.3999, h: 0.3996 };
  const square = suggestMove({ width: 2200, height: 2835, faces: [face], format: "square", durationSec: 4 });
  assert.equal(square.fill, "cover", JSON.stringify(square));
  assert.ok(holds(square.from, face) && holds(square.to, face) && inside(square.from) && inside(square.to));
  const landscape = suggestMove({ width: 2200, height: 2835, faces: [face], format: "landscape", durationSec: 4 });
  assert.equal(landscape.fill, "blur", "a 16:9 crop of a portrait is too short for the face with its margin");
});

test("suggestMove: a person box only aims the push; it never forces a blur fill", () => {
  const ghost = { x: 0.02, y: 0.1, w: 0.96, h: 0.8 };
  const s = suggestMove({ width: 4000, height: 3000, faces: [], people: [ghost], format: "vertical", durationSec: 4 });
  assert.equal(s.fill, "cover");
  assert.ok(inside(s.from) && inside(s.to) && s.ratePerSec >= 0.02);
});
