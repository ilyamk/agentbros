import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { runRecordingEditWorkflow } from "../src/lib/workflows/recording-edit";
import { hashFile } from "../src/lib/assets/registry";
import { recordingFixture } from "./workflow-recording-edit-fixtures";
import { probeRecordingTiming, hashRecordingNormalizationMapping } from "../src/lib/workflows/recording-timing";
import { TimelineEditStore } from "../src/lib/timeline-ir/store";
import { compileTimelineIR } from "../src/lib/timeline-ir/compiler";

const policy = {
  targetFps: { num: 30, den: 1 },
  video: "timestamp-near",
  boundaryRounding: "nearest",
  keepRounding: "outward",
  audio: "preserve-clock",
};
for (const kind of ["ntsc", "ntsc-shortest", "vfr"] as const)
  test(`actual ${kind} plan is write-free and reviewed normalization preserves source clock and tail`, async (t) => {
    const root = mkdtempSync(path.join(tmpdir(), "recording-normalized-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const base = recordingFixture(root);
    const source = path.join(root, `${kind}.mp4`);
    const duration = kind === "ntsc-shortest" ? 6 : 3;
    execFileSync("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=320x180:rate=${kind !== "vfr" ? "30000/1001" : "30"}:duration=${duration}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:sample_rate=48000:duration=${duration}`,
      ...(kind === "vfr" ? ["-vf", "select='not(eq(n,15))'", "-fps_mode", "vfr"] : []),
      ...(kind === "ntsc-shortest" ? ["-shortest"] : []),
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      source,
    ]);
    const request: any = {
      ...base,
      version: 2,
      source: {
        ...base.source,
        file: source,
        sha256: hashFile(source),
        fps: kind !== "vfr" ? { num: 30000, den: 1001 } : { num: 30, den: 1 },
        normalization: policy,
      },
    };
    const timing = probeRecordingTiming(source, request.source);
    request.transcript.words = [
      { id: "negation", text: "Не", startFrame: 0, endFrame: 10 },
      { id: "tail", text: "обещаем.", startFrame: timing.frames - 10, endFrame: timing.frames - 1 },
    ];
    request.keepSpans = [
      { id: "complete", startFrame: 0, endFrame: timing.frames, reason: "Retain complete synthetic declaration" },
    ];
    request.cuts = [];
    request.protectedSpans = [
      {
        startFrame: 0,
        endFrame: timing.frames,
        kind: "complete-statement",
        reason: "Whole test declaration and negation",
      },
    ];
    const plan = await runRecordingEditWorkflow(request, { action: "plan", rootDir: root });
    assert.ok(!existsSync(path.join(root, ".cache")));
    assert.ok(!existsSync(path.join(root, "public")));
    assert.equal(plan.metadata.durationInFrames, Math.ceil(timing.durationSec * 30 - 1e-9));
    assert.equal((plan.metadata.sourceTiming as any).decodedFrameCount, timing.frames);
    assert.equal((plan.metadata.sourceTiming as any).variableFrameRate, kind === "vfr");
    if (kind !== "vfr" && timing.durationSec > timing.authenticContentDurationSec + timing.clockToleranceSec) {
      const missingTail = structuredClone(request);
      missingTail.transcript.words[1].endFrame = timing.frames;
      await assert.rejects(
        () => runRecordingEditWorkflow(missingTail, { action: "plan", rootDir: root }),
        /Retained word exceeds authentic audio content/,
      );
    }
    request.review = {
      reviewer: "Synthetic fixture test declaration only",
      reviewedAt: "2026-10-11T00:00:00Z",
      approvedEditHash: plan.metadata.editHash,
      meaningPreserved: true,
    };
    await runRecordingEditWorkflow(request, { action: "create", rootDir: root });
    assert.equal(hashFile(source), request.source.sha256);
    const pipeline = path.join(root, "public/projects/recut/pipeline");
    const artifact = JSON.parse(readFileSync(path.join(pipeline, "recording-edit.json"), "utf8"));
    assert.equal(artifact.normalization.speechSpeedChanged, false);
    assert.equal(artifact.normalization.mappingHash, artifact.identity.source.mappingHash);
    assert.equal(hashRecordingNormalizationMapping(artifact.normalization), artifact.identity.source.mappingHash);
    const changedMap = structuredClone(artifact.normalization);
    changedMap.masterToDecodedFrame[0] += 1;
    assert.notEqual(hashRecordingNormalizationMapping(changedMap), artifact.identity.source.mappingHash);
    assert.equal(artifact.normalization.masterToDecodedFrame.length, plan.metadata.durationInFrames);
    assert.notEqual(artifact.sourceAssetId, artifact.normalizedVideoAssetId);
    assert.equal(artifact.normalization.masterToDecodedFrame.at(-1), timing.frames - 1);
    const timeline = new TimelineEditStore(path.join(pipeline, "timeline-edit.json")).read().timeline;
    assert.equal(timeline.tracks[0].clips[0].assetId, artifact.normalizedVideoAssetId);
    assert.equal(timeline.tracks[1].clips[0].assetId, artifact.audioAssetId);
    const compiled = compileTimelineIR(timeline);
    assert.equal(compiled.durationInFrames, plan.metadata.durationInFrames);
    assert.deepEqual(
      compiled.tracks[2].clips[0].captions.map((w) => w.text),
      ["Не", "обещаем."],
    );
    assert.ok(artifact.normalization.outputDurationSec >= artifact.normalization.originalDurationSec);
    assert.ok(Math.abs(artifact.normalization.tailAudioAdjustmentSec) <= 2 / 30 + 1e-6);
    assert.ok(Math.abs(artifact.normalization.originalAudioVideoEndpointGapSec) <= 1 / 30 + 1e-6);
  });
