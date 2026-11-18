import test from "node:test";
import assert from "node:assert/strict";
import {
  desyncMap,
  linearMotionMap,
  pickSegments,
  rateString,
  shotStartsIn,
  stutterMap,
  uniformCutMap,
} from "../src/lib/reference/degrade";
import {
  assignBatches,
  calibrationReport,
  criticAccuracy,
  mergeCriticResults,
  minimumBatches,
  selectSensors,
  type PairReading,
} from "../src/lib/reference/calibrate";
import { CriticResultsSchema, type CriticKey } from "../src/types/calibration";

// The pure half of calibration: ref:degrade's frame maps and judge:calibrate's scoring. Media runs: reference-degrade.test.ts.

test("frame maps: stutter holds, desync shifts and clamps, uniform cuts are equal, linear motion evens the change", () => {
  assert.deepEqual(stutterMap(10, 7), [10, 10, 10, 13, 13, 13, 16]);
  assert.deepEqual(desyncMap(2, 4, 4, 100), [0, 0, 0, 1]);
  assert.deepEqual(desyncMap(10, 3, -4, 15), [14, 14, 14]);
  const { map, outStarts } = uniformCutMap(0, 12, [0, 2, 10]);
  assert.deepEqual(outStarts, [0, 4, 8]);
  // shot 1 (2 frames) held on its last frame; shot 2 (8 frames) cut short; shot 3 (2 frames) held.
  assert.deepEqual(map, [0, 1, 1, 1, 2, 3, 4, 5, 10, 11, 11, 11]);
  // Ease in: change grows with each frame. Linearised, the picked frames come early in the shot less often.
  const energy = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  const linear = linearMotionMap(0, energy, [0]);
  assert.equal(linear.length, 10);
  assert.equal(linear[0], 0);
  assert.equal(linear[9], 9);
  assert.ok(
    linear.every((frame, index) => index === 0 || frame >= linear[index - 1]!),
    "monotone",
  );
  assert.ok(linear[5]! > 5, `half the time reaches over half the frames when the motion eases in: ${linear}`);
  assert.deepEqual(linearMotionMap(0, [0, 0, 0, 0], [0]), [0, 1, 2, 3], "a still shot is left alone");
  assert.deepEqual(
    shotStartsIn(
      [12, 31],
      10,
      30,
      Array.from({ length: 30 }, (_, k) => (k === 3 ? 50 : 1)),
    ),
    [0, 3, 21],
  );
  assert.equal(rateString(30), "30");
  assert.equal(rateString(29.97002997), "30000/1001");
  assert.deepEqual(
    pickSegments({ durationSec: 10, count: 2, lengthSec: 3, cutsSec: [1, 3.6, 4.2, 6], energy: [] }).length,
    2,
  );
  const picked = pickSegments({ durationSec: 10, count: 2, lengthSec: 3, cutsSec: [1, 3.6, 4.2, 6] });
  assert.ok(picked[0]!.endSec <= picked[1]!.startSec, "no overlap");
});

const pair = (
  kind: PairReading["kind"],
  id: string,
  original: Record<string, number | undefined>,
  variant: Record<string, number | undefined>,
): PairReading => ({ manifest: "m.json", variantId: id, kind, original, variant });

