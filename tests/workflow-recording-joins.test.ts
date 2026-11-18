import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  planRecordingJoins,
  renderJoinedSpeech,
  decodeMasterPcm,
  SAMPLES_PER_FRAME,
} from "../src/lib/workflows/recording-joins";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { assertRecordingEvidence } from "../src/lib/workflows/recording-evidence";
import { RecordingEditRequestSchema, type RecordingJoinPolicy } from "../src/types/workflow-recording-edit";
import { recordingFixture } from "./workflow-recording-edit-fixtures";
import { timingFixture } from "./workflow-recording-timing-fixtures";

const policy: RecordingJoinPolicy = {
  crossfadeMs: 15,
  curve: "equal-power",
  snap: { energyWindowMs: 10, searchMs: 30, zeroCrossingMs: 5 },
  roomTone: null,
  punchIn: null,
};
const stereo = (frames: number, value: (n: number) => number) => {
  const pcm = new Int16Array(frames * SAMPLES_PER_FRAME * 2);
  for (let n = 0; n < pcm.length / 2; n++) pcm[n * 2] = pcm[n * 2 + 1] = Math.round(value(n));
  return pcm;
};
const noise = (n: number) => 3000 * Math.sin(n * 12.9898) * Math.sin(n * 0.731 + 1.3);
const maxStep = (pcm: Int16Array, from: number, to: number) => {
  let max = 0;
  for (let n = Math.max(1, from); n < to; n++) max = Math.max(max, Math.abs(pcm[n * 2] - pcm[(n - 1) * 2]));
  return max;
};
const v3 = (request: Record<string, unknown>, joins: Partial<RecordingJoinPolicy> = {}) => ({
  ...request,
  version: 3,
  joins: { ...policy, ...joins },
});
const review = (request: Record<string, unknown>, editHash: unknown) => ({
  ...request,
  review: {
    reviewer: "offline-test-declaration",
    reviewedAt: "2026-11-13T00:00:00Z",
    meaningPreserved: true,
    approvedEditHash: editHash,
  },
});

test("join snaps to the quietest 10ms window, then a zero crossing, and stays near the picture cut otherwise", () => {
  const J = 30 * SAMPLES_PER_FRAME,
    aEnd = 30 * SAMPLES_PER_FRAME,
    bStart = 60 * SAMPLES_PER_FRAME;
  const pocket = (n: number) =>
    (n >= aEnd + 576 && n < aEnd + 1200) || (n >= bStart + 576 && n < bStart + 1200) ? 0.01 : 1;
  const keeps = [
    { startFrame: 0, endFrame: 30 },
    { startFrame: 60, endFrame: 90 },
  ];
  const quiet = planRecordingJoins({
    pcm: stereo(90, (n) => noise(n) * pocket(n)),
    keeps,
    words: [],
    policy,
    roomTone: null,
  });
  assert.equal(quiet.joins.length, 1);
  assert.ok(Math.abs(quiet.joins[0].offsetSamples - 888) <= 240 + 1, JSON.stringify(quiet.joins[0]));
  assert.ok(quiet.joins[0].centreEnergyDbfs < -50);
  const flat = planRecordingJoins({ pcm: stereo(90, noise), keeps, words: [], policy, roomTone: null });
  assert.ok(
    Math.abs(flat.joins[0].offsetSamples) <= 240,
    "without a clearly quieter window the join stays within 5ms of the picture cut",
  );
  assert.equal(flat.joins[0].crossfadeSamples, 720);
  assert.equal(J, quiet.joins[0].outputFrame * SAMPLES_PER_FRAME);
});

test("a zero crossing past the search edge still reports a finite join level", () => {
  const aEnd = 30 * SAMPLES_PER_FRAME,
    bStart = 60 * SAMPLES_PER_FRAME;
  const pcm = stereo(90, (n) => {
    const a = n - aEnd,
      b = n - bStart;
    if (a >= 1200 && a < 1700) return a < 1540 ? 10 : -10;
    if (b >= 1200 && b < 1700) return 0;
    return 3000;
  });
  const plan = planRecordingJoins({
    pcm,
    keeps: [
      { startFrame: 0, endFrame: 30 },
      { startFrame: 60, endFrame: 90 },
    ],
    words: [],
    policy,
    roomTone: null,
  });
  const join = plan.joins[0];
  assert.equal(join.offsetSamples, 1540);
  assert.equal(join.zeroCrossing, true);
  assert.ok(Number.isFinite(join.centreEnergyDbfs), JSON.stringify(join));
});

