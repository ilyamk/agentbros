import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, realpathSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { hashFile, readAssetRegistry } from "../src/lib/assets/registry";
import { planProjectRender } from "../src/lib/render-plan";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";
import { COMMANDS } from "../src/mcp/catalog";
import { invokeCommand } from "../src/mcp/bridge";
import { recordingFixture } from "./workflow-recording-edit-fixtures";
import { timingFixture, keepMasterBoundary, tone } from "./workflow-recording-timing-fixtures";
const repo = path.resolve(import.meta.dirname, "..");
function fixture(t: test.TestContext) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "recording-timing-audit-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
async function review(root: string, request: unknown) {
  const plan = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
  return {
    ...(request as Record<string, unknown>),
    review: {
      reviewer: "SYNTHETIC TIMING TEST ONLY",
      reviewedAt: "2026-10-11T00:00:00Z",
      approvedEditHash: plan.metadata.editHash,
      meaningPreserved: true,
    },
  };
}
for (const mode of ["ntsc", "vfr"] as const) {
  test(`${mode}: actual public CLI read-only plan and scoped MCP create bind measured PTS and one authentic audio owner`, async (t) => {
    const root = fixture(t),
      f = timingFixture(root, mode),
      requestFile = path.join(root, "request.json");
    if (mode === "vfr")
      assert.ok(
        f.pts.some((time, i) => i > 0 && time - f.pts[i - 1] > 0.06),
        "VFR fixture must have genuinely uneven decoded PTS",
      );
    else assert.ok(Math.abs(f.pts[60] - 60 / 30) > 0.001, "29.97 fixture must differ from 30fps source clock");
    writeFileSync(requestFile, JSON.stringify(f.request));
    const cli = spawnSync(
      process.execPath,
      [
        path.join(repo, "node_modules/tsx/dist/cli.mjs"),
        path.join(repo, "scripts/video-workflow.ts"),
        "--scenario=recording-edit",
        "--request=request.json",
        "--action=create",
        "--dry-run",
      ],
      { cwd: root, encoding: "utf8", timeout: 120000 },
    );
    assert.equal(cli.status, 0, cli.stderr || cli.stdout);
    assert.equal(cli.stdout.trim().split("\n").length, 1);
    const planned = JSON.parse(cli.stdout);
    assert.equal(planned.ok, true);
    assert.equal(planned.metadata.action, "plan");
    assert.equal(planned.metadata.apiCalls, 0);
    assert.equal(planned.metadata.apiSpendUsd, 0);
    assert.deepEqual(planned.outputs, []);
    assert.ok(!existsSync(path.join(root, "public")) && !existsSync(path.join(root, ".cache")));
    const expected =
      keepMasterBoundary(f, f.two, "end") +
      keepMasterBoundary(f, f.pts.length, "end") -
      keepMasterBoundary(f, f.four, "start");
    assert.equal(planned.metadata.durationInFrames, expected);
    const request = await review(root, f.request);
    writeFileSync(requestFile, JSON.stringify(request));
    const created = await invokeCommand(
      COMMANDS.find((c) => c.name === "video_workflow")!,
      { scenario: "recording-edit", request: "request.json", action: "create" },
      { root, codeRoot: repo, allowPaid: false, stderr: () => {} },
    );
    assert.equal(created.ok, true, created.message ?? "MCP create failed");
    assert.equal((created.metadata as Record<string, unknown>).apiSpendUsd, 0);
    const project = path.join(root, "public/projects", f.request.projectId);
    const registry = readAssetRegistry(f.request.projectId, root);
    assert.ok(
      registry.assets.some((asset) => asset.hash === f.request.source.sha256),
      "bit-identical original must remain imported",
    );
    const store = new TimelineEditStore(path.join(project, "pipeline/timeline-edit.json"));
    const ir = store.read().timeline;
    assert.deepEqual(
      ir.tracks.map((track) => track.kind),
      ["visual", "voiceover", "captions"],
    );
    const speech = ir.tracks.find((track) => track.kind === "voiceover")!;
    const picture = ir.tracks.find((track) => track.kind === "visual")!;
    const captions = ir.tracks.find((track) => track.kind === "captions")!;
    for (const track of ir.tracks) {
      assert.deepEqual(
        track.clips.map((c) => c.start),
        picture.clips.map((c) => c.start),
      );
      assert.deepEqual(
        track.clips.map((c) => c.source),
        picture.clips.map((c) => c.source),
      );
      assert.ok(
        track.clips.every((c) => c.rate.num === 1 && c.rate.den === 1),
        "29.97 must retain wall-clock playback rather than speeding up",
      );
    }
    assert.notEqual(
      speech.clips[0].assetId,
      picture.clips[0].assetId,
      "video must be muted and speech must have exactly one owner",
    );
    const compiled = compileTimelineIR(ir);
    assert.equal(
      planProjectRender(f.request.projectId, "landscape", root, { timeline: true }).jobs[0].durationInFrames,
      expected,
    );
    assert.equal(
      compiled.tracks
        .find((track) => track.kind === "captions")!
        .clips.at(-1)!
        .captions.at(-1)!.text,
      "проверено.",
    );
    const audio = registry.assets.find((asset) => asset.id === speech.clips[0].assetId)!;
    const measured = tone(path.join(root, "public", audio.files.original), 4.5);
    assert.ok(Math.abs(measured.hz - 880) <= 8, JSON.stringify(measured));
    const command = {
      type: "batch",
      commands: ir.tracks.map((track) => ({
        type: "trim",
        trackId: track.id,
        clipId: "last",
        start: picture.clips[1].source.start,
        end: { num: picture.clips[1].source.end.num - 1, den: 1 },
      })),
    };
    const edited = store.apply(command, 0);
    assert.equal(edited.revision, 1);
    assert.deepEqual(store.undo(1).timeline, ir, "undo must restore picture, authentic speech and captions together");
    assert.deepEqual(store.redo(2).timeline, edited.timeline);
    assert.ok(captions.clips.at(-1)!.captions.length > 0);
    assert.equal(hashFile(f.request.source.file), f.request.source.sha256);
    const authored = JSON.parse(readFileSync(path.join(project, "pipeline/recording-edit.json"), "utf8"));
    assert.equal(authored.request.version, 2);
    assert.equal(authored.request.review.reviewer, "SYNTHETIC TIMING TEST ONLY");
  });
}
test("30000/1001 long input conserves measured elapsed time, not original frame count", async (t) => {
  const root = fixture(t),
    f = timingFixture(root, "ntsc", 24);
  f.request.keepSpans = [
    { id: "whole", startFrame: 0, endFrame: f.pts.length, reason: "Technical uncut conservation" },
  ];
  f.request.cuts = [];
  f.request.transcript.words = [{ id: "whole-word", text: "Тест.", startFrame: 0, endFrame: 20 }];
  f.request.protectedSpans = [];
  const planned = await runRecordingEditWorkflow(f.request, { action: "plan", rootDir: root });
  assert.equal(planned.metadata.durationInFrames, Math.ceil(f.duration * 30 - 1e-9));
  assert.notEqual(
    planned.metadata.durationInFrames,
    f.pts.length,
    "normalization must add clock-required output frames instead of 0.1% speedup",
  );
  assert.ok(!existsSync(path.join(root, "public")));
});
test("collapsed subframe spoken word and stale normalized review fail before output", async (t) => {
  const root = fixture(t),
    f = timingFixture(root, "high-fps");
  const collapsed = structuredClone(f.request);
  collapsed.transcript.words[0].endFrame = 1;
  await assert.rejects(
    () => runRecordingEditWorkflow(collapsed, { action: "plan", rootDir: root }),
    /collaps|round|normaliz|word/i,
  );
  const ntsc = timingFixture(root, "ntsc");
  ntsc.request.transcript.words.at(-1)!.endFrame--;
  const reviewed = await review(root, ntsc.request);
  const stale = structuredClone(reviewed) as typeof reviewed & { transcript: typeof ntsc.request.transcript };
  stale.transcript.version = "different-review";
  await assert.rejects(() => runRecordingEditWorkflow(stale, { action: "create", rootDir: root }), /stale/i);
  assert.ok(!existsSync(path.join(root, "public")));
});
test("legacy30fps v1 review identity preserves original JSON hash contract", async (t) => {
  const root = fixture(t),
    request = recordingFixture(root);
  const { source, ...edit } = request;
  const identity = {
    ...edit,
    source: { sha256: source.sha256, version: source.version, fps: source.fps, rights: {} },
    sourceFrameCount: 90,
  };
  const expected = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const result = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
  assert.equal(result.metadata.editHash, expected);
  const unexpectedV2Policy = {
    ...request,
    source: {
      ...source,
      normalization: {
        targetFps: { num: 30, den: 1 },
        video: "nearest-frame",
        boundaryRounding: "nearest",
        audio: "preserve-clock",
      },
    },
  };
  await assert.rejects(() => runRecordingEditWorkflow(unexpectedV2Policy, { action: "plan", rootDir: root }));
});
test("outward keep boundaries cover complete nongrid source words and reject contamination by excluded adjacent words", async (t) => {
  const root = fixture(t),
    f = timingFixture(root, "vfr-boundary");
  const start = f.four + 1;
  assert.ok(Math.abs(f.pts[start] - 4.05) < 0.000001);
  f.request.keepSpans[1].startFrame = start;
  f.request.cuts[0].endFrame = start;
  f.request.protectedSpans[1].startFrame = start;
  f.request.transcript.words[4].startFrame = start;
  f.request.transcript.words[4].endFrame = start + 4;
  f.request.transcript.words[5].startFrame = start + 4;
  const reviewed = await review(root, f.request);
  await runRecordingEditWorkflow(reviewed, { action: "create", rootDir: root });
  const journal = new TimelineEditStore(
    path.join(root, "public/projects", f.request.projectId, "pipeline/timeline-edit.json"),
  ).read();
  const sourceStart = journal.timeline.tracks[1].clips[1].source.start.num / 30;
  assert.ok(
    sourceStart <= f.pts[start],
    `Authentic first phoneme at ${f.pts[start]}s must not be clipped by master start ${sourceStart}s`,
  );
  assert.ok(
    sourceStart < Math.round(f.pts[start] * 30) / 30,
    "half-frame boundary must be expanded outward, not silently trimmed",
  );
  const unsafe = structuredClone(f.request);
  unsafe.projectId = "unsafe-adjacent-word";
  unsafe.transcript.words.splice(4, 0, {
    id: "excluded-adjacent",
    text: "Иное.",
    startFrame: start - 1,
    endFrame: start,
  });
  await assert.rejects(
    () => runRecordingEditWorkflow(unsafe, { action: "plan", rootDir: root }),
    /silence|excluded|round|outward|word/i,
  );
  assert.ok(!existsSync(path.join(root, "public/projects/unsafe-adjacent-word")));
});

