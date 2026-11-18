import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  likelyUnmarkedFillers,
  maskFromVad,
  planRecut,
  renderRecutMarkdown,
  type RecutSource,
} from "../src/lib/workflows/recut-plan";
import { SpeechMaskSchema } from "../src/types/speech-mask";
import { RecordingEditRequestSchema } from "../src/types/workflow-recording-edit";
import type { Transcript } from "../src/types/transcript";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { hashFile } from "../src/lib/assets/registry";
import { assertRecordingEvidence } from "../src/lib/workflows/recording-evidence";
import {
  RECUT_DURATION,
  RECUT_SENTENCES,
  RECUT_WORDS,
  recutFixture,
  vadMask,
} from "./workflow-recording-recut-fixtures";

const sha = "a".repeat(64);
const cfr = (seconds: number): RecutSource => ({
  file: "talk.mp4",
  sha256: sha,
  version: "take-1",
  fps: { num: 30, den: 1 },
  boundaries: null,
  frameCount: Math.round(seconds * 30),
});
function transcript(
  words: [string, string, number, number, ("word" | "filler")?][],
  sentences: [string, string, string][],
  language = "en",
): Transcript {
  return {
    version: 1,
    source: { file: "talk.mp4", sha256: sha, durationSec: null },
    engine: { provider: "local", model: "fixture", verbatim: true, diarized: false, timing: "native" },
    language,
    speakers: [],
    words: words.map(([id, text, startSec, endSec, kind]) => ({
      id,
      text,
      kind: kind ?? "word",
      startSec,
      endSec,
      speaker: null,
      channel: null,
      confidence: 1,
    })),
    sentences: sentences.map(([id, firstWordId, lastWordId]) => ({
      id,
      firstWordId,
      lastWordId,
      text: id,
      startSec: 0,
      endSec: 0,
      speaker: null,
    })),
  };
}
const fixtureTranscript = () => transcript(RECUT_WORDS, RECUT_SENTENCES);
const spans = RECUT_WORDS.map((w) => [w[2], w[3]] as [number, number]);
const mask = maskFromVad(SpeechMaskSchema.parse(vadMask("talk.mp4", sha, RECUT_DURATION, spans)));
const input = (overrides: Partial<Parameters<typeof planRecut>[0]> = {}) => ({
  transcript: fixtureTranscript(),
  source: cfr(RECUT_DURATION),
  projectId: "talk-recut",
  name: "Talk",
  formats: ["landscape" as const],
  mask,
  levelDb: null,
  ...overrides,
});
const frameSet = (request: ReturnType<typeof planRecut>["request"]) =>
  request.keepSpans.flatMap((k) => Array.from({ length: k.endFrame - k.startFrame }, (_, i) => k.startFrame + i));

