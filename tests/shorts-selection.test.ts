import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { TestContext } from "node:test";
import { TranscriptSchema, type Transcript } from "../src/types/transcript";
import { ShortsCandidatesSchema } from "../src/types/shorts";
import { chunkSentences, loadPrepared, numberSentences, prepareShorts } from "../src/lib/shorts/prepare";
import {
  DEFAULT_WEIGHTS,
  quoteInSentence,
  rankCandidates,
  snapToSentences,
  weightedScore,
  type RankOptions,
} from "../src/lib/shorts/rank";
import { calibrateThreshold } from "../src/lib/shorts/calibrate";
import { selectionHash, stableHash } from "../src/lib/longform/plans";
import { ShortSelectionSchema } from "../src/types/longform";
import { TimelineIRSchema } from "../src/types/timeline";

const HASH = "a".repeat(64);
const WORD = 0.4,
  WORD_GAP = 0.05;

/** Synthetic speech: each word 0.4 s, 50 ms between words, `pause` seconds of silence after each sentence. */
function transcriptOf(
  sentences: string[],
  options: { pause?: number | number[]; fillerFirst?: boolean; withSentences?: boolean } = {},
): Transcript {
  const words: Transcript["words"] = [];
  const out: Transcript["sentences"] = [];
  let t = 1;
  sentences.forEach((sentence, index) => {
    const first = words.length;
    if (options.fillerFirst && index === 0) {
      words.push({
        id: `w${words.length}`,
        text: "um",
        kind: "filler",
        startSec: t,
        endSec: t + 0.3,
        speaker: "spk1",
        channel: null,
        confidence: 0.9,
      });
      t += 0.3 + WORD_GAP;
    }
    for (const text of sentence.split(" ")) {
      words.push({
        id: `w${words.length}`,
        text,
        kind: "word",
        startSec: round(t),
        endSec: round(t + WORD),
        speaker: "spk1",
        channel: null,
        confidence: 0.9,
      });
      t += WORD + WORD_GAP;
    }
    t -= WORD_GAP;
    out.push({
      id: `s${index + 1}`,
      firstWordId: words[first]!.id,
      lastWordId: words[words.length - 1]!.id,
      text: sentence,
      startSec: words[first]!.startSec,
      endSec: words[words.length - 1]!.endSec,
      speaker: "spk1",
    });
    const pause = Array.isArray(options.pause) ? (options.pause[index] ?? 0.8) : (options.pause ?? 0.8);
    t += pause;
  });
  return TranscriptSchema.parse({
    version: 1,
    source: { file: "talk.mp4", sha256: HASH, durationSec: round(t + 1) },
    engine: { provider: "local", model: "synthetic", verbatim: true, diarized: false, timing: "native" },
    language: "en",
    speakers: [{ id: "spk1" }],
    words,
    sentences: options.withSentences === false ? [] : out,
  });
}
const round = (n: number) => Math.round(n * 1000) / 1000;

/** Thirteen-word sentences last 5.8 s; with 0.8 s pauses six of them make a ~39 s clip. */
const sentence = (n: number) => `Sentence ${n} explains one concrete idea about pricing with a clear example here.`;
const talk = (count: number, options: Parameters<typeof transcriptOf>[1] = {}) =>
  transcriptOf(
    Array.from({ length: count }, (_, i) => sentence(i + 1)),
    options,
  );

function axes(first: number, last: number, scores: Partial<Record<string, number>> = {}) {
  const ax = (name: string, n: number) => ({
    score: scores[name] ?? 8,
    sentence: n,
    quote: `Sentence ${n} explains one`,
  });
  return {
    hook: ax("hook", first),
    standalone: ax("standalone", first),
    emotion: ax("emotion", first + 1),
    payoff: ax("payoff", last),
    value: ax("value", first + 1),
    relevance: ax("relevance", first),
  };
}
const candidate = (id: string, first: number, last: number, scores: Partial<Record<string, number>> = {}) => ({
  id,
  title: `Clip ${id}`,
  firstSentence: first,
  lastSentence: last,
  hookSentence: first,
  axes: axes(first, last, scores),
  vetoes: { needsSetup: false, endsBeforePayoff: false, claimOutOfContext: false },
});