test("VFR normalized picture provenance matches actual timestamp-coded decoded frame pixels", async (t) => {
  const root = fixture(t),
    f = timingFixture(root, "vfr");
  const coded = path.join(root, "timestamp-coded.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    f.request.source.file,
    "-vf",
    "geq=r='mod(N,8)*30':g='mod(floor(N/8),8)*30':b='100'",
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-crf",
    "12",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "copy",
    coded,
  ]);
  f.request.source.file = coded;
  f.request.source.sha256 = hashFile(coded);
  const reviewed = await review(root, f.request);
  await runRecordingEditWorkflow(reviewed, { action: "create", rootDir: root });
  const authored = JSON.parse(
    readFileSync(path.join(root, "public/projects", f.request.projectId, "pipeline/recording-edit.json"), "utf8"),
  );
  const registry = readAssetRegistry(f.request.projectId, root);
  const picture = registry.assets.find((asset) => asset.id === authored.normalizedVideoAssetId)!;
  const derivative = path.join(root, "public", picture.files.original);
  const pixel = (file: string, frame: number) => [
    ...execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        `select=eq(n\\,${frame}),crop=40:40:140:40,scale=1:1`,
        "-frames:v",
        "1",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
      { maxBuffer: 1024 },
    ),
  ];
  for (const master of [0, 7, 8, 9, 10, 29, 38, 59, 119, 179]) {
    let decoded = 0;
    while (decoded + 1 < f.pts.length && Math.round(f.pts[decoded + 1] * 30) <= master) decoded++;
    assert.equal(
      authored.normalization.masterToDecodedFrame[master],
      decoded,
      `provenance must pin actual source sample at master${master}`,
    );
    const expected = pixel(coded, decoded),
      actual = pixel(derivative, master);
    assert.equal(actual.length, 3);
    assert.ok(
      actual.every((value, channel) => Math.abs(value - expected[channel]) < 12),
      JSON.stringify({ master, decoded, actual, expected }),
    );
  }
  assert.equal(hashFile(coded), f.request.source.sha256);
});

