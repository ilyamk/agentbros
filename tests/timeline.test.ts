import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileTimeline } from "../src/lib/timeline";
import type { Scene } from "../src/types/video";
const scene = (id: string, extra: Partial<Scene> = {}): Scene => ({
  id,
  text: id,
  visualType: "title",
  durationInFrames: 90,
  ...extra,
});
test("promo cuts and custom dissolves share metadata timing", () => {
  const t = compileTimeline([
    scene("a", { transitionDurationFrames: 6 }),
    scene("b", { transitionToNext: "cut" }),
    scene("c"),
  ]);
  assert.equal(t.durationInFrames, 264);
  assert.deepEqual(
    t.entries.map((e) => e.startFrame),
    [0, 84, 174],
  );
});
test("legacy daily-practice padded source windows play every source frame exactly once", () => {
  const project = JSON.parse(
    readFileSync(new URL("./fixtures/legacy/daily-practice/project.json", import.meta.url), "utf8"),
  );
  const t = compileTimeline(project.scenes, { talkingHead: true });
  assert.equal(t.contiguousPresenter, true);
  assert.equal(t.durationInFrames, 450);
  assert.deepEqual(
    t.entries.map((e) => [e.sourceStartFrame, e.sourceEndFrame]),
    [
      [0, 105],
      [105, 210],
      [210, 390],
      [390, 450],
    ],
  );
});
test("presenter source edits stay serial instead of overlapping audio", () => {
  const t = compileTimeline(
    [
      scene("a", { presenterStartSec: 2, presenterEndSec: 4 }),
      scene("b", { presenterStartSec: 5, presenterEndSec: 7, transitionToNext: "cut" }),
    ],
    { talkingHead: true },
  );
  assert.equal(t.durationInFrames, 120);
  assert.equal(t.contiguousPresenter, false);
  assert.deepEqual(
    t.entries.map((e) => e.startFrame),
    [0, 60],
  );
});
test("legacy duration-only talking-head retains wall clock", () => {
  assert.equal(compileTimeline([scene("a"), scene("b")], { talkingHead: true }).durationInFrames, 168);
});
test("invalid and oversized transitions fail instead of yielding black tails", () => {
  assert.throws(() => compileTimeline([scene("a", { durationInFrames: 5 }), scene("b")]));
  assert.throws(() =>
    compileTimeline([scene("a", { presenterStartSec: 4, presenterEndSec: 2 })], { talkingHead: true }),
  );
  assert.throws(() => compileTimeline([]));
});