test("recut plan removes a clean filler and an abandoned take, shortens a long pause and protects a negation", () => {
  const plan = planRecut(input());
  const request = RecordingEditRequestSchema.parse(plan.request);
  assert.equal(request.version, 3);
  assert.deepEqual(
    plan.cuts.map((c) => `${c.id}:${c.kind}`),
    ["C1:head", "C2:filler", "C3:retake", "C4:pause", "C5:tail"],
  );
  assert.deepEqual(plan.cuts[1].removedWordIds, ["f1"]);
  assert.deepEqual(plan.cuts[2].removedWordIds, ["w4", "w5"]);
  assert.ok(
    plan.rejected.some((r) => r.words === "uh" && /protected/.test(r.reason)),
    "filler inside the negation stays",
  );
  assert.deepEqual(
    plan.protectedSpans.map((p) => p.kind),
    ["complete-statement", "negation"],
  );
  const kept = new Set(frameSet(request));
  const keptWords = request.transcript.words
    .filter((w) => kept.has(w.startFrame) && kept.has(w.endFrame - 1))
    .map((w) => w.text);
  assert.deepEqual(keptWords, [
    "We",
    "ship",
    "today.",
    "The",
    "new",
    "version",
    "is",
    "fast.",
    "It",
    "is",
    "not",
    "uh",
    "free.",
    "Thanks",
    "for",
    "watching.",
  ]);
  for (const span of request.protectedSpans)
    assert.ok(request.keepSpans.some((k) => k.startFrame <= span.startFrame && k.endFrame >= span.endFrame));
  const pause = plan.cuts[3];
  assert.ok(
    pause.startSec - 8.7 >= 0.15 - 1e-9 && pause.startSec - 8.7 <= 0.25 + 1e-9,
    `kept after phrase ${pause.startSec - 8.7}`,
  );
  assert.ok(
    9.7 - pause.endSec >= 0.08 - 1e-9 && 9.7 - pause.endSec <= 0.15 + 1e-9,
    `kept before phrase ${9.7 - pause.endSec}`,
  );
  const retake = plan.cuts[2];
  assert.ok(
    retake.startSec - 2.1 <= 0.25 + 1e-9 && 4.4 - retake.endSec >= 0.08 - 1e-9,
    "a removal keeps natural padding",
  );
  let cursor = 0;
  for (const keep of request.keepSpans) {
    assert.ok(keep.startFrame >= cursor);
    cursor = keep.endFrame;
  }
  assert.equal(request.cuts.length, plan.cuts.length);
  assert.ok(request.cuts.every((c, i) => c.reason.startsWith(`C${i + 1}:`)));
});

test("reviewer rejections keep stable ids; VAD speech in a pause and deliberate repetition are not cut", () => {
  const rejected = planRecut(input({ options: { reject: ["C2"] } }));
  assert.deepEqual(
    rejected.cuts.map((c) => c.id),
    ["C1", "C3", "C4", "C5"],
  );
  assert.ok(rejected.rejected.some((r) => /reviewer \(C2\)/.test(r.reason)));
  assert.throws(() => planRecut(input({ options: { reject: ["C9"] } })), /Unknown cut id/);
  const voiced = planRecut(
    input({
      mask: maskFromVad(
        vadMask(
          "talk.mp4",
          sha,
          RECUT_DURATION,
          [...spans, [9.0, 9.3] as [number, number]].sort((a, b) => a[0] - b[0]),
        ),
      ),
    }),
  );
  assert.ok(!voiced.cuts.some((c) => c.kind === "pause"));
  assert.ok(voiced.rejected.some((r) => r.kind === "pause" && /VAD/.test(r.reason)));
  const repeated = planRecut(
    input({
      transcript: transcript(
        [
          ["a", "the", 0.5, 0.6],
          ["b", "more", 0.65, 0.8],
          ["c", "you", 0.85, 0.95],
          ["d", "practise", 1.0, 1.4],
          ["e", "the", 1.45, 1.55],
          ["f", "more", 1.6, 1.75],
          ["g", "you", 1.8, 1.9],
          ["h", "learn.", 1.95, 2.3],
        ],
        [["s", "a", "h"]],
      ),
      source: cfr(3),
    }),
  );
  assert.ok(!repeated.cuts.some((c) => c.kind === "retake"));
  assert.ok(repeated.rejected.some((r) => r.kind === "retake" && /deliberate/.test(r.reason)));
  assert.equal(
    SpeechMaskSchema.safeParse({ speech: [[0, 1]] }).success,
    false,
    "only the speech:local schema is accepted",
  );
  assert.equal(
    SpeechMaskSchema.safeParse({
      ...vadMask("talk.mp4", sha, RECUT_DURATION, [
        [1, 2],
        [1.5, 3],
      ]),
    }).success,
    false,
  );
  assert.deepEqual(mask.speech, spans);
  assert.throws(
    () => planRecut(input({ mask: maskFromVad(vadMask("talk.mp4", "b".repeat(64), RECUT_DURATION, spans)) })),
    /Speech mask belongs to a different source/,
  );
});

