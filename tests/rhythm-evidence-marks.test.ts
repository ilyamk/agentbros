import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  realpathSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
  readdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import {
  RhythmClockSchema,
  RhythmAnalysisRequestSchema,
  RhythmEvidenceSchema,
  ReviewedRhythmMarksSchema,
  RhythmMarksSchema,
  RHYTHM_PARAMETERS,
  type RhythmEvidence,
} from "../src/types/rhythm-evidence";
import { AssetRecordSchema } from "../src/types/assets";
import { analyzeRhythmPcm } from "../src/lib/audio/rhythm-kernel";
import { validateRhythmClock } from "../src/lib/audio/rhythm-clock";
import { RhythmReadContext, RhythmReadBudget, rhythmDigest } from "../src/lib/audio/rhythm-files";
import { mapReviewedRhythmMarks } from "../src/lib/audio/rhythm-marks";
import {
  currentRhythmImplementations,
  prepareRhythmMarks,
  inspectRhythmMarks,
  readRhythmEvidence,
  rhythmArtifactKey,
  type TrustedRhythmRuntime,
} from "../src/lib/audio/rhythm-evidence";
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const clock = (rate = 16000, samples = 16000) => ({
  version: 1 as const,
  codec: "pcm_s16le" as const,
  channels: 1,
  sampleRate: rate,
  timebase: { num: 1, den: rate },
  terminalTick: samples,
  frames: [{ pts: 0, nbSamples: samples }],
});
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "rhythm-stage-b-data-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "public/projects/demo"),
    folder = path.join(project, "pipeline/rhythm");
  mkdirSync(folder, { recursive: true });
  // These are opaque source/tool DATA fixtures, NOT a WAV decode or FFmpeg installation/inference.
  const originalBytes = Buffer.from("Stage B opaque original: no media decode"),
    assetSha = hash(originalBytes),
    original = `public/projects/demo/assets/imported/${assetSha}.wav`;
  mkdirSync(path.dirname(path.join(root, original)), { recursive: true });
  writeFileSync(path.join(root, original), originalBytes);
  const asset = AssetRecordSchema.parse({
    schemaVersion: 1,
    id: `sha256:${assetSha}`,
    hash: assetSha,
    revision: 1,
    createdAt: "2026-10-12T00:00:00Z",
    kind: "audio",
    files: { original: original.slice(7), bytes: originalBytes.length, mime: "audio/wav" },
    media: { durationSec: 1, timebase: "1/16000", sampleRate: 16000, channels: 1, codec: "pcm_s16le", hasAudio: true },
    provenance: { origin: "manual", tool: "Stage-B data fixture; not decoded audio" },
    rights: {},
    entityLinks: [],
    status: "candidate",
  });
  const registry = { schemaVersion: 1, revision: 1, assets: [asset] },
    timeline = {
      version: 1 as const,
      projectId: "demo",
      timebase: { num: 30, den: 1 },
      tracks: [
        {
          id: "music",
          kind: "music" as const,
          clips: [
            {
              id: "clip",
              assetId: asset.id,
              start: { num: 10, den: 1 },
              source: { start: { num: 0, den: 1 }, end: { num: 30, den: 1 }, timebase: { num: 30, den: 1 } },
              rate: { num: 1, den: 1 },
              transition: { kind: "cut" as const },
              captions: [],
            },
          ],
        },
      ],
    };
  writeFileSync(path.join(project, "project.json"), "{}");
  writeFileSync(path.join(project, "pipeline/asset-registry.json"), JSON.stringify(registry));
  writeFileSync(
    path.join(project, "pipeline/timeline-edit.json"),
    JSON.stringify({ version: 1, revision: 0, timeline, undo: [], redo: [] }),
  );
  const runtime: TrustedRhythmRuntime = {
    ffmpeg: { file: path.join(root, "tools/ffmpeg-data.bin"), version: "Stage-B fixture; never executed" },
    ffprobe: { file: path.join(root, "tools/ffprobe-data.bin"), version: "Stage-B fixture; never executed" },
  };
  mkdirSync(path.join(root, "tools"));
  for (const tool of [runtime.ffmpeg, runtime.ffprobe]) writeFileSync(tool.file, "opaque trusted tool digest fixture");
  const runtimeData = Object.fromEntries(
    (["ffmpeg", "ffprobe"] as const).map((name) => {
      const tool = runtime[name];
      return [name, { version: tool.version, sha256: hash(readFileSync(tool.file)) }];
    }),
  );
  const pcm = Buffer.alloc(16000 * 4);
  for (let i = 8000; i < 8320; i++) pcm.writeFloatLE(0.25, i * 4);
  const analyzed = analyzeRhythmPcm(pcm, 1, assetSha);
  const request = {
    version: 1 as const,
    contract: "source-rhythm-evidence-v1" as const,
    projectId: "demo",
    assetId: asset.id,
    assetSha256: assetSha,
    profile: "rms-onset-v1-mono16k" as const,
  };
  let evidence: any = {
    version: 1,
    contract: "source-rhythm-evidence-v1",
    request,
    original: { path: original, sha256: assetSha, bytes: originalBytes.length },
    selectedAssetDigest: rhythmDigest(asset),
    parameters: RHYTHM_PARAMETERS,
    runtime: runtimeData,
    implementations: currentRhythmImplementations(),
    clock: validateRhythmClock(clock()),
    analysis: analyzed.report,
    onsets: analyzed.onsetSamples.map((sample, index) => ({ id: `onset-${index}`, sample })),
    generatedAt: "2026-10-12T00:00:00Z",
    state: "candidate",
    reviewRequired: true,
    automaticCuts: false,
    calibratedBeatTruth: false,
    apiCalls: 0,
  };
  const privateFolder = `.cache/rhythm-evidence/demo/${rhythmArtifactKey(evidence)}/`;
  mkdirSync(path.join(root, privateFolder), { recursive: true });
  const pin = (name: string, bytes: Buffer) => {
    const file = privateFolder + name;
    writeFileSync(path.join(root, file), bytes);
    return { path: file, sha256: hash(bytes), bytes: bytes.length };
  };
  evidence = {
    ...evidence,
    artifacts: { clock: pin("clock.json", Buffer.from(JSON.stringify(clock()))), pcm: pin("pcm.f32", pcm) },
    initialPins: [
      pin("initial-config.json", Buffer.from("{}")),
      pin("initial-registry.json", Buffer.from(JSON.stringify(registry))),
    ],
  };
  evidence = RhythmEvidenceSchema.parse({ ...evidence, sha256: rhythmDigest(evidence) });
  const evidenceFile = "pipeline/rhythm/data.evidence.json";
  writeFileSync(path.join(project, evidenceFile), JSON.stringify(evidence));
  const marks = {
    version: 1 as const,
    contract: "reviewed-rhythm-marks-v1" as const,
    projectId: "demo",
    evidence: { path: evidenceFile, sha256: hash(readFileSync(path.join(project, evidenceFile))) },
    trackId: "music",
    clipId: "clip",
    expectedRevision: 0,
    review: {
      kind: "supplied-review" as const,
      reviewedBy: "Fixture only; not human listening",
      note: "Stage B data-only association",
      acknowledge: "reviewed-source-marks-not-calibrated-beat-truth" as const,
    },
    marks: [
      { id: "start", origin: "manual-reviewed-mark" as const, sample: 0 },
      { id: "pulse", origin: "evidence-onset" as const, onsetId: "onset-0" },
    ],
  };
  return {
    root,
    project,
    asset,
    timeline,
    evidence: evidence as RhythmEvidence,
    marks,
    runtime,
    evidenceFile,
    privateFolder,
  };
}
test("strict clock proves zero origin/exact samples and reduced original→16k relation", () => {
  assert.deepEqual(validateRhythmClock(clock(44100, 44100)).duration, { num: 1, den: 1 });
  assert.equal(validateRhythmClock(clock(44100, 44100)).analysisSamples, 16000);
  assert.equal(validateRhythmClock(clock()).analysisSamples, 16000);
});
test("one-sample offset/gap/overlap and contradictory terminal are rejected without tolerances", () => {
  for (const pts of [1023, 1025])
    assert.throws(
      () =>
        validateRhythmClock({
          ...clock(),
          frames: [
            { pts: 0, nbSamples: 1024 },
            { pts, nbSamples: 14976 },
          ],
        }),
      /offset\/gap\/overlap/,
    );
  assert.throws(() => validateRhythmClock({ ...clock(), frames: [{ pts: 1, nbSamples: 16000 }] }), /offset/);
  assert.throws(() => validateRhythmClock({ ...clock(), terminalTick: 16001 }), /terminal/);
  assert.throws(() => validateRhythmClock({ ...clock(), frames: [{ pts: -1, nbSamples: 16000 }] }));
});
test("fractional resample extent, >300s, unsafe PTS and unknown codec/frame fields refuse", () => {
  assert.throws(() => validateRhythmClock(clock(44100, 1)), /fractional/);
  assert.throws(
    () =>
      validateRhythmClock({
        ...clock(),
        sampleRate: 8000,
        timebase: { num: 1, den: 8000 },
        terminalTick: 2408000,
        frames: Array.from({ length: 301 }, (_, i) => ({ pts: i * 8000, nbSamples: 8000 })),
      }),
    /300/,
  );
  for (const bad of [
    { ...clock(), codec: "aac" },
    { ...clock(), frames: [{ pts: Number.MAX_SAFE_INTEGER + 1, nbSamples: 1 }] },
    { ...clock(), frames: [{ pts: 0, nbSamples: 16000, fillGap: true }] },
  ])
    assert.equal(RhythmClockSchema.safeParse(bad).success, false);
});
test("shared legacy PCM kernel retains exact report shape/overrides/120BPM pulse values, no decoder", () => {
  const bytes = Buffer.alloc(48000 * 4);
  for (const hop of [25, 50, 75, 100, 125])
    for (let i = hop * 320; i < (hop + 1) * 320; i++) bytes.writeFloatLE(0.25, i * 4);
  const { report, onsetSamples } = analyzeRhythmPcm(bytes, 3, "a".repeat(64));
  assert.deepEqual(onsetSamples, [8000, 16000, 24000, 32000, 40000]);
  assert.deepEqual(report, {
    sourceSha256: "a".repeat(64),
    durationSec: 3,
    algorithm: "rms-onset-v1",
    onsetsSec: [0.5, 1, 1.5, 2, 2.5],
    tempoBpm: 120,
    confidence: 1,
    beatCandidatesSec: [0.5, 1, 1.5, 2, 2.5],
    overrides: null,
    fallback: "candidate-beats",
    sections: [{ startSec: 0, endSec: 3, rms: 1 / 120 }],
    automaticCuts: false,
  });
  const overridden = analyzeRhythmPcm(Buffer.alloc(16000 * 4), 1, "b".repeat(64), {
    beatsSec: [0.3, 0.7],
    note: "exact supplied override",
    reviewedBy: "fixture",
  }).report;
  assert.deepEqual(overridden.beatCandidatesSec, [0.3, 0.7]);
  assert.equal(overridden.fallback, "reviewed-marks");
});
test("pure silence and nonfinite PCM retain honest empty candidates/refusal, never calibrated truth", () => {
  const report = analyzeRhythmPcm(Buffer.alloc(16000 * 4), 1, "a".repeat(64)).report;
  assert.equal(report.tempoBpm, null);
  assert.deepEqual(report.beatCandidatesSec, []);
  const bad = Buffer.alloc(4);
  bad.writeFloatLE(NaN);
  assert.throws(() => analyzeRhythmPcm(bad, 1, "a".repeat(64)), /Nonfinite/);
});
test("closed request/review/schema reject executable authority, wrong asset, missing review, arrays and unknown fields", (t) => {
  const f = fixture(t);
  for (const bad of [
    { ...f.marks, execute: true },
    { ...f.marks, review: undefined },
    { ...f.marks, review: { ...f.marks.review, note: " " } },
    { ...f.marks, marks: [{ id: "x", origin: "manual-reviewed-mark", sample: 0.5 }] },
  ])
    assert.equal(ReviewedRhythmMarksSchema.safeParse(bad).success, false);
  assert.equal(RhythmAnalysisRequestSchema.safeParse({ ...f.evidence.request, toolPath: "/bin/sh" }).success, false);
  assert.equal(
    RhythmAnalysisRequestSchema.safeParse({ ...f.evidence.request, assetSha256: "a".repeat(64) }).success,
    false,
  );
  assert.equal(RhythmEvidenceSchema.safeParse({ ...f.evidence, calibratedBeatTruth: true }).success, false);
});
test("pure mark mapping preserves all half-open trim rows and exact rate/timebase subframes", (t) => {
  const f = fixture(t),
    timeline = structuredClone(f.timeline);
  timeline.tracks[0].clips[0].source.start = { num: 15, den: 1 };
  timeline.tracks[0].clips[0].rate = { num: 3, den: 2 };
  const request = {
    ...f.marks,
    marks: [
      { id: "before", origin: "manual-reviewed-mark" as const, sample: 0 },
      { id: "at-start", origin: "manual-reviewed-mark" as const, sample: 8000 },
      { id: "late", origin: "manual-reviewed-mark" as const, sample: 15999 },
    ],
  };
  const mapped = mapReviewedRhythmMarks(f.evidence, request, timeline);
  assert.equal(mapped.rows.length, 3);
  assert.equal(mapped.excluded, 1);
  assert.deepEqual(mapped.rows[1], {
    id: "at-start",
    origin: "manual-reviewed-mark",
    sample: 8000,
    sourceFrame: { num: 15, den: 1 },
    status: "included",
    outputFrame: { num: 10, den: 1 },
    outputSeconds: { num: 1, den: 3 },
  });
  assert.equal(mapped.rows[2].status, "included");
  if (mapped.rows[2].status === "included") assert.deepEqual(mapped.rows[2].outputFrame, { num: 15999, den: 800 });
  timeline.tracks[0].clips[0].source.end = { num: 15, den: 1 };
  timeline.tracks[0].clips[0].source.start = { num: 0, den: 1 };
  const endpoint = mapReviewedRhythmMarks(f.evidence, request, timeline);
  assert.equal(endpoint.rows[1].status, "outside-source-trim");
});
test("fractional 30000/1001 rate uses exact BigInt reduced rational mapping", (t) => {
  const f = fixture(t),
    timeline = structuredClone(f.timeline);
  timeline.tracks[0].clips[0].rate = { num: 30000, den: 1001 };
  const mapped = mapReviewedRhythmMarks(f.evidence, f.marks, timeline);
  assert.equal(mapped.rows[1].status, "included");
  if (mapped.rows[1].status === "included") assert.deepEqual(mapped.rows[1].outputFrame, { num: 21001, den: 2000 });
});
test("nonmusic/loop/unregistered source, physical tail, unknown onset, duplicate/reordered samples and rational overflow refuse", (t) => {
  const f = fixture(t);
  for (const mutate of [
    (tl: any) => (tl.tracks[0].kind = "voiceover"),
    (tl: any) => (tl.tracks[0].clips[0].payload = { loop: true }),
    (tl: any) => (tl.tracks[0].clips[0].assetId = "foreign"),
    (tl: any) => (tl.tracks[0].clips[0].source.end = { num: 31, den: 1 }),
    (tl: any) => (tl.tracks[0].clips[0].start = { num: Number.MAX_SAFE_INTEGER, den: 1 }),
  ]) {
    const tl = structuredClone(f.timeline);
    mutate(tl);
    assert.throws(() => mapReviewedRhythmMarks(f.evidence, f.marks, tl));
  }
  for (const marks of [
    [{ id: "x", origin: "evidence-onset", onsetId: "missing" }],
    [
      { id: "same", origin: "manual-reviewed-mark", sample: 1 },
      { id: "same", origin: "manual-reviewed-mark", sample: 2 },
    ],
    [
      { id: "x", origin: "manual-reviewed-mark", sample: 2 },
      { id: "y", origin: "manual-reviewed-mark", sample: 1 },
    ],
    [{ id: "x", origin: "manual-reviewed-mark", sample: 16000 }],
  ])
    assert.throws(() => mapReviewedRhythmMarks(f.evidence, { ...f.marks, marks } as any, f.timeline));
});
test("bounded read-only evidence/current mapping reconstructs every row/pin from DATA and never invokes a tool or writes", (t) => {
  const f = fixture(t);
  const before = readFileSync(path.join(f.project, "pipeline/timeline-edit.json"));
  const evidence = readRhythmEvidence(f.root, "demo", f.evidenceFile, f.marks.evidence.sha256, f.runtime);
  assert.equal(evidence.calibratedBeatTruth, false);
  const mapped = prepareRhythmMarks(f.root, "demo", f.marks, f.runtime);
  assert.equal(mapped.included, 2);
  assert.equal(mapped.readonly, true);
  assert.equal(mapped.timelineMutation, false);
  assert.ok(mapped.currentPins.some((p) => p.kind === "absent" && p.path.endsWith("audio-mix.json")));
  assert.deepEqual(readFileSync(path.join(f.project, "pipeline/timeline-edit.json")), before);
  assert.deepEqual(readdirSync(path.join(f.project, "pipeline/rhythm")), ["data.evidence.json"]);
});
test("sidecar coherent tampering is refused by complete current reconstruction; old bytes remain unchanged", (t) => {
  const f = fixture(t),
    mapped = prepareRhythmMarks(f.root, "demo", f.marks, f.runtime),
    file = "pipeline/rhythm/data.marks.json";
  writeFileSync(path.join(f.project, file), JSON.stringify(mapped));
  assert.deepEqual(
    inspectRhythmMarks(f.root, "demo", file, hash(readFileSync(path.join(f.project, file))), f.runtime),
    mapped,
  );
  const altered: any = structuredClone(mapped);
  altered.rows[0].outputFrame.num++;
  const { sha256, ...payload } = altered;
  altered.sha256 = rhythmDigest(payload);
  writeFileSync(path.join(f.project, file), JSON.stringify(altered));
  assert.throws(
    () => inspectRhythmMarks(f.root, "demo", file, hash(readFileSync(path.join(f.project, file))), f.runtime),
    /reconstruction/,
  );
});
test("current revision/config/absent automation drift makes old sidecar stale without reanalysis or mutation", (t) => {
  const f = fixture(t),
    mapped = prepareRhythmMarks(f.root, "demo", f.marks, f.runtime),
    file = "pipeline/rhythm/data.marks.json";
  writeFileSync(path.join(f.project, file), JSON.stringify(mapped));
  const saved = readFileSync(path.join(f.project, file));
  writeFileSync(path.join(f.project, "project.json"), '{"changed":true}');
  assert.throws(() => inspectRhythmMarks(f.root, "demo", file, hash(saved), f.runtime), /stale/);
  writeFileSync(path.join(f.project, "project.json"), "{}");
  writeFileSync(path.join(f.project, "pipeline/audio-mix.json"), "{}");
  assert.throws(() => inspectRhythmMarks(f.root, "demo", file, hash(saved), f.runtime), /stale/);
  rmSync(path.join(f.project, "pipeline/audio-mix.json"));
  const journal = JSON.parse(readFileSync(path.join(f.project, "pipeline/timeline-edit.json"), "utf8"));
  journal.revision = 1;
  writeFileSync(path.join(f.project, "pipeline/timeline-edit.json"), JSON.stringify(journal));
  assert.throws(() => prepareRhythmMarks(f.root, "demo", f.marks, f.runtime), /revision/);
  assert.deepEqual(readFileSync(path.join(f.project, file)), saved);
});
test("source/PCM/clock/tool/evidence checksum and role bounds cannot be bypassed by report paths", async (t) => {
  for (const kind of ["source", "pcm", "clock", "tool", "evidence", "path"] as const)
    await t.test(kind, (t) => {
      const f = fixture(t);
      if (kind === "source") writeFileSync(path.join(f.root, f.evidence.original.path), "changed");
      if (kind === "pcm") writeFileSync(path.join(f.root, f.evidence.artifacts.pcm.path), Buffer.alloc(4));
      if (kind === "clock") writeFileSync(path.join(f.root, f.evidence.artifacts.clock.path), "{}");
      if (kind === "tool") writeFileSync(f.runtime.ffmpeg.file, "changed tool data");
      if (kind === "evidence") writeFileSync(path.join(f.project, f.evidenceFile), "{}");
      const request =
        kind === "path" ? { ...f.marks, evidence: { ...f.marks.evidence, path: "../foreign.json" } } : f.marks;
      assert.throws(() => prepareRhythmMarks(f.root, "demo", request, f.runtime));
    });
});
test("malformed UTF8, byte ceiling, broken aliases and FIFO data reads refuse without waiting", (t) => {
  const f = fixture(t),
    file = "public/projects/demo/pipeline/bounded.json";
  writeFileSync(path.join(f.root, file), Buffer.from([255]));
  assert.throws(() => new RhythmReadContext(f.root).json(file, 1024));
  writeFileSync(path.join(f.root, file), "12345");
  assert.throws(() => new RhythmReadContext(f.root).read(file, 4), /byte bound/);
  rmSync(path.join(f.root, file));
  symlinkSync("/no-such-target", path.join(f.root, file));
  assert.throws(() => new RhythmReadContext(f.root).optional(file, 1024), /regular\/non-alias/);
  rmSync(path.join(f.root, file));
  assert.equal(spawnSync("mkfifo", [path.join(f.root, file)], { timeout: 1000 }).status, 0);
  const code = `import {RhythmReadContext} from './src/lib/audio/rhythm-files.ts';try{new RhythmReadContext(${JSON.stringify(f.root)}).json(${JSON.stringify(file)},1024);process.exitCode=2;}catch(e){console.log(e.message);}`;
  const result = spawnSync(process.execPath, [path.join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "-e", code], {
    cwd: process.cwd(),
    env: { AGENTBROS_NO_DOTENV: "1", PATH: process.env.PATH!, HOME: process.env.HOME! },
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 32768,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /regular\/non-alias/);
});
test("same consumed-FD growth, parent aliases, absent appearance and membership changes are checked", async (t) => {
  const f = fixture(t),
    file = "public/projects/demo/pipeline/bounded.json";
  writeFileSync(path.join(f.root, file), "{}");
  const fs = await import("node:fs"),
    { syncBuiltinESMExports } = await import("node:module"),
    original = fs.default.readSync;
  let changed = false;
  const inode = fs.statSync(path.join(f.root, file)).ino;
  fs.default.readSync = ((...args: Parameters<typeof original>) => {
    const n = Reflect.apply(original, fs.default, args);
    if (!changed && fs.fstatSync(args[0]).ino === inode) {
      changed = true;
      fs.appendFileSync(path.join(f.root, file), " ");
    }
    return n;
  }) as typeof original;
  syncBuiltinESMExports();
  try {
    assert.throws(() => new RhythmReadContext(f.root).json(file, 1024), /grew\/changed/);
  } finally {
    fs.default.readSync = original;
    syncBuiltinESMExports();
  }
  const reader = new RhythmReadContext(f.root);
  reader.optional("public/projects/demo/pipeline/absent.json", 1024);
  writeFileSync(path.join(f.project, "pipeline/absent.json"), "{}");
  assert.throws(() => reader.assertUnchanged(), /membership|absent/);
  symlinkSync(path.join(f.project, "pipeline"), path.join(f.project, "alias"));
  assert.throws(
    () => new RhythmReadContext(f.root).read("public/projects/demo/alias/bounded.json", 1024),
    /parent alias/,
  );
});
test("shared admitted verification accounting persists across contexts/repeats; failure is not a hard physical IO cap", (t) => {
  const f = fixture(t),
    budget = new RhythmReadBudget();
  budget.consumed = 256 * 1024 * 1024;
  const reader = new RhythmReadContext(f.root, budget);
  assert.throws(() => reader.read("public/projects/demo/project.json", 1024), /threshold/);
  assert.equal(budget.consumed, 256 * 1024 * 1024 + 2);
  const other = new RhythmReadContext(f.root, budget);
  assert.throws(() => other.read("public/projects/demo/project.json", 1024), /threshold/);
  assert.equal(budget.consumed, 256 * 1024 * 1024 + 4);
});

test("pure mapping rejects changed digest, coherent inconsistent clock, duplicate onset identity and wrong source summaries", (t) => {
  const f = fixture(t);
  const changed = structuredClone(f.evidence);
  changed.clock.analysisSamples--;
  assert.throws(() => mapReviewedRhythmMarks(changed, f.marks, f.timeline), /digest/);
  for (const mutate of [
    (e: any) => (e.clock.duration = { num: 2, den: 1 }),
    (e: any) => e.clock.terminalTick++,
    (e: any) => e.clock.sourceSamples++,
    (e: any) => e.onsets.push({ ...e.onsets[0] }),
    (e: any) => (e.analysis.sourceSha256 = "a".repeat(64)),
  ]) {
    const e = structuredClone(f.evidence);
    mutate(e);
    const { sha256, ...payload } = e;
    e.sha256 = rhythmDigest(payload);
    assert.throws(() => mapReviewedRhythmMarks(e, f.marks, f.timeline));
  }
});
test("actual 30000/1001 output timebase and supplied review literal bytes are preserved without frame rounding", (t) => {
  const f = fixture(t),
    timeline = structuredClone(f.timeline);
  timeline.timebase = { num: 30000, den: 1001 };
  const mapped = mapReviewedRhythmMarks(f.evidence, f.marks, timeline);
  if (mapped.rows[1].status !== "included") assert.fail("Expected included half-second sample");
  assert.deepEqual(mapped.rows[1].outputFrame, { num: 25010, den: 1001 });
  assert.deepEqual(mapped.rows[1].outputSeconds, { num: 2501, den: 3000 });
  const request = { ...f.marks, review: { ...f.marks.review, note: "  supplied\nreview bytes  " } };
  assert.equal(prepareRhythmMarks(f.root, "demo", request, f.runtime).request.review.note, request.review.note);
});

test("new opt-in exact clock rejects subsecond sources while legacy numerical kernel remains unrestricted", () => {
  assert.throws(() => validateRhythmClock(clock(16000, 1600)), /shorter than one second/);
  assert.equal(analyzeRhythmPcm(Buffer.alloc(1600 * 4), 0.1, "a".repeat(64)).report.durationSec, 0.1);
});
test("current no-snapshot DATA shape works, historical implementation identity refuses before missing private artifacts", (t) => {
  const f = fixture(t);
  assert.equal(
    readRhythmEvidence(f.root, "demo", f.evidenceFile, f.marks.evidence.sha256, f.runtime).artifacts.originalSnapshot,
    undefined,
  );
  const stale = structuredClone(f.evidence);
  stale.implementations.evidence = "0ad0ce7f10e5efc327841be64f9b55688070892ada18eb5233af38e4cff9b551";
  const { sha256, ...payload } = stale;
  stale.sha256 = rhythmDigest(payload);
  const file = path.join(f.project, f.evidenceFile);
  writeFileSync(file, JSON.stringify(stale));
  rmSync(path.join(f.root, f.evidence.artifacts.clock.path));
  assert.throws(
    () => readRhythmEvidence(f.root, "demo", f.evidenceFile, hash(readFileSync(file)), f.runtime),
    /implementation stale/,
  );
});
