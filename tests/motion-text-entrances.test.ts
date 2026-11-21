import assert from "node:assert/strict";
import test from "node:test";
import {
  fixedWordArrival,
  sentenceBuildCues,
  sentenceBuildDefaults,
  sentenceBuildSchema,
  textGeneratePreset,
} from "../src/motion/library/typography/SentenceBuild";
import {
  blurTextPreset,
  markerHighlightSchema,
  parseMarkerText,
} from "../src/motion/library/typography/MarkerHighlight";

test("fixed words come into focus over the fade and finish fully legible", () => {
  const arrival = (frame: number) => fixedWordArrival(frame, 10, 8, 8);
  assert.deepEqual(arrival(9), { opacity: 0, filter: "blur(8px)" });
  const midway = arrival(14);
  assert.equal(midway.opacity, 0.5);
  assert.ok(midway.filter && Number.parseFloat(midway.filter.slice(5)) < 8);
  assert.deepEqual(arrival(18), { opacity: 1, filter: undefined });
  assert.deepEqual(arrival(34), arrival(18));
  assert.deepEqual(arrival(14), midway);
});

test("existing fixed layouts keep their snap or unblurred fade", () => {
  assert.deepEqual(fixedWordArrival(9, 10, 0, 0), { opacity: 0, filter: undefined });
  assert.deepEqual(fixedWordArrival(10, 10, 0, 0), { opacity: 1, filter: undefined });
  assert.deepEqual(fixedWordArrival(14, 10, 8, 0), { opacity: 0.5, filter: undefined });
});

test("the English text presets have a stagger, a reading hold and no marker sweep", () => {
  assert.ok(sentenceBuildSchema.safeParse(textGeneratePreset).success);
  assert.ok(markerHighlightSchema.safeParse(blurTextPreset).success);
  assert.deepEqual(
    sentenceBuildCues(textGeneratePreset).map(({ frame }) => frame),
    [5, 8, 11, 14, 17, 25],
  );
  assert.equal(sentenceBuildCues(textGeneratePreset).at(-1)?.kind, "land");
  const legacy = {
    ...sentenceBuildDefaults,
    text: "Reading hold",
    at: 5,
    step: 3,
    layout: "fixed" as const,
    exitAt: -1,
  };
  assert.equal(sentenceBuildCues(legacy).at(-1)?.frame, 8);
  assert.equal(textGeneratePreset.exitAt, -1);
  assert.equal(blurTextPreset.dimRest, 0);
  assert.ok(parseMarkerText(blurTextPreset.text).every((word) => !word.marked));
});

test("a trailing chip keeps its reveal cue and the focus landing waits for the last word", () => {
  const withChip = sentenceBuildCues({ ...textGeneratePreset, text: "A signal {spark}" });
  assert.ok(withChip.some((cue) => cue.label === "spark" && cue.kind === "reveal"));
  assert.equal(withChip.at(-1)?.frame, 16);
  assert.equal(withChip.at(-1)?.kind, "land");
});