test("a false start inside a sentence keeps the last take; a protected Russian negation is never cut inside", () => {
  const restart = planRecut(
    input({
      transcript: transcript(
        [
          ["a", "I", 0.5, 0.6],
          ["b", "think", 0.65, 0.9],
          ["c", "we", 0.95, 1.05],
          ["d", "need", 1.1, 1.3],
          ["e", "to", 1.35, 1.45],
          ["f", "we", 1.8, 1.9],
          ["g", "need", 1.95, 2.15],
          ["h", "to", 2.2, 2.3],
          ["i", "ship.", 2.35, 2.7],
        ],
        [["s", "a", "i"]],
      ),
      source: cfr(3.2),
    }),
  );
  const retake = restart.cuts.find((c) => c.kind === "retake");
  assert.deepEqual(retake?.removedWordIds, ["c", "d", "e"]);
  assert.equal(restart.protectedSpans[0].kind, "complete-statement");
  assert.equal(restart.protectedSpans[0].text, "we need to ship.");
  const russian = planRecut(
    input({
      transcript: transcript(
        [
          ["a", "Это", 0.5, 0.7],
          ["b", "эээ", 0.9, 1.2, "filler"],
          ["c", "не", 1.4, 1.5],
          ["d", "гарантия.", 1.55, 2.0],
          ["e", "Повтор", 2.6, 2.9],
          ["f", "эээ", 3.1, 3.4, "filler"],
          ["g", "фразы.", 3.6, 4.0],
        ],
        [
          ["s1", "a", "d"],
          ["s2", "e", "g"],
        ],
        "ru",
      ),
      source: cfr(4.5),
    }),
  );
  assert.deepEqual(
    russian.protectedSpans.map((p) => p.kind),
    ["negation"],
  );
  const unsplit = planRecut(input({ transcript: { ...fixtureTranscript(), sentences: [] } }));
  assert.deepEqual(
    unsplit.protectedSpans.map((p) => [p.kind, p.text]),
    [
      ["complete-statement", "The new version is fast."],
      ["negation", "It is not uh free."],
    ],
  );
  assert.deepEqual(
    unsplit.cuts.map((c) => c.kind),
    planRecut(input()).cuts.map((c) => c.kind),
  );
  assert.ok(russian.rejected.some((r) => r.words === "эээ" && /protected/.test(r.reason)));
  assert.deepEqual(
    russian.cuts.filter((c) => c.kind === "filler").map((c) => c.removedWordIds),
    [["f"]],
  );
});

test("a verbatim talk with more fillers than a request holds defers the smallest cuts", () => {
  const words: [string, string, number, number, ("word" | "filler")?][] = [];
  for (let i = 0; i < 250; i++)
    words.push(
      [`w${i}`, i === 249 ? "end." : "word", i * 1.2, i * 1.2 + 0.3],
      [`f${i}`, "um", i * 1.2 + 0.6, i * 1.2 + 0.8, "filler"],
    );
  const plan = planRecut(
    input({ transcript: transcript(words.slice(0, -1), [["s", "w0", "w249"]]), source: cfr(301) }),
  );
  assert.ok(plan.request.keepSpans.length <= 200 && plan.request.keepSpans.length >= 199);
  assert.ok(plan.rejected.some((r) => r.kind === "filler" && /at most 200/.test(r.reason)));
  assert.equal(RecordingEditRequestSchema.safeParse(plan.request).success, true);
});

test("rational sources map seconds through decoded frame boundaries and request explicit normalisation", () => {
  const frameCount = Math.round((RECUT_DURATION * 30000) / 1001);
  const boundaries = Array.from({ length: frameCount + 1 }, (_, i) => (i * 1001) / 30000);
  const plan = planRecut(
    input({ source: { ...cfr(RECUT_DURATION), fps: { num: 30000, den: 1001 }, boundaries, frameCount } }),
  );
  const request = RecordingEditRequestSchema.parse(plan.request);
  assert.ok("normalization" in request.source);
  const word = request.transcript.words.find((w) => w.id === "w8")!;
  assert.equal(word.startFrame, Math.round((4.9 * 30000) / 1001));
  assert.ok(request.keepSpans.at(-1)!.endFrame <= frameCount);
});

