import assert from "node:assert/strict";
import test from "node:test";
import { glassLensCues, glassLensDefaults, glassLensSchema, lensPose } from "../src/motion/library/camera/GlassLens";
import { elasticBoxRect, planCaptionFrame, presetLayout } from "../src/motion/library/captions/plan";
import { captionStyleSchema, elasticWordBoxPreset } from "../src/motion/library/captions/style";
import {
  pageTurnCues,
  pageTurnDefaults,
  pageTurnPose,
  pageTurnSchema,
} from "../src/motion/library/transitions/PageTurn";
import {
  stateMorphCues,
  stateMorphDefaults,
  stateMorphPose,
  stateMorphSchema,
} from "../src/motion/library/ui/StateMorph";
import { swipeDeckCues, swipeDeckDefaults, swipeDeckPose, swipeDeckSchema } from "../src/motion/library/ui/SwipeDeck";

test("action morph lands, holds during processing, then reveals the result on its own cue", () => {
  const p = stateMorphDefaults;
  assert.deepEqual(stateMorphPose(p.at, p), { close: 0, open: 0, incoming: 0 });
  assert.deepEqual(stateMorphPose(p.readyAt, p), { close: 1, open: 0, incoming: 0 });
  const result = stateMorphCues(p)[1]!.frame;
  assert.deepEqual(stateMorphPose(result, p), { close: 1, open: 1, incoming: 1 });
  assert.deepEqual(stateMorphPose(result + 12, p), stateMorphPose(result, p));
  assert.equal(stateMorphSchema.safeParse({ ...p, readyAt: p.at + p.moveFrames - 1 }).success, false);
});

test("the second card rises before the departing one leaves and remains settled through the next cue", () => {
  const p = swipeDeckDefaults;
  const halfway = p.at + Math.floor(p.moveFrames / 2);
  assert.ok(swipeDeckPose(halfway, 0, p).exit > 0);
  assert.ok(swipeDeckPose(halfway, 1, p).depth < swipeDeckPose(p.at, 1, p).depth);
  const landing = swipeDeckCues(p)[0]!.frame;
  assert.equal(swipeDeckPose(landing, 0, p).show, false);
  assert.deepEqual(swipeDeckPose(landing, 1, p), { depth: 0, exit: 0, show: true });
  assert.deepEqual(swipeDeckPose(p.at + p.step, 1, p), swipeDeckPose(landing, 1, p));
  assert.deepEqual(swipeDeckPose(1_000, p.cards.length - 1, p), { depth: 0, exit: 0, show: true });
  assert.equal(swipeDeckSchema.safeParse({ ...p, step: p.moveFrames - 1 }).success, false);
});

test("an elastic highlight stretches towards the next word in both directions and closes at its exact destination", () => {
  const left = { left: 10, top: 20, width: 25, height: 15 };
  const right = { ...left, left: 70 };
  const forward = elasticBoxRect(left, right, 14, 12, 6);
  const backward = elasticBoxRect(right, left, 14, 12, 6);
  assert.ok(forward.width > left.width && backward.width > right.width);
  assert.deepEqual(elasticBoxRect(left, right, 18, 12, 6), right);
  assert.deepEqual(elasticBoxRect(right, left, 18, 12, 6), left);
});

test("the caption planner restarts the elastic box in the new line and preserves legacy slide geometry", () => {
  const p = {
    ...elasticWordBoxPreset,
    active: { ...elasticWordBoxPreset.active, scale: 1 },
    language: "en" as const,
    entry: "none" as const,
    maxWords: 4,
    maxLines: 2,
    words: [
      { text: "Portable", start: 0.1, end: 0.5 },
      { text: "Continuity", start: 0.5, end: 1.2 },
    ],
  };
  assert.ok(captionStyleSchema.safeParse(p).success);
  const measure = { width: (word: string) => word.length * 0.67, ascent: () => 0.78, descent: () => 0.22 };
  const layout = {
    ...presetLayout(p, 1080, 1920),
    pages: [{ words: p.words, lines: [[0], [1]], start: 0.1, end: 1.2 }],
  };
  const elastic = planCaptionFrame(p, layout, measure, 15, 30, 1920)!;
  const settle = planCaptionFrame(p, layout, measure, 22, 30, 1920)!;
  const legacy = planCaptionFrame(
    { ...p, active: { ...p.active, boxMotion: "slide" } },
    layout,
    measure,
    15,
    30,
    1920,
  )!;
  assert.equal(elastic.words.length, 2);
  assert.ok(elastic.words[0]!.top < elastic.words[1]!.top);
  assert.equal(elastic.activeBox!.top, settle.activeBox!.top);
  assert.ok(elastic.activeBox!.width < settle.activeBox!.width);
  assert.ok(legacy.activeBox!.top < elastic.activeBox!.top);
  assert.deepEqual(planCaptionFrame(p, layout, measure, 15, 30, 1920), elastic);
});

test("lens travel holds its final point, clips edge stops and emits cues only for changed positions", () => {
  const p = glassLensDefaults;
  assert.deepEqual(lensPose(50, 1080, 1920, p), lensPose(94, 1080, 1920, p));
  assert.deepEqual(
    glassLensCues(p).map((cue) => cue.frame),
    [50],
  );
  assert.deepEqual(lensPose(0, 100, 200, { ...p, radius: 0.25, stops: [{ at: 0, x: 0, y: 1 }] }), {
    radius: 25,
    x: 25,
    y: 175,
  });
  assert.equal(glassLensSchema.safeParse({ ...p, stops: [p.stops[0], p.stops[0]] }).success, false);
});

test("the page fold crosses the centre on the seam and holds the exact new plate after the turn", () => {
  const p = pageTurnDefaults;
  const seam = pageTurnCues(p)[0]!.frame;
  assert.equal(pageTurnPose(seam - p.moveFrames / 2, p).fraction, 0);
  assert.equal(pageTurnPose(seam, p).fold, 0.5);
  assert.equal(pageTurnPose(seam + p.moveFrames / 2, p).fraction, 1);
  assert.deepEqual(pageTurnPose(130, p), pageTurnPose(180, p));
  assert.equal(pageTurnSchema.safeParse({ ...p, seamFrame: 1 }).success, false);
});