function prepared(
  t: TestContext,
  transcript: Transcript,
  params: Partial<{ count: number; minSec: number; maxSec: number; hardMaxSec: number }> = {},
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shorts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "t.json");
  writeFileSync(file, JSON.stringify(transcript));
  prepareShorts(file, path.join(dir, "prep"), {
    count: 5,
    minSec: 20,
    maxSec: 60,
    hardMaxSec: 90,
    brief: "pricing lessons",
    ...params,
  });
  return { dir, prep: path.join(dir, "prep"), ...loadPrepared(path.join(dir, "prep")) };
}
const opts = (extra: Partial<RankOptions> = {}): RankOptions => ({
  threshold: 60,
  thresholdSource: "default",
  preparedSha256: HASH,
  candidatesSha256: HASH,
  ...extra,
});

test("prepare numbers sentences, writes the brief with the schema and chunks long recordings with 60 s overlap", (t) => {
  const p = prepared(t, talk(8));
  assert.equal(p.prepared.chunks.length, 1);
  const chunk = readFileSync(path.join(p.prep, "chunk-01.md"), "utf8");
  assert.match(chunk, /^S0001 \[00:01\.0–00:06\.7\] spk1: Sentence 1 explains/m);
  const brief = readFileSync(path.join(p.prep, "brief.md"), "utf8");
  for (const needed of [
    "Do not give a total",
    "pricing lessons",
    '"needsSetup"',
    '"hookSentence"',
    "pnpm shorts:rank --prepared",
  ])
    assert.ok(brief.includes(needed), needed);
  const example = /Example:\n\n```json\n([\s\S]*?)\n```/.exec(brief)![1]!;
  ShortsCandidatesSchema.parse(JSON.parse(example));

  const long = talk(400);
  const chunks = chunkSentences(numberSentences(long).sentences);
  const total = long.sentences.at(-1)!.endSec;
  assert.ok(total > 2400 && total < 3600);
  assert.deepEqual(
    chunks.map((c) => c.startSec),
    [0, 1140, 2280].filter((s) => s < total),
  );
  const [a, b] = chunks;
  assert.ok(
    a!.sentences.some((s) => b!.sentences.some((x) => x.n === s.n)),
    "chunks overlap",
  );
  assert.ok(b!.sentences[0]!.startSec < a!.endSec);
});

test("sentences are derived from words when the producer has none", () => {
  const { sentences, derived } = numberSentences(talk(3, { withSentences: false }));
  assert.equal(derived, true);
  assert.equal(sentences.length, 3);
  assert.equal(sentences[1]!.text, sentence(2));
});

test("quotes must be verbatim in the cited sentence; typography and case are normalised", () => {
  assert.equal(quoteInSentence("“It’s NOT free”", "And it's not free – ever."), true);
  assert.equal(quoteInSentence("not free — ever", "And it's not free – ever."), true);
  assert.equal(quoteInSentence("it is not free", "And it's not free – ever."), false);
  assert.equal(quoteInSentence("free", "And it's not free – ever."), false, "a one-word quote proves nothing");
  assert.equal(quoteInSentence("Да.", "Да."), true);
});

test("rank rejects paraphrased quotes, evidence outside the range, vetoes and an agent-supplied total", (t) => {
  const p = prepared(t, talk(20));
  const bad = candidate("para", 1, 6);
  bad.axes.payoff.quote = "Sentence 6 describes one";
  const outside = candidate("outside", 8, 13);
  outside.axes.value.sentence = 2;
  outside.axes.value.quote = "Sentence 2 explains one";
  const vetoed = {
    ...candidate("veto", 14, 19),
    vetoes: { needsSetup: true, endsBeforePayoff: false, claimOutOfContext: false },
  };
  const result = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [bad, outside, vetoed] },
    opts(),
  );
  assert.equal(result.proposals.length, 0);
  assert.deepEqual(Object.fromEntries(result.rejected.map((r) => [r.id, r.reasons])), {
    para: ["payoff: quote not found verbatim in S6"],
    outside: ["value: evidence sentence S2 outside the range"],
    veto: ["veto: needsSetup"],
  });
  assert.throws(
    () =>
      rankCandidates(
        p.prepared,
        p.transcript,
        p.sentences,
        { version: 1, candidates: [{ ...candidate("x", 1, 6), total: 90 }] },
        opts(),
      ),
    /total|Unrecognized/,
  );
});

