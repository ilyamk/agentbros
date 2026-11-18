import test from "node:test";
import assert from "node:assert/strict";
import {
  backspaceChunks,
  caretFollow,
  caretOn,
  caretTextAt,
  caretTypingPlan,
  evenSchedule,
  newestWordAccent,
  pullOutScale,
  splitState,
} from "../src/motion/type-track";

const meanGap = (frames: number[]) => (frames.at(-1)! - frames[0]!) / (frames.length - 1);

test("evenSchedule keeps the mean pace exact, with or without jitter", () => {
  for (const pace of [1.05, 1.6, 2]) {
    const even = evenSchedule(31, 10, pace);
    assert.equal(even[0], 10);
    assert.ok(Math.abs(meanGap(even) - pace) < 0.05, `even ${pace}: ${meanGap(even)}`);
    const jittered = evenSchedule(31, 10, pace, 0.4, "seed");
    assert.ok(Math.abs(meanGap(jittered) - pace) < 0.05, `jitter ${pace}: ${meanGap(jittered)}`);
    for (let i = 1; i < jittered.length; i++) assert.ok(jittered[i]! >= jittered[i - 1]!, "never runs backwards");
  }
});

test("caretTypingPlan types, deletes by word down to the kept words, waits, then retypes", () => {
  const plan = caretTypingPlan({
    text: "The future will arrive",
    at: 4,
    framesPerChar: 1,
    backspaceAt: 40,
    keepWords: 1,
    backspaceStep: 2,
    emptyFrames: 6,
    retype: "past is here",
  });
  assert.equal(caretTextAt(3, plan), "");
  assert.equal(caretTextAt(4, plan), "T");
  assert.equal(caretTextAt(plan.typedEnd, plan), "The future will arrive");
  assert.equal(caretTextAt(40, plan), "The future will ");
  assert.equal(caretTextAt(42, plan), "The future ");
  assert.equal(caretTextAt(44, plan), "The ");
  // Six empty frames after the last chunk, then the retype on top of the kept word.
  assert.equal(plan.retypeAt, 50);
  assert.equal(caretTextAt(49, plan), "The ");
  assert.equal(caretTextAt(50, plan), "The p");
  assert.equal(caretTextAt(plan.end, plan), "The past is here");
  assert.equal(plan.keptLength, 4);
  assert.ok(plan.strings.includes("") && plan.strings.includes("The past is here"));
});

test("caretTypingPlan in word units and scramble mode", () => {
  const words = caretTypingPlan({ text: "Searching for a", at: 0, framesPerChar: 6, unit: "word" });
  assert.deepEqual(
    words.keys.map((key) => [key.frame, key.text]),
    [
      [0, "Searching "],
      [6, "Searching for "],
      [12, "Searching for a"],
    ],
  );
  const scramble = caretTypingPlan({
    text: "Old line",
    at: 0,
    framesPerChar: 1,
    backspaceAt: 20,
    retype: "New line",
    retypeMode: "scramble",
  });
  const last = scramble.keys.at(-1)!;
  assert.equal(last.kind, "scramble");
  assert.equal(last.text, "New line");
});

test("backspaceChunks removes one word with its space at a time", () => {
  assert.deepEqual(backspaceChunks("a bb ccc", 0), ["a bb ", "a ", ""]);
  assert.deepEqual(backspaceChunks("a bb ccc", 2), ["a bb "]);
});

test("caretOn is solid while typing and blinks on a 19-frame cycle when idle", () => {
  for (let f = 0; f < 10; f++) assert.equal(caretOn(100 + f, 100), true);
  for (let f = 10; f < 19; f++) assert.equal(caretOn(100 + f, 100), false);
  assert.equal(caretOn(119, 100), true);
  const onFrames = Array.from({ length: 190 }, (_, f) => caretOn(200 + f, 200)).filter(Boolean).length;
  assert.equal(onFrames, 100);
});

test("newestWordAccent holds the word while it types and for the accent frames after", () => {
  const plan = caretTypingPlan({ text: "ab cd", at: 0, framesPerChar: 1 });
  // frames: a0 b1 ' '2 c3 d4
  assert.deepEqual(newestWordAccent(0, plan, 4), { start: 0, end: 1 });
  assert.deepEqual(newestWordAccent(1, plan, 4), { start: 0, end: 2 });
  assert.deepEqual(newestWordAccent(4, plan, 4), { start: 3, end: 5 });
  assert.deepEqual(newestWordAccent(7, plan, 4), { start: 3, end: 5 });
  assert.equal(newestWordAccent(8, plan, 4), null);
  const words = caretTypingPlan({ text: "Searching for", at: 0, framesPerChar: 12, unit: "word" });
  assert.deepEqual(newestWordAccent(3, words, 4), { start: 0, end: 9 });
  assert.equal(newestWordAccent(4, words, 4), null);
});

test("caretFollow holds the caret at the anchor once the line passes it", () => {
  const x = (f: number) => 100 + f * 20;
  assert.equal(caretFollow(10, x, { anchor: 600, smooth: 1 }), 0);
  assert.equal(caretFollow(40, x, { anchor: 600, smooth: 1 }), 600 - 900);
  const smooth = caretFollow(40, x, { anchor: 600, smooth: 4 });
  assert.ok(smooth > -300 && smooth < -240, String(smooth));
});

test("splitState: gap opens accelerating, insert settles, fling clears the frame", () => {
  const base = {
    openAt: 10,
    openFrames: 5,
    gap: 150,
    insertAt: 16,
    settleFrames: 5,
    insertWidth: 400,
    margin: 30,
    mode: "part" as const,
    flingFrames: 13,
    flingDistance: 1200,
    flingScale: 1.6,
  };
  assert.deepEqual(splitState(9, base), { left: -0, right: 0, scale: 1, insert: 0 });
  const steps = [11, 12, 13, 14, 15].map((f) => splitState(f, base).right * 2);
  for (let i = 2; i < steps.length; i++)
    assert.ok(steps[i]! - steps[i - 1]! >= steps[i - 1]! - steps[i - 2]! - 1e-9, "accelerates");
  assert.equal(splitState(15, base).right * 2, 150);
  const settled = splitState(21, base);
  assert.equal(settled.right - settled.left, 460);
  assert.equal(settled.insert, 1);
  const fling = splitState(34, { ...base, mode: "fling" });
  assert.ok(fling.right > 1150 && fling.right <= 1200 && fling.scale > 1.59, String(fling.right));
});

test("pullOutScale holds near full size for a few frames, then brakes into 1 (nexaa's measured widths)", () => {
  assert.equal(pullOutScale(0, { at: 0, frames: 17, from: 2.5 }), 2.5);
  assert.equal(pullOutScale(17, { at: 0, frames: 17, from: 2.5 }), 1);
  // nexaa, as scale of the settled width: about 2.2 at a sixth of the time, 1.24 at 0.57, 1.02 at 0.86.
  const at = (share: number) => pullOutScale(Math.round(share * 17), { at: 0, frames: 17, from: 2.38 });
  assert.ok(Math.abs(at(0.18) - 2.2) < 0.25, String(at(0.18)));
  assert.ok(Math.abs(at(0.53) - 1.3) < 0.2, String(at(0.53)));
  assert.ok(at(0.88) < 1.06, String(at(0.88)));
});
