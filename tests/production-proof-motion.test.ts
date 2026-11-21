import assert from "node:assert/strict";
import test from "node:test";
import { barMorphProgress, barsFormNumberDefaults, numberSegments } from "../src/motion/library/data/BarsFormNumber";
import {
  printPassState,
  printRegistrationCues,
  printRegistrationDefaults,
} from "../src/motion/library/effects/PrintRegistration";
import {
  activeWaveformWord,
  waveformWordCues,
  waveformWordsDefaults,
  waveformWordsSchema,
} from "../src/motion/library/typography/WaveformWords";
import { acceptRevisionCues, acceptRevisionDefaults, revisionPose } from "../src/motion/library/ui/AcceptRevision";
import { deviceHandoffDefaults, devicePose } from "../src/motion/library/ui/DeviceHandoff";
import {
  evidenceScrollDefaults,
  evidenceScrollPose,
  evidenceScrollSchema,
} from "../src/motion/library/ui/EvidenceScroll";
import { inspectorGeometryDefaults, inspectorValue } from "../src/motion/library/ui/InspectorGeometry";
import {
  selectionProgress,
  variationSelectDefaults,
  variationSelectSchema,
} from "../src/motion/library/ui/VariationSelect";

test("the inspector reads exactly the same scalar as the artwork before, during and after a drag", () => {
  const p = inspectorGeometryDefaults;
  assert.equal(inspectorValue(p.at - 1, p), p.from);
  const mid = inspectorValue(p.at + 13, p);
  assert.ok(mid > p.from && mid < p.to);
  assert.equal(inspectorValue(p.at + p.moveFrames, p), p.to);
  assert.equal(inspectorValue(p.at + 100, p), p.to);
});

test("an approval is visible on its cue, then the same preview updates and holds", () => {
  const p = acceptRevisionDefaults;
  assert.deepEqual(revisionPose(p.acceptAt - 1, p), { accepted: false, titleScale: p.before });
  assert.deepEqual(revisionPose(p.acceptAt, p), { accepted: true, titleScale: p.before });
  const resolved = acceptRevisionCues(p).at(-1)!.frame;
  assert.deepEqual(revisionPose(resolved + 1, p), { accepted: true, titleScale: p.after });
});

test("a review target remains in the visible four-row window at either boundary or in the middle", () => {
  for (const target of [0, 3, evidenceScrollDefaults.rows.length - 1]) {
    const p = { ...evidenceScrollDefaults, target };
    const settled = evidenceScrollPose(p.at + p.moveFrames, p);
    assert.ok(target >= settled.rowsPassed && target < settled.rowsPassed + 4);
    assert.equal(settled.emphasis, 1);
  }
  assert.equal(evidenceScrollSchema.safeParse({ ...evidenceScrollDefaults, target: 24 }).success, false);
});

test("selection waits for the choice and a screen handoff changes aspect while retaining the same content", () => {
  const p = variationSelectDefaults;
  assert.equal(selectionProgress(p.selectAt - 1, p), 0);
  assert.equal(selectionProgress(p.selectAt + p.expandFrames, p), 1);
  assert.equal(variationSelectSchema.safeParse({ ...p, selected: p.options.length }).success, false);
  assert.equal(variationSelectSchema.safeParse({ ...p, selectAt: p.at + 1 }).success, false);
  const q = deviceHandoffDefaults;
  const before = devicePose(q.at, q);
  const after = devicePose(q.at + q.moveFrames, q);
  assert.ok(before.width / before.height < after.width / after.height);
  assert.equal(devicePose(q.at + q.moveFrames + 15, q).t, 1);
});

test("each source bar reaches one digit segment by the common landing frame", () => {
  const p = barsFormNumberDefaults;
  const segments = numberSegments(p.value);
  assert.equal(segments.length, 11);
  assert.equal(numberSegments("8888").length, 28);
  assert.ok(segments.every((_, i) => barMorphProgress(p.at + p.moveFrames, p, i, segments.length) === 1));
  assert.ok(barMorphProgress(p.at + 4, p, 0, segments.length) > barMorphProgress(p.at + 4, p, 10, segments.length));
});

test("the key ink plate enters after the colour passes and the registration settles", () => {
  const p = printRegistrationDefaults;
  assert.ok(printPassState(p.at + p.step, 0, p).reveal > printPassState(p.at + p.step, 3, p).reveal);
  const at = printRegistrationCues(p).at(-1)!.frame;
  assert.ok([0, 1, 2, 3].every((pass) => printPassState(at, pass, p).reveal === 1));
  assert.deepEqual(printPassState(at, 1, p), printPassState(at + 40, 1, p));
});

test("word activation follows the frame cues and refuses ambiguous cue order", () => {
  const p = waveformWordsDefaults;
  assert.ok(waveformWordsSchema.safeParse(p).success);
  assert.equal(activeWaveformWord(p.words[0]!.at - 1, p.words), -1);
  assert.equal(activeWaveformWord(p.words[1]!.at, p.words), 1);
  assert.equal(activeWaveformWord(999, p.words), 2);
  assert.deepEqual(
    waveformWordCues(p).map((cue) => cue.frame),
    p.words.map((word) => word.at),
  );
  assert.equal(waveformWordsSchema.safeParse({ ...p, words: [...p.words].reverse() }).success, false);
});