test("snapping pads 300 ms into long silence, splits a short gap at its midpoint and skips an edge filler", () => {
  const roomy = transcriptOf(["One two three four.", "Five six seven eight."], { pause: 2 });
  const s = numberSentences(roomy).sentences;
  const snap = snapToSentences(roomy, s[0]!, s[0]!);
  assert.equal(snap.startSec, round(1 - 0.3));
  assert.equal(snap.endSec, round(s[0]!.endSec + 0.3));
  assert.deepEqual(snap.warnings, []);

  const tight = transcriptOf(["One two three four.", "Five six seven eight."], { pause: 0.2, fillerFirst: true });
  const ts = numberSentences(tight).sentences;
  const snapped = snapToSentences(tight, ts[0]!, ts[0]!);
  assert.equal(
    snapped.startSec,
    round(tight.words[1]!.startSec - 0.025),
    "filler skipped; half of the 50 ms gap after it",
  );
  assert.equal(snapped.endSec, round(ts[0]!.endSec + 0.1));
  assert.deepEqual(snapped.warnings, ["tight end: 100 ms of padding after the last word"]);
  assert.match(
    snapped.runningEdges.join(),
    /starts in running speech: 50 ms of silence before the first word; try --speech-mask/,
  );
});

test("a speech mask moves edges out to detected speech and stops padding at neighbouring speech", (t) => {
  const roomy = transcriptOf(["One two three four.", "Five six seven eight."], { pause: 2 });
  const [s1, s2] = numberSentences(roomy).sentences;
  const end = s1!.endSec;
  const speech = [
    { startSec: 0.85, endSec: round(end + 0.1) },
    { startSec: round(end + 0.3), endSec: round(end + 0.5) },
    { startSec: s2!.startSec, endSec: s2!.endSec },
  ];
  const snap = snapToSentences(roomy, s1!, s1!, speech);
  assert.equal(snap.startSec, round(0.85 - 0.3), "speech starts before the first word's time; full padding before it");
  assert.equal(
    snap.endSec,
    round(end + 0.2),
    "mask edge + half the 200 ms gap to the next detected speech (a breath or cough)",
  );
  assert.equal(snap.nextStart, round(end + 0.3));
  assert.match(snap.warnings.join(), /tight end: 100 ms/);
  const mask = {
    version: 1 as const,
    source: { file: "talk.mp4", sha256: "b".repeat(64), durationSec: 20 },
    engine: {
      provider: "silero-vad" as const,
      version: "5",
      sampleRate: 16000 as const,
      threshold: 0.5,
      minSpeechMs: 250,
      minSilenceMs: 100,
      padMs: 0 as const,
    },
    speech,
    speechSec: 1,
  };
  const p = prepared(t, talk(20));
  assert.throws(
    () =>
      rankCandidates(
        p.prepared,
        p.transcript,
        p.sentences,
        { version: 1, candidates: [candidate("a", 1, 6)] },
        opts({ speechMask: mask }),
      ),
    /another recording/,
  );
  const own = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [candidate("a", 1, 6)] },
    opts({ speechMask: { ...mask, source: { ...mask.source, sha256: HASH }, speech: [] } }),
  );
  assert.equal(own.proposals.length, 1);
});