test("calibrationReport: accuracy, eligibility at 0.85 on 6 pairs, controls' false alarms and which pair each sensor missed", () => {
  const sensors = selectSensors("shot-length-variety,fast-motion-sharp");
  const pairs: PairReading[] = [
    ...Array.from({ length: 6 }, (_, index) =>
      pair(
        "uniform-cuts",
        `u${index}`,
        { "shot-length-variety": 3, "fast-motion-sharp": 0.2 },
        { "shot-length-variety": 1.1, "fast-motion-sharp": 0.2 },
      ),
    ),
    ...[0.5, 0.6, 0.1, 0.1, 0.7, 0.9].map((value, index) =>
      pair(
        "stutter",
        `s${index}`,
        { "shot-length-variety": 2, "fast-motion-sharp": 0.1 },
        { "shot-length-variety": index === 0 ? 1 : 2, "fast-motion-sharp": value },
      ),
    ),
    pair("stutter", "s-unmeasured", { "shot-length-variety": 2 }, { "shot-length-variety": 2 }),
  ];
  const report = calibrationReport({ manifests: ["m.json"], sensors, pairs });
  const row = (sensor: string, kind: string) =>
    report.sensors.find((entry) => entry.sensor === sensor && entry.kind === kind)!;
  assert.deepEqual(
    [
      row("shot-length-variety", "uniform-cuts").n,
      row("shot-length-variety", "uniform-cuts").accuracy,
      row("shot-length-variety", "uniform-cuts").eligible,
    ],
    [6, 1, true],
  );
  // 0.1 against 0.1 twice: no change, so 4 of 6.
  assert.deepEqual(
    [
      row("fast-motion-sharp", "stutter").n,
      row("fast-motion-sharp", "stutter").detections,
      row("fast-motion-sharp", "stutter").accuracy,
      row("fast-motion-sharp", "stutter").eligible,
      row("fast-motion-sharp", "stutter").notMeasured,
    ],
    [6, 4, 0.667, false, 1],
  );
  assert.equal(row("shot-length-variety", "stutter").role, "control");
  assert.equal(row("shot-length-variety", "stutter").falseAlarms, 1, "variety halved on one stutter pair");
  assert.deepEqual(report.eligibleGates, [{ judge: "shot-length-variety", kind: "uniform-cuts", accuracy: 1, n: 6 }]);
  assert.deepEqual(
    report.failures
      .filter((failure) => failure.judge === "fast-motion-sharp")
      .map((failure) => [failure.variantId, failure.reason]),
    [
      ["s2", "no change"],
      ["s3", "no change"],
      ["s-unmeasured", "not measured on the original"],
    ],
  );
  assert.deepEqual(report.byKind["stutter"], { pairs: 7, sensors: { "fast-motion-sharp": 0.667 } });
  // Five pairs at full accuracy are still not a gate.
  assert.equal(calibrationReport({ manifests: [], sensors, pairs: pairs.slice(0, 5) }).eligibleGates.length, 0);
});

test("assignBatches: an original never twice in a batch, the two orders of a pair in different batches, deterministic", () => {
  const pair = (pairId: string, segmentId: string) => ({
    pairId,
    manifest: `m-${segmentId}.json`,
    refId: "r",
    segmentId,
  });
  const pairs = [pair("a1", "one"), pair("a2", "one"), pair("a3", "one"), pair("b1", "two"), pair("b2", "two")];
  assert.equal(minimumBatches(pairs), 6);
  assert.throws(() => assignBatches(pairs, 5, "seed"), /--batches 6 or more/);
  const dealt = assignBatches(pairs, 7, "seed");
  assert.equal(dealt.length, 10);
  assert.deepEqual(assignBatches(pairs, 7, "seed"), dealt);
  const segmentOf = new Map(pairs.map((row) => [row.pairId, row.segmentId]));
  for (let batch = 0; batch < 7; batch++) {
    const mine = dealt.filter((row) => row.batch === batch);
    const segments = mine.map((row) => segmentOf.get(row.pairId));
    assert.equal(new Set(segments).size, segments.length, `batch ${batch} shows an original twice`);
  }
  for (const id of segmentOf.keys()) {
    const [ab, ba] = (["ab", "ba"] as const).map(
      (order) => dealt.find((row) => row.pairId === id && row.order === order)!.batch,
    );
    assert.notEqual(ab, ba, `${id}: both orders in one batch`);
  }
});