test("recut:plan CLI writes a request that passes recording-edit plan and creates a joined recut after review", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "recut-plan-cli-"));
  try {
    const fixture = recutFixture(root);
    const transcriptFile = path.join(root, "transcript.json"),
      maskFile = path.join(root, "speech-mask.json");
    writeFileSync(transcriptFile, JSON.stringify(fixture.transcript));
    writeFileSync(maskFile, JSON.stringify(fixture.mask));
    const run = (...extra: string[]) =>
      spawnSync(
        path.resolve("node_modules/.bin/tsx"),
        [
          "scripts/recut-plan.ts",
          "--transcript",
          transcriptFile,
          "--speech-mask",
          maskFile,
          "--project-id",
          "talk-recut",
          "--punch-in",
          "1.12",
          "--room-tone",
          ...extra,
        ],
        { encoding: "utf8", env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME } },
      );
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const lines = first.stdout.trim().split("\n");
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]);
    assert.equal(result.ok, true);
    assert.equal(result.metadata.reviewStatus, "needs-review");
    assert.deepEqual(
      result.metadata.cuts.map((c: any) => c.kind),
      ["head", "filler", "retake", "pause", "tail"],
    );
    const markdown = readFileSync(path.join(root, "recut-plan.md"), "utf8");
    for (const id of ["C1", "C2", "C3", "C4", "C5"]) assert.match(markdown, new RegExp(`\\*\\*${id}\\*\\*`));
    assert.match(markdown, /~~um~~/);
    assert.match(markdown, /negation · frames/);
    assert.match(markdown, new RegExp(result.metadata.editHash));
    const again = run();
    assert.equal(again.status, 1);
    assert.equal(JSON.parse(again.stdout.trim()).error, "VALIDATION");
    const request = JSON.parse(readFileSync(path.join(root, "recut-request.json"), "utf8"));
    assert.ok(request.joins.roomTone && request.joins.punchIn);
    const memory = path.join(root, "memory");
    const rejecting = spawnSync(
      path.resolve("node_modules/.bin/tsx"),
      [
        "scripts/recut-plan.ts",
        "--transcript",
        transcriptFile,
        "--speech-mask",
        maskFile,
        "--project-id",
        "talk-recut",
        "--reject",
        "C2",
        "--force",
        "--output",
        path.join(root, "rejected.json"),
      ],
      {
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTBROS_MEMORY_ROOT: memory,
        },
      },
    );
    assert.equal(rejecting.status, 0, rejecting.stdout);
    const rejectingAgain = spawnSync(
      path.resolve("node_modules/.bin/tsx"),
      [
        "scripts/recut-plan.ts",
        "--transcript",
        transcriptFile,
        "--speech-mask",
        maskFile,
        "--project-id",
        "talk-recut",
        "--reject",
        "C2",
        "--force",
        "--output",
        path.join(root, "rejected.json"),
      ],
      {
        encoding: "utf8",
        env: {
          AGENTBROS_NO_DOTENV: "1",
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          AGENTBROS_MEMORY_ROOT: memory,
        },
      },
    );
    assert.equal(rejectingAgain.status, 0, rejectingAgain.stdout);
    const metric = JSON.parse(readFileSync(path.join(memory, "metrics.jsonl"), "utf8").trim()); // one line: the same rejection planned again is not counted twice
    assert.deepEqual(
      [metric.project, metric.step, metric.event, metric.value, metric.detail],
      ["talk-recut", "4-approve", "rejected", 1, "recut:plan --reject C2"],
      "the user's rejected cuts are a rejected metric",
    );
    await runRecordingEditWorkflow(
      {
        ...request,
        review: {
          reviewer: "offline-test-declaration",
          reviewedAt: "2026-11-13T00:00:00Z",
          meaningPreserved: true,
          approvedEditHash: result.metadata.editHash,
        },
      },
      { action: "create", rootDir: root },
    );
    assert.ok(assertRecordingEvidence(path.join(root, "public/projects/talk-recut"), "talk-recut"));
    writeFileSync(maskFile, JSON.stringify(vadMask(fixture.file, "b".repeat(64), RECUT_DURATION, [[0.5, 1]])));
    const foreignMask = run("--force", "--output", path.join(root, "other.json"));
    assert.equal(foreignMask.status, 1);
    assert.match(JSON.parse(foreignMask.stdout.trim()).message, /Speech mask belongs to a different source/);
    writeFileSync(
      transcriptFile,
      JSON.stringify({ ...fixture.transcript, source: { ...fixture.transcript.source, sha256: "b".repeat(64) } }),
    );
    const mismatch = run("--force", "--output", path.join(root, "other.json"));
    assert.equal(mismatch.status, 1);
    assert.match(JSON.parse(mismatch.stdout.trim()).message, /checksum/);
    assert.ok(!existsSync(path.join(root, "other.json")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const levels =
  (loud: [number, number][], floor = -60) =>
  (start: number, end: number) =>
    loud.some(([a, b]) => a < end && b > start) ? -20 : floor;
test("real-footage regressions: fillers inside merged VAD speech are judged by level, and fillers fused to words are refused", () => {
  const merged = maskFromVad(
    vadMask("talk.mp4", sha, RECUT_DURATION, [
      [0.45, 2.15],
      [3.55, 5.95],
      [6.35, 7.95],
      [8.35, 8.75],
      [9.65, 10.45],
    ]),
  );
  const before = planRecut(input({ mask: merged, levelDb: null }));
  assert.ok(
    before.cuts.some((c) => c.kind === "filler"),
    "without levels the transcript gaps decide, as before",
  );
  const tight = transcript(
    [
      ["a", "We", 0.5, 0.7],
      ["b", "ship", 0.72, 1.0],
      ["f", "um", 1.02, 1.3, "filler"],
      ["c", "today.", 1.32, 1.7],
      ["d", "And", 2.0, 2.2],
      ["g", "uh", 2.3, 2.5, "filler"],
      ["e", "go.", 2.6, 2.9],
    ],
    [
      ["s1", "a", "c"],
      ["s2", "d", "e"],
    ],
  );
  const loud = [
    [0.5, 0.7],
    [0.72, 1.0],
    [1.04, 1.28],
    [1.32, 1.7],
    [2.0, 2.9],
  ] as [number, number][];
  const plan = planRecut(
    input({
      transcript: tight,
      source: cfr(3.2),
      mask: maskFromVad(vadMask("talk.mp4", sha, 3.2, [[0.5, 2.9]])),
      levelDb: levels(loud),
    }),
  );
  const filler = plan.cuts.find((c) => c.kind === "filler");
  assert.deepEqual(
    filler?.removedWordIds,
    ["f"],
    "a filler with quiet edges is cut although VAD calls the whole phrase speech",
  );
  assert.match(filler!.evidence.join(" "), /-60 \/ -60 dBFS/);
  const word = plan.request.transcript.words.find((w) => w.id === "f")!;
  assert.ok(
    word.startFrame >= filler!.startFrame && word.endFrame <= filler!.endFrame,
    "removed word frames sit inside the cut",
  );
  assert.ok(
    plan.rejected.some((r) => r.words === "uh" && /not quiet enough/.test(r.reason)),
    "a filler fused to its neighbours by sound is refused",
  );
});

test("real-footage regressions: parallel structures are not retakes, cut-off restarts are, and both meet the same level bar", () => {
  const words: [string, string, number, number][] = [
    ["a", "Sometimes", 0.5, 0.9],
    ["b", "they're", 0.95, 1.15],
    ["c", "more", 1.2, 1.4],
    ["d", "frequent,", 1.45, 1.9],
    ["e", "sometimes", 2.2, 2.6],
    ["f", "they're", 2.65, 2.85],
    ["g", "more", 2.9, 3.1],
    ["h", "intense.", 3.15, 3.7],
    ["i", "And", 4.2, 4.35],
    ["j", "how", 4.4, 4.55],
    ["k", "good", 4.6, 4.8],
    ["l", "at", 4.85, 4.95],
    ["m", "we...", 5.0, 5.2],
    ["n", "And", 5.8, 5.95],
    ["o", "how", 6.0, 6.15],
    ["p", "good", 6.2, 6.4],
    ["q", "are", 6.45, 6.6],
    ["r", "we?", 6.65, 7.0],
  ];
  const t = transcript(words, [
    ["s1", "a", "h"],
    ["s2", "i", "m"],
    ["s3", "n", "r"],
  ]);
  const quiet = planRecut(
    input({ transcript: t, source: cfr(7.5), mask: null, levelDb: levels(words.map((w) => [w[2], w[3]])) }),
  );
  assert.deepEqual(
    quiet.cuts.filter((c) => c.kind === "retake").map((c) => c.removedWordIds),
    [["i", "j", "k", "l", "m"]],
  );
  const parallel = quiet.rejected.filter((r) => r.kind === "retake");
  assert.equal(parallel.length, 1, JSON.stringify(parallel));
  assert.match(parallel[0].reason, /parallel structure/);
  const noisy = planRecut(
    input({
      transcript: t,
      source: cfr(7.5),
      mask: null,
      levelDb: levels([
        [0.5, 3.7],
        [4.2, 7.0],
      ]),
    }),
  );
  assert.ok(
    !noisy.cuts.some((c) => c.kind === "retake"),
    "a retake whose cut points sit in speech is refused like a filler",
  );
  assert.ok(noisy.rejected.some((r) => r.kind === "retake" && /not quiet enough/.test(r.reason)));
});

test("real-footage regressions: sentence-end pauses follow punctuation, backchannels stay, considered entries are unique", () => {
  const t = transcript(
    [
      ["a", "And", 0.5, 0.7],
      ["b", "with", 1.9, 2.1],
      ["c", "this.", 2.15, 2.5],
      ["d", "Mm-hmm.", 2.6, 2.9, "filler"],
      ["e", "Next", 3.4, 3.6],
      ["f", "one.", 3.65, 4.0],
    ],
    [
      ["s1", "a", "a"],
      ["s2", "b", "c"],
      ["s3", "d", "d"],
      ["s4", "e", "f"],
    ],
  );
  t.words = t.words.map((w) => ({ ...w, speaker: w.id === "d" ? "guest" : "host" }));
  const plan = planRecut(
    input({ transcript: t, source: cfr(4.5), mask: null, levelDb: levels(t.words.map((w) => [w.startSec, w.endSec])) }),
  );
  assert.match(plan.cuts.find((c) => c.kind === "pause")!.reason, /mid-clause/);
  assert.ok(plan.rejected.some((r) => r.words === "Mm-hmm." && /backchannel/.test(r.reason)));
  assert.equal(new Set(plan.rejected.map((r) => JSON.stringify(r))).size, plan.rejected.length);
});

test("recut:plan refuses WebM without stream durations and audio that outruns the picture with a VALIDATION hint", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "recut-plan-sources-"));
  try {
    const cases: [string, string[], RegExp][] = [
      [
        "clip.webm",
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x90:rate=30:duration=1",
          "-f",
          "lavfi",
          "-i",
          "sine=d=1",
          "-c:v",
          "libvpx",
          "-c:a",
          "libopus",
        ],
        /no video stream duration.*Remux to MP4/,
      ],
      [
        "clip.mov",
        [
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=160x90:rate=25:duration=3",
          "-f",
          "lavfi",
          "-i",
          "sine=d=3.06",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-c:a",
          "aac",
        ],
        /audio runs 0\.0\d+s past the end of the video.*-t 3/,
      ],
    ];
    for (const [name, args, message] of cases) {
      const file = path.join(root, name);
      spawnSync("ffmpeg", ["-v", "error", ...args, file]);
      if (!existsSync(file)) {
        t.diagnostic(`this FFmpeg cannot encode ${name}; case skipped`);
        continue;
      }
      const clip = {
        ...transcript([["a", "Hello.", 0.2, 0.6]], [["s", "a", "a"]]),
        source: { file, sha256: hashFile(file), durationSec: null },
      };
      writeFileSync(path.join(root, `${name}.json`), JSON.stringify(clip));
      const run = spawnSync(
        path.resolve("node_modules/.bin/tsx"),
        [
          "scripts/recut-plan.ts",
          "--transcript",
          path.join(root, `${name}.json`),
          "--project-id",
          "clip-recut",
          "--output",
          path.join(root, `${name}-request.json`),
        ],
        { encoding: "utf8", env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH, HOME: process.env.HOME } },
      );
      const result = JSON.parse(run.stdout.trim());
      assert.equal(run.status, 1);
      assert.equal(result.error, "VALIDATION", name);
      assert.match(result.message, message);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a non-verbatim transcript lists likely unmarked fillers in the plan for information; cuts and request are unchanged", () => {
  const words: [string, string, number, number][] = [
    ["w1", "Ну,", 0.5, 0.7],
    ["w2", "я", 0.9, 1.0],
    ["w3", "думаю", 1.0, 1.4],
    ["w4", "э", 1.7, 1.8],
    ["w5", "что", 2.0, 2.2],
    ["w6", "вот", 2.2, 2.4],
    ["w7", "это", 2.4, 2.6],
    ["w8", "важно.", 2.6, 3.0],
  ];
  const base = transcript(words, [["s1", "w1", "w8"]], "ru");
  const local: Transcript = { ...base, engine: { ...base.engine, verbatim: false } };
  const found = likelyUnmarkedFillers(local);
  assert.deepEqual(
    found.map((f) => f.text),
    ["Ну,", "э"],
  );
  assert.deepEqual(likelyUnmarkedFillers(base), []);
  const plan = planRecut({
    transcript: local,
    source: cfr(4),
    projectId: "talk-recut",
    name: "Talk",
    formats: ["landscape"],
    mask: null,
    levelDb: null,
  });
  const without = renderRecutMarkdown(plan, { transcriptFile: "t.json", requestFile: "r.json" });
  const withList = renderRecutMarkdown(plan, {
    transcriptFile: "t.json",
    requestFile: "r.json",
    unmarkedFillers: found,
  });
  assert.doesNotMatch(without, /Likely fillers/);
  assert.match(withList, /## Likely fillers the transcript did not mark \(information only\)\n[\s\S]*- 00:01\.700 "э"/);
  assert.equal(withList.replace(/\n## Likely fillers[\s\S]*?(?=\n## Considered)/, ""), without);
  assert.deepEqual(
    planRecut({
      transcript: local,
      source: cfr(4),
      projectId: "talk-recut",
      name: "Talk",
      formats: ["landscape"],
      mask: null,
      levelDb: null,
    }).request,
    plan.request,
  );
});

test("a chosen room-tone span is used when it passes the automatic span's tests, and refused with its reason when not", () => {
  const plan = planRecut(input({ options: { roomToneSpan: { startSec: 2.4, endSec: 2.9 } } }));
  assert.deepEqual(plan.request.joins.roomTone, { startFrame: 72, endFrame: 87, gainDb: -6 });
  assert.throws(
    () => planRecut(input({ options: { roomToneSpan: { startSec: 4.5, endSec: 5 } } })),
    /overlaps detected speech/,
  );
  assert.throws(
    () => planRecut(input({ options: { roomToneSpan: { startSec: 2.4, endSec: 2.6 } } })),
    /at least 300 ms/,
  );
  assert.throws(
    () => planRecut(input({ options: { roomToneSpan: { startSec: 10.8, endSec: 11.6 } } })),
    /inside the recording/,
  );
  // Without a span or --room-tone, no room tone.
  assert.equal(planRecut(input()).request.joins.roomTone, null);
});