test("an edge in running speech moves to a nearby speech-mask silence, or the clip is rejected", (t) => {
  const run = transcriptOf(["One two three four.", "Five six seven eight.", "Nine ten eleven twelve."], {
    pause: [0.06, 2],
  });
  const [s1, s2] = numberSentences(run).sentences;
  const continuous = [{ startSec: 0.9, endSec: s2!.endSec + 0.05 }];
  assert.match(
    snapToSentences(run, s2!, s2!, continuous).runningEdges.join(),
    /starts in running speech: 60 ms .* no mask silence nearby/,
  );
  const breath = [
    { startSec: 0.9, endSec: s1!.endSec - 0.12 },
    { startSec: s1!.endSec + 0.01, endSec: s2!.endSec + 0.05 },
  ];
  const moved = snapToSentences(run, s2!, s2!, breath);
  assert.deepEqual(moved.runningEdges, []);
  assert.equal(
    moved.startSec,
    round(s1!.endSec + 0.01 - 0.065),
    "inside the 130 ms mask silence, half of it as padding",
  );
  assert.match(moved.warnings.join(), /start placed in the speech mask's 130 ms silence \(10 ms between the words\)/);

  const p = prepared(
    t,
    transcriptOf(
      Array.from({ length: 12 }, (_, i) => sentence(i + 1)),
      { pause: [0.8, 0.8, 0.05] },
    ),
  );
  const result = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [candidate("late", 4, 9), candidate("early", 1, 6)] },
    opts({ threshold: 0 }),
  );
  assert.deepEqual(
    result.rejected.map((r) => r.id),
    ["late"],
  );
  assert.match(result.rejected[0]!.reasons[0]!, /starts in running speech: 50 ms/);
});

test("score is the weighted mean computed in code; overlaps over 50% keep the higher score; threshold and count apply", (t) => {
  const p = prepared(t, talk(40), { count: 2 });
  const high = candidate("high", 1, 6, { hook: 9, payoff: 9 });
  const overlapping = candidate("overlap", 2, 7, { hook: 8 });
  const half = candidate("half", 4, 9, { hook: 7 });
  const third = candidate("third", 20, 25, { hook: 6 });
  const low = candidate("low", 30, 35, { hook: 1, standalone: 1, emotion: 1, payoff: 1, value: 1, relevance: 1 });
  const result = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [low, third, half, overlapping, high] },
    opts(),
  );
  assert.equal(result.proposals[0]!.score, weightedScore(high.axes, DEFAULT_WEIGHTS));
  assert.equal(result.proposals[0]!.score, 84.8, "(9·3 + 8·2 + 8 + 9·2 + 8·1.5 + 8) / 10.5 × 10");
  assert.deepEqual(
    result.droppedOverlaps.map((d) => [d.id, d.keptId]),
    [["overlap", "high"]],
  );
  assert.deepEqual(
    result.proposals.map((r) => r.id),
    ["high", "half"],
    "half overlaps by exactly 50% and survives",
  );
  assert.deepEqual(
    result.others.map((r) => [r.id, r.reason]),
    [
      ["third", "over-count"],
      ["low", "below-threshold"],
    ],
  );
  assert.equal(result.weightsHash, stableHash(DEFAULT_WEIGHTS));
});

test("durations: too short and too long reject; over max-sec needs a story payoff", (t) => {
  const p = prepared(t, talk(30), { minSec: 20, maxSec: 40, hardMaxSec: 60 });
  const result = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    {
      version: 1,
      candidates: [
        candidate("short", 1, 2),
        candidate("story", 3, 10, { payoff: 9 }),
        candidate("flat", 11, 18, { payoff: 6 }),
        candidate("huge", 19, 30),
      ],
    },
    opts({ threshold: 0 }),
  );
  const reasons = Object.fromEntries(result.rejected.map((r) => [r.id, r.reasons[0]]));
  assert.match(reasons.short!, /too short/);
  assert.match(reasons.flat!, /without a story payoff/);
  assert.match(reasons.huge!, /too long/);
  assert.deepEqual(
    result.proposals.map((r) => r.id),
    ["story"],
  );
  assert.match(result.proposals[0]!.warnings.join(), /story payoff/);
});

test("a hook later than 3 s into the clip is rejected", (t) => {
  const p = prepared(t, talk(20));
  const late = { ...candidate("late", 1, 6), hookSentence: 2 };
  late.axes.hook = { score: 9, sentence: 2, quote: "Sentence 2 explains one" };
  const result = rankCandidates(p.prepared, p.transcript, p.sentences, { version: 1, candidates: [late] }, opts());
  assert.match(result.rejected[0]!.reasons[0]!, /hook starts .* s in/);
});

