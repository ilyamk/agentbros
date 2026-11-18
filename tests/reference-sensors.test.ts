import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import {
  SENSOR_THRESHOLDS,
  runReferenceSensors,
  sensorEvidence,
  sensorsForRole,
  yawDiversity,
  type SensorResult,
} from "../src/lib/references/sensors";
import { recordReviewToMemory, summariseResultReview, noIdentitySimilarity } from "../src/lib/references/review";
import { runDerivative } from "../src/lib/references/derive";
import { loadMemory, memoryDir } from "../src/lib/memory";
import { PackResultReviewSchema, type PackResultReview } from "../src/types/references";
import { SlotSchema } from "../src/types/reference-profiles";
import { derivativeFixture, hasFfmpeg } from "./helpers/reference-derive";

const media = { skip: hasFfmpeg ? false : "needs ffmpeg and ffprobe" } as const;

function ffmpeg(...args: string[]) {
  const result = spawnSync("ffmpeg", ["-v", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
function temp(t: TestContext) {
  const dir = mkdtempSync(path.join(tmpdir(), "reference-sensors-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return (name: string) => path.join(dir, name);
}
const x264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
const find = (results: SensorResult[], id: string) => {
  const found = results.find((result) => result.id === id);
  assert.ok(found, `sensor ${id} missing from ${results.map((result) => result.id).join(", ")}`);
  return found;
};

test("sensorsForRole picks sensors by role and modality", () => {
  assert.deepEqual(sensorsForRole("identity", "image"), ["format", "alpha", "border", "luminance"]);
  assert.deepEqual(sensorsForRole("location", "image"), ["format", "alpha", "luminance"]);
  assert.deepEqual(sensorsForRole("performance", "video"), [
    "format",
    "cuts",
    "camera-motion",
    "black-frozen",
    "duration",
  ]);
  assert.deepEqual(sensorsForRole("depth", "video"), ["format", "flicker", "frame-count"]);
  assert.deepEqual(sensorsForRole("voice", "audio"), ["format", "duration", "audio"]);
});

test("yaw diversity mirrors the coverage rule", () => {
  assert.equal(yawDiversity([0, 45, 90]).severity, "ok");
  assert.equal(yawDiversity([0, 45, 90]).value, 3);
  assert.equal(yawDiversity([0, 10]).severity, "warn");
  assert.equal(yawDiversity([0, 10]).value, 1);
  assert.match(yawDiversity([0, 10, 90]).message, /near duplicates/);
  assert.equal(yawDiversity([350, 20], 30).value, 2, "yaw wraps at 360");
  assert.ok(SENSOR_THRESHOLDS.minDistinctYawDeg > 0);
});

test("image sensors: neutral border, busy border, uneven light, slot limits and alpha", media, (t) => {
  const file = temp(t);
  ffmpeg("-f", "lavfi", "-i", "color=c=0x808080:s=320x240", "-frames:v", "1", file("grey.png"));
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=0x808080:s=32x24,noise=alls=80:allf=u,scale=320:240:flags=neighbor",
    "-frames:v",
    "1",
    file("noisy.png"),
  );
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "gradients=s=320x240:c0=black:c1=white:x0=0:y0=0:x1=319:y1=0:n=2",
    "-frames:v",
    "1",
    file("gradient.png"),
  );
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=red@0.5:s=64x48,format=rgba",
    "-frames:v",
    "1",
    "-c:v",
    "png",
    file("alpha.png"),
  );

  const grey = runReferenceSensors({ file: file("grey.png"), role: "identity", modality: "image" });
  assert.equal(find(grey, "border.stdDev").severity, "ok");
  assert.equal(find(grey, "luminance.spread").severity, "ok");
  assert.equal(find(grey, "format.shortEdge").value, 240);

  const noisy = runReferenceSensors({ file: file("noisy.png"), role: "product", modality: "image" });
  assert.equal(find(noisy, "border.stdDev").severity, "warn");

  const gradient = runReferenceSensors({ file: file("gradient.png"), role: "identity", modality: "image" });
  assert.equal(find(gradient, "luminance.spread").severity, "warn");

  const slot = SlotSchema.parse({
    id: "images",
    modality: "image",
    pointer: "/image_urls",
    roles: ["identity"],
    max: 4,
    pixels: { minEdge: 300, maxEdge: 4096, aspect: [0.5, 1] },
    formats: ["image/jpeg"],
    alpha: "flatten",
    evidence: { tier: "official", checkedAt: "2026-11-17" },
  });
  const limited = runReferenceSensors({ file: file("grey.png"), role: "identity", modality: "image", slot });
  assert.equal(find(limited, "format.shortEdge").severity, "fail");
  assert.equal(find(limited, "format.aspect").severity, "fail");
  assert.equal(find(limited, "format.mime").severity, "fail");
  assert.equal(find(limited, "format.longEdge").severity, "ok");
  const alpha = runReferenceSensors({ file: file("alpha.png"), role: "identity", modality: "image", slot });
  assert.equal(find(alpha, "alpha").severity, "warn");
  assert.equal(find(grey, "alpha").value, 0);
});

test("video sensors: a hard cut, camera motion, flicker and black frames", media, (t) => {
  const file = temp(t);
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=red:s=160x120:r=10:d=1",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x120:r=10:d=1",
    "-filter_complex",
    "[0][1]concat=n=2:v=1",
    ...x264,
    file("cut.mp4"),
  );
  const cutWarn = runReferenceSensors({ file: file("cut.mp4"), role: "motion", modality: "video" });
  assert.equal(find(cutWarn, "cuts.count").value, 1);
  assert.equal(find(cutWarn, "cuts.count").severity, "warn");
  const cutFail = runReferenceSensors({ file: file("cut.mp4"), role: "motion", modality: "video", refuseCuts: true });
  assert.equal(find(cutFail, "cuts.count").severity, "fail");

  ffmpeg("-f", "lavfi", "-i", "testsrc=s=640x240", "-frames:v", "1", file("wide.png"));
  ffmpeg(
    "-loop",
    "1",
    "-r",
    "10",
    "-i",
    file("wide.png"),
    "-t",
    "2",
    "-vf",
    "crop=320:240:0:0",
    ...x264,
    file("static.mp4"),
  );
  ffmpeg(
    "-loop",
    "1",
    "-r",
    "10",
    "-i",
    file("wide.png"),
    "-t",
    "2",
    "-vf",
    "crop=320:240:x='t*80':y=0",
    ...x264,
    file("pan.mp4"),
  );
  const still = find(
    runReferenceSensors({ file: file("static.mp4"), role: "performance", modality: "video" }),
    "camera.motion",
  );
  const pan = find(
    runReferenceSensors({ file: file("pan.mp4"), role: "performance", modality: "video" }),
    "camera.motion",
  );
  assert.equal(still.severity, "ok");
  assert.equal(pan.severity, "warn");
  assert.ok((pan.value as number) > (still.value as number) + 5, `pan ${pan.value} vs static ${still.value}`);
  assert.equal(
    find(runReferenceSensors({ file: file("static.mp4"), role: "performance", modality: "video" }), "cuts.count").value,
    0,
  );

  ffmpeg("-f", "lavfi", "-i", "color=c=gray:s=160x120:r=10:d=2", ...x264, file("smooth.mp4"));
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=gray:s=160x120:r=10:d=2,format=gray,geq=lum='96+64*mod(N\\,2)'",
    ...x264,
    file("flicker.mp4"),
  );
  assert.equal(
    find(runReferenceSensors({ file: file("smooth.mp4"), role: "depth", modality: "video" }), "temporal.flicker")
      .severity,
    "ok",
  );
  const flicker = runReferenceSensors({ file: file("flicker.mp4"), role: "depth", modality: "video" });
  assert.equal(find(flicker, "temporal.flicker").severity, "warn");
  assert.equal(find(flicker, "frame.count").value, 20);

  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    "color=c=black:s=160x120:r=10:d=1",
    "-f",
    "lavfi",
    "-i",
    "testsrc=s=160x120:r=10:d=1",
    "-filter_complex",
    "[0][1]concat=n=2:v=1",
    ...x264,
    file("black.mp4"),
  );
  const black = find(
    runReferenceSensors({ file: file("black.mp4"), role: "performance", modality: "video" }),
    "black.share",
  );
  assert.equal(black.severity, "warn");
  assert.ok((black.value as number) > 0.4 && (black.value as number) < 0.6, String(black.value));
});

