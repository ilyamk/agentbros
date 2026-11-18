import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_RUBRIC_VERSION,
  IDEA_AXES,
  MAX_LOOPBACKS,
  PAIRWISE_TOP,
  READING_OVERRUN_CAP,
  RUBRIC_FILES,
  RUBRIC_VERSIONS,
  SCRIPT_AXES,
  THRESHOLD,
  agreedPairs,
  passes,
  rank,
  requiredOrders,
} from "../src/lib/film/creative-rubric";

const REPO = path.resolve(import.meta.dirname, "..");

/** A benchmark is scored with v1: changing the anchors or the threshold needs a new version, not an edit. */
test("creative rubric v1 is frozen: anchors file, axes and threshold", () => {
  const text = readFileSync(path.join(REPO, RUBRIC_FILES[1]), "utf8");
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    "0a00d1d8d27a139ae9d889d0b635bdab404365d5ad113324efe1f2c639a836ae",
  );
  assert.deepEqual([...RUBRIC_VERSIONS], [1, 2]);
  assert.deepEqual(
    [...IDEA_AXES],
    ["picture", "hook", "distinctiveness", "truth", "feasibility", "ambition", "native"],
  );
  assert.deepEqual([...SCRIPT_AXES], ["hookLine", "truth", "reading", "musicFit", "oneMessage"]);
  assert.deepEqual(THRESHOLD, { minAxis: 3, minTruth: 4, minMean: 3.6 });
  assert.deepEqual([PAIRWISE_TOP, MAX_LOOPBACKS, READING_OVERRUN_CAP], [6, 2, 2]);
  for (const axis of [...IDEA_AXES, ...SCRIPT_AXES]) assert.match(text, new RegExp(`^### ${axis}\\b`, "m"), axis);
});

/** v2 keeps v1's axes, threshold and ranking (the constants above are shared); only the distinctiveness anchor differs. */
test("creative rubric v2 is frozen, the default for new projects, with every axis v1 has", () => {
  const text = readFileSync(path.join(REPO, RUBRIC_FILES[2]), "utf8");
  assert.equal(
    createHash("sha256").update(text).digest("hex"),
    "78fa87188f544bfd407e46d7984819a81260c7a73f10471a2750a6b33654dd6f",
  );
  assert.equal(DEFAULT_RUBRIC_VERSION, 2);
  for (const axis of [...IDEA_AXES, ...SCRIPT_AXES]) assert.match(text, new RegExp(`^### ${axis}\\b`, "m"), axis);
  assert.match(text, /strongestAlternative/);
});

const axes = (value: number, overrides: Record<string, number> = {}) => ({
  ...Object.fromEntries(IDEA_AXES.map((axis) => [axis, value])),
  ...overrides,
});

test("an item passes with every axis at 3 or more, truth at 4 or more and a mean of 3.6", () => {
  assert.equal(passes(axes(4)), true);
  assert.equal(passes(axes(4, { native: 2 })), false, "one axis under 3");
  assert.equal(passes(axes(5, { truth: 3 })), false, "truth under 4");
  assert.equal(passes(axes(3, { truth: 4 })), false, "mean 3.14");
});

test("a pair counts only when both orders agree; disagreement is dropped as position bias", () => {
  const pairs = agreedPairs([
    { first: "A", second: "B", winner: "A" },
    { first: "B", second: "A", winner: "A" },
    { first: "A", second: "C", winner: "A" },
    { first: "C", second: "A", winner: "C" },
    { first: "B", second: "C", winner: "tie" },
    { first: "C", second: "B", winner: "tie" },
    { first: "D", second: "A", winner: "D" },
  ]);
  const find = (a: string, b: string) => pairs.find((pair) => pair.a === a && pair.b === b)!;
  assert.deepEqual([find("A", "B").agreed, find("A", "B").winner], [true, "A"]);
  assert.equal(find("A", "C").agreed, false);
  assert.equal(find("B", "C").agreed, false, "a tie in both orders decides nothing");
  assert.equal(find("A", "D").agreed, false, "one order alone decides nothing");
  assert.equal(requiredOrders(["A", "B", "C"]).length, 6);
});

test("ranking: agreed pairwise wins reorder the top, passing items lead, and no pass means below-threshold", () => {
  const items = [
    { id: "I1", axes: axes(4), order: 0 },
    { id: "I2", axes: axes(4, { picture: 5 }), order: 1 },
    { id: "I3", axes: axes(3), order: 2 },
  ];
  const both = (winner: string, loser: string) => [
    { first: winner, second: loser, winner },
    { first: loser, second: winner, winner },
  ];
  const result = rank(items, [...both("I1", "I2"), ...both("I3", "I1"), ...both("I3", "I2")]);
  assert.deepEqual(
    result.ranking,
    ["I1", "I2", "I3"],
    "I3 wins every pair but fails the threshold, so it ranks after the passing ones",
  );
  assert.deepEqual(result.passing, ["I1", "I2"]);
  assert.equal(result.verdict, "pass");
  const noPairs = rank(items, []);
  assert.deepEqual(noPairs.ranking, ["I2", "I1", "I3"], "without agreed pairs, mean order");
  assert.equal(rank([{ id: "X", axes: axes(3), order: 0 }], []).verdict, "below-threshold");
});
