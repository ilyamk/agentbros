import assert from "node:assert/strict";
import test from "node:test";
import { answerBlockHeight, wrapLines } from "../src/motion/library/ui/AiChat";

test("wrapLines wraps greedily by word", () => {
  assert.equal(wrapLines("", 500, 34), 1);
  assert.equal(wrapLines("short answer", 1300, 34), 1);
  const long =
    "Here is a five-day plan built from the twelve things in your fridge, with one shopping list for the four items you are missing.";
  assert.equal(wrapLines(long, 1316, 34), 2);
  assert.ok(wrapLines(long, 400, 34) >= 6);
});

test("answerBlockHeight grows with lines and the label, and never drops below the avatar", () => {
  const one = answerBlockHeight("Done.", undefined, 1300, 34);
  assert.ok(Math.abs(one - (4 + 34 * 1.45 + 26)) < 1e-9);
  assert.equal(answerBlockHeight("Done.", undefined, 1300, 20), 52 + 26);
  const withLabel = answerBlockHeight("Done.", "Worked for 41s", 1300, 34);
  assert.ok(withLabel > one);
  assert.ok(
    answerBlockHeight("word ".repeat(80), undefined, 1300, 34) >
      answerBlockHeight("word ".repeat(20), undefined, 1300, 34),
  );
});
