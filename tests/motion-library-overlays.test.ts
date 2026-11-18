import assert from "node:assert/strict";
import test from "node:test";
import {
  LOWER_THIRD_IN,
  LOWER_THIRD_OUT,
  lowerThirdCues,
  lowerThirdTimes,
} from "../src/motion/library/typography/lower-third-plan";
import {
  TOUCH_APPEAR,
  TOUCH_RELEASE,
  tapsFromCapture,
  touchCues,
  touchPoint,
  touchState,
  type Touch,
} from "../src/motion/library/ui/touch-math";

test("lower third: entrance, hold and an exit 55% of the entrance", () => {
  const t = lowerThirdTimes(10, 116);
  assert.equal(t.inAt, 10);
  assert.ok(t.settled > 10 + LOWER_THIRD_IN - 1);
  assert.equal(t.outAt, 116);
  assert.equal(t.gone, 116 + LOWER_THIRD_OUT);
  assert.ok(LOWER_THIRD_OUT >= LOWER_THIRD_IN * 0.5 && LOWER_THIRD_OUT <= LOWER_THIRD_IN * 0.6);
});

test("lower third: -1 holds to the end, and an exit before it settles waits for it", () => {
  assert.deepEqual(lowerThirdTimes(0, -1).gone, null);
  const early = lowerThirdTimes(20, 22);
  assert.equal(early.outAt, early.settled);
  const cues = lowerThirdCues({ inAt: 10, outAt: -1, name: "Анна" });
  assert.equal(cues.length, 1);
  assert.equal(cues[0]!.kind, "reveal");
  assert.equal(lowerThirdCues({ inAt: 10, outAt: 116, name: "Maya" })[1]!.frame, 116);
});

const tap: Touch = { at: 20, kind: "tap", x: 100, y: 200, hold: 5 };

test("touch: invisible outside its window, fades in before contact and is pressed while down", () => {
  assert.equal(touchState(20 - TOUCH_APPEAR - 1, tap), null);
  assert.equal(touchState(20 + 5 + TOUCH_RELEASE, tap), null);
  const before = touchState(19, tap)!;
  const down = touchState(23, tap)!;
  assert.ok(before.opacity > 0 && before.opacity < 1);
  assert.equal(down.opacity, 1);
  assert.ok(down.scale < 1, "pressed dot is smaller");
  assert.equal(down.tail, null);
  const leaving = touchState(28, tap)!;
  assert.ok(leaving.opacity < 1 && leaving.scale > down.scale);
});

test("touch: a swipe travels from its start to its end with a tail behind it", () => {
  const swipe: Touch = { at: 10, kind: "swipe", x: 0, y: 500, hold: 10, toX: 0, toY: 100 };
  assert.deepEqual(touchPoint(10, swipe), { x: 0, y: 500 });
  assert.deepEqual(touchPoint(20, swipe), { x: 0, y: 100 });
  assert.deepEqual(touchPoint(40, swipe), { x: 0, y: 100 });
  const mid = touchState(15, swipe)!;
  assert.ok(mid.y < 500 && mid.y > 100);
  assert.ok(mid.tail && mid.tail.y > mid.y, "tail trails behind the dot");
  assert.equal(touchState(15, { ...swipe, kind: "long" })!.y, 500);
});

test("touch: is a pure function of the frame", () => {
  const swipe: Touch = { at: 4, kind: "swipe", x: 10, y: 10, hold: 12, toX: 300, toY: 40 };
  for (let f = 0; f < 30; f++) assert.deepEqual(touchState(f, swipe), touchState(f, swipe));
});

test("tapsFromCapture keeps clicks only, in CSS pixels, at the film's frame rate", () => {
  const capture = {
    fps: 60,
    scale: 3,
    events: [
      { frame: 0, action: "navigate", text: "x" },
      { frame: 30, action: "hover", x: 5, y: 5 },
      { frame: 61, action: "click", x: 195, y: 420 },
      { frame: 120, action: "scroll" },
    ],
  };
  assert.deepEqual(tapsFromCapture(capture), [{ at: 31, kind: "tap", x: 195, y: 420, hold: 5 }]);
  assert.equal(tapsFromCapture(capture, { offset: 12 })[0]!.at, 43);
  assert.equal(tapsFromCapture({ ...capture, fps: 30 })[0]!.at, 61);
});

test("touch cues: one click per touch on its contact frame", () => {
  const cues = touchCues([tap, { at: 50, kind: "swipe", x: 0, y: 0, hold: 8, toX: 0, toY: 10 }]);
  assert.deepEqual(
    cues.map((c) => [c.frame, c.kind, c.sfx]),
    [
      [20, "click", "click"],
      [50, "click", "whoosh"],
    ],
  );
});