test("audio sensors: clipping, SNR from pauses, silence ratio", media, (t) => {
  const file = temp(t);
  const tone = "sine=f=440:d=1:sample_rate=48000";
  const gap = "anullsrc=r=48000:cl=mono:d=1";
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    `${tone},volume=0.5`,
    "-f",
    "lavfi",
    "-i",
    gap,
    "-f",
    "lavfi",
    "-i",
    `${tone},volume=0.5`,
    "-filter_complex",
    "[0][1][2]concat=n=3:v=0:a=1",
    file("clean.wav"),
  );
  ffmpeg("-f", "lavfi", "-i", `${tone},volume=20`, file("clipped.wav"));
  ffmpeg(
    "-i",
    file("clean.wav"),
    "-f",
    "lavfi",
    "-i",
    "anoisesrc=d=3:a=0.05:r=48000",
    "-filter_complex",
    "[0][1]amix=inputs=2:normalize=0",
    file("noisy.wav"),
  );
  ffmpeg(
    "-f",
    "lavfi",
    "-i",
    `${tone},volume=0.5`,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=mono:d=3",
    "-filter_complex",
    "[0][1]concat=n=2:v=0:a=1",
    file("sparse.wav"),
  );

  const clean = runReferenceSensors({ file: file("clean.wav"), role: "voice", modality: "audio" });
  assert.equal(find(clean, "audio.peakDb").severity, "ok");
  assert.equal(find(clean, "audio.snrDb").severity, "ok");
  const silence = find(clean, "audio.silenceRatio");
  assert.ok(Math.abs((silence.value as number) - 1 / 3) < 0.08, String(silence.value));
  assert.equal(silence.severity, "ok");
  assert.equal(find(clean, "duration").value, 3);

  assert.equal(
    find(runReferenceSensors({ file: file("clipped.wav"), role: "voice", modality: "audio" }), "audio.peakDb").severity,
    "fail",
  );
  assert.equal(
    find(runReferenceSensors({ file: file("noisy.wav"), role: "voice", modality: "audio" }), "audio.snrDb").severity,
    "warn",
  );
  const sparse = find(
    runReferenceSensors({ file: file("sparse.wav"), role: "voice", modality: "audio" }),
    "audio.silenceRatio",
  );
  assert.equal(sparse.severity, "warn", "trailing silence without silence_end counts to the end");
  assert.ok((sparse.value as number) > 0.7, String(sparse.value));

  const evidence = sensorEvidence(clean);
  for (const value of Object.values(evidence.measurements)) assert.ok(Number.isFinite(value));
  assert.ok("sensor.audio.peakDb" in evidence.measurements);
});