function timeline(clips: { start: number; sourceStart: number; sourceEnd: number }[], assetId = `sha256:${HASH}`) {
  return TimelineIRSchema.parse({
    version: 1,
    projectId: "talk",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "presenter",
        kind: "presenter",
        clips: clips.map((c, i) => ({
          id: `c${i}`,
          assetId,
          start: { num: c.start, den: 1 },
          source: {
            start: { num: c.sourceStart, den: 1 },
            end: { num: c.sourceEnd, den: 1 },
            timebase: { num: 30, den: 1 },
          },
        })),
      },
    ],
  });
}

test("with a timeline, proposals carry whole-frame ShortSelection drafts whose hash a human approval reuses", (t) => {
  const p = prepared(t, talk(20));
  const ir = timeline([{ start: 0, sourceStart: 0, sourceEnd: 30 * 200 }]);
  const result = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [candidate("a", 1, 6), candidate("b", 8, 13)] },
    opts({ timeline: { ir, projectId: "talk", projectDir: p.dir, protectedSpans: [] } }),
  );
  const a = result.proposals.find((r) => r.id === "a")!;
  const range = a.selection!.ranges[0]!;
  assert.equal(range.start.den, 1);
  assert.equal(range.end.den, 1);
  assert.equal(range.start.num, Math.floor(a.startSec * 30));
  assert.equal(range.end.num, Math.ceil(a.endSec * 30));
  const { selectionHash: hash, ...draft } = a.selection!;
  assert.equal(hash, selectionHash(draft.ranges));
  ShortSelectionSchema.parse({
    ...draft,
    approval: { approvedBy: "synthetic reviewer", approvedAt: "2026-11-13T00:00:00Z", selectionHash: hash },
  });
  assert.deepEqual(result.timeline, { projectId: "talk", trackId: "presenter", assetId: `sha256:${HASH}` });

  const recut = timeline([
    { start: 0, sourceStart: 0, sourceEnd: 30 * 20 },
    { start: 30 * 20, sourceStart: 30 * 25, sourceEnd: 30 * 200 },
  ]);
  const lossy = candidate("lossy", 1, 6);
  lossy.axes.emotion = { score: 8, sentence: 4, quote: "Sentence 4 explains one" };
  const split = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [candidate("a", 1, 6), lossy] },
    opts({ timeline: { ir: recut, projectId: "talk", projectDir: p.dir, protectedSpans: [] } }),
  );
  assert.match(split.proposals[0]!.warnings.join(), /crosses 1 recut cut\(s\), removing Sentence 4 explains one/);
  assert.deepEqual(split.rejected, [
    { id: "lossy", reasons: ["timeline: the recut removes quoted words: Sentence 4 explains one"] },
  ]);
  const reordered = timeline([
    { start: 30 * 20, sourceStart: 0, sourceEnd: 30 * 20 },
    { start: 0, sourceStart: 30 * 20, sourceEnd: 30 * 40 },
  ]);
  const moved = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [candidate("a", 1, 6)] },
    opts({ timeline: { ir: reordered, projectId: "talk", projectDir: p.dir, protectedSpans: [] } }),
  );
  assert.match(moved.rejected[0]!.reasons[0]!, /reordered or interrupted/);

  const negation = {
    id: "neg",
    reason: "negation" as const,
    requires: [],
    note: "not free",
    start: { num: Math.round(a.endSec * 30) - 10, den: 1 },
    end: { num: Math.round(a.endSec * 30) + 200, den: 1 },
  };
  const guarded = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [candidate("a", 1, 6)] },
    opts({ timeline: { ir, projectId: "talk", projectDir: p.dir, protectedSpans: [negation] } }),
  );
  assert.match(guarded.rejected[0]!.reasons[0]!, /protected context: .*negation/);

  assert.throws(
    () =>
      rankCandidates(
        p.prepared,
        p.transcript,
        p.sentences,
        { version: 1, candidates: [candidate("a", 1, 6)] },
        opts({
          timeline: {
            ir: timeline([{ start: 0, sourceStart: 0, sourceEnd: 300 }], "other.mp4"),
            projectId: "talk",
            projectDir: p.dir,
            protectedSpans: [],
          },
          publicDir: p.dir,
        }),
      ),
    /No timeline clip/,
  );
});