test("shortest AAC allows only bounded terminal silence with every retained word inside authentic audio", async (t) => {
  const root = fixture(t),
    f = timingFixture(root, "ntsc", 6, true);
  const missingTail = structuredClone(f.request);
  f.request.transcript.words.at(-1)!.endFrame--;
  const planned = await runRecordingEditWorkflow(f.request, { action: "plan", rootDir: root });
  assert.equal(
    planned.metadata.durationInFrames,
    keepMasterBoundary(f, f.two, "end") +
      keepMasterBoundary(f, f.pts.length, "end") -
      keepMasterBoundary(f, f.four, "start"),
  );
  const reviewed = await review(root, f.request);
  await runRecordingEditWorkflow(reviewed, { action: "create", rootDir: root });
  const report = JSON.parse(
    readFileSync(path.join(root, "public/projects", f.request.projectId, "pipeline/recording-edit.json"), "utf8"),
  );
  assert.ok(
    report.normalization.tailAudioAdjustmentSec > 1 / 30 && report.normalization.tailAudioAdjustmentSec <= 2 / 30,
    JSON.stringify(report.normalization),
  );
  missingTail.projectId = "invalid-speech-tail";
  await assert.rejects(
    () => runRecordingEditWorkflow(missingTail, { action: "plan", rootDir: root }),
    /word|speech|audio|coverage|tail/i,
  );
  assert.ok(!existsSync(path.join(root, "public/projects/invalid-speech-tail")));
  const truncated = path.join(root, "truncated-too-far.mp4");
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-i",
    f.request.source.file,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-af",
    "atrim=end=5.8",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    truncated,
  ]);
  const invalid = {
    ...f.request,
    projectId: "too-short-audio",
    source: { ...f.request.source, file: truncated, sha256: hashFile(truncated) },
  };
  await assert.rejects(() => runRecordingEditWorkflow(invalid, { action: "plan", rootDir: root }), /audio|cover/i);
  assert.ok(!existsSync(path.join(root, "public/projects/too-short-audio")));
  assert.equal(hashFile(f.request.source.file), f.request.source.sha256);
});
test("original adjacent keeps that collide after outward mapping and dishonest VFR nominal rate fail closed", async (t) => {
  const root = fixture(t),
    f = timingFixture(root, "ntsc");
  const adjacent = structuredClone(f.request);
  adjacent.keepSpans.splice(
    0,
    1,
    { id: "first-a", startFrame: 0, endFrame: 30, reason: "Technical adjacency" },
    { id: "first-b", startFrame: 30, endFrame: f.two, reason: "Technical adjacency" },
  );
  await assert.rejects(
    () => runRecordingEditWorkflow(adjacent, { action: "plan", rootDir: root }),
    /overlap|merge adjacent/i,
  );
  const variable = timingFixture(root, "vfr");
  variable.request.source.fps.num = 28; // Actual average, deliberately not the measured nominal rate30.
  await assert.rejects(
    () => runRecordingEditWorkflow(variable.request, { action: "plan", rootDir: root }),
    /nominal|fps/i,
  );
  assert.ok(!existsSync(path.join(root, "public")));
});