test("a sensor that cannot run is a warning, never a throw", () => {
  const results = runReferenceSensors({
    file: "/nonexistent/file.png",
    role: "identity",
    modality: "image",
    yaws: [0, 90],
  });
  assert.equal(find(results, "inspect").severity, "warn");
  assert.equal(find(results, "angles.distinctYaws").severity, "ok");
});

test("derive runs the role's sensors and stores them in the receipt", media, async (t) => {
  const f = derivativeFixture(t);
  const run = await runDerivative(
    "demo",
    { ...f.spec("sensed", [{ op: "extract-frame", at: "first" }]), role: "identity" },
    f.rootDir,
  );
  const measurements = run.receipt.measurements;
  assert.ok(typeof measurements["sensor.border.stdDev"] === "number");
  assert.ok(typeof measurements["sensor.luminance.spread"] === "number");
  assert.equal(measurements["sensor.format.shortEdge"], 240);
  // testsrc is busy at the edges: the neutral-background heuristic warns.
  assert.match(run.receipt.warnings.join("\n"), /sensor border\.stdDev \(warn\)/);
  const stored = JSON.parse(readFileSync(path.join(run.directory, "receipt.json"), "utf8"));
  assert.deepEqual(stored.measurements, measurements);
  // Without a role, no sensor runs.
  const plain = await runDerivative("demo", f.spec("plain", [{ op: "extract-frame", at: "first" }]), f.rootDir);
  assert.ok(!Object.keys(plain.receipt.measurements).some((key) => key.startsWith("sensor.")));
  assert.equal(plain.receipt.output.sha256, run.receipt.output.sha256, "sensors do not change the output");
});