test("join handles never reach into excluded or kept words, and a join with no silence fails closed", () => {
  const keeps = [
    { startFrame: 0, endFrame: 30 },
    { startFrame: 60, endFrame: 90 },
  ];
  const words = [
    { startFrame: 10, endFrame: 29 },
    { startFrame: 30, endFrame: 59 },
    { startFrame: 61, endFrame: 80 },
  ];
  const plan = planRecordingJoins({ pcm: stereo(90, noise), keeps, words, policy, roomTone: null });
  const { offsetSamples, crossfadeSamples } = plan.joins[0];
  assert.ok(
    offsetSamples - crossfadeSamples / 2 >= -SAMPLES_PER_FRAME && offsetSamples + crossfadeSamples / 2 <= 0,
    JSON.stringify(plan.joins[0]),
  );
  assert.throws(
    () =>
      planRecordingJoins({
        pcm: stereo(90, noise),
        keeps,
        words: [
          { startFrame: 10, endFrame: 30 },
          { startFrame: 30, endFrame: 59 },
          { startFrame: 60, endFrame: 80 },
        ],
        policy,
        roomTone: null,
      }),
    /under 5ms of silence/,
  );
  assert.throws(
    () =>
      planRecordingJoins({
        pcm: stereo(90, noise),
        keeps,
        words,
        policy,
        roomTone: { startFrame: 20, endFrame: 40, gainDb: -6 },
      }),
    /overlaps a transcript word/,
  );
});

test("equal-power crossfade removes the hard-cut discontinuity and keeps the exact frame length", () => {
  const sine = (n: number) =>
    n < 45 * SAMPLES_PER_FRAME
      ? 8000 * Math.sin((2 * Math.PI * 440 * n) / 48000)
      : 8000 * Math.sin((2 * Math.PI * 660 * n) / 48000 + 1.7);
  const pcm = stereo(90, sine);
  const keeps = [
    { startFrame: 0, endFrame: 31 },
    { startFrame: 60, endFrame: 90 },
  ];
  const plan = planRecordingJoins({ pcm, keeps, words: [], policy, roomTone: null });
  const joined = renderJoinedSpeech(pcm, keeps, plan);
  assert.equal(joined.length, 61 * SAMPLES_PER_FRAME * 2);
  const J = 31 * SAMPLES_PER_FRAME;
  const hard = new Int16Array(joined.length);
  hard.set(pcm.subarray(0, J * 2));
  hard.set(pcm.subarray(60 * SAMPLES_PER_FRAME * 2, 90 * SAMPLES_PER_FRAME * 2), J * 2);
  const toneStep = (8000 * 2 * Math.PI * 660) / 48000;
  assert.ok(maxStep(hard, J - 50, J + 50) > 3 * toneStep, "the fixture has a real click without a crossfade");
  assert.ok(
    maxStep(joined, J - 2000, J + 2000) <= toneStep * Math.SQRT2 * 1.05,
    `crossfaded join step ${maxStep(joined, J - 2000, J + 2000)} vs tone ${toneStep}`,
  );
  for (let n = 0; n < J - 2000; n++) assert.equal(joined[n * 2], pcm[n * 2]);
  const toned = renderJoinedSpeech(pcm, keeps, { ...plan, roomTone: { startFrame: 50, endFrame: 55, gainDb: -6 } });
  let changed = 0;
  for (let n = 0; n < toned.length / 2; n++)
    if (toned[n * 2] !== joined[n * 2]) {
      changed++;
      assert.ok(Math.abs(n - J) < 1500, `room tone only under the join, saw ${n}`);
    }
  assert.ok(changed > 500);
});