test("a recording-edit recut matches by payload.sourceHash, skips joined speech, and maps a span across pause cuts to one output range", (t) => {
  const p = prepared(t, talk(20));
  const master = `sha256:${"c".repeat(64)}`;
  const payload = { sourceHash: HASH, editHash: "d".repeat(64) };
  const kept = [
    { start: 0, sourceStart: 15, sourceEnd: 210 },
    { start: 195, sourceStart: 225, sourceEnd: 410 },
    { start: 380, sourceStart: 425, sourceEnd: 6000 },
  ];
  const clip = (c: (typeof kept)[number], i: number, assetId: string, extra: Record<string, unknown> = {}) => ({
    id: `k${i + 1}`,
    assetId,
    start: { num: c.start, den: 1 },
    source: { start: { num: c.sourceStart, den: 1 }, end: { num: c.sourceEnd, den: 1 }, timebase: { num: 30, den: 1 } },
    payload: { ...payload, ...extra },
  });
  const ir = TimelineIRSchema.parse({
    version: 1,
    projectId: "talk-recut",
    timebase: { num: 30, den: 1 },
    tracks: [
      {
        id: "authentic-speech",
        kind: "voiceover",
        clips: kept.map((c, i) =>
          clip(
            { ...c, sourceStart: c.start, sourceEnd: c.start + c.sourceEnd - c.sourceStart },
            i,
            `sha256:${"e".repeat(64)}`,
            { joinedSpeech: true },
          ),
        ),
      },
      { id: "recording-picture", kind: "visual", clips: kept.map((c, i) => clip(c, i, master)) },
    ],
  });
  const result = rankCandidates(
    p.prepared,
    p.transcript,
    p.sentences,
    { version: 1, candidates: [candidate("a", 1, 6)] },
    opts({ timeline: { ir, projectId: "talk-recut", projectDir: p.dir, protectedSpans: [] } }),
  );
  assert.deepEqual(result.timeline, { projectId: "talk-recut", trackId: "recording-picture", assetId: master });
  const a = result.proposals[0]!;
  assert.match(a.warnings.join(), /crosses 2 recut cut\(s\)/);
  const range = a.selection!.ranges[0]!;
  assert.equal(
    range.start.num,
    Math.floor(a.startSec * 30) - 15,
    "source frame minus the first kept clip's source start",
  );
  assert.equal(range.end.num, Math.ceil(a.endSec * 30) - 425 + 380, "source frame through the third kept clip");
  assert.equal(a.selection!.selectionHash, selectionHash(a.selection!.ranges));
});

test("calibration picks the lowest threshold where at least 70% of clips above it were approved", () => {
  const scored = (id: string, score: number) => ({
    id,
    title: id,
    score,
    axes: {},
    firstSentence: 1,
    lastSentence: 2,
    hookSentence: 1,
    startSec: 0,
    endSec: 30,
    durationSec: 30,
    text: "x",
    warnings: [],
  });
  const scores = [90, 85, 80, 75, 70, 65, 60, 55, 50, 45];
  const proposals = {
    version: 1 as const,
    preparedSha256: HASH,
    candidatesSha256: HASH,
    sourceSha256: HASH,
    weights: DEFAULT_WEIGHTS,
    weightsHash: stableHash(DEFAULT_WEIGHTS),
    threshold: 0,
    thresholdSource: "flag" as const,
    proposals: [],
    others: scores.map((s, i) => ({ ...scored(`c${i}`, s), reason: "below-threshold" as const })),
    droppedOverlaps: [],
    rejected: [],
    timeline: null,
  };
  const ratings = { version: 1, ratings: [5, 4, 2, 5, 4, 2, 1, 3, 1, 2].map((rating, i) => ({ id: `c${i}`, rating })) };
  const calibration = calibrateThreshold(proposals, ratings, {
    minClips: 10,
    minAbove: 3,
    ratingsSha256: HASH,
    proposalsSha256: HASH,
    now: new Date("2026-11-13T00:00:00Z"),
  });
  assert.equal(calibration.threshold, 70, "at 70: 4 of 5 approved (80%); at 65: 4 of 6 (67%)");
  assert.equal(calibration.clipsAbove, 5);
  assert.equal(calibration.precision, 0.8);
  assert.throws(
    () =>
      calibrateThreshold(
        proposals,
        { version: 1, ratings: ratings.ratings.slice(0, 5) },
        { minClips: 10, minAbove: 3, ratingsSha256: HASH, proposalsSha256: HASH },
      ),
    /at least 10/,
  );
  assert.throws(
    () =>
      calibrateThreshold(
        proposals,
        { version: 1, ratings: [{ id: "ghost", rating: 5 }] },
        { minClips: 1, minAbove: 1, ratingsSha256: HASH, proposalsSha256: HASH },
      ),
    /no score/,
  );
  const allBad = { version: 1, ratings: ratings.ratings.map((r) => ({ ...r, rating: 1 })) };
  assert.throws(
    () =>
      calibrateThreshold(proposals, allBad, { minClips: 10, minAbove: 3, ratingsSha256: HASH, proposalsSha256: HASH }),
    /No threshold/,
  );
});