const HASH = "a".repeat(64);
function review(overrides: Partial<PackResultReview> = {}): PackResultReview {
  return PackResultReviewSchema.parse({
    schemaVersion: 1,
    packSha256: HASH,
    outputSha256: "b".repeat(64),
    reviewer: "qa-reviewer",
    evidence: "results board frames 1-12",
    identity: "fail",
    wardrobe: "pass",
    preserved: "pass",
    otherSubjects: "not-applicable",
    motion: "pass",
    naturalness: "fail",
    promptFit: "pass",
    temporalConsistency: "pass",
    audio: "replace-in-edit",
    verdict: "repair",
    ...overrides,
  });
}
const pack = {
  packId: "hero-pack",
  profileFamily: "kling-o3",
  attachmentRoles: ["identity", "identity", "motion"] as const,
};

test("result review summary: failed dimensions and the memory line", async () => {
  const summary = summariseResultReview(review(), { ...pack, attachmentRoles: [...pack.attachmentRoles] });
  assert.equal(summary.verdict, "repair");
  assert.deepEqual(summary.failedDimensions, ["identity", "naturalness"]);
  assert.equal(
    summary.memoryObservation,
    "kling-o3 pack, 3 attachment(s) (identityx2, motion): result repair; failed identity, naturalness",
  );
  assert.ok(summary.memoryObservation.length <= 160);
  assert.deepEqual(
    summariseResultReview(review({ identity: "pass", naturalness: "pass", verdict: "pass" })).failedDimensions,
    [],
  );
  // The schema keeps the invariant: a failed dimension cannot pass.
  assert.throws(() => summariseResultReview({ ...review(), verdict: "pass" }), /cannot receive a passing verdict/);
  assert.deepEqual(await noIdentitySimilarity.measure({ resultFrames: [], attachments: [] }), []);
});

test("result review is recorded as a memory observation under the test memory root", () => {
  assert.ok(process.env.AGENTBROS_MEMORY_ROOT, "the memory-root helper is loaded");
  const packSummary = { ...pack, attachmentRoles: [...pack.attachmentRoles], project: "demo" };
  const dry = recordReviewToMemory({ review: review(), packSummary, dryRun: true });
  assert.equal(dry.action, "dry-run");
  assert.equal(loadMemory().entries.length, 0);
  const added = recordReviewToMemory({ review: review(), packSummary });
  assert.equal(added.action, "added");
  assert.equal(added.entry.type, "observation");
  assert.equal(added.entry.scope.project, "demo");
  assert.ok(memoryDir().startsWith(path.resolve(process.env.AGENTBROS_MEMORY_ROOT!)));
  const again = recordReviewToMemory({ review: review({ outputSha256: "c".repeat(64) }), packSummary });
  assert.equal(again.action, "seen");
  assert.equal(again.entry.occurrences, 2);
  assert.equal(loadMemory().entries.length, 1);
});
