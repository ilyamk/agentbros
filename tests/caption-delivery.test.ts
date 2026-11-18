import test from "node:test";
import assert from "node:assert/strict";
import { captionCues, subtitleText } from "../src/lib/captions/delivery";
import { adaptLegacyProject, applyEdit } from "../src/lib/timeline-ir";
const r = (num: number) => ({ num, den: 1 });
function fixture() {
  const ir = adaptLegacyProject(
    {
      name: "captions",
      productName: "captions",
      colors: {},
      musicVolume: 0,
      voiceoverEnabled: true,
      scenes: [
        {
          id: "a",
          text: "Это не гарантия.",
          visualType: "title",
          durationInFrames: 120,
        },
      ],
    },
    "captions",
  );
  const speech = ir.tracks.find((t) => t.kind === "voiceover")!;
  speech.clips[0].captions = [
    { id: "a:0", text: "Это", start: r(0), end: r(15) },
    { id: "a:1", text: "не", start: r(15), end: r(30) },
    { id: "a:2", text: "гарантия.", start: r(30), end: r(60) },
  ];
  return { ir, speech };
}
test("Russian subtitles derive exact output time after source trim/rate and preserve negation", () => {
  const { ir, speech } = fixture();
  const changed = applyEdit(ir, {
    type: "rate",
    trackId: speech.id,
    clipId: "a",
    rate: r(2),
  });
  const cues = captionCues(changed);
  assert.deepEqual(
    cues.map((c) => [c.startMs, c.endMs, c.lines]),
    [[0, 1000, ["Это не гарантия."]]],
  );
  assert.match(subtitleText(cues, "srt"), /00:00:00,000 --> 00:00:01,000/);
  assert.match(subtitleText(cues, "vtt"), /^WEBVTT\n/);
});
test("caption split fragments merge without duplicated words at an edit boundary", () => {
  const { ir, speech } = fixture();
  const split = applyEdit(ir, {
    type: "split",
    trackId: speech.id,
    clipId: "a",
    at: r(22),
    newClipId: "b",
  });
  assert.equal(
    captionCues(split)
      .flatMap((c) => c.lines)
      .join(" "),
    "Это не гарантия.",
  );
});
test("phrase profiles enforce line limits/gaps and ambiguous overlaps fail", () => {
  const { ir, speech } = fixture();
  const cues = captionCues(ir, {
    profile: { maxCharsPerLine: 9, maxLines: 1 },
  });
  assert.deepEqual(
    cues.map((c) => c.lines),
    [["Это не"], ["гарантия."]],
  );
  const overlapping = structuredClone(speech);
  overlapping.id = "duplicate";
  ir.tracks.push(overlapping);
  assert.throws(() => captionCues(ir), /Overlapping/);
  assert.equal(captionCues(ir, { trackId: speech.id }).length, 1);
  assert.throws(() => captionCues(ir, { trackId: "missing" }), /does not exist/);
});

test("punctuation never hides overlapping owners between cue boundaries", () => {
  const { ir, speech } = fixture();
  speech.clips[0].captions[0].text = "Это.";
  speech.clips[0].captions[1].start = r(10);
  assert.throws(() => captionCues(ir), /Overlapping/);
});
for (const id of ["scene-->1", "scene--->1", "-->-->", "a--->>b", "->x", "-\n->"])
  test(`WebVTT cue identifiers never contain the timing arrow (${id})`, () => {
    const cue = { id, startMs: 0, endMs: 1000, lines: ["hello"] };
    const vtt = subtitleText([cue] as Parameters<typeof subtitleText>[0], "vtt");
    const blocks = vtt.split("\n\n").slice(1);
    assert.equal(blocks.length, 1);
    const [identifier, timing] = blocks[0].split("\n");
    assert.doesNotMatch(identifier, /-->/);
    assert.match(timing, /^00:00:00\.000 --> 00:00:01\.000$/);
  });
