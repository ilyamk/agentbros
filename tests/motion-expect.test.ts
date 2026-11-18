import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  judgeMotion,
  readMotionSummary,
  readOutputMotion,
  summariseMotion,
  type MotionSummary,
} from "../src/lib/sensors/motion-expect";
import { FalEndpointRequestSchema, FalOperationContextSchema } from "../src/types/generation";

const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;
const media = { skip: hasFfmpeg ? false : "needs ffmpeg", timeout: 60000 } as const;
const root = mkdtempSync(path.join(tmpdir(), "motion-expect-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

function clip(name: string, filter: string, seconds = 3): string {
  const file = path.join(root, name);
  const result = spawnSync(
    "ffmpeg",
    ["-v", "error", "-y", "-f", "lavfi", "-i", filter, "-t", String(seconds), "-pix_fmt", "yuv420p", file],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return file;
}

const summary = (patch: Partial<MotionSummary>): MotionSummary => ({
  stillShare: 0,
  longestStillSec: 0,
  meanEnergy: 5,
  meanChanged: 0.2,
  medianSpread: 0.6,
  durationSec: 5,
  ...patch,
});

test("judgeMotion: animated passes on a moving picture and fails on frozen or local motion", () => {
  assert.deepEqual(judgeMotion(summary({}), { motion: "animated" }), { passed: true, findings: [] });
  const frozen = judgeMotion(summary({ stillShare: 0.8, longestStillSec: 4, medianSpread: 0 }), { motion: "animated" });
  assert.equal(frozen.passed, false);
  assert.equal(frozen.findings.length, 2);
  assert.match(frozen.findings[0]!, /Frozen for 80% of 5s/);
  const local = judgeMotion(summary({ medianSpread: 0.0625 }), { motion: "animated" });
  assert.equal(local.passed, false);
  assert.match(local.findings[0]!, /Only 6% of the frame moves/);
  assert.equal(
    judgeMotion(summary({ medianSpread: 0.0625 }), { motion: "animated", minMovingShare: 0.05 }).passed,
    true,
  );
  assert.equal(judgeMotion(summary({ stillShare: 0.6 }), { motion: "animated", maxStillShare: 0.7 }).passed, true);
});

test("judgeMotion: still needs at least 90% frozen; a too-short clip fails", () => {
  assert.equal(judgeMotion(summary({ stillShare: 0.95 }), { motion: "still" }).passed, true);
  const moving = judgeMotion(summary({ stillShare: 0.3 }), { motion: "still" });
  assert.equal(moving.passed, false);
  assert.match(moving.findings[0]!, /Frozen for only 30%/);
  assert.equal(judgeMotion(summary({ durationSec: 0.1 }), { motion: "animated" }).passed, false);
});

test("summariseMotion reads frozen time and median spread from motion rows", () => {
  const motion = Array.from({ length: 49 }, (_, index) => ({
    timeSec: (index + 1) / 10,
    energy: index < 25 ? 0 : 4,
    changed: index < 25 ? 0 : 0.3,
  }));
  const spread = motion.map((row) => (row.changed ? 0.5 : 0));
  const read = summariseMotion(motion, spread);
  assert.equal(read.durationSec, 5);
  assert.equal(read.stillShare, 0.5);
  assert.equal(read.longestStillSec, 2.5);
  assert.equal(read.medianSpread, 0);
});

test("context.expect parses; unknown keys stay rejected", () => {
  const parsed = FalOperationContextSchema.parse({ expect: { motion: "animated", minMovingShare: 0.3 } });
  assert.deepEqual(parsed.expect, { motion: "animated", minMovingShare: 0.3 });
  assert.throws(() => FalOperationContextSchema.parse({ expect: { motion: "animated", wobble: 1 } }));
  assert.throws(() => FalOperationContextSchema.parse({ expect: { motion: "jittery" } }));
  assert.throws(() => FalOperationContextSchema.parse({ expect: { motion: "animated", maxStillShare: 2 } }));
  assert.throws(() => FalOperationContextSchema.parse({ unknown: true }));
  const request = FalEndpointRequestSchema.parse({
    endpoint: "fal-ai/kling-video/v3/pro/image-to-video",
    input: { prompt: "x" },
    context: { expect: { motion: "still" } },
  });
  // Context travels beside the provider input, never inside it.
  assert.equal("expect" in request.input, false);
});

test("a static frame with a small blinking corner square fails animated on spread", media, () => {
  // 10 Hz blink at 30 fps: every 10 fps sample pair sees the square change, so nothing reads as frozen.
  const file = clip(
    "blink.mp4",
    "color=c=0x305070:s=320x180:r=30,drawbox=x=8:y=8:w=24:h=24:color=white:t=fill:enable='lt(mod(n,6),3)'",
  );
  const read = readMotionSummary(file);
  assert.ok(read.medianSpread < 0.25, JSON.stringify(read));
  const verdict = judgeMotion(read, { motion: "animated" });
  assert.equal(verdict.passed, false);
  assert.ok(
    verdict.findings.some((finding) => /of the frame moves/.test(finding)),
    verdict.findings.join(" "),
  );
});

test("a moving test pattern passes animated", media, () => {
  const read = readMotionSummary(clip("testsrc2.mp4", "testsrc2=s=320x180:r=30"));
  const verdict = judgeMotion(read, { motion: "animated" });
  assert.equal(verdict.passed, true, `${JSON.stringify(read)} ${verdict.findings.join(" ")}`);
});

test("a fully static frame fails animated on frozen time and passes still", media, () => {
  const read = readMotionSummary(clip("static.mp4", "color=c=0x305070:s=320x180:r=30"));
  assert.ok(read.stillShare >= 0.9, JSON.stringify(read));
  const verdict = judgeMotion(read, { motion: "animated" });
  assert.equal(verdict.passed, false);
  assert.ok(verdict.findings.some((finding) => /^Frozen for/.test(finding)));
  assert.equal(judgeMotion(read, { motion: "still" }).passed, true);
});

test(
  "readOutputMotion: reads the video output, adds acceptance only with an expectation, skips non-video",
  media,
  () => {
    const file = clip("output.mp4", "testsrc2=s=320x180:r=30", 2);
    const plain = readOutputMotion([file]);
    assert.ok(plain && "medianSpread" in plain.motion);
    assert.equal(plain.acceptance, undefined);
    const judged = readOutputMotion([file], { motion: "still" });
    assert.equal(judged?.acceptance?.passed, false);
    writeFileSync(path.join(root, "still.png"), "");
    assert.equal(readOutputMotion([path.join(root, "still.png")], { motion: "animated" }), undefined);
    const broken = path.join(root, "broken.mp4");
    writeFileSync(broken, "not a video");
    const skipped = readOutputMotion([broken], { motion: "animated" });
    assert.ok(skipped && "skipped" in skipped.motion);
    assert.equal(skipped.acceptance, undefined);
  },
);