test("CLIs: prepare, rank and calibrate emit one JSON line and the calibrated threshold is used by rank", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "shorts-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runner = path.resolve("node_modules/tsx/dist/cli.mjs");
  const cli = (script: string, args: string[]) => {
    const r = spawnSync(process.execPath, [runner, path.resolve(`scripts/${script}`), ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60000,
    });
    const lines = r.stdout.trim().split("\n");
    assert.equal(lines.length, 1, r.stderr);
    return { status: r.status, out: JSON.parse(lines[0]!) };
  };
  writeFileSync(path.join(dir, "t.json"), JSON.stringify(talk(40)));
  const prep = cli("shorts-prepare.ts", ["--transcript", "t.json", "--output-dir", "prep", "--count", "3"]);
  assert.equal(prep.status, 0);
  assert.equal(prep.out.metadata.sentences, 40);
  writeFileSync(
    path.join(dir, "c.json"),
    JSON.stringify({
      version: 1,
      candidates: [candidate("a", 1, 6), candidate("b", 8, 13, { hook: 3 }), candidate("c", 15, 20, { hook: 5 })],
    }),
  );
  const ranked = cli("shorts-rank.ts", ["--prepared", "prep", "--candidates", "c.json", "--threshold", "0"]);
  assert.equal(ranked.status, 0, JSON.stringify(ranked.out));
  assert.equal(ranked.out.metadata.proposals, 3);
  assert.match(readFileSync(path.join(dir, "prep/proposals.md"), "utf8"), /not approvals/);
  writeFileSync(
    path.join(dir, "r.json"),
    JSON.stringify({
      version: 1,
      ratings: [
        { id: "a", rating: 5 },
        { id: "c", rating: 4 },
        { id: "b", rating: 2 },
      ],
    }),
  );
  const calibrated = cli("shorts-calibrate.ts", [
    "--proposals",
    "prep/proposals.json",
    "--ratings",
    "r.json",
    "--output",
    "cal.json",
    "--min-clips",
    "3",
    "--min-above",
    "1",
  ]);
  assert.equal(calibrated.status, 0, JSON.stringify(calibrated.out));
  const reranked = cli("shorts-rank.ts", ["--prepared", "prep", "--candidates", "c.json", "--calibration", "cal.json"]);
  assert.equal(reranked.out.metadata.thresholdSource, "calibration");
  assert.equal(reranked.out.metadata.threshold, calibrated.out.metadata.threshold);
  const otherWeights = cli("shorts-rank.ts", [
    "--prepared",
    "prep",
    "--candidates",
    "c.json",
    "--calibration",
    "cal.json",
    "--weights",
    "hook=1",
  ]);
  assert.equal(otherWeights.out.error, "VALIDATION");
  writeFileSync(path.join(dir, "prep/transcript.json"), "{}");
  assert.equal(cli("shorts-rank.ts", ["--prepared", "prep", "--candidates", "c.json"]).out.error, "VALIDATION");
});