test("version 3 request binds the join plan into the review hash, creates joined speech and punch-ins, and fails closed on tampering", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "recording-joins-"));
  try {
    const base = recordingFixture(root);
    const request = v3(base, { punchIn: { scale: 1.12, pattern: "alternate" } });
    assert.equal(RecordingEditRequestSchema.parse(request).version, 3);
    const plan = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
    const legacy = await runRecordingEditWorkflow(base, { action: "plan", rootDir: root });
    assert.notEqual(plan.metadata.editHash, legacy.metadata.editHash);
    assert.equal((plan.metadata.joins as { joins: unknown[] }).joins.length, 1);
    const changed = await runRecordingEditWorkflow(
      v3(base, { crossfadeMs: 20, punchIn: { scale: 1.12, pattern: "alternate" } }),
      { action: "plan", rootDir: root },
    );
    assert.notEqual(changed.metadata.editHash, plan.metadata.editHash);
    await assert.rejects(
      runRecordingEditWorkflow(
        review(v3(base, { crossfadeMs: 20, punchIn: { scale: 1.12, pattern: "alternate" } }), plan.metadata.editHash),
        { action: "create", rootDir: root },
      ),
      /stale/,
    );
    await runRecordingEditWorkflow(review(request, plan.metadata.editHash), { action: "create", rootDir: root });
    const project = path.join(root, "public/projects/recut");
    assert.ok(assertRecordingEvidence(project, "recut"));
    const report = JSON.parse(readFileSync(path.join(project, "pipeline/recording-edit.json"), "utf8"));
    const timeline = JSON.parse(readFileSync(path.join(project, "pipeline/timeline-edit.json"), "utf8")).timeline;
    const [picture, speech, captions] = timeline.tracks;
    assert.deepEqual(
      picture.clips.map((c: any) => c.payload.transform?.scale ?? 1),
      [1, 1.12],
    );
    assert.ok(
      speech.clips.every((c: any) => c.assetId === report.joins.joinedAudioAssetId && c.payload.joinedSpeech === true),
    );
    assert.deepEqual(
      speech.clips.map((c: any) => [c.start.num, c.source.start.num, c.source.end.num]),
      [
        [0, 0, 30],
        [30, 30, 60],
      ],
    );
    assert.deepEqual(
      captions.clips.map((c: any) => [c.source.start.num, c.source.end.num]),
      [
        [0, 30],
        [60, 90],
      ],
    );
    const original = JSON.parse(
      readFileSync(path.join(project, "pipeline/recording-edit-original-timeline.json"), "utf8"),
    );
    assert.equal(original.tracks[1].clips[0].assetId, report.audioAssetId);
    const registry = JSON.parse(readFileSync(path.join(project, "pipeline/asset-registry.json"), "utf8"));
    const joinedRecord = registry.assets.find((a: any) => a.id === report.joins.joinedAudioAssetId);
    assert.equal(joinedRecord.media.durationSec, 2);
    assert.deepEqual(joinedRecord.provenance.referenceAssetIds, [report.audioAssetId]);
    const joinedFile = path.join(root, "public", joinedRecord.files.original);
    const pcm = decodeMasterPcm(joinedFile, 60, false);
    const J = 30 * SAMPLES_PER_FRAME;
    assert.ok(maxStep(pcm, J - 1000, J + 1000) < 3000, "no click at the join of the created speech");
    const bytes = readFileSync(joinedFile);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(joinedFile, bytes);
    assert.throws(() => assertRecordingEvidence(project, "recut"), /bytes changed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("version 3 accepts the reviewed rational normalisation and binds joined speech to master coordinates", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "recording-joins-ntsc-"));
  try {
    const fixture = timingFixture(root, "ntsc");
    const request = v3(fixture.request, { roomTone: null });
    const plan = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
    await runRecordingEditWorkflow(review(request, plan.metadata.editHash), { action: "create", rootDir: root });
    const project = path.join(root, "public/projects/recut-ntsc");
    assert.ok(assertRecordingEvidence(project, "recut-ntsc"));
    const report = JSON.parse(readFileSync(path.join(project, "pipeline/recording-edit.json"), "utf8"));
    assert.equal(report.version, 3);
    assert.ok(report.normalization && report.joins.joinPlanHash === report.identity.joinPlanHash);
    report.joins.plan.joins[0].offsetSamples += 1;
    writeFileSync(path.join(project, "pipeline/recording-edit.json"), JSON.stringify(report));
    assert.throws(() => assertRecordingEvidence(project, "recut-ntsc"), /join plan/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test(
  "rendered version 3 recut has no click at the join and an exact frame duration",
  {
    skip: process.env.RUN_WORKFLOW_RENDER_TESTS !== "1",
    timeout: 240000,
  },
  async () => {
    const { bundle } = await import("@remotion/bundler");
    const { enableTailwind } = await import("@remotion/tailwind-v4");
    const { selectComposition, renderMedia } = await import("@remotion/renderer");
    const { planProjectRender } = await import("../src/lib/render-plan");
    const root = mkdtempSync(path.join(tmpdir(), "recording-joins-render-"));
    const retained = process.env.WORKFLOW_ARTIFACTS_DIR
      ? path.resolve(process.env.WORKFLOW_ARTIFACTS_DIR, "recording-joins")
      : undefined;
    try {
      const base = recordingFixture(root);
      const request = v3(
        {
          ...base,
          keepSpans: [{ ...base.keepSpans[0], endFrame: 28 }, base.keepSpans[1]],
          cuts: [{ ...base.cuts[0], startFrame: 28 }],
        },
        { punchIn: { scale: 1.12, pattern: "alternate" } },
      );
      const plan = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
      await runRecordingEditWorkflow(review(request, plan.metadata.editHash), { action: "create", rootDir: root });
      const job = planProjectRender("recut", "landscape", root, { timeline: true }).jobs[0];
      assert.equal(job.durationInFrames, 58);
      const serveUrl = await bundle({
        entryPoint: path.resolve("src/index.ts"),
        publicDir: path.join(root, "public"),
        outDir: path.join(root, "bundle"),
        webpackOverride: (config) => {
          const c = enableTailwind(config);
          return {
            ...c,
            resolve: {
              ...c.resolve,
              alias: {
                ...c.resolve?.alias,
                [path.resolve("src/lib/fonts")]: path.resolve("tests/fixtures/offline-fonts.ts"),
              },
            },
          };
        },
      });
      const composition = await selectComposition({ serveUrl, id: job.compositionId, inputProps: job.props });
      const output = path.join(root, "recut.mp4");
      await renderMedia({
        serveUrl,
        composition,
        inputProps: job.props,
        codec: "h264",
        outputLocation: output,
        concurrency: 1,
        scale: 0.25,
        logLevel: "error",
      });
      const frames = Number(
        JSON.parse(
          execFileSync(
            "ffprobe",
            [
              "-v",
              "error",
              "-count_frames",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=nb_read_frames",
              "-of",
              "json",
              output,
            ],
            { encoding: "utf8" },
          ),
        ).streams[0].nb_read_frames,
      );
      assert.equal(frames, 58);
      const decode = (file: string) => {
        const b = execFileSync(
          "ffmpeg",
          ["-v", "error", "-i", file, "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "-"],
          { maxBuffer: 64 * 1024 * 1024 },
        );
        return new Float32Array(b.buffer, b.byteOffset, b.length / 4);
      };
      const rendered = decode(output);
      assert.ok(
        Math.abs(rendered.length - 58 * SAMPLES_PER_FRAME) <= SAMPLES_PER_FRAME,
        `audio ${rendered.length} samples`,
      );
      const curvature = (x: Float32Array, from: number, to: number) => {
        let max = 0;
        for (let n = Math.max(2, from); n < Math.min(x.length, to); n++)
          max = Math.max(max, Math.abs(x[n] - 2 * x[n - 1] + x[n - 2]));
        return max;
      };
      const J = 28 * SAMPLES_PER_FRAME;
      const authentic = decode(
        path.join(
          root,
          "public",
          JSON.parse(
            readFileSync(path.join(root, "public/projects/recut/pipeline/asset-registry.json"), "utf8"),
          ).assets.find(
            (a: any) =>
              a.id ===
              JSON.parse(readFileSync(path.join(root, "public/projects/recut/pipeline/recording-edit.json"), "utf8"))
                .audioAssetId,
          ).files.original,
        ),
      );
      const hard = new Float32Array(58 * SAMPLES_PER_FRAME);
      hard.set(authentic.subarray(0, J));
      hard.set(authentic.subarray(60 * SAMPLES_PER_FRAME, 90 * SAMPLES_PER_FRAME), J);
      const hardClick = curvature(hard, J - 960, J + 960),
        renderedJoin = curvature(rendered, J - 960, J + 960),
        renderedBody = curvature(rendered, 10 * SAMPLES_PER_FRAME, 25 * SAMPLES_PER_FRAME);
      assert.ok(hardClick > 0.08, `fixture must click without a crossfade (${hardClick})`);
      assert.ok(
        renderedJoin < 0.02,
        `rendered join curvature ${renderedJoin} (hard cut ${hardClick}, body ${renderedBody})`,
      );
      if (retained) {
        mkdirSync(retained, { recursive: true });
        copyFileSync(output, path.join(retained, "joined-recut.mp4"));
        writeFileSync(
          path.join(retained, "join-report.json"),
          JSON.stringify(
            {
              technicalOnly: true,
              synthetic: true,
              frames,
              audioSamples: rendered.length,
              hardClick,
              renderedJoin,
              renderedBody,
              joins: plan.metadata.joins,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