test("mergeCriticResults maps batch question ids back to pair and order; refuses unknown ids, a question judged twice and unanswered batches", () => {
  const entry = (pairId: string) => ({
    pairId,
    manifest: "m.json",
    refId: "r",
    segmentId: "s",
    variantId: pairId,
    kind: "stutter" as const,
    original: "x" as const,
    x: "x.mp4",
    y: "y.mp4",
  });
  const key: CriticKey = {
    schemaVersion: 1,
    seed: "s",
    pairs: [entry("p1")],
    batches: [
      { batch: 0, questions: [{ id: "q-one", pairId: "p1", order: "ab" }] },
      { batch: 1, questions: [{ id: "q-two", pairId: "p1", order: "ba" }] },
    ],
  };
  const answer = (id: string, winner: "A" | "B") => ({ pairId: id, order: "ab" as const, winner, reason: "" });
  const merged = mergeCriticResults(key, [
    { file: "batch-0", judgements: [answer("q-one", "A")] },
    { file: "batch-1", judgements: [answer("q-two", "B")] },
  ]);
  assert.deepEqual(
    merged.map((row) => [row.pairId, row.order, row.winner]),
    [
      ["p1", "ab", "A"],
      ["p1", "ba", "B"],
    ],
  );
  assert.equal(criticAccuracy(key, merged).critic.correct, 1, "A in ab and B in ba both name x");
  assert.throws(
    () => mergeCriticResults(key, [{ file: "f", judgements: [answer("q-one", "A")] }]),
    /Unanswered questions: batch-1 1 of 1/,
  );
  assert.throws(
    () =>
      mergeCriticResults(key, [
        { file: "f", judgements: [answer("q-one", "A")] },
        { file: "g", judgements: [answer("q-one", "B"), answer("q-two", "B")] },
      ]),
    /already judged in f/,
  );
  assert.throws(
    () => mergeCriticResults(key, [{ file: "f", judgements: [answer("p1", "A")] }]),
    /not a question of this answer key/,
  );
  const plain: CriticKey = { schemaVersion: 1, seed: "s", pairs: [entry("p1")] };
  assert.equal(
    mergeCriticResults(plain, [
      { file: "a", judgements: [{ pairId: "p1", order: "ab", winner: "A", reason: "" }] },
      { file: "b", judgements: [{ pairId: "p1", order: "ba", winner: "B", reason: "" }] },
    ]).length,
    2,
    "several result files without batches",
  );
});

test("criticAccuracy: both orders must name the original; disagreement, tie and a missing order are not right", () => {
  const entry = (pairId: string, original: "x" | "y", kind: CriticKey["pairs"][number]["kind"] = "stutter") => ({
    pairId,
    manifest: "m.json",
    refId: "r",
    segmentId: "s",
    variantId: pairId,
    kind,
    original,
    x: "x.mp4",
    y: "y.mp4",
  });
  const key: CriticKey = {
    schemaVersion: 1,
    seed: "s",
    pairs: [
      entry("p1", "x"),
      entry("p2", "y"),
      entry("p3", "x"),
      entry("p4", "y"),
      entry("p5", "x"),
      entry("p6", "x", "desync"),
    ],
  };
  const judgements = CriticResultsSchema.parse({
    judgements: [
      // p1: original is x, A in ab and B in ba. Right both times.
      { pairId: "p1", order: "ab", winner: "A", reason: "eases" },
      { pairId: "p1", order: "ba", winner: "B" },
      // p2: original is y. Right both times.
      { pairId: "p2", order: "ab", winner: "B" },
      { pairId: "p2", order: "ba", winner: "A" },
      // p3: picks A both times, so the orders disagree on the clip: position bias, not judgement.
      { pairId: "p3", order: "ab", winner: "A" },
      { pairId: "p3", order: "ba", winner: "A" },
      // p4: a tie.
      { pairId: "p4", order: "ab", winner: "tie" },
      { pairId: "p4", order: "ba", winner: "A" },
      // p5: one order only.
      { pairId: "p5", order: "ab", winner: "A" },
      // p6: agrees, on the degraded copy.
      { pairId: "p6", order: "ab", winner: "B" },
      { pairId: "p6", order: "ba", winner: "A" },
      { pairId: "unknown", order: "ab", winner: "A" },
    ],
  });
  const { critic, failures } = criticAccuracy(key, judgements);
  assert.deepEqual([critic.pairs, critic.judged, critic.agreed, critic.correct, critic.accuracy], [6, 5, 3, 2, 0.333]);
  assert.deepEqual(critic.disagreements, ["p3", "p4"]);
  assert.deepEqual(critic.missing, ["p5"]);
  assert.deepEqual(critic.byKind["stutter"], { n: 5, detections: 2, accuracy: 0.4, eligible: false });
  assert.deepEqual(
    failures.map((failure) => [failure.variantId, failure.reason]),
    [
      ["p3", "the two orders disagree"],
      ["p4", "a tie"],
      ["p5", "not judged in both orders"],
      ["p6", "preferred the degraded copy"],
    ],
  );
  const report = calibrationReport({ manifests: [], sensors: [], pairs: [], critic, criticFailures: failures });
  assert.equal(report.byKind["desync"]!.critic, 0);
  assert.equal(report.failures.length, 4);
});
